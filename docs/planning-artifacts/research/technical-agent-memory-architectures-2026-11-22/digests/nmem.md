# nmem · 实现机制 digest

> 访问日期：2026-11-22（所有 URL 均为当日抓取）
> 证据分级约定：**[代码]** 仓库内可读源码；**[官方文档]** 厂商自述；**[issue]** 用户报告；**[推断]** 我基于前两者的推理，未取到直接证据。

## 身份确认（URL、star、语言、最近提交、是否有论文）

**结论：清单给的 URL 已 404，但产品本体存在，且自称 `nmem`——这是地址漂移（rename），不是"项目不存在"，也不是同名替代。**

| 检查项 | 结果 | 证据 |
|---|---|---|
| 清单 URL `github.com/nowledge-co/mem` | **404**（HTML 页 + API 双查） | `curl -o NUL -w %{http_code} https://github.com/nowledge-co/mem` → 404；`https://api.github.com/repos/nowledge-co/mem` → `{"message":"Not Found"}` |
| 同名 raw README（main/master） | 均 404 | `https://raw.githubusercontent.com/nowledge-co/mem/main/README.md` → 404 |
| 组织 `nowledge-co` | 存在（Organization, id 210230799） | `https://api.github.com/users/nowledge-co` → 200 |
| 组织下真实仓库 | `nowledge-mem`、`nowledge-mem-deepseek-harness`、`nowledge-mem-gemini-cli`、`nowledge-mem-google-antigravity`、`community`、`claude-dxt`、`tiddlynmem` … | `https://github.com/orgs/nowledge-co/repositories`（HTML 内 `href="/nowledge-co/…"` 抽取） |
| 目标仓库 | **nowledge-co/nowledge-mem** | 见下 |

nowledge-mem 的元数据（`https://api.github.com/repos/nowledge-co/nowledge-mem`，2026-11-22）：

- 描述： “Memory and context manager just works.”
- star **318**，fork **15**，2025-10-28 创建，**最近 push 2026-08-24**，未归档
- homepage `https://mem.nowledge.co/`，topics：`agent-memory, context-manager, graphrag, mcp, mcp-server, memory`
- 语言字段**为空**（GitHub linguist 未识别主语言）→ 仓库本身几乎不含源码
- 仓库文件树只有 **4 个条目**，可见 blob 仅 `README.md` 与 `refs/nowledge_mem_exchange/example_conversation_file.md`（`/git/trees/main?recursive=1`）→ **核心实现闭源**

**身份判定依据（为什么认定它就是清单里的 nmem）**：该产品的 CLI 命令名就是 `nmem`——`nmem --json m add` / `nmem --json m search "query" -n 5` / `nmem --json wm read` / `nmem spaces list`（`nowledge-mem-agent-plugin/skills/distill-memory/SKILL.md`、`…/read-working-memory/SKILL.md`）。清单里的 “nmem” 即 “Nowledge Mem” 的缩写，`nowledge-co/mem` 是它的旧/短地址。

**论文**：未发现任何 arXiv/论文链接（README、docs 全站导航均无 Publications 入口）→ **无论文（未证实其存在）**。

**⚠️ 排除的同名陷阱**：GitHub 搜索 `nmem in:name` 命中 `dayyanj/nmem`（Python，7★，“6-tier memory hierarchy with hybrid search, background consolidation, confidence…”）。它的功能描述恰好贴近委托书里“多层记忆栈/后台整合”的措辞，**但它是另一个人的项目，与本条清单无关，本 digest 完全未采信它**。若委托方后续发现清单本意是它，需重新派单。

## 一句话定位

闭源、本地优先的**个人 AI 记忆/上下文管理器**（桌面 App + 常驻本地 HTTP 服务 + MCP server），把多个 AI 工具里的对话与洞见沉淀成一张知识图谱，并靠“后台智能”做链接、矛盾检测、结晶（crystal）与每日早报。

## 架构总览（组件与数据流）

