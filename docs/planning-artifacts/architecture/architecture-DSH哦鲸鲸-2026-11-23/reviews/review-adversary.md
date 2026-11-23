# 对抗性评审 — 两个互不兼容的合规实现

- **评审对象**：`ARCHITECTURE-SPINE.md`（22 条 AD，312 行）
- **参照**：`SOLUTION-DESIGN.md`（骨架的下沉实现）、`C4-VIEWS.md`（组件边界与时序）、`.memlog.md`（裁定历史）
- **角色**：第 2 位评审 · 对抗性（两单元兼容性）
- **日期**：2026-11-23
- **纪律**：只读；不评风格/措辞/篇幅；每条给出「改哪条 AD、改成什么」

---

## 结论

**verdict：22 条 AD 在「禁止什么」上是硬的，在「同一件事怎么算同一件」上仍是软的——6 处边界足以让两个都自认零违规的实现产出互不兼容的库；F1（新版本进入路径）与 F3（撤销比较域）是阻断级，必须在 M1 开工前落成可判定断言。**

| # | 主题 | 涉及 AD | 严重度 | 一句话 |
| --- | --- | --- | --- | --- |
| F1 | 新版本怎么进库：覆盖写还是第二条节点 | AD-3 / AD-5 / AD-9 | 高 | 唯一索引的复合成分没写，导致「历史在节点里」与「历史在账本里」两种库 |
| F2 | `obj_norm` 是没版本号的不可变身份函数 | AD-3 | 高 | 算法一改全库 key 失配，而骨架没有重算路径 |
| F3 | 撤销的「逐条一致」没有比较域 | AD-22 / AD-21 | 高 | `affected[]` 闭包未定义，且该条验收口径自我否决 |
| F4 | 3s 去抖的作用域、饥饿与「本轮」边界 | AD-4 / AD-6 | 高 | 全局去抖会把两个会话合进一个单会话证据指针 |
| F5 | dream ② 的种子与锚点集可否重算 | AD-10 | 中 | 断点续跑与可追溯性在两种读法下互斥 |
| F6 | 三层预算的单位、记账粒度与叠加 | AD-7 / AD-10 / AD-20 | 中 | 字符与 token 混用，阶段预算与日上限无语义，`dream_truncated` 两个意思 |
| 附录 A | `tqlMut` 的辖区互斥 | AD-4 / AD-15 | 中 | 不是两种解释，是两条 AD 字面不能同时满足，CI 必挂 |

### 判定约定

两个单元的画像是刻意对称的，不是挑刺：

- **单元 A（字面派）**：把 AD 当规范逐字读，凡未规定处取最保守、最贴近设计稿的写法，偏好「少写多读、历史留在账本」。
- **单元 B（语义派）**：把 AD 当意图读，凡未规定处取「显然应该」的语义（同一件事只有一条、历史可查、幂等可复现），偏好「多写对齐」。

本文说「都合规」，指**字面合规**：A 与 B 都不违反任何一句禁止性表述，只在 AD 没写的地方分歧。凡涉及 triviumdb API 具体行为而未能核对的，标「未证实」；凡引宿主事实的，标「已核对」。

---

## F1 · 新版本怎么进库：覆盖写还是第二条节点

**严重度：高｜AD-3、AD-5、AD-9**

### 场景

3 月用户说「我住北京」，写入 assertion(subj=user, pred=`lives_in`, obj=北京)。11 月说「我搬去上海了」。`lives_in` 是 TBox 的 `single` 谓词——按设计稿 §2.3 与 memlog 的裁定，`single` 谓词的键是 `assertion:<subj>:<pred>`，**不含 `obj_norm`**。

### 单元 A 的做法

严格照设计稿的单列唯一索引 `createUniqueCompositeIndex(["mem_key"])`。它发现第二条同 key 节点进不去，于是把「版本链」实现为**同一节点 + decision 账本**：`updatePayload` 覆盖 `obj` / `valid_from` / `recorded_at`，历史留在 `decision{from:北京, to:上海}` 里。

