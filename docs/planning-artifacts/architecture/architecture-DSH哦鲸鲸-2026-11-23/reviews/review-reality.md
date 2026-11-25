# 现实核查评审 — ARCHITECTURE-SPINE.md（DSH 哦鲸鲸）

- 评审角色：现实核查员（第 1 位）。只判「关于现实世界的断言是否成立」，不判逻辑自洽、不报文风。
- 评审对象：`ARCHITECTURE-SPINE.md`，344 行，文件 mtime `2026-11-23 08:48:49`，AD-1…AD-22（评审期间骨架被作者改过一版，本文行号对应上面这一版）。
- 核对源（全部只读）：
  - DSH 宿主 0.2.2-rc.5：`C:\Users\ellio\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\`（`docs\subsystems\*.md` 与 `node_modules\@deepseek-ai\<pkg>\lib\types\*.d.ts`）。下文 d.ts 路径均相对该目录的 `node_modules\@deepseek-ai\`。
  - TriviumDB 0.9.3：`C:\Users\ellio\AppData\Local\Temp\tdbpack\ex\package\triviumdb.d.ts`（1070 行）＋同目录 `index.js` 与 `triviumdb.win32-x64-msvc.node`（真跑起来过，见「实测」）。
- 实测脚本（临时目录，不入仓）：`C:\Users\ellio\AppData\Local\Temp\omw-probe\probe.mjs`（$exists / 过滤器语义）、`probe2.mjs`（唯一索引 / 快照幂等 / unlinkLabel 是否存在）。

**Verdict：骨架可继续，但 12 条关于现实的断言被推翻或必须收窄——集中在三处：DSH 事件语义（turn-stopping 是被 await 的 serial 钩子；`ctx.schedule` 是提醒投递不是任务调度；`PromptContext` 是类型不是方法）、TriviumDB 写通道（CAS 与 `patchPayload` 都不在事务 op 里；快照不幂等；`search()` 同步无期限）、静态门（禁的 `unlinkLabel` 方法根本不存在，真写 API 有 20 个）。全部可用一句话改掉，不动架构。**

## 1. 逐条核对（结论 | 骨架位置 | 宿主证据 | 一句话）

### 证实

| 结论 | 骨架位置 | 证据 path:line | 一句话 |
| --- | --- | --- | --- |
| 证实 | AD-1 L47 | `dsh-schedule/lib/types/index.d.ts:23-25`；`docs/subsystems/schedule.md:5,28-46,75-84` | `ctx.schedule` 存在，七种时序 after/at/every/daily/weekly/cron/rrule 与三种目标 session/new_once/new 全部齐备。 |
| 证实 | AD-1 L47 | `cordis-plugin-timer/lib/types/index.d.ts:3-5,11-27` | `ctx.timer` 提供 timeout/interval/throttle/debounce，且 throttle/debounce 的定时器随 fiber 销毁；`setTimeout/setInterval` 已 deprecated。 |
| 证实 | AD-1 L47 | `cordis/lib/types/fiber.d.ts:161` | `ctx.effect()` 可登记显式资源并随 fiber 回收。 |
| 证实 | AD-4 L65 | `dsh-agent/lib/types/runtime-types.d.ts:417-427` | `agent/turn-stopping` 的 payload 恰为 `{agent, turn, signal}`，确实不含 session 与 seq——骨架这句是对的。 |
| 证实 | AD-4 L65 | `dsh-session/lib/types/index.d.ts:66`（语义见 :54-57） | `session/event` 存在，且是 post-commit、fire-and-forget 的 append feed。 |
| 证实 | AD-4 | `dsh-session/lib/types/index.d.ts:259,302` | `Session.append()` 双签名可用（批量事件 / 单事件带 opts）。 |
| 证实 | Deferred L331、AD-15 | `dsh-tools/lib/types/events.d.ts:29-40` | `tools/post-execute` 是 `@mode waterfall`，返回 `PostToolDecision`，JSDoc 明写 accept/replace/enrich/block——「卡片与通知可做硬门禁」成立。 |
| 证实 | AD-8 L89、AD-5 L71 | 实测 `probe.mjs`；`triviumdb.d.ts:194-213` | `{superseded_at: {$exists:false}}` 语义正确：只返回缺该字段的节点；`$eq:null` 只命中显式 null；未知操作符抛 `TDB_INVALID_INPUT`（说明 `$exists` 是被实现的真操作符）。 |
| 证实 | AD-10 L101 | `triviumdb.d.ts:921`＋实测 `probe2.mjs` | `createUniqueCompositeIndex(['k','v'])` 真唯一：重复 insert 与 updatePayload 都抛 `TDB_UNIQUE_CONSTRAINT`，`dream_cycle` 一天一次有机制兜底。 |
| 证实 | AD-4 L65 | `triviumdb.d.ts:695,135-143` | `commitTransaction(operations): number[]` 存在，op 恰 8 种：insert / insertWithId / delete / updatePayload / updateVector / link\|upsertEdge / unlink / unlinkLabel。 |
| 证实 | AD-8 L89 | `triviumdb.d.ts:983-984` | `prepareTql` / `executePreparedTql` 存在；参数类型是 `Record<string, string\|number\|boolean\|null>`（只接受标量，见中项 I）。 |
| 证实 | AD-13 L119 | `triviumdb.d.ts:558,414,468-478` | `memoryLimitMb` 是构造选项；资源拒绝的 `error.code === 'QueueFull'`，`ResourceBudgetError` 存在。 |
| 证实 | AD-14 L125 | `triviumdb.d.ts:1060` | `close()` 存在，可满足「恢复前先停库」。 |
| 证实 | AD-14 L125 | `triviumdb.d.ts:1039,537-538` | `createSnapshot` 是实例方法；`verifySnapshot` / `restoreSnapshot` 是模块级导出（骨架写法隐含它们同源，实现时注意 import 位置）。 |
| 证实 | AD-14 L125 | 实测 `probe2.mjs`（5 个文件、`complete=true`、每条都带 crc32 与 sha256）；类型 `:527-535` | manifest 校验能做到 crc32+sha256+complete；注意类型里 `sha256?` 可选（见未证实 U4）。 |
| 证实 | AD-14 L125 | `triviumdb.d.ts:1051,1044-1050` | `migrate(newPath,newDim)` 存在，迁移后向量 0 填充、需 `updateVector` 重灌——与 AD-19 的补写路径一致。 |
| 证实 | AD-8 L89 | `triviumdb.d.ts:245,1017` | `enableRefractoryFatigue` 默认 false，且 `clearSearchState()` 证明疲劳是跨查询引擎状态、不落 payload。 |
| 证实 | AD-5 L71、AD-15 L131 | `triviumdb.d.ts:771,774` | `delete` / `deleteManyAtomic` 是真实方法，禁它们有意义。 |
| 证实 | Stack L218-227 | `dsh/package.json:4`＝`0.2.2-rc.5`；tdb `package.json:3`＝`0.9.3`；`npm view` 逐个命中 typescript@7.0.2 / vitest@5.1.1 / eslint@10.15.0 / zod@4.6.7 / react@19.3.1 / pnpm@12.18.0 / @types/node@26.6.6 | Stack 表九项版本全部可核对，没有想象版本。 |
| 证实 | Stack L218 | 本机 `node -v` | Node 24.21.0，与 Stack 一致。 |
| 证实 | Gates G0-1 L236 | 实测 `probe.mjs`（Node v24.21.0 + `triviumdb.win32-x64-msvc.node`，open/insert/search 全通） | 原生模块 ABI 在本机现在就成立，G0-1 可当场结项，不必留到 M0。 |
| 证实 | Gates G0-3 L238、Open Q2 L342 | `docs/subsystems/session-query.md:15,32`；`dsh-session-query/lib/types/index.d.ts:120,136,159` | 压缩只替换 surface，原事件留 `log-only`，`listEvents` 可按 `surface` 过滤、`readEvent` 可读回；「压缩后 seq 能读回复」预期成立。 |
| 证实 | AD-2 L53 | 实测 API 完备 | 直连 TriviumDB 无 port 层在技术上成立（前提是承担下文 I/J 的写通道细节）。 |

### 推翻（事实不成立）

| 结论 | 骨架位置 | 证据 path:line | 一句话 |
| --- | --- | --- | --- |
| 推翻 | AD-7 L83 | `dsh-system-prompt/lib/types/index.d.ts:72,256,275`；`docs/subsystems/system-prompt.md:46,78` | `PromptContext` 是接口、不是可调用方法；注册动态上下文的是 `ctx.systemPrompt.context(PromptContext)`，且只有它 cache-safe。 |
| 推翻 | AD-4 L65 | `dsh-agent/lib/types/runtime-types.d.ts:406-427` | `agent/turn-stopping` 是 `@mode serial` 且「Awaited before the boundary commits」，在其中等待 3s 去抖（上限 10s）会把每个 turn 的闭合推迟同样时长。 |
| 推翻 | AD-3 L59 | `triviumdb.d.ts:757,135-143,695` | `compareAndSetPayloadField` 是实例方法、不在事务 op 联合里，与 AD-4「一次业务写入＝一次 commitTransaction」互斥；同句要求的「先查活动版本→supersede→insert」本身就是读后写。 |
| 推翻 | AD-14 L125 | `triviumdb.d.ts:1038-1039`＋实测 | 快照不幂等：目标目录已存在直接抛 `TDB_SNAPSHOT_EXISTS`，「今天目录在、校验不过」时补做会撞名。 |
| 推翻 | AD-5 L71、AD-15 L131 | `triviumdb.d.ts:143,817`＋实测 | 实例上没有 `unlinkLabel` 方法（只有事务 op），`grep unlinkLabel(` 永远零命中；真正删边的 `unlink(`、`{type:'unlink'}`、`{type:'delete'}` 一个都没禁。 |
| 推翻 | AD-8 L89 | `triviumdb.d.ts:862,20-28,405` | `search()` 是同步原生调用、无 timeout 参数、JS 侧无法 abort；「800ms 超时即返回空」只能靠 `RequestContext(requestId,timeoutMs).run()`，而且仍会阻塞宿主事件循环。 |
| 推翻 | AD-1 L47 | `dsh-schedule/lib/types/index.d.ts:24`；`docs/subsystems/schedule.md:75-84` | `ctx.schedule` 是「Durable Host-wide reminder management」：投递＝把 prompt 当 user 消息送进目标 Session（new/new_once 还会建 Session），不是后台任务调度器。 |
| 推翻 | AD-6 L77 | `dsh-session-query/lib/types/index.d.ts:24-26`；`docs/subsystems/session-query.md:343` | 宿主只读句柄是 `ctx.sessionQuery`，属可选能力（错误码里就有 optional-backend failure）；provider 缺席时证据指针不可解引用，骨架没这一档降级。 |
| 推翻 | AD-4 L65、AD-15 L131 | `triviumdb.d.ts:686,689,718,726,754,764,801,817,890,897,928,1005` | 写 API 远超 grep 清单：`batchInsert(`、`insertWithId(` 连 `insert(` 子串都不匹配，`patchPayload`（$set/$inc/$unset）、`updateVector`、`link`、`unlink`、`indexText/Keyword`、`dropIndex`、`flush` 全在门外。 |
| 推翻 | AD-5 L71 | `triviumdb.d.ts:139,741,754` | 事务里只能整份替换 payload（`updatePayload`），能 `$unset` 的 `patchPayload` 不是事务 op →「同一事务移除 superseded_at」必须携带完整 payload，与 AD-3「禁止先读后写」摩擦。 |
| 推翻 | Deferred L331 | `dsh-llm/lib/types/index.d.ts:33-46` | `llm/stream` 不是只读：它是 waterfall，监听器可 yield 自己的 chunk 短路替换；只有 LOOP 构造的请求是 deep-frozen。 |
| 推翻 | Deferred L331 | `dsh-session/lib/types/surface.d.ts:24-37,141` | 「助手消息不可变」只对事件日志与人类 transcript 成立；插件自有事件经 `SessionMessageProjection` 可改写既有消息的 model-visible 投影。 |

### 未证实（保持原样，不要当事实用）

| 结论 | 骨架位置 | 证据 path:line | 一句话 |
| --- | --- | --- | --- |
| ~~未证实~~ → **已证实** | Stack L228、Open Q1 L341 | `scripts/probe-m0.ts --dim`（2026-11-23 跑通） | **已实测**：`BAAI/bge-m3` 经 `POST /v1/embeddings` 返回 `dim = 1024`，239 字中文 3 次复测 255 / 300 / 408ms。骨架 G0-2 与 OQ1 已按此关闭。 |
| ~~未证实~~ → **已证实** | Operations L274、Open Q3 L343 | `dsh-storage-json`、`dsh-home-paths`、`dsh-storage-domain` 源码 + 本机 `~/.dsh/storages/`（2026-11-23） | **已实测**：root = `<dsh home>/storages/<domain>/`，`DSH_HOME` 可覆盖；单文件 layout 落 `<root>/<name>.json`，分记录落 `<root>/<name>/<table>/<key>.json` + `global.json`；后端收**绝对**路径；两个包内查无 quota / maxBytes 常量 → **宿主不施加配额，上限即文件系统**。 |
| ~~未证实~~ → **已证实** | AD-16 L137、Open Q4 L344 | `dsh-mnemon@0.5.31` 源码 `dsh-mnemon-source-runtime/lib/index.js:368-375`（2026-11-23） | **已实测**：落盘路径 `~/.mnemon/sources/<instanceKey>/runtime/{USER.md,MEMORY.md}`，归档 `runtime/archived/MEMORY.md`；限额 `memoryLimitBytes=10240`、`userLimitBytes=4096`、单条 `MAX_ENTRY_BYTES=8192`；条目以 `§` 分隔并带 `importance` + `created_at`。**本机 `~/.mnemon` 不存在、无 profile 启用 mnemon，故无真实行数可抽**，迁移验证改用 fixture。 |
| 未证实 | AD-14 L125 | `triviumdb.d.ts:534` | `sha256?` 在类型上可选（0.9.3 实测每条都有）；校验收紧时要留「manifest 未带 sha256」分支。 |
| 未证实 | AD-20 L202 | 无 | 注入组装 p95 ≤30ms 能否达成取决于召回是否离开主线程（见发现 D6）。 |

## 2. 发现（骨架位置 → 现实 → 该怎么改）

### 高

**H1 · AD-7（L83）把类型名当方法，且没分清两条缓存通道**

- 骨架：「只有 `seams/prompt-composer.ts` 可调用 `ctx.systemPrompt.section()` 与 PromptContext」。
- 现实：`section(section: PromptSection): () => void` 在 `dsh-system-prompt/lib/types/index.d.ts:256`；`PromptContext` 是接口（`:72`），注册方法是 `context(context: PromptContext): () => void`（`:275`）。更关键的是缓存语义不同：section 的渲染结果被提交为 `system/message` surface node 0，「replaced in place when the rendered text changes」（`docs/subsystems/system-prompt.md:46`）——文本一变就击穿前缀；而 `PromptContext` 是「the cache-safe counterpart to `PromptSection`」，快照只在变化或 compaction 移除后追加在保留历史之后（`:78`）。
- 改法：AD-7 的 Rule 改成两句：“身份段（≤1200 字符、字节稳定）走 `ctx.systemPrompt.section({name:'omw:persona', order:…, text})`；状态尾巴（≤30 token、每轮可变）**只能**走 `ctx.systemPrompt.context({name:'omw:persona-state', order:…, text})`，禁止用 section 承载任何逐轮变化的文本。”并在 AD-11（L107）把「`persona_state` 只走上下文档」改成同一句的展开（点名 `context()`）。

**H2 · AD-4（L65）把 3s 去抖挂在 turn 闭合边界上**

- 骨架：「`agent/turn-stopping` 后的去抖抽取（默认 3s 去抖，可关）… 去抖是每会话的、带 max-wait（默认 10s）」。
- 现实：该事件 `@mode serial`，且「Awaited before the boundary commits — a listener that objects steers and the machine re-reads its inbox」（`dsh-agent/lib/types/runtime-types.d.ts:406-427`）。监听器返回的 Promise 被 await 才允许边界提交，所以在监听器里 sleep 3s / 最多 10s，等于每个 turn 多等 3–10s 才闭合（GUI 侧表现为回复结束卡顿）。
- 改法：AD-4 加一句实现约束：“监听器只做三件事——解析 agent→session、把 `turn` 记进内存待抽取集合、**同步返回**；去抖与 max-wait 一律用 `ctx.timer.debounce/timeout`（随 fiber 销毁，见 `cordis-plugin-timer/lib/types/index.d.ts:24-27`），插件需 `inject: ['timer']`。禁止在 `agent/turn-stopping` 监听器内 await 任何延时。”

**H3 · AD-5（L71）/AD-15（L131）禁的是一个不存在的方法名**

- 骨架：`delete` / `deleteManyAtomic` / `unlinkLabel` 全仓禁止，CI grep `unlinkLabel(`。
- 现实：`delete`(`:771`)、`deleteManyAtomic`(`:774`) 是真的；但实例上**没有** `unlinkLabel` 方法（实测 `typeof db.unlinkLabel === 'undefined'`），它只作为事务 op 存在：`{ type:'unlinkLabel'; src; dst; label }`（`:143`）。真正的删边方法是 `unlink(src,dst,label?)`（`:817`），事务侧的硬删除还有 `{type:'delete'}`（`:138`）与 `{type:'unlink'}`（`:142`）。所以这条门即使接上也永远 0 命中，而 `unlink(` / `type:'delete'` 完全没被拦。
- 改法：AD-5 禁令改为“会话内禁止 `delete(` / `deleteManyAtomic(` / `unlink(` / `unlinkLabel(`，且禁止事务 op 字面量 `type: 'delete' | 'unlink' | 'unlinkLabel'`”；AD-15 的 grep 相应换成两条：`\.(delete|deleteManyAtomic|unlink|unlinkLabel)\(` 与 `type:\s*'(delete|unlink|unlinkLabel)'`，豁免仍只给 `src/ops/snapshots.ts`（注：快照清理删的是**目录**，根本不需要这三个 API，豁免其实可以取消）。

**H4 · AD-3（L59）+AD-4（L65）用 CAS 保唯一，但 CAS 进不了事务**

- 骨架：「…由写路径在事务内保证（先查活动版本 → supersede → insert）…需要强唯一语义时用 `compareAndSetPayloadField`，禁止「先读后写」」＋「一次业务写入 = 一次 `commitTransaction`」。
- 现实：`compareAndSetPayloadField(id, field, expected, replacement): void`（`triviumdb.d.ts:757`）是实例方法，**不在** `TransactionOperation` 联合（`:135-143`）里，也没有交互式事务（`commitTransaction` 只收 op 数组，`:695`）。所以“CAS＝唯一性兜底”和“单事务”只能二选一；同句还同时要求“先查活动版本→supersede→insert”（读后写）和“禁止先读后写”。
- 改法：AD-3 删掉 CAS 兜底，改成可实现的机制且只用一种：`createUniqueCompositeIndex(['mem_key','active_slot'])`（活动版本写 `active_slot=1`，被 supersede 时写 `active_slot = <superseded_at 的毫秒数>`），由数据库在 insert 与 updatePayload 上强制（实测都会抛 `TDB_UNIQUE_CONSTRAINT`）；同时把“先查后写”的措辞改成“补丁表由 core 依据本轮读到的活动版本生成，`store/commits` 单写者串行提交，冲突以唯一索引抛错为准，抛错即写 `rejected`”。CAS 只在 AD-14/运维修复里允许出现（并写进 AD-15 的写方法清单）。

**H5 · AD-14（L125）「快照是幂等且廉价的」**

- 现实：`createSnapshot(destination, generationId)` 的 JSDoc 就是「创建新的独立快照目录；已有目标返回 `TDB_SNAPSHOT_EXISTS`」（`triviumdb.d.ts:1038-1039`；错误码 `:415`），实测同目录再建即抛。而 AD-14 的触发规则是“每次插件启动检查今天有没有已校验的快照，缺则补做”——“目录在但校验不过”恰是最需要补做的情形，却必然撞名。
- 改法：AD-14 写明快照目录命名含尝试序号（`snapshots/<YYYY-MM-DD>-a|b|c…`）与流程：“先 `verifySnapshot(今天最新一份)`；通过→跳过；不通过或无目录→用下一个未占用后缀 `createSnapshot`，并把 `TDB_SNAPSHOT_EXISTS` 列为预期分支而非错误”。把“幂等”改成“可重入：重复运行最多多一份已校验快照，随后由保留策略收敛到 7 份”。

**H6 · AD-8（L89）「单次召回 800ms 超时即返回空」**

- 现实：`search(queryVector, topK?, expandDepth?, minScore?, payloadFilter?, exact?)`（`:862`）是**同步**方法，没有 timeout 参数；JS 侧 `Promise.race` 无法取消已进入原生的调用。唯一可用的期限机制是 `new RequestContext(requestId, timeoutMs)` + `rc.run(() => db.search(...))`（`:20-28`），期限到了由原生侧抛 `TDB_QUERY_DEADLINE_EXCEEDED`（`:405`）。即便如此，同步调用会占住宿主同一个事件循环最多 800ms，与 AD-20「注入组装 p95 ≤30ms」和「不得占用下一轮首个 token 之前的路径」（L202）直接冲突。
- 改法：AD-8 拆成两句并落一个机制：“召回在 `node:worker_threads` 里执行（AD-1 禁的是 spawn 子进程与端口，不是线程池）；主线程等待上限 `recall.timeoutMs`（默认 800ms）到点返回空并记 `degraded`；worker 侧用 `RequestContext(id, timeoutMs)` 让原生自己查期限。”AD-20 的判据相应补一行“主线程阻塞 p95”。

### 中

**M1 · AD-1（L47）`ctx.schedule` 被当成后台任务调度** — 现实：`Context.schedule` 的注释是「Durable Host-wide reminder management」（`dsh-schedule/lib/types/index.d.ts:24`），投递语义是把 prompt 作为 scheduled message 从 user 送进目标 Session，`new`/`new_once` 还会创建 Session（`docs/subsystems/schedule.md:75-84`）。dream 八步是代码驱动的，走它会在 GUI 里多一条用户消息并触发模型轮次、吃掉 token 预算。改法：AD-1 改成“后台代码任务只用 `ctx.timer`（in-process，随 fiber 销毁）；`ctx.schedule` 只服务 Deferred 表里的主动搭话，且必须经 `seams/schedule.ts` 单一出口”。

**M2 · AD-4（L65）/AD-15（L131）写入口清单不完整** — 现实：真实写方法共 20 个（`triviumdb.d.ts:682-1005`），grep 只覆盖 5 个；`batchInsert(`、`insertWithId(`、`upsertWithId(`、`batchInsertWithIds(` 因大小写差异连 `insert(` 子串都不匹配，`patchPayload`/`updateVector`/`link`/`unlink`/`indexText`/`indexKeyword`/`dropIndex`/`flush`/`compareAndSetPayloadField` 全未纳入。改法：AD-15 换成“eslint 限制 `triviumdb` 只在 `src/store/**` 出现（`no-restricted-imports` 的 allowlist 反写），`src/store/` 之外不得 import 其类型或实例”；grep 兜底规则改为 `\.(insert|insertWithId|upsertWithId|batchInsert|batchInsertWithIds|patchPayload|updatePayload|updateVector|link|unlink|unlinkLabel|delete|deleteManyAtomic|compareAndSetPayloadField|indexText|indexKeyword|dropIndex|tql|tqlMut|flush|commitTransaction)\(`。

**M3 · AD-5（L71）撤销要在事务里 `$unset`** — 现实：事务 op 只有整体替换的 `updatePayload`（`:139`），能 `$set/$inc/$unset` 的 `patchPayload`（`:754`）不是事务 op。改法：AD-5/AD-4 明确“补丁表里的 payload 是完整最终值，由 core 计算，store 不做读-改-写”；或把 `patchPayload` 立为事务外的第四种窄写路径并显式写进 AD-15 黑名单（二选一，别两可）。

**M4 · AD-6（L77）读原文依赖可选能力** — 现实：只读句柄是 `ctx.sessionQuery`（`dsh-session-query/lib/types/index.d.ts:24-26`），`docs/subsystems/session-query.md:343` 的错误联合里就有 optional-backend failure，说明 provider 可以缺席。改法：AD-6 增加“`sessionQuery` 未挂载或查询失败时，evidence 指针降级为不可解引用：召回仍返回指针但标 `degraded:'evidence-unresolvable'`，不得伪造原文”；AD-13 的 no-op 判据里补这一档（它不属于“底座故障全停”，属 AD-18 局部降级）。

**M5 · AD-8（L89）参数化的边界** — 现实：`executePreparedTql(prepared, parameters: Record<string, string|number|boolean|null>)`（`:984`）只接受标量，`$in` 这类数组不能当参数。改法：AD-8 补一句“集合类条件不写进 TQL，改由模板构造 `payloadFilter` 对象传入（`search` 的第 5 参是对象，`:862`）；TQL 参数只承载标量”。

**M6 · Deferred 表（L331）两句关于宿主的描述反了** — 现实：`llm/stream` 是 waterfall 且“yield your own chunks to short-circuit”（`dsh-llm/lib/types/index.d.ts:33-46`），只有 LOOP 构造的请求 deep-frozen；助手消息的 model-visible 投影可被插件自有事件改写（`dsh-session/lib/types/surface.d.ts:24-37`，`foldSurface` `:141`）。改法：把“`llm/stream` 只读”改成“LOOP 请求不可改写，非 LOOP 请求可短路替换，但替换是全局副作用、v1 不用”；把“助手消息不可变”改成“事件日志与人类 transcript 不可变，model-visible 投影只允许由本插件的投影事件改写”。deferral 结论不变。

## 3. 给作者的最小改动清单（按 AD 序）

1. AD-1 L47：`ctx.schedule` 只用于主动搭话；后台代码任务用 `ctx.timer`；补 `inject: ['timer']`。
2. AD-3 L59：删 CAS 兜底，改 `createUniqueCompositeIndex(['mem_key','active_slot'])` + 单写者串行 + 冲突写 `rejected`。
3. AD-4 L65：turn-stopping 监听器同步返回，去抖走 `ctx.timer`；写入口清单补 `patchPayload`/`updateVector`/`compareAndSetPayloadField` 的去向。
4. AD-5 L71：禁令换成 `delete(`/`deleteManyAtomic(`/`unlink(`/`unlinkLabel(` + 事务 op 字面量；撤销写明 payload 是完整最终值。
5. AD-6 L77：`sessionQuery` 缺席时的降级规则。
6. AD-7 L83：`section()` = 身份段，`context()` = 状态尾巴；删掉“与 PromptContext”这种类型名当方法。
7. AD-8 L89：召回进 worker + `RequestContext` 期限；`$exists` 的单点封装（`store/filters.ts` 的 `liveOnly()`，本地类型放宽 `FilterOperator` 并钉死 triviumdb 0.9.3，M0 加一条 `$exists:false` 语义测试）；`$in` 走 `payloadFilter` 不走 TQL 参数。
8. AD-14 L125：快照改“可重入”，写明 `TDB_SNAPSHOT_EXISTS` 是预期分支与尝试序号命名。
9. AD-15 L131：静态门改为 import 限制 + 全量写方法 grep；`unlinkLabel(` 那条删掉。
10. Gates G0-1 L236：本机已证实（Node 24.21.0 + win32-x64-msvc 加载成功），可标“已通过”，把人力留给 G0-2/G0-3。
11. Gates G0-3 L238：把“只读句柄”落实为 `ctx.sessionQuery.listEvents({surface:['log-only','shadowed']})` / `readEvent`，并注明该能力可选。**（2026-11-23 已应用，且实测修正：`listEvents` 只收 `sessionId`，`surface` 是返回记录上的字段不是筛选参数——真实形状见骨架 Open Questions 第 2 条与 G0-3 行。）**
12. Deferred L331：修正 `llm/stream` 与“助手消息不可变”两句。

## 4. 评审边界

- 只看「关于现实世界的断言」，未评逻辑自洽、分层合理性、预算数值是否合适（那是 rubric/adversary/ops 的活）。
- 实测只覆盖 TriviumDB 的 JS 表面行为（过滤器、唯一索引、快照、方法存在性）；未做并发/崩溃/性能基准，未测 `leisureCluster`、`searchAdvanced`、TQL 语义。
- 未实测 bge-m3（无凭据/未联网调用）；未抽样 mnemon 源文件；未验证 storage domain 的实际落盘 root。
