---
name: '骨架评审 · rubric walk'
type: review
lens: rubric
status: final
created: '2026-11-23'
reviewer: rev-rubric
target: ARCHITECTURE-SPINE.md (312 行, 22 条 AD)
verdict: '骨架主干可执行，但第 7 条不通过：3 处自相矛盾的契约（decision / flag / 物理删除例外）+ 3 个未定面（升级与契约版本、外部 provider、写并发），需一轮修订后才可作为 build substrate。'
severity_counts: { high: 5, medium: 15, low: 11 }
---

# 骨架评审 — rubric walk

## 0. 方法与证据

- 对象：`ARCHITECTURE-SPINE.md`（312 行 / 22 条 AD / 4 道闸门）。
- 按需核对：`SOLUTION-DESIGN.md`（262 行）、`C4-VIEWS.md`（156 行）、`.memlog.md`（59 行）、简报 `brief.md`（110 行，四个成功标准）。
- 交叉核对宿主事实（只读）：`@deepseek-ai/dsh-system-prompt/lib/types/index.d.ts:256,275`（`section()` 与 `context()` 两个注入 API）；`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:423`（`agent/turn-stopping` 事件存在）；`@deepseek-ai/dsh-llm/lib/types/types.d.ts:160-179`（每次调用上报 `cacheReadTokens` / `cacheWriteTokens` / `uncachedInputTokens`）；`@deepseek-ai/dsh-token-meter/lib/types/projection.d.ts:13-16`（这三个值的投影）。
- 版本核对（本机 + registry）：`node -v` = v24.21.0；`npm view` 返回 typescript 7.0.2、pnpm 12.21.0、triviumdb 0.9.3、vitest 5.1.1、eslint 10.15.0、react 19.3.1、zod 4.6.7、@types/node 26.6.6；已安装 DSH = 0.2.2-rc.5。
- 工作区当前无 `src/`、无 `package.json`、无 CI 配置，骨架处于「尚无代码可校验」阶段；因此下文的「可执行」按「能否被将来的代码 / CI / 测试 / 一次明确流程动作强制」判定，不按「今天是否已跑通」判定。

## Verdict

**骨架的主干是可信的**：写权（AD-4）、TQL 出处（AD-8）、身份（AD-3）、时间三轴（AD-5）、撤销单元（AD-22）这五处，单看每一条都能被 CI 或契约测试钉住，而且确实挡住了最难腐化的两个权力。问题不在主干，在**接缝**：三处契约在不同文档里各写了一套（F01/F03/F06），三块该有结论的面被留空（F04/F05/F08），加上 AD-15 这道唯一的静态门漏掉了它最该守的两条纪律（F02）。按第 7 条的严格标准，**第 7 条不通过**；第 1、2、3、5 条为「有条件通过」，第 4、6 条通过。

## 1. 七条清单逐条判定

| # | 清单项 | 判定 | 依据 |
| --- | --- | --- | --- |
| 1 | 钉死下一层真实分歧点、且没漏 | **有条件通过** | 写权/查询权/身份/时间/注入/裁决/幂等/降级/快照/迁移/可结算/撤销 12 个分歧点都已钉死；漏 4 个会撞车的接口面：工具契约（F16）、治理投影契约（F12）、配置面（F22）、外部 provider 契约（F05），另缺升级与契约版本（F04）、写并发（F08） |
| 2 | 每条 AD 的 Rule 可执行、且能阻止它声明的分歧 | **有条件通过** | 22 条中 9 条可被 CI/测试硬执行，11 条部分可执行，1 条无机械判据（见 §2 逐条表）。4 条 AD 的 Rule 与其声明的 Prevents 不匹配：AD-1（禁子进程无门）、AD-2（禁抽象无判据）、AD-15（拼接字面量不可判定）、AD-20（命中率只有代理指标） |
| 3 | Deferred 是否会让两个单元各自发散 | **不通过（1 条）** | 「治理界面细节」一条：`gui/` 拿不到 ctx 且不得 import `store/`，但骨架没有定义它**可以**通过什么读数据，两个单元必然各写一套投影（F12）。其余 6 条 Deferred 的重启条件虽是文字，但都不在 v1 路径上，可接受 |
| 4 | 点名的技术是否已核实为当前版本 | **通过（1 处小偏差）** | 10 个名称里 9 个与 registry/本机一致；`pnpm 12.18.0` 落后当前 12.21.0（F30）。`triviumdb 0.9.3` 确为 latest（0.9.4-beta.1 为预发布，不选是对的）；`Node 24.21.0` 与本机运行时一致；`DSH 0.2.2-rc.5` 与已安装版本一致 |
| 5 | 规格驱动的能力覆盖（简报四个成功标准） | **有条件通过** | 四条都有落点（293 行），但 3 条落点不可验收：标准 1 缺评测集落点（F14）、标准 2 缺 20 问 golden set 且被 F03 的 flag 契约冲突直接威胁、标准 3 的映射本身写错（F19，映射到 AD-14 快照恢复，与 AD-5「快照恢复不是撤销机制」自相矛盾）、标准 4 的命中率口径与宿主已提供的计量脱节（F15） |
| 6 | 继承骨架是否存在 | **通过** | `companions: []`，sources 中无上游 spine；本骨架自给。副作用是第 7 条必须更严：没有上游替它兜底 |
| 7 | 每个 initiative 面都有结论/暂缓/开放问题 | **不通过** | 18 个面里 6 个「有结论」、6 个「部分」、6 个「缺」；其中运维/环境包络三面里，**外部 provider 整面缺**（F05）、**部署与环境缺升级/卸载两半**（F04、F20）、运维面缺审计保留与轮转（F06）。按纪律，缺一面即一条发现 |

