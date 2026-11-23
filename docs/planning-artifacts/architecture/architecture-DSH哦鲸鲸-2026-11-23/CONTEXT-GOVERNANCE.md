---
name: '上下文治理模块（CAP-6）'
type: design
purpose: capability-design
altitude: initiative
paradigm: '阶梯式折叠 + 模型选段 / 代码守门 + 决策账本'
capability: CAP-6
status: draft-for-review
created: '2026-11-23'
updated: '2026-11-23'
binds: [CAP-1, CAP-4, CAP-6]
sources:
  - docs/planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/ARCHITECTURE-SPINE.md
  - docs/planning-artifacts/research/technical-context-governance-2026-11-23/research.md
  - docs/specs/spec-DSH哦鲸鲸/SPEC.md
companions:
  - docs/planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/ARCHITECTURE-SPINE.md
---

# 上下文治理模块设计（CAP-6）

## 0. 一句话

**把「上下文快满了」从一个需要紧急处理的事故，变成一件有账可查、可撤销、且从不替用户做决定的日常记账。**

三个参照实现各自证明了一半：weave 证明摘要必须被审计（否则丢的是要求），argp 证明大部分膨胀根本不需要模型（否则每次都在给缓存挖坑），billion-context 证明决定权应交给模型（否则模型对任务状态是盲的）。本设计把三者拼成一条**四级阶梯**，并把「谁守哪道门」写成不变量。

## 1. 为什么这是一个独立能力，而不是 AD-7 的延伸

AD-7 管的是「往系统提示里放什么」，AD-20 管的是「放了多少、有没有变慢」。两者都只覆盖**注入**，不覆盖**历史**。

历史侧今天由宿主自带的 `@deepseek-ai/dsh-compaction-basic` 决定，它是阈值触发的整体摘要：模型不参与、不能拒绝、整段压成一个不透明块。对我们这个定位（长期在场、记得事情、有分寸）有三处硬冲突：

1. **人格冲突**：一个从不询问就改写历史的同伴，不像同伴。用户第四轮裁定身份段只留 1200 字符 + 30 token 尾巴，正是为了「记忆是帮助而不是表演」——那么历史的处置也应遵循同一分寸：能问就问，能留指针就留指针。
2. **证据冲突**：记忆库的每条断言都靠 `{session_id, seq_from, seq_to}` 回指原文（AD-6）。如果压缩把原文变成一段不可寻址的散文，证据链就断在这里——不是记忆模块能补救的。
3. **成本冲突**：阈值式整体摘要是 O(历史) 操作，每轮重摘要同一段内容，前缀缓存必然被打断（weave 与 bili 的实测都把这一点当成首要矛盾）。我们要的是 O(增量)。

所以它需要自己的不变量、自己的降级、自己的闸门。它是一个能力（CAP-6），不是一个函数。

## 2. 立场：三条定律

### 定律一：只折已消费的增量

折叠对象不是「旧内容」，是「本任务已经用完的材料」。判据是任务阶段，不是年龄。一个开场就给出、全程有效的约束，哪怕在第一轮，也永远不在折叠面；一段刚跑完、结论已提取的构建日志，哪怕在上一轮，也可以折。

直接后果：每段内容一生只被折一次，之后作为不动的摘要常驻；留存率停在 ρ₁ 而不是 ρ^k 衰减到零（billion-context 论文 §4.2 的论证）。这也是成本从 O(历史) 变成 O(增量) 的唯一来源。

### 定律二：模型选段，代码守门

模型擅长判断「这段还需要吗」，不擅长保证「约束没丢」「数字没改」「授权是真的」「折完确实变小了」。所以分工是硬的：

| 决定 | 谁做 | 为什么 |
| --- | --- | --- |
| 折哪一段、折几段 | 模型 | 只有它知道当前任务走到哪一步 |
| 折完是否严格变小 | 代码 | 可计算，且反例代价高（越压越大） |
| 用户约束是否仍在 | 代码 | 账本 + 覆盖/极性核对，可判定 |
| 指针是否可解析 | 代码 | seq 语法 + 存在性，可判定 |
| 能否撤销 | 代码 | op_id + affected 闭包 |
| 要不要现在折 | 门控 + 模型 | 门控给下限，模型有拒绝权 |

这条分工同时否定了两种极端：weave 让代码替模型写正文（它其实没有，但审计规则厚到接近重写），bili 让模型对结构负责（它其实没有，内核守了 filter 与 prune）。

### 定律三：折叠是记账，不是遗忘

每次折叠在我们的语义里是一次 `decision`（AD-21）：有 op_id、有 affected 闭包、有理由、可整体撤销（AD-22）。「看不见」与「不存在」必须是两件事——这正是整个项目的第一性要求（AD-5 的软删除、AD-6 的证据指针、AD-22 的撤销），上下文治理没有理由例外。

## 3. 不变量（AD-28 … AD-41）