```
 AI 工具（Claude Code / Cursor / Codex / Gemini CLI / Copilot …）
   │  ① MCP streamableHttp: http://localhost:14242/mcp   （README 配置块）
   │  ② CLI: nmem …（skills 全篇）      ③ 浏览器扩展 / 线程文件导入
   ▼
 [本地 Mem 服务]  ← Rust 后端（issue #916 提到 “Rust backend”）
   ├── Memory 单元（原子记忆，带 unit_type/importance/space）
   ├── Thread（完整对话线程）
   ├── 知识图谱（实体+关系+版本链；graph WAL，issue #941）
   ├── 检索层：语义 embedding + FTS 全文 + 图遍历（issue #452/#649）
   ├── Working Memory（每日简报，默认 8:00 本地时间）
   └── Background Intelligence（需 Remote LLM + 授权；链接/矛盾/结晶/洞察）
   ▼
 本地存储（LanceDB 向量索引见 issue #452；图存储独立；"~/ai-now/memory.md" 为 legacy 兼容文件）
```

来源：MCP 地址与头部 `APP` 见 `README.md` 的 mcpServers 配置块；CLI 形态见 7 个 SKILL.md；后端语言与索引见 issue #916/#452；简报时间见 `read-working-memory/SKILL.md`。

## 数据模型与存储

**记忆单元（官方文档 + skill 双重印证）**

| 字段 | 取值 | 证据 |
|---|---|---|
| `unit_type` | `fact / preference / decision / plan / procedure / learning / context / event`（8 类） | `distill-memory/SKILL.md`，“Use structured saves … `--unit-type`” |
| `importance` | 0.8–1.0 重大决策；0.5–0.7 有用模式；0.3–0.4 次要笔记 | 同上 |
| `labels` | `-l` 任意标签 | 同上 |
| `space` | 空间（个人 “Only me” / 团队共享 Space），`space_id`、`space_label`、`share_hint` | 同上 “Where It Lands” 段；`memory_add` 返回值 |
| `title` / 正文 | 要求“atomic, standalone memories with strong titles” | 同上 |
| 图谱侧 | 实体（people / technologies / concepts / organizations / projects）+ 关系 + 版本链 | `docs/advanced-features` |

**多层容器（这是它真正的“记忆栈”，与委托书假设的 tier 不同）**：Memories、Threads（对话）、Wiki pages、Working Memory、Activities、Sources、Artifacts（`https://mem.nowledge.co/docs` 原文罗列）；其上是派生物 Crystals（多记忆合成的一篇参考文章）、Insights（跨项目关联发现）、Flags（矛盾/过期/无据断言）。来源：`docs` 与 `docs/advanced-features`。

**存储**：本地优先，“Your knowledge lives on your device by default … your data never touches Nowledge servers”（`https://mem.nowledge.co/docs`）。具体引擎：**未证实**——仓库无源码；仅能从 issue 侧证推断 LanceDB 向量索引（#452 “LanceDB INVERTED index is missing”）、FTS 全文（#649）、独立图存储带 WAL（#941）。**schema 定义文件不可得（闭源）**。

## 写入路径

- **触发**：三种入口——用户在 App 里存、AI 代理在任务中主动存（skill 明确要求 “Save proactively … Do not wait to be asked”）、后台自动抽取（Background Intelligence 对新记忆自动跑实体抽取）。证据：`distill-memory/SKILL.md`；`docs/advanced-features` “With Background Intelligence enabled, extraction runs automatically for new memories”。
- **谁决定写**：**模型决定**（agent 依据 skill 的“何时该存/该跳过”规则判断），不是规则引擎，也不是用户显式点击唯一路径。
- **抽取方式**：LLM 抽取。写入时 LLM 做实体识别 + 与已有图谱建边；蒸馏（distillation）把对话压成 memory，失败会有 `Contract(InvalidCandidate)`/`Contract(InvalidJson)` 这类契约校验（issue #784、#958 —— 说明写入是有 schema 校验的，且校验会拦下模型输出）。
- **去重/噪声控制**（可核查的三条）：
  1. **Add vs Update**：同一决策/流程/偏好若已存在，要求 `nmem m update <id>` 而不是新建（`distill-memory/SKILL.md` “Add vs Update” 段）。
  2. **写入侧白名单**：只存 decision/procedure/lesson/preference/plan/context；“跳过无普适教训的常规修复、进行中的工作、文档可查的问答、广泛已知的常识”（同文件 “When to Save”）。
  3. **后台侧质量闸**：“One insight that changes how you think beats ten that state the obvious. Strict quality gates keep the noise out.”（`docs/advanced-features`）——**闸门的具体阈值未公开，未证实**。
