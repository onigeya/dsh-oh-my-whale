# 研究融合 · 研究线索引

> **2026-11-23 起本文件是历史索引，不是口径来源。** 一切与本项目决定有关的口径以
> `docs/planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/ARCHITECTURE-SPINE.md`（现行 AD-1…AD-55）为准；
> 各研究线 `research.md` 里的推荐（R1…Rn）是**当日证据与建议**，其中被架构采纳的已写进 AD，被否的留在 `architecture/…/reconcile/` 与简报 addendum。
> 六条研究线全部收口，下游 skill 读研究只需读本文件 + 各线执行摘要，不需要重读 digest。
>
> **2026-11-25 补记**：下文 §「六条研究线索引」与「第 1 线的产出」记的是 11-22/11-23 那批线，编号（AD-1…AD-26、FR-1…FR-22）也是当时口径，**不要据此判断现行编号**。此后又新增四条线——`technical-context-governance-2026-11-23`（上下文治理，CAP-7 的 18 条 AD-28…45）、`technical-video-watch-fusion-2026-11-23`、`technical-owl2-dl-ontology-native-recall-pipeline-2026-11-25`，以及两份单文件研究 `memory-layering-precedents.md` 与 `technical-datalog-engine-selection-2026-11-25.md`；它们的产出已并入 PRD §4.8–§4.16 的 FR-34…FR-77，实现归属见 `docs/planning-artifacts/epics.md`。本文件**不**代替这些线的 `research.md`。

## 六条研究线索引

| # | 目录 | 主题 | 状态 | 规模 |
|---|---|---|---|---|
| 1 | `technical-agent-memory-architectures-2026-11-22` | 9 家 agent 记忆架构 | complete | research.md 194 行 + 10 digest |
| 2 | `technical-anthropomorphic-companion-agent-persona-2026-11-22` | 拟人化与宜人化参考（10 个项目） | complete | 439 行 + 7 digest |
| 3 | `technical-dreaming-what-if-counterfactual-simulati-2026-11-22` | Dreaming 阶段的批量 What-If 反事实推演 | complete | 243 行 + 5 份 arXiv |
| 4 | `technical-frozen-weight-policy-iteration-via-memor-2026-11-22` | 冻结权重下的策略迭代（记忆库/案例库路线） | complete | 471 行 + 4 digest |
| 5 | `technical-ontology-world-model-references-2026-11-22` | 本体模型 / 世界模型设计参考 | draft（结论可用，未做收口复核） | 260 行 + 3 digest |
| 6 | `technical-output-humanization-anti-slop-voice-laye-2026-11-22` | 输出端人性化与反八股（风格层落点） | complete | 358 行 + claims.json |

## 第 1 线的产出（融合时的锚点）

- `research.md`：执行摘要 → 9 行横向矩阵（分层/写入/固化/衰减/检索/工程形态）→ 7 条跨项目洞察 → 6 条推荐 R1–R6 → 融合设计草案 v0 → 未决问题 → 来源附录。
- `digests/`：nmem、tencentdb、cerebrocortex、elo-memory、mem0、memoryos、langmem、reflex-ai、openreverie、nested-learning（10 份，每条结论带 `路径:行号`）。
- 三条硬结论：①分层与检索已是标配，差异化只剩「离线固化 + 治理」；②参数式 dream 在样本里是文档幻觉，只能做生成式；③可撤销的遗忘 0/9、LLM 提议+人裁决+版本回溯 0/9。
- Nested Learning（arXiv:2512.24695）= 训练期方法，无官方代码，**无梯度即无 CMS**，对本地插件不可迁移。

## 2026-11-23 进展（超越 11-22 快照，覆盖下文暂停点）