## 2. 逐条 AD 可执行性判定

约定：**A** = 能被代码/CI/测试硬强制；**B** = 只在部分环节可强制，其余靠评审；**C** = 无机械判据。

| AD | 判定 | 强制手段（现状） | 缺口 |
| --- | --- | --- | --- |
| AD-1 单进程 | B | `ctx.effect()` 有 cordis 支撑；`ctx.schedule`/`ctx.timer` 存在 | 禁 spawn/端口/锁文件**不在任何门里**（F02） |
| AD-2 直连不抽象 | C | 无 | 无 grep/结构可判（F27） |
| AD-3 身份在 mem_key | A | 唯一复合索引 + zod；导出不含 id 可测 | key 公式只覆盖 assertion（F26） |
| AD-4 唯一写入口 | A | AD-15 grep + 单事务 | 缺写并发串行化（F08） |
| AD-5 三轴时间 | A | 禁删 grep + 契约测试 I1 | `tombstone` 未定义（F25） |
| AD-6 证据是指针 | B | zod 字段白名单可 `.strict()` | dangling 检查时机未定（F17）；`deidentified` 无判定规则（F18） |
| AD-7 注入唯一出口 | B | 预算可测（I3/I9） | 唯一出口**无静态门**（F02）；token 口径（F28）；裁剪顺序含召回（F29） |
| AD-8 召回只读有界 | A | 模板集中 + grep + I4 | — |
| AD-9 三级裁决 | B | 仲裁函数单测 | flag 状态机三套写法（F03） |
| AD-10 固化确定性 | B | dry-run / 幂等 / 断点可测 | no-LLM 步骤集冲突（F07）；周期日期时区（F13）；「不得调 LLM」无类型级强制（见 F07 改法） |
| AD-11 身份不依赖库 | A | 文件哈希测试 | — |
| AD-12 关系数值化 | A | 纯函数单测 + execute 前置 | 30 token 的计量口径（F28） |
| AD-13 整体 no-op | A | I6（坏文件启动断言零注册） | 缺「契约版本不符」这一档（F04） |
| AD-14 快照纪律 | B | ops 脚本 + I8 | 与 AD-20 的 30 天保留直接冲突（F06） |
| AD-15 静态门 | B | 5 组 grep | 漏注入出口与进程禁令（F02）；拼接字面量不可判（F10）；`insert(` 裸 grep 会误报（F10）；lint 前置条件未证实（F23） |
| AD-16 mnemon 替换 | A | 幂等测试 / 一键回退 | 「立即恢复」与 AD-13 冲突（F24） |
| AD-17 推断可结算 | B | zod 必填 falsifier + I7 | falsifier 无封闭算子集（F09） |
| AD-18 解耦降级 | A | 两个独立 try/catch 可测 | — |
| AD-19 向量异步 | A | 熔断/超时可测 | pending 的恢复路径未定（F11） |
| AD-20 可核 | B | audit 行可复算 | 与 AD-14/15 的删除纪律冲突（F06）；命中率指标脱节（F15）；无延迟预算（F21） |
| AD-21 决策账本 | B | zod + 同事务 | 字段集与 AD-22 冲突（F01） |
| AD-22 撤销单元 | A | I13（撤销后逐条一致） | 与 AD-21 的 schema 冲突（F01） |

统计：A 9 条、B 12 条、C 1 条（另 AD-7/AD-20 各有一处与其 Prevents 不匹配）。

## 3. 发现清单

严重度：**高** = 会让两个单元写出互不兼容的实现，或让验收无法执行；**中** = 规则不可机械执行、边界模糊，会在实现期产生分歧但可局部收敛；**低** = 契约精度不足或版本表小偏差。

### 高

**F01 · 高 · AD-21 / AD-22 — `decision` 的字段集自相矛盾**
- 证据：AD-21（167 行）把 decision 定义为 `{ts, actor, kind(insert|supersede|arbitrate|resolve_flag|migrate), target_mem_key, from?, to?, reason, precedent_id?, contract_version}`；AD-22（173 行）要求「每个 `decision` 携带 `op_id` 与 `affected[]`」，且要写 `decision(kind=revert…)`。AD-21 的 kind 枚举里没有 `revert`，字段表里没有 `op_id`/`affected`。`SOLUTION-DESIGN.md:40` 的 payload 表同样缺这两项。
- 后果：按 AD-21 写的 zod schema 会拒绝 AD-22 要求的节点；按 AD-22 写的实现会违反 AD-21 的枚举。撤销功能（成功标准 3 的核心）直接建立在冲突契约上。
- 改法：把 AD-21 的字段表改为 `{ts, actor, kind(insert|supersede|arbitrate|resolve_flag|migrate|revert), op_id, affected[]{mem_key[], edges[](from_key,label,to_key)}, target_mem_key, from?, to?, reason, precedent_id?, contract_version}`，并注明「`op_id` 与 `affected` 由 AD-22 定义，本表为准」；同步改 `SOLUTION-DESIGN.md:40`。