- 自动捕获（auto-capture）与生命周期钩子由各宿主原生 connector 负责，纯 CLI/skill 路径没有（`distill-memory/SKILL.md` “Native Connector” 段）。

## 点名深挖：嵌套学习（Nested Learning）的流转规则、冲突裁决（证据投票晋升、信念修正）、nightly retrospective / dream 调度、多层记忆栈

**先给否证：这套词汇在本项目里 0 命中。**

我对 `docs`、`docs/advanced-features`、`docs/ai-context` 三个页面 + 7 个 SKILL.md 全文做了关键词扫描：
`nested`=`Nested`=0，`dream`=0，`retrospective`=0，`belief`=0，`vote`=0，`half-life`=0，`cron`=0，`tier` 仅 3 次且全部是 “frontier”（图遍历队列，见 `explore-graph/SKILL.md` 的 5 hops/20 neighbors 边界）。
→ **“Nested Learning 流转规则 / 证据投票晋升 / 信念修正 / nightly dream 调度” 在 nmem 中不存在任何证据；任何把它们写成 nmem 机制的句子都是编造。** 这套措辞更像另一条产品线（含 `dayyanj/nmem` 的 6-tier 描述）的用语。

**它实际有的是这四件近似物（机制不同，别混为一谈）：**

1. **版本链（belief revision 的弱形式）**：新记忆与旧记忆比对后建四类关系——`replaces`（“Use CockroachDB” replaces “Use PostgreSQL”）、`enriches`、`supports`（两篇评测推荐同一库）、`contradicts`（三月评估 vs 十月结论）。检索时“both appear with the full trail of how your thinking changed”。证据：`docs/advanced-features`。**注意：这是“并存 + 标注演变”，不是加权投票后旧信念被删除/降权。**
2. **Flags（冲突降级为待办）**：三类问题被标出——互相矛盾的断言、被新笔记覆盖的过期指南、**没有支撑证据的孤立断言**；每个 flag 可 dismiss / acknowledge / link to a resolution。证据同上。这是“冲突裁决”的唯一真实落点，且**裁决权在人**。
3. **Crystals（合并/结晶）**：多条同主题记忆合成一篇带引用的参考文章，新证据到来时更新；“You don't request them”，由系统判断材料是否足够。证据同上。
4. **每日 Working Memory（近似“nightly retrospective”，但发生在早晨）**：每个 space 每天生成一份简报，含 Active Focus Areas（按近期活动排序）、Priorities、**Unresolved Flags**（矛盾/过期/待核实）、Recent Activity、Deep Links；默认 **8:00 本地时间**，可在设置里改。证据：`read-working-memory/SKILL.md`（“Updated daily at your configured briefing time (default: 8 AM local time)”）+ `docs/advanced-features` 的 “Each morning, Mem writes a Working Memory briefing for the current space”。
   → 机制上是**生成式摘要 + 图查询**，不是 sleep-time 梯度/参数更新，也不是随机“梦”。

**结论**：委托书点名的三件事（Nested Learning、证据投票晋升、dream）→ **未证实/不存在**；可对标的是 版本链 + Flags + Crystals + 每日简报。这个差别必须写进下游对比表，否则整张对比表会被污染。

## 读取路径

- **检索方式：混合**——语义（embedding）+ 关键词（FTS 全文）+ 图（`explore_graph`）。证据：`search-memory/SKILL.md` 的 “Retrieval Routing”；issue #452 提到 LanceDB INVERTED 索引与 embedding 超时；issue #649 提到 “Thread-message FTS”。
- **三档模式**（`search-memory/SKILL.md` “Retrieval Modes”）：
  - `normal`：具体事实、有界召回（默认档）
  - `deep`：概念/理由/历史/跨主题关系；当 normal 结果为空、含糊、冲突、不足时升级
  - `progressive graph search`：从一个**精确 Memory ID** 出发逐跳扩展，`depth=1`、`limit=15` 起步；`explore-graph` 默认边界 **5 hops、每跳 20 neighbors**
