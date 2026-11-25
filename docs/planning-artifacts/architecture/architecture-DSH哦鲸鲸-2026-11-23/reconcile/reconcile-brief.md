# 对账简报：产品简报/附录 ↔ 架构骨架

> **时点说明（2026-11-23 收口）**：本文件是当时的一次快照核查，正文里的行号与 AD 编号范围（如「254 行 / AD-1…AD-18」「268 行 / AD-1…AD-20」）均指当时版本。收口后的骨架为 **397 行 / AD-1…AD-26**。**2026-11-25 再记**：经研究线融合与编号审计，骨架现为 **471 行 / AD-1…AD-55 / CAP-1…CAP-9 / FR-1…FR-77 / NFR-1…NFR-16**（新增 CAP-7 上下文治理、CAP-9 入口与路由）。凡与当前骨架冲突，以骨架为准，本文件只作「当时为什么这么判」的证据，**其 AD 编号均指 2026-11-23 口径，勿直接引用**。

> 角色：架构对齐核查（来源：产品简报与附录）
> 核查对象：docs/planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/ARCHITECTURE-SPINE.md
> 核对版本：268 行，AD-1..AD-20；sha256 831e5aa82627240fd3bb57c492b461dd695931ddc81b17aae92c92327548ce8f；mtime 2026-11-23T08:33:46+08:00
> 来源文稿：brief.md（110 行）、addendum.md（65 行）
> 方式：只读；设计文档只作旁证，不作为权威。行号均指上述版本。
> 版本备注：memlog.md:52 显示 AD-10/13/14/15/16/19 与 Gates 节仍在修订；本简报是对当前快照的对账，已列入“待改”的项在下一次修订后可能消失。

## 结论

有实质分歧：12 条（3 high / 8 medium / 1 low）。

- 8 个「已否决方案」均未被骨架以任何形式重新引入（逐项见文末）。
- BLOCKING 的 dsh-mnemon 关系有明确落点（AD-16：替换不共存 + legacy 开关），但迁移键派生与 AD-3 冲突（F8）；memlog:50 已给出修正方向，AD-16 待改。
- 四个成功标准中，2 的“谁改/哪版 prompt”最弱，3 的撤销契约不完整，1 的落点标注不成立，4 缺缓存命中率采集。

## 发现索引

| ID | 严重度 | 骨架位置 | 源文稿 | 冲突摘要 |
| --- | --- | --- | --- | --- |
| F1 | high | AD-5 / AD-9 / AD-14 / AD-15 | brief:62,70,90；addendum:17-19 | 逐条撤销原语已补，但无 op_id / 复合操作 / Flag 与边复原；delete 口径未同步 |
| F2 | high | AD-5 / AD-6 / AD-20 | brief:60,89；addendum:14 | 无 actor / prompt_version，20/20 答不出“谁改、哪版” |
| F3 | medium | AD-9 | brief:46,71；addendum:34-35 | 自动档直接 supersede，越过“落库一律待人确认”，且未记录覆盖关系 |
| F4 | high | AD-11 / 节点图 / 能力映射 | brief:36-41,40,88,97 | L0–L3 无映射；L3 画像被静态 persona.md 取代 |
| F5 | medium | AD-10 | brief:51-52 | 无 dream_log / 检查点 / seed，断点续跑与“为什么挑这条”落空 |
| F6 | medium | AD-1 / AD-4 / seams | brief:44 | 三个写入口只落实 agent 工具；无用户命令、无会话结束抽取 |
| F7 | medium | AD-8 / AD-10 | brief:55-57,97 | 热度 / 衰减 / 晋升无 AD；L2 只由 dream 产生 |
| F8 | medium | AD-16 与 AD-3 | brief:103 | mem_key 用 uuid5(file:linehash)，与身份语法冲突、行号变动不幂等 |
| F9 | medium | AD-7 / AD-20 | brief:91；addendum:21-23 | 只记 token，不采集 cache 命中率 |
| F10 | medium | Deferred / scripts | brief:89,93；addendum:14 | 查询面推到 M5，v1 没有 30 秒答清的工具 |
| F11 | low | Open Questions / AD-10 | brief:106 | 自动挖料边界未决也未列 Open Question |
| F12 | medium | 成功标准落点 / AD-6 / AD-17 | brief:88；addendum:7-11 | 标准 1 是“该不该记”，AD-6/17 只覆盖来源与推断结算 |

## 详细发现