**F02 · 高 · AD-15 — 唯一的静态门漏掉了 AD-7 和 AD-1**
- 证据：AD-15（131 行）的 CI grep 清单只覆盖 `prepareTql(`/`executePreparedTql(`、`commitTransaction(`/`insert(`/`updatePayload(`/`upsertEdge(`、`tql(`/`tqlMut(`、`delete(`/`deleteManyAtomic(`/`unlinkLabel(`。AD-7（83 行）声明「只有 `seams/prompt-composer.ts` 可调用 `ctx.systemPrompt.section()` 与 PromptContext」——但清单里没有任何一条 grep 覆盖它。宿主侧确实有**两个**注入 API（`dsh-system-prompt/lib/types/index.d.ts:256` 的 `section()` 与 `:275` 的 `context()`），任意模块调一次就能击穿前缀缓存，而这正是 AD-7 的 Prevents 第一条。同理 AD-1 的「禁止 spawn 子进程、监听端口、跨进程锁文件」也没有任何门。
- 后果：骨架里最贵的一条纪律（前缀缓存）与最基础的一条形态纪律（单进程）都退化为口头约定；而 AD-15 的 Prevents 自称就是在防「时间门被绕过」。
- 改法：在 AD-15 的清单里补三组：
  1. `systemPrompt.section(` / `systemPrompt.context(` / `PromptContext` 只允许出现在 `src/seams/prompt-composer.ts`；
  2. `child_process` / `worker_threads` / `net.createServer` / `dgram` / `.listen(` 全仓禁止；
  3. 跨进程锁（`proper-lockfile` / `flock` / `*.lock` 写入）全仓禁止。
  并把这三条同时写进 `SOLUTION-DESIGN.md §9`，作为 I2a/I2b。

**F03 · 高 · AD-9 — `flag` 的状态机有三套写法**
- 证据：AD-9（95 行）写「`flag` 节点（`flag_type=contradiction`、`status=resolved_auto`）」，同段又说治理视图靠「`kind=flag ∧ status=open`」查询；`SOLUTION-DESIGN.md:39` 的 payload 表却是 `resolved_at?, resolved_by(auto|human)?`，`:172` 又写生命周期 `open → resolved(auto|human)`。三处对「状态存在哪个字段、取值域是什么」给出三个答案。
- 后果：写 flag 的单元（core/arbitration）与读 flag 的单元（gui/ 治理队列）会各自按自己看到的那份文档实现，结果是队列永远为空或永远不闭合——直接打掉成功标准 2（治理 20/20）。
- 改法：在 AD-9 里钉死一个枚举：「`flag.status ∈ {open, resolved_auto, resolved_human}`，`resolved_by` 字段废弃，改用 `status`；`resolved_at` 在 `status ≠ open` 时必填」；同步改 `SOLUTION-DESIGN.md:39` 的 payload 与 `:172` 的生命周期。

**F04 · 高 · AD-13 — 缺「插件升级 / 契约版本不符」这一档（部署与环境面）**
- 证据：AD-13（119 行）的四项检查是「打开库失败 / `verifySnapshot` 不符 / `dim` 不符 / 维度校验失败」；AD-14 管快照与 `migrate`；AD-21 的 payload 里出现了 `contract_version`，但全文没有任何地方规定「磁盘上的 schema/contract 版本比代码新或旧时怎么办」。Stack 是 `DSH 0.2.2-rc.5` 这类会变的宿主，插件必然会被升级，而 `migrate(newPath, newDim)` 只解决维度。
- 后果：这是两个单元最容易各干一半的地方——`store/schema.ts` 的作者会自己加一个 `schema_version` 字段并「尽力兼容」，`ops/migrate.ts` 的作者会假设「没有版本字段」。用户升级插件后要么静默读错数据，要么整库报废（而 AD-5 禁物理删除，报废的库会一直躺在磁盘上）。
- 改法：在 AD-13 的四项检查前插入第 0 项：「打开库后先读 `meta.contract_version`；**高于**代码支持的版本 → 按 AD-13 整体 no-op 并写一行 `unsupported_contract_version`；**低于** → 拒绝启动并提示先跑 `scripts/migrate --dry-run`；不得就地兼容」。同时在 Structural Seed 的 `store/` 行注明该值落在 `meta` 节点。

**F05 · 高 · 〔缺 AD〕— 外部 provider 整面没有结论（基础设施与环境面）**
- 证据：全文对 SiliconFlow `bge-m3` 的规定只有三处：Stack 表一行（197 行，且标「待 G0-2 实测」）、运行包络图一行（235 行，「唯一网络出口」）、G0-2 一行（206 行）。AD-19（155 行）只规定失败侧（超时、熔断、降级）。**没有任何一条 AD 规定**：API key 从哪来（环境变量名？profile 配置？）、endpoint 与 model id 是否可配、限流与配额如何应对、每日/月成本上限、以及「换 provider」时的替换契约（G0-2 直接把「换 provider」写成退路，但没说换的时候业务代码改哪里）。
- 后果：这条面会以两种方式发散——`store/embedding.ts` 的作者把 key 硬编码读 `process.env.SILICONFLOW_KEY`，`seams/config.ts` 的作者把它做成 `config.embedding.apiKey`；以及 provider 一换，`dim` 变了要 `migrate`，而没人负责触发。
- 改法：新增 **AD-23「外部 provider 只有一个适配点，且有配额与替换契约」**：
  - 唯一出口是 `src/store/embedding.ts` 导出的 `embed(texts: string[]): Promise<Float32Array[]>`，其余层不得直接发 HTTP；
  - 必填配置 `embedding = { baseUrl, model, apiKeyEnv, dim, timeoutMs ≤ 2000, maxCallsPerDay }`，key 只从环境变量读，`config` 里只存变量名（与 Consistency Conventions「环境变量只承载密钥」对齐）；
  - `maxCallsPerDay` 命中即整体走文本+图路径并写一行 `embedding_quota_exhausted`；
  - 换 provider = 改这一个文件 + 跑 `migrate(newPath, newDim)`，并在 G0-2 里写明「换 provider 必须同时给出新 `dim` 与迁移命令」。

