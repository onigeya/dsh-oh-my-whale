# 追加材料：哦鲸鲸 brief 的支撑细节

> 承接"该留但不属于 brief"的深度。研究证据在 `docs/planning-artifacts/research/technical-agent-memory-architectures-2026-11-22/research.md` 与 `digests/`。

## 1. 四条成功标准的口径

**1.1 记忆准确率**
- 抽样：从 L1 按时间分层抽 50 条（近 7 天 20 条、7–30 天 20 条、30 天以上 10 条），避免只抽"刚写进去的"。
- 判定：从同一会话日志里取原文上下文，双人独立盲判"该记 / 不该记 / 该改"，不一致的进入第三判。
- 记录 False Positive（记了不该记的）与 False Negative（漏记）分开统计——这两者的修复方向相反。
- 拒绝用"检索命中率"作替代指标：命中率高可以因为库小，也可以因为记忆模糊。

**1.2 可治理性**
- 抽 20 条，被问者只允许用产品自带的查询界面/命令，计时到答清三个问题为止。
- "答不清"的常见原因按出现频次记录：没有来源指针 / 版本链断 / 删除无记录 / 检索不到。

**1.3 遗忘可回滚**
- 10 次操作覆盖：手动删除、dream 归档、冲突替换、过期失效、整场景废弃。
- 每次操作后尝试完整撤销，验证：内容一致、版本链复原、Flag 状态复原、检索结果复原。

**1.4 注入成本**
- 记忆量 100 / 1000 / 10000 三档，记录常驻注入 token 数与 prompt cache 命中率。
- 这是唯一一条"达标线故意宽松"的：样本里九家没有一家给过可信数据，先建基线再定线。

## 2. 被否掉的方案（及否掉的理由）

| 方案 | 来源 | 否掉的理由 |
|---|---|---|
| 参数式 dream（后台更新权重/衰退系数） | elo-memory 的设计意图 | 代码里根本没接上（`brain.dream()` 单行、governor 上下文硬编码）；要做对需要可验证的训练回路，本地插件够不着 |
| 四包服务化 + 多存储后端 | TencentDB Agent Memory | 本地插件会被原生模块（CodeGraph 外部二进制）与运维面拖死 |
| 只做 ADD、不裁决 | Mem0 | 只增不减，且没有任何回滚路径 |
| 召回即写入 | CerebroCortex / elo-memory | 记忆被"被检索过的"而非"重要的"占据 |
| 分层用 FSRS + ACT-R 双理论 | CerebroCortex | 需要 50 条访问时间戳与三套参数，且它自己就栽在召回即写入上；样本中没有一家证明复杂衰减带来可测收益 |
| 把裁决完全交给人 | nmem | 机器不提议，用户面对一堆 Flag 无从下手 |
| 把裁决完全交给 LLM | TencentDB | 无版本链回滚，改错了追不回来 |
| 梯度式连续记忆（CMS） | Nested Learning（arXiv:2512.24695） | 记忆更新依赖 ∇L，本地插件无训练回路；无官方代码，社区复现仅 ★3/★2 |

## 3. 对标证据索引（每个结论的出处）

| 结论 | 项目 | 证据位置 |
|---|---|---|
| 遗忘是静默硬删 | nmem | issue #882（open） |
| Flags 人工裁决 | nmem | `docs/advanced-features` |
| 版本链四关系 | nmem | `docs/advanced-features` |
| 有界检索纪律 | nmem | `search-memory/SKILL.md` |
| 6 阶段 dream + 预算 12/4/4 | CerebroCortex | `engines/dream.py:204-288`、`config.py:134-137` |
| 断点续跑 | CerebroCortex | `dream.py:230-257, 921-938` |
| PRAGMA data_version 派生缓存 | CerebroCortex | `storage/graph_store.py:72-136` |
| 召回即写入 | CerebroCortex | `cortex.py:682-690` |
| 幂律衰减 + 对数 rehearsal | elo-memory | `memory/forgetting.py:44-84` |
| 软删除 `_superseded` | elo-memory | `memory/user_memory.py:438-503` |
| 两阶段检索时间邻域 | elo-memory | `retrieval/two_stage_retriever.py:36-49` |
| heat≥5.0 晋升 | MemoryOS | `memoryos.py:140, 242` |
| 画像整篇重写 | MemoryOS | `utils.py:269-281` |
| RRF k=60 与阈值量纲错配 | TencentDB | `search-utils.ts:38-61`、`config.ts:729-737` |
| 三元溯源 | TencentDB | `memory-store.ts:843-929` |
| 谓词先于 LIMIT + 取回复查 | TencentDB | `store/isolation.ts:40,120,155-161` |
| ADD-only 单次抽取 | Mem0 | `memory/main.py:918-1220` |
| 三信号加法融合 | Mem0 | `utils/scoring.py:60-139` |
| 实体链接表 | Mem0 | `memory/main.py:1100-1204` |
| 补丁表 + 稳定 id | LangMem | `extraction.py:262, 472-475, 937` |
| 去抖后台执行器 | LangMem | `reflection.py:307-328` |
| 确定性种子 + 产物即完成标记 | OpenReverie | `engine.ts:3232-3347`、`dreamSchedule.ts:1-42` |
| min_score 前置过滤 | ReFlex.AI | `manager.py:148-152` |
| 声明后从未读取的配置 | ReFlex.AI | `promotion_importance`、`semantic_threshold` |