# R2 状态引擎样本：agethos × ai-character-engine

访问日期 2026-11-22。agethos HEAD `d2cf701`（v0.16.0）；AICE HEAD `36a362c`。

## 1. 概览
- **agethos**（jinsoo96/agethos）：Python 库，把 persona/memory/reflection/planning/steering 打成可导出 `.brain.json` 的"大脑"。**8★**、100 blob、无 LICENSE 文件（GitHub API license=null，但 pyproject 与 README 自称 MIT）。2026-03-24 建，2026-07-10 最后推送；17 天内连发 v0.10→v0.16 七个版本后停更——脉冲式维护，单人节奏。
- **AICE**（aivrar/ai-character-engine）：TypeScript 游戏 NPC 运行时，**7★ / MIT / 159 blob**。5 次提交，最后一次 2026-04-26 仅改 URL，实际开发止于 2026-03-01；README 称 415 tests，仓库有 30 个 tests/ 文件（未运行，不计为已验证）。

## 2. 架构与核心数据模型
agethos 分层：`models.py`（全部 pydantic 模型）→ `cognition/`（perceive/retrieve/reflect/emotion/relationship/plan）→ `persona/`（renderer + policy）→ `memory/`+`storage/` → `learning/` → `forge/`+`steering/`。AICE 由 Engine 组装约 20 个 manager，全部实现 `Persistable{saveState,loadState}`，由 StatePersistence 单事务落 SQLite（`src/db/StatePersistence.ts:30-50`）。

- `OceanTraits`：5 个 float[0,1]，渲染按 **0.66/0.33** 切 HIGH/MID/LOW（`agethos/models.py:141-186`）。
- `PersonaSpec`：3 层身份 l0/l1/l2（每层仅 `traits: dict[str,str]`）+ 6 facet（identity/tone/values/boundaries/conversation_style/transparency）+ ocean + PAD + behavioral_rules + hard/soft constraints（`agethos/models.py:544-593`）；`PersonaLayer` 只有一个字段（`:538-541`）。
- `EmotionalState`：PAD 各 -1..1 + velocity，12 个情绪坐标表，`from_ocean` 线性映射，`step()` 用 μ=0.85 的二阶惯性（`agethos/models.py:238-363`）。
- `Relationship`：strength 0–100 默认 50；`record` 用 valence[-5,5]×gain 5，空闲 24h 向 50 回归，tier 阈值 75/55/40（`agethos/cognition/relationship.py:26-61`）。
- `BrainState` 聚合 persona+memories+relationships+lessons+mental_models 整体序列化（`agethos/models.py:879-908`）。

## 3. 拟人化
- **人格持久化**：L0/L1/L2 字典分层；L1 由 SocialPattern→behavioral_rules 自动演化（`agethos/learning/evolution.py:29-108`，min_confidence 0.7、min_level L1）。防漂移靠"固定渲染顺序 + 硬约束段"，但 `render_iss` **没有 token 预算**，全量拼接（`agethos/persona/renderer.py:18-109`）；全仓 grep "token" 只命中 eval 的 token-Jaccard。
- **一致性验收（可复用）**：`forge/verify.py` 把 **20 题 Mini-IPIP**（Donnellan 2006，含反向计分）一次性发给"戴着人设"的模型自评；Likert 1–5，反向取 6-v，按 trait 求均值归一到 [0,1]，`ocean_similarity = 1 - 欧氏距离/√5`，输出 trait_gaps（`verify.py:24-109`）。SOTOPIA 侧用 7 维 rubric 让 evaluator 出 JSON（goal 0..10、secret -10..0 等），`overall()` 归一化除以 7（`models.py:937-951`；`eval/sotopia.py:38-66`）。forge 循环 weak_threshold 0.7、max_rounds 3 修复弱项（`forge/loop.py:57-117`）——但 fidelity 只报告，无硬性通过线。
- **情绪**：`emotion.py` 一次 LLM 调用抽 PAD，异常回落 (0,0,0)（`cognition/emotion.py:22-35`）；`brain.chat` 不自动更新情绪，需显式 `apply_event_emotion`（`brain.py:477`）。
- **关系**：RelationshipBook 有衰减与 tier，但 `brain.chat` 未接线——库化设计，得调用方手动 record。

## 4. 在线 / 离线
在线每轮：perceive → retrieve top10 → `render_full` → LLM → Self-Refine（可选）→ 写回 MemoryNode → importance 累计 ≥**150** 触发反思（`brain.py:316-397`；`cognition/reflect.py:61-91`）。反思产出 depth+1、importance 8.0、带 evidence_ids 的 THOUGHT 节点，写回**同一条 memory stream**，下一轮 retrieve 自然带回。离线：ConsolidationEngine 按 evidence_count 3/10/10 与 confidence 0.8 计算 L0–L3、TTL 72h/90d/365d/∞（`learning/consolidation.py:23-109`）——等级是"算出来的"而非存储，demote 分支只保留不降级；Autopilot 1s tick 轮询环境事件、空闲时主动搭话（`autopilot.py:34-178`）。
**steering 不需要权重**：rerank 采 n=4、temperature 0.9，用 trait 极词表打分 + 可选 LLM judge×3.0 取最优（`steering/rerank.py:70-114`），成本 = n 次生成 + n 次 judge；vectors 走 mean-diff + Gram-Schmidt + α=4.0，需 torch 可选依赖（`steering/vectors.py:54-99`）。

