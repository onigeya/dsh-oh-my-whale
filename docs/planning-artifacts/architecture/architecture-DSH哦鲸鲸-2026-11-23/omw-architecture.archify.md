# 哦鲸鲸的架构：记忆是一条有账可查的写路径 {#omw}

哦鲸鲸是一个 DSH 插件，把单文件库变成**可结算的记忆**：写入只有一条路，读取只读且有界，遗忘永远可撤销。

- 写入收敛到一个事务：补丁表、校验层、决策账本同进同出，被拒的写入也留痕。
- 读取只读：召回不写回，注入只有一个出口并带预算表。
- 遗忘可撤销：全仓禁止物理删除，撤销按 `op_id` 整体回滚。
- 人格不依赖库：库坏了身份段照常注入，状态尾巴整段省略。

@answer scope="哦鲸鲸 v1 · DSH 0.2.2-rc.5 · 单进程插件"
@meta locale=zh-CN style=swiss

## 五个能力怎么切 {#caps}

@workflow id=cap-map title="三条路径：对话、夜间、运维"
| lane online | 对话中 |
| lane offline | 夜间 |
| lane ops | 运维 |
| host | 宿主一轮 | external | online |
| mem | 记忆读写 | backend | online |
| db | .tdb | database | online |
| dream | 固化八步 | backend | offline |
| snap | 快照与体检 | backend | ops |
| sif | SiliconFlow 三通道 | cloud | online |
| host > mem | 注入与工具 |
| mem > db | 一个事务 |
| mem > sif | 向量与打分 | dashed |
| dream > db | 收敛 | dashed |
| snap > db | 拷贝 | dashed |

| 能力 | 负责 | 最硬的不变量 |
| --- | --- | --- |
| CAP-1 记忆 | 断言、证据、实体、场景、三档注入 | 召回只读，默认只返回未失效 |
| CAP-2 固化 | 夜间八步、确定性结算先行 | 每步独立提交，可从断点续跑 |
| CAP-3 治理 | 版本链、flag、账本、撤销、导出 | 零物理删除，撤销逐条等于操作前 |
| CAP-4 人格 | 身份文件、状态尾巴、关系四维 | 身份不依赖库，边界在工具层拦截 |
| CAP-5 运维 | 快照、体检、配置、降级 | 故障整体 no-op，不半开 |

## 一次写入要过哪几道门 {#write}

@sequence id=write-path title="写入路径：一次业务写入一次事务"
| actor host | DSH 宿主 | backend |
| actor ext | 抽取器 | backend |
| actor llm | 抽取模型 | cloud |
| actor val | 校验层 | security |
| actor store | 写入口 | database |
| actor db | 单文件库 | database |
| host | ext | turn-stopping 同步返回 |
| ext | llm | timer 去抖 3s 后，一次 LLM 调用 |
| llm | ext | 补丁表草案 | return |
| ext | val | 补丁表 op / key / content / evidence_seq |
| val | store | 通过的单据 | emphasis |
| val | store | 拒收，落 rejected 与 flag | dashed |
| store | db | 一个事务：补丁 + decision |
| db | host | 提交，seq 落盘 |

三处细节决定这条路能不能强制。

- 唯一索引建在 `(mem_key, active_slot)`：活动版本 `active_slot = 1`，被改写时写入 `superseded_at` 的毫秒数。于是「同键至多一条未失效」由**数据库**在 `insert` 与 `updatePayload` 上强制（实测抛 `TDB_UNIQUE_CONSTRAINT`），不靠应用层自觉；`(mem_key, valid_from)` 另建普通复合索引供历史查询。
- `obj_norm` 带 `norm_version`：换归一化算法必须走 `ops/rekey`，逐条写决策账本。
- 推断必须带 `falsifier` 与 `settle_state`：没有可判错的预言，不许入库。

## 一次对话注入什么 {#inject}

