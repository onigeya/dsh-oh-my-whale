# 架构改进清单

> 产出日期 2026-11-26。依据：`HEAD 1cefa2a` 与工作区实测。全量测试 635 处 `it()`（46 文件，含 2 处条件跳过）、静态门 97 文件全过。
> 这份清单只管**结构摩擦**；语义裁定仍以 `epic-3-readiness-2026-11-26.md` 为准，两者重叠的四处标了 [`merge`]。
> 每条都带：证据（file:line）、代价、改法、验收判据、工作量。按优先级自上而下做。

## 结论

代码的**深度本身不差**：降级状态机、审计三行、只读召回、单一注入出口都有真实落地与测试护住。摩擦集中在两类：

1. **一个人全包的 module**——`startRuntime` 459 行 / `createWritePort` 503 行 / `planPatchTable` 486 行。要搬它们必须独占工作区。
2. **同一语义写了多遍**——「当前版本」判据、业务键拼装、封闭词汇、可选宿主服务解析。这些可以逐个安全收口。

其中**只有一条是正确性风险**：`superseded_at` 非数字时，两处判据结论相反。它排在第一位不是为了架构好看，是因为它会读错数据。

## 基线（可复算）

| 指标 | 实测值 | 复算方式 |
| --- | --- | --- |
| 静态门 | 97 文件 / 全部规则通过 / 退出 0 | `node scripts/check-layers.mjs` |
| 层门测试 | 27 用例全过 | `pnpm exec vitest run test/lint/layers.test.ts` |
| 全量测试 | 635 处 `it()` / 46 文件 / 12,087 行（含 2 处按条件跳过） | `grep -c 'it(' test/**.ts` 逐文件累加 |
| src 体量 | 11,684 行 / 43 文件 | 按行计数，排除 `lib/` |
| 最大函数 | `createWritePort` 503 行、`planPatchTable` 486、`startRuntime` 459 | 花括号配对计数 |
| docs 体量 | 168.8 MiB / 4,394 文件 | 递归求和 |
| 其中第三方副本 | 148.4 MiB / 4,174 文件（**未被 git 跟踪**） | 路径含 `/imports/` |
| git 跟踪的 docs | 473 文件 / 20.3 MiB | `git ls-files docs` |

**两条被证伪的结论**（记录下来，避免下一轮再被当成事实）：

- 「静态门在干净树上就是红的」——不成立，实测 97/97 通过。看到的是并发会话未提交的中间态。
- 「码表标称八条实际十四处矛盾」——不成立。`ARCHITECTURE-SPINE.md:268` 已写明错误码分两层、两个封闭集不合并计算。

## 工作区状态：有人在同时改

审查期间工作区有另一个会话在实施 Epic 3 P0-1，未提交：

- 5 份 spec：`docs/implementation-artifacts/spec-e3p0-{1..5}-*.md`
- 8 个改动文件：`src/ops/audit.ts`、`src/ops/injection-audit.ts`、`src/seams/prompt-composer.ts`、`src/seams/runtime.ts`、`test/load/inject.test.ts`、`test/ops/audit.test.ts`、`test/ops/injection-audit.test.ts`、`test/seams/prompt-composer.test.ts`
- 文件时间戳实测：10:53 → 12:40 之间持续落笔，最近一次距我运行为 31 秒。

**因此本轮没有改动 `src/` 与 `test/`。** 往别人正在写的文件里塞改动会丢更新，这不是保守，是不可逆风险。下面标 `[blocked]` 的条目等那次改动落地后再做。

---

## P0：现在就做（不被并发写入阻塞）

### P0-1 「当前版本」只留一个判据　`中低`　`merge: P0-4`

**证据**

- `src/store/filters.ts:69` 用 `!Object.hasOwn(payload,'superseded_at')`——字段存在即退役，值为 `null` 也算退役。
- `src/seams/version-reader.ts:134,148` 用 `numberField(payload,'superseded_at') === undefined`——非数字才算退役，`null` 判在用。
- 同一语义的四份模板字面量：`src/store/templates/assertions.ts:22,43,53` 与 `src/store/templates/recall.ts:29`。其中只有 `recall.ts` 那一份被 `test/store/filters.test.ts:109-130` 与 `isLive` 对齐，另三份无人钉。

**代价**：`superseded_at` 取到 `null` 或字符串 `"0"` 时，两处结论相反——一条已被改写退役的记忆会在 `history` 里显示为在用，或反之。这是全清单唯一的正确性风险，其余都是维护性问题。

**改法**：把「当前版本」收成一处可判定的 payload 谓词（`isLive` 已是它的读侧形式），四份模板字面量从它派生，`version-reader` 不再自己判一次。

**验收**

1. 先补一条会红的测试：写入一条 `superseded_at: null` 的节点，断言 `isLive` 与 `version-reader` 给出**同一结论**。
2. `grep -rn "\$exists: false" src/` 的结果只出现在定义处，不再散在模板里。
3. `pnpm test` 全绿，`test/store/filters.test.ts` 与 `test/store/version-chain.test.ts` 都不改断言。

### P0-2 封闭词汇只留一份定义　`中低`　`merge: P0-5`

**证据**

- `src/core/tool-errors.ts:20` 定义封闭集合；`src/store/commits/queue.ts:89` 自建 `'E_GATE_DOWN' | 'E_TIMEOUT'`；`src/core/patch.ts:295` 又自建 `'E_BOUNDARY' | 'E_CONFLICT'`。同类字面量共 46 处、分布 9 个文件。
- `src/core/degrade.ts:172-182` 的 `EMBEDDING_FAILURE_KINDS` 手抄 `src/store/embedding.ts:15-27` 的六个 kind，注释自称 structurally identical 故免 cast。
- `isToolErrorCode`（`tool-errors.ts:44`）在 `src/` **零调用**，只有 `test/core/tool-errors.test.ts` 调用它。

