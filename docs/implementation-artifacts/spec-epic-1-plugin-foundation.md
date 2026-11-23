---
title: 'Epic 1 — 装得上、坏得起：插件底座与可验证的启用'
type: 'feature'
created: '2026-11-23'
status: 'done'
baseline_revision: 'cf04e95038f7fd6d7be37589f3f3fd03bbdcb9b7'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/docs/implementation-artifacts/epic-1-context.md'
  - '{project-root}/docs/planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/ARCHITECTURE-SPINE.md'
warnings: ['oversized', 'multiple-goals']
deferred:
  - summary: >-
      契约版本 flag 以全零向量入库且不带 vec_state，Epic 2 的向量召回上线后可能把这条 flag 当作相似度候选
    evidence: |-
      本 epic 只有文本检索（src/store/search.ts 的全量扫描），这条 flag 目前不进任何排序；一旦 Epic 2 引入向量检索，未过滤 vec_state 或零向量的实现会把 flag:contract_version 混进召回结果。
    location: >-
      src/store/meta.ts:96
    severity: low
  - summary: >-
      快照恢复留下的 .pre-restore-<ts> 备份没有老化或清理，每次恢复都多一份完整库文件
    evidence: |-
      restoreSnapshot 会把主库与 sidecar 改名成 .pre-restore-<stamp>（这是失败回滚所需的保险），但清理属于 ops/retention.ts 的轮转职责，本 epic 不做保留策略，故仅记录。
    location: >-
      src/ops/snapshots.ts
    severity: low
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

### 2026-11-23 — Review pass 1

- verdicts: 58 findings — high 1, medium 30, low 22, false 5, maybe-false 0（重复项各自留行，按同根因归组共享路由）
- routes: patch 45、reject 11、defer 2

