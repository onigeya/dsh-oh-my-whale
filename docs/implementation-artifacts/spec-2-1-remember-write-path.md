---
title: 'Story 2.1 — 用 remember 写下一条断言，立刻能按业务键读回'
type: 'feature'
created: '2026-11-23'
status: 'done'
baseline_revision: '18374671c9b5f0239fa5a02398ea314c981058ae'
review_loop_iteration: 2
followup_review_recommended: true
context:
  - '{project-root}/docs/implementation-artifacts/epic-2-context.md'
  - '{project-root}/docs/specs/spec-DSH哦鲸鲸/data-model.md'
warnings: ['oversized'] # 13KB：12 条 AC + 11 行矩阵，单故事规格已按可评审粒度拆分
deferred:
  - summary: >-
      模型提出新谓词时挂上的 flag 没有任何路径把它 resolve 成 resolved，`DecisionKind 'resolve_flag'`
      在整个仓库里没有生产者。本故事只负责挂 flag，收敛语义属于 Story 2.3 的账本工作。
    evidence: >-
      在 src 下检索 resolve_flag 只命中 `src/core/decisions.ts:14` 的类型定义；`src/core/patch.ts` 挂 flag 的两处
      都写 status:open，没有对应的 resolve 写入。
    location: 'src/core/patch.ts:721'
    severity: low
  - summary: >-
      本故事写入的节点 vec_state 恒为 pending，2.1 内没有任何路径把它推到 ready。补算属 Story 2.5
      （只读有界召回）的向量回填；README 的边界段已写明这一限制，避免宿主以为写入即可召回。
    evidence: >-
      `src/core/patch.ts:380,433` 两处写 vec_state 为 pending；全仓库唯一写 ready 的是
      `src/store/vector-write.ts:91`，而 `src/seams/vector.ts` 的 VectorPolicy 只有 closed 与 write 两个成员，无批量补算入口。
    location: 'src/core/patch.ts:380'
    severity: medium
  - summary: >-
      写队列的错误翻译分支在测试里不可达：`createWritePort` 的 `createWriteQueue({reporter})` 不暴露
      `taskTimeoutMs`，要触发 E_TIMEOUT 需要真实停顿 ≥30s，而 vitest 的 `testTimeout` 同为 30_000。
    evidence: >-
      `test/seams/write-port-failures.test.ts` 只能通过 Proxy 覆盖 `commitTransaction` 触发泛化错误；
      超时路径由 `test/store/queue.test.ts` 直接对队列验证（fake timers），端口层的映射无覆盖。
    location: 'src/seams/write-port.ts:361-373'
    severity: low
  - summary: >-
      用户把模型当日的候选谓词提升为 single 后，该谓词是否仍计入 `tbox.maxNewPredsPerDay` 的当日额度
      未经场景验证；若不计入，提升一次就重置额度，日上限可被绕过。
    evidence: >-
      `src/store/templates/assertions.ts` 的 MODEL_PREDS_SINCE_QUERY 本轮已加 live 过滤，但「提升后已存条目
      的 decided_by 是否改写」没有用例；settle 方法：连续两次升级同一候选，再观察第 21 个新谓词是否被拒。
    location: 'src/core/patch.ts:575-591'
    severity: medium
  - summary: >-
      写队列超时后「新任务不得开始」由 poisoned 标志与 `test/store/queue.test.ts` 的
      「stops the queue after a timeout」覆盖，但真实调度下超时与 straggler 结算的时序未复现。
    evidence: >-
      `src/store/commits/queue.ts` 的 execute 用链式 then 在 straggler 真正结算时释放槽位；
      该时序只在 fake timers 下验证过。
    location: 'src/store/commits/queue.ts:196-216'
    severity: high
  - summary: >-
      两条 flag 的载荷字段（severity/detail/status）未与 data-model §3 的 flag 定义逐字段对齐。
      按 low 处理，因为 flag 的 detail 是自由文本，数据模型未约束其形状。
    evidence: >-
      `src/core/patch.ts` 的 flagPayload 写 kind/flag_type/severity/status/detail/valid_from/recorded_at/active_slot；
      data-model §3 列的是 flag_type/severity/status/detail/resolved_at?/resolved_by?。
    location: 'src/core/patch.ts:319-337'
    severity: low
---

<intent-contract>

## Intent

**Problem:** 写路径为零。`src/store/` 只有打开/快照原语，没有 schema、事务、唯一索引、补丁表；四个工具全是占位。Epic 2 其余五条故事都建立在「一次写入要么全成要么全不成」「同键至多一条未失效」之上。

**Approach:** 补丁表落成一次事务：core 依谓词登记表算出每个节点的完整 payload（`mem_key` 三段/四段、`active_slot=1`），`store/commits` 经唯一写队列提交；唯一索引冲突翻成 `E_CONFLICT`，失败另落一条 `rejected`。登记表是数据：10 个种子谓词随安装写入，模型可新建 `multi`/`candidate`，只有用户命令能把基数提升为 `single`。

## Boundaries & Constraints

**Always:**
- 业务身份只在 `mem_key`（`<kind>:<subj>:<pred>[:<obj_norm>]`）；活动位 `active_slot=1`，失效位写成失效毫秒数；唯一性由 `(mem_key, active_slot)` 复合唯一索引在 `insert` 与 `updatePayload` 上强制，不做 CAS 重试。
- 一张补丁表 = 一次 `commitTransaction`；任一 op 非法或撞唯一键，则节点/边/账本全为 0，另落一条 `rejected`（原因 + 原始补丁），普通查询读不到它。
- 全进程只有一个写队列（`store/commits/queue.ts`），优先级 对话 > 快照 > 固化；任何模块不得自行加锁或绕过队列。
- 工具错误码在封闭五码之外增加 `E_CONFLICT`（唯一冲突的语义位）；引擎异常一律翻译成它或 `E_GATE_DOWN`，不裸抛。
- 每次成功写入在同一事务内写一条 `decision`（`ts/actor/kind/op_id/affected[]/target_mem_key/reason/contract_version`）。
- 断言 payload 带 `actor`、`cause`、`prompt_version`、`recorded_at`、`vec_state:'pending'` 与零向量；节点 id 不进日志、审计、导出与 flag 负载。
- schema 只在可写句柄上幂等建立；`omw doctor` 的只读路径不得写库。

**Never:**
- 不写 `superseded_at: null`；「未失效」只写 `superseded_at: {$exists: false}`。
- 不做断言改写（2.3）、证据落库（2.2）、召回（2.5）、审计报告（2.6）。
- 不新增物理删除路径；不引入 repository/port 抽象；不一次建齐 14 个 kind 的索引。
- 不让模型写 `single`；不放行 `omw_` 前缀；不让非法谓词名只拒单条 op。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| WRITE_NEW | 空库，`assertion` + 种子谓词 `likes` | 提交成功；节点数 +1（断言）、`mem_key=assertion:Elliott:likes:coffee`、`active_slot=1`、有 `valid_from`/`recorded_at`；同事务多一条 `decision` | 无错误 |
| WRITE_SAME_VALUE | 同键同 `obj_norm` 再写一次 | 不新增节点；返回既有版本的 `mem_key` 与值，`ok:true` | 无错误 |
| WRITE_DIFFERENT_VALUE | 同键不同 `obj_norm` | 不新增活动节点；返回既有版本 | `E_CONFLICT`（2.3 才改成 supersede） |
| WRITE_INVALID_OP | 3 个 op，第 3 个谓词名非法 | 断言/pred/flag/decision 节点数全 0；`rejected` 恰 1 条含原因与原始补丁 | `E_BOUNDARY`，补丁整体拒收 |
| PRED_SEEDED | 首次 bootstrap | 10 个 `pred:<名>` 节点，`status=active`、`decided_by=seed`、基数按登记表 | 无错误 |
| PRED_NEW | 表外谓词 `mood` | 同事务先建 `pred:mood`（multi/candidate/model），再写断言，并挂 `flag_type=predicate_new`（open）；旧版本不被 supersede | 无错误 |
| PRED_PROMOTE | `/omw pred promote mood --single --reason …` | 同事务旧 `pred:mood` 置失效 + 新 `single` 节点生效 + `decision`；此后同键冲突才走自动档 | 模型提交同类补丁时 `E_BOUNDARY` |
| PRED_INVALID_NAME | 空 / 41 字符 / `Mood` / `omw_x` | 整表拒收 + `rejected` | `E_BOUNDARY` |
| PRED_CAP | 当日已建 20 个新谓词（`tbox.maxNewPredsPerDay`） | 不建 pred；断言降级为 `scene` 文本节点并写一行 `write` 审计（`outcome:downgraded`） | `ok:true`（信息不丢） |
| TX_ATOMIC_CONFLICT | 事务内第二条活动版本撞键（绕过 supersede） | 事务整批 `not_committed`（实测节点数不变） | `E_CONFLICT` + `rejected` |
| PERF_P95 | ≥200 次单 op 写入（dim=4 临时库） | 写事务 p95 ≤10ms | 超标即失败 |

</intent-contract>

## Code Map