**代价**：加一个码要同时改 3 处声明加 N 处字面量，且没有测试会因漏改失败。embedding 加第七个 kind 时类型系统不报错，`mapEmbeddingFailureKind` 落进 default 返回 `undefined`，降级链静默退化成「只 warn 不降级」。

**改法**：唯一一份词汇定义同时产出类型、判定函数与 store 侧可用的码；副本改为引用。`EMBEDDING_FAILURE_KINDS` 由 `embedding.ts` 派生而不是手抄。

**验收**：`grep -rn "'E_GATE_DOWN'" src/` 只命中一处；删掉 `EMBEDDING_FAILURE_KINDS` 后仍有代码用它（说明改成引用了），或它已被删除且测试仍绿；`pnpm lint` 通过（类型收窄是关键判据）。

### P0-3 删掉零消费者的浅接口　`低`

**证据**（全部经 grep 复核）

| 符号 | 位置 | 生产调用 | 结论 |
| --- | --- | --- | --- |
| `WRITE_OUTPUT_SCHEMA` | `src/seams/write-port.ts:189` | 0（全仓 1 处命中，仅定义） | 真契约挡在 `src/seams/tools.ts:92` 的另一个 schema 里 |
| `isToolErrorCode` | `src/core/tool-errors.ts:44` | 0 | 只有测试调用 |
| `EMBEDDING_FAILURE_KINDS` | `src/core/degrade.ts:172` | 0 | 测试零引用 |
| `composeStateTail` | `src/seams/prompt-composer.ts:416` | 0 | 只是 `planStateTail().text` 的一行包装 |

**代价**：`prompt-composer.ts` 28 个导出对 5 个类成员，读的人分不清哪个是契约、哪个是内窥镜；`WRITE_OUTPUT_SCHEMA` 与 `tools.ts:92` 的 schema 并存，模型要查两处才知道返回形状。

**改法**：删除前三者；`WRITE_OUTPUT_SCHEMA` 若本就是「准备接进工具输出」，则接上 `tools.ts` 而不是删。

**注意**：`composeStateTail` 与 `prompt-composer.test.ts:282` 有耦合，删它要同时改那条断言。`prompt-composer.ts` 当前**正被并发会话改动**，这一条实际应排到 P0-1 之后、并发落地再动。

### P0-4 可选宿主服务解析收敛成一个接缝　`低`

**证据**：同一件事四个实现、四种返回约定——

- `src/index.ts:140-151`：手写 shape 判定，返回 `registry | undefined`
- `src/seams/runtime.ts:787-806`：先 `ctx.get` 再退属性，`isToolRegistry` 类型守卫
- `src/seams/runtime.ts:818-827`：返回 `unknown`，调用方各自收窄
- `src/seams/runtime.ts:665-672`：`asSessionQuery` 再判，第三种守卫

**代价**：加一个宿主能力就要再吃一份 try/catch 与一种返回约定；「缺席即降级」的策略有四个版本，测试要分别覆盖。

**改法**：一个「按名取可选服务 + 一次形状窄化」的 module，四个调用点收敛。

**验收**：四处调用点只剩一处 `try { ctx.get(...) }`（grep `ctx.get` 命中数从 4 降到 1）；`pnpm test` 全绿。

**风险**：`runtime.ts` 与 `index.ts` 都在并发改动集合里。标 `[blocked]`，等那次落地。

---

## P1：需要独占工作区的大拆分

以下三条都要搬动百行级函数，且涉及的文件都在并发改动集合里。**必须等那次落地并提交后再做**，否则一定冲突。

### P1-1 装配中心拆成「探测 → 判定 → 组装」　`高`　`[blocked]`

**证据**

- `src/seams/runtime.ts:308-766`，`startRuntime` 独占 **459 行**，一个函数做完九件事：路径解析、审计门面与两个审计器、composer 构造、审计轮转、开库与快照、四级探针与闸门判定、契约盖章与 schema 引导、会话查询与三个 reader、向量策略与句柄组装。
- `src/seams/runtime.ts:414-425` 有 **12 个可变 `let`**（`db`/`sectionRegistered`/`tools`/`vector`/`write`/`evidence`/`version`/`recall`/`injection`/`retention`/`disposed`/`disposing`），顺序即契约。
- 该文件在最近 120 次提交里被改 **9 次**，全仓最高。
- 测试只能整机启动：`test/seams/runtime-write.test.ts:86,200,251`、`test/seams/runtime-audit.test.ts:53,219,354`。

**代价**：任何一处改动都要读完 841 行；单点行为无法隔离测试，每个用例都要开真数据库文件；12 个闭包变量顺序敏感，AI 无法局部修改。

**改法**：探测（开库 + 快照 + 三个探针，返回 `ProbeResult` 不写全局）、判定（`decideGates` 已是纯函数，不动）、组装（按判定结果调每个装配器，各自返回自己的句柄）三段各自成 module。

**验收**：`startRuntime` 降到 100 行以内；探针相关测试不再需要整机启动；`pnpm test` 全绿且用例数不减少。

### P1-2 写口拆成「校验 → 规划 → 提交」　`中高`　`[blocked]`

**证据**：`src/seams/write-port.ts:247-749`，`createWritePort` 独占 **503 行**，文件共 824 行。同一路径上还耦合着脱敏、审计、错误码映射（`writeFailureError`、`writeQueueError` 在 `src/core/tool-errors.ts:74,114`）。

**代价**：`write-port` 是 Epic 2 六个 story 的汇合点，改一个 story 的行为要先读完 503 行；脱敏与审计混在写入事务里，两者的失败语义不同（一个要拒收、一个只 warn）却写在同一个函数体内。

**改法**：按「校验并脱敏 → 规划（调用 `planPatchTable`）→ 提交（事务 + 审计行）」三段切开，每段一个 module。

**验收**：`createWritePort` 降到 150 行以内；`test/seams/write-port-failures.test.ts` 与 `test/seams/write-port.test.ts` 断言不改仍全绿。

### P1-3 `planPatchTable` 的六个分支收成单一产出物　`中高`　`[blocked]`