- findings:

  **blind-hunter（20）**
  - `[medium]` `[patch]` 默认 embedding 端点是相对路径 `/v1/embeddings`，Node fetch 直接 TypeError，被归为 transient 后静默吞掉 —— 已核对 `src/seams/config.ts` 默认值与 `src/store/embedding.ts` 的 `fetchImpl(options.endpoint)`；最小修复：默认值改为绝对 URL 并用 `z.url()` 校验，transient 失败必须落一行日志。
  - `[medium]` `[patch]` 非向量检索只扫最旧 `candidatePool`（默认 12）个节点即 `break`，超出窗口的新记忆永远搜不到 —— `src/store/search.ts` 的循环即证据；最小修复：扫描全部 id 后再排序切片。
  - `[medium]` `[patch]` 层依赖门有多行 import 漏检（`[^'"\n]*?` 跨不过换行）、字符串里的 `delete(` 误报、含空格路径下 `isMain` 判假导致静默 exit 0、`--root` 指向不存在目录时「0 个源文件全部通过」 —— 评审者已实跑复现；最小修复：正则改 `[\s\S]`、`isMain` 改用 `pathToFileURL`、源文件为 0 时报错、扫描前剥离字符串字面量。
  - `[medium]` `[patch]` `package.json` 的 `types` 指向 `lib/types/index.d.ts`，而 `rootDir: src`/`outDir: lib` 实际产出 `lib/index.d.ts` —— 类型入口指向不存在的文件；最小修复：改指向 `lib/index.d.ts`。
  - `[medium]` `[patch]` `file:` 依赖安装不会构建，`lib/` 被 gitignore 且无 `prepare`，干净克隆装进 profile 后宿主拿到没有入口的包 —— 最小修复：加 `prepare` 构建脚本并在 README 写明。
  - `[medium]` `[patch]` e2e 在路径含空格时 `expect(true).toBe(true); return`，G0-5 仍记为 pass —— 与 verify-gap 同一根因，合并处理：改为真 skip 且 gate 对 skip 判失败。
  - `[medium]` `[patch]` `g0-5.json` 的 detail 只截取 vitest 尾部一行，不含加载行/组合树/段标记 —— `scripts/gate.ts` 用 `lastLine(stdout)`；最小修复：把观察到的加载行写进证据。
  - `[low]` `[reject]` 契约版本过高记成 `OMW_DB_OPEN` —— 日志 detail 已带 `probe:'contract'`、`supported`、`stored`，读者可区分；换码等于给封闭八码加第九个，修复代价大于收益。
  - `[low]` `[patch]` `DegradeMachine.enterVectorOff` 接受任何码（含 `OMW_EMBED_TIMEOUT`），与「超时不得关闭向量」冲突 —— 最小修复：进入 `vector-off` 前断言 `closesVectorPath(code)`。
  - `[low]` `[patch]` `meta.ts` 注释称「旧版本是需要迁移」，实现却接受 `stored <= supported` —— 直接改注释使其与行为一致。
  - `[low]` `[defer]` 契约版本 flag 以零向量入库且无 `vec_state` —— 仅当 Epic 2 的向量召回上线后才可见，记入 `deferred`，附「向量召回应过滤 `vec_state` 与零向量 flag」。
  - `[low]` `[patch]` 状态尾巴在变为 `undefined` 时不释放旧注册 —— `src/seams/prompt-composer.ts` 只在非空分支 dispose；最小修复：补 `else` 分支。
  - `[medium]` `[patch]` `ctx.get('tools')` 与 persona 读取无保护，异常会穿透 `apply` —— 最小修复：tool 解析包 try/catch，persona 读取失败给出可读错误。
  - `[low]` `[patch]` `Audit.append` 实际会抛，与自身注释「报告失败而不抛」矛盾 —— 直接改注释为真实契约。
  - `[medium]` `[patch]` 两处「密钥不外泄」断言比对的字面量永远不可能出现（占位符/错值），脱敏路径实际未被测 —— 最小修复：用真实注入的密钥值做比对。
  - `[false]` `[reject]` 「损坏快照被静默取代而非闸门」 —— `ensureDailySnapshot` 在新快照校验失败时返回 `ok:false` 并让 runtime 进 no-op，「同日最多多一份」是矩阵另一行要求；缺的是该分支的测试（见 verify-gap #1），不是行为错。
  - `[low]` `[defer]` 恢复留下 `.pre-restore-<ts>` 备份且无老化 —— 属 `ops/retention.ts` 的轮转范围，记入 `deferred`。
  - `[low]` `[reject]` 退出码 2 同时表示「未找到 profile」与用法错误 —— 两者都是「跑不起来」，AC 只要求非零；改语义会动 CLI 契约。
  - `[medium]` `[patch]` `prompt-seam-owner`/`hard-delete-owner` 两条 AD 豁免规则无测试 —— 最小修复：在 fixture 上各加一条失败用例。
  - `[false]` `[reject]` 插件自带 `cordis.patch.yml` 是空数组「机制空转」 —— 启用三步（`epics.md` 1.1）明确要求宿主补丁条目，空 bundle 补丁是有意为之。
  - `[low]` `[reject]` 缺 LICENSE / CI —— 不在 Epic 1 意图范围；补 `packageManager` 已并入其它补丁项。
  - `[false]` `[reject]` 「矩阵承诺了未交付行为、Code Map 与实现不符」 —— 修复方式是改本 spec，按规则拒绝。

  **edge-case-hunter（20）**
  - `[medium]` `[patch]` `omw.log` 写入失败（数据目录不可写）会让降级路径抛错、身份段注册不上 —— 最小修复：logger 的 `emit` 内部吞掉写失败并保留内存事件。
  - `[low]` `[patch]` 四个工具注册中途失败会留下部分注册 —— 最小修复：逐个收集 disposer，失败即回滚全部。
  - `[medium]` `[patch]` doctor 第 5 项用空配置调 `apply`，忽略 profile 里的 `db.path`/`snapshot.keep` —— 最小修复：把已解析的 config 传进去。
  - `[medium]` `[patch]` doctor 的段检查会写第二行 `omw.log`（降级态），破坏「每次运行恰一行」 —— 最小修复：段检查注入内存 logger。
  - `[medium]` `[patch]` 补丁文件 YAML 坏掉时被报成「缺条目」 —— 最小修复：profile.problems 非空时判 `OMW_CONFIG_SCHEMA` 并回显解析错误。
  - `[low]` `[patch]` `dsh.profile.bundles` 写成字符串时被当成「空」 —— 最小修复：类型不符记入 problems。
  - `[low]` `[patch]` profile 目录存在但 package.json 缺失时返回退出码 2（「未找到」）—— 最小修复：区分 `PROFILE_UNREADABLE` 并返回 1。
  - `[low]` `[patch]` 状态尾巴清理 —— 与 blind-hunter 同根因，同一补丁。
  - `[medium]` `[patch]` doctor 的快照检查会触发 7 份轮转、可能删掉用户快照 —— 最小修复：诊断路径传 `keep: Number.MAX_SAFE_INTEGER`。
  - `[medium]` `[patch]` 非向量检索扫描窗口 —— 与 blind-hunter 同根因，同一补丁。
  - `[low]` `[patch]` 空批次也先查凭据，缺凭据会被误判为 vector-off 触发 —— 最小修复：空批次提前返回。
  - `[low]` `[patch]` 嵌入成功但 `updateVector`/`updatePayload` 抛错会逃出写入路径 —— 最小修复：包 try/catch 并回落 `pending`。
  - `[medium]` `[patch]` `check-layers` 的 `isMain` 在含空格路径下静默通过 —— 与 blind-hunter 同根因。
  - `[medium]` `[patch]` `--root` 指向错目录仍 exit 0 —— 同根因。
  - `[low]` `[patch]` 只扫 `.ts/.mts/.tsx`，`.js/.mjs` 源文件不受规则约束 —— 并入同一补丁。
  - `[low]` `[patch]` 字符串里的 `delete(` 误报 —— 并入同一补丁。
  - `[low]` `[patch]` 文档写了 `--dry-run` 但未实现 —— 最小修复：实现为只做检查不写证据、不启动 dsh。
  - `[medium]` `[patch]` 加载行无条件打印 `section=omw:persona`，即使段注册失败 —— 最小修复：按实际注册结果打印。
  - `[medium]` `[patch]` e2e 空过 —— 与 blind-hunter 同根因。
  - `[false]` `[reject]` `search.ts` 重复声明 `DEFAULT_TOP_K`/`MAX_TOP_K` 违反「配置单一来源」 —— 分层规则禁止 `store/` import `seams/`，重复是被强制的；改的是 config 头注释的措辞。

  **verification-gap（11）**
  - `[medium]` `[patch]` 启动闸门的快照失败分支（`OMW_SNAPSHOT_VERIFY` → 整体 no-op）无任何测试 —— 最小修复：造 26 个当日快照目录使创建耗尽后挂载，断言 no-op、零工具、恰一行日志。
  - `[high]` `[patch]` 库已存在但当天无快照时，`omw doctor` 以只读句柄补做快照，引擎拒绝（`Read-only database operation denied: create_snapshot`），五项体检必然报失败 —— 评审者已实跑复现；最小修复：需要补做时用可写句柄，并补一条该状态的测试。
  - `[medium]` `[patch]` 真实宿主用的 `ctx.get('tools')` 解析路径无测试 —— 最小修复：录制式 ctx 增加只暴露 `get` 的选项并断言四个工具名。
  - `[medium]` `[patch]` `apply` 对非法配置抛错的保证无测试 —— 最小修复：断言 `apply(ctx, {db:{dim:'1024'}})` 抛出并点名 `db.dim`。
  - `[medium]` `[patch]` e2e 可在零观察下通过 —— 与 blind-hunter 同根因。
  - `[medium]` `[patch]` `decideGates` 的快照/维度分支在生产路径不可达（runtime 自行短路），纯函数契约无人测 —— 最小修复：runtime 一律把四个探针交给 `decideGates`，并补该函数的直接测试。
  - `[medium]` `[patch]` `writeContractVersion` 无生产调用点，契约版本永不落库，ADR-19 闸门实际失效 —— 最小修复：ok 分支在版本缺失时写一次。
  - `[low]` `[patch]` `Runtime.loaded.state` 是构建时快照，与 live `state` getter 会不一致 —— 最小修复：`loaded` 改为 getter。
  - `[low]` `[reject]` e2e 用子串匹配而非行形状 —— 解析 dump 的收益不抵复杂度，且真实会话已证明条目存在。
  - `[low]` `[reject]` doctor 在维度不符时第 1 项 pass、第 3 项 fail —— 矩阵 DIM_MISMATCH 正是要求第 3 项失败；「库能开」判 pass 是准确描述。

  **intent-alignment（6）**
  - `[medium]` `[patch]` 验收取证停在接缝层：没有任何测试以进程方式跑 `node lib/cli.js doctor` 并断言进程退出码 —— 最小修复：加进程级 CLI 测试（0/1/2 三种）。
  - `[medium]` `[patch]` e2e 是唯一的宿主面证据且可空过 —— 与 blind-hunter 同根因。
  - `[medium]` `[patch]` 意图期望在宿主/用户面，而多数断言在录制式 ctx —— 由上面两项补丁（进程级 CLI、真 skip、证据含观察）共同收敛。
  - `[low]` `[reject]` 契约版本码 —— 与 blind-hunter 同根因，同一理由。
  - `[false]` `[reject]` 「审计行形状与写路径越出 Epic 2 边界」 —— spec 的 Code Map 明确把 `search.ts`/`audit.ts` 纳入本 epic 以支撑 1.4 的矩阵行。
  - `[medium]` `[patch]` 1.3 的「不重载连聊数轮状态不变」无测试 —— 最小修复：no-op 挂载后连续两次调用/再次挂载，断言状态与库写入均为零。

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


