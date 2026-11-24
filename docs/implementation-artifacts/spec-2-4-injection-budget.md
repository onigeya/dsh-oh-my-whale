---
title: 'Story 2.4 — 注入只有一个出口，两段各有预算'
type: 'feature'
created: '2026-11-24'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: true
baseline_revision: 'b2ecde5'
context:
  - '{project-root}/docs/planning-artifacts/epics.md'
  - '{project-root}/docs/specs/spec-DSH哦鲸鲸/requirements.md'
warnings: ['oversized']
deferred:
  - "逐轮注入计划：Runtime.injection 现在只在挂载时组装一次，逐轮重算要等 Epic 7 给状态尾巴真实数据源；届时 AC6 需要复测，那一轮再补逐轮采样与真实库不可用的用例。"
  - "召回通道：composer 已能规划召回（InjectionPlan.recall），但 register() 只登记身份段与尾巴两条宿主通道，真装配下 readRecall 从不传入，故真实挂载的 tokens 里召回恒为 0。Story 2.5 接入召回后该字段才恢复为真现场。"
  - "prefix_unchanged 只有单次取样：它在 composer 层与 personaRegistered 互补且有用例，但「与上一轮相同」需要轮级第二个数据点，随 Epic 7 的逐轮组装一并补。"
  - "CI 未在 GitHub 实跑：.github/workflows/ci.yml 是本故事之前就存在的门，本故事没有改动它，也没有权限在远端触发；所有数字来自本机全量命令。"
---

<intent-contract>

## Intent

**Problem:** 身份段与状态尾巴现在由 `PromptComposer.register` 各自登记，但没有任何一处能回答「这一轮到底注入了多少、哪一档被削了」。两条通道的预算各写各的（身份段只比字符、尾巴只比 token），一旦将来召回也往里塞，就没有共同的裁剪顺序，也没有可被审计的结论；AC 要的 `prefix_unchanged`、`tokens`、`truncated` 三个字段目前无处产生。

**Approach:** 让 composer 成为三档唯一的组装点：一次 `compose()` 按「身份 > 状态 > 召回」的保留优先级把三档合成为一份 `InjectionPlan`，每档各自守自己的上限，并如实报出「这段字节是否与上一轮相同」「共用多少 token」「哪一档的哪一项被削了」。注入路径不查库，所以场景常驻恒为 0 是结构结论而不是过滤结果。

## Boundaries & Constraints

**Always:**
- 身份段走 `ctx.systemPrompt.section({name:'harness:identity'})`，尾巴走 `ctx.systemPrompt.context({name:'omw:persona-state'})`；两处调用只出现在 `src/seams/prompt-composer.ts`（静态门 `prompt-seam-owner` 已守）。
- 身份段文本只由 `assets/persona.md` 决定：不含时间、会话 id、库状态或任何逐轮变化的内容，因此同一份文件在任意轮、任意库状态下产出同一串字节（sha256 相同）。
- 保留优先级恒为 身份 > 状态 > 召回；裁剪从低到高发生（召回先让，其次状态逐条让），身份段只在自身 1200 字符上限处截断，绝不为给别的档腾位置而缩短。理由见 Design Notes 第 1 条。
- 尾巴每一段要么整段保留、要么整段丢弃，不做半句截断；缺值即省略，不填默认值、不用占位文本凑数。
- `truncated` 记录的是「谁被削了」的封闭枚举项（`identity` / `state:<段名>` / `recall`），不是布尔。
- 注入路径不读库、不调工具、不发起网络请求。