### F1 — 撤销原语已补，但“10/10 完整撤销”仍缺操作级契约
- 严重度：high
- 骨架位置：AD-5（67-71）、AD-9（91-95）、AD-14（121-125）、AD-15（127-131）；Deferred「治理界面细节」（261）
- 源文稿位置：brief.md:90（10/10 零残留）、brief.md:62（删除与归档一律留 tombstone，可完整回滚）、brief.md:70；addendum.md:17-19（10 次操作覆盖手动删除 / dream 归档 / 冲突替换 / 过期失效 / 整场景废弃，验证内容、版本链、Flag、检索结果复原）
- 冲突：AD-5 已补“撤销 = 同事务移除 superseded_at + 清 tombstone，逐条可回滚”，并明确全库快照是灾难恢复而不是撤销机制——方向已对上。但标准 3 要求的是“每次操作后完整撤销”并验证四类状态；AD-5 只有逐条原语，没有 op_id、undo journal 或影响集，无法把一次复合操作作为一个单位回滚。tombstone 没有字段/节点定义；AD-9 的自动替换还会插入新断言、flag 节点和 contradicts 边，单纯“移除 superseded_at”不会回收它们；dream 的多节点归档、scene 废弃的级联、检索可见性复原也都没写。AD-14/AD-15 仍按“ops 可执行破坏性操作 / delete”的措辞（memlog:52 标注待改），与 AD-5 的“delete 全仓禁止”不一致，静态门仍会放行 ops 里的 delete。
- 建议：在 AD-5 增补 undo 契约（op_id + 影响集 + 原子复原 + audit 行），明确 tombstone 字段、AD-9 flag/边与 scene 级联的回收规则，并同步 AD-14/AD-15 的删除例外；v1 至少给一个 undo 命令。
- 旁证：memlog.md:45 记录这次修订是对 rec-design high#1 的响应；memlog.md:52 列 AD-14/AD-15 待改；plugin-design-triviumdb-v2.md:107/261 要求回收站与撤销是内置能力、M5 治理面含撤销。

### F2 — 无法回答“被谁改过、哪版 prompt 生成”
- 严重度：high
- 骨架位置：AD-5（67-71）、AD-6（73-77）、AD-20（157-161）、Consistency Conventions 记账行（168）
- 源文稿位置：brief.md:60（版本链要回答“替换了什么、被谁改过、哪版 prompt 生成”）、brief.md:89（20/20 在 30 秒内答清）、addendum.md:14（只允许用产品自带的查询界面 / 命令）
- 冲突：AD-5 只给 valid_from / valid_to、recorded_at、superseded_at 三轴；AD-6 的 evidence 指向对话来源，不是修改者；AD-20 只记注入与召回，不记写入。全仓没有 actor、cause、prompt_version、dream_cycle 等字段或边；Conventions 里的 actor 属于 token 记账行，不是断言级来源。因此“谁改的”只能靠猜，“哪版 prompt 生成”无数据，20/20 无法成立（grep 证据：除记账行外，actor / cause / prompt_version 0 命中）。
- 建议：每条断言 / 每次写入强制记录 actor（tool / user / dream / migration / adjudication）、cause、prompt_version（无则 null）与 cycle_id，并让查询模板和导出都带出这四项。

### F3 — 自动裁决越过了“落库一律待人确认”，且未记录覆盖关系
- 严重度：medium
- 骨架位置：AD-9（91-95）
- 源文稿位置：brief.md:46（LLM 只提议，落库一律转成新版本 + 旧版本软删除 + 版本链，并生成一条待人确认的 Flag）、brief.md:71（机器不擅自改你的记忆，只把矛盾和过期写成待办）；addendum.md:34-35（否决纯人工与纯 LLM 两种极端）
- 冲突：自动档在同一次 commitTransaction 里给旧断言填 superseded_at、插入新断言、写 flag(kind=flag, status=resolved_auto) 与 contradicts 边，没有人工确认。即使只做符号可判（single 谓词、同 kind/subj/pred、区间重叠、obj_norm 不同），它仍是一次无人确认的语义改写，与“落库一律待人确认”和“机器不擅自改”直接矛盾。memlog.md:21 显示用户后来裁定允许自动档，但附加了“可回滚”；AD-5 现在给了逐条撤销原语，所以“可回滚”有基础，但 AD-9 既没有写“本档取代 brief 的哪句承诺”，也没有规定 resolved_auto flag 如何被人工复核 / 撤销。
- 建议：在 AD-9 明写“本档取代 brief.md:46/71 的一律待人确认”，并给 resolved_auto flag 一个可复核 / 可撤销的状态转换；同步 brief 的“凭什么不同”措辞。
- 说明：这不是要求撤销自动档；是要把用户裁定的覆盖关系写进骨架，否则产品对外主张与实现不一致。

