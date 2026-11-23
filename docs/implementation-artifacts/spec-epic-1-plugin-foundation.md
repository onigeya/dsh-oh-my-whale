---
title: 'Epic 1 — 装得上、坏得起：插件底座与可验证的启用'
type: 'feature'
created: '2026-11-23'
status: 'in-progress'
baseline_revision: 'cf04e95038f7fd6d7be37589f3f3fd03bbdcb9b7'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/docs/implementation-artifacts/epic-1-context.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/ARCHITECTURE-SPINE.md'
warnings: ['oversized', 'multiple-goals']
deferred: []
---

<intent-contract>

## Intent

**Problem:** 仓库只有规划文档与两个探针脚本，没有任何可被 DSH 加载的插件包（无 package.json / src / test），因此 AR-1 的脚手架、FR-15/FR-17/FR-18/FR-19 与闸门 G0-5/G0-6 全部无法验证；一旦开始写记忆逻辑，加载失败、库损坏、向量故障都会表现为「静默半死」，既看不出装没装上，也说不清坏在哪一层。

**Approach:** 先交付一个零业务逻辑但真实可加载的插件底座：分层目录 + 锁定版本工具链 + `apply(ctx, config)` 入口 + 字节稳定的身份段注入；用 `omw doctor` 把「装没装上 / 库能不能开 / 快照对不对 / 维度与凭据对不对 / 注入段注册没有」压成五个有序检查与非零退出码；把库打不开、快照校验失败、维度不符、契约版本过高收敛成整体 no-op，把向量故障收敛成 vector-off；快照按天做、做后即校验、留 7 份、恢复先停库。

## Boundaries & Constraints

**Always:**
- 全部逻辑在 `apply(ctx, config)` 内注册、随 fiber 销毁；不新增常驻进程、端口监听、子进程、跨进程锁文件（`worker_threads` 属同进程，不在此列）。
- 注入只有两个出口，且只允许出现在 `src/seams/prompt-composer.ts`：身份段 `ctx.systemPrompt.section({name:'omw:persona'})` ≤1200 字符、字节稳定、文本哈希不变即不重写；状态尾巴 `ctx.systemPrompt.context({name:'omw:persona-state'})` ≤30 token。其它任何文件出现 `systemPrompt.` 调用即为越界。
- 降级状态是封闭三值 `ok | no-op | vector-off`，由单一状态机持有；任何代码路径不得产生第四态、中间态或「先降级后悄悄恢复」。
- 运行时降级错误码封闭八个：`OMW_DB_OPEN`、`OMW_SNAPSHOT_VERIFY`、`OMW_DIM_MISMATCH`、`OMW_EMBED_AUTH`、`OMW_EMBED_QUOTA`、`OMW_EMBED_TIMEOUT`、`OMW_EXTRACT_FAIL`、`OMW_DREAM_BUDGET`。
- 配置唯一出处是 `src/seams/config.ts` 的 zod schema；环境变量只承载凭据（键名由 `embedding.apiKeyEnv` 指定，默认 `SILICONFLOW_API_KEY`）；宿主补丁条目的 `config:` 原样传入 `apply`，未知键保留不报错。
- 日志 `<dataDir>/omw.log` 一行一事件 `{ts, level, code, detail}`；`omw doctor` 一次运行只追加一行 `omw.log`、不写任何业务节点、不发任何网络请求。
- 目录与文件全部由 `<dataDir>` 派生，`<dataDir>` 来自 `ctx.dshHomePath('oh-my-whale')`（`db.path` 显式配置时以其为准）：`oh-my-whale.tdb`、`omw.log`、`snapshots/`、`audit-YYYYMMDD.jsonl`。
- 快照只在 `<dataDir>/snapshots/` 下生成与清理，且只经 `src/ops/snapshots.ts`；该文件是 AD-15 的具名豁免（文件头写 `// AD-15 豁免：快照目录`），其它文件不得出现 `delete(` / `deleteManyAtomic(` / `unlink(`。
- 分层依赖方向由 `pnpm lint` 强制：`store/` 不 import 任何其他层，`core/` 不 import `seams/`，`gui/` 不 import `store/`；必须有「故意违规即失败」的证据。
- 密钥与载荷只输出键名/环境变量名，永不输出取值。

