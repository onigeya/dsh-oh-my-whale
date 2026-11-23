# LangMem · 实现机制 digest

> 取证口径：代码行号取自 **PyPI langmem 0.0.30 wheel** 解包后的 `langmem/`（对应仓库 `src/langmem/`）。GitHub main 分支可能存在数行偏移，但函数与默认值一致（README/文档同版本核对）。标注约定：**[代码]** = 源码确实如此；**[声称]** = README/docstring 说法；**[推断]** = 我的解读。

## 身份确认

- 仓库存在且吻合：`github.com/langchain-ai/langmem`，包名 `langmem`，版本 **0.0.30**，描述 "Prebuilt utilities for memory management and retrieval."（`pyproject.toml:1-4`）。
- Python `>=3.10`，构建 hatchling，纯 Python wheel（`langmem-0.0.30-py3-none-any.whl`，PyPI 0.0.30 发布物）。**[代码/发布物]**
- 核心依赖：`langchain>=0.3.15`、`langchain-core>=0.3.46`、`langgraph>=0.6.0,<2`、`trustcall>=0.0.39`、`langsmith>=0.3.8`（`pyproject.toml:8-18`）。
- README 自述："LangMem helps agents learn and adapt from their interactions over time."（`README.md`，https://github.com/langchain-ai/langmem）。

## 一句话定位

一个**进程内 Python 库**（不是服务、不是数据库）：把「记忆的抽取/合并/检索」做成可组合的 LangChain Runnable 与 Tool，真正的持久化外包给 **LangGraph BaseStore**；对开发者提供 hot-path 工具 + background manager 两种接入姿势，另有 prompt 优化与短期摘要两个旁支模块。

## 架构总览

四层，彼此可单独使用（`src/langmem/__init__.py` 导出即分层边界）：

1. **函数核（无状态、无 store）**：`create_memory_manager` → `MemoryManager`，输入 messages + existing，输出 `list[(id, BaseModel)]`（`knowledge/extraction.py:217-236, 536-545`）。
2. **绑定 store 的管理器**：`create_memory_store_manager` → `MemoryStoreManager`，内部依次做「检索 → 抽取/合并 → 写回 store」（`extraction.py:832-886, 1006-1135`）；`create_memory_searcher` 提供「自动生成查询 + 检索」的只读管线（`extraction.py:695-700`）。
3. **工具层（hot path）**：`create_manage_memory_tool`（create/update/delete）、`create_search_memory_tool`（query/limit/offset/filter）（`knowledge/tools.py:25-39, 362-369`）。
4. **调度层**：`ReflectionExecutor`，本地线程队列或 LangGraph Platform 远程运行（`reflection.py:110-140`）。

旁支：`short_term/summarization.py`（对话压缩，token 预算在这里，不在检索里）、`prompts/optimization.py`（prompt 进化，与记忆存储解耦）。

## 数据模型与存储

- **默认记忆单元只有一个字段**：`Memory.content: str`（`extraction.py:86-92`）。schema 可替换为任意 Pydantic 模型列表（`schemas: Sequence[BaseModel]`，`extraction.py:222, 540`）。
- **store 落盘形状**（这是真正的"记忆单元"）：`value = {"kind": <schema 类名>, "content": <model_dump 后的 dict>}`（`extraction.py:1044-1047, 1114, 1122`）。`kind` 是运行期类型标签，让多种记忆 schema 共存同一 namespace。
- **Item 元数据**来自 LangGraph：`namespace / key / value / created_at / updated_at / score`（`reflection.py:31-50` 的 `MemoryItem` TypedDict 明确定义）。
- **key 生成**：检索回来的行用 `uuid5(NAMESPACE_DNS, namespace+key)` 算稳定 id（`extraction.py:937-938`）；新行沿用抽取器给出的 id。**[代码]**
- **namespace 是模板元组**，默认 `("memories", "{langgraph_user_id}")`（`extraction.py:699, 848, 1678`），运行期由 `utils.NamespaceTemplate` 用 config 变量填充（`extraction.py:877, 1660-1663`）。分片维度是「配置里的用户/租户」，不是 embedding 聚类。
- **存哪**：LangGraph `BaseStore`。README 示例用 `InMemoryStore(index={"dims":1536,"embed":"openai:text-embedding-3-small"})`（进程内、重启即丢），生产建议 `AsyncPostgresStore`（`README.md`；`tools.py:415-420` 同款示例）。**没有文件存储、没有自带 DB、没有 migration。**

## 写入路径

