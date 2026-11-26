---
id: SPEC-DSH哦鲸鲸
companions:
  - requirements.md
  - data-model.md
  - glossary.md
  - acceptance.md
  - rejected-approaches.md
  - entry-routing.md
  - ../../planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/ARCHITECTURE-SPINE.md
  - ../../planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/CONTEXT-GOVERNANCE.md
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

2026-11-25 的第二次蒸馏把两个**已经在架构侧写完、却从未进入需求面**的能力面拉进契约：**CAP-7 上下文治理**（18 条 AD-28…AD-45——长会话会爆窗，而宿主的通用压缩器既不可核账也不可回退）与 **CAP-9 入口与路由**（FR-25…FR-33、AD-46…AD-55——人格与记忆必须按安装位分开，否则 worker 会话会顶着主对话的人格说话）。两者与 CAP-1…CAP-6 共享同一条第一性要求：**可变的东西必须可结算**。折叠要说清它折掉了什么、能不能退回；派发要说清这条消息为什么进了这个话题。

## Capabilities

- **CAP-1 记忆**
  - **intent:** 用户可以在多轮对话之间保留可判真假的断言与偏好，并在需要时按需取回，而写入与召回都不拖慢对话。
  - **success:** `requirements.md` 的 FR-1…FR-7 与 FR-22 可测结果全过——写入后按 `mem_key` 取回 `{session_id, seq 区间, 短引文}`（引文 ≤200 字符，命中敏感正则即脱敏）；一次业务写入一张补丁表一次事务，被拒必留 `rejected`；同一 `mem_key` 不会同时存在两条未失效版本；召回只读、默认 5 条/硬上限 8 条、三段 250+600+20ms 合计 ≤1000ms 且到点不返空、同一批分数重跑同序；注入只有两个**常驻**出口（身份段 ≤1200 字符且字节稳定、状态尾巴 ≤30 token），场景常驻为 0；第三档按需召回不计入常驻。**扩展 2026-11-25**：FR-34/35 的写入侧去重（重复陈述 10 次断言净增 1、未变补丁 10 次版本数不变）、FR-36 的热度只算不写回、FR-40–45 的证明链与三态结论、FR-39 的只读简报，可测结果同样全过。

- **CAP-2 固化**
  - **intent:** 系统可以在用户不参与时把已有记忆整理成更少、更准的对象（结算、抽样、场景、策略），且每个产出都能追溯到生成它的提示词版本与证据。
  - **success:** FR-8…FR-10 全过——①②⑥⑦ 的依赖对象里没有模型客户端（测试断言，不是代码评审）；③④⑤⑧ 每步留「提炼产物 + 核验结论」两段记录，核验不过不提交、按缺步处理；进程在第 ④ 步被杀后重启从 ④ 续跑；日预算命中停在段边界并记 `dream_truncated`；连续 3 天在夜间窗口离线、第 4 天 09:00 启动恰好跑 1 个 cycle。**扩展 2026-11-25**：FR-37 的长期不提归档（打 `valid_to`、不物理删）、FR-38 的实体别名归并、FR-55–57 的推演结算（`whatif` 四字段 + 四类可校验推演 + 覆盖率只出报告）用 `test/fixtures/whatif-*.jsonl` 手工 fixture 验收——**验收对象明写是 fixture 不是真实产出**，因为生成全程关闭。

- **CAP-3 治理**
  - **intent:** 用户可以对任一条记忆问清「谁改的、依据什么、为什么」，并撤销一次操作，让默认查询与召回回到操作前。
  - **success:** FR-11…FR-14、FR-23、FR-24 全过——一次查询同时返回版本链、决策账本与证据指针；自动档只在「同键 + 有效区间重叠 + 归一化值不同」一种情形下改数据且可整体撤销；按 `op_id` 撤销后，固定 20 条 fixture 查询的 `{mem_key, active_version, flag_status, edge_label}` 集合逐条等于操作前（排除账本类节点）；命令面为十条平铺注册（2026-11-26 P0-3/P0-4 裁定；`/omw-explain` / `/omw-flag-queue` / `/omw-export` 为本批新增，`version-chain` 统一为 `history`），未命中返回明确空结果并带标记而非退出码；全量导出为纯文本 + JSONL，不含节点 id 与已脱敏引文。**扩展 2026-11-25**：FR-41 的邻域一致性闸门（不一致整批返 `UNRELIABLE`，检查 ≤50ms）、FR-44 的契约层准入三关（P1/P2 不过拒收落 `rejected`，P3 不过只落 flag）、FR-45 的 `source_independence` 封闭定义与同源只算 1、FR-58 的不确定性折扣 `U`。