- **简报已按架构校准**：`briefs/brief-DSH哦鲸鲸-2026-11-22/brief.md` 的存储（TriviumDB 单文件）、L3（人格文件 + 偏好节点）、裁决（两级）、固化（八步）、检索（三段预算）、晋升（热度只作读时排序）全部改写为架构口径；7 条反向决议记在简报 `.memlog.md`。
- **架构 SSOT 已定**：`ARCHITECTURE-SPINE.md` 26 条 AD + 同目录 `omw-architecture.html`（四门 pass 的交互呈现）。
- **两份设计稿退役**：`planning-artifacts/design/` 已删除（2026-11-23 用户裁定），存活决定在骨架，被否决定在 `architecture/…/reconcile/reconcile-design.md`。
- **BLOCKING 已关闭**：与 `dsh-mnemon` 的关系由 **AD-16 定为「替换而非共存」**——一次性迁移、不删源文件、幂等、留回滚开关。
- **遗留问题清零（2026-11-23）**：13 条逐条与 Elliott 对齐完毕。甲组 5 条定案并回写 PRD（迁移报告 + 回滚 + 可重跑 / 单人隔 ≥7 天重判 / precision 优先 / v1 只出口径 / 空闲触发）；乙组 4 条实测（bge-m3 实测 1024、255–408ms；本机无 mnemon 数据，迁移改用 fixture 验证）；丙组 4 条过期引用改完。
- **门控口径修正（2026-11-23）**：M0 闸门以骨架为准是 **8 道**（G0-1…G0-8）。此前 SOLUTION-DESIGN、epics、PRD 正文与附录、架构页与状态报告都写「六道 / 六门」，已统一为八道，并补上 G0-7（`POST /systemone` 打分通道与断网降级）与 G0-8（固化提炼 / 核验两个模型 id 与核验行为）。当前已过 4 道（G0-1 / G0-2 / G0-3 / G0-8），其余 4 道待测。G0-8 的实测经过：原定 `Qwen3.5-4B` 三次探测均无响应，按闸门换同族 `Qwen/Qwen3.5-9B`（关思考后单次 11–13s）；核验模型 `deepseek-ai/DeepSeek-R1-0528-Qwen3-8B` 对清空证据指针的产物判 fail、对伪造引文判 fail、对零断言空产物判 fail，但会把完全相同的引文误报 `quote_not_found`（机械子串核验改由调用方做）。证据：`docs/implementation-artifacts/gates/g0-8-2026-11-23.json`，探针 `scripts/probe-g0-8.ts`。
- **规划状态报告**：`planning-artifacts/omw-planning-status-2026-11-23.html`（单文件：M0–M5 分段、10 条定案、八道门、7 项缺口、下一步三件事）。**2026-11-25 订正**：该文件从未入库，现不存在（`docs/` 下无此路径）；状态口径见 `architecture/…/omw-architecture.html`（1.3 MB 交互页，四门 pass 的呈现）与骨架的 G0 闸门表（`ARCHITECTURE-SPINE.md` 的「M0 闸门」段）。
- **PRD 起草中**：`prds/prd-DSH哦鲸鲸-2026-11-23/`（§4 的 FR-1…FR-21 已按五能力分组）。
- **三条线结论的下场**：第 3 线的 What-If 被采纳为八步里的第 ⑤ 步但**默认关闭**；第 6 线的风格层被推迟到 v1 之后（DSH 助手消息不可变）；第 4 线的候选重排被采纳为召回第二段；第 5 线的双时态与本体检判被采纳为三时间轴与 13 kind / 11 edge label。

## 历史快照（2026-11-22 21:30，原文保留）

用户指令：**研究完成后暂停后续产品设计工作**，等其余并行研究全部完成再唤醒；最终如何融合由 lead 整体考虑。
（原话：「现在并行多个研究，所以在你研究之后暂停后续的产品设计工作，等待我其余研究都完成之后重新唤醒你。它们都是背靠背研究，最终如何融合还需要你来整体考虑。」）

## 唤醒后应先读什么（2026-11-23 更新）

1. `ARCHITECTURE-SPINE.md` 的 AD-1…AD-26 与 Open Questions——它已经是研究融合的结论，不需要再从六条线重新推导。
2. `prds/prd-DSH哦鲸鲸-2026-11-23/prd.md` §4（FR-1…FR-22）与 §8（未决 **0 条**；三条定案记录留在 §8.1）。
3. 需要追溯「某条 AD 当初凭什么」时，再回到对应研究线的执行摘要与 `architecture/…/reconcile/`。

## 当前约束（取代 11-22 的三条）

- v1 范围仍是「分层 + 固化 + 治理三件套一起上」，但分层已改写为 L0–L3 的落地对象（见骨架 AD-1 与本文件上方进展）。
- 四条成功标准不变、分阶段达标；dogfood 期只采基线不设质控门控。
- 与 `dsh-mnemon` 的关系已定：**替换而非共存**（AD-16），不再是待决项。

