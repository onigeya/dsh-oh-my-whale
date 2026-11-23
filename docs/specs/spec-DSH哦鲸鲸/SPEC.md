---
id: SPEC-DSH哦鲸鲸
companions:
  - requirements.md
  - data-model.md
  - glossary.md
  - acceptance.md
  - rejected-approaches.md
  - ../../planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/ARCHITECTURE-SPINE.md
  - ../../planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/C4-VIEWS.md
sources:
  - ../../planning-artifacts/prds/prd-DSH哦鲸鲸-2026-11-23/prd.md
  - ../../planning-artifacts/prds/prd-DSH哦鲸鲸-2026-11-23/addendum.md
  - ../../planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/SOLUTION-DESIGN.md
  - ../../planning-artifacts/briefs/brief-DSH哦鲸鲸-2026-11-22/brief.md
---

> **Canonical contract.** 本 SPEC 与 `companions:` 里的文件合起来，是「要建什么、怎样算做到、什么不许做」的完整契约。`sources:` 里的文档已被完全吸收，只作审计与更新时重读，下游不必再读。

# 哦鲸鲸（oh-my-whale）· v1 记忆插件

## Why

一个跑在 DeepSeek Harness 里的插件，要解决「助理记不住」这个已经被别人做过、但**没人敢让人查账**的问题：九家对标里静默硬删、召回即写入、冲突无人裁决是通病——不是技术做不到，是没人把「可撤销」当作第一性要求来设计。受影响的是本机唯一用户（Elliott 本人），场景是本地单用户、无服务端、每一轮对话都在等它。三条宿主事实把这件事逼到必须现在做：DSH 会话日志是 append-only 的唯一日志，压缩只是遮蔽、原文仍在但没有反压缩 API；机器上已装 dsh-mnemon（「记不住」不再是空白点，只做「注入更勤」没有存在理由）；DSH 无内建 embedding，向量必须走外部 provider。所以 v1 不比别人记得更多，只比他们更可结算：**每条记忆追得到它从哪句话来、被谁改过、为什么还在；每次「它怎么忘了这个」都能反悔。**

## Capabilities

- **CAP-1 记忆**
  - **intent:** 用户可以在多轮对话之间保留可判真假的断言与偏好，并在需要时按需取回，而写入与召回都不拖慢对话。
  - **success:** `requirements.md` 的 FR-1…FR-7 与 FR-22 可测结果全过——写入后按 `mem_key` 取回 `{session_id, seq 区间, 短引文}`（引文 ≤200 字符，命中敏感正则即脱敏）；一次业务写入一张补丁表一次事务，被拒必留 `rejected`；同一 `mem_key` 不会同时存在两条未失效版本；召回只读、默认 5 条/硬上限 8 条、三段 250+600+20ms 合计 ≤1000ms 且到点不返空、同一批分数重跑同序；注入只有两个出口（身份段 ≤1200 字符且字节稳定、状态尾巴 ≤30 token），场景常驻为 0。

- **CAP-2 固化**
  - **intent:** 系统可以在用户不参与时把已有记忆整理成更少、更准的对象（结算、抽样、场景、策略），且每个产出都能追溯到生成它的提示词版本与证据。
  - **success:** FR-8…FR-10 全过——①②⑥⑦ 的依赖对象里没有模型客户端（测试断言，不是代码评审）；③④⑤⑧ 每步留「提炼产物 + 核验结论」两段记录，核验不过不提交、按缺步处理；进程在第 ④ 步被杀后重启从 ④ 续跑；日预算命中停在段边界并记 `dream_truncated`；连续 3 天在夜间窗口离线、第 4 天 09:00 启动恰好跑 1 个 cycle。

- **CAP-3 治理**
  - **intent:** 用户可以对任一条记忆问清「谁改的、依据什么、为什么」，并撤销一次操作，让默认查询与召回回到操作前。
  - **success:** FR-11…FR-14、FR-23、FR-24 全过——一次查询同时返回版本链、决策账本与证据指针；自动档只在「同键 + 有效区间重叠 + 归一化值不同」一种情形下改数据且可整体撤销；按 `op_id` 撤销后，固定 20 条 fixture 查询的 `{mem_key, active_version, flag_status, edge_label}` 集合逐条等于操作前（排除账本类节点）；四条只读命令退出码固定 0/2/其他；全量导出为纯文本 + JSONL，不含节点 id 与已脱敏引文。

- **CAP-4 人格**
  - **intent:** 库不可用时鲸鲸仍是鲸鲸；库可用时它带着一小段可解释的关系状态，而不是每轮重写一份画像。
  - **success:** FR-15/FR-16 全过——库打不开时身份段照常注入，且连续 100 轮注入的 section 文本 sha256 不变；状态字段缺失或库不可用时整段省略、不填默认值；四维越界（超出 0–100 或步长超限）在工具 `execute` 之前返回拒绝，不靠提示词提醒。