编号接续骨架的 AD-27，永不复用。每条都写明它防的是什么。

### AD-28 — 可见历史只有一个写者 [ADOPTED]

- **Binds:** CAP-6, govern/
- **Prevents:** 记忆、人格、抽取各自动一次表面，最后没人说得清某条消息为什么不见了；也防止两个模块各自实现「替换区间」而互相覆盖。
- **Rule:** 对宿主可见历史的改写（`surfaceOp: {op:'replace'}` / 等价 API）只允许出现在 `src/govern/commits.ts`；其它层只读。静态门（AD-15 的同款机制）用 AST 规则钉死：`surfaceOp` 对象里的 `op: 'replace'` 字面量只允许出现在该文件；规则挂在对象属性上而不是裸文本上，避免误伤 `Map.replace` 一类同名调用。记忆模块从不改写历史——它只写库。

### AD-29 — 模型选段，代码守门 [ADOPTED]

- **Binds:** CAP-6
- **Prevents:** 让模型决定「删谁」而造成的不可复算损失；也防止代码用阈值替模型选段，退回 bili 批判的「模型不感知、无法拒绝」三缺陷。
- **Rule:** 折叠的**选区**必须来自模型对推荐列表的选择（列表由代码给出，含每段的真实尺寸：tokens、消息数、tool/text 构成）；**接受与否**由代码判定，判据封闭为五条：工具调用与结果成对、保护区未被触碰、严格缩小成立、要求账本核对通过、指针可解析。任何一条不成立即拒绝，拒绝写审计行 `fold_rejected`，**不重试、不改写模型的选择**。模型返回「拒绝折叠」是合法结果，记 `fold_declined`，不是错误。

### AD-30 — 折叠必可逆且必须有指针 [ADOPTED]

- **Binds:** CAP-6, store/
- **Prevents:** 折完只剩一段散文，原文再也找不到；以及「可逆」停留在文档里而没有任何可执行路径。
- **Rule:** 每个 `fold` 节点必带 `{session_id, seq_from, seq_to}`，且该区间必须满足 G0-3 已验证的性质——压缩后 `ctx.sessionQuery.readEvent({sessionId, seq})` 仍能取回原文。展开（`context_expand`）只做两件事：把该区间的 `surface` 从 `shadowed` 恢复为 `current`，并把 `fold.status` 置 `expanded`；**不复制、不重写、不移动原文**。指针不可解析时（provider 缺席、seq 缺号）该块标 `degraded: 'evidence-unresolvable'`，仍可读摘要，但不得声称可展开。
- **证据：** G0-3 已实测两个真实会话（609 / 1377 事件，seq 连续缺号 0），压缩后回读通过。这条不变量不是设想，是既有闸门的直接推论。

### AD-31 — 要求账本零丢失，且以阻断而非降级处理 [ADOPTED]

- **Binds:** CAP-6, govern/
- **Prevents:** 摘要模型把「不要动 X」写成「可以动 X」，或干脆忘掉一条禁止事项——这是上下文压缩唯一真正不可接受的失败，因为它把成本转移给了用户。
- **Rule:** 会话维护一份 `req_ledger:<session_id>`（会话级、随会话结束失效），由**确定性提取器**从真实用户消息中抽取，条目形如 `{seq, kind: goal|constraint|prohibition|authorization|scope, text_norm, status: active|retired|superseded, source_seq}`。折叠时：账本条目由引擎**逐字填入**检查点第 2 节，模型不得改写该节；折叠后对账本做覆盖核对（规范化后逐条子串/分词命中）与极性核对（否定词、上下限、方向、作用域），任一 `active` 条目丢失即 `fold_blocked`，历史保持不变。撤销/替代的条目（`retired` / `superseded`）必须连同撤销指令一起剔除，防止废弃约束复燃（`RETIRED_REINTRODUCED`，同 weave 的 `RETIRED_MEMORY_REINTRODUCED`）。账本本身不可由模型写：模型只能通过用户消息改变它。

### AD-32 — 严格缩小：tokens 与规范化字节都要小 [ADOPTED]

- **Binds:** CAP-6
- **Prevents:** 「压缩」把 8K 的消息折成 9K 的检查点——加了原话、指针、账本之后，反膨胀是完全现实的结果。
- **Rule:** 接受条件为 `after_tokens < before_tokens` **且** `after_canonical_bytes < before_canonical_bytes`（规范化 UTF-8，行尾统一 `\n`、去尾随空白）。任一不成立即 `SUMMARY_NOT_SMALLER`，先尝试去掉可选的指针文件清单，再尝试省略指针行，仍不成立则拒绝。这条是 weave §5.1 的直接采用——它的价值不在精巧，在于它是**唯一一条不需要模型配合就能挡住反膨胀的规则**。

### AD-33 — 只折增量，前缀不重写 [ADOPTED]