逐条核对：没有物理删除、未失效时不写 `superseded_at`、没有写 null——**全部合规**。AD-5 只在 Prevents 段说「覆盖写导致历史不可回溯」，Rule 段没有任何一句禁止覆盖 `obj`；AD-9 的自动档要求「插入新断言」，但 A 让这个前提**不可达**：没有第二条节点可插，自动裁决就永不触发，全部冲突走「提案 + 挂起」——AD-9 的 Rule 写的是「其余冲突只允许提案 + 挂起」，所以 A 也能辩称合规。

### 单元 B 的做法

认为 AD-9 的「旧断言置 `superseded_at` + 插入新断言」是硬步骤，于是把唯一索引改为复合 `(mem_key, superseded_at)`：缺失值代表「活版本」，同 key 允许一条活版本 + 多条死版本。

也**全部合规**：AD-3 只说「由唯一复合索引保证唯一」，没说复合成分；AD-5 没有限制索引怎么建。

### 接起来会怎样

1. **A 的库经 B 的模板读**：`superseded_at` 缺失 → 被判为 current → 返回**被覆盖后的上海**；`knownAsOf(2026-06)` 也返回上海。治理 20 问里的「当时为什么说北京」在 A 库上永远答不出，因为版本链长度恒为 1。
2. **B 的库经 A 的写入**：A 的第二次 `insert` 撞上它没预料到的「活版本唯一」约束 → 落 `rejected`。审计合规，用户仍然丢了新事实，且治理视图只看到一条 rejected，看不出这是「架构不支持更新」。
3. **默认查询的第三处空白**：AD-5 允许「世界时间失效 ≠ 记录失效」（只置 `valid_to`、不置 `superseded_at`）。默认查询按 AD-5 只过滤 `superseded_at`，于是一条 `valid_to` 已过的北京仍会被召回。A 与 B 谁都没错——**没有 AD 规定默认查询要不要叠加 `valid_to` 过滤**。
4. **治理语义分叉**：A 的库永远没有 `contradiction` flag（自动档不可达），B 的库有。同一个治理界面的「待处理矛盾」空队列，在两个单元里是两种含义。

### 哪条 AD 缺失或太松

- **AD-3**：「由唯一复合索引保证唯一」没有写**复合成分**，而 `single` 谓词的键公式本身不含版本判别位。
- **AD-5**：Rule 没有写「新版本如何进入库」，只有 Prevents 段的一句动机；也没有说默认查询是否叠加 `valid_to`。
- **AD-9**：要求「插入新断言」，却没有与之配套的索引语义；其自动档在 A 的存储下是死条文。

### 补法（一句话）

AD-3 把唯一性收窄为「只约束未失效版本，索引为 `(mem_key, superseded_at)`」，AD-5 增加「`single` 谓词的值变更必须与旧版本 `superseded_at` + `valid_to` 置位在同一 `commitTransaction` 内成对提交，禁止覆盖 `obj`/`obj_norm`」，AD-5 同时把默认查询写死为 `superseded_at` 不存在 ∧ (`valid_to` 不存在 ∨ `valid_to` > now)。

---

## F2 · `obj_norm` 是一个没有版本号的不可变身份函数

**严重度：高｜AD-3**

### 场景

三句话进库：「我住 上海」「我住在上海。」「我住上海市」。三周后又把规范化算法从「去标点」升级到「去中文行政后缀 + 数字归一 + 别名映射」。

### 单元 A 的做法

只实现设计稿 §2.3 列的五步（去首尾空白、全角转半角、去标点、英文小写、压空白），不做后缀与同义；`obj` 原文入 payload。

合规：AD-3 只给了 `obj_norm` 这个占位符，**没有任何一句定义它**；设计稿不是骨架，对实现没有约束力。

### 单元 B 的做法

认为 AD-3 的目的句「同一件事只有一条断言」是约束，「上海」与「上海市」必须同 key，于是额外做后缀剥离、`三十岁 → 30`、`魔都 → 上海`（读 `entity.aliases`）。

也合规：设计稿 §12.3 承认「同义留给 dream 与人工」，但没禁止把这一步前移到 key 构造。

### 接起来会怎样