### 中

**F06 · 中 · AD-14 / AD-15 vs AD-20 — 「全仓唯一物理删除」与 30 天审计保留冲突**
- 证据：AD-5（71 行）「`delete`/`deleteManyAtomic`/`unlinkLabel` 全仓禁止，唯一例外是快照目录清理」；AD-14（125 行）重申「快照目录清理是全仓唯一允许的物理删除」；AD-15（131 行）把豁免写死为 `src/ops/snapshots.ts`。但 AD-20（161 行）要求「审计行只落文件不落库，保留 30 天」——30 天保留必然要有删除旧行的代码，而那段代码不在任何豁免里。
- 改法：新增 `src/ops/retention.ts` 作为**第二个**具名豁免（文件头 `// AD-15 豁免：审计与日志保留`），并把 AD-5、AD-14、AD-15 三处的「唯一」改为「仅限 `snapshots.ts` 与 `retention.ts` 两处」；AD-20 补一句「轮转与删除只经 `ops/retention.ts`，按天切分 `audit-YYYYMMDD.jsonl`」。

**F07 · 中 · AD-10 — 不调模型的步骤集与方案设计不一致**
- 证据：AD-10（101 行）「①②⑥ 不得调用 LLM」；`SOLUTION-DESIGN.md:151`「①②⑥⑦ 不调模型」（⑦ 跨主题重组在 `:148` 标为「否（校验为主）」）。两处对 ⑦ 是否允许模型给了相反答案。
- 后果：dream 的实现者按骨架写会把 ⑦ 做成 LLM 步骤（因为它不在禁令里），成本与不确定性随之进来。
- 改法：AD-10 改为「①②⑥⑦ 不得调用 LLM」，并补一条类型级强制：「确定性步骤的函数签名只接收 `{ store, clock, config }`，不得注入 `llm`；`dream/steps/*.ts` 的确定性步骤在 `test/dream/no-llm.test.ts` 里断言其依赖对象不含 `llm` 键」。

**F08 · 中 · AD-4 — 缺进程内写串行化（并发与一致性面）**
- 证据：AD-1 禁跨进程锁，AD-4 要求「一次业务写入 = 一张补丁表 = 一次 `commitTransaction`」，但 dream（夜间）、`turn-stopping` 抽取（每轮）、快照（每日）三个写入者在同一事件循环里没有任何排队规则。`SOLUTION-DESIGN.md:259` 只用一句「同一事件循环内串行提交即可」带过，且不在骨架里。
- 后果：dream 的长事务与对话写入交错时，`dream_cycle` 的幂等判断与 `superseded_at` 的置位可能看到中间态；两个单元各自加自己的 mutex，最终出现两把锁。
- 改法：AD-4 增加一段：「全进程只有一个写队列（`store/commits/queue.ts`），所有 `commitTransaction` 经它串行提交；队列优先级 对话写入 > 快照 > dream，dream 在提交边界让出；任何模块不得自行加锁或直接 await `commitTransaction`」。

**F09 · 中 · AD-17 — `falsifier` 没有封闭算子集，「可符号判定」不可校验**
- 证据：AD-17（143 行）要求「可符号判定的条件 + 所需观测字段」，但没定义算子与字段的词表。LLM 完全可以产出 `{"condition": "用户以后不再提这个"}` 这种字符串，zod 也验证不出。
- 改法：AD-17 规定 `falsifier` 必须是 `{ op ∈ {eq, ne, gt, lt, gte, lte, exists, count_gte}, field ∈ <白名单>, value }` 的判别联合，白名单与 TBox 同处 `store/tbox.ts`（如 `valid_to`、`superseded_at`、`evidence.count`、`flag.status`）；不合法的 falsifier 与「缺失」同等处理（进 `rejected`）。

**F10 · 中 · AD-15 — 两条 grep 规则不可判定 / 会误报**
- 证据：AD-15 最后一条「任何位置出现含 `{` 拼接的 TQL 字符串字面量」——「TQL 字符串字面量」在文本层面无法识别，规则不可实现；同一条里 `insert(` 是裸方法名，会命中 `Map.insert` 一类同名调用，`delete(` 会命中 `Map.delete`。
- 改法：改为 AST 规则（eslint `no-restricted-syntax`）：
  - `CallExpression[callee.property.name=/^(insert|updatePayload|upsertEdge|commitTransaction|delete|deleteManyAtomic|unlinkLabel)$/]` 只在 `src/store/**` 放行，且限定接收者为库句柄标识符（`db` / `store`）；
  - TQL 参数化用「`prepareTql`/`executePreparedTql` 的第一实参必须是 `Literal` 或无插值的 `TemplateLiteral`（`expressions.length === 0`）」表达。