**Never:**
- 不实现 Epic 2 及以后的记忆语义：不写 `remember`/`recall`/`forget`/`explain` 的业务行为（本 epic 只按名注册占位，调用返回结构化「本版本未实现」错误）、不做抽取、不做 dream 八步、不做 tier/rerank/预算裁剪、不做审计轮转、不做迁移与卸载。
- 不做 GUI 客户端、不做治理命令、不做 eval 数据集与评测脚本。
- 不修改用户真实的 `~/.dsh/profiles/*`：端到端启用只在临时 `DSH_HOME` 内进行。
- 不绕过 `src/store/` 直连 `triviumdb`；`seams/` 不出现 `triviumdb` 类型；`core/` 不出现 IO。
- 不为了通过闸门在源码里留跨层 import 的「例外注释」，也不把层检查降级成人工约定。
- 不在 AR-1 清单之外引入运行时第三方依赖（唯一例外：`yaml@2.9.1`，供 `omw doctor` 解析补丁文件）。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| LOAD_OK | profile 的 `dsh.profile.bundles` 含本包，`cordis.patch.yml` 有 `insert` 条目 | stderr 打印一次 `[omw] loaded`；组装后的系统提示含 `omw:persona` 文本；会话正常结束 | 无错误 |
| PATCH_WRONG_PLACE | 条目只写在生成物 `cordis.yml`，补丁文件没有 | `omw doctor` 非零退出，打印 `OMW_CONFIG_WRONG_PATCH_FILE` 并指出应改 `cordis.patch.yml` | 退出码 1 |
| DEP_NOT_DECLARED | profile `package.json` 的 `dsh.profile.bundles` 缺本包 | 打印 `OMW_CONFIG_DEP_NOT_DECLARED` 并点名包名与字段 | 退出码 1 |
| SCHEMA_INVALID | `config.db.dim` 为字符串 / 负数 | 打印 `OMW_CONFIG_SCHEMA` 并点名 `db.dim` 与收到的类型 | 退出码 1 |
| SECTION_MISSING | 产物 `apply` 未注册 `omw:persona`（fixture 包） | 打印 `OMW_SECTION_NOT_REGISTERED` | 退出码 1 |
| CRED_MISSING | 无 `SILICONFLOW_API_KEY` | 凭据项 fail、`OMW_EMBED_AUTH`、全程零网络请求 | 退出码 1 |
| DB_OPEN_FAIL | 库文件被独占或损坏 | 运行时整体 no-op：`omw:persona` 仍注入、四个工具未注册、`omw.log` 恰一行 `level=error, code=OMW_DB_OPEN` | 无未捕获异常；退出码不因插件而变 |
| DIM_MISMATCH | `db.dim=1024`，库实际 dim=512 | 该检查 fail，`OMW_DIM_MISMATCH`，点名 `db.dim` 与两侧取值 | 退出码 1；运行时同样 no-op |
| CONTRACT_AHEAD | 库内 `contract_version=99` > 代码支持 1 | 整体 no-op，日志/诊断点名两侧取值，不注入记忆段 | 无崩溃，不重载即状态不变 |
| EMBED_401_402 | `POST /embeddings` 返回 401 / 402 | 关闭向量（`vector-off`），分别记 `OMW_EMBED_AUTH` / `OMW_EMBED_QUOTA`，不重试、不阻塞写入 | 写事务照常成功 |
| EMBED_TIMEOUT | 单次调用 >2s | `OMW_EMBED_TIMEOUT`，该条 `vec_state` 回落 `pending`，写事务成功，向量能力不关闭 | 不重试、不抛给调用方 |
| VECTOR_OFF_RECALL | 向量已关闭，库里有可检索节点 | 非向量检索路径返回非空结果；审计行 `degraded_reason` ∈ 封闭枚举（含 `vec_unavailable`） | 结果标 degraded，不抛错 |
| SNAPSHOT_DAILY | 当天无快照 | 启动补做一份并立即校验 `complete=true`；同日再启动最多多一份、不报错 | 校验失败 → no-op + `OMW_SNAPSHOT_VERIFY` |
| SNAPSHOT_ROTATE | 已有 7 份，新增第 8 份 | 清掉最旧一份（先按快照日期，同日取 mtime 最旧），只经 `ops/snapshots.ts` | 目录撞名不抛未捕获异常 |
| RESTORE_HANDLE_HELD | 恢复时库仍被打开 / Windows 句柄未释放 | 先 `close()` 再替换；句柄未释放时返回可读错误并提示「先停止进程」 | 可读错误，不损库 |
| PRE_MIGRATION_MISSING | 无 `snapshots/pre-migration-<ts>` | 迁移前置判定返回拒绝，并给出原因 | 抛出 `OMW_SNAPSHOT_VERIFY`，迁移不开始 |