**A. Hot path（对话中，模型自己决定写）**
- 装配 `create_manage_memory_tool(namespace=..., actions_permitted=("create","update","delete"))`，默认三种动作全开（`tools.py:25-39`）。
- 默认使用指引就是「何时该记」的策略文本：识别用户偏好、用户显式要求记住、记录重要上下文、发现旧记忆错误（`tools.py:28-32`）。
- 写发生在主推理循环内，所以增加延迟、且模型要"一心二用"——官方文档把这点列为 hot path 的固有代价（https://docs.langchain.com/oss/python/concepts/memory，「In the hot path」）。

**B. Background（会话后/异步）**
- `create_memory_store_manager(...)` 先 `store.asearch` 取相关旧记忆，再交给 `MemoryManager` 做「抽取+合并」，最后批量 `aput/adelete`（`extraction.py:1015-1135`）。
- 后台化靠 `ReflectionExecutor(reflector, namespace)` 包裹后 `submit(payload, after_seconds=N)`（`reflection.py:110-140, 273-329`）。
- 两条路径共用同一个 `MemoryManager`，差别只在触发者与时机：hot path = 模型工具调用；background = 计时器/框架调度。

**抽取方式：[代码] 纯 LLM function-calling 抽取（trustcall），无规则、无正则、无用户显式 DSL。**
- `create_extractor(model, tools=schemas, enable_inserts/updates/deletes=..., existing_schema_policy=False)`（`extraction.py:253-260`）。
- prompt 强制「所有操作放在一次并行 multi-tool call 里」「避免重复抽取」（`extraction.py:472-475`）。
- `max_steps` 多轮：第 2 轮起额外挂一个 `Done` 工具，模型自评「还没整理完就继续」；每轮把上一轮结果以 tool 消息回灌（`extraction.py:266-270, 300-334`）。
- 动作判定不是业务代码，而是读 trustcall 的 `response_metadata["json_doc_id"]` 区分 updated/inserted，用 `RemoveDoc` 识别 deleted（`extraction.py:300-313`）。

**去重：不做向量近邻去重，靠「旧记忆带 id 注入 + LLM 自行 patch」。**
- 旧记忆以 `(id, kind, value)` 形式进入 prompt 的 `existing`（`extraction.py:262, 480-507, 1065-1079`）。
- 写回时按 stable id 合并，并且**只有 kind/content 真变了才 put**（`extraction.py:1104-1124`）——这是抑制写放大的唯一硬机制。**[代码]**
- 首次为空时可写入 `key="default"` 的种子记忆（`extraction.py:1040-1052`）。

## 点名深挖：本体与记忆分类 + 事实抽取 + 冲突校验

### 本体与记忆分类（语义/情景/程序）
- **分类只存在于提示词里，代码不强制**：默认指令要求维护 "a core store of semantic, procedural, and episodic memory"（`extraction.py` `_MEMORY_INSTRUCTIONS`，约 180-207 行）。**[代码]**
- 但默认 schema 是单一 `content: str`，**没有 type 字段、没有三类各自的字段集**（`extraction.py:86-92`）。想要三分就得自己传 `schemas=[SemanticMemory, EpisodicMemory, ProceduralMemory]`，类型由 `value["kind"]` 记录（`extraction.py:1114`）。**[代码+推断]**
- LangChain 官方文档对三分的定义（作为对照，不是 LangMem 的实现）：语义=事实/概念（常做成 profile 或 collection）、情景=过往事件与动作（常做成 few-shot 例子）、程序=做事规则（落在 system prompt / 代码 / 权重）——https://docs.langchain.com/oss/python/concepts/memory 。LangMem 只对"存哪"负责，"三分语义"要靠用户 schema 落地。

### 事实抽取范式
trustcall 式 **schema-constrained multi-tool extraction**：模型不是自由写 JSON，而是"调用工具"；工具即 schema；插入/更新/删除由工具调用与元数据推断（见上节）。这是全库最核心的可复用范式。

### 冲突校验（conflict / update）
- **没有独立的校验器/判官模型、没有 NLI 矛盾检测、没有置信度阈值门控**。**[代码：全库无此类调用]**
- 冲突处理全部下压给同一 prompt 的三段式指令：Extract & Contextualize（不确定信息要带 `p(x)` 置信度与理由）、Compare & Update（"Remove incorrect or redundant memories while maintaining internal consistency"）、Synthesize & Reason（用演绎/归纳/溯因下结论并给概率）（`extraction.py` `_MEMORY_INSTRUCTIONS`）。
- `enable_deletes` 是唯一的硬开关：`MemoryManager` 默认 **False**（`extraction.py:226`），`MemoryStoreManager.__init__` 默认 **True**（`845`），工厂函数签名默认 **False**（`1675`，与 docstring "defaults to True" 矛盾，issue #192 正是报这个）。删除默认关闭 = 宁可留着错记忆也不误删。