- **CAP-4 人格**
  - **intent:** 库不可用时鲸鲸仍是鲸鲸；库可用时它带着一小段可解释的关系状态，而不是每轮重写一份画像。
  - **success:** FR-15/FR-16 全过——库打不开时身份段照常注入，且连续 100 轮注入的 section 文本 sha256 不变；状态字段缺失或库不可用时整段省略、不填默认值；四维越界（超出 0–100 或步长超限）在工具 `execute` 之前返回拒绝，不靠提示词提醒。**扩展 2026-11-25**：FR-65 的写入白名单（非法字段拒收）、FR-66 的关系阶段五级且 `stageHistory` 完整不跳级不回退、FR-68 的入站危险信号能拦、FR-70 的降级后身份段字节不变。FR-63/64/67/71（漂移探针、污染四判据、不讨好约束、Mini-IPIP）**推 Epic 9**，因为验收前提是「有若干个已发布版本可比较」，v1 交付时只有第一个版本，没有基线可跑。

- **CAP-5 运维**
  - **intent:** 用户能在一次重启后确认插件真的在工作，并在它坏掉时立刻知道是哪一档坏了。
  - **success:** FR-17…FR-20 全过——启用三步（依赖声明 / 宿主补丁文件 / 重启验证）缺一不可，体检（聊天内 `/omw-doctor`）对每种错误配置判为单项 fail 并点名失败项与对应错误码，无退出码语义、不中断对话；降级只有整体 no-op 与只关向量路径两档，日志侧错误码封闭为 `OMW_*` 十一个（2026-11-25 由八个扩入 CAP-9 的三个 route 码）；每次启动补做当天未校验快照、保留 7 份、恢复前必须先停库；四类日上限命中后各自降级而非报错。**扩展 2026-11-25**：FR-77 的自有产物文案门禁（v1 只有 `/omw` 命令输出与 `reports/brief-<date>.md` 两类文本过结构检查）。
  - **体检的两笔账**：`/omw-doctor` **当前实现输出五行**（`src/seams/commands.ts` 的 `inspectInProcess`），行号分母取本次实际行数，不再写死；CAP-7 与 CAP-9 的安装位落地后各追加一行（第 6、7 项，权威表见 `ARCHITECTURE-SPINE.md` 的 doctor 表），届时输出七行。验收归属仍分两笔——前五项属 FR-17（Story 1.2 的 AC 只对这五项负责），后两项是 CAP-7 与 CAP-9 各自追加、由各自 FR 验收；其中第 5 项的判据已由 CAP-9 改判为「`omw-main` preset 内该段可见 ∧ profile 位未注册该段」（AD-46），照旧判据实现会把装对的环境判成 fail。

- **CAP-6 迁移**
  - **intent:** 用户可以从 dsh-mnemon 一次性迁到本插件，失败不改变任何东西，重跑不产生重复。
  - **success:** FR-21 全过——重复运行不产生重复节点；迁移前必须禁用/卸载 mnemon，否则报错退出、不半途迁；产物是一份迁移报告（迁入/跳过/去重合并/失败 四项计数）；迁移失败自动回滚到 `snapshots/pre-migration-<ts>`；回滚开关重启后只恢复本插件的 legacy 注入；一次会话的注入快照里 mnemon 段落出现次数 = 0。