- **排序与阈值**：**不公开**。skill 反而明令 “Do not invent score thresholds the server did not return”“Use server-returned scores only when present” → 说明 score 由服务端给，客户端不设阈值。
- **注入 prompt 的形态与 token 预算（有界检索纪律，这是它最工程化的一块）**：
  - 记忆检索默认 `-n 5`（5 条）
  - 线程读取：`thread_fetch_messages` 或 `nmem t show --limit 8 --offset 0 --content-limit 1200`，**每个问题最多调一次**，明确禁止用 offset 循环重建对话
  - 宁可报“证据不足”也不许放大 `--content-limit` 去补慢读
  - 启动注入用 `nmem --json context --source-app <app>`（Context Bundle：owner identity / AI Identity / active scope / active rules / Working Memory），或轻量档 `nmem --json wm read`
  证据：`search-memory/SKILL.md`（“Bounded thread reads” 段）、`read-working-memory/SKILL.md`。**没有任何 token 数预算被写死**，预算是以“条数 + 字符数 + 调用次数”表达的——这比 token 预算更好落地。

## 生命周期规则与参数

可确证的只有这些（其余**未证实**）：

| 环节 | 规则 | 参数 | 来源 |
|---|---|---|---|
| 重要性分级 | 写入时由模型给 importance | 0.8–1.0 / 0.5–0.7 / 0.3–0.4 三档 | `distill-memory/SKILL.md` |
| 合并 | 同主题多记忆 → crystal（带引用、随新证据更新） | 触发条件未公开 | `docs/advanced-features` |
| 修正 | 新旧冲突 → version link（replaces/enriches/supports/contradicts） | 无阈值公开 | 同上 |
| 降级/标记 | 矛盾、过期、无据断言 → flag（dismiss/acknowledge/link） | 无阈值公开 | 同上 |
| 简报刷新 | 每 space 每日一次 | 默认 08:00 本地时间，可配 | `read-working-memory/SKILL.md` |
| 衰减 / 半衰期 / 遗忘 | **不存在公开规则**；文档无 decay、无 half-life（grep=0） | — | 关键词扫描 |

**反证一条**：所谓“遗忘”在实现里更接近**静默硬删除**，且被用户当成 bug 报（issue #882：“Memories silently hard-deleted while background curation runs — zero deletion events in feed, unrecoverable”，open）。

## 后台调度

- **调度方式**：非 cron 表达式（`cron` 关键词 0 命中），是**应用内后台任务 + 每日定点**（简报 8:00 本地时间）+ **事件触发**（新记忆入库即触发实体抽取）。证据：`docs/advanced-features`、`read-working-memory/SKILL.md`。
- **依赖**：Background Intelligence **必须配置 Remote LLM 且有对应 license**，否则整套后台能力不跑（`docs/advanced-features`：“requires a configured Remote LLM and the appropriate license for your build”）。本地优先 ≠ 本地推理。
- **并发/幂等/失败恢复**：无公开设计文档。**从 issue 反推的真实故障面**（均为用户报告，单一来源）：
  - 图存储非正常退出后 WAL 卡死，**永久无法启动**，且内置自动恢复不可达（#941）
  - 后台策展期间记忆被硬删（#882）
  - 蒸馏连续 3 天 0 产出，多种 provider 的合法 JSON 被 `Contract(InvalidJson)` 拒绝（#958、#784、#774）
  - 检索在 embedding 超时后挂起、重建索引永不完成（#452）；线程 FTS 超时且重建无进度（#649）
  → **失败是静默的**，这是它最大的工程债。

## 工程形态与代价