**F11 · 中 · AD-19 — `pending` 的恢复路径未指定**
- 证据：AD-19（155 行）定义了 `pending → ready|failed` 与熔断，但没说插件重载后谁去补写、补多少、优先级如何。dream 与启动闸门都可能实现「扫 pending」。
- 改法：AD-19 补：「补写只由 `store/embedding.ts` 的启动扫描发起（限 50 条/次、3 次/分钟），dream 不参与补写；`failed` 节点只在人工 `reembed` 命令下重试」。

**F12 · 中 · Deferred「治理界面细节」— `gui/` 与 `core/` 之间没有投影契约**
- 证据：C4/C2 明确 `gui/` 拿不到 ctx、不得 import `store/`（骨架 39 行也写了），Deferred（305 行）把「治理界面细节」推到 M5；但骨架没有定义 `gui/` **可以**通过什么读数据。两个单元会一个在 `core/` 里加 `getFlagQueue()`，一个在 `seams/` 里加 IPC 通道。
- 改法：新增 **AD-24「治理投影是唯一的只读出口」**：`core/projections/*.ts` 导出纯函数 DTO（`flagQueue` / `versionChain` / `exportJsonl` / `explain`），DTO 带 `contractVersion`，经 `seams/projection-bridge.ts` 暴露给客户端插件；`gui/` 只允许 import 这些 DTO 的类型，禁止自行推导查询。这样 Deferred 的「界面细节」才真的可以等。

**F13 · 中 · AD-10 — `dream_cycle:<date>` 的日期时区未定（时钟面）**
- 证据：AD-10 用 `dream_cycle:<date>` 保证一天一次，全文无时区约定；环境写「Windows 本地单用户」。
- 后果：一个单元用 UTC 日期、一个用本地日期，跨零点会跑两次或一次都不跑；这在 dogfood 阶段就直接表现为「昨晚没固化」。
- 改法：AD-10 补「周期键取**本地时区**日期 `YYYY-MM-DD`，并在 `dream_cycle` 记 `tz` 与 `utc_offset`；夜间触发窗口为本地 02:00–05:00」。

**F14 · 中 · 成功标准 1 / 2 — 验收物没有结构落点**
- 证据：简报要求 v1 内「建评测集与口径」（标准 1，50 条人工盲判）与「治理 20 问 30 秒内答清」（标准 2）；骨架 293 行只把标准 1 映射到 AD-6+AD-17（机制），没有任何 `eval/` 或样本库的位置；Structural Seed（212–225 行）里也没有。
- 后果：v1 出口是「20/20 能答」，但 20 个问题本身没有作为产物存在，谁都可以临时想 20 个简单问题自证通过。
- 改法：Structural Seed 增加 `eval/`（`golden-l1.jsonl` 50 条 + `governance-20.md` 20 问 + `rubric.md` 判定口径），并在 Capability Map 下加一行「成功标准 1/2 的验收物落在 `eval/`，由 `scripts/eval.ts` 跑，输出 `eval/reports/<date>.md`」。

**F15 · 中 · AD-20 — 缓存命中率用代理指标，宿主已有真实计量**
- 证据：AD-20（161 行）把 `prefix_unchanged` 称为「前缀缓存命中率的代理指标」。但宿主每次模型调用都上报真实值：`dsh-llm/lib/types/types.d.ts:160-179`（`cacheReadTokens` / `cacheWriteTokens` / `uncachedInputTokens`，且注明三者互斥、计费输入为三者之和），`dsh-token-meter/lib/types/projection.d.ts:13-16` 已有投影。
- 后果：简报标准 4 的达标线是「命中率下降 < 10%」，用布尔代理算不出百分比；v1 又要「建监控与基线」，指标口径定错，基线就白建。
- 改法：AD-20 的注入行改为 `{ts, session_id, tier, chars, tokens, items[], truncated, prefix_unchanged, host_cache_read, host_cache_write, host_cache_uncached}`，来源写死为宿主 token 计量投影；`prefix_unchanged` 降为辅助字段。并把「命中率 = ΣcacheRead / (ΣcacheRead + ΣcacheWrite + Σuncached)（按会话聚合）」写进一致性约定。

**F16 · 中 · 〔缺 AD〕— 工具面契约（名字/入参/返回/错误码）没有 AD**
- 证据：C4/C3 提到 `recall` / `remember` / `forget` / `explain` 四个工具，AD-4 提到 `remember` 工具，但骨架从未钉死工具名、入参 schema、返回包封（`{ok, items[], degraded, reason?}`）、错误码枚举。Consistency Conventions 只写「错误 `{code, message, detail?}`」，没有 code 列表。
- 后果：模型侧契约是最容易被两个单元各写一遍的地方（`seams/tools` 与 `core`），而且一旦名字定了再改要动提示词。
- 改法：新增 **AD-25「工具面是本插件的公开契约」**：固定四个工具名与 zod 入参（`recall{query, topK?≤8}`、`remember{patch}`、`forget{mem_key, reason}`、`explain{mem_key}`），返回统一 `{ok, items?, degraded, reason?}`；错误码封闭为 `{E_BUDGET, E_TIMEOUT, E_DEGRADED, E_BOUNDARY, E_GATE_DOWN}`；新增工具必须改本条 AD。

