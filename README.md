# dsh-oh-my-whale（鲸鲸）

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

退出码不适用（它是聊天里的命令）：命令用消息文本报告，有失败时以错误样式返回，摘要给出「k/5 通过」与首个失败码。

体检的边界：**零网络**（凭据项只读环境变量）、不新开数据库连接、不写业务节点。缺当天快照时会补做并校验——这是「快照校验过」这一项的字面含义。「凭据可用」不校验密钥真伪：那需要一次真实请求，与零网络冲突；密钥是否有效由第一次真正调用 embedding 时的 `OMW_EMBED_AUTH` 判定。

## 追源：`/omw evidence <mem_key>`（聊天里）

每条记忆都能回答「你从哪儿知道的」。写的时候在补丁表的 `evidence` 里给出区间，读的时候按业务键问：

```
/omw evidence assertion:Elliott:likes:coffee
```

输出先是人读的几行，末行是同一次回答的 JSON（`pointers` 与 `degraded` 都在里面），脚本不必解析散文。

写入侧把来源做成**指针节点**，而不是消息副本：payload 只有 `session_id` / `seq_from` / `seq_to` / `quote` / `quote_truncated` / `deidentified` 六个业务键（外加 `kind` 与 `mem_key`），整段消息体一律不进库。指针与它支持的断言在同一事务里落库，边是 `supports`（指针 → 断言）。

引文的两条硬规则，都在写入路径上一次做完，不能事后补：

- **先脱敏，再截断。** 手机号、身份证、邮箱、银行卡命中后替换成 `[手机号]` 这类标记并置 `deidentified: true`；替换会让文本变长，所以顺序反了就可能截出一个没被遮住的号码再截掉标记。截断按**码点**计，上限 200：恰好 200 不截断，201 截断并置 `quote_truncated: true`。
- **指不到就给空，绝不伪造。** 宿主没有回读能力或回读拿不到那段文本时，指针照常落库、`quote` 留空串，读取面报 `degraded: 'evidence-unresolvable'`。空引文分两种来源，读取面会说明是哪一种：写入时就没读到（库内已记录），或本次启动没接入回读。

导出的默认规则（FR-24）：`listEvidenceFor(key)` 只给未脱敏的指针，`listEvidenceFor(key, { includeSensitive: true })` 才给全部。这条规则只落在 `src/store/commits/reads.ts` 一处——新读面直接用它，就不会漏。直接 `/omw evidence` 问一条键时看得到存着的那条（含脱敏版），因为那是「我自己库里的东西」，不是导出。

区间上限 20 条事件（超过报 `E_BOUNDARY`，不会去白读宿主）。一次只查一个业务键；多写一个词会被点名，而不是被默默当成键的一部分。

## 改写与账本：`/omw history` 与 `/omw ledger`（聊天里）

改主意不需要删东西。对同一个单值业务键再 `remember` 一次新值，旧版本**退役**而不是被覆盖：`superseded_at` 记下毫秒时刻、`valid_to` 写下退役的 ISO 时间，新版本以 `active_slot: 1` 进来。默认读取只看未失效的那条；所有版本都还在库里。

`active_slot` 不是「第几版」的小序号，而是唯一索引 `(mem_key, active_slot)` 的让位机制：活版本恒为 `1`，退役版本取 `max(本次写入毫秒, 该键已花过的槽位 + 1)`。所以它是个 13 位的时间戳量级数字，读库时不要按版本序号理解；要知道顺序请按 `valid_from` 排，`/omw history` 就是这么排的。同一毫秒内连改两次也不会撞索引——第二个退役版本取到 `+1`。

```
/omw history assertion:Elliott:lives_in   # 这条键的全部版本，旧值也看得到
/omw ledger  assertion:Elliott:lives_in   # 谁在什么时候、因为什么改了它
```

两条都是只读命令，末行同样给一段 JSON（`versions` / `entries`）。答案码三种：`OK` 表示读到了（可能是一条空列表）、`E_BOUNDARY` 表示这次请求本身不成立、`E_GATE_DOWN` 表示库已关闭或这次没接上。空键会被拒（`E_BOUNDARY`，附用法）；查 `decision:` / `rejected:` 前缀会被拒并说明审计条目没有版本链。`history` 的每一行是一个版本：值、`valid_from` → `valid_to`、退休时刻、写入者；`ledger` 的每一行是一条决策：动作（`insert` / `supersede` / …）、操作号、影响到的业务键、从什么改到什么、理由。

