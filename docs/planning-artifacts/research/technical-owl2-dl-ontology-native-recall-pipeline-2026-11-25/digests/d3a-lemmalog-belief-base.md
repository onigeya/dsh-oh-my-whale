# d3a — Lemmalog：Datalog 信念基的完整工程实现（最接近本目标的外部先例）

source: https://github.com/JordyZomer/lemmalog （git clone --depth 1 实读源码与 README，2026-11-25）
publisher: Jordy Zomer（个人仓库）；设计文档自署 "Design document — August 2026"
pub_date: 2026-08（设计文档自署）
accessed: 2026-11-25
confidence: high（直接读仓库 README 功能表 + datalog-context-engine-design.md 全文）
class: 工程先例

## 核心主张（原文）

> "an agent's memory should be a **deductive database** — the agent builds a *verifiable model of what it knows* and mechanically reasons over how that knowledge changes, rather than 'remembering better' than a vector store."

> "LLM agents fail on long horizons for a structural reason: *context is treated as a buffer, not a database*."

## 已实现功能表（README 逐条核对，全部标 ✅）

| 能力 | 具体实现 | 对本项目的意义 |
|---|---|---|
| Runtime-parsed, stratified Datalog（解释器而非 proc-macro） | 规则可运行时装载/卸载 | 宿主 LLM 可动态装规则，不用重编译 |
| Negation-as-absence with **negative-cycle rejection** | 分层否定，拒绝负环 | NAF 被显式限制在分层内，避免非单调失控 |
| Seminaive fixpoint + per-epoch delta maintenance | 每轮只算增量 | 对应「每轮对话是一个小 delta」 |
| Bi-temporal facts：`valid_from`/`valid_to`/`asserted_at` + `now()` | 双时间轴 | 与现有 schema 的 valid_from/valid_to 同构 |
| **Semiring annotations：confidence（product t-norm）× provenance（set union）** | 置信度与溯源在同一代数里 | 正是「信念强度 + 凭什么」的统一载体 |
| Annotation merge on re-derivation（max conf, union prov, deduped supports） | 同一事实多次推导时合并 | 避免重复推导导致置信度爆炸 |
| **`why()` proof trees with cycle protection** | 可追溯证明树 | 服务第 4 步「部分证明子树」 |
| Additive arithmetic in comparisons（`D = Dm + 1`）with linear solving | 比较中带算术 | 精细但非核心 |
| **Scoped negative deltas：retraction recomputes only transitive dependents** | 撤销只重算传递依赖 | **这就是核收缩的工程近似** |
| `ask()` 只读查询面 / `ask_deep` magic-sets 按需求值 | 点查询不全量不动点 | 对应召回的低延迟要求 |
| Epoch change-log：`changes_from/since` + "new in memory" 章节 | 变更流 | 可增量同步给宿主 |
| Hybrid retrieval（`context_for_query`）：BM25 + entity/graph boosting，budget-aware | 混合检索 | 对应第 1 步粗召 |
| Deterministic update policy：**ADD / UPDATE / NOOP / escalate** | 写路四分支 | escalate = 冲突升级给人/宿主 |
| Positional `ContextAssembler`（distilled top, verbatim provenance bottom, budget） | 位置感知的上下文组装 | 与 AD-8 的 topK 有界注入直接对应 |
| **DRed-lite scoped recompute** | supersession 只重建真正变化的部分 | 见下节 |
| `what_if` hypotheticals：assume → fixpoint → restore byte-identically | 反事实前瞻 | 服务第 3 步溯因的试验性推演 |
| Streaming change feed：`Added`/`Retracted`/`Cleared` | 变更事件 | 给投影/向量索引同步 |
| Entity resolution：star-shaped `alias(Local, Canonical)`，Datalog 推闭包，读侧规范化视图 | 实体归一 | 对应 sameAs 问题 |
| Rule registry：versioned batches，install/uninstall + backfill | 规则版本化 | TBox 演进可回滚 |
| Differential testing：450 随机程序 vs 朴素不动点 oracle + parser fuzzing | 差分测试 | 推理引擎正确性保障 |

## 关键设计决策（可直接借鉴的三条）

### 1. 派生关系永不持久化（event sourcing）

> "Derived relations are never persisted — they are rebuildable projections, recomputed on load (event sourcing, per the design doc)."