- **CAP-5 运维**
  - **intent:** 用户能在一次重启后确认插件真的在工作，并在它坏掉时立刻知道是哪一档坏了。
  - **success:** FR-17…FR-20 全过——启用三步（依赖声明 / 宿主补丁文件 / 重启验证）缺一不可，体检五项对五种错误配置各返回非零退出码与对应错误码；降级只有整体 no-op 与只关向量路径两档，八个错误码封闭；每次启动补做当天未校验快照、保留 7 份、恢复前必须先停库；四类日上限命中后各自降级而非报错。

- **CAP-6 迁移**
  - **intent:** 用户可以从 dsh-mnemon 一次性迁到本插件，失败不改变任何东西，重跑不产生重复。
  - **success:** FR-21 全过——重复运行不产生重复节点；迁移前必须禁用/卸载 mnemon，否则报错退出、不半途迁；产物是一份迁移报告（迁入/跳过/去重合并/失败 四项计数）；迁移失败自动回滚到 `snapshots/pre-migration-<ts>`；回滚开关重启后只恢复本插件的 legacy 注入；一次会话的注入快照里 mnemon 段落出现次数 = 0。

## Constraints

每条都注明它在 `ARCHITECTURE-SPINE.md` 里的出处（AD 编号，或以 Stack / Gates 计）；权威文本与「为什么」在那个 companion 里，这里只定不许违反什么。