1. 同一句话在 A 库落 `...:lives_in:上海市`，在 B 库落 `...:lives_in:上海`。治理视图按 `mem_key` 取版本链，同一事实得到两条互不相关的链；dream ⑦ 跨主题重组按 key 去重，两条都留。
2. **真正的杀伤在升级**：`obj_norm` 是身份函数，算法一改，全库 key 全部失配。AD-5 禁止物理删除、AD-3 禁止用节点 id 当身份，骨架里**没有「重算 key」的迁移路径**——只能整库 supersede 重写（版本链膨胀一倍）或走快照恢复（AD-5 说那是灾难恢复，不是撤销）。
3. 这不是 A/B 分歧本身造成的，而是「一个没有版本号的规范函数」这一设计缺陷；A/B 两种读法只是让它在 M1 之前就暴露。

### 哪条 AD 缺失或太松

AD-3 没有把 `obj_norm` 钉成「代码里唯一的导出函数 + 版本号」，也没有算法变更的迁移条款；设计稿的规范化配方**没有进骨架**，因此对实现无约束力。

### 补法（一句话）

AD-3 增加「`obj_norm` 只能由 `core/normalize.ts` 的单一导出函数产生，算法编号写入每个 assertion 的 `norm_version`；`norm_version` 变更必须走 `ops/` 迁移（重算 key + 同事务 supersede 旧节点），禁止原地改 `obj_norm`」，并把五步配方从设计稿提升进 AD-3 正文。

---

## F3 · 撤销的「逐条一致」没有定义比较域，且 AD-22 自我否决

**严重度：高｜AD-22、AD-21、AD-9**

### 场景

dream 自动裁决一次（AD-9 的唯一自动档）：北京 `superseded` + 上海 `insert` + `flag(resolved_auto)` + `contradicts` 边 + `decision(arbitrate)`。30 天后用户在该 flag 上点「撤销」。

### 单元 A 的做法

`affected[]` 只记业务对象——两条 assertion 的 `mem_key` + 那条 `contradicts` 边。撤销时反向补丁 = 撤销上海这条、恢复北京、去边；flag 保留 `resolved_auto`（认为它是审计物，不是业务物）；`decision` 追加一条 revert。

合规：AD-22 只说「受影响的 `mem_key` 集合 + 受影响的边」，没定义 flag 算不算受影响对象。

### 单元 B 的做法

`affected[]` 记**该事务写入的全部节点与边**，含 flag 节点与 evidence 的 `supports` 边。撤销时把 flag 也置 `superseded_at`（认为「已解决的矛盾」这个记录在矛盾被撤销后不成立；改回 `open` 更错，会重新进待处理队列）。

也合规：AD-22 没有说闭包要排除谁。

### 接起来会怎样

1. **A 的库**：撤销后 `kind=flag ∧ status=open` 为 0（对），但那条 `resolved_auto` flag 仍指向一条已被移除的 `contradicts` 边 → 治理视图点进去悬空（悬空边不是节点，AD-22 没有 flag 悬空的兜底条款）。「默认查询逐条一致」在 `kind=flag` 上不成立：操作前根本没有这个 flag。
2. **B 的库**：flag 消失了，`kind=flag` 与操作前一致；但 `decision` 账本里 `kind=arbitrate` 那行的 `to` 指向一个已 supersede 的 flag，AD-21「decision 只增、不改、不删」使它**永远无法修正**。
3. **决定性的一处——AD-22 自我否决**：它自己要求撤销时「追加一条 `decision(kind=revert, precedent_id=原 op_id)`」，同时要求「撤销之后再查，默认查询与召回结果必须与操作前逐条一致」。若「默认查询」包含 `kind=decision`（它是骨架 :265 的权威 kind），那么**任何撤销都不可能一致**。骨架没有说比较域是哪些 kind，也没有给 AD-21 与 AD-22 的优先级。

### 哪条 AD 缺失或太松

AD-22 的 `affected[]` 没有闭包定义（谁必须进、谁必须不进）；「逐条一致」没有说比较哪些查询、比到什么粒度（节点集合？字段？召回顺序？）；AD-21 与 AD-22 在 decision 上直接打架，没有优先级条款。

### 补法（一句话）