</intent-contract>

## Code Map

- `package.json` -- 插件清单：`type: module`、`main: lib/index.js`、`bin.omw`、`dsh.manifestVersion/bundle.patch`、锁定版本的 deps 与 scripts
- `tsconfig.json` -- `module/moduleResolution: nodenext`、`rootDir: src`、`outDir: lib`、`strict`
- `eslint.config.js` -- flat config，覆盖 `.js/.mjs/.cjs`（TS 由 `tsc --noEmit` 负责；eslint 10 无法解析 TS，见 Design Notes）
- `vitest.config.ts` -- `test/**/*.test.ts`，node 环境
- `.gitignore` -- 追加 `node_modules/`、`lib/`、`.omw-e2e/`
- `README.md` -- 启用三步与「改补丁文件不是改生成物」的说明（FR-17 文档面）
- `assets/persona.md` -- 身份段唯一来源，四段文本，字节稳定
- `src/index.ts` -- 插件入口：`export Config`、`export function apply(ctx, config)`
- `src/seams/config.ts` -- zod schema、默认值、`<dataDir>` 解析、`Config` 类型导出
- `src/seams/prompt-composer.ts` -- 唯一注入出口：身份段与状态尾巴、1200 字符/30 token 预算、哈希不变即不重写
- `src/seams/logger.ts` -- `omw.log` 追加器 `{ts, level, code, detail}`，注入 sink 以便测试
- `src/seams/tools.ts` -- 按名注册 `remember/recall/forget/explain` 占位（返回未实现错误），no-op 时一个都不注册
- `src/seams/runtime.ts` -- 组装：开库 → 闸门 → 注入 → 工具 → 审计/日志，持有降级状态机
- `src/core/degrade.ts` -- 三态状态机、八个错误码常量、`degraded_reason` 封闭枚举、非法转移即抛
- `src/core/gates.ts` -- 纯函数：由开库/快照/维度/契约版本四个探针结果决定状态与首个失败码
- `src/store/db.ts` -- 唯一 `triviumdb` 打开/关闭入口、`dim()`、`nodeCount()`
- `src/store/meta.ts` -- `contract_version` 读写（`flag` 节点承载，见 Design Notes）
- `src/store/search.ts` -- 非向量检索最小路径，供 vector-off 与审计测试使用（Epic 2 的召回在此之上）
- `src/store/embedding.ts` -- 唯一 embedding 调用通道：2s 超时、401/402/超时映射、可注入 `fetch`
- `src/ops/snapshots.ts` -- 每日快照、`verifySnapshot`、保留 7 份轮转、恢复先 `close()`、迁移前快照判定（AD-15 豁免）
- `src/ops/audit.ts` -- `audit-YYYYMMDD.jsonl` 追加器与事件形状
- `src/cli.ts` -- `omw doctor`：解析 profile → 五项有序检查 → 输出 → 退出码
- `src/cli/doctor.ts` -- 五项检查实现（库/快照/维度/凭据/注入段），可单测
- `src/cli/profile.ts` -- 读 `<DSH_HOME>/profiles/<name>` 的 package.json、cordis.patch.yml、cordis.yml（`yaml`）
- `scripts/check-layers.mjs` -- 层依赖检查（import 说明符扫描），违规即非零退出
- `scripts/gate.ts` -- 跑 G0-5/G0-6 并把证据写到 `docs/implementation-artifacts/gates/`
- `test/support/fake-ctx.ts` -- 录制式假 ctx：`systemPrompt.section/context`、`tools.register`、`logger`、`effect`、`dshHomePath`
- `test/scaffold/*.test.ts`、`test/load/*.test.ts`、`test/doctor/*.test.ts`、`test/degrade/*.test.ts`、`test/ops/*.test.ts`、`test/lint/layers.test.ts` -- 各故事的可执行验收
- `test/e2e/load.e2e.test.ts` -- `OMW_E2E=1` 时才跑：临时 `DSH_HOME` + 真实 `dsh` 会话，断言加载与注入