| 档位 | 内容 | 上限 | 变化频率 |
| --- | --- | --- | --- |
| 身份段 | persona.md 四段 | 1200 字符 | 几乎不变，字节稳定 |
| 状态尾巴 | 关系四维与档位、一条已确认偏好、一条待处理 flag | 30 token | 每轮可能变 |
| 按需召回 | 候选 → 重排 → 剪枝，最多 5 条 | 三段合计 ≤1000ms | 提问时，重排每轮至多一次 |

@facts id=inject-facts
| 注入出口 | PromptComposer 一个 |
| 越预算顺序 | 身份 > 状态 > 召回，截断记账 |
| 场景 | 一律不常驻 |
| 召回硬上限 | 1000ms，超了用候选，不返回空 |
| 重排 | 默认开启，失败只降不空 |

召回不是一次调用，是三段，每段各有预算与退路。

| 段 | 做什么 | 预算 | 失败怎么办 |
| --- | --- | --- | --- |
| ① 候选 | 向量 + 图 + 全文，worker 线程内本地检索 | 250ms | 这一段失败才是真的没有细节，记降级 |
| ② 重排 | System One 打分、去重、剪枝前置；默认开启 | 600ms | 退回 ① 的顺序照常注入，标 rerank_unavailable |
| ③ 注入 | 按重要度取前 5 条，压到预算内 | 20ms | 取不满就少给，不凑数 |

第二段默认开启，失败不传染：重排是增强，不是通行证——它超时只是「这次没排过序」，候选照常注入。只有第一段失败才是真的没有细节可用。

- 身份段与状态尾巴从不查库：最坏是记忆的细节这一轮没拿到，不会连人设一起丢。
- 代价是每轮最多一次 600ms 与一次模型调用，换来候选被真正排过序。

再补四条约束：

- 召回由模型按需调用，慢只慢在工具调用里，不在每轮开头。
- 同一回合至多触发一次重排，结果按查询与候选指纹缓存 10 分钟，一轮里多次调用不重复付费。
- 连续 3 次重排超时熔断 10 分钟，期间只走 ①③，免得长任务每轮付一次超时。
- 日调用上限见 `budget.rerankCallsPerDay`，命中即降级为 ①③ 并记一行审计。
- 打分走 `POST /systemone` 的 score 任务，模型 `SemIf`（备选 `Kev-4b`）：它只产分数，剪枝按阈值与 top-k 确定性地做；端点属 Alpha，停用时这一档整体降级为 ①③。
## 「改」和「忘」为什么都安全 {#time}

@workflow id=undo-flow title="改写与撤销"
| a | 新事实入库 | backend |
| b | 旧版本打 superseded_at | backend |
| c | 默认查询只看未失效 | backend |
| d | 按 op_id 反向补丁 | security |
| e | 逐条等于操作前 | security |
| a > b | 同键区间重叠 |
| b > c | |
| c > d | 想反悔 |
| d > e | 排除账本 |

| 时间轴 | 记什么 | 用在哪 |
| --- | --- | --- |
| 世界时间 | valid_from、valid_to | validAt(t)：那时成立吗 |
| 记录时间 | recorded_at | knownAsOf(t)：那时我们知道吗 |
| 失效时间 | superseded_at | 默认查询的唯一过滤器 |

撤销是一个操作单元，不是一条字段。每个 `decision` 带 `op_id` 与 `affected[]`，闭包只含状态节点与边；账本类节点永不撤销，比较时也排除，否则追加撤销记录会让判据自我否决。

## 固化在夜里做什么 {#dream}

| 步 | 做什么 | 用模型 |
| --- | --- | --- |
| ① | 确定性结算 | 否 |
| ② | 重放抽样，种子按日期定 | 否 |
| ③ | 模式提取 | 提炼 + 核验 |
| ④ | 场景抽象 | 提炼 + 核验 |
| ⑤ | What-If，v1 默认关闭 | 提炼 + 核验 |
| ⑥ | 剪枝归档 | 否 |
| ⑦ | 跨主题重组 | 否 |
| ⑧ | 策略提炼 | 提炼 + 核验 |

