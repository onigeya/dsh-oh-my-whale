# dsh-oh-my-whale（鲸鲸）

DSH 记忆插件。**本版本只有底座**：可被宿主加载、可用一条命令体检、坏掉时可以整档退场或只关向量路径。记忆语义（记住、想起、遗忘、解释）属于后续 epic，四个工具名在此只注册占位，调用返回 `E_NOT_IMPLEMENTED`。

> **这份 README 描述的是「已交付」的状态，不是目标状态**（2026-11-25 补记）。文中的「单一安装位、五项体检、八个错误码」都是 Epic 1 的实际形态。目标设计把插件拆成**两个安装位**（记忆位 `profile` + 人格位 `omw-main` preset），届时第 5 项判据、体检项数与错误码个数都会变——那套设计在 [`docs/specs/spec-DSH哦鲸鲸/entry-routing.md`](docs/specs/spec-DSH哦鲸鲸/entry-routing.md)，**尚未实现**。两份文档不冲突，是时点不同：这里写的是现在装得上什么，那里写的是要装成什么样。

## 启用三步

三步缺一即等于没装。**改的是补丁文件，不是生成物。**

### ① 在 profile 里声明依赖与本插件

编辑 `<$DSH_HOME>/profiles/<名字>/package.json`：

```json
{
  "dependencies": { "dsh-oh-my-whale": "file:/path/to/dsh-oh-my-whale" },
  "dsh": { "profile": { "bundles": ["dsh-oh-my-whale"] } }
}
```

`dsh.profile.bundles` 决定宿主是否把这层补丁叠上去；缺了它，后面的条目等于写进了空气。

### ② 在 `cordis.patch.yml` 里加一条 insert 条目

编辑 `<$DSH_HOME>/profiles/<名字>/cordis.patch.yml`：

```yaml
- insert:
    - id: oh-my-whale
      name: dsh-oh-my-whale
      config: {}
```

新增插件必须写成 `- insert:` 下的行；裸条目（只有 `id:`）只能覆盖已存在的 id。

**不要**改 `cordis.yml`：它是每次启动都被重写的生成物，文件头就写着「Edit cordis.patch.yml, not this file」。写错地方时插件不会加载——改完后用 `/omw doctor` 看第 5 项是否 pass，就能确认这次改动有没有真的生效。

### ③ 验证（装完即可用，不必重启）

web profile 里 `dsh-hmr` 是启用的：它监听 profile 的 `package.json`、`cordis.patch.yml` 与 `--patch` 覆盖层，**profile 重新组合时会替换"磁盘上已加载文件发生变化"的插件**——包括 `node_modules` 下的已安装包与 `link:` 包的目标。因此改完本插件（源码重建、`assets/persona.md` 等）之后，触发一次重新组合即可热生效：改一行 `cordis.patch.yml`（例如给条目加一个 `config:` 键），或在 Plugin Manager 里做一次操作。实测：改身份段文本后触发重组合，宿主提示里的 `harness:identity` 段当场换成新文本，无需重启。

headless / SDK / ACP 组合包默认关闭 HMR，那些场景下仍以重启为准。

```bash
dsh --profile <名字> --dump-config   # 组合后的树里应出现 {id: oh-my-whale, name: dsh-oh-my-whale}
dsh --profile <名字> "hi"            # stderr 恰一次 [omw] loaded ... section=harness:identity
```

stderr 的加载行由插件自己写，不走 `ctx.logger`：宿主只把插件日志压进内存环形缓冲，且唯一的 exporter 只转发 `warn`/`error`。这一行也**不**写进 `omw.log`，否则「库坏时 `omw.log` 恰一行」就不成立。

## 体检：`/omw doctor`

在输入框里直接发 `/omw doctor`。它在本进程内跑五项检查，**复用当前实例已经打开的库句柄**——所以它不会和运行中的宿主抢数据库租约，也不需要另起一个进程。插件处于 `no-op` 时命令照样注册（那时最需要它），第 1 项会直接点名让插件退场的那个码。

```
/omw doctor   五项检查
/omw help     说明
```

五项按固定顺序检查，逐项 pass / FAIL / skip：

| # | 检查 | 判据 | 失败码 |
| --- | --- | --- | --- |
| 1 | 库能开 | 当前实例的库句柄可用；整体退场时点名让它退场的码 | `OMW_DB_OPEN` |
| 2 | 快照校验过 | 今天有已校验快照，缺则补做一份 | `OMW_SNAPSHOT_VERIFY` |
| 3 | 维度匹配 | `db.dim` 与库一致 | `OMW_DIM_MISMATCH` |
| 4 | 凭据可用 | `embedding.apiKeyEnv` 指向的环境变量已设置 | `OMW_EMBED_AUTH` |
| 5 | 注入段已注册 | 本实例注册了 `harness:identity` 且文本非空，并报出已注册的工具数 | `OMW_SECTION_NOT_REGISTERED` |