## Tasks & Acceptance

**Execution:**
- `package.json` -- 建包清单：`type: module`、`main: lib/index.js`、`bin.omw: lib/cli.js`、`dsh.manifestVersion/bundle.patch`、锁定版本 deps、scripts（build/test/lint/doctor） -- 让包可安装、可被 DSH 识别
- `tsconfig.json` -- `module/moduleResolution: nodenext`、`rootDir: src`、`outDir: lib`、`strict` -- 产出可被 ESM 直接 import 的 `lib/*.js`
- `eslint.config.js` -- flat config，只覆盖 `.js/.mjs/.cjs` -- 把不兼容 TS 7 的解析器隔离在外
- `vitest.config.ts` -- include `test/**/*.test.ts`、node 环境 -- 跑验收
- `.gitignore` -- 追加 `node_modules/`、`lib/`、`.omw-e2e/` -- 不污染工作树
- `assets/persona.md` -- 写四段身份文本（≤1200 字符） -- 身份段唯一来源，字节稳定
- `src/seams/config.ts` -- zod schema、默认值、`<dataDir>` 解析、导出 `Config` 类型 -- 配置单一真相（AR-7）
- `src/core/degrade.ts` -- 三态状态机、八个错误码常量、`degraded_reason` 封闭枚举、非法转移即抛 -- 封闭状态，杜绝中间态
- `src/store/db.ts` -- 开库/关库/`dim()`/`nodeCount()`，与 triviumdb 的唯一接触点 -- 库访问收敛
- `src/store/meta.ts` -- `contract_version` 读写（`flag` 节点承载） -- ADR-19 的落地
- `src/seams/logger.ts` -- `omw.log` 追加器（sink 可注入） -- 一行一事件
- `src/ops/audit.ts` -- `audit-YYYYMMDD.jsonl` 追加器与事件形状 -- 审计面
- `src/ops/snapshots.ts` -- 每日快照、校验、轮转、恢复、迁移前判定 -- FR-19 与 AD-15 豁免
- `src/store/embedding.ts` -- 唯一 embedding 通道：2s 超时、401/402/超时映射、`fetch` 可注入 -- FR-18
- `src/store/search.ts` -- 非向量检索最小路径 -- vector-off 下的非空结果
- `src/core/gates.ts` -- 由开库/快照/维度/契约版本四个探针结果算状态与首码的纯函数 -- 分叉点可单测
- `src/seams/runtime.ts` -- 组装顺序：开库 → 闸门 → 注入 → 工具 → 日志/审计 -- 唯一装配处
- `src/seams/prompt-composer.ts` -- 身份段与状态尾巴、预算、哈希不变即不重写 -- 注入单出口
- `src/seams/tools.ts` -- 按名注册四个占位工具；no-op 时一个都不注册 -- 1.3 的对照面
- `src/index.ts` -- 导出 `Config` 与 `apply`，注册身份段后向 stderr 写一次 `[omw] loaded ... section=omw:persona` -- 插件入口与加载确认
- `src/cli/profile.ts` -- 读 `<DSH_HOME>/profiles/<name>` 的 package.json、cordis.patch.yml、cordis.yml -- 结构诊断
- `src/cli/doctor.ts` -- 五项有序检查与诊断码映射 -- FR-17 主体
- `src/cli.ts` -- `omw doctor` 参数解析、输出格式、退出码 0/1/2 -- 命令面
- `scripts/check-layers.mjs` -- 扫描 src 的 import 说明符，违规即非零退出 -- G0-6
- `scripts/gate.ts` -- 跑 G0-5/G0-6 并把证据写到 `docs/implementation-artifacts/gates/` -- 闸门取证
- `test/support/fake-ctx.ts` -- 录制式假 ctx -- 让注入与注册可断言
- `test/scaffold/build.test.ts` -- 断言构建产物存在且可 import -- 1.1
- `test/load/inject.test.ts` -- 断言段名/文本/字节稳定与 `[omw] loaded` 行 -- FR-15、1.1
- `test/doctor/doctor.test.ts` -- 五项检查的通过与五种错误配置 -- 1.2
- `test/degrade/no-op.test.ts` -- 脏库与契约版本过高时的整体 no-op -- 1.3
- `test/degrade/vector-off.test.ts` -- 401/402/超时与三态枚举 -- 1.4
- `test/ops/snapshots.test.ts` -- 每日/重复/轮转/恢复/迁移前 -- 1.5
- `test/lint/layers.test.ts` -- 在 fixture 上证明层规则会失败 -- G0-6
- `test/e2e/load.e2e.test.ts` -- 临时 DSH_HOME 的真实加载与注入观察 -- G0-5
- `README.md` -- 启用三步、体检语义、降级语义 -- FR-17 文档面