### prompt 注入方式
- 会话被包进 `<session_{uuid}>` 标签（`extraction.py:457-466`），旧记忆作为结构化 `existing` 字段传入（`extraction.py:262`），不是拼成文本块。**[代码]**
- 记忆正文本身要求"写成独立、可直接回忆的句子"（`Memory.content` 的 field description，`extraction.py:89-92`），即注入侧不做二次改写。

## 读取路径

- **两种读法**：
  1. 工具式：`search_memory(query, limit=10, offset=0, filter=None)`（`tools.py:389-397`），由模型在推理中调用。
  2. 自动式：`MemoryStoreManager` 内部先「生成检索意图」再检索——若配了 `query_model`，让它以并行 tool call 产出多条"假设性记忆查询"，每条 `store.asearch(namespace, limit=query_limit)` 并发执行（`extraction.py:1015-1029`）；没配 `query_model` 则退化为按对话时间窗切片查询（`extraction.py:1030-1037`）。
- **排序**：合并多路结果，按 `(namespace,key)` 去重，按 `item.score` 降序截断到 `query_limit`（默认 5）；score 为空时视为 `-inf`（`extraction.py:991-1004`）。**无 rerank、无时间衰减、无 MMR、无多样性约束。** **[代码]**
- **注入形态**：检索结果作为 `existing` 回灌给抽取器；hot path 里则作为 tool 消息文本返回（`response_format` 可选 `content` / `content_and_artifact`，`tools.py:367`）。
- **token 预算：检索侧没有预算**，只有条数上限 `query_limit=5` / 工具 `limit=10`。真正的 token 预算在短期摘要：`max_tokens`、`max_summary_tokens`、`max_tokens_before_summary`，并强制 `max_summary_tokens < max_tokens`（`short_term/summarization.py:102-121`）。

## 生命周期规则与参数

- **没有衰减**：无 TTL、无 last_used 降权、无时间半衰期。**[代码：全库无相关字段/参数]**
- **没有晋升/降级**：单层 store，没有 working/episodic/archival 分层。**[代码]**
- **没有自动合并任务**：合并只发生在一次抽取调用内部的指令层面（"Consolidate and compress redundant memories"），可选 `phases: list[MemoryPhase]` 追加后处理，默认指令 "Deduplicate, consolidate, and enrich these memories."（`extraction.py:977-989, 1086-1100`）。**[代码]**
- **删除是硬删**：`store.adelete(namespace, key)`（`extraction.py:1132-1135`）。docstring 声称 "maintains a versioned history of all changes"（`extraction.py:1685`），但代码路径是 `aput` 覆盖写，**未见版本表/历史表**。**[声称 vs 代码不符]**（单来源，故不断言"它没有版本"）
- 可调参数清单：`namespace`、`schemas`、`instructions`、`enable_inserts/updates/deletes`、`query_model`、`query_limit=5`、`max_steps`、`default/default_factory`、`phases`（`extraction.py:833-851, 1666-1681`）。

## 后台调度

- `ReflectionExecutor(reflector, namespace, url=None, client=None, store=None)`：`reflector` 是字符串 → `RemoteReflectionExecutor`（提交给 LangGraph 部署的图）；是可调用对象 → `LocalReflectionExecutor`（`reflection.py:110-140`）。
- 本地实现：**单后台线程 + `queue.PriorityQueue`（键为执行时刻）**，线程 `daemon=False`（`reflection.py:264-270`）。
- **并发 = 1**：一个 worker 串行 `self._reflector.invoke(task.payload)`（`reflection.py:401-450`）；异常只塞进 Future，**没有重试、没有退避**。
- **幂等/去抖**：按 `thread_id` 去抖——同一 thread 再次 `submit` 会先 `cancel_event.set()` + `future.cancel()` 掉上一条待办，再以 `time.time()+after_seconds` 入队（`reflection.py:307-328`）。即"新事件到来就顺延重排"，而不是 cron。**存储层没有幂等键**，靠去抖近似。**[代码]**
- 已知缺陷：`thread_id=None` 的排队任务在 `shutdown(cancel_futures=True)` 时不被清理（issues #210、#213）；entrypoint 注入的 store 会被本地执行器丢弃（#194、#195）。

## 工程形态与代价