- **CAP-7 上下文治理**（2026-11-25 新增；AD-28…AD-45，权威文本在 `CONTEXT-GOVERNANCE.md`）
  - **intent:** 长会话接近窗口上限时，插件能在不改变身份、不丢失可核约束的前提下把历史变短，并让用户随时问清「刚才被折掉的是什么、能不能展开」，同时保证折叠后的上下文**密度不降**。
  - **success:** FR-46…FR-54 与 FR-72…FR-76 的可测结果全过——第 0 级观测折叠 0-LLM 且只折工具输出（折后可展开、坐标完整）；`req_ledger` 逐条覆盖已抽取约束、折叠后核对无丢失；折叠块带 `{session_id, seq_from, seq_to}` 可逆指针，展开只恢复原文不改写；`context_status` / `context_expand` 两个工具按契约返回；五档降级（`full` / `fold-only` / `ledger-only` / `readonly` / `recovering`）各能进能出且不产生幽灵状态；每折一行审计且 `breakeven_turns` 可手算对上（超 `govern.breakevenMaxTurns` 默认 20 记 `low_yield`）；`sha256(personaText)` 在折叠前后不变；`focus_ratio` 折叠后不低于折叠前（任一例下降即回滚该次折叠）；第 1 级摘要折叠 100% 同时满足 `after_tokens < before_tokens` 与 `after_canonical_bytes < before_canonical_bytes`；前缀不可重折（连续折叠后首块逐字节不变）；模型只能提议、代码守门，拒绝分 `fold_rejected`（判据不过）与 `fold_declined`（模型自己不给）且不重试。
  - **为什么两半都要在 v1**：启用 CAP-7 必须替换宿主的 `compaction-basic`（否则两个压缩器同时接管历史），而第 0 级只折工具输出、对散文零覆盖。只交第 0 级等于拿掉宿主的散文压缩器而不给替代——那不是降级，是退化。故第 0 级与第 1 级**同批交付同批验收**；做不到就整组退回 Deferred，不允许半开。

- **CAP-9 入口与路由**（2026-11-25 新增；FR-25…FR-33、AD-46…AD-55、NFR-11…NFR-12，权威正文在 `entry-routing.md`）
  - **intent:** 主对话之外派出去干活的会话不该顶着鲸鲸的人格说话，也不该各自打开一份记忆库；用户还要能从任意一个 worker 会话反查它属于哪个话题，并把 worker 接手过来。
  - **success:** FR-25…FR-33 的可测结果全过——三个会话（主对话 / 无 preset / worker）里**只有主对话**的 system 消息含 `harness:identity` 全文，另两个命中数为 0，三次 `compose()` 产物逐字节 diff 与静态断言 profile 位未注册 section 同时成立；四个记忆工具在三个会话里都可调、库只有一个打开者；派发判定不追问「这条消息属于哪个话题」，不明确时落最接近话题并带最多 3 个备选；worker 收尾后主对话收到一条 ≤2000 字符的 note 带 `<sessionId> 第 N 步` 指针、不复制 worker 消息全文；同一 `requestId` 重试任意次 worker 侧只出现一条对应消息；连续失败 3 次写一条 `OMW_ROUTE_DISPATCH` 并标该话题 `pending`；给定任一会话 id 可 `topicOfSession` 得到话题 id 或 `undefined`；派发目标 preset 不在白名单时回落 `ptc` 并记一条 `OMW_ROUTE_DISPATCH`，绝不透传模型给出的任意 preset id，worker 从不以 `omw-main` 创建；worker 会话在侧栏可见可 `resume` 可接管。

> **CAP-8（看视频融合）不登记为能力。** 架构侧 `ARCHITECTURE-SPINE.md` 记其为「仅候选，未立项」，PRD 的对应四条 FR（FR-59–62）已整组 Deferred。登记成能力会让下游误以为有交付承诺。它的重启条件写在 PRD §6.2：CAP-8 在架构侧正式立项并写出自己的 AD 之后，四条按届时应有的能力面重写验收，而不是照搬现在的写法。

### 能力与验收的对应

| 能力 | v1 硬闸门 | 说明 |
| --- | --- | --- |
| CAP-1 / CAP-2 / CAP-3 | 既有 SM-2、SM-3 + **Epic 3 的** G-E3-1、G-E3-2、G-E3-4 + G-E4-1、G-E5-1、G-E6-1 | 扩展条目挂进各 epic 已有验收事件，不新开终局验收 |
| CAP-5 / CAP-6 | 既有 M1…M5 出口条件 + G-E3-4 | — |
| CAP-7 | **G-E8-0（前置）+ G-E8-1 + G-E8-2 + SM-6** | G-E8-0 不通过则 CAP-7 整组退回 Deferred，v1 不交付。CAP-7 由**新开的 Epic 8** 承载（属 v1，两半同批） |
| CAP-9 | **SM-7 + M6 出口条件** | SM-7 原编号 SM-5，2026-11-25 改号以避免与 PRD 的记忆卫生冲突 |

明细见 `acceptance.md`。

## Constraints