- **Binds:** CAP-6, seams/
- **Prevents:** 每次折叠都改写整段历史，导致服务商 KV 缓存全量失效、命中率从 97% 掉到 0；也防止「折完还要再折一次刚才折过的东西」的抖动。
- **Rule:** 折叠区间必须整体位于「最近一个仍然 active 的 fold 之后」；已提交的 fold 块与其之前的消息构成不可改写的保留前缀。只有三种情况允许把旧块一并重折（tier-2，见 AD-35 之外的 L2）：旧块数超过 `govern.maxVisibleBlocks`、旧块内含有已被取代的要求、增量区间去掉新块后不足以释放最小空间。任何折叠提交后记 `prefix_unchanged: true|false` 与宿主的三项缓存计量（`cacheReadTokens` / `cacheWriteTokens` / `uncachedInputTokens`，AD-20 已定义），命中率按会话聚合。

### AD-34 — 触发用增速与阶段边界，不用填充率 [ADOPTED]

- **Binds:** CAP-6, seams/
- **Prevents:** 用「已用 80%」触发——这个数字模型无法用自己的注意力校准，告诉它只会让它锚定在一个错误的安全感上（bili §4 机制 ii）；也防止在半步中间折叠，把正在用的材料抽走。
- **Rule:** 折叠只在三种时机发生：① **增速门**——上下文 ≥ `govern.fillRatioFloor`（默认 0.45）× 声明窗，**且**自上次折叠以来增长 ≥ `govern.growthFloorTokens`（默认 32K）；② **阶段边界**——`agent/turn-stopping` 之后、工具批次结束之后（与 AD-4 的抽取共用同一事件，但各自独立去抖，互不阻塞）；③ **模型申请**——`context_fold` 工具。溢出（上游 400 / `CONTEXT_WINDOW_EXCEEDED`）只解锁 **L0 观测折叠与 L3 应急截断**，不解锁 L1 摘要——撞墙时最该做的不是再花一次模型调用，而是把已经没用的工具输出折掉。nudge 文案只给「可折区间的列表与真实尺寸」，**不给填充百分比**；措辞是效率提示而非溢出警告，明确保留拒绝权。

### AD-35 — 0-LLM 优先：能确定性解决的绝不进模型 [ADOPTED]

- **Binds:** CAP-6, govern/
- **Prevents:** 为了一次读文件产生的 40K 输出去调用摘要模型——花掉的钱、打断的缓存、引入的幻觉风险，全都白花。
- **Rule:** 四级阶梯严格自上而下，前一级达标即停：**L0 观测折叠**（0 LLM：超大工具结果归档为头尾预览、被同路径后续读取取代的旧读取、被后续编辑取代的 diff、同命令族的重复输出，判据全部是已发生事实，判不上的不折）→ **L1 增量检查点**（LLM，唯一有损步骤）→ **L2 代际再蒸馏**（LLM，低频，v2 起）→ **L3 应急截断**（0 LLM，只在上游拒绝后，且只丢预览不丢正文）。L0 单独可用是本设计的硬要求（闸门 G-ctx-6）：关掉模型，长会话也必须不爆窗。

### AD-36 — 降级五档，且与记忆、人格互不牵连 [ADOPTED]

- **Binds:** CAP-6, seams/, ops/
- **Prevents:** 记忆库坏了就没人管上下文，或上下文治理坏了就连人格注入一起停——两个能力的故障率相乘，用户看到的是「插件整体瘫了」。
- **Rule:** 状态封闭为五档，由单一状态机持有，进程内不自愈：

| 档 | 触发 | 行为 |
| --- | --- | --- |
| `full` | 正常 | L0 + L1（+ L2 若已启用） |
| `fold-only` | 摘要 provider 不可用 / 预算耗尽 / 连续 3 次超时熔断 10 分钟 | 只做 L0 确定性折叠；**永不返回空、永不放弃** |
| `ledger-only` | 折叠被连续阻断（账本核对失败 ≥2 次） | 停止自动折叠，保留账本与 `context_status`，等人工确认 |
| `readonly` | 库不可用 / `contract_version` 高于代码 / 配置非法 | 不折叠、不注入折叠块，历史逐字不动；人格照常（AD-11） |
| `recovering` | 存在未恢复的折叠事务 | 阻塞新折叠，先恢复；期间只读 |

与 AD-13 的分工：AD-13 管记忆库故障 → 记忆整体 no-op；本条管上下文治理故障 → 只降自己这一档。两者共用库句柄，但**不得互相回滚**（AD-18 的推广）。

### AD-37 — 检查点不是记忆：单向，且不可逆 [ADOPTED]

