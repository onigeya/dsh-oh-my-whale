# dsh-oh-my-whale（哦鲸鲸）

DSH 记忆插件。**本版本只有底座**：可被宿主加载、可用一条命令体检、坏掉时可以整档退场或只关向量路径。记忆语义（记住、想起、遗忘、解释）属于后续 epic，四个工具名在此只注册占位，调用返回 `E_NOT_IMPLEMENTED`。

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

**不要**改 `cordis.yml`：它是每次启动都被重写的生成物，文件头就写着「Edit cordis.patch.yml, not this file」。把条目写错地方时，`omw doctor` 会直接告诉你 `OMW_CONFIG_WRONG_PATCH_FILE` 并指向正确文件。

### ③ 重启后验证

```bash
dsh --profile <名字> --dump-config   # 组合后的树里应出现 {id: oh-my-whale, name: dsh-oh-my-whale}
dsh --profile <名字> "hi"            # stderr 恰一次 [omw] loaded ... section=omw:persona
omw doctor --profile <名字>          # 五项全绿，退出码 0
```

stderr 的加载行由插件自己写，不走 `ctx.logger`：宿主只把插件日志压进内存环形缓冲，且唯一的 exporter 只转发 `warn`/`error`。这一行也**不**写进 `omw.log`，否则「库坏时 `omw.log` 恰一行」就不成立。

## 体检：`omw doctor`

```bash
omw doctor [--home <DSH_HOME>] [--profile <名字>] [--json]
```

五项按固定顺序检查，逐项 pass / FAIL / skip：

| # | 检查 | 判据 | 失败码 |
| --- | --- | --- | --- |
| 1 | 库能开 | 打开 `oh-my-whale.tdb`（已存在则以只读打开） | `OMW_DB_OPEN` |
| 2 | 快照校验过 | 今天有已校验快照，缺则补做一份 | `OMW_SNAPSHOT_VERIFY` |
| 3 | 维度匹配 | `db.dim` 与库一致 | `OMW_DIM_MISMATCH` |
| 4 | 凭据可用 | `embedding.apiKeyEnv` 指向的环境变量已设置 | `OMW_EMBED_AUTH` |
| 5 | 注入段已注册 | 构建产物调 `apply` 后注册了 `omw:persona` 且文本非空 | `OMW_SECTION_NOT_REGISTERED` |

退出码：**0** 全部通过、**1** 有检查失败、**2** 未找到 profile。

结构性配置错误不占用上面五项，而是先于它们被判：

| 码 | 含义 |
| --- | --- |
| `OMW_CONFIG_DEP_NOT_DECLARED` | profile 的 `dsh.profile.bundles` 没有本包 |
| `OMW_CONFIG_WRONG_PATCH_FILE` | 条目写进了生成物 `cordis.yml` |
| `OMW_CONFIG_PATCH_ENTRY_MISSING` | `cordis.patch.yml` 里没有 insert 条目 |
| `OMW_CONFIG_SCHEMA` | 条目 `config:` 不合法（点名键与收到的类型） |

体检的边界：一次运行**只追加一行** `omw.log`、**不发任何网络请求**（凭据项只读环境变量）、**不写业务节点**。「凭据可用」不校验密钥真伪——那需要一次真实请求，与「零网络」冲突；密钥是否有效在第一次真正调用 embedding 时由 `OMW_EMBED_AUTH` 判定。

> 第 5 项会用录制式假 ctx 加载 `lib/index.js` 并调用 `apply`，因此你会在这条命令的 stderr 里也看到一次 `[omw] loaded`。那正是它验的东西。

## 降级：只有三档，没有中间态

状态封闭为 `ok` / `no-op` / `vector-off`，由单一状态机持有；`no-op` 是终点，进程内**不自愈、不重试**，恢复一律靠重载插件。

| 触发 | 结果 |
| --- | --- |
| 库打不开 / 快照校验失败 / `db.dim` 与库不符 / 库内契约版本高于代码支持 | **整体 no-op**：不注册可执行工具、不排固化、不写任何节点，只写一行原因日志；**身份段照常注入** |
| embedding 凭据无效、欠费 | **只关向量**：`OMW_EMBED_AUTH` / `OMW_EMBED_QUOTA`，不重试 |
| embedding 单次超时 > 2s | 记 `OMW_EMBED_TIMEOUT`，该条 `vec_state` 回落 `pending`，写入照常成功，向量能力**不**关闭 |

运行时降级错误码封闭八个：`OMW_DB_OPEN`、`OMW_SNAPSHOT_VERIFY`、`OMW_DIM_MISMATCH`、`OMW_EMBED_AUTH`、`OMW_EMBED_QUOTA`、`OMW_EMBED_TIMEOUT`、`OMW_EXTRACT_FAIL`、`OMW_DREAM_BUDGET`。新增或改名都算破坏兼容。

「坏掉的是记忆，不是人设」是硬约束：库不可用时 `omw:persona` 的文本与健康库**逐字节相同**（`test/degrade/no-op.test.ts` 断言）。

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
pnpm build          # 产出 lib/index.js 与 lib/cli.js
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