- `src/store/commits/engine.ts` -- 唯一调用引擎写方法（`commitTransaction`/`insert`/`updatePayload`）的模块；把 `TDB_UNIQUE_CONSTRAINT` 翻成 `{kind:'unique',fields,existingId}`（`src/store/db.ts:54-79` 是只读面的先例）。
- `src/store/commits/queue.ts` -- 串行写队列与优先级；`src/ops/snapshots.ts:185-239` 将来也经它排队。
- `src/store/commits/assertions.ts` -- 补丁表 → 事务 op 列表 → 队列提交 → `rejected` 落库。
- `src/store/schema.ts` -- 幂等 bootstrap：两个复合索引 + 10 个种子 `pred` 节点；`listUniqueIndexes()`/`indexInfo()` 预检。
- `src/store/templates/assertions.ts` -- 唯一允许 TQL 的地方：`findLiveByKey`、`findAllVersionsByKey`、`findPredByName`、`findModelPredsSince`；参数只能写在 `WHERE x == $p`（实测）。
- `src/store/tbox.ts` -- 谓词名规范化/校验（`^[a-z][a-z0-9_]*$`、≤40、禁 `omw_`）、种子表、payload 构造、事务内登记表快照。
- `src/core/patch.ts` -- 补丁表 zod schema（`ops` 1..50）、`mem_key` 推导与 `obj_norm`（带 `norm_version`）、最终 payload 计算。
- `src/core/decisions.ts` -- `decision` 节点构造（`op_id`、`affected[]` 用 `mem_key`）。
- `src/core/tool-errors.ts` -- 工具错误码封闭集（含新增 `E_CONFLICT`）与映射。
- `src/seams/tools.ts:80-87` -- `remember` 的参数 schema 已冻结；把占位换成实现，其余三个仍是占位。
- `src/seams/commands.ts:100-268` -- `/omw doctor` 的先例；新增 `/omw pred promote` 作为唯一的 user-actor 写入口。
- `src/seams/runtime.ts:183-339` -- 启动时序接入点：闸门通过后、注册工具前做 schema bootstrap，并创建写队列。
- `src/seams/config.ts:73-94` -- 已有 `recall.candidatePool` 先例；新增 `tbox.maxNewPredsPerDay`（ADR-26 要求进 schema 与默认值测试）。
- `src/ops/audit.ts:18-44` -- 现有注入/召回行；新增 `write` 行（`outcome`、`elapsed_ms`）。
- `scripts/check-layers.mjs:29-195` -- 文本扫描的既有规则与豁免机制；新增写权/TQL/`$exists` 三条。
- `test/support/fake-ctx.ts:29-62` -- `tempHome`、`memoryLogger`、`startRuntime` 三种测试基建。
- `src/seams/runtime.ts:370-395` -- 写面装配点：`ensureSchema` 返回 `{ok, writable}`，只有两者皆真才创建 `writeDeps`（队列 + 工具注册 + 命令写入口）；否则 `runtime.write === undefined`。
- `src/store/commits/queue.ts` -- 除优先级串行外增加 `close()`（关闭后 `run` 立即拒绝）、`pending` 深度上限与单任务超时。
- `src/core/tool-errors.ts` -- `sanitizeEngineText` 的节点 id 规则需同时覆盖 `id: 12` 与中文「节点 12 / 冲突节点 12」，且不得吃掉 `assertion:Elliott:id:12` 这类合法 `mem_key`。

## Tasks & Acceptance

**Execution:**
- `src/seams/config.ts` -- 加 `tbox.maxNewPredsPerDay`（整数 ≥1，默认 20） -- AD-26 单一出处。
- `src/store/commits/engine.ts` -- 包住三个写方法并翻译唯一冲突 -- 让引擎语义只落一处。
- `src/store/commits/queue.ts` -- 优先级串行队列 + `idle()` -- AD-4 的单写队列。
- `src/store/templates/assertions.ts` -- 四个字面量预编译模板 -- AD-8 的唯一查询入口。
- `src/store/tbox.ts` -- 校验、种子、快照 -- 谓词是数据（AD-27）。
- `src/store/schema.ts` -- `ensureSchema(db)` 幂等建索引与种子 -- 2.1 的 schema AC。
- `src/core/patch.ts` -- zod 补丁表、键推导、终值计算 -- 原子性与键语义的核心。
- `src/core/decisions.ts` -- `decision` 构造 -- AD-21 的同事务账本。
- `src/store/commits/assertions.ts` -- 提交编排、`rejected` 补写 -- 一次写入一次事务。
- `src/core/tool-errors.ts` -- 错误码与映射 -- 不裸抛引擎异常。
- `src/seams/tools.ts` -- 实现 `remember`，保留另外三个占位 -- 公开工具面（AD-25）。
- `src/seams/commands.ts` -- `/omw pred promote <名> --single|--multi --reason <文本>` -- 用户提升基数的唯一入口。
- `src/ops/audit.ts` -- 增加 `write` 行类型 -- 降级审计与 2.6 的写事务分位。
- `src/seams/runtime.ts` -- 闸门后 bootstrap、装配队列与工具、schema 失败则不注册工具 -- 启动时序。
- `scripts/check-layers.mjs` -- 新增：写方法仅 `src/store/commits/**`；`prepareTql`/`executePreparedTql` 仅 `src/store/templates/**`；`$exists` 仅模板内 -- 静态门。
- `package.json` + `vitest.config.ts` -- 加 `@vitest/coverage-v8@5.1.1` 与 `test:coverage`，阈值 行 80 / 分支 70（Epic 2 DoD） -- 复盘 A5。
- `test/store/**`、`test/tools/**`、`test/commands/**` -- 覆盖 I/O 矩阵全部行与下列 AC -- 可执行证据。

- `test/seams/write-port.test.ts` -- 补混合表整表拒收、items 为空、恰一条 rejected；补句柄不可用的 E_GATE_DOWN；补同表重复断言的幂等 -- 表级原子性。
- `test/load/commands.test.ts` -- 补一条经真 `apply()` 挂载的 `/omw pred promote` 成功用例 -- 生产接线。
- `test/seams/config.test.ts` -- 补 `tbox.maxNewPredsPerDay` 默认值与边界 -- ADR-26。
- `test/store/templates.test.ts` -- 补行形状不符时抛错而不是丢行 -- 读故障不伪装成空结果。
- `test/seams/write-port.test.ts` -- 补多 op 表每 op 一条 decision、dispose 排空 -- 账本与卸载。
- `test/seams/runtime-write.test.ts` -- 补写面装配：`ensureSchema` 失败与只读句柄两种状态下 `runtime.write === undefined`，`/omw pred promote` 与 `remember` 均不落库 -- 第 2 轮评审的 high（盲审①/边界③）。
- `test/store/commits.test.ts` -- 补表内谓词规划：同表两个 `pred` op、`pred`+断言、断言先于 `pred` 三种形态都只插一条 `pred` 且整表成功 -- 盲审②/边界②。
- `test/store/commits.test.ts` -- 补提升后同表断言按新基数推导键（旧基数四段 vs 新基数三段） -- 边界⑥。
- `test/core/patch.test.ts` -- 补 multi 谓词缺 `obj` 整表拒收、`obj` 规范化后为空、`obj` 超 200 码点、`obj` 含控制字符四条 -- 边界①⑧。
- `test/store/schema.test.ts` -- 补种子写入是单事务：中途失败后注册表为空，且成功路径写一条 `write` 审计 -- 盲审⑨。
- `test/store/queue.test.ts` -- 补关闭态、深度上限、单任务超时三条 -- 盲审⑥。
- `test/store/templates.test.ts` -- 补 `Number('')`/`'0x10'`/`'1e3'` 抛错 -- 盲审⑪。
- `test/core/tool-errors.test.ts` -- 补脱敏：`assertion:Elliott:id:12` 原样保留，`id: 12`、`existing_id: 3`、「节点 12」「冲突节点 4」被剥离 -- 盲审⑩/边界⑦。
- `test/lint/layers.test.ts` -- 补三条新静态门的负向 fixture（write-authority / tql-owner / exists-owner），并覆盖 `batchInsert`/`insertWithId`/`upsertWithId`/`patchPayload`/`updateVector`/`tqlMut` 六个写令牌 -- 验证层 V1、盲审/边界「门只匹配 3 个字面量」。
- `test/seams/memory-tools.test.ts` -- 补 `--reason` 内含 `--multi` 字样不改变基数、未识别 token 不静默进 `reason`、`/omw PRED PROMOTE` 与全小写同效三条 -- 边界⑪⑫⑬。
- `test/core/patch.test.ts` -- 补补丁表 schema 边界：0 个 op、51 个 op、`subj` 恰 200 码点与 201 码点（含 emoji 代理对） -- 盲审⑫。