**Acceptance Criteria:**
- Given 干净仓库，when `pnpm install && pnpm build`，then 产出 `lib/index.js` 与 `lib/cli.js`，且无未声明依赖。
- Given 空测试集，when `pnpm test`，then 通过（脚手架阶段）——最终状态下 `pnpm test` 全绿且至少覆盖 I/O 矩阵每一行。
- Given 临时 `DSH_HOME` 中已把本包装进 profile 且在 `cordis.patch.yml` 写了 `insert` 条目，when 跑 `dsh --profile <tmp> --dump-config`，then 组合后的树含 `{id: oh-my-whale, name: dsh-oh-my-whale}`；when 再跑 `dsh --profile <tmp> "hi"`，then stderr 出现恰一次 `[omw] loaded` 且同一行含 `section=omw:persona`（模型轮次是否成功不影响该判定）。
- Given 同一 profile，when 把条目只写进生成物 `cordis.yml`，then `omw doctor` 非零退出并指认「补丁文件改错位置」。
- Given `pnpm lint`，when 在 `src/core/` 里加一条指向 `../seams/` 的 import，then `pnpm lint` 失败并指出违规文件与规则；移除后恢复通过。
- Given 正常配置，when `omw doctor`，then 五项按固定顺序输出、全部 pass、退出码 0、`omw.log` 只多一行、库内节点数与审计文件均未变。
- Given `db.dim=1024` 与 dim=512 的库，when `omw doctor`/`apply`，then 该检查 fail 并点名 `db.dim` 与两侧取值，运行时整体 no-op。
- Given 五种错误配置（依赖未声明 / 补丁改错 / schema 不合法 / 注入段未注册 / 库不可开），when `omw doctor`，then 各自非零退出、打印出错项与对应码、不打印任何密钥。
- Given 无 `SILICONFLOW_API_KEY`，when `omw doctor`，then 凭据项 fail、`OMW_EMBED_AUTH`、零网络请求（用拦截过的 `fetch` 断言零调用）。
- Given 脏库 fixture，when 插件加载，then `omw:persona` 注入文本与健康库逐字节相同，四工具未注册，`omw.log` 恰一行 `OMW_DB_OPEN`，审计无「已注入记忆」记录，库写入 0 次。
- Given 库内 `contract_version=99`，when 插件加载，then 整体 no-op 且日志点名两侧取值，重载前状态不变。
- Given embedding 返回 401/402 或超过 2s，when 走写入路径，then 分别记 `OMW_EMBED_AUTH`/`OMW_EMBED_QUOTA`/`OMW_EMBED_TIMEOUT`；超时那条 `vec_state=pending` 且写事务成功；401/402 不重试。
- Given 向量关闭，when 非向量检索，then 返回非空、审计 `degraded_reason` 命中封闭枚举；且测试枚举断言不存在第四态。
- Given 当天无快照，when 启动，then 生成并校验一份；同日再启动最多多一份、不报错；第 8 份时最旧一份被清理，排序规则可被测试观测。
- Given 库仍被打开，when 恢复快照，then 先 `close()`；Windows 句柄未释放时返回可读错误并提示先停止进程。
- Given 缺 `snapshots/pre-migration-<ts>`，when 请求迁移前置判定，then 拒绝并给出原因。