- **单进程纯插件**：全部逻辑在 `apply(ctx, config)` 内注册、随 fiber 销毁；禁止 spawn 子进程、监听端口、跨进程锁文件（`worker_threads` 不在此列）；后台代码任务只用 `ctx.timer`，`ctx.schedule` 只服务 Deferred 的主动搭话。（AD-1）
- **单文件库直连，不设适配层**：业务代码只经 `store/` 具名函数访问 TriviumDB；只有出现第二个存储后端时才允许抽象。（AD-2）
- **身份是业务键，不是节点 id**：`mem_key = <kind>:<subj>:<pred>[:<obj_norm>]`；节点 id 禁止进导出、配置、运行日志、flag 负载；「同一 `mem_key` 至多一条未失效」由 `(mem_key, active_slot)` 唯一索引在数据库层强制，补丁表算**完整最终 payload**，冲突以唯一索引抛错为准、抛错即写 `rejected`。（AD-3、AD-4）
- **唯一写入口 + 全进程单写队列**：写 API 只允许出现在 `src/store/commits`（`compareAndSetPayloadField` 另准 `src/ops/` 修复路径）；一次业务写入 = 一张补丁表 = 一次 `commitTransaction`；所有提交经同一队列串行，优先级 对话写入 > 快照 > dream；任何模块不得自行加锁或绕过队列。（AD-4）
- **零物理删除**：`delete(` / `deleteManyAtomic(` / `unlink(` / `unlinkLabel(` 与事务 op 字面量 `type: 'delete' | 'unlink' | 'unlinkLabel'` 全仓禁止，由 AST 级门禁阻断；仅三个具名豁免——快照目录清理、审计与日志轮转、卸载前先导出再删除，文件头必须写 `// AD-15 豁免：<用途>`；「删除」= 写 `superseded_at`。（AD-5、AD-15）
- **证据是指针不是副本**：`evidence` 负载只允许 `{session_id, seq_from, seq_to, quote ≤200 字符, quote_truncated, deidentified}`；禁止写完整消息体；回读只走宿主只读日志，能力缺席或查询失败时标 `evidence-unresolvable`，绝不伪造原文。（AD-6）
- **注入只有一个出口，且带预算**：身份段 ≤1200 字符走 `systemPrompt.section()`（字节稳定，文本哈希不变即不重写），状态尾巴 ≤30 token **只能**走 `systemPrompt.context()`；两处调用只允许出现在 `seams/prompt-composer.ts`；场景常驻 = 0；注入路径不查库，缺值整段省略、不填默认值；超预算按 身份 > 状态 > 召回 裁剪并记账。（AD-7、AD-11、AD-20）
- **召回只读、有界、三段预算**：默认 5 条、硬上限 8 条、无 offset 循环、默认只返回未失效；① 候选 250ms（`worker_threads` + `RequestContext` 期限）→ ② 重排 600ms（默认开启，每轮至多一次，缓存 10 分钟，连续 3 次超时熔断 10 分钟）→ ③ 注入 20ms；合计硬上限 1000ms，到点交候选、**不返回空**；② 失败只降不空（`rerank_unavailable`），且只产分数——剪枝由阈值 + top-k 确定性执行；召回路径禁止任何写调用。（AD-8）
- **谓词是数据，不是白名单**：谓词登记表由 `pred` 节点承载（`mem_key = pred:<规范名>`），10 个种子谓词只是初始集合；每次落盘先读一份表快照，模型判断现有谓词是否够用，不够就在同一事务内新建一条（默认 `multi` / `candidate` / `decided_by=model`）并挂 `flag_type=predicate_new`；只有用户能把它提升为 `single`（写 `kind=pred` 的普通补丁，走账本、可撤销），模型永不写 `single`；谓词名规则与 `falsifier` 字段白名单留在 `store/tbox.ts`；`pred` 节点不进召回与注入，导出时作词表段。（AD-27）
- **三级裁决，只有自动档改数据且必须可撤销**：自动档成立当且仅当 single 基数谓词 ∧ 同 `(kind, subj, pred)` ∧ 有效区间重叠 ∧ `obj_norm` 不同，结果（旧版本置失效 + 新断言 + 已解决标记 + 矛盾边）在同一事务内；其余冲突只能提案挂起，人工解除是唯一解除路径。（AD-9）
- **撤销以操作单元为单位**：每个 `decision` 带 `op_id` 与 `affected[]`；闭包只含状态节点与边（边以 `(from_key, label, to_key)` 表达），账本类对象（`decision`、`dream_log`、`rejected`、`dream_cycle`）永不撤销、也不进判据比较；判据 = 撤销后默认查询与召回逐条等于操作前。（AD-22）
- **推断必须可结算**：`origin=inference` 的断言必须带 `falsifier`（`op ∈ {eq,ne,gt,lt,gte,lte,exists,count_gte}` + 白名单字段）与 `settle_state ∈ {open,confirmed,refuted}`；缺判别式即拒收，只能降级为 `scene` 描述文本；证伪不删除，改为置失效 + `flag(refuted)`。（AD-17）
- **固化确定性先行**：8 步顺序固定，①②⑥⑦ 的依赖对象不含模型客户端（由 `test/dream/no-llm.test.ts` 断言）；③④⑤⑧ 先提炼（`Qwen/Qwen3.5-9B`——G0-8 实测原定 `Qwen3.5-4B` 不可用，按闸门换同族）后核验（`deepseek-ai/DeepSeek-R1-0528-Qwen3-8B`），核验不过该步不提交、停在段边界；每步独立提交 `dream_log`，可从断点续跑；预算三层取最小；⑤ What-If 默认关闭。（AD-10）
- **降级只有两档**：整体 no-op（库打不开 / 快照校验失败 / 建库维度不符 / 契约版本不符）或只关向量路径（401/402、embedding 返回维度不符）；不存在半开——不写一半、不注入半段；八个错误码封闭，新增或改名都算破坏兼容；恢复需重载插件，进程内不自愈重试。（AD-13、AD-18、AD-19）
- **外部 provider 三个出口、各自熔断与预算**：`store/embedding.ts`、`seams/llm.ts`、`seams/systemone.ts` 之外不得发起网络请求；密钥只从 `SILICONFLOW_API_KEY` 读，禁止进配置、日志或 payload；返回维度必须等于 `db.dim`；换 provider 只换这一个文件。（AD-23）
- **配置与预算只有一个出处**：`seams/config.ts` 的 zod schema 是唯一真相（环境变量只承载密钥），互斥规则启动即校验；新增键必须改 AD-26 并补 schema 测试。（AD-26）
- **工具面是公开契约**：`recall(query, topK?≤8)`、`remember(patch)`、`forget(mem_key, reason)`、`explain(mem_key)`；返回统一包封 `ok / items? / degraded / reason?`，错误码封闭为 `{E_BUDGET, E_TIMEOUT, E_DEGRADED, E_BOUNDARY, E_GATE_DOWN}`；改名即破坏兼容；越界检查在 `execute` 之前执行。（AD-25、AD-12）
- **迁移替代而非共存**：mnemon 源文件不删不改；`uuid5(file:linehash)` 只作 `migration_id`，不作身份；`legacyMnemonInject` 回滚需重启。（AD-16）
- **平台与前置闸门**：Windows 本地单用户、Node 24.21.0 / TS 7.0.2 / triviumdb 0.9.3；无服务端、无鉴权、无多租户；M0 八道闸门全过才进 M1——G0-1（原生模块加载）、G0-2（bge-m3 维度 1024）、G0-3（压缩后 seq 可回读）已实测通过，保留为回归项。（Stack、Gates）

## Non-goals