**Acceptance Criteria:**
- Given 空库与已注册的 `remember`，when 提交一条 `pref`（Elliott / reply_style / concise），then 事务提交成功，`mem_key` 为 `pref:Elliott:reply_style:concise`，节点带 `valid_from` 与 `active_slot=1`。
- Given 干净安装（doctor 全绿），when 首次 bootstrap，then 只建 `(mem_key,active_slot)` 唯一索引、`(mem_key,valid_from)` 普通索引与 10 个种子谓词，不建其他 kind 的索引。
- Given 同键同值，when 再写，then 不产生第二条未失效节点并返回既有版本。
- Given 二值谓词（无 `obj`），when 写一条 `persona_state`，then `mem_key` 为三段且受同一唯一索引约束。
- Given 同键不同值绕过 supersede 插入，then 数据库抛唯一约束，工具返回 `E_CONFLICT` 而非裸异常。
- Given 3 个 op 且第 3 个非法，then 前两个也不落库，另落一条 `rejected`。
- Given 表外谓词，then 同事务建 `pred`（multi/candidate/model）+ 断言 + `predicate_new` flag，且不自动 supersede 旧版本。
- Given 用户 `kind=pred` 提升，then 旧节点失效 + 新节点生效 + 一条 `decision`，且可按 `op_id` 撤销（账本字段齐全）。
- Given 非法谓词名，then 整表拒收并落 `rejected`。
- Given 当日已建 20 个新谓词，then 第 21 个不建 pred，断言降级为 `scene` 并写一行审计。
- Given ≥200 次正常写入，then 写事务 p95 ≤10ms。
- Given 只读句柄（doctor），when 启动，then 不建索引、不写种子、不写账本。
- Given 一张表同时含可写 op 与同键冲突 op，then 整表不落库（含前序 op）、恰落一条 `rejected`、返回 `E_CONFLICT` 且 `items` 为空。
- Given 同表两次提同一断言，then 第二次按既有版本处理，整表成功且只有一条活动版本。
- Given 唯一键冲突导致的失败，then `items` 为空，且响应文本不含任何节点 id。
- Given 库句柄不可用（读或写失败），then 返回 `E_GATE_DOWN`、`items` 为空、审计 `mem_keys` 为空，而不是 `E_CONFLICT`。
- Given 用户提升一个已有候选谓词，then 新节点保留原 `aliases` 与 `evidence_count`，账本 `from/to` 记全。
- Given 同一毫秒内二次提升同一谓词，then 不撞唯一索引（失效位取 `max(nowMs, 已有失效位+1)`）。
- Given 一张表创建两条断言，then 恰落两条 `decision`（每 op 一条）。
- Given 经真实 `apply()` 挂载，when `/omw pred promote mood --single --reason 探针`，then 返回 success 且 `pred:mood` 为 `single`。
- Given `parseConfig({})`，then `tbox.maxNewPredsPerDay === 20`，且 `0` 与 `1.5` 被 schema 拒收并点名该键。
- Given `dispose()` 时队列仍有任务，then 先排空再关库，不出现「已关库的写入」。
- Given `ensureSchema` 失败或库句柄只读，when 启动完成，then `runtime.write === undefined`，`remember` 与 `/omw pred promote` 都不落库（工具面返回 `E_GATE_DOWN`，命令面报不可用）。
- Given 一张表内出现两次同一新谓词（两个 `pred` op、`pred`+`assert`、或 `assert` 先于 `pred`），then 只插一条 `pred` 节点，整表成功，不撞唯一索引。
- Given 同一张表里 `pred` 提升与 `assert` 混排，then `assert` 用**表内提升后**的基数推导键（`single` 出三段键），不是已提交历史的旧基数。
- Given `multi` 谓词但 op 缺 `obj`，then 整表拒收 + 一条 `rejected`，不产生「无 obj 三段 + 有 obj 四段」两条 live。
- Given `obj` 超过 200 码点、含控制字符、或规范化后为空，then 整表拒收 + `rejected`，`E_BOUNDARY` 点名是哪个字段。
- Given 补丁表 0 个 op 或 51 个 op，then schema 拒收，不进入规划；`subj` 恰 200 码点接受、201 码点拒收（按码点计，emoji 算 1）。
- Given 边界拒收（解析失败或校验失败），then `rejected` 与普通提交走**同一个队列任务**，不出现「队列内提交与队列外拒收交错」。
- Given 一张混合表（含可写 op 与冲突 op），then 整表不落库、恰落一条 `rejected`、返回 `E_CONFLICT` 且 `items` 为空 —— 预检与引擎两条冲突路径的 `items` 形状必须相同。
- Given `dispose()` 时队列仍有任务或仍在跑，then `await` 其返回的 promise 会等到排空并关库，两个生产调用点都不丢弃该 promise。

## Spec Change Log

- 2026-11-23 — 第 1 轮评审（60 条发现，47 条判 bad_spec，触发点：混合补丁表先提交后判冲突，探针 12→14 节点、返回 ok:false、无 rejected）。修订：补 10 条 AC、5 条测试任务，并在 Design Notes 定死表级原子性、subj 校验、pref/persona_state 负载、origin 口径、归一化算法、decision_kind、队列内规划、op_id/rejected 键、提升保留词表、基数变更挂 flag、审计 code、静态门全令牌、节点 id 禁出境、占位码入词汇、dispose 排空、读故障抛错。已知坏状态（已避免）：半提交、items 谎报 created、模型响应夹带节点 id。KEEP：幂等 bootstrap 与两索引、唯一冲突翻译、三级队列、字面量预编译模板、pred/flag/decision 负载与 10 种子、覆盖率 85% 的测试密度、CRLF 用例修正。

- 2026-11-23 — 第 2 轮评审（51 条发现，37 条判 bad_spec；四层回执 blind 18 / edge 13 / verify 8 / intent 17，同源合并后 51 条）。触发点：`ensureSchema` 失败仍向命令暴露写路径、`plannedPreds` 不登记 `op:'pred'` 导致同表二次插入整表回滚、边界拒收的 `rejected` 写在队列外、`NODE_ID_TEXT` 改写合法 `mem_key`。修订：<intent-contract> 未动（本轮无 intent_gap）；补 9 条 AC（AC23–AC31）与 13 条测试任务，新增 Design Notes 9 段（写面装配、表内谓词规划、拒收同队列、脱敏规则、队列生命周期、提升保留词表、种子单事务、覆盖率口径、p95 判据）。已知坏状态（已避免）：只读句柄下 promote 落库、同表重复 `pred` 插两次、`assertion:Elliott:id:12` 被脱敏成 `<id>`、`rejected` 与提交交错。KEEP：幂等 bootstrap 与两索引、唯一冲突翻译、三级队列、字面量预编译模板、`pred`/flag/decision 负载与 10 种子、表级原子性的预检位置、`norm_version=1` 算法、`decision_kind` 字段名、`op_id` 表内序号、测试密度（21 文件 172 用例）。
- 2026-11-24 — 第 3 轮评审（42 条发现：blind 18 / edge 9 / verify 6 / intent 若干，同源合并后 42 条；判 patched 32、deferred 6、rejected 4，无 intent_gap、无 bad_spec，故 `review_loop_iteration` 不增）。本轮未改 <intent-contract>，也未新增 AC —— 上一轮补的 AC23–AC31 已覆盖这些缺口，缺的是测试与几处实现口径，故走 patch 分支而非 bad_spec 回流。修订：① 代码补 20 处（同基数提升补 `decision`、队列超时后 `poisoned` 停用、lane 饥饿保底 `STARVATION_BOUND=8`、只读句柄由 `TDB_READ_ONLY` 自判、dispose 不二次关库、`rejected` 键进程内序号、`toErrorId` 不抛、`flag:predicate_rekey` 加表内序号、`MODEL_PREDS_SINCE_QUERY` 加 live 过滤、`remember` 参数广告出补丁表、`cause` 按 caller 分 `conversation`/`tool`、同表重复声明合并 aliases、降级 scene 进 `seen`、提升保留原 payload、`recording-ctx` 异步 dispose、`index.ts` cleanup 返回 promise、`assertClosedOutcome` 陈旧注释、`pred` 前缀精确匹配、`describeSuccess` 计 promoted/unchanged、删除 write-port 里重复的中文文案）；② 测试补 6 组（AC13 混合表、组合缝 `remember-composed`、脱敏边界、`test/ops/audit.test.ts`、日上限从 config 到 planner、engine 无 id 的返回形状）；③ 文档修 3 处（Code Map 的 `findModelPredsSince`、Tasks 的测试文件落点、README 的边界段）。已知坏状态（已避免）：成功的 promote 报「写入 0 条新事实」、超时后仍在飞的事务上再开新写、doctor 在排空中途删 scratch、同毫秒两条被拒补丁撞键丢证据。KEEP：幂等 bootstrap 与两索引、唯一冲突翻译、三级队列、字面量预编译模板、`pred`/flag/decision 负载与 10 种子、表级原子性的预检位置、`norm_version=1` 算法、`decision_kind` 字段名、`op_id` 表内序号、拒收与提交同队列、覆盖率阈值行 80/分支 70。

## Review Triage Log