**证据**：`src/core/patch.ts:540-1025`，`planPatchTable` 独占 **486 行**（文件 1151 行，其中 297 行注释）。同一形状重复：`buildPredicatePayload` 4 次（`:647,702,741,866`）、`decisions.push` 6 次（`:661,716,765,840,958,999`）、`items.push` 12 次、`obj === undefined ? {} : { value: obj }` 6 次（`:911,970,981,992,1009,1020`）。

**代价**：改一处 ledger 形状要同时改 4–6 个分支；`test/core/patch.test.ts` 逐字段钉死 payload，另有 8 处断言钉死中文 `reason` 原文（如 `:236`、`:278`），任何重排先让 8 条变红——测试给的是回归成本而不是安全网。AI 定位「哪个分支产出这条 decision」要在 486 行里跳读 6 次。

**改法**：把「一个 op → (node|update) + decision + item」收成单一产出物，六个分支只填差异字段。

**验收**：`planPatchTable` 降到 150 行以内；`test/core/patch.test.ts` 的 45 条用例语义不变仍全绿（断言可以换写法，但覆盖的契约不能少）。

---

## P2：可以并行做，不阻塞任何人

### P2-1 业务键拼装与解读收进一个 module　`中`

**证据**：七个构造点加两处内联——`deriveMemKey`（`src/core/patch.ts:142`）、`predicateMemKey`（`src/store/templates/assertions.ts:68`，经 `src/store/tbox.ts:144` 再导出一次）、`evidenceMemKey`（`src/core/evidence.ts:211`）、`decisionMemKey`/`rejectedMemKey`（`src/core/decisions.ts:51,97`）、字面量 `CONTRACT_VERSION_MEM_KEY`（`src/store/meta.ts:21`）、内联拼接（`src/core/patch.ts:738,880`）。解读侧在 `src/seams/recall-reader.ts:306,385` 各自 `split(':')` 取末段；`test/support/evidence-commit.test.ts:36` 反过来把 key 拆开重建 payload。

**代价**：改一种键的形状要搜 7 个构造函数加 2 处内联，没有单一改动点；拆键靠字符串约定（assertion 禁 `:`、evidence 改用 `#` 绕开），这条规则没有任何共用校验；测试自己实现逆解析，等于在接口之外多一份隐式契约。

**验收**：`grep -rn "mem_key\`\|mem_key +" src/` 的构造点收敛到一处；`recall-reader` 不再 `split(':')`。

### P2-2 让测试只穿过接口　`中`

**证据**：`test/` 里 **55 处**直接 `db.insert(...)`（`test/seams/recall-reader.test.ts` 独占 29）；`test/support/write-store.ts:51-58` 因 `ensureIndexes` 私有而重抄两条索引 DDL（文件头自述）；`test/store/commits.test.ts:46` 手搓 assertion payload 取代 `buildAssertPayload`；`test/support/fake-registry.ts:130-134` 另写一遍 slot 过滤，被验证的其实是这份复制品。

**代价**：断言写的是 payload 字段与索引形状而非模块对外语义，改内部表示时 55 处夹具要逐个跟着改，而漏改的地方测试仍然绿——回归信号与改动点脱钩。

**验收**：`test/` 里 `db.insert(` 命中数从 55 降到个位数；`write-store.ts` 不再重抄 DDL。反向的好例子已有：`test/store/perf.test.ts` 判 ratio 而非绝对值；`test/load/inject.test.ts:136` 用 sha256 比对两轮。

### P2-3 静态门：规则补全与死字段清除　`中`

**证据**

- `scripts/check-layers.mjs:36-56` 的 `RULES` 只表达 3 条层规则，而 `src/` 有 4 个真实目录。实际跨层边：`seams → ops` 8 处、`ops → seams` 5 处、`ops → store` 2 处、`core → store` 4 处（含 `core/patch.ts:22` 的值导入 `buildPredicatePayload`）。seams 与 ops 双向 import，门一句话都没说。
- `:32` 的 `LAYERS` 列了 7 层（含 dream/persona/gui），`src/` 只有 cores/store/seams/ops 四个目录。
- `:41` 的 `allowedSpecifiers: ['triviumdb']` 全文件只出现 1 次，定义后从不读取——死字段。
- `:115-127` 的 `WRITE_TOKENS` 只列 11 个写方法，`test/lint/layers.test.ts:126-138` 又逐字抄了一遍。

**代价**：ops 在新目录里被完全放任（无规则）；新加一条规则要连带重写「树干净」前提与 gate 证据；写方法漏判是静默的（`db['delete'](1)`、`const m = db; m.delete(1)` 都过）。

**验收**：`RULES` 覆盖四个真实目录的完整邻接矩阵；`allowedSpecifiers` 要么接线要么删除；测试改为「规则 id → 一个最小违规片段」的表驱动。

### P2-4 docs 瘦身　`低`　`等确认`

**证据（实测）**：docs 共 **168.8 MiB / 4,394 文件**，其中 `docs/**/imports/**` 的第三方仓库副本 **148.4 MiB / 4,174 文件**，且**未被 git 跟踪**；`preview/` 9.6 MiB（`_stale-*` 三个目录里 12 张 PNG 有 8 张与当前副本 SHA256 逐字节相同）；`browser-check.json.bak*` 三个共 4.54 MiB。git 只跟踪 docs 下 473 文件 / 20.3 MiB。

**代价**：全目录 grep 要扫 50 倍噪声，真正可读面只有 138 个 md、3.0 MiB（2%）。

**建议**：`docs/**/imports/` 移出仓库或加 ignore；`preview/_stale-*` 与 `*.bak*` 删除；`.gitignore` 追加生成物规则。

> **按 C2 约束：只出清单，不执行。** 等你确认后再动手。

---

## 与 Epic 3 阻塞项的关系

`epic-3-readiness-2026-11-26.md` 管「语义没裁定」（P0 8 / P1 6 / P2 10），本清单管「结构有摩擦」。只有四处重叠，**应当合并做**，不要当成两份工。