## Auto Run Result

**Status:** done
**Baseline:** `cf04e95038f7fd6d7be37589f3f3fd03bbdcb9b7`

### 实现摘要
Epic 1（1.1–1.5）以**一个可被 DSH 真实加载的插件底座**交付：分层目录 + 锁定版本工具链 + `apply(ctx, config)` 入口 + 字节稳定的身份段注入（`omw:persona`）；`omw doctor` 五项按序体检与非零退出码；库打不开/快照校验失败/维度不符/契约版本过高 → 整体 no-op（身份段照常、四工具零注册、日志恰一行）；向量故障 → 只关向量（401/402/维度不符），超时只记 `OMW_EMBED_TIMEOUT` 且写入照常、节点留 `vec_state=pending`；每日快照做后即校验、保留 7 份、恢复先关库、迁移前必须已有 `pre-migration-*`。闸门 G0-5/G0-6 以真实宿主会话与故意违规 fixture 双重取证。

### 变更文件（按职责）
- `package.json` / `tsconfig.json` / `tsconfig.test.json` / `eslint.config.js` / `vitest.config.ts` / `.gitignore` / `cordis.patch.yml` / `README.md` — 包清单（`dsh.manifestVersion/bundle.patch`、`bin.omw`、`prepare`、`packageManager`）、构建与测试配置、启用三步与降级语义文档
- `assets/persona.md` — 身份段唯一来源（四段 338 字符）
- `src/index.ts` — 插件入口：`export apply`/`inject=['systemPrompt']`，stderr 打印一次带真实段注册状态的加载行
- `src/seams/{config,prompt-composer,logger,tools,runtime,vector,json-schema}.ts` — 配置单一真相、唯一注入出口、一行一事件日志、四个占位工具、启动装配与降级决策、向量失败策略
- `src/core/{degrade,gates}.ts` — 三态状态机与封闭八码/`degraded_reason` 枚举、四个探针的有序闸门（纯函数）
- `src/store/{db,meta,search,embedding,vector-write}.ts` — triviumdb 唯一接触点、契约版本 flag、全量文本检索、2s 超时与 401/402 映射、先提交节点再挂向量的写入路径
- `src/ops/{snapshots,audit}.ts` — 每日快照/校验/轮转/恢复/迁移前判定（AD-15 豁免）、审计行与封闭 `degraded_reason` 校验
- `src/cli.ts`、`src/cli/{doctor,profile,recording-ctx}.ts` — `omw doctor` 命令面、profile 三文件解析、录制式离线 ctx
- `scripts/check-layers.mjs`、`scripts/gate.ts` — 层依赖/写权限门、G0-5/G0-6 证据生成
- `test/**`（10 个文件、92 个用例）— 覆盖 I/O 矩阵全部 16 行、进程级 CLI 退出码、真实 `dsh` e2e
- `docs/implementation-artifacts/{epic-1-context.md,spec-epic-1-plugin-foundation.md,gates/g0-5.json,gates/g0-6.json}` — 本 epic 的上下文、规格与闸门证据