每条都注明它在架构侧的出处（AD 编号，或以 Stack / Gates 计）；权威文本与「为什么」在对应 companion 里，这里只定不许违反什么。

- **单进程纯插件**：全部逻辑在 `apply(ctx, config)` 内注册、随 fiber 销毁；**不常驻任何进程**、不监听端口、不用跨进程锁文件（`worker_threads` 不在此列）；后台代码任务只用 `ctx.timer`，`ctx.schedule` 只服务 Deferred 的主动搭话。子进程边界按 **NFR-13** 收敛：默认禁止，唯一例外是「一次性短命子进程」（必须带超时、退出即回收句柄与临时文件、不常驻不监听不后台）——**该类在 v1 休眠、无消费者**，v1 交付物里不应出现任何子进程调用，出现即按违反本条处理。本条与 AD-15「`child_process` 全仓禁止」的冲突须在架构侧登记豁免后才生效。（AD-1、AD-15、NFR-13）
- **单文件库直连，不设适配层**：业务代码只经 `store/` 具名函数访问 TriviumDB；只有出现第二个存储后端时才允许抽象。（AD-2）
- **身份是业务键，不是节点 id**：`mem_key = <kind>:<subj>:<pred>[:<obj_norm>]`；节点 id 禁止进导出、配置、运行日志、flag 负载；「同一 `mem_key` 至多一条未失效」由 `(mem_key, active_slot)` 唯一索引在数据库层强制，补丁表算**完整最终 payload**，冲突以唯一索引抛错为准、抛错即写 `rejected`。（AD-3、AD-4）
- **唯一写入口 + 全进程单写队列**：写 API 只允许出现在 `src/store/commits`（`compareAndSetPayloadField` 另准 `src/ops/` 修复路径）；一次业务写入 = 一张补丁表 = 一次 `commitTransaction`；所有提交经同一队列串行，优先级 对话写入 > 快照 > dream；任何模块不得自行加锁或绕过队列。（AD-4）
- **零物理删除**：`delete(` / `deleteManyAtomic(` / `unlink(` / `unlinkLabel(` 与事务 op 字面量 `type: 'delete' | 'unlink' | 'unlinkLabel'` 全仓禁止，由 AST 级门禁阻断；仅三个具名豁免——快照目录清理、审计与日志轮转、卸载前先导出再删除，文件头必须写 `// AD-15 豁免：<用途>`；「删除」= 写 `superseded_at` 或 `valid_to`。**上下文治理的清理同样不物理删**：从注入与检查点选区移除，库内打标记，可按恢复路径回退。（AD-5、AD-15、FR-54）
- **证据是指针不是副本**：`evidence` 负载只允许 `{session_id, seq_from, seq_to, quote ≤200 字符, quote_truncated, deidentified}`；禁止写完整消息体；回读只走宿主只读日志，能力缺席或查询失败时标 `evidence-unresolvable`，绝不伪造原文。（AD-6）
- **注入只有一个出口，且带预算**：身份段 ≤1200 字符走 `systemPrompt.section()`（字节稳定，文本哈希不变即不重写），状态尾巴 ≤30 token **只能**走 `systemPrompt.context()`；两处调用只允许出现在 `seams/prompt-composer.ts`；场景常驻 = 0；注入路径不查库，缺值整段省略、不填默认值。默认裁剪顺序为 身份 > 状态 > 召回（三档注入）；**注意力池启用且存在折叠块时**改为 身份 > 状态 > 近期原文 > 折叠块 > 召回，并按密度单条裁剪。新顺序只在池启用时生效，池未启用时旧顺序逐字节不变。（AD-7、AD-11、AD-20、AD-45）
- **注意力总池与密度优先**：常驻 + 折叠块 + 近期原文 + 召回 ≤ `govern.attentionPoolRatio`（默认 0.6）× 窗口；冲突时**先删密度最低的那一条，不整档丢弃**；`focus_ratio = (身份段 + 状态尾巴 + 未折叠的近期原文) 的估算 token / 注入总估算 token` 每轮记一条，**折叠不得使它下降**（下降即回滚该次折叠）；低于 `govern.focusFloor`（默认 0.6）触发**清理**而非折叠；任何为省 token 而牺牲精确性（删错误串、删路径、删决定理由）的裁剪一律拒绝。注意 `focusFloor` 与 `attentionPoolRatio` 是两个键两事，默认值同为 0.6 纯属巧合。（AD-42、AD-44、AD-45、NFR-14）
- **召回只读、有界、三段预算**：默认 5 条、硬上限 8 条、无 offset 循环、默认只返回未失效；① 候选 250ms（`worker_threads` + `RequestContext` 期限）→ ② 重排 600ms（默认开启，每轮至多一次，缓存 10 分钟，连续 3 次超时熔断 10 分钟）→ ③ 注入 20ms；合计硬上限 1000ms，到点交候选、**不返回空**；② 失败只降不空（`rerank_unavailable`），且只产分数——剪枝由阈值 + top-k 确定性执行；召回路径禁止任何写调用。**召回侧新增的结论与字段一律可缺席**：响应级 `UNRELIABLE`、逐条三态、缺口描述、`U` 四个新增字段全部缺省时，返回体必须与既有召回模板逐字段相同。（AD-8、FR-41、FR-42、FR-43、FR-58）
- **计数一律从 evidence 边算，库里没有计数器**：置信带、偏好晋升门槛、热度等一切「出现过几次」的量，都由该节点上的 `evidence` 边按 `source_independence` 去重后计数；两条证据算同一来源当且仅当指向同一宿主 `session_id` **或**规范化引文前 80 字符完全相同，同源多条只算 1。写入侧去重（FR-34）不新建断言节点，但**追加一条指向本次 `source seq` 的 `evidence` 边**，否则「重复 10 次」永远数到 1。库内不存在任何可变计数字段——另存计数器在快照恢复后会与库不同步，且与「热度只算不写回」自相矛盾。（NFR-16、FR-34、FR-45、FR-69）
- **证明四列写入即定，不可改写**：推断节点的 `derivation` / `rule_id` / `justification_id` / `depth` 四列在写入时确定，缺列拒收、事后不可补写（推导事实不存历史，事后补会让全部历史推导无法溯源）。首列叫 `derivation` 而非 `origin`——`origin` 已被 `observed | inference` 占用，且 AD-17 据它要求 `origin=inference` 必带 `falsifier` 与 `settle_state`；`derivation ∈ {rule, dream} ⇒ origin = inference`。`justification_id = sha256(sorted(前提业务键集合))`，不含节点 id。（AD-17、FR-40）
- **三态结论封闭，不得新增第四种**：逐条结论 ∈ {`CERTAIN`, `REFUTED`, `POSSIBLE`}；`UNRELIABLE` 是**响应级**状态（这一次整批不回答），与逐条三态不在同一层，四者合计构成封闭集合。同库快照 + 同查询重跑，结论与 `justification_id` 链逐条相同，不依赖模型打分。（NFR-16、FR-41、FR-42）
- **谓词是数据，不是白名单**：谓词登记表由 `pred` 节点承载（`mem_key = pred:<规范名>`），10 个种子谓词只是初始集合；每次落盘先读一份表快照，模型判断现有谓词是否够用，不够就在同一事务内新建一条（默认 `multi` / `candidate` / `decided_by=model`）并挂 `flag_type=predicate_new`；只有用户能把它提升为 `single`（写 `kind=pred` 的普通补丁，走账本、可撤销），模型永不写 `single`；谓词名规则与 `falsifier` 字段白名单留在 `store/tbox.ts`；`pred` 节点不进召回与注入，导出时作词表段。（AD-27）
- **三级裁决，只有自动档改数据且必须可撤销**：自动档成立当且仅当 single 基数谓词 ∧ 同 `(kind, subj, pred)` ∧ 有效区间重叠 ∧ `obj_norm` 不同，结果（旧版本置失效 + 新断言 + 已解决标记 + 矛盾边）在同一事务内；其余冲突只能提案挂起，人工解除是唯一解除路径。**召回路径上的邻域一致性检查不是自动裁决**：它只在本查询邻域内做，超 50ms 即放弃检查、按 `POSSIBLE` 返回并标 `consistency_skipped`；不做全库检查，全库一致性是独立命令。（AD-9、FR-41）
- **撤销以操作单元为单位**：每个 `decision` 带 `op_id` 与 `affected[]`；闭包只含状态节点与边（边以 `(from_key, label, to_key)` 表达），账本类对象（`decision`、`dream_log`、`rejected`、`dream_cycle`）永不撤销、也不进判据比较；判据 = 撤销后默认查询与召回逐条等于操作前。（AD-22）
- **推断必须可结算**：`origin=inference` 的断言必须带 `falsifier`（`op ∈ {eq,ne,gt,lt,gte,lte,exists,count_gte}` + 白名单字段）与 `settle_state ∈ {open,confirmed,refuted}`；缺判别式即拒收，只能降级为 `scene` 描述文本；证伪不删除，改为置失效 + `flag(refuted)`。（AD-17）
- **固化确定性先行**：8 步顺序固定，①②⑥⑦ 的依赖对象不含模型客户端（由 `test/dream/no-llm.test.ts` 断言）；③④⑤⑧ 先提炼（`Qwen/Qwen3.5-9B`——G0-8 实测原定 `Qwen3.5-4B` 不可用，按闸门换同族）后核验（`deepseek-ai/DeepSeek-R1-0528-Qwen3-8B`），核验不过该步不提交、停在段边界；每步独立提交 `dream_log`，可从断点续跑；预算三层取最小；⑤ What-If 默认关闭。（AD-10）
- **折叠接管必须替换宿主的 `compaction-basic`**：两个压缩器不能同时接管历史，故启用 CAP-7 时必须 patch 掉宿主的 `compaction-basic`（与 `tool-result-pruner`）。这条替换的成立性由 **G-E8-0 前置闸门**验证（真在 fixture 里 patch，验加载、验纯散文会话也能被压、验可回滚逐字节复原）；不成立则 CAP-7 整组退回 Deferred。（`CONTEXT-GOVERNANCE.md` §12、`acceptance.md` G-E8-0）
- **折叠阶梯一律写「第 n 级」**：第 0 级 0-LLM 观测折叠 / 第 1 级模型摘要 / 第 2 级 v2 / 第 3 级应急截断。**不得用 L0/L1 记号**——`L0–L3` 专指记忆分层，两套记号混写会让下游把「折叠阶梯第 0 级」误读成「记忆 L0」。（AD-35、`data-model.md` 抬头）
- **折叠不是记忆**：检查点不抽取、不进召回、不进注入（除当前会话的折叠块表达）、不进导出、不参与 dream；折叠块的唯一身份是 `{session_id, seq_from, seq_to}`，谱系写在 `block_refs` 而不新增边。（AD-30、AD-37）
- **人格文本字节稳定**：`sha256(personaText)` 在折叠、库不可用、降级三种情形下都必须不变；身份段不因上下文治理而改写一个字。（AD-38、FR-52、NFR-15）
- **降级只有两档（记忆安装位）**：整体 no-op（库打不开 / 快照校验失败 / 建库维度不符 / 契约版本不符）或只关向量路径（401/402、embedding 返回维度不符）；不存在半开——不写一半、不注入半段；日志侧错误码封闭为 `OMW_*` 十一个（原八个 + CAP-9 的 `OMW_ROUTE_LOAD` / `OMW_ROUTE_DISPATCH` / `OMW_ROUTE_MISMATCH`），新增或改名都算破坏兼容；恢复需重载插件，进程内不自愈重试。上下文治理安装位另有**五档**（`full` / `fold-only` / `ledger-only` / `readonly` / `recovering`），两处别混。（AD-13、AD-18、AD-19、AD-36、FR-50）
- **工具面是公开契约**：`recall(query, topK?≤8)`、`remember(patch)`、`forget(mem_key, reason)`、`explain(mem_key)`，CAP-7 另加 `context_status` 与 `context_expand`；返回统一包封 `ok / items? / degraded / reason?`，工具返回码封闭为 `{E_BUDGET, E_TIMEOUT, E_DEGRADED, E_BOUNDARY, E_GATE_DOWN}`，CAP-7 只新增 `E_FOLD_BLOCKED` 与 `E_FOLD_NOT_SMALLER`；改名即破坏兼容；越界检查在 `execute` 之前执行。**两套错误码别混**：`OMW_*` 用于 `omw.log` 的 code 字段，`E_*` 用于工具返回；`fold_blocked` 是审计行状态标记不是错误码。（AD-25、AD-12、AD-40）
- **外部 provider 三个出口、各自熔断与预算**：`store/embedding.ts`、`seams/llm.ts`、`seams/systemone.ts` 之外不得发起网络请求；密钥只从 `SILICONFLOW_API_KEY` 读，禁止进配置、日志或 payload；返回维度必须等于 `db.dim`；换 provider 只换这一个文件。（AD-23）
- **配置与预算只有一个出处**：`seams/config.ts` 的 zod schema 是唯一真相（环境变量只承载密钥），互斥规则启动即校验；新增键必须改 AD-26 并补 schema 测试。CAP-7 新增的 `govern.*` 与 `consistency.*` 键同样入这张表。（AD-26）
- **待标定的值只能触发记录、打标、报告**：任何未标定的阈值/窗口/权重不得触发不可逆动作（拒收、合并、删除、阻塞发布）或成本支出（调模型、发外部请求）；凡因未标定而跳过判定，必须在审计行或返回值留显式标记（`consistency_skipped`、`dedup_threshold_unset` 一类）。未标定不得静默通过；任一项在其所属 epic 交付前未收口，该 epic 闸门判未通过；若确认不成立，处置是**删掉对应 FR**，不是无限期挂着。（PRD §8.2 三条统一规则）
- **迁移替代而非共存**：mnemon 源文件不删不改；`uuid5(file:linehash)` 只作 `migration_id`，不作身份；`legacyMnemonInject` 回滚需重启。（AD-16）
- **平台与前置闸门**：Windows 本地单用户、Node 24.21.0 / TS 7.0.2 / triviumdb 0.9.3；无服务端、无鉴权、无多租户；M0 八道闸门全过才进 M1——G0-1（原生模块加载）、G0-2（bge-m3 维度 1024）、G0-3（压缩后 seq 可回读）、G0-8（固化提炼/核验两模型）已实测通过，保留为回归项。（Stack、Gates）