## Spec Change Log

## Review Triage Log

## Design Notes

**库内 `meta.contract_version` 的落地方式。** triviumdb 0.9.3 不提供任何 meta/契约字段（`StorageInfo` 只有 `package_version`/`database_format_*`/`manifest_format`），ADR-19 的「读 `meta.contract_version`」在库里没有对应 API。因此本 epic 用 `flag` 节点承载库侧契约版本：`mem_key = flag:contract_version`、`payload = {flag_type:'contract_version', value:<n>, written_at}`，读写只在 `src/store/meta.ts`。比较语义与错误处理按 ADR-19 不变（库版本 > 代码支持版本 → 整体 no-op 并点名两侧）。

**`[omw] loaded` 只能自己写 stderr。** 宿主 cordis 只把日志压进内存环形缓冲，全树唯一的 exporter 在 boot 里且只收 `warn/error`；`ctx.logger.info` 不会出现在 stdout/stderr/日志文件。因此加载确认由插件自己 `process.stderr.write('[omw] loaded ...\n')` 打一次，且**不**写 `omw.log`（否则 1.3 的「`omw.log` 恰一行」不成立）。

**补丁文件的两级清单。** 插件 `package.json` 声明 `dsh.bundle.patch`；profile `package.json` 的 `dsh.profile.bundles` 列 bundle；profile 的 `cordis.patch.yml` 里新增插件行必须是 `- insert: [{id, name, config}]`（裸条目只覆盖已有 id）。`cordis.yml` 是生成物，头部注释即写明「Edit cordis.patch.yml, not this file」。

**`omw doctor` 的诊断码与运行时八码分离。** 运行时降级码严格封闭为八个；结构性配置问题不属于降级语义，用 doctor 专属码：`OMW_CONFIG_DEP_NOT_DECLARED`、`OMW_CONFIG_WRONG_PATCH_FILE`、`OMW_CONFIG_PATCH_ENTRY_MISSING`、`OMW_CONFIG_SCHEMA`、`OMW_SECTION_NOT_REGISTERED`。库相关检查复用 `OMW_DB_OPEN`/`OMW_SNAPSHOT_VERIFY`/`OMW_DIM_MISMATCH`，凭据缺失复用 `OMW_EMBED_AUTH`（`detail.reason='missing'`）。