- **Binds:** CAP-6, CAP-1, dream/
- **Prevents:** 摘要里的模型幻觉（「用户已同意」「项目用 Rust」）被当成断言写进记忆库，之后再被召回、被固化、被引用——错误获得了证据的外观。这是本项目与三个参照实现在语义上最大的分歧：它们把摘要当上下文，我们把摘要当**给人看的索引**。
- **Rule:** 三个方向的禁令：① 记忆抽取只读 L0 原始日志的 seq 区间，**禁止以 `fold` 节点或其摘要文本作为抽取输入**；② 检查点里的事实只能是「本会话已发生的事」，**禁止把召回结果写进检查点**（否则检查点变成第二份记忆）；③ `fold` 节点不进召回、不进注入、不进 `exportJsonl`、不参与 dream 的任何一步，只有 `context_search` 与治理视图能读它。反过来是允许的：记忆的证据指针指向 seq，而折叠不改 seq——**折叠对记忆模块完全透明**，这是两个模块能共存的结构原因。

### AD-38 — 身份免疫：人格不参与折叠，也不因折叠改变 [ADOPTED]

- **Binds:** CAP-6, CAP-4
- **Prevents:** 折叠顺手把身份段当普通上下文摘要掉（身份段本该随每轮常驻，且字节稳定），或折叠失败时把人格一起带进降级。
- **Rule:** `omw:persona`（section）与 `omw:persona-state`（context）都不是消息，永远不会进入折叠选区——它们在 `systemPrompt` 层，折叠只作用于消息表面。人格影响折叠的唯一通道是**保留优先级**：检查点的 KEEP 规则要求逐字保留用户的显式偏好与边界表达（「不要主动打扰」这类），这与 `assets/persona.md` 的第四段同源，但人格文本本身不进入检查点。折叠前后断言 `sha256(personaText)` 相等（测试 `test/govern/persona-immune.test.ts`），库不可用与折叠失败两种情形都要覆盖。

### AD-39 — 经济性可结算：每折一行，含盈亏平衡 [ADOPTED]

- **Binds:** CAP-6, ops/
- **Prevents:** 「压缩省了 token」变成一句无法证伪的口号；也防止某类会话上折叠长期亏本（摘要成本 + 缓存重付 > 节省）却没人发现。
- **Rule:** 每次折叠写一行审计（只落文件，不落库，按天切分，保留 30 天）：`{ts, session_id, op_id, tier, span, before_tokens, after_tokens, saved_tokens, summary_cost_tokens, prefix_repay_tokens, breakeven_turns, prefix_unchanged, degraded, host_cache_read, host_cache_write, host_uncached}`。其中 `breakeven_turns = ceil((summary_cost_tokens + prefix_repay_tokens) / max(1, saved_tokens))`。`breakeven_turns > govern.breakevenMaxTurns`（默认 20）记 `low_yield`，并把该会话的 `growthFloorTokens` 临时上调 50%（自适应降频，会话结束即失效）。**归因只用自己的计量**：`prefix_repay_tokens` 由相邻两次请求的 `uncached` 差值给出，不引入第二个数字来源。

### AD-40 — 工具面是公开契约 [ADOPTED]

- **Binds:** CAP-6, seams/tools
- **Prevents:** 模型侧契约被两个 epic 各写一遍；也防止工具改名时没人当它是破坏性变更（同 AD-25）。
- **Rule:** 四个工具，入参固定：`context_status()`（只读：占用、可折区间与尺寸、最近折叠、当前降级档）、`context_fold({spans[], reason})`（申请折叠；返回 `queued|folded|blocked|declined`）、`context_expand({block, toFile?})`（恢复区间或写文件，保前缀）、`context_search({query})`（在折叠摘要里检索，返回块与 seq，不含原文）。返回统一包封 `{ok, items?, degraded, reason?}`；错误码在既有封闭集上新增且仅新增 `E_FOLD_BLOCKED`（账本核对失败）与 `E_FOLD_NOT_SMALLER`（严格缩小失败）。新增或改签名必须先改本条。

### AD-41 — 提示词即契约：nudge 文案版本化 [ADOPTED]

- **Binds:** CAP-6
- **Prevents:** 改一句 nudge 措辞就悄悄改变模型的压缩行为，而回归测试看不出差别；也防止模型把 nudge 里的数字（区间 id、尺寸）当作之后轮次仍然成立的事实带下去。
- **Rule:** nudge 与检查点模板同属提示词面，带 `prompt_version` 并写进每个 `fold` 节点；改动必须在 PR 里标 `MODEL-FACING`，并补一条断言「模型可见字符串逐字等于预期」的回执测试。nudge 注入后在被消费的那一轮结束时从上下文移除（宿主 `hide-compress-calls` 语义），不留痕。nudge 里出现的所有数字必须是**本次真实可用**的量，不得出现被截断/钳制后的残留值（模型会把它当锚点带到下一次调用）。

## 4. 结构