| 本清单 | readiness 条目 | 合并理由 |
| --- | --- | --- |
| P0-1 当前版本单判据 | P0-4 Story 3.2 版本链归位 | Story 3.2 要在既有 `history` 上扩展，先得让「活版本」只有一个定义 |
| P0-2 封闭词汇单一定义 | P0-5 `flag_type` 补第八值 | 「封闭集」的判据只有一处定义，补值才不会漏 |
| P1-3 `planPatchTable` | Story 3.3 / 3.4（冲突分级、按 op_id 撤销） | 这两条 story 正是往这个 486 行函数里再加分支 |
| P2-2 测试穿接口 | P1-4 补两条契约测试 | 同一批夹具，一次改完 |

**不重叠的部分**：readiness 的 P0-1/P0-2/P0-3/P0-8 是「接没接上」与「文档怎么措辞」，与模块深度无关，不要塞进重构里；本清单的 P1-1/P1-2/P1-3 是搬迁，不该夹在功能 story 里——readiness 的 Q3 与 Q9 已经作过同样的判断。

---

## docs 清理清单（待确认执行）

### 可删（未被 git 跟踪，删了不需要提交）

| 路径 | 体量 | 依据 |
| --- | --- | --- |
| `docs/planning-artifacts/research/*/imports/**` | 148.4 MiB / 4,174 文件 | 第三方仓库副本（含 `lemmalog`、`see-now`、`sense-now`、`streamvision`、`video-watch-plus` 等），git 从未跟踪 |
| `docs/**/preview/_stale-*` | 7.45 MiB / 18 文件 | 12 张 PNG 里 8 张与当前 preview 副本 SHA256 逐字节相同 |
| `docs/**/omw-architecture.browser-check.json.bak*` | 4.54 MiB / 3 文件 | 历史副本，`visual-check.json` 单份 2.14 MiB |

### 保留（自有文档，138 个 md / 3.0 MiB 全部不动）

`docs/specs/**`、`docs/planning-artifacts/{prds,epics.md,architecture,briefs}/**`、`docs/implementation-artifacts/**`。

### 建议的 .gitignore 追加

```gitignore
# 研究阶段的第三方仓库副本：按需重新克隆，不入库
docs/**/imports/
# 架构讲解器的过期预览与浏览器自检快照
docs/**/preview/_stale-*/
docs/**/*.browser-check.json.bak*
```

现有 `.gitignore` 已覆盖 `_bmad/`、`.agents/`、`node_modules/`、`lib/`、`.omw-e2e/`、`coverage/`、`**/experiments/data/`、`*.tsbuildinfo`。

---

## 本轮做了什么、没做什么

**做了**

- 只读取证：读 `src/` 全部 43 个文件的导出面、4 个关键实现、`scripts/check-layers.mjs` 规则表、`ARCHITECTURE-SPINE.md`、`epic-3-readiness`、`sprint-status.yaml`。
- 实测：静态门 97/97、层门测试 27/27、全量测试 635 处 `it()`（46 文件，含 2 处条件跳过）、docs 体量 168.8 MiB 并按路径分桶、最大函数体量按花括号配对计数、导出面按 grep 计数、跨层 import 边按目录聚合成矩阵。
- 核实并撤回了子代理的两条错误结论（见「基线」）。
- 产出 HTML 报告（含 10 张前后对比图）与本清单。

**没做的，以及为什么**

- **没有改动 `src/` 与 `test/` 任何文件。** 工作区有另一个会话正在实施 Epic 3 P0-1（8 个文件持续落笔，最近一次距我运行 31 秒）。此时写入会互相覆盖，属不可逆风险。清单里标 `[blocked]` 的条目全部落在它的改动集合内。
- **没有执行 docs 清理。** 按你选的「出清单 + .gitignore 建议，等确认再执行」，清单在上一节，随时可以照做。
- **没有改 ARCHITECTURE-SPINE 的措辞。** 命令面形态（文档写七条、代码是一条 `/omw` 加子命令）已在 readiness 的 P0-3 里，属你的裁定范围，不是我能替他选的。

## 复核方式

```bash
node scripts/check-layers.mjs                                  # 应为 97 文件全过，退出 0
pnpm exec vitest run test/lint/layers.test.ts                  # 应为 27 passed
pnpm test                                                      # 635 处 it()，含 2 处条件跳过
pnpm lint                                                      # tsc + 层门 + eslint
```

本清单里的每一条在实施后都应回到这三条命令上验证，而不是只看代码读感。


---

# 第二部分：设计本身是否合理（2026-11-26 追加）

> 第一部分管「模块怎么切」，这一部分管「这些东西该不该存在、有没有交付位、能不能被验收」。
> 只写能用文档行号或实测坐实的结论；每条最后给「该怎么处理」。

## 一句话判断

这套设计**不是想错了**，而是**契约的增长速度超过了实现的验证速度**。三个直接后果：

1. 不变量被写成了「当前实现的快照」，于是任何合法演进都变成违约；
2. 能力设计先于交付位存在（CAP-9 有 9 条 FR、10 条 AD、10 条不变量，却没有一个 epic）；
3. 验收设施没有归属（`eval/` 被引用 15 次，0 个 story 负责建它，目录不存在）。

## 1｜AD-7 已经被正在进行的 P0-1 违反，而且没人发现

**证据**

- `ARCHITECTURE-SPINE.md:81` 原文：「**两条注入通道**各管一档，不得混用」，只认身份段（`section`）与状态尾巴（`context`）。
- 工作区里 P0-1 的代码新增了第三条 context 通道：`src/seams/prompt-composer.ts:859` 注册 `omw:recall`，序位 `RECALL_CONTEXT_ORDER = PERSONA_STATE_CONTEXT_ORDER + 1`。
- 没有任何测试守通道数：`grep -r "harness:identity\|omw:persona-state\|omw:recall" test/` 只命中前两个段名（18 处），`omw:recall` 零命中。
- README 与 SPEC 也跟着写「两段」：`README`「注入：两段，一个出口」、`SPEC.md:89`「两处调用只允…」。