**「注入段已注册」如何离线判定。** doctor 加载构建产物 `lib/index.js`，用录制式假 ctx 调 `apply`，断言 `systemPrompt.section` 收到 `name === 'omw:persona'` 且文本非空，随后 dispose。全程零网络、零库写入；它验证的是「产物会注册这个段」，与真实会话的观察互为补充。

**lint 与 G0-6 的机制。** `@typescript-eslint/parser@8.x` 的 peer 要求是 `typescript >=4.8.4 <6.1.0`，与钉住的 7.0.2 冲突，eslint 10 自身也无法解析 TS（`Parsing error: Unexpected token :`）。因此 `pnpm lint` = `tsc --noEmit` + `node scripts/check-layers.mjs` + `eslint .`；层依赖规则由 `check-layers.mjs` 做确定性检查，并用 `test/lint/layers.test.ts`（临时 fixture 上运行该脚本）证明「故意的 `core → seams` import 会让 `pnpm lint` 失败」。

**G0-4 不在本 epic。** G0-4 是「写入→注入→召回最小闭环」，其召回属 FR-5/Epic 2；epics.md 的反向约束禁止为过关而预埋后续 epic 的实现。本 epic 负责 G0-5（真实启用并注入一次）与 G0-6（层依赖静态闸门），G0-1/2/3/8 作为回归保持，G0-4 留给 Epic 2。

**端到端取证的机制与边界。** 端到端只在临时 `DSH_HOME`（环境变量，优先级高于 `~/.dsh`）里做：让 `dsh` 初始化一个自带 profile 模板的临时 profile，把仓库作为 `file:` 依赖装进该 profile 的 `node_modules`，在 profile `package.json` 的 `dsh.profile.bundles` 追加包名、在其 `cordis.patch.yml` 追加 `insert` 条目，然后 `--dump-config` 验证组合结果、真实启动一次会话验证 stderr 的加载行。`dsh` 可执行文件优先取 `OMW_DSH_BIN`，否则用 PATH 上的 `dsh`。由于无人值守环境不保证有可用模型凭据，判定只依赖「加载行 + 段注册标记 + 组合后的树」，模型轮次失败不算失败；「提示文本含 `omw:persona` 正文」由 `test/load/inject.test.ts` 在录制式 ctx 上断言，二者合起来覆盖 1.1 的观察面。

**四个工具名只注册占位。** 1.3 的验收是「no-op 时 `remember/recall/forget/explain` 一个都不注册」，隐含 ok 状态下按名存在；本 epic 注册占位实现，调用返回 `{ok:false, code:'E_NOT_IMPLEMENTED'}`，不写库、不注入。

## Verification

**Commands:**
- `pnpm install` -- expected: 成功，锁定版本与 AR-1 一致，无 peer 冲突
- `pnpm build` -- expected: `lib/index.js` 与 `lib/cli.js` 存在且可 `import`
- `pnpm test` -- expected: 全绿，覆盖 I/O 矩阵每一行
- `pnpm lint` -- expected: 通过；注入一条跨层 import 后失败（G0-6 取证）
- `node scripts/gate.ts --gate g0-6` -- expected: 通过并写 `docs/implementation-artifacts/gates/g0-6.json`
- `node scripts/gate.ts --gate g0-5` -- expected: 通过并写 `docs/implementation-artifacts/gates/g0-5.json`（临时 `DSH_HOME`，不改用户 profile）
- `OMW_E2E=1 pnpm test -- test/e2e` -- expected: 临时 `DSH_HOME` 内加载成功、`[omw] loaded` 出现、提示含 `omw:persona`
- `node lib/cli.js doctor --home <tmp> --profile web` -- expected: 五项按序输出，退出码 0/1 与矩阵一致

**Manual checks (if no CLI):**
- 通读 `src/seams/prompt-composer.ts`：确认 `systemPrompt.` 只在此文件出现，且身份段文本不含逐轮变化内容。
- 通读 `omw.log` 样本：确认一行一事件、字段齐备、无密钥。