```
src/govern/
  l0-observation.ts     # 观测折叠：判据、头尾预览、桩文本（0 LLM）
  l1-checkpoint.ts      # 增量检查点：选区校验、模板装配、引擎填充
  l2-distill.ts         # 代际再蒸馏（v2）
  l3-truncate.ts        # 应急截断（只丢预览）
  ledger.ts             # 要求账本：确定性抽取、覆盖与极性核对
  selector.ts           # 推荐列表：区间、尺寸、保护区、配对
  audit-fold.ts         # 严格缩小、结构核对、账本核对（纯函数，零 IO）
  economics.ts          # breakeven 与自适应降频（纯函数）
  commits.ts            # 唯一写者：surfaceOp replace / 事务 / 恢复
  archive.ts            # fold 节点读写（经 store/，不直连库）
  state.ts              # 五档状态机（单一持有者）
  tools.ts              # context_* 四个工具
```

依赖方向沿用骨架：`core/`（纯规则：audit-fold、economics、ledger 的判定部分）← `govern/`（编排）→ `store/`（fold 节点）；`seams/` 只做宿主适配（事件、工具注册、token 计量），不出现判定逻辑。`govern/` 不 import `dream/`、`persona/`、`gui/`。

新增静态门（并入 AD-15 的清单）：`surfaceOp: { op: 'replace'` 与 `Session.append(` 只允许出现在 `src/govern/commits.ts`；`fold` 节点的写方法只允许出现在 `src/store/`；`nudge` 文案字面量只允许出现在 `src/govern/l1-checkpoint.ts` 的模板常量里。

## 5. 数据模型

复用既有 kind 与账本，不新增「第二套真相」：

| 对象 | 落点 | 形状 | 为什么不新建一类 |
| --- | --- | --- | --- |
| 折叠块 | `fold` 节点（新 kind） | `{session_id, seq_from, seq_to, tier, topic, summary, sections, req_refs[], block_refs[], dropped[], tokens_before/after, bytes_before/after, prompt_version, contract_version, status: active|expanded|superseded}` | 它是上下文状态，不是记忆断言；单独 kind 才能被 AD-37 的三条禁令精准排除 |
| 要求账本 | `req_ledger` 节点（新 kind），每会话一条 | `{session_id, items[], updated_seq, contract_version}` | 会话级、随会话失效；与记忆库的 `pref` 生命周期不同（见 §7） |
| 折叠决策 | 既有 `decision`（AD-21） | `kind=fold`，`op_id`，`affected[]=[fold_key, ...]` | 撤销机制已经存在（AD-22），不必发明 |
| 折叠审计 | 文件 `audit-YYYYMMDD.jsonl` | AD-39 的字段 | 审计只落文件是 AD-20 的既有纪律 |

`mem_key` 用业务身份（AD-3）：`fold:<session_id>:<seq_from>`、`req_ledger:<session_id>`。会话 id 是宿主稳定标识，seq 是宿主单调序号——两者都不依赖节点 id，重建库后仍可对上。

**不需要第二个归档目录。** weave 自建 `history/` 是因为它面向任意宿主、不假设日志可回读；我们的 AD-6 已经把宿主 append-only 日志定为唯一原文源，G0-3 又证明了压缩后 seq 仍可回读。所以折叠的「原文」永远不搬家：库里只存摘要与指针，原文在宿主日志里，由 `ctx.sessionQuery` 按需取回。这是本设计能比参照实现都薄的原因，也是它与记忆模块天然兼容的原因。

## 6. 四级阶梯

### L0 观测折叠（0 LLM）

判据全部是已发生事实，判不上就不折：

| 判据 | 动作 | 反向保护 |
| --- | --- | --- |
| 单条工具结果 > 4000 字符且非报错 | 归档为「头 300 + 尾 300 + 回查指引」 | 报错结果原样保留（错误串本身是 KEEP 类） |
| 同一路径被后续读取/编辑取代 | 旧读取折成一行路径指针 | 被引用过的读取保留（模型可能还在用） |
| 同一命令族重复输出 | 只留最后一次 + 次数 | 输出含唯一标识（哈希、ID）时保留 |
| 被后续编辑取代的 diff | 折成「文件 + 段落」指针 | 该 diff 是当前任务的唯一修改记录时不折 |

L0 的产物是**桩**，不是摘要：`[folded: read D:\src\a.ts → seq 120-140, 18.4K chars]`。桩必须包含足以让人（和模型）决定要不要回查的坐标。

### L1 增量检查点（唯一有损步骤）

六节模板（比 weave 的九节少三节，理由见下）：

```
## 1. 目标          当前任务与成功判据
## 2. 仍然有效的约束  ← 引擎逐字填入要求账本，模型不得改写
## 3. 已完成与已验证 含命令、路径、精确错误串的原文
## 4. 决定与理由     含被否决的路线（保留教训，不保留过程）
## 5. 待办与下一步
## 6. 继续所需       文件路径、标识符、环境细节
[history: seq 120-380 → fold f-0012]
```