**Never:**
- 不新增「注入总预算」配置键：AD-7 与 NFR-9 都只给了三档各自的上限，凭空造一个总额数字会让这两份文档与实现三方不一致。共用预算由三档上限推导（Design Notes 第 2 条）。
- 不让召回挤掉身份段或尾巴：召回是「取不满就少给」的那一档。
- 不在 composer 里落审计行（那是 Story 2.6 的事）；本轮只保证结果里带齐字段。
- 不引入 AD-45 的注意力池与 `focus_ratio`（属后续 epic）。
- 不改尾巴的段序、不改身份段的归一化规则（`\r\n`→`\n`、去尾空白、按码点截）。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| INJ_TWO_ROUNDS | 连续两轮同一份 persona 文本 | 第二轮 `personaRegistered:false`、`prefix_unchanged:true`、section 文本字节不变 | 无错误 |
| INJ_100_ROUNDS | 100 轮，其中若干轮库不可用或未装配 | 100 次 section 文本的 sha256 全同 | 无错误；库状态不参与身份段 |
| INJ_IDENTITY_OVER | persona 源文本 1201 字符 | 截断到 1200、`truncated:true`、`truncatedItems` 含 `identity` | 不报错，按上限截断 |
| INJ_IDENTITY_EXACT | 源文本恰好 1200 字符 | 原样保留、`truncated:false` | 无错误（边界含 1200） |
| INJ_TAIL_OVER | 三段合计估 token 超 30 | 自低优先级起整段丢弃（flag → preference），`truncatedItems` 含 `state:<段名>` | 不报错；不许截半句 |
| INJ_TAIL_EMPTY | `readState` 缺席或三段全空 | 不调用 `context()`、`tailRegistered:false`、`tokens:0` | 无错误；不写占位文本 |
| INJ_TAIL_CLEARED | 上一轮有尾巴、本轮为空 | 主动 dispose 旧尾巴，宿主侧不再出现该段 | 无错误 |
| INJ_RECALL_OVER | 召回条目超出自身额度（`topK × 每条估值`） | 按前缀语义丢弃（被丢项后面的小条目不会顶上来），`overBudget` 记条数、`truncatedItems` 含 `recall`，身份段与尾巴不动 | 不报错 |
| INJ_RECALL_TOP_K | 条目数超过 `topK` 但都装得下 | `overCount` 记剩余条数，`truncated` 为 false（契约在起作用，不是被削） | 不报错 |
| INJ_RECALL_ABSENT | 未传召回（本故事常态） | `recall` 各计数为 0、不产生 `recall` 截断记录 | 无错误 |
| INJ_SCENE_PRESENT | 库里存在 `scene:` 节点 | 注入结果与库为空时逐字节相同，且两次挂载都是 `state=ok` | 无错误；注入不读库 |
| INJ_HOST_THROWS | `systemPrompt.section` 抛错 | 不抛给调用方：`failed:['section']`、`personaRegistered:false`，尾巴若走另一条通道仍照常注册，`plan` 仍描述组装结果 | 由 runtime 记日志并标未注册 |
| INJ_HOST_REPLACES | 已有注册，宿主拒绝替换 | 旧注册**不释放**，`hasSection` 仍为 true，模型仍有身份段 | 同上，记 `failed` |

</intent-contract>

## Code Map

- `src/seams/prompt-composer.ts` -- 三档唯一组装点：`compose()` 产出 `InjectionPlan`，`register()` 只据它决定是否重注册；新报告的三个审计字段在此产生。
- `src/seams/runtime.ts` -- 装配处：把 `config.inject` 的两档上限传进 composer、把 `compose()` 的结果留给 2.6 的审计。
- `src/seams/config.ts` -- 已有 `inject.personaMaxChars`(1200) 与 `inject.tailMaxTokens`(30)，本轮不新增键。
- `src/ops/audit.ts` -- `InjectionAuditRow` 的字段（`tier/chars/tokens/truncated/prefix_unchanged`）是本轮报告的形状来源；本轮不写行。
- `scripts/check-layers.mjs` -- `prompt-seam-owner` 规则已把两处宿主调用锁在本文件；本轮补一条测试证明它真的会拦。
- `test/seams/prompt-composer.test.ts` -- 新建：I/O 矩阵逐行的单元测试与 1000 次压测。
- `test/load/inject.test.ts` -- 真挂载断言：身份段字节、尾巴缺席、场景不常驻。

## Tasks & Acceptance