## Non-goals

- **不是要记得更多**：v1 不比对标产品记更多，只比它们更可查账。
- **不做参数化学习**：不改权重、不训练模型、不做梯度式记忆更新。
- **不做多用户 / 团队共享 / 跨设备同步 / 鉴权**：一开就要服务端，与「本地单用户插件」定位冲突。
- **不是独立应用或 API 服务**：不监听端口、不起后台服务、**不常驻任何进程**；允许的唯一例外是一次性短命子进程（NFR-13），且该类在 v1 休眠无消费者；也不做 RAG 问答界面——召回服务于注入与工具调用。
- **不做主动搭话、不改写已生成的助手消息**：表达层（Voice）Deferred；DSH 助手消息不可变、turn-stopping 只能 steer，重启条件 = 预生成契约 + 生成后记账可落地。这意味**对「助手已经说出口的结论」做后置检查没有合法执行点**——视频自检一类的检查器只可能被未来某条能力面在生成之前调用。
- **不做技能自演进**：宿主没有 `top_logprobs`，候选重排不可用；闸门与归因链没落地前不做。
- **不做 What-If 生成**：v1 只建表与结算字段、默认关闭；将来开跑的约束已写死在 AD-10 ⑤（深度 ≤2、K=1、一锚点一分叉、先剪候选、产物永不进断言层）。**v1 的推演验收对象是手工 fixture，不是真实产出**。
- **不做治理界面（GUI）**：v1 用只读命令 + 导出；图形界面在数据契约之后，AD-24 的治理投影是它唯一的只读出口。
- **不重写人格**：不做「整篇画像重写」；L3 拆成字节稳定的文件身份 + 可治理的偏好节点，因为整篇重写每轮击穿前缀缓存，且单条偏好失去来源。
- **不做看视频融合（CAP-8）**：整组不立项。实时陪看、屏幕采集、说话人分离、查询期证据装配**永久不做**（无重启条件）；成本台账与自检器那四条（FR-59–62）随 CAP-8 Deferred，重启条件 = CAP-8 在架构侧正式立项并写出自己的 AD。不登记为能力，见 Capabilities 段的说明。
- **不做人格 anchor 定期复述**：安慰剂对照同样有效，属「加了也没用的复杂度」，无重启条件。
- **不做上下文治理第 2 级与自主 nudge**：v1 只到第 1 级；第 2 级与自主 nudge 属 v2。折叠的触发由确定性条件给出（增速门 / 阶段边界 / 模型申请），**不向模型暴露填充百分比**。