砍掉 weave 的「关键技术概念 / 全部用户消息 / 问题解决过程」三节：技术概念由第 6 节按需承载，用户原话转入要求账本（更结构化、可核对），过程叙述与「决定与理由」重复。少三节意味着更小的检查点、更低的摘要成本、更少的幻觉面。

**KEEP / DROP 规则**（写进提示词，`prompt_version` 管版本）：

- KEEP 逐字：带行号的文件路径、承重代码行与签名、精确错误串、带理由的决策、精确数值、目标演化、用户显式偏好与边界。
- DROP：结论已提取的冗长日志、重复读取、保留教训的死胡同、通向结论的过程。
- 预算紧张时的优先级：目标 > 约束 > 决定与理由 > 已完成 > 继续所需。

### L2 代际再蒸馏（v2）

块多了以后按层折块（tier-2），`block_refs` 保留谱系。触发条件三条之一：可见块 > `maxVisibleBlocks`、旧块含已被取代的要求、增量不足以释放最小空间。v1 不实现，但 `fold` 节点从第一天就带 `tier` 与 `block_refs` 字段，避免将来迁移。

### L3 应急截断（0 LLM）

只在上游拒绝（400 / 超窗）后触发，且**只丢 L0 桩与已折叠块的预览文本**，不丢任何未折叠的原文，不丢账本。截断必须写审计并标 `emergency: true`；同一会话 24 小时内超过 3 次即上报 `E_EMERGENCY_REPEAT`，提示用户会话已超出该模型窗口的设计容量。

## 7. 与记忆模块的接口

**唯一的接口是 seq。** 记忆的证据指针（AD-6）指向 `{session_id, seq_from, seq_to}`；折叠不改 seq、不动日志、不改 surface 的 seq 编号。因此：折叠发生前后，记忆模块看到的世界完全一样。这是刻意的——两个模块之间没有调用关系，只有共享的坐标系统。

四条边界规则：

1. **抽取只读 L0**（AD-37 ①）：`agent/turn-stopping` 的去抖抽取读 `sessionQuery` 的 seq 区间，永远不读 `fold` 节点。摘要可能幻觉，抽取不能建立在幻觉上。
2. **召回不回写**（AD-37 ②）：`recall` 的结果作为工具返回进入对话，可能被后续折叠纳入区间——但折叠只把「这次召回发生过」这件事写进检查点，不把召回内容当成事实库里的断言重复一遍。
3. **两种「用户说过的话」分工不同**：记忆的 `pref` 是跨会话、可结算（带 falsifier）的长期偏好；`req_ledger` 是会话级、随会话失效的当前任务约束。**同一句话可以同时进两处，但只有 `pref` 会被 dream 结算、被跨会话召回。** 会话结束时账本不复制进记忆——抽取仍从 L0 读。
4. **冲突不跨模块裁决**：账本说「不要动 X」，记忆说「用户偏好改 X」，两者都不自动覆盖对方。账本只在本次会话内有效；记忆的冲突裁决走 AD-9。跨模块的冲突由用户裁决，不写成自动化规则。

对 dream 的影响：**零**。dream 的八步读 `assertion` / `evidence` / `episode`，不读 `fold`。唯一相关的是 dream 第 ① 步的证据存在性检查——它检查的是 seq 是否存在，而折叠恰好不动 seq。

## 8. 与人格模块的接口

三条：

1. **不参与**：身份段与状态尾巴在 `systemPrompt` 层，不在消息表面，天然不在折叠面（AD-38）。
2. **不影响算法，只影响优先级**：人格第四段（「涉及身体、金钱、关系和重大决定时，先确认再行动」）与 KEEP 规则里的「用户显式偏好与边界」同源。人格改变的是**保留什么**，不是**怎么折**——折叠算法不读取人格文本，避免「人格一改，历史重折」这种不可复现的耦合。
3. **失败隔离**：折叠失败、库不可用、账本阻断，人格段照常注入且字节不变（`test/govern/persona-immune.test.ts` 断言 `sha256` 相等）。「坏掉的是记忆，不是人设」（AD-11）在这里推广为「坏掉的也不是历史」。

## 9. 注入预算（扩展 AD-7 的表）

| 档位 | 内容 | 上限 | 变化频率 | 通道 |
| --- | --- | --- | --- | --- |
| 身份段 | `persona.md` 四段 | 1200 字符 | 几乎不变，字节稳定 | `section`（AD-7） |
| 状态尾巴 | 关系四维、一条偏好、一条 flag | 30 token | 每轮可能变 | `context`（AD-7） |
| 折叠块 | 每个 active 块的可见摘要 | ≤ 3 块，每块 ≤ 900 token | 折叠/展开时 | 消息表面（替换区间） |
| 近期原文区 | 最近交互，折叠保留 | ≥ 窗口 16% | 每轮 | 消息表面（不折） |
| 按需召回 | 候选 → 重排 → 剪枝，≤5 条 | 三段合计 ≤1000ms | 提问时 | 工具返回（AD-8） |