**为什么这是设计问题而不是措辞问题**：AD-7 的标题叫「注入只有一个出口」，但那句话真正想守的是「注入不能散落各处」。它把**当时的实现形态**（两个通道）写成了规则，于是第三条通道一来，规则就失效了——而通道本身完全合法（它只是另一个 `context`）。这就是「不变量实现细节化」的典型例子。

**处理**：把 AD-7 改写成形态无关的约束——「所有注入只经 `seams/prompt-composer.ts` 一个 module；每一档必须登记名字、序位、上限与稳定性等级（字节稳定 / 逐轮可变），未登记不得注入」；再补一条测试断言「注册的通道集合与登记表相等」。这样第三条通道来了是**改登记表**，不是**违约**。

## 2｜CAP-9 没有 epic，却已经两次改动 v1 的验收契约

**证据**

- `epics.md:36`：CAP-9（FR-25…FR-33 / AD-46…AD-55 / I17…I26）「仍然**未分解为 story**」。
- `epics.md:39`：「**错误码 8→11** 是 CAP-9 **唯一**已渗入 v1 的部分」。
- `SPEC.md:51` 却记录了第二处渗入：「第 5 项的判据**已由 CAP-9 改判**为『`omw-main` preset 内该段可见 ∧ profile 位未注册该段』，照旧判据实现会把装对的环境判成 fail」。

- 两句话互相矛盾：一处说「唯一」，另一处给出了第二处。
- 同一节还说「`/omw doctor` 实际输出**七行**」，而 `src/seams/commands.ts:100` 仍在打印 `${index}/5`（实测 5 项）。
- `ARCHITECTURE-SPINE.md:268` 的 doctor 表已经按安装位排到 7 项，等于承认目标态与实现态不同。

**为什么是设计问题**：v1 的验收判据现在依赖一个没有交付位的capability。要么 Epic 1 的 doctor 按旧判据实现（那就与 SPEC 冲突），要么按新判据实现（那就需要 preset，而 preset 属 CAP-9，没有 story）。这不是措辞能解决的，是**依赖关系没进计划**。

**处理**：二选一，并在 `epics.md` 写死——(A) 把 CAP-9 的「人格位」切出最小一片（preset 声明 + doctor 第 5 项）作为 Epic 1 的补丁 story；(B) 把 doctor 第 5 项判据退回旧口径，CAP-9 整体推后，并在 SPEC 里标注「第 5 项判据随 CAP-9 改判」。选 B 更省，但要接受 SPEC 现在这句话是错的。

## 3｜验收设施没有 epic，而 v1 的 story 已经在读它

**证据（实测）**

| 路径 | 是否存在于仓库 | 被谁引用 |
| --- | --- | --- |
| `eval/` | **不存在** | `epics.md` 引用 15 处；`epics.md:140` 的 AR-16 列为 v1 交付物 |
| `test/fixtures/` | **不存在** | Story 3.1 / 3.4 / 3.6 / FR-55 的验收输入 |
| `docs/implementation-artifacts/epic-3-context.md` | **不存在** | readiness 清单 P1-6 要求它作为 Epic 3 的开工输入 |

- `epics.md:1057`：Story 4.x 的 **Given** 就是「存在 `eval/golden-l1.jsonl`（50 条标注）」——它把一份不存在的人工标注集当成了前置条件。
- `epics.md:720`：Story 3.1 的 **Then** 要求「记录写 `eval/governance-20.md`」。
- `ARCHITECTURE-SPINE.md:373` 的 Structural Seed 把 `eval/` 列为目录，写着「验收物：golden-l1.jsonl、governance-20.md、rubric.md、reports/」。

**为什么是设计问题**：验收设施是所有 story 的**共同依赖**，却被当成「某个 story 顺手建」。顺手的部分是建目录，不顺手的部分是**人工标注 50 条金标准 + 20 条约束压力集**——那是需要单独排期的产出，不是一个 story 的副产物。计划里没有它的位置，意味着 Epic 3 一开工就会卡在「拿什么验」。

**处理**：把「评测基线」立成 Epic 3 的**前置交付物**（可以很小：一条 story，产物是空目录约定 + 20 条手工样本 + rubric 口径），而不是让它在各个 story 的 Given 里凭空出现。这也是 readiness 清单 P1-5 已经在说的事，但那份清单把它写成「写进 epic-3-context.md 就行」——写进去不等于做出来。

## 4｜三个「计划中的反转」暴露了底层抽象选错了层次

| 已实现 / 已定的说法 | 计划里被改成 | 出处 |
| --- | --- | --- |
| AD-7：三档预算各守各的，不互相借 | FR-53：注入 + 折叠 + 召回共用一个注意力池 | `README`「三档的预算各守各的」vs `prd.md:612` |
| AD-13：降级只有两档 | AD-36：上下文治理五档 | `SPINE:313-320` 的安装位表 |
| I6：库不可用时零注册 | I24：人格位那时必须还在 | `SPINE:322` |

**证据**：`ARCHITECTURE-SPINE.md:313-322` 用一张「按安装位切分降级档位」的表把前两个冲突**调和**掉，并明确写「因此 I6 的原文需要读成『记忆安装位零注册』」。

**为什么是设计问题**：这条路走通靠的是给每条旧规则加限定语。三处都需要限定语，说明「安装位」不是补丁，而是本该在 AD-1 就确立的一等概念——但 AD-1 写的是「单进程纯插件」，默认只有一个安装位。同理，预算从「三档独立」改成「共享池」也是同一种症状：AD-7 当初把**实现手段**（各自封顶，便于实现）写成了**规则**，而真正的规则是「总额不超窗口的一定比例」。

**处理**：把两个一等概念补进 spine 的开头（不是散在 AD 里）：**安装位**（记忆 / 人格 / 路由 / 上下文治理，各自可独立启用与降级）与**注意力池**（一个总预算，若干档位从中分配）。然后把 AD-7 / AD-13 / I6 / FR-53 都改成它们的实例。这比再加三条限定语便宜。