## Success signal

三个月后回来，Elliott 能对任意一条记忆说清三件事——它记住了什么、为什么记、我当初怎么改的——并且说错那一次能一键退回；同时长会话翻到第 40 轮仍然只读到该读的东西，`focus_ratio` 可复算且不下降。

一次性终局验收（v1 末，Elliott 签字）：SM-2 20/20 与 SM-3 10/10 及格；SM-1 只要求评测集与口径就绪；产物 = `eval/governance-20.md` + `eval/golden-l1.jsonl` + `eval/rubric.md` + `scripts/eval.ts`。扩展组 36 条 v1 增量挂进各自 epic 已有的验收事件（**Epic 8 的 G-E8-0 / G-E8-1 / G-E8-2**、Epic 3 的 G-E3-1 / G-E3-2 / G-E3-4、G-E4-1…G-E7-1），不新开终局验收；测不过的统一处置是「该 epic 不算完成，延后而非降级」。**唯一不可豁免的两条底线**：SM-2 的单条三答 30 秒上限，以及折叠接管的替换必须自证成立（不成立就摘掉折叠接管、回滚宿主压缩器、把 CAP-7 重开为新 epic，**不允许降级成只做第 0 级继续留在 v1**）。

## Assumptions

- **A0** 唯一用户与验收人是 Elliott 本人（已确认，不是假设）。
- **A1** 抽取去抖 3s、最大等待 10s 是合适的默认值，可在 M1 后校准。
- **A2** 八步固化第 ⑤ 步（What-If）在 v1 全程关闭，只建表与结算字段。
- **A3** 谓词表是开放登记表：模型可新建 pred 节点但默认 `multi`，只有用户写入可提升 `single`。
- **A4** 治理界面推迟，但 SM-2 必须在 v1 末可做，故 v1 必交付只读查询命令 `FR-23`。
- **A5** 四指标的阶段划分沿用简报（v1 / v1.5 / v2），dogfood 期不设持续门控。
- **A6** 研究报告里的具体数字**不能直接当验收线**：它们来自别人的样本与口径，只能作为起点值入配置并标「待标定」（见 PRD §8.2 的 T/D/C 三类）。
- **A7′**（取代已推翻的 A7）一次性替换宿主压缩器可行：前提是折叠阶梯第 0 级与第 1 级**同批交付**，且宿主的 `compaction-basic` 能力由四级阶梯完整覆盖（含第 3 级应急截断的兜底位置）。原 A7「只交第 0 级也够」不成立——启用 CAP-7 必须替换 `compaction-basic`，而第 0 级只折工具输出，对散文零覆盖。本假设由 G-E8-0 前置闸门验证。
- **A8** 一次性短命子进程不会使插件变成「独立应用」：它不常驻、不监听、随主流程退出；本条在 v1 **无从验证**（唯一消费者 FR-61 已 Deferred，v1 不应出现任何子进程调用），只是留给视频组重启时的边界铺垫，与 AD-15 的冲突须先登记架构豁免。
- **A9（2026-11-25 已落实）** 扩展组的增量条目原本设想并入既有 epic 的 story 范围，不必新开 epic。**实际裁定是必须开**：上下文治理 14 条替换的是宿主机制，与治理查询几乎不共享代码面，故新开 **Epic 8** 承载（属 v1，两半同批）；人格保真四条要多个版本做基线，排到 **Epic 9**（不属 v1）。Epic 3–7 只收「在既有面上补缺口」的部分。**任何情况都不得回填 Epic 1/2。**
- **A10** 本次修订没有偷引入被否掉的方案：读时衰减投影 ≠ FSRS+ACT-R 双理论（`rejected-approaches.md` #10 已写明区别）；证明式召回 ≠ 本体推理器或自研 Datalog 引擎（#11，规则是封闭常量表上的符号计算）；热度只算不写回 ≠ 召回即写入（#4）。

## Open Questions

- **Q1（已裁决 2026-11-23）** `flag` 生命周期两态：`open` / `resolved`，不做第三态。
- **Q2（已裁决 2026-11-23）** 谓词表是开放集合，见 A3。
- **Q3（已裁决 2026-11-23）** 召回候选池 `recall.candidatePool` 默认 12。
- **Q4（未收口，2026-11-25 新增）** PRD §8.2 的十一项待标定（T1–T4 四个真参数、D1–D6 六个设计待解决、C1 随 Deferred）何时收口？现行处置：任一项在其所属 epic 交付前未收口，该 epic 闸门判未通过；若确认不成立（如近重复校准语料造不出来），处置是删掉对应 FR，不是无限期挂着。这十一项**不阻塞拆 epic**，只阻塞验收。