**F17 · 中 · AD-6 — `dangling_evidence` 的检查时机与检查者未定**
- 证据：AD-6（77 行）「指针指向不存在的 seq 时必须挂 `flag(dangling_evidence)`」，但没说谁在什么时候检查——召回时检查（每轮都查，代价高）还是 dream ① 结算时检查（一天一次）。
- 改法：AD-6 补「检查只在 dream 第①步（确定性结算）执行，结果写 `flag(type=dangling_evidence, status=open)`；召回路径只做 `seq` 语法校验，不做存在性回读」。

**F18 · 中 · 〔缺结论〕— 隐私/脱敏面**
- 证据：AD-6 有 `deidentified` 布尔字段，但没有判定规则；快照（AD-14）与导出（Consistency Conventions「导出为纯文本 + JSONL」）都会包含 `quote`（≤200 字原文），骨架没有任何关于敏感内容或目录权限的规定。本地单用户降低了风险，但「证据是别人的隐私」这件事在 `quote` 里是真实存在的。
- 改法：AD-6 增加「`deidentified` 由写入路径计算：命中手机号/身份证/邮箱/银行卡正则即置 `true` 并把 `quote` 替换为脱敏版（保留 `quote_truncated` 原长度）；`ops/export.ts` 与快照目录默认排除 `deidentified=true` 的 `quote`，需要时用 `--include-sensitive` 显式导出」。

**F19 · 中 · Capability Map（293 行）— 遗忘回滚的落点写错**
- 证据：293 行「遗忘回滚零残留 → AD-5 + AD-14」。AD-5（71 行）明确写「全库快照恢复是灾难恢复，不是撤销机制」，AD-22 才是撤销单元。
- 后果：验收时若按此映射去测「快照能恢复」，会得出与 AD-5 相反的结论；实现者也可能据此把撤销做成快照恢复。
- 改法：293 行改为「遗忘回滚零残留 → AD-5（软删除 + tombstone）+ AD-22（按 `op_id` 撤销）+ I13」。

**F20 · 中 · 〔缺结论〕— 卸载与数据处置（部署与环境面）**
- 证据：运行与部署包络（239–243 行）只写「怎么启用」；没有写「怎么停用/卸载」以及卸载后 `<plugin-data>/oh-my-whale/{oh-my-whale.tdb, snapshots/, audit.jsonl}` 的命运。这一面与 AD-5 的「零物理删除」直接相撞。
- 改法：在运行包络下补三条：「停用 = 从 `cordis.yml` 移除补丁，数据原地保留；卸载 = 提供 `scripts/dispose.ts --export-then-delete`，先导出 JSONL 再删除目录，且这是 AD-5 纪律的**第三处**具名豁免；`audit.jsonl` 默认不随卸载删除」。

**F21 · 中 · AD-20 — 没有整轮注入路径的延迟预算**
- 证据：AD-8 给了召回 800ms、AD-19 给了 embedding 2s，但 `prompt-composer` 是每轮同步执行的（写 section、算预算、写 `audit.jsonl` 一行），骨架没有任何一条规定这段必须在多少毫秒内完成；方案设计 §1 的目标「不拖慢任何一次原生对话」因此不可验证。
- 改法：AD-20 增加「注入路径的同步预算：`compose()` 单次 ≤ 20ms（p95），审计行写入必须异步（`fs.appendFile` 队列），不得在注入路径上做任何库查询；超预算按 `E_BUDGET` 降级为仅身份段」。

**F22 · 中 · 〔缺 AD〕— 配置面没有单一出处**
- 证据：散落在各处的配置项已有 6 个以上：`legacyMnemonInject`（AD-16）、`enableRefractoryFatigue`（AD-8）、去抖 3s「可关」（AD-4）、dream 日 token 上限（AD-10）、`memoryLimitMb`（AD-13）、embedding key（F05 指出根本没写）。Consistency Conventions 只有一句「配置由 zod 校验」。
- 后果：两个单元各加各的键，`config` schema 变成垃圾场；`enableRefractoryFatigue` 这种「只读实例不得开启」的开关没有地方承载互斥校验。
- 改法：新增 **AD-26「配置单一出口」**：`src/seams/config.ts` 导出唯一的 zod schema，列出全部键、默认值与互斥规则（如 `enableRefractoryFatigue=true ∧ accessMode=readOnly` 直接启动失败）；新增配置键必须改本条 AD 并补 schema 测试。

**F23 · 中 · AD-15 — lint 前置条件未证实（标注：未证实）**
- 证据（未证实）：Stack 选 `TypeScript 7.0.2`（原生端口）与 `eslint 10.15.0`；AD-15 的第一条强制手段是「eslint 强制分层依赖」，这依赖 typescript-eslint 能解析 TS 7 的工程。**我没有验证这两者组合是否可用**（本仓库尚无 `package.json`，无法运行）。
- 后果：若不可用，AD-15 的一半（分层依赖）在 M0 就落不了地，而它被默认当作可用。
- 改法：在 Gates 增加 **G0-5**：「在 `TS 7.0.2 + eslint 10.15.0` 下，对一条故意的跨层 import（`core → seams`）`pnpm lint` 必须报错；不过就降到 TS 6.x 并记录」。