AD-22 写死「`affected[]` 闭包 = 该事务写入/修改的全部节点（含 flag）的 `mem_key` + 全部边，`decision` 与 `rejected` 除外（账本只增）；一致性比较域 = `kind ∈ {assertion, pref, scene, episode}` 的默认查询结果 + 召回 topK（按 `mem_key` 集合比对，不比顺序），flag 只比 `status` 集合，decision 只校验新增恰好一条 `kind=revert`」。

---

## F4 · 「3s 去抖」的作用域、饥饿与「本轮」的边界

**严重度：高｜AD-4（与 AD-6 联动）**

### 场景

同一 profile 两个会话。S1 说完，1.2s 后用户在 S2 说一句。S1 那轮模型调了 3 次工具；其中一次 turn-stopping 上另一个 listener steer 了一句，宿主因此在同一 turn 内再次触发 turn-stopping。

**已核对事实**（DSH 0.2.2-rc.5 类型定义）：`agent/turn-stopping` 的 payload 只有 `{agent, turn, signal}`，`@mode serial`，且在边界提交前被 await；文档明确 listener 若 steer，机器重读 inbox 再跑一步——**同一 `turn` 会触发多次 turn-stopping**，payload 里既没有 `session_id` 也没有 `seq`。

### 单元 A 的做法

3s 是模块级**全局** timer，任何会话的 turn-stopping 都重置它；到期后按「自上次抽取以来的全局 seq 增量」一次抽取，跨会话合并成一次 LLM 调用（省 token，也贴合设计稿「一轮一次抽取调用」）。

合规：AD-4 只说「默认 3s 去抖」，没说是全局还是每会话。

### 单元 B 的做法

3s **按 session 隔离**，每个会话一个 timer；只抽该会话的 seq 增量；同一 turn 的第二次 turn-stopping 只取增量。

也合规：AD-4 的「抽取只读本轮新增的 seq 区间」可以被读成「本会话本轮」。

### 接起来会怎样

1. **A 合并 S1+S2**：抽出的每条 assertion 只能挂一个 `evidence{session_id, seq_from, seq_to}`（AD-6 规定为单会话单区间）。要么丢一条证据，要么写出跨两个 session 的区间——后者字面不违规，但指针回读必然错（跨会话的 seq 区间里混着另一个会话的消息）。AD-6 的兜底是「指向不存在的 seq 挂 `flag(dangling_evidence)`」，而这里是**指向存在但不该在区间里的 seq**，兜底不触发。
2. **A 的「区间」退化成「集合」**：全局 seq 在并发会话下会被对方插入，S1 的本轮新增不连续，AD-4 的「区间」一词必须被改写才能实现。
3. **B 的 trailing-only 去抖会饥饿**：若某会话每 2.8s 说一句，timer 永不触发，整段记忆要等会话空闲才落库。AD-4 没有 max-wait。
4. **两者都会在重载时丢未提交的抽取**（按 AD-1，`ctx.timer` / `ctx.effect` 随 fiber 回收）；丢多少、算不算「错过不补做」（AD-10 只对 dream 说了这句），没有规定。

### 哪条 AD 缺失或太松

AD-4 的「默认 3s 去抖」没有作用域、没有 max-wait、没有「本轮」的定义（turn 号？两次 turn-stopping 之间？本会话？），也没有与 AD-6 单会话 evidence 的对齐条款。

### 补法（一句话）

AD-4 改写为「去抖按 `session_id` 隔离；触发条件 = 该会话连续 3s 无新 turn-stopping，且距上次成功抽取超过 30s 时强制触发（max-wait）；抽取区间 = 该会话自上次成功提交以来连续同会话的 seq 段，若中间夹入其它会话的 seq 则按连续段拆成多次抽取，禁止跨会话合并；同一 `turn` 的重复触发只取增量 seq，并把 `turn` 号写进审计行」。

---

## F5 · dream ② 的种子、锚点集能否重算，以及 `importance`/`surprise` 没有定义

**严重度：中｜AD-10**

### 场景

夜间 ②③④ 跑完 ③ 后进程被杀；02:40 用户又聊了 20 轮；次日 00:10 重启续跑。另有 I5「dry-run 两次 diff 为空」。

### 单元 A 的做法