### 评审结果
- 共 58 条发现：high 1、medium 30、low 22、false 5；路由 patch 45、reject 11、defer 2。
- **patch 45 条**落地为 24 组修复：默认端点改绝对 URL 并校验、非向量检索改全量扫描、`check-layers` 四处门缺陷（跨行 import、字符串误报、含空格路径、`--root` 失效）、`types` 指向修正与 `prepare`/`packageManager`、e2e 空过改真 skip、G0-5 证据收录真实加载行并实现 `--dry-run`、`omw doctor` 四处（只读补快照误报、诊断触发轮转删除、段检查忽略配置、第二行日志）、profile 解析问题归类与退出码、状态尾巴清理、`runtime` 三处（工具解析保护、`loaded` 改 getter、契约版本落库）、加载行按真实注册状态、`enterVectorOff` 断言、注释与行为对齐、`redact` 处理 Error/循环、空批次提前返回、向量挂载失败回落、工具注册全回滚、`decideGates` 全探针接线 + 直测、新增 9 组测试（快照 no-op、库存在无快照、进程级 CLI、非法配置、`ctx.get('tools')`、no-op 多轮不变、密钥泄漏双向、两条 AD 豁免规则）。
- **defer 2 条**写入 frontmatter：契约版本 flag 的零向量/缺 `vec_state`（Epic 2 向量召回需过滤）、恢复备份 `.pre-restore-*` 无老化（属 `ops/retention.ts`）。
- **reject 11 条**：false 5（损坏快照「静默取代」实为新快照失败即 no-op；空 bundle 补丁是启用三步的有意设计；矩阵/Code Map 类发现只能改 spec；维度不符时第 1 项 pass 是准确描述；`store/` 内重复常量被分层强制）+ low 6（契约版本记 `OMW_DB_OPEN` 但 detail 已带 `probe/supported/stored`，换码要动封闭八码；退出码 2 语义、LICENSE/CI、e2e 子串断言等修复代价大于收益）。