**F24 · 中 · AD-16 — 「立即恢复旧注入」与 AD-13 冲突**
- 证据：AD-16（137 行）「`config.legacyMnemonInject = true` 立即恢复旧注入」；AD-13（119 行）「恢复需重载插件，不在进程内自愈重试」。配置热读的能力全文没有定义。
- 改法：AD-16 改为「置 `true` 并重载插件后恢复旧注入」，或明确「配置支持热读（由 `seams/config.ts` 监听），但只影响注入开关、不影响库句柄」。

**F31 · 中 · 〔缺结论〕— 外部调用成本没有上限**
- 证据：AD-10 给了 dream 的日 token 上限；但每轮一次抽取 LLM 调用（AD-4、`SOLUTION-DESIGN.md:120-125`）与每次写入的 embedding（AD-19）都没有任何日/月上限。`SOLUTION-DESIGN.md:261` 承认「长对话会累积」，只写「按轮次上限而非字数上限」。
- 改法：并入 AD-26（配置）增加 `budget = { extractionCallsPerDay, embeddingCallsPerDay, dreamTokensPerDay }`，命中后抽取降级为「只记不抽」并写一行审计；AD-20 增加对应汇总行。

### 低

**F25 · 低 · AD-5 — `tombstone` 未定义**
- 证据：AD-5（71 行）「撤销 = 在同一事务里移除 `superseded_at` 并清 tombstone」；权威 kind 表（265 行）里没有 `tombstone`，`SOLUTION-DESIGN.md:174` 用的是 `flag(deleted)`。
- 改法：AD-5 把 `tombstone` 统一为 `flag(type=deleted, status=open)`，或在 payload 里加显式 `tombstoned_at` 字段并在 kind 表注明。

**F26 · 低 · AD-3 — `mem_key` 公式只覆盖 assertion**
- 证据：AD-3 定义 `<kind>:<subj>:<pred>[:<obj_norm>]`；`SOLUTION-DESIGN.md:68,74` 另有 `<kind>:<稳定名>` 与 `decision:<epoch_ms>:<rand>`。
- 改法：AD-3 注明「该公式适用于 `assertion`；其余 kind 为 `<kind>:<稳定名>`（entity=规范化名、pref=key、dream_cycle=日期、decision/dream_log/rejected=单调键）」，并在表里给出单调键的构造规则。

**F27 · 低 · AD-2 — 「不引入 repository/port」无机械判据**
- 证据：AD-2 的 Rule 是命名与风格约束，没有可执行检查。
- 改法：改为可判形式：「`src/store/` 的导出名必须是动词短语（`insertAssertion`/`queryByMemKey`…），禁止出现 `Repository` / `Port` / `Adapter` 后缀的接口或类；eslint `no-restricted-syntax` 匹配 `TSInterfaceDeclaration[name.value=/(Repository|Port|Adapter)$/]`」。

**F28 · 低 · AD-7 / AD-12 — 30 token 缺计量口径**
- 证据：AD-7 的「≤30 token」由字符近似写死（≈12/≈10/≈8），但 CJK 与英文的 token 比差异很大；宿主有 `dsh-token-meter` 可计量。
- 改法：AD-7 补「预算以宿主 token 计量为准（`dsh-token-meter` 投影），无计量时按 1 汉字 = 1.5 token 保守估算；审计行同时记 `tokens_estimated` 与 `tokens_measured`」。

**F29 · 低 · AD-7 — 裁剪顺序把「召回」并进了 section 预算**
- 证据：AD-7「超预算按 身份 > 状态 > 召回 顺序裁剪」；但召回走工具返回（AD-8），不占 section 预算，这一项不可执行。
- 改法：改为「section 预算内按 身份 > 状态 裁剪；召回预算独立（≤5 条 / 800ms），两者不互相挤占」。

**F30 · 低 · Stack — `pnpm 12.18.0` 非当前版本**
- 证据：`npm view pnpm version` = 12.21.0；其余 9 项与 registry/本机一致（typescript 7.0.2、triviumdb 0.9.3、vitest 5.1.1、eslint 10.15.0、react 19.3.1、zod 4.6.7、@types/node 26.6.6、Node 24.21.0、DSH 0.2.2-rc.5）。
- 改法：Stack 表 `pnpm` 改为 12.21.0（或注明「以 `packageManager` 字段为准」）。

## 4. 版本核实表（第 4 条）

| Stack 项 | 骨架写 | 实测/registry | 判定 |
| --- | --- | --- | --- |
| Node.js | 24.21.0 | 本机 `node -v` = v24.21.0 | 一致 |
| TypeScript | 7.0.2 | npm latest = 7.0.2 | 一致（但与 eslint 10 的组合未证实，见 F23） |
| pnpm | 12.18.0 | npm latest = 12.21.0 | 落后（F30） |
| triviumdb | 0.9.3 | npm latest = 0.9.3（0.9.4-beta.1 为预发布） | 一致 |
| DSH 宿主 | 0.2.2-rc.5 | 已安装包 version = 0.2.2-rc.5 | 一致 |
| vitest | 5.1.1 | npm latest = 5.1.1 | 一致 |
| eslint | 10.15.0 | npm latest = 10.15.0 | 一致 |
| react | 19.3.1 | npm latest = 19.3.1 | 一致 |
| zod | 4.6.7 | npm latest = 4.6.7 | 一致 |
| @types/node | 26.6.6 | npm latest = 26.6.6 | 一致 |
| bge-m3 dim | dense 1024（待 G0-2） | 未实测 | 骨架已自标待测，处置正确 |