`seed = hash(cycle_date)`，PRNG 算法固定；② 的锚点集与每条 `importance`/`surprise` 写入 `dream_log(step=2)`；③ 续跑**只读**该记录，绝不重算。

合规：AD-10 只说 `dream_log` 带「阶段、种子、diff、tokens」。

### 单元 B 的做法

`seed = hash(cycle_date, last_committed_seq)`（理由：幂等应针对「同一库状态」，只按日期定种子会让变化后的库复用同一随机序列）；③ 续跑**重算** ②（② 不调 LLM、确定性、便宜；AD-10 只禁止 ①②⑥ 调 LLM，没禁止重算）。

也合规。

### 接起来会怎样

1. **B 续跑时库已变**（02:40 那 20 轮），重算的锚点集 ≠ `dream_log(step=2).diff` 记录的那一组 → ④ 产出的 scene 的 `derived_from` 指向锚点集 B，账本记的是 A → AD-21 的「这条从哪来」答错。而这正是 AD-10 用「每步一条 dream_log」想换来的能力。
2. **A 的 seed 确定但不可复现**：没记录 PRNG 算法、没记录输入快照（哪些节点参与排序），拿 seed + date 复算得不到同一锚点集。
3. **两个因子在骨架与 schema 里都不存在**：payload 里既无 `importance` 也无 `surprise`，AD-8 又禁止把读时排序因子写回。于是 A 取「近 30 天 audit 召回命中次数」与「1 − 与最近 scene 的余弦相似度」；B 取「evidence 条数」与「contradicts 边数 / 邻居数」。两种都合规，同一天同库跑出完全不同的锚点集，且 `dream_log` 不记录用了哪种口径。

### 哪条 AD 缺失或太松

AD-10 只说「② 重放抽样」与「dream_log 带种子」，没有钉死种子的输入、PRNG、锚点集是否可重算；`importance`/`surprise` 这两个 ② 的必要输入在骨架与 schema 里都不存在。

### 补法（一句话）

AD-10 增加「② 的输入固定为 `seed = sha256(cycle_date | last_committed_seq | sampler_version)`，PRNG 算法写进 AD-10；`importance`/`surprise` 的计算式与 `sampler_version` 落在 `store/schema.ts` 并在 AD-10 指名，实现不得自选；② 的产物（锚点 `mem_key` 列表 + 每条 importance/surprise + sampler_version）持久化在 `dream_log(step=2)`，③ 续跑只读、禁止重算，不一致即置 `dream_truncated`」。

---

## F6 · 三层预算没有统一单位、没有记账粒度、也没有叠加规则

**严重度：中｜AD-7、AD-10、AD-20**

### 场景

一轮注入 = 身份段 1200 汉字 + 状态尾巴 28 token + 召回 5 条（约 800 token）。当晚 dream ③ 已用 12k token，日上限 30k。

### 歧义 1 · 单位（A 与 B 各取一端）

AD-7 给身份段用**字符**（≤1200 字符），给状态尾巴用 **token**（≤30 token）；AD-20 的审计行同时记 `chars` 与 `tokens`。谁把字符折成 token、用什么折算率，没有规定。

宿主机侧可用的只有：`ContextBreakdownProjection.systemTokens`（dsh-token-meter 文档自称按固定密度估算、**系统性低估 CJK**）与 `pressureTokens`（要等 provider 回报，即注入**之后**才有）。

- **A**：用宿主密度估算，把 1200 汉字算成约 700 token，按 token 预算裁。
- **B**：用 1 汉字 = 1 token 的保守上界（1200 token），按字符预算裁。

同一段 `persona.md` 在 A 下不用裁、在 B 下要裁掉四成——两边都合规，两边的审计行 `tokens` 也不可比。

### 歧义 2 · 粒度

「每次注入写一行」里的「一次」是每次注入还是每档：

- **A**：写 3 行（identity / status / recall），`tier` 各一。
- **B**：写 1 行（`tier='injection'`，items 内嵌三档）。

后果：I3「用审计行重算 tokens 与预算表比对」在两种粒度下要不同聚合，跨单元汇总必错；`prefix_unchanged` 被 A 记 3 次、B 记 1 次，前缀缓存命中率的代理指标直接差 3 倍。