## 5. AICE 状态层（问题 6–8）
- **Emotion** 8 类，decay 0.05/tick + 每种情绪地板值（anger 0.15…），同情绪叠加 +0.5×intensity，mood 取最大（`src/agent/EmotionManager.ts:5-133`）。**Needs** 5 种：rest .003、social .002、sustenance .004、safety .001、purpose .002 每 fast tick 增长，由工具/事件满足（`NeedsManager.ts:192-236`）。**Goal** 多步 steps + priority 1–10（`GoalPlanner.ts:18-140`）。**Proximity** closeness 0–100，decay 0.1/tick，事件增益 combat+5/rescue+8/betrayal−10，tier 60/20，chat≥40、delegate≥60（`ProximityRules.ts:17-85`；`core/config.ts:65-75`）。**Routine** 相位制取最高优先级活动（`RoutineManager.ts:116-141`）。**PlayerModeler** 记交互计数→偏好比例，≥5 次才注入（`PlayerModeler.ts:91-103`）。
- **快/慢 tick**：fast 2s、最多 15 个 active；slow 30s、最多 50，做 tier 刷新、closeness 衰减、记忆衰减/巩固、摘要重生成（light 模型 maxTokens 300）（`scheduler/TickScheduler.ts:299-380`；`config.ts:77-83`）。dormant 每 5 个 slow tick 跑一次（`scheduler/AgentScheduler.ts:60-75`）。状态全在 manager 内存 Map + SQLite 表。
- **prompt 注入**：TokenBudget active 800/150、background 400/100、dormant 250/80，importance≥6/5 可临时升档（`inference/TokenBudget.ts:13-70`）；ContextAssembler 先算 base prompt，**<45% 预算**才加扩展、扩展后 **>65%** 回退，记忆 <75%，working memory 占剩余 50%（`agent/ContextAssembler.ts:65-160`）。摘要、情绪、需求、目标、关系、routine 都以短句进入 XML 段（`PromptBuilder.ts:99-175`）。
- **主动性节流**：InitiativeChecker 每轮 maxPerCycle=2，按 上级命令 > 情绪0.5 > 需求0.7 > 目标 > 关系70 产出事件，溢出排队（`InitiativeChecker.ts:9-31,52-135`）。**未见**基于用户作息/勿扰时段的静默策略。

## 6. 可迁移机制（DSH）
1. **Mini-IPIP 验收** → 离线脚本或定时任务跑 20 题，domain KV 存 fidelity/gaps，GUI 卡片展示漂移；成本 1 次 LLM 调用；风险：自评迎合偏差。
2. **PAD + 二阶惯性** → domain KV 存 3 float + velocity，工具写入，prompt 只注入一行 `to_prompt`；约 20 token/轮；风险：常驻注入破坏前缀缓存，须置于变体段末尾。
3. **关系 strength 0–100 + 24h 回归 + tier 门槛** → domain KV + 每日定时任务衰减，tier 决定主动消息频率；风险：无对话事件时 valence 需自定。
4. **快/慢分层 + 预算门控** → 在线只做轻量，巩固/摘要交定时任务；扩展段按 token 预算百分比准入，直接映射 DSH 定时任务 + prompt section。
5. **反思阈值触发** → 定时任务跑反思，洞察写 domain KV，下轮以工具结果注入；会话日志只读，需自建事件表。
6. **best-of-n steering** → 工具化"重说一遍"（n=3 采样+打分），3× 成本与延迟。

## 7. 不可迁移 / 风险
- agethos **无 LICENSE 文件**（API license=null），pyproject/README 却写 MIT——法务上不可直接搬；AICE MIT 可搬，但绑定 drizzle/SQLite/vitest 与游戏 tick 循环。
- AICE 文档称 Dormant ≥5，代码 `getTier` 实际 <20 即 dormant（`config.ts:71` vs `ProximityRules.ts:67-71`）——配置项未生效。
- agethos 反思/关系/情绪都要显式调用，不是"每轮自动"，移植时别按 README 的自动化叙事设计。

## 8. 未找到证据 / 开放问题
- AICE "415 tests""35 子系统"仅 README 宣称；agethos README 一处写 211 tests、一处 161 tests，与 15 个测试文件对不上（均未运行）。
- 两仓均无真实用户对话数据，宜人化的"语气一致性"没有可引用指标。
- AICE 的 prompt 节流只看 importance，没有"用户刚说过话就别插嘴"的时间窗，需自建。

## 证据清单
1. `agethos/models.py:544-593` PersonaSpec 字段全集
2. `agethos/models.py:227-363` PAD + 情绪动力学
3. `agethos/persona/renderer.py:18-145` ISS 渲染顺序（无预算）
4. `agethos/cognition/reflect.py:61-114` 反思阈值与 insight 写回
5. `agethos/forge/verify.py:24-109` Mini-IPIP 计分与 fidelity
6. `agethos/learning/consolidation.py:23-109` L0–L3 TTL 与升降级
7. `agethos/steering/rerank.py:70-114` best-of-n 成本结构
8. `src/agent/EmotionManager.ts:5-133` 情绪衰减与地板
9. `src/inference/TokenBudget.ts:13-70` 分档预算
10. `src/agent/ContextAssembler.ts:65-160` 预算门控与回退
11. `src/scheduler/TickScheduler.ts:299-380` 快/慢 tick 分工
12. `src/agent/InitiativeChecker.ts:9-135` 主动性优先级与配额