**Execution:**
- `src/seams/prompt-composer.ts` -- 新增 `InjectionPlan`/`TruncationItem` 类型与 `compose()`；`register()` 改为消费它 -- 让「注入了什么、削了什么」成为可断言的值而不是日志。
- `src/seams/prompt-composer.ts` -- `composeStateTail` 改为返回保留段与丢弃段（保持现有段序与整段语义） -- AC6 要能说出被丢的是哪一段。
- `test/seams/prompt-composer.test.ts` -- 覆盖 I/O 矩阵 11 行 + 100 轮哈希 + 1000 次压测 -- 判据全部可用断言表达。
- `test/load/inject.test.ts` -- 增场景常驻与尾巴缺席的真挂载断言 -- 端到端确认而非单测。
- `test/lint/layers.test.ts` -- 增一条 fixture：seam 之外出现 `systemPrompt.section(` 即违规 -- 证明 AC1 的门不是空转。

**Acceptance Criteria:**
- Given 一次组装，when 检查两处宿主调用，then 全仓只有 `src/seams/prompt-composer.ts` 出现，且静态门会拒绝别处出现。
- Given 身份段文本，when 连续两轮未变，then 第二轮不重注册、section 字节与前缀一致、报告 `prefix_unchanged:true`。
- Given 连续 100 轮（含库不可用轮次），when 逐轮算 section 文本 sha256，then 100 个哈希全同。
- Given 三档合计超预算，when 组装，then 按召回 → 状态 → 身份的顺序让位，报告 `truncated` 与 `truncatedItems` 点名被削项，且身份段永不为他档让位。
- Given 库里存在场景记忆，when 组装提示词，then 场景常驻 0 条（注入路径不读库，且真挂载用例与空库结果逐字节相同）。
- Given 状态尾巴，when 计数，then ≤30 token、≤1 条偏好、≤1 条 flag；缺值整段省略；尾巴为空时整段不出现且报告 `tokens:0`。本 AC 待 Epic 7 交付真实尾巴后复测。
- Given `compose()` 同步段，when 压测 1000 次，then p95 ≤20ms。
- Given 全量验证，then `pnpm build` / `pnpm lint` / `pnpm test` / `pnpm test:coverage` 全绿，覆盖率行 ≥80%、分支 ≥70%。

## Spec Change Log

- 2026-11-24 初稿：AC 七条来自 docs/planning-artifacts/epics.md:492-528；预算口径取自 ARCHITECTURE-SPINE.md:77-89（AD-7）与 requirements.md:228（NFR-9）。
- 2026-11-24 评审后修订（四层评审返回 38 条发现，裁定见 Review Triage Log）：
  - **预算口径改正**：召回不再吃尾巴的余量，改为只受自身 `topK × 每条估值` 约束。原算法让召回的上限随宿主状态浮动，与「每档各有预算」相悖（Design Notes 5）。
  - **两种截断分开**：`overCount`（条数到 `topK`）与 `overBudget`（额度装不下）不再混为一个 `dropped`，只有后者进 `truncatedItems`（Design Notes 6）。
  - **召回丢弃改前缀语义**：由 `continue` 改为 `break`，避免被丢项后面的小条目顶上来，与「从末位起丢弃」一致。
  - **宿主失败改为就地报告**：`RegisterOutcome.failed` 取代抛异常；旧注册只在新调用成功后才释放（Design Notes 7）。I/O 矩阵相应新增 INJ_HOST_REPLACES，改写 INJ_HOST_THROWS。
  - **每档补齐审计字段**：`ComposedPersona.chars`、`TailPlan.chars/truncated`、`RecallPlan` 的完整拆分、`InjectionPlan.truncated`；`Runtime.injection` 是本次挂载的组装结果，供 2.6 直接落行而不重算。
  - **常量单一出处**：`DEFAULT_TOP_K` 与 `RECALL_ITEM_BUDGET_TOKENS` 从 composer 内的私有副本改为从 `src/seams/config.ts` 导入（AD-26）。
  - **身份段可传函数**：`personaText` 接受 `string | (() => string)`，使「文本变了才重注册」这条分支可被真实驱动（Design Notes 8）。
  - **读状态失败不再毁掉身份段**：`readState` / `readRecall` 抛错时按「本档没有内容」处理并回调 `onReaderFailure`，身份段照常注入（FR-15）。

## Review Triage Log