- **不是要记得更多**：v1 不比对标产品记更多，只比它们更可查账。
- **不做参数化学习**：不改权重、不训练模型、不做梯度式记忆更新。
- **不做多用户 / 团队共享 / 跨设备同步 / 鉴权**：一开就要服务端，与「本地单用户插件」定位冲突。
- **不是独立应用或 API 服务**：不监听端口、不起后台服务、不 spawn 子进程；也不做 RAG 问答界面——召回服务于注入与工具调用。
- **不做主动搭话、不改写已生成的助手消息**：表达层（Voice）Deferred；DSH 助手消息不可变、turn-stopping 只能 steer，重启条件 = 预生成契约 + 生成后记账可落地。
- **不做技能自演进**：宿主没有 `top_logprobs`，候选重排不可用；闸门与归因链没落地前不做。
- **不做 What-If 生成**：v1 只建表与结算字段、默认关闭；将来开跑的约束已写死在 AD-10 ⑤（深度 ≤2、K=1、一锚点一分叉、先剪候选、产物永不进断言层）。
- **不做治理界面（GUI）**：v1 用只读命令 + 导出；图形界面在数据契约之后，AD-24 的治理投影是它唯一的只读出口。
- **不重写人格**：不做「整篇画像重写」；L3 拆成字节稳定的文件身份 + 可治理的偏好节点，因为整篇重写每轮击穿前缀缓存，且单条偏好失去来源。

## Success signal

v1 结束时有**一次性终局验收**，不是「跑起来了」：SM-2 20/20（单条从执行到答清三问 ≤30 秒、字段齐全）、SM-3 10/10（10 次遗忘操作完整撤销、内容/版本链/标记状态/检索结果逐条复原、零残留）、SM-1 的评测集与口径就绪（`eval/golden-l1.jsonl` 50 条标注、`eval/rubric.md`、预注册种子），由 Elliott 本人签字确认；产物四件：`eval/governance-20.md`、`eval/golden-l1.jsonl`、`eval/rubric.md`、`scripts/eval.ts`。世界变化的时刻：三个月后回来，能对任意一条记忆说清「它记住了什么、为什么记、我怎么改」，且说错的那次一键退回操作前。dogfood 期间不做持续门控、只采基线；唯一不可豁免的底线是 SM-2 的 30 秒。

## Assumptions

- 抽取去抖 3s / max-wait 10s 是合适默认值；若实测漏记严重需重新标定（影响 FR-22）。
- 「符号可判」由 `pred` 登记表的基数承担：模型可以新建谓词，但只能得到 `multi`，所以自动裁决的触发面始终由人控制。开放式谓词会带来同义分裂（`likes` / `喜欢` / `love` 各自成词），v1 只做 `aliases` 显式合并 + dream ② 归并，不承诺语义聚类。
- 八步固化的 ⑤ What-If 在 v1 全程关闭，不会因为「表都建好了」被顺手打开。
- `obj_norm` 只处理形近（全角/标点/大小写/空白），处理不了同义（「上海」/「魔都」）；同义归并留给 dream ② 与人工锚点，v1 不承诺。
- System One 端点属 Alpha，可能调整或停用；停用即按 AD-8 降级为 ①③，G0-7 不过则 `rerank.enabled=false`，② 不作为 v1 必需。
- 治理界面推迟，但只读查询命令（FR-23）必须在 v1 交付，否则 SM-2 无法验收。
- 四条指标的阶段划分沿用简报；dogfood 不设持续门控，v1 末做一次终局验收。
- 单文件库在插件内串行写入即可，不需要跨进程锁（AD-1 本就禁跨进程锁）；Windows 句柄锁只在恢复路径上被尊重（先停库）。

## Open Questions

> 全部裁决于 2026-11-23，与 `data-model.md`、`ARCHITECTURE-SPINE.md`（AD-27、AD-26）、`requirements.md` 同步。

- **flag 生命周期：两态（已裁决）**。`status ∈ {open, resolved}` + `flag_type ∈ {dangling_evidence, contradiction, refuted, rejected, dream_truncated, migration, predicate_new}` + `resolved_by(auto|human)`。PRD 的四/五态是 status 与 flag_type 的混写：创建与挂起都是 `open`，已解决是 `resolved`，已证伪是 `flag_type=refuted`，已撤销由 `decision(kind=revert)` 表达。
- **谓词表：开放集合（已裁决）**。不再有「初始 10 谓词定稿」这回事——表由 `pred` 节点承载，落盘时先取表、模型按需新建，新谓词默认 `multi` 因而触发不了自动裁决；提升为 `single` 只由用户写入（AD-27）。
- **召回候选池：配置项（已裁决）**。`recall.candidatePool` 默认 12，进 `seams/config.ts` 与 AD-26 默认值表，并补 schema 默认值测试。