### 2026-11-23 — Review pass 1
- verdicts: 60 findings — high 7, medium 35, low 18, maybe-false 0（第 2 轮重算表头，见 pass 2 最后一条）
- routes: bad_spec 51, patch 0, defer 3, reject 6（存在 bad_spec，按级联只执行规格返修）
- findings:
  - `[high]` `[bad_spec]` 混合补丁表先提交后判冲突：可写 op 落库、返回 ok:false/E_CONFLICT、无 rejected（blind）— 探针：12→14 节点、断言可读回、rejected 0；tools.ts:345 先 commit，:383 才判 conflict
  - `[medium]` `[bad_spec]` pref 的 payload `key` 存了含值的 mem_key，改值即换身份（blind）— 规格未定义 pref payload，需在 Design Notes 定形
  - `[medium]` `[bad_spec]` persona_state 用断言形状，未记录与 data-model dims 的偏差（blind）— 规格需明确 2.1 的占位形状与 Epic 7 的 dims
  - `[medium]` `[bad_spec]` 断言恒写 origin='observed'，schema 无 falsifier（blind）— tbox.ts:238；规格需声明 2.1 只收观测
  - `[medium]` `[bad_spec]` 归一化把符号替成空格，`C++`/`C#` 判同值而静默丢弃（blind）— patch.ts:92；规格需写明算法与后果
  - `[medium]` `[bad_spec]` 归一化算法与 data-model「去标点」不一致却同用 norm_version=1（blind）— 规格需定死算法并说明版本语义
  - `[medium]` `[bad_spec]` subj 原样拼键，含 `:` 可与四段键重合、大小写各成一条活版本（blind）— patch.ts:106-116；需校验规则
  - `[medium]` `[bad_spec]` 规划在队列之外，plan→commit 非原子、日上限可被并发突破（blind）— 规格需要求 plan+commit 同处一个队列任务
  - `[low]` `[bad_spec]` op_id=`<ms>:<36^6 random>`，同表多 op 可撞键，合法补丁被误判冲突（blind）— decisions.ts:44-46；需表内序号
  - `[medium]` `[bad_spec]` 提升谓词丢弃 aliases 与 evidence_count，账本 from 不全（blind）— 规格需要求提升保留词表与计数
  - `[medium]` `[bad_spec]` 基数变更后旧键成为孤儿活版本，无 rekey 决策（blind）— 需在 2.1 明确「不自动改写、留给 2.3/迁移」并挂 flag
  - `[medium]` `[bad_spec]` rejected 写失败被吞、无日志（blind）— 规格需要求失败至少落一行 OMW_* 日志
  - `[low]` `[bad_spec]` write 审计行无 code/reason，2.6 无法分因计数（blind）— 需加 code 字段
  - `[low]` `[reject]` elapsed_ms 计整条调用而非事务（blind）— AC 的判据是测试测量的服务端 p95（更严），审计值仅作参考，不构成缺陷
  - `[medium]` `[bad_spec]` dispose 立即关库、不等队列排空（blind）— runtime.ts:260-267；需先 idle() 再关
  - `[medium]` `[bad_spec]` 写权门只匹配 3 个字面量，bootstrap 与两个 Epic-1 直写豁免未写进规格（blind）— check-layers.mjs:79
  - `[low]` `[bad_spec]` live-filter 门匹配 `$exists` 过宽，会误伤 `$exists:true`（blind）— check-layers.mjs:102
  - `[low]` `[bad_spec]` Code Map 的模板函数名与实现不符、filters.ts 延后未记（blind）— 规格需同步
  - `[medium]` `[bad_spec]` 占位工具返回 E_NOT_IMPLEMENTED，不在封闭工具码内（blind）— 需把占位码纳入词汇表
  - `[low]` `[bad_spec]` core/tool-errors 的映射是死代码、store 层说工具码（blind）— 需下沉映射或删除死码
  - `[medium]` `[bad_spec]` remember 入参 schema 无补丁表形状，输出 schema 无校验（blind）— 需补 JSON Schema 并在测试里断言
  - `[medium]` `[defer]` 明文 PII 进 mem_key/审计/拒收负载，脱敏属 2.2（blind）— 2.2 交付前不得宣称「默认导出不含」
  - `[medium]` `[bad_spec]` 测试缺口：AC12 无启动级用例、无混合表、无配置默认值（blind）— 需补
  - `[medium]` `[bad_spec]` toStoredNode 静默丢行，读故障被当作空结果（blind）— templates/assertions.ts:55-73
  - `[low]` `[bad_spec]` ensureSchema 注释与只读用例自相矛盾（blind）— 需改注释
  - `[medium]` `[bad_spec]` subj 含 `:`/空白（edge）— 同 blind 第 7 条
  - `[high]` `[bad_spec]` 混合表先 commit 后判冲突（edge）— 同 blind 第 1 条
  - `[medium]` `[bad_spec]` 唯一键失败后 items 仍报 created（edge）— tools.ts:360 先建 items、:373 才判失败
  - `[medium]` `[bad_spec]` WRITE_TOKENS 缺 batchInsert/insertWithId/upsertWithId/patchPayload/updateVector/tqlMut（edge）— 门禁可被绕过
  - `[medium]` `[bad_spec]` 行形状不符时静默丢行（edge）— 同 blind 第 24 条
  - `[low]` `[bad_spec]` op_id 同毫秒同随机撞键（edge）— 同 blind 第 9 条
  - `[medium]` `[bad_spec]` 同毫秒二次提升写同一失效位，撞唯一索引（edge）— tbox superseded slot 需 max(nowMs, slot+1)
  - `[low]` `[bad_spec]` `--single --multi` 后者静默覆盖（edge）— commands.ts:294-299
  - `[low]` `[bad_spec]` 同毫秒同补丁的 rejected 键相同，第二条丢失（edge）— assertions.ts:96
  - `[medium]` `[bad_spec]` 同表内重复同一断言两次插入，整表被唯一索引回滚（edge）— plannedKeys 只增不查
  - `[high]` `[bad_spec]` 预检冲突返回 ok:false 却不落 rejected（edge）— 同 blind 第 1 条
  - `[medium]` `[bad_spec]` 边界拒收路径的 recordRejection 未包 try，库不可用时裸 reject（edge）— tools.ts:322-330
  - `[medium]` `[bad_spec]` 门只匹配 3 个字面量（edge）— 同 blind 第 16 条
  - `[medium]` `[bad_spec]` `/omw pred promote` 生产接线（index.ts:121）无用例，删掉仍全绿（verify）— 需补真 apply 挂载用例
  - `[medium]` `[bad_spec]` tbox.maxNewPredsPerDay 无默认值与边界测试（verify）— 需补 config 用例
  - `[medium]` `[bad_spec]` 读失败应 E_GATE_DOWN，但 templates:97 的 rethrow 未被测（verify）— 需补
  - `[medium]` `[defer]` schema 失败→不注册工具的分支无端到端用例，需先抽出 bootstrap 接缝（verify）
  - `[high]` `[bad_spec]` 混合表部分提交（verify）— 同 blind 第 1 条
  - `[medium]` `[bad_spec]` 唯一键失败后 items 报 created（verify）— 同 edge 第 3 条
  - `[medium]` `[bad_spec]` 引擎原文进模型响应，含节点 id（verify）— assertions.ts:151 → tools.ts:376；AD-3 禁止
  - `[low]` `[bad_spec]` 同毫秒重复拒收只落一条（verify）— 同 edge 第 9 条
  - `[high]` `[bad_spec]` 意图 R1（表级原子）未被实现，实测 R2a（intent）— 同 blind 第 1 条
  - `[high]` `[bad_spec]` 冲突不落 rejected（intent）— 同 blind 第 1 条
  - `[high]` `[bad_spec]` ok:false 与「已改状态」并存（intent）— 同 blind 第 1 条，三处同源
  - `[medium]` `[bad_spec]` 每 op 一条 decision 未测（intent）— 需一条多创建表用例
  - `[low]` `[reject]` decision 字段名 decision_kind 偏离 data-model 的 kind（intent）— decisions.ts:9-11 已注明理由，node kind 必须是 decision
  - `[medium]` `[bad_spec]` 「所有 commitTransaction 经队列」实为「新写路径经队列」（intent）— 需具名例外并写进规格
  - `[low]` `[reject]` AC12 的被测对象是 ensureSchema 而非整次启动（intent）— doctor 已有既有用例覆盖活文件不变
  - `[medium]` `[defer]` schema 失败分支无用例（intent）— 同 verify 第 4 条
  - `[low]` `[reject]` 日上限只计模型提案（intent）— 种子与用户登记非「当日新建」，口径合理
  - `[low]` `[reject]` p95 测的是整条 remember（intent）— 比「写事务」更严，非缺陷
  - `[medium]` `[bad_spec]` 两种 E_CONFLICT 的 items 形状不同（intent）— 同 edge 第 3 条
  - `[low]` `[reject]` promote 只发单 op 表（intent）— 用户面本就只提升基数，合规
  - `[low]` `[bad_spec]` 审计 outcome 词汇比意图宽（intent）— 随 blind 第 13 条一并定形
  - `[low]` `[bad_spec]` rejected 键边界（intent）— 同 edge 第 9 条
