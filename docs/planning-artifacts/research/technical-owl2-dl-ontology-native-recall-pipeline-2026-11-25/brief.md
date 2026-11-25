---
topic: OWL2-DL ontology-native recall pipeline
type: technical
decision: 是否与如何基于 OWL 2 重新设计 oh-my-whale 的存储 schema，使 TBox/ABox 天然嵌入，并支撑 5 步证明式召回
preset: deep
validation: normal
red_team: on
created: 2026-11-25
---

# Research brief

## The decision

把存储 schema 从 property graph + JSON payload，重构为「天然承载 OWL 2 TBox/ABox」的形态。这个决定要同时满足：

1. 粗召阶段只求全面不求聚焦，可产出几百条候选；
2. 候选能编译成多个 OWL 概念查询，逐条做实体查询与断言的证实/证伪；
3. 未证实/未证伪时，用 Abduction 求最小 delta 做二次查询补证明树；
4. 补不齐时，把信息缺口作为一等召回产物，附已证实/证伪的部分证明子树；
5. 证明过程 + 已有信息 + 缺口合并成召回集合，提交宿主 LLM。

目的是产出「基于 OWL 2 推理后对此问题的形式化证明」与「让推论成立所需的最小额外证据」。

## Existing ground truth (constraint, not evidence)

宿主存储 `triviumdb@0.9.3`：单文件嵌入式，向量 + property graph + payload JSON。

- 节点：`insert(vector, payload)`，payload 为任意 JSON；向量维度固定（默认 1536）
- 边：`link(src, dst, label, weight)`，边可带 metadata；`getEdges` / `getIncomingEdges` / `reachable` / `querySubgraph`
- 索引：`createIndex` / `createUniqueIndex` / `createCompositeIndex` / `createBitmapIndex` / `createOrderedIndex` / `createNgramIndex`
- 查询：TQL 三入口 `MATCH`（图遍历）/ `FIND`（文档过滤）/ `SEARCH`（向量）；`tqlMut` 写操作；`prepareTql` / `executePreparedTql` 预编译带参
- 检索神器：`searchAdvanced`（向量锚定 + FISTA 残差 + SA-PPR 有限深度扩散 + DPP 多样性）、`searchGraphFirst(queryVec, anchorIds, topK)` 只在给定锚点集内精确 Top-K、`searchHybrid` 向量+BM25 双路
- Hook：六个 JS 阶段 hook（`onPreSearch` / `onCustomRecall` / `onPostRecall` / `onPreGraphExpand` / `onRerank` / `onPostSearch`）+ `loadFfiHook` 加载 C ABI 动态库
- 文本：`indexText`（BM25 正文）、`indexKeyword`（AC 自动机关键词）

**它没有 RDF 三元组、没有 SPARQL、没有任何 OWL 推理层。** 这是本研究的核心工程约束：OWL 2 的 TBox/ABox 必须映射到「带 label 的边 + 节点 payload + 二级索引」这套原语上。

工程约束：单进程内嵌（不起子进程、不监听端口），粗召延迟预算 250ms 量级。

## Dimensions (approved, deep)

| # | 维度 | 服务哪一步 |
|---|---|---|
| d1 | OWL 2 配置文件能力边界（DL/EL/QL/RL、direct vs RDF-based 语义、SWRL 可判定性） | 全局选型 |
| d2 | TBox/ABox 到宿主存储的映射范式（三元组直存 / property graph / 查询重写 / 物化 / 增量维护） | ① 存储 |
| d3 | Schema-as-ontology 的工程先例（Stardog/GraphDB/TerminusDB/SHACL 分工/TBox 版本化） | 全局 |
| d4 | 溯因与最小 delta 算法（justification、axiom pinpointing、hitting set 对偶） | ③④ |
| d5 | 概念查询与三值语义（certain answers、OWA 下证伪、LCWA、部分证明树） | ②④ |
| d6 | 概念嵌入与不确定性标注（BoxEL/ELEm/BoxE、fuzzy/probabilistic/defeasible DL） | ① 粗召 |
| d7 | 单进程内嵌推理器的可行性与代价（HermiT/Openllet/ELK/whelk/reasonable、napi、增量分类） | 全局 |
| d8 | 综合为 Schema 设计与架构修订 | 全部 |

## Epistemics

1. 绝不只凭训练数据下结论。已有知识只用来提出假设、查询与结构；结论必须有本轮检索到的证据。
2. 研究防火墙：项目上下文只决定「问什么」，绝不决定「什么是真的」。每条结论追溯到带来源的 digest。

## Knobs in force

- preset: `deep`（用户选定）→ subagents 6、sources/round 12、depth 3
- validation: `normal`（抽查承重结论）
- red_team: `on`（用户选定）→ 主要结论跑反方检索
- 搜索面：harness `web_search` + `web_fetch`（已实测可用）；无已安装的 search 型 MCP 工具
- workflow 编排：不可用（当前环境无该能力），按技能规则线性迭代

## Out of scope

- 不实现代码，只出设计与 AD 修订建议
- 不评估与 OWL 无关的存储替代品（如换掉 triviumdb）