提炼用 `Qwen/Qwen3.5-9B`（原定 `Qwen3.5-4B` 在 2026-11-23 三次探测全无响应，按闸门换同族），核验用 `deepseek-ai/DeepSeek-R1-0528-Qwen3-8B`。核验不过，这一步不提交，整体停在段边界。

两条实测约束。提炼调用必须显式关思考：不关时单次 86 秒且常超时，关掉后 11–13 秒。引文是否为原文子串、seq 是否存在由调用方本地核对，模型只判语义——它会把一字不差的引文误判成找不到。

每步单独提交 `dream_log`：进程在第 ④ 步被杀，重启从 ④ 续跑。预算三层取最小：阶段预算、日 token 上限、provider 配额。`--dry-run` 只跑 ①②，用来验证结算而不花钱。

## 治理要能回答哪三个问题 {#gov}

| 问题 | 谁答 | 字段 |
| --- | --- | --- |
| 谁改的 | 决策账本 | actor、ts |
| 依据什么 | 证据指针 | source、seq 区间、短引文 |
| 为什么 | 决策账本 | kind、reason、prompt_version、precedent_id |

账本只增不改不删。人工裁定可以引用可撤销先例，先例只影响建议排序，不自动改数据。

## 坏了会怎样 {#fail}

| 故障 | 表现 | 恢复 |
| --- | --- | --- |
| 库打不开 | 整体 no-op，不注入不写 | 修库后重启 |
| 快照校验失败 | 拒绝写入，保留现场 | 回滚上一份校验过的快照 |
| 向量维度不符 | 只关向量路径，文本与图照用 | 重算或迁移 |
| 凭据 401 或 402 | 关向量路径，报固定错误码 | 换 key 或充值 |
| 抽取超时 | 弃本轮，记一次失败 | 下一轮重来 |

@callout id=fail-rule level=warning title="记忆安装位降级只有两档"
记忆安装位（库、四工具、召回）要么整体 no-op，要么只关向量路径。不存在「半开」：不写一半、不注入半段。人格安装位**无降级档**（`harness:identity` 不依赖库，见骨架 AD-11），上下文治理安装位另有五档（`CONTEXT-GOVERNANCE.md` AD-36），二者都不受本 callout 约束。

## 哪些门不过就不许往下走 {#gates}

八道门里四道已在 2026-11-23 实测通过，剩下四道还没开测。

@facts id=gate-passed
| G0-1 原生模块 | 通过 · Windows + Node 24.21.0 |
| G0-2 bge-m3 维度 | 通过 · 1024 维，255–408ms |
| G0-3 旧 seq 回读 | 通过 · 连续缺号 0 |
| G0-8 固化两模型 | 通过 · 提炼 11–13s、核验 11–40s |

剩下四道不过就停在这里，不进入 M1。这四道查的是工具链、外通道与我们自己的判断力。

- [ ] G0-4 单条记忆跑通写入、注入、召回闭环
- [ ] G0-5 插件在宿主真正启用，并完成一次注入
- [ ] G0-6 在 TS 7 与 eslint 10 下，跨层 import 必须被拦下
- [ ] G0-7 `POST /systemone` 打分键对齐、600ms 内、断网降级记审计

G0-8 过关的不是「模型能回话」。核验模型要把一份证据指针被清空的产物判成不通过。实测它判掉了，顺带判掉了伪造引文与零断言空产物。

`dim` 建库即定，除全库迁移外改不了；实测 1024，建库直接用它。

## 还没定的 {#open}

@callout id=open-voice level=open-question title="Voice 层推迟"
DSH 的助手消息不可变，生成后无法改写。v1 只做预生成契约与生成后记账，重启条件是记忆层固化完成。

@callout id=open-proactive level=open-question title="主动搭话推迟"
宿主提供定时投递，卡点不在能力而在门控：概率、日上限、安静时段、硬退避，缺一条就会变成骚扰。