预算冲突时的裁剪顺序：身份 > 状态 > 近期原文 > 折叠块 > 召回。折叠块排在外面的理由：它是**可再生**的（原文在日志里，随时可展开或重折），而近期原文区一旦压掉就无法恢复顺序与措辞。

## 10. 触发与门控（可执行形式）

```
measure := { windowTokens, inputTokens, source: anchored | estimated }

allowL0  := contextOverflow OR anyToolResult.bytes > 4000
allowL1  := source = anchored
        AND inputTokens >= 0.45 * windowTokens
        AND (inputTokens - lastFoldInputTokens) >= growthFloorTokens
        AND queue.empty AND noActiveTurn

floor    := growthFloorTokens * (lowYield ? 1.5 : 1.0)
if materialize(allowL0) meets reductionTarget -> stop        // 不进 L1
else if allowL1 -> propose(spans to model)                   // 模型可拒绝
```

三条纪律：`source != anchored` 时不做任何破坏性改写（估算值驱动改写是 argp §4.2 明确拒绝的）；`noActiveTurn` 保证只在步与步之间动手；`meets reductionTarget` 用**实测**而不是估算（折叠后重新量一次，省了就不必再花一次模型调用——weave §2.1 的做法）。

## 11. 验收与闸门

| 闸门 | 判据 | 不过怎么办 |
| --- | --- | --- |
| G-ctx-1 | 在 3 个真实长会话上，100% 的折叠满足 tokens 与字节双重严格缩小 | 停用 L1，退回只做 L0 |
| G-ctx-2 | 20 条约束的压力集（含否定、上下限、方向、作用域、授权）折叠后零丢失 | 停用自动折叠，只保留 `context_fold` 人工申请 |
| G-ctx-3 | 折叠前后 `prefix_unchanged=true`，会话缓存命中率 ≥90% | 收紧选区（只允许折最新 fold 之后），必要时关闭自动触发 |
| G-ctx-4 | 按 `op_id` 撤销后，默认查询与召回结果逐条等于折叠前 | 折叠不进入 M1，先修撤销 |
| G-ctx-5 | 库不可用 / 折叠失败两种情形下 `sha256(persona)` 不变 | 阻塞发布（人格免疫是硬约束） |
| G-ctx-6 | 关掉摘要模型，10 轮重工具会话不爆窗（只靠 L0） | L0 判据不足，补判据而不是开 L1 |
| G-ctx-7 | 每折一行审计字段齐全，`breakeven_turns` 可复算 | 审计字段缺失即视为未实现 AD-39 |

评测物落在 `eval/context/`：`long-session-3.jsonl`（三个真实会话的事件切片）、`requirement-20.md`（约束压力集与判定口径）、`rubric-context.md`（什么算「没丢」）、`reports/<date>.md`。

## 12. 分期

| 期 | 内容 | 不做什么 |
| --- | --- | --- |
| v1 | L0 + L1 + `context_status` / `context_expand` + 账本 + 五档降级 + 审计 | 不做 L2、不做 nudge 自主申请、不做 `context_search` |
| v2 | L2 代际再蒸馏 + `context_search` + 块谱系 | 不做跨会话的上下文复用 |
| v3 | 模型自主 nudge（推荐列表、拒绝权、经济性自适应降频） | 不做「把上下文写进记忆」的任何路径（AD-37 永久） |

v1 与记忆语义（epic-2）同期，但**独立交付**：它不依赖 `remember` / `recall` 的业务实现，只依赖 `store/` 与 `seams/`。这是刻意的——上下文治理是宿主历史的治理，不是记忆的功能。

## 13. 对骨架的增量（需要合并进 ARCHITECTURE-SPINE 的条目）

| 位置 | 增量 |
| --- | --- |
| Capability → Architecture Map | 新增一行 CAP-6 上下文治理：`govern/`，最硬不变量 AD-28…AD-41，受 AD-15/AD-18/AD-21 约束 |
| Invariants | 追加 AD-28 … AD-41（本文 §3 原文） |
| AD-7 预算表 | 增加「折叠块」一档，裁剪顺序改为 身份 > 状态 > 近期原文 > 折叠块 > 召回 |
| AD-15 静态门 | 追加三条：`surfaceOp replace`/`Session.append` 仅 `govern/commits.ts`；`fold` 写方法仅 `store/`；nudge 字面量仅 `govern/l1-checkpoint.ts` |
| AD-20 审计 | 增加 `fold` 行格式（AD-39）与四项缓存计量在折叠场景下的含义 |
| 节点与边 | 新增 kind `fold`、`req_ledger`；**不新增边**——块的谱系写在 `fold.block_refs` 里（被折区间是 seq 坐标，不是节点，硬造一条指向区间的边只会让图模式失真） |
| 配置面 | 新增 `govern.*` 十一键与 `budget.foldCallsPerDay`（见 §14） |
| 结构种子 | 增加 `src/govern/` 与 `eval/context/` |
| Deferred | 从「不做压缩」改为「不做 L2 与自主 nudge」 |