### F4 — L0–L3 分层与 L3 画像在骨架中没有落点
- 严重度：high
- 骨架位置：AD-11（103-107）、节点与边的形状（222-236）、Capability → Architecture Map（238-247）、Structural Seed（187-202）
- 源文稿位置：brief.md:36-41（L0–L3 分层；L3 画像“整篇重写而非追加，只用于注入”）、brief.md:88（抽 50 条 L1 人工盲判）、brief.md:97（v1 内包含 L0–L3 分层）
- 冲突：骨架全文没有 L0/L1/L2/L3 术语，也没有到节点 kind 的映射（grep 证据：L1/L2/L3 与“画像”均 0 命中，L0 仅在 Open Question 2 出现一次）。节点 kind 是 assertion / pref / episode / scene；L2 只有 scene，L3 画像没有节点、没有文件、没有生成步骤。AD-11 的身份是随插件发布、字节稳定的 persona.md，与“画像整篇重写”是相反的性质；persona_state 只有 30 token 尾巴，不是画像。标准 1 的抽样对象 L1 因此无定义。fusion-design-v1.md:38 的画像层（traits + evidence + confidence_band）同样没有落点。
- 建议：在能力映射中补一行 L0–L3 ↔（文件 / 节点 kind / 注入位置）的显式映射，并补画像节点或明确由 pref/traits 投影生成并写回，定义其证据链、重写周期与注入预算；把标准 1 的“L1”改成可执行的节点 kind。
- 说明：fusion-design-v1.md:46 有意把 brief 的 L1 改写为 Assertion/Evidence 双时态，这是设计修订；但修订后没有回写 brief 的验收口径，也没有在骨架里保留映射，导致验收对象悬空。

### F5 — dream 的断点续跑与种子被“统一提交”抹掉
- 严重度：medium
- 骨架位置：AD-10（97-101）、节点图（222-236）、Structural Seed 的 dream/（194）
- 源文稿位置：brief.md:51（逐阶段写日志，可断点续跑）、brief.md:52（种子写进产物，事后能回答“为什么挑了这条”）；addendum.md:46-47（断点续跑与预算的证据）
- 冲突：AD-10 要求“每步产出 diff 后统一提交”，幂等只靠完成时的 dream_cycle 标记；没有 dream_log 或阶段检查点节点，中断后只能整轮重跑，已经花掉的 LLM 预算作废；也没有 seed 字段，“为什么挑了这条”无法回答（grep 证据：断点 / 检查点 / 续跑 / dream_log / seed 均 0 命中）。八步本身是 fusion-design-v1.md:108 的有意修订，不算分歧；丢的是设计明写的 dream_log 与 payload.seed（fusion-design-v1.md:69、plugin-design-triviumdb-v2.md:144/259）。
- 建议：增加 dream_log 节点或文件（阶段、输入哈希、预算、diff 摘要、seed），每阶段持久化；AD-10 改为“阶段检查点 + 末尾统一提交业务 diff”。

### F6 — 三个写入口只落实了一个
- 严重度：medium
- 骨架位置：AD-1（43-47）、AD-4（61-65）、seams/（196）、Capability Map 的 CAP-1（242）、scripts/（200）
- 源文稿位置：brief.md:44（三个入口：agent 显式工具、用户命令、会话结束的去抖抽取）、brief.md:88（False Negative 要单独统计）
- 冲突：骨架只规定补丁表写机制，没有会话结束抽取 / 去抖队列的接缝或 AD；用户命令入口也没有（scripts 只有 snapshot / verify / migrate）。若只靠 agent 显式 remember，自动捕获缺失，标准 1 的漏记（FN）无法控制。plugin-design-triviumdb-v2.md:193/236 明确要求“写入异步，抽取在会话结束后的后台任务里跑”，骨架未接（grep 证据：去抖 / 用户命令 / extraction 0 命中）。
- 建议：在 seams/ 增 extraction 接缝（session-end / turn-stopping → 去抖队列 → 补丁表），并给用户命令一个入口（工具或 CLI），在 CAP-1 映射中列出。