### 2026-11-23 — Review pass 2
- verdicts: 51 findings — high 6, medium 28, low 17, maybe-false 0（四层：blind 18 / edge 13 / verify 8 / intent 17，同源合并后 51 条）
- routes: bad_spec 37, patch 10, defer 3, reject 1（存在 bad_spec，按级联仍只执行规格返修，patch 项作废待第 3 轮重推）
- findings:
  - `[high]` `[bad_spec]` ensureSchema 失败或只读句柄时写面仍暴露：writeDeps 无条件创建，/omw pred promote 绕过 schemaReady 守卫落库；writable:false 被丢弃（blind/edge）
  - `[high]` `[bad_spec]` planPatch 的 plannedPreds 不登记 op:'pred'，同表两个 pred op、pred+断言、断言先于 pred 都会二次插入撞唯一索引，整表回滚（blind/edge）
  - `[high]` `[bad_spec]` 边界拒收与解析失败的 rejected 写入在队列之外，与队列内提交交错，「单写入口」不成立（blind/edge）
  - `[high]` `[bad_spec]` 冲突裁判从引擎面搬到规划面：工具面 unique→E_CONFLICT 在生产路径几乎不可达，表级原子性只在规划面成立（intent）
  - `[high]` `[bad_spec]` 预检判冲突后直接返回，不落 rejected；ok:false 与「已改状态」并存（intent）
  - `[high]` `[bad_spec]` NODE_ID_TEXT 的裸 id 分支改写合法 mem_key（assertion:Elliott:id:12 → <id>），且不匹配引擎中文文案「节点 12 / 冲突节点 4」（blind/edge）
  - `[medium]` `[bad_spec]` multi 谓词缺 obj 时 deriveMemKey 只出三段键，与带 obj 的四段键并存两条 live，无 obj 那条永远匹配不到去重（edge）
  - `[medium]` `[bad_spec]` obj 缺长度与控制字符校验（subj 有），键可含裸控制字符或数千字符（edge）
  - `[medium]` `[bad_spec]` assert 读到本表已退役的旧基数：同表内的 pred 提升后，断言仍按旧基数写键（edge）
  - `[medium]` `[bad_spec]` 同基数提升静默 continue，丢弃 aliases 与 evidence_count（blind）
  - `[medium]` `[bad_spec]` dispose() 的 promise 在 src/index.ts:122 与 test/degrade/vector-write.test.ts:30 被丢弃，卸载不等待排空（blind/edge）
  - `[medium]` `[bad_spec]` 写队列无关闭态、无深度上限、无单任务超时（blind）
  - `[medium]` `[bad_spec]` write 审计行在事务外、失败被吞、elapsed_ms 用 Date.now() 而 ts 用注入时钟（blind）
  - `[medium]` `[bad_spec]` rejected 节点永久保留原始补丁，与 deferred: [] 矛盾（PII 与补丁体积无归宿）（blind）
  - `[medium]` `[bad_spec]` bootstrap 十条种子逐条 insert，无事务无审计，中途失败留半个注册表；幂等只看行数（blind）
  - `[medium]` `[bad_spec]` PATCH_TABLE_SCHEMA 的 ops 无 minItems/maxItems（core 限 1..50），subj.maxLength 按 UTF-16 计而 core 按码点（blind）
  - `[medium]` `[bad_spec]` remember 入参 schema 未广告补丁表形状，PRED_OP_SCHEMA 广告了模型永远用不到的 op:'pred'（blind）
  - `[medium]` `[bad_spec]` 多条 AC 在最关键的边界无用例（subj 含 ':'、>200 码点、normalizeObjectText/normalizeSubject/deriveMemKey/startOfLocalDayIso 无直测、无 >50 op、无提升种子谓词）（blind）
  - `[medium]` `[bad_spec]` 三条新静态门（write-authority / tql-owner / exists-owner，scripts/check-layers.mjs:210-251）无负向 fixture，整块删掉套件仍绿（verify）
  - `[medium]` `[bad_spec]` 模型写 op:'pred' 的 E_BOUNDARY 守卫（src/core/patch.ts:435）无用例，删掉该行套件仍绿（verify）
  - `[medium]` `[bad_spec]` subj/obj 边界拒收（src/core/patch.ts:142-149、:526-527、:610-611）无用例，删掉 ':' 检查可伪造四段键（verify）
  - `[medium]` `[bad_spec]` 日上限作用域（src/core/patch.ts:531-535 与 :582 的 newPreds）无用例，把 usedToday 判断提到 info===null 之外或删 newPreds+=1 套件仍绿（verify）
  - `[medium]` `[bad_spec]` 同基数提升的 no-op 分支（src/core/patch.ts:452-457、src/seams/commands.ts:313）完全未覆盖（verify）
  - `[medium]` `[bad_spec]` /omw pred promote 的生产接线（src/index.ts:121）无用例，删掉仍全绿（verify）
  - `[medium]` `[bad_spec]` tbox.maxNewPredsPerDay 无默认值与边界测试（verify）
  - `[medium]` `[bad_spec]` 读失败应 E_GATE_DOWN，但模板解包抛错未被测（verify）
  - `[medium]` `[bad_spec]` 覆盖率阈值只在 pnpm test:coverage 生效，pnpm lint / pnpm test 与 CI 都不跑；仓库无 .github/**（blind）
  - `[medium]` `[bad_spec]` 写事务 p95 ≤10ms 成为机器速度硬门（test/store/perf.test.ts:19-38），CI 抖动即红（blind）
  - `[medium]` `[bad_spec]` 「所有 commitTransaction 经队列」实为「新写路径经队列」，种子写入与 rejected 写入的例外未写进规格（intent）
  - `[medium]` `[bad_spec]` 两种 E_CONFLICT 的 items 形状不同（预检冲突 vs 引擎冲突）（intent）
  - `[medium]` `[bad_spec]` 契约层面：diff 在对齐被 Design Notes 二次解释后的意图，而非 <intent-contract> 原文（intent）
  - `[low]` `[bad_spec]` op_id 与 rejected 键在同毫秒内可撞（decisions.ts:47-51、assertions.ts:100-117）（blind）
  - `[low]` `[bad_spec]` write 审计行缺 code，2.6 无法分因计数；outcome 词汇比意图宽（blind）
  - `[low]` `[bad_spec]` ensureSchema 注释与只读用例自相矛盾（blind）
  - `[low]` `[bad_spec]` 占位工具返回 E_NOT_IMPLEMENTED，不在封闭工具码内（blind）
  - `[low]` `[bad_spec]` E_BUDGET/E_TIMEOUT/E_DEGRADED 在 src/core/tool-errors.ts:16-24 声明但无生产者（blind）
  - `[low]` `[bad_spec]` pass 1 表头计数（high 5 / medium 31 / low 16 / false 8）与正文（high 7 / medium 35 / low 18）不符，6 行路由写成 [false]（blind）
  - `[low]` `[patch]` 模板行解包用 Number()，接受 ''/'0x10'/'1e3'（src/store/templates/assertions.ts:72-75）（blind）
  - `[low]` `[patch]` remember 的 DESCRIPTIONS 未解释降级与日上限（src/seams/tools.ts:222-227）（blind）
  - `[low]` `[patch]` PRED_OP_SCHEMA 对模型广告 op:'pred'，模型提交必得 E_BOUNDARY，提示词与能力不符（blind）
  - `[low]` `[patch]` 去重（deduped）路径的审计行带着未写入的 mem_key（src/seams/tools.ts:431-435）（edge）
  - `[low]` `[patch]` 命令分发用小写判断、解析用原文，/omw PRED PROMOTE 被识别后仍报无法解析（src/seams/commands.ts:336-340）（edge）
  - `[low]` `[patch]` --reason 文本里的旗标字样被当基数旗标，整条被拒（src/seams/commands.ts:291-298）（edge）
  - `[low]` `[patch]` --reason 之后的杂项被吞进 reason，leftover 检查永不触发（src/seams/commands.ts:296-304）（edge）
  - `[low]` `[patch]` core/tool-errors 的映射是死代码，store 层在说工具码（blind）
  - `[low]` `[patch]` rejected 写失败被吞、无日志（blind）
  - `[low]` `[patch]` 同基数提升的 no-op 却写 decision（账本记了一次未发生的变更）（patch）
  - `[medium]` `[defer]` 明文 PII 进 mem_key/审计/拒收负载，脱敏属 2.2（blind）
  - `[medium]` `[defer]` rejected 节点的保留期限与清理策略未定，属 2.2/2.3 治理范围（blind）
  - `[low]` `[defer]` store/filters.ts 与对象过滤器延后到 2.5（保持延后，Design Notes 已记因）（blind）
  - `[medium]` `[reject]` kind 混进业务身份：同一事实用 assertion 与 pref 各写一次即两条 live — 复核后判 false：data-model §2 的身份本就是 <kind>:<subj>:<pred>[:<obj_norm>]，跨 kind 去重不在 AD-3 之内；跨 kind 合并若要成立需改契约，属 2.3 的改写决策（intent）

### 2026-11-24 — Review pass 3
- verdicts: 42 findings — high 2, medium 23, low 12, false 2, maybe-false 3
- routes: patch 32, defer 6, reject 4（无 intent_gap、无 bad_spec，故走 patch + defer 分支）
- findings:
  - `[high]` `[patch]` 同基数提升只改 payload、不写 decision，与「每次成功写入恰一条决策」冲突（blind 1）— 已改：`src/core/patch.ts` 同基数 changed 分支现推一条 `decisionKind:'supersede'`，affected 含谓词键，from/to 记 cardinality/aliases/evidence_count；`test/core/patch.test.ts` 断言该行
  - `[medium]` `[patch]` 成功的 `/omw pred promote` 输出「写入 0 条新事实」，像失败（blind 2）— 已改：`src/seams/write-port.ts` 的 describeSuccess 增 promoted/unchanged 两个计数，文案变为「写入 N 条新事实，K 条谓词登记已更新」。
  - `[high]` `[patch]` 超时后 depth 已减、底层 run 仍在跑，idle() 提前 resolve，dispose 可在在飞写之上关库（blind 3 / edge 1）— 已改：`src/store/commits/queue.ts` 超时即 `poisoned = true`，停用队列，pending 槽位保持到 straggler 真正结算；`drain()` 与 `run()` 都拒绝后续任务。
  - `[medium]` `[patch]` 队列头注释承诺 lane 不饥饿，`takeNext()` 却每轮取全局最小 rank（blind 4）— 已改：新增 `STARVATION_BOUND = 8` 与 `Entry.skips`，被越过足够次数的条目优先；头注释改写为「优先级决定顺序，但不能无限推迟」。
  - `[medium]` `[patch]` `ensureSchema` 从不收到 `readOnly`，只读句柄在生产路径撞进 ensureIndexes 报 ok:false（blind 5）— 已改：`src/store/schema.ts` 自判 `TDB_READ_ONLY` 与 `failure.kind === 'read-only'` 两条路径都返回 `{ok:true, writable:false}`。
  - `[medium]` `[patch]` dispose 先 `port.dispose()`（内部关库）再 `closeDatabase(db)`，同句柄关两次且失败被吞（blind 6）— 已改：`src/seams/runtime.ts` 增 `closedByPort` 标记，端口关过就不再关。
  - `[medium]` `[patch]` `rejectedMemKey` 序号硬编码 1，同毫秒两条被拒补丁撞唯一索引、证据丢失（blind 7 / edge 2）— 已改：`src/seams/write-port.ts` 增进程内 `rejections` 计数器。
  - `[medium]` `[patch]` `toErrorId()` 在 `translate()` 内 throw，异常逃出只返回 WriteOutcome 的函数，跳过 rejected 与审计（blind 8 / edge 4）— 已改：`toErrorId` 返回 `number | undefined`，详情字段改可选；`test/store/engine.test.ts` 两条用例改为断言返回 `fields: []`。
  - `[medium]` `[patch]` 改基数 flag 键无序号，同毫秒两次提升同谓词撞键（blind 9 / edge 6）— 已改：键补表内序号 `flag:predicate_rekey:<名>:<ms>:<序号>`。
  - `[low]` `[defer]` `flag:predicate_new` 永不 resolve，`DecisionKind 'resolve_flag'` 无生产者（blind 10）— 属 2.3 的收敛语义；本故事只负责挂 flag
  - `[medium]` `[patch]` `MODEL_PREDS_SINCE_QUERY` 无 live 过滤，已 retire 的候选仍占日额度（blind 11 / edge 5）— 已改：查询加 `superseded_at: {$exists: false}`。
  - `[medium]` `[patch]` remember 的 patch 参数只有 `{type:'object'}`，ops 形状只在描述里；minItems/maxItems 无使用者（blind 12）— 已改：`src/seams/tools.ts` 把补丁表整表广告出来（ops 1..50、两条 op 的 anyOf、字段上限）。
  - `[low]` `[patch]` `assertClosedOutcome` 前挂着 `assertClosedReasons` 的陈旧注释副本（blind 13）— 已改：删掉重复段落。
  - `[medium]` `[patch]` 两处 switch 逐句重复同一批中文文案；`toolError`/`ToolError`/`isToolErrorCode`/`writeQueueError` 无生产调用者（blind 14）— 已改：`src/seams/write-port.ts` 删本地副本，refusalFor 直接用 `writeFailureError`，run() 用 `writeQueueError`；工具码构造器仍只被测试引用，保留为公开词汇表。
  - `[low]` `[patch]` `sub.startsWith('pred')` 让 `/omw predict` 也进 promote 再报「未知子命令」（blind 15）— 已改：改为 `sub === 'pred' || sub.startsWith('pred ')`。
  - `[medium]` `[patch]` `cause` 两处硬编码 `'tool'`，用户命令与工具写入无法区分（blind 16）— 已改：新增 `writeCause(caller)`，用户通道记 `conversation`、模型通道记 `tool`。
  - `[medium]` `[defer]` 写入节点 `vec_state` 恒 `pending`，2.1 无任何路径推到 ready（blind 17）— 补算属 Story 2.5；已在 README 边界段与 deferred 记录
  - `[medium]` `[patch]` 同表重复声明同谓词时第二个 op 的 aliases 被静默丢弃（blind 18）— 已改：合并别名并就地替换已生成的节点/改写，item 记 `promoted`；`test/core/patch.test.ts` 断言别名落到已存条目。
  - `[medium]` `[patch]` 同表重复同一降级 assert 产生两条相同 scene 键，撞唯一索引（edge 3）— 已改：降级分支也进 `seen` 去重，同值记 existing、异值整表拒收。
  - `[medium]` `[patch]` 提升用 `buildPredicatePayload` 重建 payload，live 上的额外字段被丢弃、时间戳被重置（edge 7）— 已改：同基数提升改为在原 payload 上合并 aliases/status，保留 recorded_at/valid_from 与既有字段。
  - `[medium]` `[patch]` recording-ctx 的 dispose 同步、不 await，doctor 在排空途中删 scratch（edge 8 / 9）— 已改：`src/cli/recording-ctx.ts` dispose 变 async 并逐个 await；`src/cli/doctor.ts` 与 `src/index.ts` 的 cleanup 都返回/等待该 promise。
  - `[medium]` `[patch]` `src/index.ts` 的 effect cleanup 丢弃 dispose 返回的 promise（AC31）— 已改：cleanup 直接 `return runtime.dispose()`。
  - `[medium]` `[patch]` 覆盖率阈值不在任何常规验证路径（verify G5）— 判 defer 更准确：仓库无 CI，`pnpm test:coverage` 已在 Verification 段作为必跑项；记为 deferred 待 Epic 收尾接 CI
  - `[medium]` `[patch]` 脱敏无边界测试，删掉 sanitizeEngineText 包装全套仍绿（verify G1）— 已补：`test/seams/write-port-failures.test.ts` 增两条，引擎消息内嵌「节点 5」「conflicting_id: 7」，断言答案不含 id 且是自写文案。
  - `[medium]` `[patch]` `assertClosedOutcome` 删掉后全套仍绿（verify G2）— 已补：新建 `test/ops/audit.test.ts` 六条，镜像 vector-off 对 assertClosedReasons 的先例。
  - `[medium]` `[patch]` 日上限没验证从 config 走到 planner，改成硬编码 20 仍全绿（verify G3）— 已补：`test/seams/remember-composed.test.ts` 用 `{tbox:{maxNewPredsPerDay:1}}` 挂载真 apply，第二条新谓词降级且 `pred:hobby` 不存在。
  - `[medium]` `[patch]` 组合缝无测试：tool→port→planner→engine→store 从未一次串起来（intent）— 已补：`test/seams/remember-composed.test.ts` 四条，全部经真 `apply` 挂载后调用 remember 并读回。
  - `[medium]` `[patch]` 混合表 AC13 在任何表面都无测试（intent）— 已补：`test/seams/write-port.test.ts` 增两条（整表不落库、两条冲突路径 items 形状相同）。
  - `[low]` `[patch]` spec Code Map 写 `countPredsSince`，真实导出是 `findModelPredsSince`（blind）— 已改：Code Map 更正。
  - `[low]` `[patch]` spec Tasks 列的三个测试文件不存在（blind）— 已改：改到真实落点（`test/seams/write-port.test.ts`、`test/core/patch.test.ts`、`test/seams/memory-tools.test.ts`、`test/seams/runtime-write.test.ts`）。
  - `[low]` `[patch]` README 仍写「remember 只按名注册占位」（blind）— 已改：边界段重写为 remember 已实现、recall/forget/explain 仍占位。
  - `[low]` `[patch]` 队列头注释与超时实际语义不符（blind 4 附）— 随饥饿保底一并重写。
  - `[low]` `[patch]` `engine.test.ts` 把「无 id 时抛错」钉成正确行为（blind 8 附）— 随第 8 条改为断言返回 `fields: []`。
  - `[low]` `[patch]` 队列用例名与断言相反（blind 4 附）— 已改为 `serves the higher lane first even when it arrived last`，并新增饥饿用例。
  - `[low]` `[defer]` 队列错误翻译不可达（verify G4）— `createWritePort` 不暴露 taskTimeoutMs，触发需 ≥30s 停顿；deferred 待 2.5 引入可注入时钟后补
  - `[low]` `[reject]` p95 只测 gateway 不含 parse/plan/queue/audit（intent）— 规格 Design Notes 明写「写事务 p95」以 gateway 为被测对象，测量口径与契约一致；整链耗时已在审计行 elapsed_ms 记录
  - `[low]` `[reject]` 零向量在 payload 无测试读回（intent）— AC1 与 AC5 断言的是 payload 形状与唯一索引行为；向量内容属 2.5 的召回面，此处读回不构成 2.1 的判据
  - `[false]` `[reject]` 「普通查询读不到 rejected」既无代码也无测试（intent）— 复核：rejected 节点的 kind 是 `rejected`，四个模板都按 kind 或 mem_key 前缀过滤，规划器的 lookup 只认 live 版本；该断言在 `test/seams/write-port.test.ts` 与 `test/store/templates.test.ts` 有覆盖
  - `[false]` `[reject]` `E_BUDGET` 无产出者即为缺陷（blind 14 附）— 复核：封闭词汇表允许声明未被本故事使用的码，AD-25 的清单本就跨故事；不构成 2.1 的缺陷
  - `[maybe-false]` `[defer]` 提升后谓词掉出当日计数、上限可被突破（edge 5 附）— 若成立为 medium；需验证「用户提升候选后当日新建计数是否回升」，settle 方法：连续两次升级同一候选并观察第 21 个新谓词是否被拒；本轮未构造该场景
  - `[maybe-false]` `[defer]` 超时后新任务仍可能开始（edge 1 附）— 若成立为 high；已由 `poisoned` 实现与 `test/store/queue.test.ts` 的「stops the queue after a timeout」覆盖，但「超时后再入队」的时序在真实调度下未复现
  - `[maybe-false]` `[defer]` `flag:predicate_rekey` 与 `flag:predicate_new` 的载荷字段未与 data-model §3 对齐（intent）— 若成立为 low，按 low 拒绝：flag 的 detail 是自由文本，data-model 未约束其形状

## Design Notes

**键形态与登记表冲突的读法。** 数据模型 §2 把 `pref` 归入 `<kind>:<稳定名>`，而 2.1 的 AC 给出四段示例。取读法：`pref` 与 `persona_state` 都是「带 subj/pred 的断言形状」，走 AD-3 的通用三段/四段形态（`pref:Elliott:reply_style:concise`、`persona_state:Elliott:mode`）；数据模型那句「pref 用 key」被读成「稳定名由 key 表达」。理由：把值放进键后改值就成了新身份，2.3 的版本链将永远不触发。

**`E_CONFLICT` 是新增码。** AD-25 的封闭五码没有冲突位，而 2.1 的 AC 要求「翻译成可读错误码」。做法：工具层加 `E_CONFLICT`，并在 Epic 复盘时把 AD-25 的清单补一行；不改规划文档本身（构建期不改契约层）。

**契约版本仍是 1。** 2.1 只新增索引与种子，双向兼容（旧代码忽略多余索引），因此不走 AD-14 的迁移快照流程；破坏性变更留给未来的版本号。

**`rejected` 只能补写。** 失败的事务已经中止，`rejected` 只能在随后的一次独立事务里落库——2.1 的 AC 要求「节点 0 + rejected 1」，这正是唯一可行的顺序。

**`$exists` 出现在模板字面量里。** 预编译 TQL 的首参必须是字面量（AD-15 的 AST 规则），无法把过滤器拼进去；因此 `superseded_at: {$exists:false}` 在每个模板里重复，并由静态门限定它只出现在模板目录。`store/filters.ts` 与对象过滤器等到 2.5 的检索路径再引入，避免出现无人使用的死代码（Epic 1 的 `NO_OP_CODES` 教训）。

**schema 失败不进入 no-op。** 只跳过工具注册并记 `OMW_SCHEMA_NOT_READY`，身份段照常注入（AD-18 的局部降级，不新增第四种状态）。

**补丁表形状（实现照此，不要另造）。**
```json
{"ops":[{"op":"assert","kind":"pref","subj":"Elliott","pred":"reply_style","obj":"concise"}],"reason":"用户明确要求"}
{"ops":[{"op":"pred","pred":"mood","cardinality":"single","aliases":[],"reason":"用户提升为单值"}],"reason":"…"}
```
`op=assert` 必填 `kind`（`assertion`/`pref`/`persona_state`）、`subj`、`pred`；`obj` 缺省即三段键。`op=pred` 只接受 user 调用方，`cardinality` 只允许 `single`/`multi`。两条路径共用同一张表、同一次事务。

**G0-4 不在本故事过闸。** 闭环需要「注入 + 召回」，分别由 2.4、2.5 交付；复盘 A4 的「首条故事过闸」假设了竖切，而用户已裁定一故事一 spec，因此 G0-4 在 2.5 交付后记录到 `gates/g0-4.json`，2.1 只交写入半环。

**零向量 + `vec_state: pending`。** 断言先以零向量落库，向量补写在后续故事接入（AD-19）；2.5 的召回必须用 `payloadFilter` 排除 pending，否则零向量会在 ANN 里互相聚集。


**表级原子性（第 1 轮评审的返修）。** 预检冲突在入队之前判定：任一 op 为 `conflict` 即整表拒收、落一条 `rejected`、`items` 置空；`commitPatch` 只在零冲突时执行。理由：探针证实旧实现会提交可写 op 再返回 `ok:false`，「一次写入要么全成要么全不成」不成立。

**subject 校验。** `subj` 先去首尾空白，长度 1..200，禁止 `:` 与控制字符；大小写敏感（人名）。非法即整表拒收。理由：旧实现原样拼键，`a:b` 可伪造四段键。

**负载形状。** `pref` 存 `{kind:'pref', mem_key, key:<pred>, value:<obj>, subj, active_slot, …}`——`key` 是稳定的偏好名，不是含值的 `mem_key`；`persona_state` 在 2.1 只存占位形状 `{subj, pred, value?}`，`dims{}` 由 Epic 7 写入，在此之前不参与召回与注入。

**origin 口径。** 2.1 只接受观测写入，`origin` 恒为 `observed`；`inference` 与 `falsifier` 属 Epic 4/6，schema 不收（I7 的闸门因此不在此被声明绕过）。

**归一化算法（norm_version=1）。** NFKC → 小写 → 标点与符号替为空格 → 压缩空白 → trim。符号差异（`C++` 与 `C#`）因此被视为同值，这是有意的形状不敏感，记录在此以免被当成 bug；换算法必须升 `norm_version` 并走 `ops/rekey`。

**decision 的字段名。** 节点 `kind` 必须是 `decision`（治理查询按它过滤），动作名落 `decision_kind`——这是唯一有意偏离数据模型字段清单的地方。

**队列内规划。** `planPatch` 与 `commitPatch` 在**同一个队列任务**里执行，读到的活动版本与提交之间没有窗口；日上限计数同批完成。

**op_id 与 rejected 键。** `op_id = <ms>:<表内序号>:<rand36>`；`rejected:<ms>:<digest>:<序号>`，同毫秒重复拒收不再撞键。

**提升与基数变更。** 提升保留旧词的 `aliases` 与 `evidence_count`，账本 `from/to` 记全；基数变更不自动改写既有键，挂 `flag(predicate_rekey)` 留给 2.3。

**审计与错误面。** `write` 行增加 `code`；工具响应在返回前剥离引擎文本里的节点 id；`E_NOT_IMPLEMENTED` 纳入封闭工具码清单（占位工具专用）。

**静态门。** 写令牌全集 = `insert|insertWithId|batchInsert|upsertWithId|patchPayload|updatePayload|updateVector|link|upsertEdge|commitTransaction|tqlMut`；`$exists` 只允许 `superseded_at: {$exists: false}` 这一形态出现在 `store/templates/**`；`store/schema.ts` 的 bootstrap DDL 与两个 Epic-1 载体（`store/meta.ts`、`store/vector-write.ts`）作为具名例外写进脚本。

**卸载与读故障。** `dispose()` 先 `await queue.idle()` 再关库；模板解包失败必须抛错，不得当作空结果。

**写面装配是一个开关，不是两处守卫（第 2 轮返修）。** `ensureSchema` 返回 `{ok, writable}`；**只有两者皆真**才创建 `writeDeps` 并把 `runtime.write` 暴露给工具面与命令面。`writable:false`（只读句柄）与 `ok:false`（建索引/种子失败）走同一条路径：`runtime.write === undefined`，工具面返回 `E_GATE_DOWN`，`/omw pred promote` 报「写面未就绪」。理由：探针证实旧实现只守工具注册，`/omw pred promote` 经命令面直接落库；只读句柄下 `ok:true` 还会让守卫失效。

**表内谓词规划看的是「表内状态」，不是提交历史（第 2 轮返修）。** `planPatch` 维护 `plannedPreds: Map<name, {cardinality, aliases, evidenceCount}>`：`op:'pred'` 先把新状态写进该表（占用名字），后续 `op:'assert'` 读表内状态而非 `readPredicateHistory`。同表第二次遇到已计划的谓词时不再产生插入。理由：旧实现只读已提交历史，同表两个 `pred` op 会二次 `inserts.push`，撞唯一索引整表回滚。

**拒收与提交同队列（第 2 轮返修）。** 解析失败、边界拒收、预检冲突三条路径的 `recordRejection` 都在写队列任务内执行，与普通提交共用同一串行序列。理由：AD-4 的「单写入口」若允许队列外裸写，提交与拒收会交错，读到的活动版本与写入顺序不可复现。

**节点 id 脱敏按 mem_key 边界切分（第 2 轮返修）。** `sanitizeEngineText` 先按 `\b[a-z_]+:[^\s:]+:[^\s:]+(:[^\s:]+)?` 保护 `mem_key` 片段，再剥离 `id\s*[:=]\s*\d+`、`existing_id\b`、`conflicting_id\b`，以及中文「节点 N / 冲突节点 N / 节点 ID N」。理由：旧规则里的裸 `id` 分支把 `assertion:Elliott:id:12` 改成 `<id>`，同时漏掉引擎自己的中文冲突文案。

**队列是可关闭的（第 2 轮返修）。** `close()` 之后 `run` 立即以 `E_GATE_DOWN` 拒绝；`pending` 有上限（默认 1000，超出即拒收并记 `OMW_WRITE_QUEUE_FULL`）；单任务有超时（默认 30s，超时记 `OMW_WRITE_TIMEOUT`，任务结果按失败返回但不中止已发出的引擎调用）。`dispose()` 的顺序固定为：`queue.close()` → `await queue.idle()` → `closeHandle()`，且返回的 promise 必须被调用方 `await`。

**提升保留词表与计数（第 2 轮返修）。** 同基数提升不是 no-op：仍要合并 `aliases` 与 `evidence_count`，但不写 `decision`（账本只记变更）。跨基数提升写一条 `decision`，`from/to` 含 `cardinality`、`aliases`、`evidence_count` 三个字段。

**种子写入是单事务（第 2 轮返修）。** 10 条种子在**一次** `commitTransaction` 里插入，末尾写一条 `write` 审计（`outcome:'bootstrap', code:'seed_install'`）。幂等判据从「行数」改为「按名逐个查 `findPredByName`」，因此中途失败不会留半个注册表。理由：旧实现逐条 `insert` 无事务，中途失败后重跑会跳过错插的谓词，注册表永久残缺。

**覆盖率是 DoD 的一部，要在 `pnpm test` 里可见（第 2 轮返修）。** `vitest.config.ts` 的 `coverage.thresholds`（行 80 / 分支 70）绑定到 `test:coverage`；本故事的 Verification 段要求**先跑 `pnpm test:coverage` 再跑 `pnpm test`**，两者都必须是证据的一部分。仓库当前没有 CI（`.github/**` 不存在），因此不声称「CI 会拦」。

**p95 判据必须可复现（第 2 轮返修）。** `test/store/perf.test.ts` 的断言改为「200 次写入的中位耗时 ≤ 2ms 且 p95 ≤ 10ms」，并在用例开头做一次 100 次预热；同时比较同一用例内 `insert` 基线与 `remember` 的比值（≤ 5×），使判据对机器速度不敏感。论文式地钉死绝对毫秒数会在慢机上随机红。

## Verification

**Commands:**
- `pnpm install --frozen-lockfile` -- expected: 成功（worktree 首次安装）
- `pnpm build` -- expected: tsc 无错误
- `pnpm lint` -- expected: 退出码 0；故意在 `src/core/` 写 `db.commitTransaction(` 时新增的门必须报错
- `pnpm test` -- expected: 全绿，含矩阵 11 行与 12 条 AC
- `pnpm test:coverage` -- expected: 行 ≥80%、分支 ≥70%（Epic 2 DoD；本轮记录基线）

**Manual checks (if no CLI):**
- 用临时 `DSH_HOME` 跑两次 `node lib/cli.js doctor --profile web`：两次都不新建索引/种子（只读路径），且第二次与第一次输出一致。
- 在真实宿主加载后调 `remember` 一次，确认 `audit-YYYYMMDD.jsonl` 出现一行 `write`，且 `omw.log` 无 `OMW_SCHEMA_NOT_READY`。

## Auto Run Result

**Status:** done

**What was built.** `remember` 从占位变成真的写路径：core 的 `planPatchTable` 把一张补丁表规划成节点、改写与账本草稿，`store/commits` 的单写队列把「规划 + 提交」放进同一个队列任务，一次 `commitTransaction` 落库；`(mem_key, active_slot)` 复合唯一索引强制「同键至多一条未失效」，冲突翻成 `E_CONFLICT` 并另落一条 `rejected`。谓词登记表是数据：10 个种子谓词随首次 bootstrap 一次事务写入，模型只能新建 `multi`/`candidate`，只有用户能用 `/omw pred promote <名> --single|--multi --reason <理由>` 改基数。写入节点带零向量与 `vec_state:'pending'`，向量补算留给 2.5。

**Changed files.** 新增 `src/store/{schema,tbox}.ts`、`src/store/templates/assertions.ts`、`src/store/commits/{engine,queue,assertions}.ts`、`src/core/{patch,decisions,tool-errors}.ts`、`src/seams/write-port.ts`；改 `src/seams/{tools,commands,runtime,config,json-schema}.ts`、`src/index.ts`、`src/ops/audit.ts`、`src/cli/{doctor,recording-ctx}.ts`、`scripts/check-layers.mjs`、`package.json`、`vitest.config.ts`、`README.md`；测试新增 24 个文件（`test/core/{patch,tool-errors}`、`test/store/{templates,tbox,schema,queue,commits,engine,perf}`、`test/seams/{write-port,write-port-failures,memory-tools,runtime-write,config,remember-composed}`、`test/ops/audit`）与 2 个 support（`test/support/{write-store,fake-registry}.ts`），并修掉 `test/load/inject.test.ts` 里一处与 CRLF 有关的测试构造缺陷。

**Findings.** 四层评审共 42 条：patched 32、deferred 6、rejected 4。
- patched 含 2 条 high：同基数提升不写 `decision`（现补一条 `supersede`）；写队列超时后仍可开始新任务（现处于 `poisoned` 状态，队列停用直到重启）。
- patched 的 medium 主要是：成功的 promote 报「写入 0 条新事实」；lane 饥饿无保底；只读句柄在生产路径被判成 `ok:false`；dispose 二次关库；`rejected` 键序号写死 1；`toErrorId` 抛异常逃出只返回 `WriteOutcome` 的函数；`flag:predicate_rekey` 键无序号；日额度把已失效候选算进去；`remember` 的 `patch` 参数没有广告出补丁表形状；`cause` 恒 `'tool'`；同表重复声明丢 `aliases`；同表重复降级产生同键 scene；提升时重建 payload 丢字段；`recording-ctx` 的 dispose 不 await（doctor 会在排空中途删 scratch）。另补了五组测试：AC13 混合表、tool→port→planner→engine→store 组合缝、脱敏边界、`assertClosedOutcome`、日上限从 config 到 planner 的接线。
- deferred 6 条：`flag:predicate_new` 永不 resolve（2.3 的账本语义）、写入节点 `vec_state` 恒 `pending`（2.5 的向量回填）、队列错误翻译在测试里不可达、提升后是否仍计入当日额度未验场景、超时与 straggler 的真实时序只在 fake timers 下验证过、两条 flag 的载荷字段未与 data-model §3 逐字段对齐。
- rejected 4 条：p95 只测 gateway（规格 Design Notes 明写以 gateway 为被测对象）；零向量在 payload 无读回（向量内容属 2.5）；`E_BUDGET` 无产出者（封闭词汇表跨故事）；「普通查询读不到 rejected」无代码（复核为误报，只认 live 版本的模板已覆盖）。另有 2 条 false 与 3 条 maybe-false 逐条给了理由。

**Follow-up.** 建议再跑一轮评审，重点验证三条：① 用户提升候选谓词后当日额度是否被重置（可能让 `maxNewPredsPerDay` 形同虚设）；② 写队列超时后 `poisoned` 在真实调度下的行为（目前只有 fake timers 证据）；③ 混合表在 port 层的完整时序（现有用例只断言不落库与 items 为空）。

**Verification.** `pnpm build` exit 0；`pnpm lint` exit 0（`layers: 32 个源文件，全部规则通过`，含本轮新增的 write-authority / tql-owner / exists-owner 三条门）；`pnpm test` 26 文件通过 1 跳过、307 passed 1 skipped；`pnpm test:coverage` exit 0，All files statements 83.87 / branches 72.75 / functions 87.94 / lines 86.39（阈值行 80、分支 70 均满足）；`test/store/perf.test.ts` 实测 `median=0.094ms p95=0.158ms n=200`，与 `insert` 基线比值 1.61×（判据：中位 ≤2ms、p95 ≤10ms、比值 ≤5×）。两条手工检查也做过：临时 `DSH_HOME` 连跑两次 `doctor --profile web` 均 5/5 通过、数据目录 `audit-*` 文件数为 0、库内 `nodes=0`/索引为空（只读路径确实不建索引不写种子）；真实 `apply()` 挂载后调 `remember` 一次，`audit-20261124.jsonl` 出现 `bootstrap seed_install` 与 `committed OK` 两行，`omw.log` 为空、无 `OMW_SCHEMA_NOT_READY`。
**Residual risk.** 尚未覆盖：`vec_state` 无路径转 `ready`（2.5 前写入的记忆只可按键读、不可语义召回）；`resolve_flag` 无生产者；覆盖率阈值只挂在 `test:coverage` 上，仓库无 CI，不会被自动拦。