## 14. 配置面

| key | 默认 | 说明 |
| --- | --- | --- |
| `govern.enabled` | true | 关掉即完全退回宿主自带压缩（本插件不接管） |
| `govern.growthFloorTokens` | 32000 | 增量门槛；`low_yield` 时临时 ×1.5 |
| `govern.fillRatioFloor` | 0.45 | 下限比例，不是触发比例 |
| `govern.observationMaskChars` | 4000 | L0 阈值 |
| `govern.headTailChars` | 300 | L0 预览头尾长度 |
| `govern.checkpointMaxTokens` | 900 | 单块可见摘要上限 |
| `govern.maxVisibleBlocks` | 3 | 超过即触发 L2（v2 前为阻塞条件） |
| `govern.recentTailRatio` | 0.16 | 近期原文区保留比例 |
| `govern.foldModel` | 跟随会话 | 摘要模型；与主会话同路由时才复用前缀 |
| `govern.foldTimeoutMs` | 180000 | 单次摘要超时 |
| `govern.breakevenMaxTurns` | 20 | 超过即 `low_yield` 降频 |
| `budget.foldCallsPerDay` | 400 | 命中即降 `fold-only` |

启用方式沿用骨架的三步（`package.json` 声明 + `dsh.profile.bundles`、`cordis.patch.yml` 的 insert 条目、重启验证），另加一步：**替换宿主的 `compaction-basic` 条目**（bundle patch），否则两个压缩器同时接管历史。`omw doctor` 增加第 6 项：折叠接管是否生效、`fold` 表可读、账本存在。

## 15. 与三个参照实现的关系

| 机制 | 来源 | 我们怎么改 |
| --- | --- | --- |
| 两级整理（先折工具输出） | weave §1 | 采用；判据合并 argp 的实体标签（路径/命令族/错误码） |
| 九节检查点 | weave §3.2 | 砍到六节；用户原话转入要求账本 |
| 要求审计与授权出处 | weave §5.2 | 采用，但只保留可判定的部分（覆盖、极性、单位、方向、作用域）；放弃依赖自然语言猜测的启发式 |
| 双重严格缩小 | weave §5.1 | 原样采用（AD-32） |
| 事务与 `.rollback` | weave §6 | 采用思路，但宿主改由 `Session.append(replace)` 为主路径，避免依赖私有方法指纹 |
| 0-LLM 标签剪枝 | argp §2 | 采用，作为 L0 的主体 |
| `shadowedRange` 配对不变量 | argp §3 | 采用（宿主强制，不是选项） |
| 撞墙兜底 | argp §4.1 | 部分采用：溢出只解锁 L0/L3，不解锁 L1 |
| 块 LSM 与谱系 | bili §3.2 | 采用结构，v2 才实现（字段先留） |
| 增速门控与不报比例 | bili §3.4/§4 | 原样采用（AD-34） |
| 模型拒绝权 | bili §3.7 | 原样采用（AD-29） |
| 留存率 R∞ | bili §4.2 | 作为验收指标之一（G-ctx-1 的补充口径），不作为实现机制 |
| decompress-to-file | bili §3.2 | 采用为 `context_expand({toFile})` |
| 摘要即上下文 | 三家共有 | **拒绝**（AD-37） |
| 阈值填充率触发 | dsh-basic / weave | **拒绝**（AD-34） |
| 本地估算拒发 | 多家曾有 | **拒绝**（上游是权威） |

## 16. 已知风险

1. **账本提取器的准确性**：确定性规则抽不出所有约束（尤其隐含约束）。缓解：抽不出就不阻断，但会让 G-ctx-2 的统计更保守；v1 的账本只认显式句式（禁止/必须/不要/只能/上限/下限/授权），隐含约束靠检查点的 KEEP 规则兜。
2. **模型拒绝折叠导致长期不折**：若模型持续 `declined`，上下文会持续增长。缓解：连续 3 次拒绝后，`context_status` 明确报告「可折区间充足但模型拒绝」，并在下一轮 nudge 里换一种表述；仍不折则交 L3 兜底，不强制。
3. **前缀缓存的计量依赖宿主**：`host_cache_read/write/uncached` 若缺失，`breakeven` 不可算，只能记 `unknown`。此时不降频、不阻断，只标 `economics_unavailable`。
4. **与宿主自带的 `compaction-tool-result-pruner` 重叠**：宿主会在超窗时全局预剪工具结果（约 8192 字符阈值），可能与我们 L0 的桩竞争。缓解：启用的 profile 里一并替换该条目；`omw doctor` 第 6 项检查两个条目是否都已让位。