- **语言/技术栈**：核心闭源。可见线索：Rust 后端（#916 “Rust backend keeps local embedding model resident”）、LanceDB 向量索引（#452）、独立图存储带 WAL（#941）、本地 embedding 模型常驻内存（#916）。仓库本身零源码（4 个 tree 条目）。
- **宿主形态**：**桌面 App（主）+ 本地 HTTP 服务（localhost:14242）+ MCP server（streamableHttp）+ CLI（`nmem`）+ 浏览器扩展 + 各宿主原生 connector 插件**。不是库，不是可嵌入 SDK。
- **部署复杂度**：中——装 App 即可，但要拿到全部能力需：Remote LLM key + license + 可选团队 Space/多设备共享（`nmem config client set --url … --api-key …`）。跨设备需一台常开机器（`docs`：“run one Mem on an always-on machine”）。
- **可观测性**：弱。Timeline 里有 Activities/flags 可看，但失败**没有可操作诊断**——#774 的标题就是 “needs actionable diagnostics”，#882 抱怨 “zero deletion events in feed”。
- **性能数字**：**没有官方 benchmark**。唯一可引的量化来自用户报告：#664 “28 calls at 13–30s each, one Codex turn produced no output”（单条 issue，**单一来源，不能当基准**）。
- **许可证**：仓库无 LICENSE 文件；官网有 `/licenses` 页但未核验内容 → **未证实**。

## 可迁移到「本地优先的 DSH 插件」的部件

1. **原子记忆 + 8 类 `unit_type` + 三档 importance**
   能搬：枚举与分档本身就是廉价而有效的写入约束，能显著压低“什么都记”的噪声；DSH 插件里做一个 JSON schema 就够。
   会坏在哪：importance 是**模型自评**，没有校准机制；跨模型（DSH 里可能换模型）分档会漂移，需要固定 rubric 文本而非裸数字。

2. **Add-vs-Update 的写入协议（先查重再写）**
   能搬：写前用一次检索判断“是否已有同决策”，有则 update。比事后去重便宜一个数量级。
   会坏在哪：需要稳定的 id 与可更新的存储；纯文件式 memory.md 做 update 会退化成重写整文件（并发写有风险）。

3. **Working Memory 每日简报 + Unresolved Flags**
   能搬：这是“跨会话连续性”的最高性价比形态——一次生成、全天复用、可缓存、可被任意 host 读取；Flags（矛盾/过期/无据断言）把“记忆质量”变成**待办清单**而不是隐式概率。
   会坏在哪：它需要**每天一次 LLM 调用 + 全库扫描**；DSH 插件若无后台常驻，只能在 session start 惰性生成，会撞上首轮延迟。必须做 TTL 缓存 + 增量（只处理 since-last-run 的新记忆）。

4. **有界检索纪律（8 条消息 / 1200 字符 / 每问一次 / 禁翻页）**
   能搬：这条比任何排序算法都更能省钱、更能防“代理把上下文烧光”。可以直接写成 DSH 插件里的硬约束 + 工具层截断。
   会坏在哪：对“必须通读长文档”的任务过严，需要显式的逃生阀（用户点名要求时才放开）。

5. **四态版本链（replaces / enriches / supports / contradicts）**
   能搬：比“覆盖写”信息量大得多，且天然可审计——旧信念不删除，只标记演变。
   会坏在哪：需要图存储或至少一张边表；纯 markdown 方案要退化成 front-matter 里的 `supersedes:` 列表，查询得自己实现。

**最不该照抄的一条**：**把后台策展做成不可见、不可撤销的写操作**（#882 静默硬删、#941 WAL 卡死、#958 蒸馏静默 0 产出）。本地优先插件里，任何删除/合并都必须留 tombstone、必须进事件流、失败必须冒泡成用户可见的一条 flag——否则用户丢的是自己的记忆，且无法恢复。

## 未证实 / 缺口

- 存储 schema、表结构、字段类型、索引定义：**闭源不可得**（仓库仅 4 个 tree 条目）。
- 检索的排序函数、分数区间、相似度阈值：**未公开**；官方 skill 甚至禁止客户端臆造阈值。
- 衰减/半衰期/遗忘参数：**文档中不存在**（grep 命中 0）。
- Crystal / Insight 的“足够材料”判定阈值：**未公开**（原文只说 “Strict quality gates”）。
- Background Intelligence 的并发模型、幂等键、重试策略：**无公开资料**。
- 性能基准：**无官方数字**；唯一量化来自 issue #664（单一来源）。
- 许可证：未核验。
- 是否存在论文/技术报告：**未发现**。
- **委托书点名的 “Nested Learning / 证据投票晋升 / 信念修正 / nightly dream” 在 nmem 中无任何证据（0 命中）**——这是本 digest 最重要的负结论。