> 第 5 项的判据在**两个安装位**落地后会改（目标设计）：从「本实例注册了该段」改为「`omw-main` preset 内该段可见 ∧ profile 位未注册该段」，因为人格搬进 preset 后，profile 位**不该**再注册任何 section——照现判据体检必然失败。同一时刻还会多出第 6、7 项（折叠接管、`routing.json` 可读），且按安装位报数：只装记忆位报 1–4。见 `entry-routing.md` §八 与 `ARCHITECTURE-SPINE.md` 的 doctor 表。

退出码不适用（它是聊天里的命令）：命令用消息文本报告，有失败时以错误样式返回，摘要给出「k/5 通过」与首个失败码。

体检的边界：**零网络**（凭据项只读环境变量）、不新开数据库连接、不写业务节点。缺当天快照时会补做并校验——这是「快照校验过」这一项的字面含义。「凭据可用」不校验密钥真伪：那需要一次真实请求，与零网络冲突；密钥是否有效由第一次真正调用 embedding 时的 `OMW_EMBED_AUTH` 判定。

## 降级：只有三档，没有中间态

状态封闭为 `ok` / `no-op` / `vector-off`，由单一状态机持有；`no-op` 是终点，进程内**不自愈、不重试**，恢复一律靠重载插件。

| 触发 | 结果 |
| --- | --- |
| 库打不开 / 快照校验失败 / `db.dim` 与库不符 / 库内契约版本高于代码支持 | **整体 no-op**：不注册可执行工具、不排固化、不写任何节点，只写一行原因日志；**身份段照常注入** |
| embedding 凭据无效、欠费 | **只关向量**：`OMW_EMBED_AUTH` / `OMW_EMBED_QUOTA`，不重试 |
| embedding 单次超时 > 2s | 记 `OMW_EMBED_TIMEOUT`，该条 `vec_state` 回落 `pending`，写入照常成功，向量能力**不**关闭 |

运行时降级错误码封闭八个：`OMW_DB_OPEN`、`OMW_SNAPSHOT_VERIFY`、`OMW_DIM_MISMATCH`、`OMW_EMBED_AUTH`、`OMW_EMBED_QUOTA`、`OMW_EMBED_TIMEOUT`、`OMW_EXTRACT_FAIL`、`OMW_DREAM_BUDGET`。新增或改名都算破坏兼容。

> 入口与路由（CAP-9）要在这个封闭集上**再加三个**——`OMW_ROUTE_LOAD` / `OMW_ROUTE_DISPATCH` / `OMW_ROUTE_MISMATCH`，即 8 → 11。那是目标设计，本版本尚未实现；扩集的动作与 `SPEC.md`、`requirements.md`、`epics.md` 同批改（见 `entry-routing.md` §七）。

「坏掉的是记忆，不是人设」是硬约束：库不可用时 `harness:identity` 的文本与健康库**逐字节相同**（`test/degrade/no-op.test.ts` 断言）。

## 数据目录

全部由 `<dataDir>` 派生，`<dataDir> = ctx.dshHomePath('oh-my-whale')`；显式配置 `db.path` 时以其所在目录为准。

```
<dataDir>/
  oh-my-whale.tdb          # 单文件库
  omw.log                  # 一行一事件 {ts, level, code, detail}
  snapshots/               # 每日快照，保留最近 7 份
  audit-YYYYMMDD.jsonl     # 审计（本 epic 只建通道，生产路径不写入）
```

## 开发

```bash
pnpm install
pnpm build          # 清空 lib/ 后产出 lib/index.js（插件入口）
pnpm test           # vitest；会先自动 build
pnpm lint           # tsc --noEmit + scripts/check-layers.mjs + eslint .
pnpm gate -- --gate g0-6   # 层依赖闸门取证 -> docs/implementation-artifacts/gates/g0-6.json
OMW_E2E=1 pnpm test -- test/e2e   # 真实 dsh 会话（临时 DSH_HOME，不动用户 profile）
```

`pnpm lint` 里的层依赖检查不是约定：`scripts/check-layers.mjs` 扫描 import 说明符与禁用调用，故意写一条 `src/core/ → src/seams/` 的 import 会让它非零退出（`test/lint/layers.test.ts` 在临时 fixture 上证明了这一点）。

## 本版本的边界

- 不实现 `remember` / `recall` / `forget` / `explain` 的业务行为，只按名注册占位。
- 不做抽取、不做 dream 八步、不做 tier/rerank/预算裁剪、不做审计轮转、不做迁移与卸载。
- 不做 GUI，不做治理命令，不做 eval 数据集。
- 单进程纯插件：不监听端口、不起后台服务、不 spawn 子进程。