**更根本的一处**：召回由工具返回（C4 时序：composer 注入身份+状态，召回走工具返回），composer **无法裁**它。AD-7 的「按 身份 > 状态 > 召回 顺序裁剪」实际只有两档可执行，预算表声称持有的总量没人真正持有。

### 歧义 3 · 叠加

AD-10 同时有「模型步骤按段计 token 预算」「日 token 上限」「上限命中即停在段边界」：

- **A**：日预算按步骤均分（30k / 4 = 7.5k 每段），命中即停在该段边界、后续步骤不跑。
- **B**：每段独立配额（③ 12k / ④ 8k / ⑧ 4k），日上限只作总额兜底，前段结余可挪用。

同一天同库，A 在 ③ 就截断，B 能跑完 ④。

而且 B 的读法暴露出这句话**自相矛盾**：日上限在 ③ 段中途命中时，要「停在段边界」就得跑完当前段（超硬上限），要「硬上限」就得段内截断（不在段边界）。`dream_truncated` 在两种读法下分别是「后续步骤未跑」与「当前步半途」，一个 flag 两种含义。

### 哪条 AD 缺失或太松

AD-7 混用两种单位且没指定计数器；AD-20 的 `tier` 是单数却没定义行粒度，也没要求各档之和等于总行；AD-10 的三种预算没有优先级，`dream_truncated` 没有原因区分。

### 补法（一句话）

AD-7 统一为 token 并指定唯一计数函数（`core/tokens.ts`，用宿主同一密度估算器，对 CJK 另加 1.5× 安全系数），字符上限降级为二次护栏；AD-20 改为「每次注入一行 `tier='injection'`，`breakdown[]` 内嵌三档 `{tier, chars, tokens}` 且之和等于该行 `tokens`」；AD-10 改为「`dream_budget = {daily, per_step{③,④,⑤,⑧}}`，步骤启动前检查 `remaining_daily ≥ per_step[step]`，不足则整段不启动并置 `dream_truncated{reason='daily_exhausted', next_step}`，段内超 `per_step` 则截断并置 `reason='step_budget'`」。

---

## 附录 A · 字面不可同时满足：`tqlMut` 的辖区互斥

**严重度：中｜AD-4、AD-15**

这不是「两种解释」，是**没有实现能同时满足两条 AD 的字面**：

- AD-4（:65）：「`insert` / `updatePayload` / `upsertEdge` / `commitTransaction` / `tqlMut` 只允许出现在 `src/store/`」
- AD-15（:131）：「`tql(` / `tqlMut(` 只允许出现在 `src/ops/`」

`tqlMut` 被要求同时只在 store、只在 ops。单元 A 服从 AD-4 → AD-15 的 CI grep 必挂；单元 B 服从 AD-15 → AD-4 必挂。同族第二处：`commitTransaction` 在 AD-4 允许 `src/store/` 全域，在 AD-15 只允许 `src/store/commits`——把它放在 `src/store/schema.ts` 是 AD-4 合规、AD-15 违规。

### 补法（一句话）

AD-4 的写入口清单删掉 `tqlMut`（另起一句「`tql`/`tqlMut` 仅 `src/ops/`」），AD-4 的 `src/store/` 收窄为 `src/store/commits/`，与 AD-15 的 grep 清单逐字一致。

---

## 未证实清单

1. triviumdb `createUniqueCompositeIndex` 是否支持部分索引、缺失字段是否按 null 参与唯一性——仓库未安装依赖，未能核对 d.ts。F1 的两种实现因此都以「AD 没写索引成分」为前提，不依赖该 API 的具体行为。
2. 宿主是否暴露可用的 tokenizer——DSH 包内 grep `countTokens|Tokenizer` 零命中，只有 dsh-token-meter 的启发式投影；F6 的「唯一计数函数」按此写，provider 侧是否有更准的计数未证实。
3. 「另一个会话并发写入会让全局 seq 交错」——基于 C4 的单文件库单写者与 seq 全局追加的读法；未实测。F4 的跨会话合并问题不依赖这一条（AD-6 的单会话 evidence 已足以证成）。

## 不在本评审范围

风格、措辞、篇幅、AD 编号顺序、图的可读性、里程碑与闸门设置。