## 来源清单（每行：标题 — URL — 访问日期 2026-11-22）

- 清单给定地址（404）— https://github.com/nowledge-co/mem — 2026-11-22
- 清单给定地址 API（404）— https://api.github.com/repos/nowledge-co/mem — 2026-11-22
- 组织 nowledge-co 仓库列表 — https://github.com/orgs/nowledge-co/repositories — 2026-11-22
- nowledge-mem 仓库元数据 — https://api.github.com/repos/nowledge-co/nowledge-mem — 2026-11-22
- nowledge-mem 仓库树 — https://api.github.com/repos/nowledge-co/nowledge-mem/git/trees/main?recursive=1 — 2026-11-22
- Nowledge Mem README（含 MCP localhost:14242 配置）— https://raw.githubusercontent.com/nowledge-co/nowledge-mem/main/README.md — 2026-11-22
- 官方文档首页（local-first、多层容器罗列）— https://mem.nowledge.co/docs — 2026-11-22
- 官方文档：Background Intelligence / 图谱 / 版本链 / Crystals / Flags — https://mem.nowledge.co/docs/advanced-features — 2026-11-22
- 官方文档：AI context / Context Bundle — https://mem.nowledge.co/docs/ai-context — 2026-11-22
- 站点地图（文档目录结构）— https://mem.nowledge.co/sitemap.xml — 2026-11-22
- skill: distill-memory（unit_type / importance / add-vs-update / space）— https://raw.githubusercontent.com/nowledge-co/community/main/nowledge-mem-agent-plugin/skills/distill-memory/SKILL.md — 2026-11-22
- skill: search-memory（normal/deep/progressive、有界线程读取）— https://raw.githubusercontent.com/nowledge-co/community/main/nowledge-mem-agent-plugin/skills/search-memory/SKILL.md — 2026-11-22
- skill: read-working-memory（每日简报、默认 8 AM）— https://raw.githubusercontent.com/nowledge-co/community/main/nowledge-mem-agent-plugin/skills/read-working-memory/SKILL.md — 2026-11-22
- skill: explore-graph（5 hops / 20 neighbors 边界）— https://raw.githubusercontent.com/nowledge-co/community/main/nowledge-mem-agent-plugin/skills/explore-graph/SKILL.md — 2026-11-22
- issue #882 后台策展静默硬删 — https://github.com/nowledge-co/community/issues/882 — 2026-11-22
- issue #941 图 WAL 脏退出导致无法启动 — https://github.com/nowledge-co/community/issues/941 — 2026-11-22
- issue #958 蒸馏 3 天 0 产出 / InvalidJson — https://github.com/nowledge-co/community/issues/958 — 2026-11-22
- issue #784 Contract(InvalidCandidate) 导致蒸馏不落库 — https://github.com/nowledge-co/community/issues/784 — 2026-11-22
- issue #774 需可操作诊断 — https://github.com/nowledge-co/community/issues/774 — 2026-11-22
- issue #452 embedding 超时后检索挂起、LanceDB 索引缺失 — https://github.com/nowledge-co/community/issues/452 — 2026-11-22
- issue #649 线程 FTS 超时、重建无进度 — https://github.com/nowledge-co/community/issues/649 — 2026-11-22
- issue #916 Rust 后端常驻本地 embedding 模型 — https://github.com/nowledge-co/community/issues/916 — 2026-11-22
- issue #664 渐进式线程引导导致 28 次调用/13–30s — https://github.com/nowledge-co/community/issues/664 — 2026-11-22
- issue #444 中文语义查询排序错乱（0.10.30 已修，closed）— https://github.com/nowledge-co/community/issues/444 — 2026-11-22
- 同名易混项目（未采信）— https://github.com/dayyanj/nmem — 2026-11-22