### F7 — 热度、衰减与晋升没有 AD
- 严重度：medium
- 骨架位置：AD-8（85-89）、AD-10（97-101）、节点图
- 源文稿位置：brief.md:55-57（热度达到阈值 → 升 L2；长期不命中 → 归档不删除；幂律 + 对数 rehearsal 作排序因子；检索只读）、brief.md:97（v1 内含热度晋升与归档）
- 冲突：AD-8 只禁止召回写，没有定义热度从哪来、如何投影；骨架没有 heat / decay / promotion 字段或 AD，L2 只由 dream 的场景抽象产生，“热度晋升 L2”和“长期不命中归档”没有落点（grep 证据：衰减 / 晋升 0 命中，热度仅出现在 AD-8 的 Prevents 里）。AD-20 的 hits 可以作派生输入，但骨架没有规定这条链路。fusion-design-v1.md:52 的裁决是“可及性读时投影、访问热度只影响排序、绝不改写存储”，骨架也没有承接。
- 建议：明确热度 = audit.jsonl 的读时投影（不改存储），晋升 / 归档作为 dream 的确定性步骤并写 dream_log；或在 Deferred 明写 v1 不做晋升。

### F8 — mnemon 迁移的 mem_key 派生与 AD-3 冲突，且行号变动不幂等
- 严重度：medium
- 骨架位置：AD-16（133-137）与 AD-3（55-59）
- 源文稿位置：brief.md:103（BLOCKING：替代 / 共用 / 并行，决定第一行代码写在哪）
- 冲突：AD-3 规定业务身份 mem_key = kind:subj:pred[:obj_norm]，由唯一复合索引保证唯一；AD-16 却用 uuid5(namespace, file:linehash) 派生 mem_key。行号一变哈希就变，重跑会产生重复节点，与 AD-16 自称的“幂等”和 AD-3 的唯一索引都不一致。BLOCKING 本身有落点（替换不共存 + legacyMnemonInject 回滚开关 + 不删源文件），但落点机制与身份模型冲突；plugin-design-triviumdb-v2.md:213 原本只是把它当迁移幂等键 / id，不是 mem_key。memlog.md:50 已裁定“pref 的 mem_key 用业务身份 pref:<规范化 key>；uuid5(file,linehash) 只作 migration_id”，memlog.md:52 把 AD-16 列为待改，说明这条是当前快照的遗留。
- 建议：迁移仍生成 mem_key 语法（例如 pref:user:<slug>），uuid5(file:linehash) 只作 migration_id 或节点 id 存在 payload，不冒充 mem_key；或在 AD-3 明确迁移例外。

### F9 — 标准 4 的缓存命中率没有采集
- 严重度：medium
- 骨架位置：AD-7（79-83）、AD-20（157-161）
- 源文稿位置：brief.md:91（token 增长受对数约束，命中率下降 < 10%）、addendum.md:21-23（记忆量 100/1000/10000 三档，记录常驻注入 token 与 prompt cache 命中率）
- 冲突：AD-20 只记 chars / tokens / items / truncated，没有 prompt cache 命中或未命中的采集；AD-7 只保证身份段字节稳定，是代理指标而非命中率。达标线没有数据来源（grep 证据：命中率 0 命中）。
- 建议：AD-20 审计行增加 cache 命中字段（若宿主暴露），否则明确用“身份段哈希变更次数 / 注入字节”作代理指标并同步改口径。

### F10 — 标准 2 的验收面被推到 M5，v1 没有查询工具
- 严重度：medium
- 骨架位置：Deferred「治理界面细节」（261）、scripts/（200）、CAP-3（244）
- 源文稿位置：brief.md:89（20/20 在 30 秒内答清）、brief.md:93（v1 先兑现 2 和 3）、addendum.md:14（只允许用产品自带的查询界面 / 命令）
- 冲突：骨架把治理视图推到 M5，scripts 只有 snapshot / verify / migrate；v1 末要在 30 秒内答清 20/20，却没有可用的查询 / 审计面。与“v1 先兑现 2”直接冲突。
- 建议：明确 v1 至少交付一个只读查询命令（按 mem_key / 时间 / flag 查 + 版本链 + 证据），GUI 可继续 M5。

### F11 — 未决 #4「自动挖料边界」既未决策也未列入 Open Questions
- 严重度：low
- 骨架位置：Open Questions（263-268）、AD-10（97-101）
- 源文稿位置：brief.md:106（v1 是否从宿主会话日志只读自动挖料，还是只从显式写入开始）
- 冲突：骨架既没有回答，也没有把它列入 Open Questions；而 dream 的“重放抽样”隐含需要读宿主日志，范围与隐私边界未定。
- 建议：在 Open Questions 增列，或在 AD-10 明确 v1 只从显式写入 + 当前会话抽取，不回填历史日志。

