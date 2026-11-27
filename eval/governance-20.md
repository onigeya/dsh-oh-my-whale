# 治理三问 20 条（SM-2 记录）

> 这份文件是 **SM-2 可治理性的记录**，不是设计文档。它定义「哪 20 条记忆、要答出哪几个问题、字段齐到什么程度算齐」，
> 并在每次运行后追加结果。上游判据：`acceptance.md:15`（SM-2）、`epics.md:723-725`（Story 3.1）、`epics.md:2232`（Epic 3 前置）。
>
> **状态：定义已冻结，尚未运行。** `/omw-explain` 属 Story 3.1（`src/seams/commands.ts:400` 现注册为「未实现」），
> 评测驱动 `scripts/eval.ts` 属 Story 4.4。在此之前本文件第五节保持为空——**空的运行表比编造的结果诚实**。

## 一、三个问题分别由什么回答

`FR-11`（`requirements.md:113-117`）把治理三问拆成三条各自独立的数据来源。这不是措辞上的三句话，是三种读：

| 问题 | 来源 | 必须出现的字段 |
| --- | --- | --- |
| **谁改的** | 决策账本 | `actor`（`user`/`model`/`seed`/`system`）、`ts` |
| **依据什么** | 证据指针 | `session_id`、`seq_from`–`seq_to`、`quote`（≤200 字符），以及 `quote_truncated`、`deidentified` 两个自曝标记 |
| **为什么** | 决策账本 | `kind`（`insert`/`supersede`/`arbitrate`/`resolve_flag`/`migrate`/`revert`）、`reason`、`precedent_id?` |

三次读共用一个账本条目，所以一条答案里还有四个「结构性」字段必须在：`op_id`、`affected[]`、`target_mem_key`、`contract_version`。
八个必需键加 `from`/`to` 视改动形态出现，合计「AC③ 的十个键」（`spec-2-3-version-chain.md:63`）；`precedent_id` 可选。

## 二、运行协议

判据不是「能答」，是「**在这个条件下、用这个时限、答到这么齐**」。条件写在下面，缺一条这次运行就不算数。

| 项 | 值 | 出处 |
| --- | --- | --- |
| 库规模 | **1000 条记忆**（20 条 fixture + 980 条合成填充） | `epics.md:719-721` 要求「1000 条记忆的库」下 ≤30 秒 |
| 查询方式 | 逐条执行 `/omw-explain <mem_key>`，不用关键词形式 | Story 3.1 AC①；FR-23 |
| 计时口径 | 从「执行命令」到「三个答案出现在消息文本里」，含人工阅读时间 | `FR-23`（`requirements.md:148`） |
| 单条上限 | ≤30 秒 | SM-2 |
| 及格线 | **20/20**——一条超时或一个必需字段缺失即该条不通过，不设「大部分通过」 | SM-2 |
| 写入副作用 | 每轮前后比对库内节点字节与审计行，**必须零写入**（不更新热度、不动 `recorded_at`） | Story 3.1 AC⑦、FR-4 |
| 降级行为 | 任一条读不出必需字段时，该条按 `E_DEGRADED` 计失败，不得静默补默认值 | `spec-2-3-version-chain.md:63` |
| 结果落点 | 本文件第五节 | `epics.md:725` |

人工判定只做一件事：读 `expected.sample_answer` 与机器输出，判**读得懂吗**。不判「查得到吗」——那是机械判据的事。
口径见 `eval/rubric.md` 第一、二节。

## 三、20 条的总表