两条命令的分工是刻意的：版本回答「它以前说什么」，账本回答「为什么变成现在这样」。账本条目（`decision:` / `rejected:`）本身没有版本链，查它们会被拒并说明原因——审计记录不参与记忆的版本演化。

## 降级：只有三档，没有中间态

状态封闭为 `ok` / `no-op` / `vector-off`，由单一状态机持有；`no-op` 是终点，进程内**不自愈、不重试**，恢复一律靠重载插件。

| 触发 | 结果 |
| --- | --- |
| 库打不开 / 快照校验失败 / `db.dim` 与库不符 / 库内契约版本高于代码支持 | **整体 no-op**：不注册可执行工具、不排固化、不写任何节点，只写一行原因日志；**身份段照常注入** |
| embedding 凭据无效、欠费 | **只关向量**：`OMW_EMBED_AUTH` / `OMW_EMBED_QUOTA`，不重试 |
| embedding 单次超时 > 2s | 记 `OMW_EMBED_TIMEOUT`，该条 `vec_state` 回落 `pending`，写入照常成功，向量能力**不**关闭 |

运行时降级错误码封闭八个：`OMW_DB_OPEN`、`OMW_SNAPSHOT_VERIFY`、`OMW_DIM_MISMATCH`、`OMW_EMBED_AUTH`、`OMW_EMBED_QUOTA`、`OMW_EMBED_TIMEOUT`、`OMW_EXTRACT_FAIL`、`OMW_DREAM_BUDGET`。新增或改名都算破坏兼容。

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

物理删除有独立的两道门，扫的是**整个仓库**（`src/`、`test/`、`scripts/` 与根目录一层文件），不只是源码树：

1. **函数名**：`delete(` / `deleteManyAtomic(` / `unlink(` / `unlinkLabel(` 按词法 token 判定「调用」，字符串与注释里提到这些名字不算。
2. **事务 op 字面量**：`type: 'delete'` / `'unlink'` / `'unlinkLabel'`，覆盖裸字面量、`as const`、`+` 拼接、无插值模板四种写法。`type` 的取值读不出来时也报（`hard-delete-unreadable`）——静默跳过等于没查。

豁免只对函数名那道生效，且只有 `src/ops/snapshots.ts`、`src/ops/retention.ts`、`src/ops/dispose.ts` 三个路径（后两个是预留，文件尚不存在）；这三个文件的首行必须写 `// AD-15 豁免：<用途>`，门会校验这一行而不是相信清单。op 字面量那道对豁免文件同样生效，删节点只能走退役，没有例外。

## 本版本的边界

- `remember` 已实现（Story 2.1）：整张补丁表规划后一次事务写入，冲突整表拒收并补写一条 `rejected`；`recall` / `forget` / `explain` 仍是占位。
- 追源已实现（Story 2.2）：`remember` 的补丁表可带 `evidence: {seq_from, seq_to}`，`/omw evidence <mem_key>` 读回指针。文本检索跳过 `kind: 'evidence'` 节点——引文是宿主原话的引述，不是我们的记忆，扫它会同一句说两次。
- 改写与账本已实现（Story 2.3）：同键改值走版本链（旧版本退役，不删除），`/omw history` 读版本、`/omw ledger` 读决策。
- 写入的节点 `vec_state` 恒为 `pending`：向量补算属于 Story 2.5，在那之前新记忆不进向量召回。
- 谓词基数只能由用户通过 `/omw pred promote <名> --single|--multi --reason <理由>` 修改。
- `/omw doctor` 只读：不建索引、不写种子、不写审计行。
- 不做抽取、不做 dream 八步、不做 tier/rerank/预算裁剪、不做审计轮转、不做迁移与卸载。
- 不做 GUI，不做治理命令，不做 eval 数据集。
- 单进程纯插件：不监听端口、不起后台服务、不 spawn 子进程。