## 5｜Structural Seed 里有 5 个目录不存在

`ARCHITECTURE-SPINE.md:358-375` 列出的目录树与实测对照：

| spine 里的目录 | 实测 |
| --- | --- |
| `src/core` `src/store` `src/seams` `src/ops` | 存在（43 个 .ts） |
| `src/dream` | **不存在** |
| `src/persona` | **不存在**（`assets/persona.md` 在，读取在 `seams/runtime.ts`） |
| `src/core/projections` | **不存在** |
| `src/gui` | **不存在** |
| `eval/` | **不存在** |

**为什么是设计问题**：bmad-architecture 对 seed 的定义是「冷启动时成立、之后由代码接管」。一份一半不成立的目录树不是 seed，是**愿望清单**，而它会被下一个 agent 当成事实读——`epics.md:313` 的 Story 1.1 就写着「生成 `src/{core,store,dream,persona,seams,gui,ops}`、`assets/`、`eval/`」，也就是说 Story 1.1 的 AC 当年要求建 7 个目录，实际建了 4 个，而这条 AC 已被标 done。

**处理**：把 seed 拆成「已存在」与「计划中」两段，或在树里逐行标 `# 计划中，Epic N`。顺带回查 Story 1.1 的 AC 为什么能在只建 4 个目录的情况下判 done。

## 6｜AD 里混着研究结论与外部端点事实，所以不变量会随实验过期

**实测**：27 条 AD 的正文合计 19,379 字符，平均 718、中位 590，8 条超 800 字符。最长的三条：

- `AD-10`（1,713 字符）：写进了 G0-8 的实测数字（「关思考后 11–13s」「原定 `Qwen3.5-4B` 三次探测 180/60/45s 全无响应」）、夜间窗口 02:00–05:00、空闲触发 30 分钟、去抖 3s。
- `AD-8`（1,636 字符）：把 SiliconFlow 的 `/systemone` **Alpha 端点**、模型名 `SemIf` / 备选 `Kev-4b`、缓存 10 分钟、熔断 3 次/10 分钟写进了规则。
- `AD-15`（1,424 字符）：把 11 个写方法名逐个列出。

**为什么是设计问题**：按 bmad-architecture 的判据（「两个下一层的单元各自实现，会不会做出不兼容的选择」），模型名、实测耗时、Alpha 端点都不属于不变量——它们属于**实现选择**，会随一次实验或一次 provider 变更而过期。混进 AD 的直接代价是：改一个模型名要动「不变量」文档，动得多了，读的人就不再相信 AD 是规则。

具体风险还有一条：把 **Alpha 端点**做成默认开启的召回第②段（`rerank.enabled` 默认 `true`），意味着这条链路的默认行为依赖一个自述「可能调整或停用」的外部服务。降级路径已经有了（`rerank_unavailable` → 退 ①③），所以风险可控——但它必须写进「风险」而不是「规则」。

**处理**：AD 正文只留「必须这样、否则两个单元会不兼容」的部分；模型名/耗时/端点/窗口收进 `Stack` 与 `Operations` 表（这两张表本来就在，且已经列了这些值）。AD-8 保留「重排必须可缺席、缺席不得返空、只产分数不产删除」即可。

## 7｜编号登记表本身说明「单一权威」曾经失败

**证据**：`ARCHITECTURE-SPINE.md:290-292` 自述——「三份文档各自宣称『接续 AD-27、永不复用』，结果 `CONTEXT-GOVERNANCE.md` 与 `entry-routing.md` 都从 **AD-28** 起跳、**同号异义**。本表是唯一权威」。同表还登记了 55 条 AD、9 个 CAP、77 条 FR、26 条不变量的归属。

**为什么是设计问题**：三方各自续号 → 撞号 → 建登记表纠正，这是一次真实的协作失败留下的补丁。它现在能工作（表写得很认真），但代价是：任何扩号必须先读这张表，而表在 spine 里、被扩的文档在别处。一个 agent 只被给了 `CONTEXT-GOVERNANCE.md`，不可能知道 AD-28 已被占用。

**处理**：把登记表提升成独立文件（如 `docs/architecture/ID-REGISTRY.md`），三份文档都在开头引用它；或者干脆让 spine 成为唯一 AD 容器，其余文档只写「本条受 AD-n 约束」不新开号。后者更彻底，也更符合 spine 的定义。

## 8｜范围的来源是研究线，不是用户

**证据**：`PRD` 2026-11-25 迭代把六条研究线一次性抽成 **44 条新 FR（FR-34…FR-77）**，占 77 条 FR 的 57%；它们分散落进 Epic 3–7 的增量 story、新开的 Epic 8（14 条）与 Epic 9（4 条）。而实测目前只交付了 Epic 1–2 的 11 个 story。

**为什么是设计问题**：这不是「需求太多」的问题——PRD 对每条 FR 都给了可测结果，质量很高。问题是**生产与消化的比例**：一轮研究可以产出 44 条需求，而消化它们需要 40+ 个 story。在这样的比例下，「先写下来再实现」会稳定地把契约堆到实现前面，于是出现本清单第 1、2、3 条那种「文档说得到、代码做不到」。

**处理**：给 FR 加一个状态字段（`planned / building / shipped / deferred`），并规定**同一时刻 `planned` 的 FR 不得超过 N 条**（N 取一个 sprint 能消化的量，比如 12）。这不是限制研究，是让「已规划」重新具有承诺含义。

## 这一部分不建议做什么

- **不建议重写 PRD 或 spine**。这两份文档的自我约束很强：PRD 自己标出了循环定义（FR-53 的 `focus_ratio` 用纯结构量而不是「相关性」）与恒真闸门（FR-57 早先的「阈值不得高于实测值」已自纠）；spine 的 Operations 已经按安装位重排了 doctor 表。它们是**需要收口**，不是**需要推翻**。
- **不建议现在动 Epic 8（上下文治理）**。它是全表里唯一「替换宿主能力」的 epic（`prd.md:540`：必须替换宿主的 `compaction-basic`，否则两个压缩器同时接管历史），爆炸半径最大。在 AD-7 的预算语义还没收口之前动它，等于在会变的地基上盖楼。