### F12 — 标准 1 的落点标注不成立，缺写入准入与评测契约
- 严重度：medium
- 骨架位置：成功标准落点（249）、AD-6（73-77）、AD-17（139-143）
- 源文稿位置：brief.md:88（抽 50 条 L1 人工盲判“该不该记”，≥80%）、addendum.md:7-11（按时间分层抽样，FP / FN 分开统计，拒绝用检索命中率替代）
- 冲突：标准 1 衡量的是“该不该记”的写入判断；AD-6 只保证来源可追，AD-17 只管推断可结算，两者都不约束准入。骨架没有写入准入 / 去重规则，也没有评测数据契约（按 recorded_at 分层、FP / FN 标签、第三判记录）。因此第 249 行“记忆精度 → AD-6 + AD-17”的映射不成立。
- 建议：补写入准入 / 去重规则，并定义评测导出（分层抽样、FP / FN 标签、盲判记录）；把第 249 行的“记忆精度”改为“可追溯性”，或补上真正的精度支撑。

## 已核对、不构成分歧

### 8 个「已否决方案」

| 方案 | 骨架中的处置 | 判定 |
| --- | --- | --- |
| 参数式 dream（后台更新权重 / 衰退系数） | Deferred「参数化学习（改权重、训模型）」；AD-10 无训练回路 | 未复活 |
| 四包服务化 + 多存储后端 | AD-1 单进程纯插件；AD-2 单文件库直连，不设适配层 | 未复活。embedding 是外部 API 出口，不是第二个部署单元 |
| 只做 ADD、不裁决 | AD-9 三档裁决；AD-17 可结算 | 未复活 |
| 召回即写入 | AD-8 召回路径禁止任何写调用（含 updatePayload 与 flush） | 未复活 |
| 分层用 FSRS + ACT-R 双理论 | 全文无 FSRS / ACT-R；AD-12 是人格关系权重，不是记忆衰减 | 未复活 |
| 把裁决完全交给人 | AD-9 有自动档与提案机制 | 未复活（但见 F3：自动档越过了“待人确认”） |
| 把裁决完全交给 LLM | AD-9 自动档只做符号可判；LLM 提案不直接落库 | 未复活 |
| 梯度式连续记忆（CMS） | 无训练回路；Deferred 参数化学习 | 未复活 |

### 五阶段 vs 八步
brief.md:50 写五阶段，AD-10 写八步。fusion-design-v1.md:108 明确建议“dream 从五阶段扩为八步，并把确定性结算提到最前”，属于有意的设计修订，不是骨架静默遗漏。memlog.md:47 也给了 8 步权威清单。但 brief.md:97 的 v1 范围仍写“五阶段 dream”，建议同步 brief 或加一行映射。不计入发现。

### mnemon BLOCKING
AD-16 明确选择“替换而非共存”，对应 brief.md:103 的三个选项；不删源文件 + legacyMnemonInject 回滚开关满足“可回退”。关系问题有落点；机制缺陷见 F8，memlog.md:50 已给出修正方向。

### 其他已核对
- 纯文本导出：brief.md:64/74 与 Consistency Conventions“导出为纯文本 + JSONL，不含节点 id”一致（JSONL 是否满足“markdown 可读”可另议，不构成 Rule 冲突）。
- 有界召回：brief.md:64 与 AD-8 一致（默认 5、硬上限 8、800ms、无 offset 循环、宁可返回空）；AD-8 的 fatigue 默认关闭且为引擎内部状态，不违反“召回只读”。
- 单文件 SQLite FTS5：brief.md:41 的存储机制已被 plugin-design-triviumdb-v2.md 的 TriviumDB + TEXT（AC/BM25）取代；这是有意的技术选型变更，不影响“混合召回”的产品承诺，但 brief 未同步。不计入发现。

## 口径备注（不计入发现）

- memlog.md 记录 2026-11-23 用户裁定“dogfood 不设质控指标”，而 brief 的四条达标线与 spine 第 249 行仍按验收映射。需明确四条是 v1/v1.5 验收还是仅监控；否则 F9/F10 的“达标线”没有验收场景。
- 本简报以 sha256 831e5aa82627240fd3bb57c492b461dd695931ddc81b17aae92c92327548ce8f 的骨架版本为准；骨架若继续修订（memlog:52 已列待改项），按 AD 编号定位，不以行号为准。