## 5. initiative 面覆盖矩阵（第 7 条）

| 面 | 骨架现状 | 位置 | 判定 |
| --- | --- | --- | --- |
| 部署与环境（运行形态、安装） | 有结论：同进程插件、`cordis.yml` 补丁 `insert`、无端口、Windows 单用户 | AD-1、239–241 行 | 有 |
| 部署与环境（升级、契约版本） | **缺** | — | 缺 F04 |
| 部署与环境（停用、卸载、数据处置） | **缺** | — | 缺 F20 |
| 基础设施与外部 provider | **缺**（只有失败侧与一道闸门） | AD-19、G0-2 | 缺 F05 |
| 运维：备份/迁移/保留 | 有结论 | AD-14、AD-16 | 有（与 F06 冲突需修） |
| 运维：日志轮转、排障 runbook、健康自检 | **缺** | — | 缺 F06（保留与删除冲突）；runbook 未提 |
| 性能与容量 | 部分：召回 800ms、embedding 2s 有；整轮注入延迟无 | AD-8、AD-19 | 部分 F21 |
| 容量与磁盘增长 | 开放问题（storage root/配额未证实） | Open Q3 | 开放问题，可接受 |
| 并发与一致性 | **缺** | — | 缺 F08 |
| 安全与隐私（本地无鉴权） | 部分：`deidentified` 只有字段 | AD-6、181 行 | 部分 F18 |
| 可观测性 | 部分：audit.jsonl + 一行一事件 | AD-20、181 行 | 部分 F06/F15 |
| 配置管理 | **缺单一出处** | 散布 | 缺 F22 |
| 测试与验收（I1–I13 的绑定） | 部分：I1–I13 在方案设计，骨架未绑定成门 | AD-15 | 部分 F02/F14 |
| 成本 | 部分：只有 dream 的 token 上限 | AD-10 | 缺 F31 |
| 时钟与时区（dream 周期） | **缺** | — | 缺 F13 |
| 数据生命周期（迁移/导出） | 部分：迁移有，导出只在约定 | AD-16、180 行 | 部分（随 F20 一并补） |
| 人格资产发布 | 有结论：`assets/persona.md` 随包、字节稳定 | AD-11 | 有 |
| 治理视图投放 | 暂缓（Deferred），但投影契约缺 | Deferred 305 行 | 部分 F12 |

结论：**运维/环境包络没有做到「每面都有结论」**——外部 provider 整面缺、部署缺升级与卸载、运维缺保留与轮转、并发缺、配置缺、时区缺。按纪律逐条计为 F04/F05/F06/F08/F13/F20/F22/F31。

## 6. 已核实为「通过」的部分（不必改）

- AD-3 / AD-4 / AD-5 / AD-8 / AD-22 这五条是全场最硬的部分：都有唯一索引、CI grep 或可由一次事务断言的性质支撑。
- AD-13 的「全停」与 AD-18 的「局部降级」分工写得清楚，且互相引用，不会让实现者二选一。
- AD-22 的验收口径（「撤销后默认查询与召回结果逐条等于操作前」）是全篇最好的一条可执行断言，建议其他 AD 照此写法补验收句。
- Gates（G0-1..G0-4）把「不通过就回退方案」写在前面，比把风险留到 M4 强。
- 第 6 条：无继承骨架，`companions: []` 与 sources 一致，无隐性依赖。

## 7. 未证实清单（不得当作事实使用）

1. `TS 7.0.2 + eslint 10.15.0` 下 typescript-eslint 的类型感知规则可用性（F23）。
2. `bge-m3` 实际维度是否 1024（骨架 Open Q1、G0-2 已自标）。
3. 压缩后的 `seq` 能否经只读句柄读回原文（Open Q2、G0-3）。
4. `triviumdb` 原生模块在 DSH 运行时 Node ABI 下能否加载（G0-1）。
5. storage domain 的实际落盘 root 与容量配额（Open Q3）。
6. `agent/turn-stopping` 之后发起 LLM 调用是否会被宿主接受、是否计入会话成本——事件本身存在（`dsh-agent/lib/types/runtime-types.d.ts:423`），但「在 turn 已停止后做异步模型调用」的可行性未验证；这条直接影响 AD-4 的抽取路径与 F31 的成本上限。
7. mnemon 的 `USER.md` / `MEMORY.md` 真实行数与 `§` 结构（Open Q4）。

## 8. 修订优先级建议

1. **先修契约冲突**（F01、F03、F06、F19）——这四条是同一份文档里两个说法打架，改动量小、收益最大，且直接决定成功标准 2/3 能否验收。
2. **再补静态门**（F02、F10）——门一旦写错，后面所有纪律都在裸奔。
3. **再补三块缺面**（F04 升级与契约版本、F05 外部 provider、F08 写并发）——这三块决定 M1 之后两个单元会不会各写一套。
4. 其余按中→低顺序随修订一并处理即可。