## 第二部分的优先级

| 序 | 事项 | 工作量 | 为什么先做 |
| --- | --- | --- | --- |
| 1 | 把 AD-7 改写成形态无关约束 + 补一条通道登记测试 | 小 | 正在被违反，且有合法改动就能自证 |
| 2 | 裁定 CAP-9 的 doctor 第 5 项（补最小片 / 退回旧口径） | 小 | v1 验收判据现在两说 |
| 3 | 给 `eval/` 立一条前置 story | 中 | Epic 3 一开工就要用 |
| 4 | 补「安装位」「注意力池」两个一等概念 | 中 | 能消掉三处限定语式补丁 |
| 5 | AD 正文瘦身（模型名/耗时/端点移出） | 中 | 决定 AD 还能不能被当规则读 |
| 6 | 登记表独立成文件 | 小 | 防下一次撞号 |


---

# 第三部分：对另一侧改动的复核（2026-11-26 20:15）

> 对方宣称改动完成、正在 review。全部改动已 `git add` 但**尚未 commit**（`git diff --stat` 为空、`git status` 全是 `A`/`M`）。
> 复核以工作区实测为准。判定只有三种：已失效 / 仍成立 / 新增。

## 实测基线（复核时）

| 项 | 数值 |
| --- | --- |
| 静态门 | **99 个源文件，全部规则通过，退出 0**（此前 97） |
| 全量测试 | **657 处 `it()` / 43 个 `*.test.ts`**，`pnpm test` 退出 0（此前 635） |
| 新模块 | `src/ops/stats.ts`（234 行）+ `test/ops/stats.test.ts` |
| 新闸门记录 | `gates/g0-4.json`，`status: pass` |
| 命令注册 | 六条平铺：`omw-doctor` / `omw-pred-promote` / `omw-evidence` / `omw-history` / `omw-ledger` / `omw-stats` |

## 已失效：对方确实修好了

### ✗ 旧结论 1「AD-7 正在被 P0-1 违反」——已修

`ARCHITECTURE-SPINE.md:81` 已从「**两条**注入通道」改成「**三条**注入通道」，第三条就是 `omw:recall`。具体违约消失。

> **但根因没动**：规则仍然以**数量**枚举通道。第四条通道来时，同一场景会重演一次。我上一轮建议的「改成形态无关约束 + 通道登记表」只被部分采纳——通道集合的断言有了（见下条），但 AD 的措辞仍是枚举式。

### ✗ 旧结论 2「`omw:recall` 零测试」——已修，而且修法正确

`test/load/inject.test.ts:154` 现在有：`expect(sections.contexts.map(c => c.name)).toEqual([RECALL_CONTEXT_NAME])`——**钉的是通道集合**，不是单点行为。这正是我建议的形态。全仓 7 处引用 `RECALL_CONTEXT_NAME`。

### ✗ 旧结论 3「命令面文档说七条、代码一条」——已解决，且找到了机制原因

`ARCHITECTURE-SPINE.md:234` 已定形为**十条平铺注册**，并写明为什么当初的七条写法不成立：

> 「…**没有裸 `/omw`、也没有子命令分派**——宿主把首 token 整个当命令名，`/omw doctor` 解析出来只会是 `name: 'omw'`，这就是当初七条写法不成立的实证原因」

这是三轮文档里第一次**从机制上**解释清楚一件事，而不只是改措辞。readiness P0-3 的两选一（A 子命令 / B 七条独立）被一个更准确的第三方案取代了。

### ✗ 旧结论 4「`gates/g0-4.json` 缺失」——已补

文件存在，`status: pass`。readiness P0-2 收口。

### ✗ 旧结论 5「`/omw stats` 未实现」——已交付

`src/ops/stats.ts`（234 行，11 个导出，`parseStatsWindow` / `summarizeAudit` / `renderStats`）+ 命令 `omw-stats` + 测试。readiness P0-8 收口。

## 仍成立：没被这次改动触及

| # | 旧结论 | 复核证据 |
| --- | --- | --- |
| 1 | doctor 项数文档说七行、实现五栏 | `SPEC.md:51` 仍写「实际输出**七行**」；`src/seams/commands.ts:102` 仍打印 `` `${index}/5` ``，五项 |
| 2 | CAP-9 渗入「唯一」与第二处并存 | `epics.md:39` 仍写「错误码 8→11 是 CAP-9 **唯一**已渗入 v1 的部分」；`SPEC.md:51` 同节仍写「第 5 项的判据**已由 CAP-9 改判**」 |
| 3 | 验收设施无归属 | `eval/`、`test/fixtures/`、`epic-3-context.md` **三者仍都不存在**；epics 里 15 处 `eval/` 引用仍悬空 |
| 4 | 「当前版本」判据仍是两套 | `store/filters.ts:69` 用 `!Object.hasOwn(payload,'superseded_at')`；`seams/version-reader.ts:134` 用 `numberField(payload,'superseded_at')`。非数字取值下结论仍相反 |
| 5 | 三个超大函数未拆 | `startRuntime` 459 行（runtime.ts 841）、`createWritePort` 503 行（write-port.ts 824）、`planPatchTable` 481 行（patch.ts 1145）。数值与上轮几乎一致 |
| 6 | 零消费者导出仍在 | `WRITE_OUTPUT_SCHEMA` 全仓仍只有声明 1 处；`composeStateTail` 3；`EMBEDDING_FAILURE_KINDS` 2；`isToolErrorCode` 6（全在测试） |
| 7 | seed 目录仍不完整 | `src/dream`、`src/gui`、`src/core/projections`、`eval/` 仍不存在 |
| 8 | docs 体量 | 未动（`docs/**/imports` 仍 148.4 MiB / 未跟踪） |