### 后续评审建议
`followup_review_recommended: true` —— 本轮 patch 含 1 条 high（`omw doctor` 在「库已存在但当天无快照」时必然误报失败）。未实机复核的风险：该修复把医生从只读改为可写补做快照，只在临时 `DSH_HOME` 与进程级 CLI 测试中验证过，尚未在真实用户 profile（真实引擎锁文件、已有 7 份快照）上核对。

### 验证（本轮实跑，非转述）
- `pnpm install --frozen-lockfile` → exit 0
- `pnpm build` → exit 0（`lib/index.js`、`lib/cli.js`）
- `pnpm lint` → exit 0（`tsc` src + `tsc` test + `layers: 21 个源文件，全部规则通过` + eslint）
- `pnpm test` → 9 文件通过 / 1 skip，**91 passed | 1 skipped**
- `node scripts/gate.ts --gate g0-6` → pass（`tree-clean` / 故意违规报 `core-no-seams` / 移除后恢复通过）
- `node scripts/gate.ts --gate g0-5` → pass，证据 detail 为真实观测行 `[omw] loaded state=ok section=omw:persona …`
- `OMW_E2E=1 pnpm test -- test/e2e` → pass（临时 `DSH_HOME` 中的真实 `dsh` 会话，60→ 全绿）
- 矩阵审计：16 行 I/O 矩阵逐行有对应测试且均已实跑通过

### 残余风险
- 写方法收敛（`insert|updateVector|commitTransaction` 仅限 `store/commits/`）未强制：Epic 1 没有 commits 层，留待 Epic 2。
- `omw:persona-state` 通道已接线但本 epic 无状态来源，故未注册（AD-11「缺值整段省略」）。
- `omw doctor` 的凭据项只判环境变量存在（零网络约束），不验真伪；真伪由首次 embedding 的 `OMW_EMBED_AUTH` 判定。
- `snapshots/` 会残留引擎产物 `.<name>.snapshot.lock`，列目录时已忽略但未清理。
- e2e 需要 PATH 上的 `dsh`（或 `OMW_DSH_BIN`）与已热的 pnpm store，默认跳过；G0-5 现在把「被跳过」判为失败。
- 工作树里 `docs/planning-artifacts/**` 的改动由外部工具在本轮期间重写（13:47–15:25），不是本 epic 的产物；它们在收尾时一并提交以保持工作树干净，但未纳入本次代码评审的 diff。