| ID | 组 | `mem_key` | 末条账本 | 证据 | 标记 | 这条钉住什么 |
| --- | --- | --- | --- | --- | --- | --- |
| G20-01 | A | `assertion:Elliott:lives_in` | `insert` | 1 条 | — | 最简形态：三问全部由同一条 insert 账本与同一条证据回答。这条答不全，其余 19 条不必测。 |
| G20-02 | A | `assertion:Elliott:works_at` | `supersede` | 2 条（独立来源 2） | — | 版本链有两段、账本有两条。「谁改的」取末一条，「依据什么」取最新那条证据，不能退回旧证据。 |
| G20-03 | A | `assertion:Elliott:timezone` | `supersede` | 3 条（独立来源 3） | — | 链长三段的读取：三版都要在、active 只有一版、每条 valid_to 与下一版的 valid_from 接得上。 |
| G20-04 | A | `assertion:Elliott:likes:手冲咖啡` | `revert` | 1 条 | — | Story 3.4 的 AC：撤销完成后 explain 仍看得到那条撤销账本与它的 op_id。撤销用 precedent_id 指回被撤销的 op。 |
| G20-05 | A | `assertion:Elliott:birthday` | `migrate` | 1 条，脱敏 | migration / resolved / human | actor 只取 user/model/seed/system；「迁移」是 cause，不是 actor。迁移完成后一条已解决 migration 标记留痕。 |
| G20-06 | A | `assertion:Elliott:likes:纪录片` | `insert` | 1 条 | — | AD-22 的撤销闭包：一次 op 的影响面写不全，撤销就会漏。六个受影响的业务键必须全部出现在 affected[]。 |
| G20-07 | B | `assertion:Elliott:prefers_tone` | `arbitrate` | 2 条（独立来源 2） | contradiction / resolved / auto | FR-12 唯一会改数据的一档。四个对象（旧断言、新断言、flag、两条 contradicts 有向边计两条）必须全在 affected[] 里，否则撤销按 op_id 重放就缺件。 |
| G20-08 | B | `assertion:Elliott:knows:小林` | `resolve_flag` | 1 条 | contradiction / resolved / human | 人工解除是唯一解除路径（多值谓词不可自动裁决）。引用先例时 precedent_id 必须出现，否则「为什么」答不出「依据哪次决定」。 |
| G20-09 | B | `assertion:Elliott:avoids_topic:体检` | `insert` | 1 条 | contradiction / open | 挂起档的判据：数据一个字段都没动，账本停在 insert。若这里出现一条新账本，说明「提案」偷偷改了库。 |
| G20-10 | B | `assertion:Elliott:likes:冬天跑步` | `resolve_flag` | 1 条 | refuted / resolved / human | FR-14：证伪不删除。这条记忆仍可 explain，且「为什么」必须答出是人工确认的证伪，不是模型自己改的。 |
| G20-11 | B | `assertion:Elliott:likes:黑咖啡` | `supersede` | 1 条 | — | AD-5：遗忘走软删除 + tombstone。库里节点还在，explain 必须仍能答出三问，而不是返回 NOT_FOUND。 |
| G20-12 | C | `assertion:Elliott:dislikes:香菜` | `insert` | 1 条 | — | C 组的基准形态。其余四条（截断/脱敏/多源/过期）都靠与这条对照才读得出差别。 |
| G20-13 | C | `assertion:Elliott:knows:阿城` | `insert` | 1 条 | — | evidence.quote ≤200 字符，quote_truncated 为真。答案不能把截断的引文当成完整原文朗读——那是把裁剪当成事实。 |
| G20-14 | C | `assertion:Elliott:dislikes:熬夜` | `insert` | 1 条，脱敏 | — | FR-24：默认档既不含引文也不含节点 id；脱敏标记必须可读，否则用户会以为看到的是原文。 |
| G20-15 | C | `assertion:Elliott:likes:猫` | `insert` | 2 条（独立来源 2） | — | source_independence 按 session_id 去重后为 2。只报一条会低估，把两条算成同一来源会高估——两头都要能看出来。 |
| G20-16 | C | `assertion:Elliott:likes:雨天` | `insert` | 1 条，过期 | — | FR-22：lookback ≤30 天，超出部分标 evidence-expired。三问仍要答，但「依据什么」必须自曝这条证据已不可回读原文。 |
| G20-17 | D | `assertion:Elliott:knows:老周` | `insert` | 1 条 | — | AD-17：origin=inference 必带 falsifier 与 settle_state。缺判别式的推断不得进断言层——这里是它被允许存在的完整形态。 |
| G20-18 | D | `assertion:Elliott:likes:早睡` | `supersede` | 1 条 | — | 推断从「未定」变成「已确认」也是改动，必须有账本与 from/to。凭空把结算状态刷成已确认，等于绕过治理面。 |
| G20-19 | D | `pred:lives_in` | `supersede` | 无（谓词节点无证据） | — | AD-9 的自动裁决依赖「有人声明过的 single」。谁声明的、什么时候、为什么，必须答得出来，否则自动档的合法性无法回溯。 |
| G20-20 | D | `assertion:Elliott:likes:山` | `insert` | 3 条（独立来源 3） | — | FR-34 的两头核：重复命中不新建断言、不改内容、不写账本，但追加 evidence 边。三问里「为什么」保持单数，「依据什么」变成复数源。 |

组别：`A` 写入与版本链（6 条）、`B` 裁决与标态（5 条）、`C` 证据形态（5 条）、`D` 推断与谓词（4 条）。

逐条的完整定义（版本链、账本、证据、期望答案）在 `test/fixtures/governance-20.jsonl`——**那里是唯一事实来源**，
本节的表格与它的一致性由 `test/eval/governance-20.test.ts` 强制。

## 四、为什么是这 20 条

抽样的原则不是「凑满 20」，是**让每一种会改变三问答案的形态至少出现一次**。四组的分工：

- **A 组（01–06）问的是「答案会不会被后来的改动带跑」**。单版本 vs 两段链 vs 三段链 vs 被撤销 vs 被迁移，
  四者的「谁改的」都指向不同位置：01 是最新也是唯一，03 是最新但链上还有两段，04 是**目标已失效**但账本必须仍在。
- **B 组（07–11）问的是「标态会不会污染答案」**。自动裁决（07）要能看出四个对象一起动过；人工解除（08）要带先例；
  仍挂起（09）**不能**因为有一条 open flag 就凭空长出一条账本；证伪（10）要证明「不删除」；遗忘（11）要证明软删后还答得出。
- **C 组（12–16）问的是「依据一栏会不会撒谎」**。截断的引文被当成完整原文朗读、脱敏的文本被当成原话、
  过期的指针被当成还能回读——这三种都是「答了但答错」，比不答更糟。
- **D 组（17–20）问的是「推断与重复会不会被算成观测」**。未结算（17）与已结算（18）的区别必须落在账本上；
  谓词（19）证明非断言节点也是合法目标；重复陈述（20）证明「为什么」保持单数而「依据什么」变成复数。

## 五、运行结果

| 运行日期 | 库规模 | 通过 | 最慢一条 | 失败条目 | 记录人 |
| --- | --- | --- | --- | --- | --- |
| _（未运行）_ | — | — | — | — | — |

每次运行按上面的格式追加一行，失败条目要写具体是哪一条、哪个字段缺、耗时多少。
**不允许只写「20/20 通过」**——没有失败记录的满分报告，和没有跑过一样不可核。