- **发现总数 38**：blind-hunter 17 条、edge-case-hunter 5 条、verification-gap 4 条、intent-alignment 12 条。
- **裁定合计**：high 5 / medium 22 / low 11；patch 34 / defer 4 / reject 0。
- **severity 由 lead 复核重判**，不采信子代理自报：blind24 自标 7 条 high 里 5 条实为 medium（多为「文档与实现不一致」或「现金额是恒等式」），保留 2 条 high（召回吃尾巴余量、两种截断混记）；intent24 的 5 条中 3 条与其余层同源，按最早编号归并裁定。
- **无 intent_gap、无 bad_spec**：没有一条发现要求改 spec 的范围或措辞才能成立，故 `review_loop_iteration` 保持 0。
- **复核手段**：patch 类逐条读源码确认落点，其中 4 条做了断线验证（拆掉实现看用例是否转红），结果见 Verification。
- **blind24-1** `[medium]` `[patch]` 「共用预算不可能被超出」使 tokens <= budget 成为算术恒等式，测试无法失败 — 已改为逐档断言各守其上限（recall.tokens <= topK × 每条估值、tail.tokens <= 30），并保留总额断言作为恒等式的书面记录
- **blind24-2** `[high]` `[patch]` 尾巴为空时召回可吃下超出自身名义上限的额度（默认配置 330 token 对 300） — 已删掉 room = budget - identityTokens - tail.tokens，召回改只受 recallCap = topK × 每条估值 约束（Design Notes 5）
- **blind24-3** `[low]` `[patch]` README 关于尾巴怎么让的两处说法矛盾（「首段一丢后续全丢」对「尾巴逐条让」） — README.md:124-126 已改为「尾巴从后往前让」并明写整段丢、不跳段
- **blind24-4** `[medium]` `[patch]` 召回选择是 skip-greedy，与「按重要度取前 N 条」相悖 — 收集循环由 continue 改 break，被丢项后面的小条目不再顶上来
- **blind24-5** `[high]` `[patch]` recall.dropped 把「超预算被削」与「超 topK 被截」混成一个数，正常召回会被审计成降级 — 拆成 overCount / overBudget，只有后者进 truncatedItems（Design Notes 6）
- **blind24-6** `[medium]` `[patch]` composer 内重抄 DEFAULT_TOP_K 与 DEFAULT_RECALL_ITEM_TOKENS，违反 AD-26 单一真源 — 改为从 src/seams/config.ts 导入，本地副本已删
- **blind24-7** `[medium]` `[patch]` 身份段上限是字符、进预算时按 token 计，README 的池子算式无法用代码复现 — README.md:124 已写明「进池前按 estimateTokens 折成 token，中文接近 1200、拉丁文远小于此」
- **blind24-8** `[medium]` `[patch]` Runtime.injection 的 JSDoc 承诺「最近一次注入」，实现只在挂载时组装一次 — 文档改为「挂载时组装的计划」并说明逐轮计划随 Epic 7 到来；逐轮采样列入 deferred
- **blind24-9** `[medium]` `[patch]` registerSection 的失败分支不清空 injection，且用 composePersona().text.length > 0 重算而非读 plan — catch 里已置 injection = undefined，成功后改用 composer.hasSection
- **blind24-10** `[medium]` `[patch]` 本故事新增路径有四处没有用例（身份段文本变化的旧注册释放、尾巴全丢、非空换非空、- tail.tokens 的符号） — 已补三条对应用例；- tail.tokens 那项随算法删除而消失
- **blind24-11** `[medium]` `[patch]` AC5 用例可能空过：两次挂载配置不同、手写库文件名、不断言挂载状态 — 改为共用同一份 parseConfig({ db: { dim: 4 } })、断言两边 state=ok；writeScene 现在自己校验节点落库
- **blind24-12** `[low]` `[patch]` truncatedItems 号称封闭词汇表，实为 state:${string} 开放模板且 kept/dropped 是 string[] — 新增 TailSegment 三值联合，TAIL_SEGMENTS 改为段名数组
- **blind24-13** `[medium]` `[patch]` plan 缺审计行需要的 chars，2.6 无法按档填行 — ComposedPersona.chars、TailPlan.chars、RecallPlan.chars 已补齐，TailPlan.truncated 同时补上
- **blind24-14** `[low]` `[patch]` README 未描述本轮新增公开面 — 已新增「组装结果长什么样」，列 InjectionPlan 各字段、truncatedItems 三值词汇、prefixUnchanged 含义与「落行属 Story 2.6」
- **blind24-15** `[low]` `[patch]` 静态门用例只覆盖 systemPrompt.section(，删掉 context( 那条不会变红 — test/lint/layers.test.ts 新增 rejects prompt-seam calls on the tail channel too
- **blind24-16** `[low]` `[patch]` RECALL_ITEM_BUDGET_TOKENS 被 README 说成「每条按 60 token 估」，代码里是池子输入 — README 已改为「每条召回的估值输入，不是硬上限」，并说明长记忆会一次吃掉几条额度
- **blind24-17** `[low]` `[patch]` runtime-write 用例把 30 / 5 / 60 硬编码且缺空行 — 改为 DEFAULT_TAIL_MAX_TOKENS / DEFAULT_TOP_K / RECALL_ITEM_BUDGET_TOKENS 推导，空行已补
- **edge24-1** `[high]` `[patch]` register() 首句改 compose() 后，读取方抛错会先于 section 抛，本轮提示词没有身份段 — 新增 #readOrNothing 把读取失败降级为「本档没有内容」并回调 onReaderFailure；补两条用例，断线验证：拆掉兜底后 2 条转红
- **edge24-2** `[medium]` `[patch]` 召回循环用 continue，剩余额度 50 时 40-token 首项被丢而 20-token 次项被留 — 与 blind24-4 同一处，已改 break 并补「drops the tail of the list rather than skipping ahead to a smaller item」
- **edge24-3** `[medium]` `[defer]` readRecall 供了条目时召回文本从未送到宿主通道，而 tokens 自述「whole injection」 — 已改写 JSDoc 明说只计能真正进提示词的档；召回通道本身属 Story 2.5，届时该字段才恢复为真
- **edge24-4** `[medium]` `[patch]` 候选多于 topK 而额度还装得下时，正常截断被计进 recallDropped 并写入 truncatedItems — 已拆 overCount / overBudget（同 blind24-5），并补「stops at topK … without calling it a cut」
- **edge24-5** `[low]` `[patch]` section 抛错时 register() 不返回，injection = outcome.plan 永不执行、停在 undefined，与相邻注释相反 — 失败路径改为 failed: [section] 就地返回 plan；runtime 侧 catch 也已清空 injection（同 blind24-9）
- **vgap24-F1** `[medium]` `[patch]` #readOrNothing 的兜底行为已修好但全仓没有一个抛错的 reader 用例，删掉兜底仍旧全绿 — 新增两条抛错 reader 用例；断线验证后恰好这 2 条转红
- **vgap24-F2** `[medium]` `[patch]` 宿主拒绝注册时不抛、failed 报告、旧注册保留，这三条已实现但只有 composer 层用例 — 新增 runtime 层用例，断言 injection 仍在、loaded.sectionRegistered 为 false、日志出现 OMW_SECTION_NOT_REGISTERED
- **vgap24-F3** `[medium]` `[patch]` config.recall.topK 与 RECALL_ITEM_BUDGET_TOKENS 接进 composer 这件事没有任何测试锁定（composer 默认值恰等于 config 默认值） — 新增用 topK: 3 启动的用例；断线验证：删掉两行接线后该条报 expected 335 to be 215
- **vgap24-F4** `[low]` `[patch]` AC5 用例的 writeScene 不检查 insert 返回值也不断言节点数，删掉插入仍绿 — writeScene 现在回读 getPayload(id) 并校验 kind === scene，没落库就抛
- **intent24-1** `[high]` `[patch]` 共用预算在算术上把身份抵消，尾巴未满的余量送给召回 — 与 blind24-2 同一处，已改为每档各守上限（Design Notes 5）
- **intent24-2** `[medium]` `[patch]` 召回丢弃方向与意图的「从末位起丢弃」不符 — 已改前缀语义（同 blind24-4 / edge24-2）
- **intent24-3** `[high]` `[patch]` host 抛错时 runtime 永不记录 plan，与注释「即使 host 拒绝也保留」矛盾 — 失败路径改为就地返回 failed，runtime 拿到 plan 并把拒绝写进日志（同 blind24-9 / vgap24-F2）
- **intent24-4** `[medium]` `[patch]` INJ_HOST_THROWS 只在 composer 层被测，意图指定的 runtime 行为（记日志 + 标未注册）无断言 — 已补 runtime 层用例（同 vgap24-F2）
- **intent24-5** `[medium]` `[patch]` Runtime.injection 是挂载快照而非每轮数据，与 AD-7「尾巴每轮可变」冲突 — JSDoc 已改为「挂载时组装的计划」；每轮重算列入 deferred（与 blind24-8 同源）
- **intent24-6** `[medium]` `[defer]` INJ_100_ROUNDS 的「若干轮库不可用」被换成 composer 层 readState 轮换，真库不可用从未发生 — 100 轮哈希稳定已由用例守住；「库不可用轮次仍注册身份段」需宿主侧注入失败，随 Epic 7 复测 AC6 时一并补
- **intent24-7** `[medium]` `[patch]` 被审的 .review-2-4.diff 是早于最终版本的快照，缺的正是 AC 点名的 truncated: boolean — 评审材料生成后代码又被补丁改动；已在 finalize 前重新生成 diff 并复核一致性
- **intent24-8** `[medium]` `[defer]` INJ_RECALL_ABSENT 的 recall 是对象而非空数组，且真装配下 readRecall 从不传入 — 契约上 recall 恒为计划对象；召回通道在 Story 2.5 接入后该行才有真实取值
- **intent24-9** `[low]` `[patch]` 召回丢弃方向无法被现有断言区分（两条等长 30-token 条目） — 已补方向可区分的用例：25-token 超 20 池时 kept 为空、overBudget 2
- **intent24-10** `[low]` `[patch]` config 单源被复制进 composer（DEFAULT_TOP_K / DEFAULT_RECALL_ITEM_TOKENS） — 已改为导入（同 blind24-6）
- **intent24-11** `[low]` `[patch]` plan 没有 per-tier chars 字段 — 已补齐三档 chars（同 blind24-13）
- **intent24-12** `[medium]` `[defer]` prefixUnchanged 只对 composer 自己最近一次注册取样，轮级「与上一轮相同」没有第二个数据点 — 字段在 composer 层与 personaRegistered 互补且有用例；真正的逐轮采样要等每轮组装存在（Epic 7），已列入 deferred

## Design Notes

1. **「身份 > 状态 > 召回」是保留优先级，不是裁剪次序。** 两种读法结论相反：若按字面先削身份段，就会与 FR-15「库打不开时身份段照常注入」和 I9「100 轮哈希不变」直接冲突——一个会被预算削短的段不可能字节稳定。因此实现取「召回先让、状态逐条让、身份只受自身 1200 字符上限约束」；裁剪记录点名被削项，读的人不必猜。
2. **共用预算由三档上限推导，不新增配置键。** AD-7 与 NFR-9 都只给单档上限（1200 字符 / 30 token / ≤5 条），任何自造的总额数字都会变成第四份互相打架的口径。实现把三档都折算成 `estimateTokens` 的估算值，共用额度 = 三档上限之和；因为身份与尾巴各自先被自己的上限约束住，真正可能越界的只有召回，判据因此可观测：喂进超量召回，必被削。
3. **`prefix_unchanged` 是「这次没有再注册」的同义词，不是「文本看起来一样」。** 它直接读哈希缓存的状态，所以宿主侧字节不变与报告字段不可能各说各话。
4. **场景常驻为 0 用「不读库」来保证，而不是「过滤掉 scene」。** 过滤意味着先读了库再挑掉，那既违反 AD-7 的注入路径不查库，也会让场景记忆在别的档位漏出来。真挂载用例对比「库里有 scene 节点」与「空库」两次组装的结果逐字节相同，是比「断言 0 条」更强的判据；两次挂载共用同一份配置（同一个 `dim`），并各自断言 `state=ok`，否则「字节相同」可能只是「两边都失败了」。
5. **每档各守各的额度，尾巴的余量不转给召回。** 初稿让召回吃 `budget - identityTokens - tail.tokens`，等于召回的上限随宿主状态浮动，「每档各有预算」退化成「一个池子三家分」；而尾巴本来就可能整段缺席，这个浮动就在正常路径上。改为 `recallCap = topK × 每条估值` 后，每档的界只由自己的配置决定，`tokens ≤ budget` 也就自动成立，不需要再强制。
6. **被 `topK` 截断不算「被削」。** 条数到顶是契约在起作用，额度装不下才是被预算削了。两者分开记（`overCount` / `overBudget`），只有后者进 `truncatedItems`——否则审计行会把每一次正常召回都说成降级。
7. **宿主拒绝注册不抛异常，且旧注册要等新调用成功才释放。** 身份段与尾巴是两条独立通道：section 被拒时尾巴仍应落地，抛异常会让调用方只看到「失败」而丢掉幸存的半份。替换时先调新注册、成功后才释放旧的，是因为「宿主拒绝替换」与「提示词失去身份段」是两件事，前者不该导致后者。
8. **身份段文本可传函数。** 固定字符串在单个 composer 实例内哈希永远不会变，「文本变了就重注册」那条分支既不可达也无测试可守；允许传 `() => string` 之后，这条分支与 `prefix_unchanged` 的两种取值都能被真实驱动。

## Verification

**Commands:**
- `pnpm build` -- expected: exit 0，`lib/` 重新产出。
- `pnpm lint` -- expected: exit 0，含 `tsc` 双工程、`scripts/check-layers.mjs`（零违规）、eslint。
- `pnpm test` -- expected: exit 0，新增用例全过、既有用例零回归。
- `pnpm test:coverage` -- expected: 行 ≥80%、分支 ≥70%。

**Observed (2026-11-24, this worktree):**
- `pnpm build` exit 0；`pnpm lint` exit 0（`layers: 79 个源文件，全部规则通过`）；`pnpm test` exit 0（Test Files 32 passed | 1 skipped (33)，Tests 446 passed | 1 skipped (447)）；`pnpm test:coverage` exit 0（lines 92.14 / statements 90.02 / functions 92.23 / branches 78.43）。
- `test/seams/prompt-composer.test.ts` 29 条全过，含 100 轮哈希全同与 1000 次组装压测（`perf compose: median=0.053ms p95=0.075ms n=1000`）。
- `test/seams/runtime-write.test.ts` 17 条、`test/load/inject.test.ts` 15 条、`test/lint/layers.test.ts` 18 条全过。

**Manual checks:**
- 真挂载由测试承担，不再另写探针：合并 main 之后 `src/cli/recording-ctx.ts` 已移到 `test/support/recording-ctx.ts`，不再进 `lib/`，独立 `.mjs` 探针无从导入它。
- `test/load/inject.test.ts > load: identity section > is byte-stable across two independent loads` 覆盖「连续两次挂载 section 文本 sha256 相同」。
- `test/load/inject.test.ts > load: what the injection may read (Story 2.4) > injects the same bytes whether or not a scene is in the store` 覆盖场景常驻：先在临时 home 的库里写一条 `scene:` 节点再挂载，与空库逐字节比对。
- `test/load/inject.test.ts > load: stderr confirmation > prints exactly one loaded line naming the section` 覆盖 loaded 行仍只一行且段名正确。

## Auto Run Result

**Status:** done

**What was built.** `src/seams/prompt-composer.ts` 从一个「两次登记」的门面变成唯一的注入出口：`compose()` 一次算出三段计划（身份段 / 状态尾巴 / 召回），`register()` 只消费这份计划去调用两条宿主通道。三段各有各的上限——身份段 1200 字符（进池前用 `estimateTokens` 折算）、尾巴 30 token、召回 `topK × RECALL_ITEM_BUDGET_TOKENS`——任一档装不下时只削自己，尾巴的余量不转给召回。计划里带每档的 `chars` / `tokens` / `truncated`、三值 `truncatedItems`、全局 `truncated` 与 `prefixUnchanged`，`Runtime.injection` 把它原样暴露给 Story 2.6 落审计行，不重算。读者失败（`readState` / `readRecall` 抛错）降级为「本档没有内容」并经 `onReaderFailure` 上报，身份段照常注入；宿主拒绝注册时 `register()` 返回 `failed: ['section' | 'context']` 而不抛，旧注册只在新调用成功后才释放。

**Changed files.**
- `src/seams/prompt-composer.ts` — 重写为计划 + 消费两步；新增 `plansStateTail`、`InjectionPlan`、`TailSegment`、`HostChannel`、`#readOrNothing`、`hasSection`。
- `src/seams/runtime.ts` — 传入 `topK` 与 `recallItemBudgetTokens`；新增 `injection` 与 `Runtime.injection`；`registerSection` 按 `outcome.failed` 记日志。
- `src/seams/config.ts` — 新增 `RECALL_ITEM_BUDGET_TOKENS`（导出的单一真源）。
- `test/seams/prompt-composer.test.ts` — 新增文件，31 条。
- `test/seams/runtime-write.test.ts` — 新增注入计划、topK 接线、宿主拒绝三条（18 条）。
- `test/load/inject.test.ts` — 新增 AC5 场景常驻用例，`writeScene` 自校验落库（15 条）。
- `test/lint/layers.test.ts` — 新增 `context(` 通路的门用例（18 条）。
- `README.md` — 新增「注入：两段，一个出口」与「组装结果长什么样」两节。

**Findings.** 四层评审共 38 条（blind 17 / edge 5 / vgap 4 / intent 12），裁定 high 5 / medium 22 / low 11，patch 34 / defer 4 / reject 0，无 intent_gap、无 bad_spec。三条 high 是真缺陷：召回吃尾巴余量（`room` 算法）、两种截断混记成一个 `dropped`、读取方抛错会让本轮丢失身份段。四条 defer 都是「本故事没有数据源」而非实现缺陷：逐轮注入计划、召回宿主通道、`prefixUnchanged` 的轮级取样（三者都要 Epic 7 或 2.5 的真实数据源）、以及 CI 未在 GitHub 实跑。

**Follow-up.** Story 2.5 接入召回通道后，`InjectionPlan.tokens` 里的召回那一档才会变成真实数字，本故事 JSDoc 已写明这一点。Story 2.6 直接把 `Runtime.injection` 的字段写成 `InjectionAuditRow`，不需要重算。Epic 7 交付状态尾巴真实内容后需复测 AC6（≤1 条偏好、≤1 条 flag）与逐轮注入。

**Verification.**
- `pnpm build` / `pnpm lint` / `pnpm test` / `pnpm test:coverage` 四命令全部 exit 0（BUILD=0 LINT=0 TEST=0 COV=0）。
- `pnpm lint` 含 `layers: 79 个源文件，全部规则通过`。
- `pnpm test`：Test Files 32 passed | 1 skipped (33)，Tests 450 passed | 1 skipped (451)。
- 覆盖率：lines 92.29% / statements 90.16% / functions 92.23% / branches 78.5%（阈值行 ≥80、分支 ≥70）。
- `perf compose: median=0.109ms p95=0.195ms n=1000`（判据 p95 ≤20ms）。
- **两处断线验证**：①把 `#readOrNothing` 的 try/catch 拆掉 → `prompt-composer.test.ts` 恰好 2 条转红（`keeps the identity section when the state reader throws`、`…when the recall reader throws`），恢复后 31 条全过；②把 `runtime.ts` 里 `topK` 与 `recallItemBudgetTokens` 两行接线删掉 → `takes the recall width from the configuration, not from the composer default` 报 `expected 335 to be 215`，恢复后 18 条全过。

**Residual risk.** 召回那一档在真实挂载下恒为 0（没有宿主通道），审计行若照此记录会低估实际注入量——这是 2.5 的前置事实，已写进 JSDoc 与 deferred。另一处是 `Runtime.injection` 只在挂载时组装一次：状态尾巴在 Epic 2 阶段恒空，所以现在不会错，但一旦尾巴有真实数据源，每轮都需要重新组装，否则审计行会重复报同一份快照。