- 形态：**库/SDK**，无守护进程、无自带服务端；部署单元是你自己的 LangGraph 应用（本地进程或 LangGraph Platform）。**[代码+README]**
- 可观测性：不自带 metrics/tracing，靠 LangSmith（`langsmith>=0.3.8` 依赖；`with_config({"run_name": ...})`，如 `extraction.py:176`）。无 OTel、无内置统计。**[代码]**
- 成本来源（可数）：每次记忆写入 = 1 次抽取 LLM 调用（可能 2 轮 + `max_steps`）；每次 background 写入 = 1 次 NL 查询生成 + N 次 store 检索 + 1 次抽取。检索条数默认 5，抽取时所有旧记忆全量进 prompt，**随记忆条数线性膨胀**。**[推断，基于 1015-1084 的调用结构]**
- **性能数字：仓库/README 未给出任何 benchmark 或延迟数字 → 未证实。** 与性能相关的只有 issue 层的实现缺陷（重复检索 #189/#211、`query_limit` 被 store 默认上限截断 #198、写失败被吞 #196/#212、重复命中取错分 #204）。

## 可迁移到「本地优先的 DSH 插件」的部件

1. **namespace 模板 + 运行期解析**：`("memories", "{project_id}")` 这种声明式元组，比在每个函数里手传 scope 干净；本地插件可直接映射到 `workspace/session` 两维。
2. **"existing 带 id 注入 + 模型并行 patch"**：把已有记忆连同稳定 id 交给模型，让它一次并行发 insert/update/remove，而不是让代码算 diff。这是 LangMem 最值得抄的骨架（`extraction.py:262, 472-475`）。
3. **stable id + 内容比较后才写**：`uuid5(namespace,key)` 保证同一逻辑记忆恒定 id，写回时比较 kind/content 再落盘（`extraction.py:937-938, 1109`），天然抑制写放大。
4. **`kind` 字段承载 schema 名**：多类记忆共用一个表，不必分库分表（`extraction.py:1114`）。
5. **thread 级去抖的后台执行器**（`reflection.py:307-328`）：比 cron 更适合本地插件——新消息到来就取消旧任务，省 token 且天然避免并发写同一 scope。注意要补 `thread_id=None` 的清理与错误传播。

**最不该照抄**：把记忆治理全权交给一段 instruction（无类型字段、无冲突校验器、删除默认关闭、置信度只是提示词里的 `p(x)`），同时声称有 versioned history 而代码是覆盖写。本地插件应显式 schema + append-only 版本列，否则记忆质量不可审计、不可回滚。

## 未证实·缺口

- **行号偏移**：本文行号来自 PyPI 0.0.30 wheel；GitHub `main` 已推进（issues 中 #186/#197 等仍在改抽取与检索），未逐文件 diff，故 `main` 上具体行号可能偏移数行。
- **检索是否向量相似度**：由 store 的 `index={dims, embed}` 决定（README/`tools.py:415-420`）；LangMem 自己不实现索引，未验证 Postgres 实现细节。
- **"versioned history"**：只有 docstring 一处声称（`extraction.py:1685`），代码未见 → 单来源，不断言"不存在"。
- **性能数字**：无任何官方 benchmark；不给数字。
- **本体三分的强制程度**：仅凭 `_MEMORY_INSTRUCTIONS` 与默认 schema 推断"不强制"，未跑到运行期验证 schema 校验行为。
- **未读**：`docs/concepts/conceptual_guide.md` 原文、`evals/` 评测集、`graphs/`（graph_rag）模块；故"它做不到 X"类结论仅限已读代码路径。
- **issue 只取标题/状态**（GitHub API 60 条按创建时间倒序），未读正文细节与修复合并状态。

## 来源清单

- 仓库：https://github.com/langchain-ai/langmem （README、`pyproject.toml`）
- PyPI 0.0.30：https://pypi.org/project/langmem/0.0.30/ ；wheel `langmem-0.0.30-py3-none-any.whl`（https://files.pythonhosted.org/packages/ae/08/c7bc95456f6e02819e9fed56aa01578c3b8ee1a47b520994efc37e9febcc/langmem-0.0.30-py3-none-any.whl）
- 源码文件（行号出处）：`src/langmem/knowledge/extraction.py`、`src/langmem/knowledge/tools.py`、`src/langmem/reflection.py`、`src/langmem/short_term/summarization.py`
- 官方 memory 概念文档（三分/hot path vs background）：https://docs.langchain.com/oss/python/concepts/memory
- LangMem 文档站：https://langchain-ai.github.io/langmem/
- Issues（真实抱怨来源，编号见正文）：https://github.com/langchain-ai/langmem/issues?q=is%3Aissue
  - #217/#218/#219 更新不存在的 id 会重建记忆；#196/#212 写失败仍报成功；#189/#211 同一检索跑两次；#198/#199 query_limit 被截断；#194/#195 注入 store 丢失；#204 重复命中取错分；#207/#215 摘要裁掉消息却标记已摘要；#192 enable_deletes 默认值文档与签名不一致；#164/#163 记忆投毒防护诉求。