持久化只存：rules、clock、episodes（逐字来源）、escalation queue、base facts + annotations。**推导结果全部可重建**。

这对本项目极其关键：意味着 OWL 层的物化闭包不必成为存储的真相来源，只需是缓存。schema 只需保证 base facts + rules 完整。

### 2. supersession 是「定向重算」，不是「全量重推」

> "Retraction cost: supersession uses a DRed-lite scoped recompute — dependents are cleared level by level in stratum order, and a level is only rebuilt-and-propagated-into if its input's key set actually changed. A `works_at` supersession rebuilds `current` (linear) and leaves a manager-only closure untouched."

DRed = Delete-Rederive（Gupta/Mumick/Subrahmanian 1993）。lemmalog 做的是「lite」版：按 stratum 逐层清空依赖，只在输入的 key set 真变了时才重建该层。

**这正是 AGM 核收缩缺的那一半**：AGM 说「移除某信念时要找到包含它的所有极小冲突集（kernel）并各删一条」，但没说要怎么高效重算。DRed 给了工程答案。

### 3. 冲突不是静默处理，而是升级（escalate）

更新策略四分支 ADD / UPDATE / NOOP / **escalate**。冲突不能被自动化解时就升级。

评测数据（seed 42, 1000 turns, 30 people）：
```
knowledge updates   : 30/30 correct (220 supersessions applied)
multi-hop reasoning : 40/40 correct (magic-sets ask_deep, 7.6 ms total)
conflict abstention : 29/29 conflicted people keep ALL open preferences
overall accuracy    : 100.0%
token economics     : 422 ctx tokens vs 5386 transcript tokens (12.8x saving)
maintenance latency : 1.5 ms/turn
```
注意 `conflict abstention : 29/29 conflicted people keep ALL open preferences` —— **冲突时保留全部开放偏好而不选边**，这就是「如实报缺口」的一种实现。

## 与 OWL 2 的语义对立（这是最重要的发现）

| | Lemmalog（Datalog） | OWL 2 DL |
|---|---|---|
| 世界假设 | 封闭（negation-as-absence） | 开放（OWA） |
| 证伪来源 | 「推不出来」即假（但被 stratification 限制） | 必须有显式否定/不相交/基数冲突 |
| 冲突处理 | 分层 + 拒绝负环，保证唯一最小模型 | 允许不一致；不一致时一切皆真，必须报错 |
| 单调性 | 非单调（retraction 会撤销已推出的事实） | 单调（新增公理只会增加蕴含） |
| 可判定性 | 分层 Datalog 保证终止 | SROIQ 可判定但 ExpTime |
| 置信度 | semiring annotation，**参与推导**（product t-norm） | annotation **不参与语义**（规范明文） |

**结论：两者不是可以简单叠加的层，而是两套互斥的认识论。** 这一点直接否决了「在 OWL 之上加 Datalog」或「在 Datalog 之上加 OWL」的朴素拼接方案。必须选一个作为语义基底，另一个只能作为局部工具。

## 对本项目的直接含义

1. **lemmalog 已经实现了「信念基 + 定向收缩 + 溯源证明树 + 有界注入」的全部要素**，且是 Rust 单进程、可嵌入。它是本项目最接近的先例，应当作为**架构参照系**而不是被忽略。
2. **`why()` proof tree + semiring provenance 就是第 4 步「部分证明子树」的现成形态**。
3. **DRed-lite 是核收缩的工程答案**，比 AGM 原始表述更可落地。
4. **semiring annotation 让 confidence 参与推导** —— 这是 Lemmalog 与 OWL 2 最根本的冲突点。若本项目最终选 OWL 2 作基底，confidence 必须退回 annotation（不参与语义）；若选 semiring 路线，则放弃 OWL 2 的标准语义。**这是必须由用户裁定的分叉点**。
5. 教训：`Negation-as-absence with negative-cycle rejection` 说明 lemmalog 自己也承认纯 NAF 会失控，必须靠分层约束。本项目若走封闭世界路线，同样需要分层设计。

## 未核实项

- 未编译运行 lemmalog，未验证其 README 声称的测试数（44 tests）与评测数字。
- 未读 `src/eval.rs` 内部实现，DRed-lite 的具体算法细节未核验。
- 未核验其对「多条 justification / 多核」的处理——README 只提到 `why()` 单条证明树，未提 justification 枚举。
