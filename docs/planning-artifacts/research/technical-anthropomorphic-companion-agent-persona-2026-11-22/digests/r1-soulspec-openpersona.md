# R1 digest：SoulSpec / OpenPersona（人设定义层）

访问日期 2026-11-22。soulspec@`124bd73`（main，最后提交 2026-07-27，22★，Apache-2.0，66 文件）；OpenPersona@`03b924f`（v0.22.0，最后提交 2026-08-11，61★，MIT，374 文件）。两者均为单点提交、无 issue（open_issues=0），维护活跃度：**低—中**（soulspec 近 4 个月仅文档提交；OpenPersona 4 个月 1 次合并）。

## 1. 概览
- **SoulSpec**：不是库，是**文档站**（Docusaurus，仅 `src/pages/index.tsx`）。"可校验"完全依赖外部 npm 包 `clawsouls`、`clawsouls-mcp` 与 clawsouls/registry——仓库内**没有任何 JSON Schema 或校验代码**。
- **OpenPersona**：可运行的 Node CLI（`bin/cli.js`，v0.22.0），把人设声明编译成 SKILL.md 技能包，默认绑 OpenClaw；40 个 `*.test.js`，自带 JSON Schema。

## 2. 架构与关键机制
**SoulSpec**：`soul.json`（元数据）+ 若干 Markdown 文件。`SOUL.md` 是**自由文本**，没有 section schema；建议结构只在 README 示例里（`README.md:64-82`：Personality/Principles/Boundaries/Patterns）。可选文件 IDENTITY/AGENTS/STYLE/HEARTBEAT/USER_TEMPLATE（`docs/spec/overview.md:15-29`）。v0.6 新增 RULES.md、memory/、skills/、tools/*.yaml、hooks/bootstrap.md（`docs/spec/v0.6.md:52-62`）。
`soul.json` 必填：`specVersion,name,displayName,version,description(≤160),author{name,github},license,tags(≤10),category,files.soul`（`overview.md:37-48`）；v0.5 加 `safety.laws[{priority:0-3, rule, enforcement:hard|soft}]`、`environment,interactionMode,sensors,actuators`（`docs/spec/v0.5.md:330-385`）；v0.6 加 `type:persona|pack`、`includes{skills,tools,memory,rules,hooks}`、`memory{format,layout,search.default:tfidf,search.enhanced:llm-rerank,sync}`、`registry{scanGrade,scanScore}`（`v0.6.md:44-50,186-209`）。**注意 v0.6 是 Draft，稳定完整版是 v0.5**；且 `overview.md` 未同步 0.6。
**OpenPersona**：4+5+3——四层 Soul/Body/Faculty/Skill；五概念 Evolution/Economy/Vitality/Social/Rhythm；三门 Generate/Install/Runtime（`README.md:5`）。`persona.json` 由 `lib/generator/*` 编译为 `SKILL.md`（## Soul/## Body/## Faculty/## Skill 索引）+ `soul/injection.md`（Mustache partials）+ `state.json`。`faculty.json` 字段：`name,dimension,description,allowedTools,envVars,triggers,files`（`layers/faculties/voice/faculty.json:1-9`）。

## 3. 拟人化
**人设定义与持久化**：SoulSpec 把人格当**文件**——注入即整份 Markdown 进 system prompt/CLAUDE.md，无运行时状态、无情绪状态机。OpenPersona 把人格拆成**声明 + 状态**：声明在 persona.json，状态在 `state.json`：`relationship{stage:stranger|acquaintance|friend|close_friend|intimate, stageHistory, interactionCount}`、`mood{current,intensity 0..1,baseline}`、`evolvedTraits[]`、`speakingStyleDrift{formality,emoji_frequency,verbosity}`、`interests,milestones,pendingCommands,stateHistory,eventLog`（`schemas/evolution/soul-state.schema.json:7-90`，模板 `templates/soul/soul-state.template.json:1`）。
**防漂移（这是两个项目最值得抄的部分）**：
- SoulSpec：规则优先级（priority 0 最高，"低优先级永不覆盖高优先级"）、**双声明**（soul.json 给机器审、SOUL.md 给模型读，因为"运行时不会把 soul.json 送进上下文"）、SEC100-102 检测缺失/矛盾（`v0.5.md:376-400`）；checkpoint 的**四层污染检测**：分数跌幅≥15、diff>50%、新增违规、SOUL.md 人格关键词漂移率（`docs/platform/checkpoint.md:83-93`）。
- OpenPersona：`constitution.md` 五公理 + 层级 **Constitution > Persona Creator > User**，只能加严不能放宽（`constitution.md:59-70`、`layers/soul/README.md:9,17`）；写入时**实测的 gate**：不可变字段白名单、`immutableTraits` 过滤、formality 夹取、关系阶段禁止回退/跳级（`templates/body/state-sync.template.js:91-168`）。这是"规范宣称"与"代码执行"对齐得最好的一处。
**在线/离线**：SoulSpec 离线=作者侧 scan/validate、在线=客户端注入整份文档；OpenPersona 离线=generate 编译，在线=会话开始 `state read`、结束 `state write`（`templates/soul/partials/soul-awareness-growth.partial.md:9-19`）。

## 4. 宜人化
- **主动性**：`rhythm.heartbeat{enabled,strategy,maxDaily,quietHours}` + `rhythm.circadian{morning/night:{energy,topics}}`（`aspects/rhythm/README.md:20-35`）；README 有 "Heartbeat — Proactive Real-Data Check-ins" 与 `openpersona heartbeat`。代码侧只派生 `heartbeatExpected/heartbeatStrategy` 注入 prompt（`lib/generator/derived.js:144-146`），调度本身交给宿主。
- **节奏（真实算法）**：唯一的节律计算在 TTS 层 `applyCircadianProfile()`：22-7 点 stability +0.12、7-9 点 +0.03、9-18 点 -0.04、其余 +0.06，再 clamp 到 0..1（`layers/faculties/voice/scripts/speak.js:154-184`）。行为层**未见**按时段改语气。
- **亲密感/边界**：关系阶段映射到语音参数 `voiceEmotionMap`（stranger stability .55 → intimate .22、similarity .75→.92），情绪用 `moodModifiers` 叠加 delta（`presets/samantha/persona.json:38-79`、`speak.js:93-140`）。
- **出错体验**：显式规则——资源受限时"降级但保持角色，诚实承认限制，绝不静默失败"（`soul-awareness-body.partial.md:39-42`）。这条可直接借。
- **Vitality 不是情绪**：文档称"多维健康聚合"，代码 `score = financial.fhs`，仅 AgentBooks 财务维度，其余为注释掉的 TODO（`lib/report/vitality.js:29-44`、`aspects/vitality/README.md:9-17`）。**文档称 X，代码实际 Y**。

## 5. 可迁移机制（DSH）
1. **写入时 evolution gate**（不可变 traits / formality 夹取 / 阶段不跳级）→ 工具 `persona_state_write` + domain KV；prompt 零成本，风险：规则要产品化定义。
2. **关系阶段枚举 + 阶段化表达**→ domain KV 存 stage，GUI 节点显示；每轮只注入 1 行"${stage}：${行为}"，避免常驻长文。
3. **双声明**（机器可读 JSON + 模型可读 MD）→ domain KV 存结构体做校验，prompt section 只放渲染后的短文本，兼顾缓存与可审计。
4. **heartbeat 配置**（maxDaily/quietHours/strategy）→ 定时任务 + KV 计数闸门；成本低，风险是打扰感需 A/B。
5. **离线 SoulScan 式体检**（作者侧跑，不进运行时）→ 工具/CLI；不占 token，风险是规则维护。
6. **语气 rubric**（"可执行规则 > 形容词"、跨字段一致性）→ 作者侧评审工具（`skills/persona-evaluator/references/RUBRICS.md:55-62`）。

## 6. 不可迁移/风险
SoulSpec 无可复用代码，只有规范文本；其 scan/checkpoint/memory 全在闭源或另仓（`clawsouls/registry`）。OpenPersona 深度绑 OpenClaw：`OPENCLAW_HOME`、`~/.openclaw`、`clawhub:` 源、channel/ACN/R2 发布、Live2D vendor 包；依赖 mustache/commander/inquirer/agentbooks/sharp/aws-sdk。许可 MIT/Apache-2.0 均可商用。

## 7. 证据清单
- `clawsouls/soulspec:docs/spec/overview.md:15-48` 包结构与 soul.json 必填
- `soulspec:docs/spec/v0.5.md:330-400` safety.laws 优先级、SEC100-102、双声明
- `soulspec:docs/spec/v0.6.md:44-62,186-209` pack/type/memory/registry
- `soulspec:docs/platform/soulscan.md:31-77` 六阶段与 0.6/0.4 加权评分
- `soulspec:docs/platform/checkpoint.md:83-93` 四层污染检测
- `soulspec:docs/platform/soul-memory.md:63-70` 时间衰减 exp(-λ·age)，半衰期 23 天
- `soulspec:docs/api/cli.md:64-72,132-140` `--use` 跨客户端写入与 export
- `openpersona:schemas/evolution/soul-state.schema.json:33-90` 关系/情绪/漂移字段
- `openpersona:templates/body/state-sync.template.js:91-168` 演化约束闸门
- `openpersona:layers/faculties/voice/scripts/speak.js:154-184` 昼夜节律算法
- `openpersona:presets/samantha/persona.json:38-79` 阶段→语音参数、情绪 delta
- `openpersona:lib/report/vitality.js:29-44` Vitality 实为财务单维

## 8. 未找到证据的宣称 / 开放问题
- "resists drift / survives model swaps"（README:29,43）无运行时对照实验，只有关键词漂移指标。
- 检查项数量自相矛盾：README:45 与 v0.6:313 说 53，`soulscan.md:9` 说 55+；版本号 v1.4.0 仅见文档。
- SoulScan/CLI/MCP 均不在本仓，无法核验实现；REST API 文档未逐条读。
- OpenPersona README 多处引用 `scripts/state-sync.js`，仓库只提供 `templates/body/state-sync.template.js`，须生成后才存在。
- 谁触发演化（宿主/用户/定时）在代码中是 CLI 写入 + `pendingCommands`，无自主触发证据；`sources` 拉取逻辑未验证。
- 未做社区检索（预算内 8 源已用满），Star 数仅为本次 API 快照。
