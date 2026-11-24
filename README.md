# dsh-oh-my-whale（鲸鲸）

DSH 记忆插件。可被宿主加载、可用一条命令体检、坏掉时可以整档退场或只关向量路径。记忆语义按故事逐步落地：`remember`（写入、追源、版本链）与 `recall`（只读有界召回）已实现，`forget` 与 `explain` 仍是占位，调用返回 `E_NOT_IMPLEMENTED`。

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


## 召回：`recall`（模型按需调用）

记忆不常驻提示词。模型需要翻旧账时自己调 `recall(query, topK?)`，这是唯一的召回入口。

**只给未失效的版本。** 被改写过的旧值留在库里但不再出现——默认读只看 `superseded_at` 缺席的那一版。要旧值请走 `/omw history`。

**两道闸门，不是一个数字的两种叫法。** 候选池（`recall.candidatePool`，默认 12）截的是打分之后的候选，`topK`（默认 5、硬上限 8）截的是最终交给你的条数。30 条命中、池 12、`topK` 5 时，进池 12 条、返回 5 条，答案里 `matched: 30`、`candidates: 12`、`items.length: 5` 三个数分开报，你能看出到底是「库里只有 5 条」还是「被截到 5 条」。

**越界就拒，不静默夹取。** `topK` 给 9、0、-1、5.5、`'5'`、`null`，一律 `E_BOUNDARY` 并在打开任何查询之前拒掉——库访问计数为 0。旧实现用 `Math.min` 把越界悄悄变成「少给几条」，调用方没法区分「只有 8 条命中」和「要了 30 条被砍到 8 条」。

**只返回能叫得出名字的记忆。** 六个记忆类 kind（`assertion` / `entity` / `episode` / `scene` / `pref` / `persona_state`）会被召回；`evidence`（指针，只能经它支持的断言抵达）、`pred`（谓词词表）、`decision` / `dream_log` / `rejected` / `dream_cycle`（只增账本）、`flag`（治理队列）、`whatif` 不进召回。理由不是分类洁癖：决策节点的 `reason` 是一句关于某次改动的散文，拿查询词去匹配它，等于把可调试的账本记录当成一条记忆报给你。没有 `mem_key` 的节点也不返回——报不出来的键，之后也没法追问。

**排序完全确定。** 分数降序 → `mem_key` 升序 → 节点 id 升序。同一份数据跑两次得到同一个键序列，不靠哈希顺序。

**只读。** 一次成功召回对库的写方法调用次数为 0（含 `updatePayload` 与 `flush`，测试用计数代理盯着句柄）。热度、稳定性、计数一律不写回；时间衰减这类因子如果将来要加，也只作读时排序。

```ts
recall(query: string, topK?: number) -> {
  ok, code, tool, message,
  top_k, candidate_pool, candidates,  // 两道闸门各自的门槛
  matched,                            // 过了过滤与打分、进入门槛之前有多少条
  mem_keys: string[],                 // 与 items 一一对应，便于只取键
  items: [{ mem_key, kind, value }],
  elapsed_ms, degraded, degraded_reason[]
}
```

工具面不回 `hits`：读取器内部用它排过序，工具把它摊成 `mem_keys` 与 `items`。输出 schema 是 `additionalProperties: false`，多出来的键会让声明与实现对不上。

`degraded` 在本版本恒为 `false`，这是事实不是省事：还没有重排、没有向量路径、没有线程超时，能发生的失败只有「库不可用」（`E_GATE_DOWN`）与「拒收」（`E_BOUNDARY`），两者都不是降级。字段与封闭词表随本故事一起交付，是为了让 Epic 5 填 `rerank_unavailable` 一类理由时不必改契约。

**没有翻页。** 没有 `offset` / `page` / `cursor`。取不满就少给，不凑数、不补空条目、不报错。

**只读库照样召回。** 库以 `readOnly` 打开、或 schema 未就绪导致写面没有装配时，召回回答得和可写库一样——它依赖的是句柄，不是写面。

召回这一档在注入预算里仍留 0（见下文），因为把召回结果接进宿主通道是 Epic 5 的事；本故事的 recall 只到工具面。

## 注入：两段，一个出口

提示词只从两处进来，且两处调用都只写在 `src/seams/prompt-composer.ts` 里（静态门 `prompt-seam-owner` 会拦下别处的调用）：

| 段 | 通道 | 名 | 序位 | 上限 |
| --- | --- | --- | --- | --- |
| 身份段 | `systemPrompt.section` | `harness:identity` | `-1000` | 1200 字符 |
| 状态尾巴 | `systemPrompt.context` | `omw:persona-state` | `130` | 30 token |

身份段用宿主自己的名字 `harness:identity`，所以它**顶替**宿主那句开场白，而不是并列再加一段；插件卸载即复原。序位 `-1000` 让它排在所有宿主段之前。文本读自 `assets/persona.md`，按码点截到 1200 字符（不会劈开代理对），两次组装文本不变时**不重注册**——宿主持有注册时那份文本，重复注册只会让它重新计算。