## 新增：这次改动带来的漂移

### ▲ 新 1｜命令面定形只落到 SPINE，没落到 README 与 SPEC

代码与 SPINE 已改成 `omw-doctor` 这种平铺写法，但：

- `README.md` 六处仍写 `/omw doctor`、`/omw history`、`/omw ledger`（`:37`、`:52`、`:54`、`:57`、`:105`、`:118`、`:289`）；
- `SPEC.md:50`、`:51` 仍写 `/omw doctor`。

这正是 P0-3 想消灭的那类问题（同一事实多文档各写一遍），定形之后没有一次同步到底。**影响是实际的**：照 README 输入的 `/omw doctor` 在宿主里解析成命令名 `omw`，注册表里没有这条，所以它不会工作。

**处理**：`README` 六处 + `SPEC` 两处改成 `/omw-doctor` 等实际命令名。这是一次纯替换，但必须做，否则文档在教人一个不存在的调用。

### ▲ 新 2｜全部改动已 staged 但未 commit

`git status` 显示 37 个条目全是 `A`/`M`（已进 index），`git diff --stat` 为空。review 阶段这样没问题，但要注意两件事：

- 我这份 `architecture-review-2026-11-26.md` 仍是 `??`（未跟踪），提交时应单独 add，别和生产改动混在一个提交里；
- 提交前建议先跑一次 `pnpm lint`（`tsc --noEmit` + 层门 + eslint），我只验了 `check-layers.mjs` 与 `pnpm test`，**类型检查与 eslint 没跑**。

## 复核后仍然推荐的下一步（顺序有变）

| 序 | 事项 | 变化 |
| --- | --- | --- |
| 1 | ~~同步命令名到 README 与 SPEC~~ | **已做**，见第四部分 |
| 2 | ~~「当前版本」收敛成一个判据~~ | **已做**，见第四部分 |
| 3 | 给 `eval/` 立一条前置 story | 未动，仍挡 Epic 3 |
| 4 | ~~AD-7 从枚举改成登记制~~ | **已做**，见第四部分 |
| 5 | 三个超大函数拆分 | 未动，需独占工作区 |

---

# 第四部分：已落地的修正（2026-11-26 22:06，提交 82cb7e8）

上面第三部分列出的待修项，这一批做完了五项，另外顺带修掉两处别人提交里的缺陷。

| 修正 | 落点 | 依据 |
| --- | --- | --- |
| 命令名同步 | `README.md` 18 处、`SPEC.md` 2 处改为 `omw-doctor` 等实际注册名；`/omw help` 指向不存在的命令，换成 `/omw-stats` | 第三部分「新 1」 |
| 体检项数 | `src/seams/commands.ts` 的 `render()` 分母改取本次实际行数；`SPEC.md:51` 与 `addendum.md:43` 的「实际输出七行」改为「当前五行、安装位落地后七行」 | 仍成立项 1 |
| CAP-9 措辞 | `epics.md` 的「错误码 8→11 是唯一渗入」改为并列两处（第二处是 doctor 第 5 项判据改判）；同时修正两处错位行号引用（原指 `SPEC.md:69`／`requirements.md:185`，实为 `:50`／`:188`） | 仍成立项 2 |
| 在用判据 | `src/seams/version-reader.ts` 改为复用 `store/filters.ts` 的 `isLive`，与模板的 `$exists: false` 同源 | 仍成立项 4 |
| AD-7 登记制 | `ARCHITECTURE-SPINE.md:81` 从「三条通道」枚举改为「按登记制管理、不按数量枚举」，并补了通道登记表（名字／宿主通道／序位／上限／稳定性） | 第二部分第 1 条 |
| 顺带修 1 | `test/ops/stats.test.ts` 的 `'timeout'` 不在封闭词表内，改为 `'recall_timeout'`——`pnpm lint` 的 tsc 会直接报错 | 验证时发现 |
| 顺带修 2 | `test/store/filters.test.ts` 的 agreement 用例补上 `superseded_at: null` 这个真会分叉的取值 | 补强仍成立项 4 的守门 |

## 验证（实测）

```
pnpm lint         # tsc + check-layers + eslint，退出 0
pnpm test         # 666 passed | 2 skipped
check-layers.mjs  # 99 个源文件，全部规则通过
```

## 一条没采纳的审查建议

审查建议把 `store/templates/assertions.ts` 的三处 `$exists` 字面量改为从 `isLive` 派生。**没有采纳**，理由写在 `test/store/filters.test.ts` 的文件头：TQL 过滤器无法参数化，所以刻意让「模板持有拼写、`filters.ts` 持有语义、测试把两者钉在一起」；静态门 `exists-owner`（`scripts/check-layers.mjs:149-157`）还强制了这个结构。改成派生会破坏一个有意为之的设计。

## 仍然未动

> **2026-11-26 补记**：下面这些条目已按归属规划进 `docs/planning-artifacts/epics.md` 的「架构审查结转（2026-11-26 登记）」段——结构类进新增的 Epic R，评测基线进 Epic 3 前置，文档卫生单列一次 chore。本节保留为「当时为什么没做」的记录，不再是待办清单。

- **`eval/` 前置 story**——`eval/`、`test/fixtures/`、`epic-3-context.md` 三者仍都不存在，而 `epics.md` 有 15 处引用 `eval/`。这是 Epic 3 开工的实质阻塞。
- **三个超大函数拆分**——`startRuntime` 459 行 / `createWritePort` 503 行 / `planPatchTable` 481 行。搬迁需要独占工作区。
- **docs 瘦身**——`docs/**/imports` 仍 148.4 MiB 且未被 git 跟踪。按 C2 约束只出清单，等确认。
- **未消费者的导出**——`WRITE_OUTPUT_SCHEMA`（1 处，仅声明）、`composeStateTail`（3）、`EMBEDDING_FAILURE_KINDS`（2）、`isToolErrorCode`（6，全在测试）。