状态尾巴是 `context` 通道，内容按 `relationship` → `preference` → `flag` 的顺序装，装不下时**首段一丢后续全丢**，不让低优先级段顶上来补位；三段都没有内容时整段不注册，不写占位文本凑数。Epic 2 阶段还没有状态源，所以尾巴恒为空——`test/load/inject.test.ts` 断言的就是这一点。

### 谁先让位

三档上限相加就是注入池：身份段 1200 字符（进池前按 `estimateTokens` 折成 token，中文接近 1200、拉丁文远小于此）、尾巴 30 token、召回 ≤5 条（每条按 60 token 估）。

超预算时的让位顺序是**召回先让（可以全丢），尾巴从后往前让，身份段不为别档让位**。尾巴的「让」是整段丢：`relationship` → `preference` → `flag` 依次装，某一段装不下时它和它后面的段一起丢，不会跳过它去留一条更低优先级的段。

这里刻意没做成「按身份 > 状态 > 召回的次序依次裁剪」：身份段被预算削短，就等于它不再逐字节稳定，而「库打不开时身份段照常注入」和「连续 100 轮哈希不变」都要求它稳定。所以那三个字的实际含义是**保留优先级**——重要性排序，不是裁剪顺序。

三档的预算各守各的，不互相借：尾巴没用满的额度不会转给召回，否则召回的上限会随宿主状态漂移，「每档各有预算」就变成了「一个池子三家分」。`estimateTokens` 的换算是中日韩一字一 token、拉丁词按空格切、其余非空白各算一个；`RECALL_ITEM_BUDGET_TOKENS`（60）是**每条召回的估值输入**，不是硬上限——一条长记忆会一次吃掉几条的额度，所以召回按「装得下的前缀」取，不是按条数硬塞，也不因为某条太大就跳过去取后面更小的。

召回这一档在注入里还没有通道可走（Story 2.5 交付的是 `recall` 工具，不是注入通道），所以运行时根本不组装召回：真实挂载下 `recall.kept` 恒为空、`tokens` 记 0，而不是去数模型看不到的文本。召回的结果由模型显式调用工具取得，见下节。

注入也不读库。场景（`scene`）这类记忆按需召回，永不常驻：库里有场景节点与库里没有，组装出来的提示词逐字节相同。

### 组装结果长什么样

每次挂载组装一次，结果留在 `runtime.injection`（`InjectionPlan`），审计行（Story 2.6）报的就是这份数字，不重算：

| 字段 | 含义 |
| --- | --- |
| `persona` / `tail` / `recall` | 三档各自的成品与计数，每档都带 `chars`、`tokens`、`truncated` |
| `tail` 的 `kept` / `dropped` | 装进去与让位的**段名**（`relationship` / `preference` / `flag`），不是文本 |
| `recall` 的 `overCount` / `overBudget` | 前者是 `topK` 到顶后的剩余条数，后者是额度装不下的条数；**只有后者算截断** |
| `identityTokens` / `budget` | 身份段折算后的 token 数与三档上限推出的池子 |
| `tokens` | 真正能进提示词的部分，2.5 之前召回那一档不计入 |
| `truncatedItems` | 被削掉的档，取值为 `identity`、`state:<段名>`、`recall` |
| `truncated` | 等价于 `truncatedItems` 非空；两个字段冗余是刻意的，一个给读日志的人，一个给写日志的代码 |
| `prefixUnchanged` | 这次没有重注册身份段（文本哈希与上次相同） |

宿主拒绝注册时不会把异常抛给调用方：`register()` 返回 `failed`（哪条通道失败），并且**旧注册只在新调用成功后才释放**——拒绝替换不该让提示词丢掉已有的身份段。

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

- `remember` 已实现（Story 2.1）：整张补丁表规划后一次事务写入，冲突整表拒收并补写一条 `rejected`；`forget` / `explain` 仍是占位。
- 追源已实现（Story 2.2）：`remember` 的补丁表可带 `evidence: {seq_from, seq_to}`，`/omw evidence <mem_key>` 读回指针。文本检索跳过 `kind: 'evidence'` 节点——引文是宿主原话的引述，不是我们的记忆，扫它会同一句说两次。
- 改写与账本已实现（Story 2.3）：同键改值走版本链（旧版本退役，不删除），`/omw history` 读版本、`/omw ledger` 读决策。
- 召回已实现（Story 2.5）：`recall(query, topK?)` 只返回未失效版本，默认 5 条、上限 8 条，越界拒收而不是静默夹取；候选池（默认 12）与 `topK` 是两道独立闸门。契约见下节。
- 写入的节点 `vec_state` 恒为 `pending`：向量补算还没做，在那之前新记忆不进向量召回，只走文本路径。
- 谓词基数只能由用户通过 `/omw pred promote <名> --single|--multi --reason <理由>` 修改。
- `/omw doctor` 只读：不建索引、不写种子、不写审计行。
- 不做抽取、不做 dream 八步、不做 tier/rerank/预算裁剪、不做审计轮转、不做迁移与卸载。
- 不做 GUI，不做治理命令，不做 eval 数据集。
- 单进程纯插件：不监听端口、不起后台服务、不 spawn 子进程。
