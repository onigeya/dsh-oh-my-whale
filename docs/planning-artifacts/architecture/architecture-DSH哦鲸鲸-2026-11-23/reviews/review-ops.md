# 评审：运维与环境包络（review-ops）

- **对象**：ARCHITECTURE-SPINE.md（312 行，22 条 AD，status: draft）
- **透镜**：运维与环境包络（ad-hoc）。只判一件事：一个**从没参与设计**的实现者，拿到这份骨架，能不能把「装、跑、坏、修、看」五件事各自做完，而不需要再问一轮。
- **不在本次范围**：裁决正确性、注入预算语义、schema/TBox 设计、GUI 视图、里程碑排期。这些归其他透镜；本文只在它们与运维动作交界处点到为止。
- **方法**：骨架全文；SOLUTION-DESIGN.md 第 8 节降级矩阵、第 9 节可执行不变量、第 12 节遗留风险；C4-VIEWS.md 容器/组件声明；.memlog.md 全部裁定。另**实测**了本机 DSH profile 的启用机制（C:/Users/ellio/.dsh/profiles/web/），用于核对骨架「运行与部署包络」段的说法。
- **纪律**：只读。未实测的判断标注「未证实」。每条发现给出「改哪条 AD / 哪一节 + 改成什么」，不给措辞建议。

> **时点说明（2026-11-25 补记）**：本文件是 **2026-11-23** 的一次评审快照，正文里的「312 行 / 22 条 AD」以及所有行号、AD 编号均指当时版本。收口后的骨架已到 **471 行 / AD-1…AD-55**（并新增 CAP-7、CAP-9 与 NFR-13…NFR-16）。凡与当前骨架冲突，**以骨架为准**；本文件只作「当时为什么这么判」的证据，其结论是否已闭合以 `triage-2026-11-25.md` 与本目录后续评审为准。

---

## 1. 判定口径与结论

| 事 | 实现者能否独立完成 | 卡在哪 | 缺口 |
| --- | --- | --- | --- |
| **装** | 不能 | 骨架说「靠 cordis.yml 补丁 insert 启用」，真实启用是三个文件三处修改，且 cordis.yml 自己写明不要编辑它 | OPS-1、OPS-2、OPS-6 |
| **跑** | 勉强能写代码，不能交付 | 默认值散落在各 AD 正文里，没有一张键表；配置改了要不要重启没人知道 | OPS-2、OPS-9 |
| **坏** | 语义清楚，但发现不了 | AD-13/18/19 的降级语义是这份骨架最强的一面；但「去哪看」只有「宿主日志一行原因」 | OPS-5、OPS-8 |
| **修** | 不能 | 快照有纪律没有步骤；恢复要停库还是热恢复没写；Windows 单文件句柄问题没人提 | OPS-3、OPS-10、OPS-11 |
| **看** | 不能 | AD-20 定义了审计**行**，没定义**读者、阈值、命令**；「今天有没有拖慢 DSH」不可判定 | OPS-4、OPS-7 |

**结论：不通过运维包络门。** 不是语义缺失，是**可执行面缺失**——骨架把「不该做什么」（AD-1 不新增进程、AD-13 故障全停）钉得很死，把「具体怎么做一次」几乎全部留给实现者自己发明。这类缺口不会在评审时暴露，会在 M0 第一天以「配置文件改了没生效」「快照目录在哪」「怎么证明没变慢」三个提问的形式出现。

---

## 2. 发现

严重度：**S1** = 会直接卡住首次交付或造成数据/信任损失；**S2** = 会导致实现者自行发明契约、后期返工；**S3** = 可延后但必须记在册。

### OPS-1 · S1 · 「运行与部署包络」段的启用方式指错文件，且只写了三步中的一步

**位置**：ARCHITECTURE-SPINE.md:239「**运行形态**：DSH profile 内插件，靠 cordis.yml 补丁 insert 启用」。

**实测证据**（本机 C:/Users/ellio/.dsh/profiles/web/）：

- cordis.yml 全文 4 行，内容是一个空数组 []，注释原文：*"The tree is composed as patches: each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any --patch overlays. **Edit cordis.patch.yml, not this file.**"*
- 真正的插件启用要改三处：
    1. package.json → dependencies（装包）**且** dsh.profile.bundles（进加载顺序）；
    2. cordis.patch.yml → 顶层数组里加一个 patch 条目，形状是 id / name / config 三项（本机现有条目如 id: ui-theme、name: "@deepseek-ai/dsh-client-ui-theme"、config: {preference: dark}）；
    3. 重启 DSH 使其重新加载 profile。
- 所以「cordis.yml 补丁 insert」这句话，按字面执行会**改错文件**（改完不生效，且该文件自己叫人别改它）；而 insert 是 patch 条目内部的概念，不是 cordis.yml 的顶层写法。

**最小补法**：把 :239 那一颗 bullet 替换成下面这段（照抄即可）：

    - **启用（三步，缺一不生效）**：
      ① 在 profile 目录 profiles/<profile>/package.json 的 dependencies 加 dsh-oh-my-whale，
         并在 dsh.profile.bundles 数组末尾追加同名条目；
      ② 在同目录 cordis.patch.yml（不是 cordis.yml——后者恒为 []，其注释明确要求改 patch 文件）追加：
           - id: oh-my-whale
             name: dsh-oh-my-whale
             config: { dim: 1024, recall: { topK: 5 } }   # 键表见「配置面」一节
      ③ 重启 DSH。
    - **启用验证（三条全过才算装上）**：启动日志出现唯一一行
      [omw] ready root=<abs> dim=<n> snapshot=<last|none>；pnpm omw doctor 打印同样三值；
      工具列表出现 remember。
    - **停用**：从 dsh.profile.bundles 移除条目并重启（保留数据）；彻底移除见 OPS-11。

同时在 M0 闸门表加一行：G0-5 | 按上述三步在干净 profile 装一次、doctor 通过、卸载干净 | 不进 M1——否则「装」永远没人第一次验证。

**未证实**：改 cordis.patch.yml 是否需要完整重启、还是 profile 有热重载路径——骨架不该假定，写上「重启」这条保守路径即可。

---

### OPS-2 · S1 · 配置面只有一句原则，没有键表，没有 zod 目标

**位置**：ARCHITECTURE-SPINE.md:181（Conventions「配置由 zod 校验，环境变量只承载密钥」）+ AD-13。

**现象**：骨架正文里至少隐含了 **19 个可配置量**，一个名字都没起：库路径、dim、memoryLimitMb、快照目录/保留份数/每日时刻、召回 topK（5，上限 8）、召回超时 800ms、写去抖 3s、抽取开关、dream 日 token 上限、dream 时刻、whatif 开关、embedding baseUrl/模型/超时 2s/重试次数/熔断 10 分钟、审计目录/保留 30 天、legacyMnemonInject、enableRefractoryFatigue。这些默认值现在**只存在于 AD 的叙述句里**（「默认 5、硬上限 8」「默认 3s 去抖，可关」），实现者只能自己发明键名与嵌套形状。

**为什么这是 S1**：配置键名一旦被发明，zod schema、文档、用户在 cordis.patch.yml 里已经写下的 config、以及后续迁移全部绑定在它上面。后期改名等于让用户手改 YAML。而且「哪些键改了必须重建库」是最贵的一类错误——dim 会写进 config，但骨架没说它是**建库即定**（Open Question 1 提了「不是改配置」，但没落成规则）。

**最小补法**：新增一节「## 配置面」（放在「运行与部署包络」之后），一张表 + 三条规则：

| 键 | 类型 / 范围 | 默认 | 来源 | 生效方式 |
| --- | --- | --- | --- | --- |
| dataDir | string，绝对路径 | 由 storage domain 解析（见 OPS-6） | config | 重启 |
| dim | int | 1024 | config | **建库即定**，改只能 migrate |
| memoryLimitMb | int | 512 | config | 重启 |
| snapshot.keep | int >= 1 | 7 | config | 下次快照 |
| snapshot.atLocalHour | 0-23 | 4 | config | 重启 |
| recall.topK | 1-8 | 5 | config | 即时 |
| recall.timeoutMs | int | 800 | config | 即时 |
| write.debounceMs | int | 3000 | config | 即时 |
| write.extractEnabled | bool | true | config | 即时 |
| dream.dailyTokenBudget | int | 待 M0 定 | config | 当日 |
| dream.idleOnly | bool | true | config | 即时 |
| dream.whatifEnabled | bool | false | config | 即时 |
| embedding.baseUrl / .model | string | https://api.siliconflow.cn/v1 / BAAI/bge-m3 | config | 模型变更等同 dim 变更 |
| embedding.dailyRequestBudget | int | 待定 | config | 当日 |
| embedding.apiKey | — | — | **env OMW_SILICONFLOW_API_KEY** | 重启 |
| audit.dir / .retainDays | string / int | <dataDir>/audit / 30 | config | 重启 / 轮转时 |
| legacyMnemonInject | bool | false | config | 即时 |
| enableRefractoryFatigue | bool | false | config | 重启；只读实例强制 false |

三条规则（写进同一节，不进 AD，除非你想让它可被 lint 查）：

1. **密钥只走环境变量**，名字固定为 OMW_SILICONFLOW_API_KEY；config 里出现疑似密钥键即 zod 拒绝启动（长随机串不进 config）。
2. **未知键 fail-fast**：zod strict()；拼错 topk 要报错，不要静默回落默认值——静默回落是「我改了配置但行为没变」这类工单的唯一来源。
3. **不可变键**：dim、dataDir、embedding.model 三者在库已存在时与库内记录不一致 → 走 AD-13 整体 no-op，日志给 code=config_immutable_mismatch，并提示「改维度只能 migrate」（把 Open Question 1 从问题升级为规则）。

---

### OPS-3 · S1 · 每日快照没有触发者、没有补做、恢复没有步骤

**位置**：AD-14（全文一句「每日一次 createSnapshot 后立刻 verifySnapshot」）。

**四个洞，每一个都会让「7 份快照」变成 0 份**：

1. **谁在「每日一次」**：宿主是本地桌面应用（:241「Windows 本地单用户」）。若按「每天 04:00 定时器」实现，机器在 04:00 关着就**永远不触发**。骨架没有任何「错过补做」条款，而同一份骨架在 AD-10 里对 dream 明确写了「错过不补做」——两个相反的沉默，实现者会照 dream 的写法办，于是备份也不补做。**这是整份文档里最贵的一处空白**：备份策略看起来有，实际为零。
2. **恢复怎么做**：restoreSnapshot 被点名了两次，但没有一句写「恢复时库文件还被加载中的插件持有句柄」。Windows 上单文件库在 open 状态下被覆盖会 EPERM/EBUSY（**未证实**，但风险方向明确）。骨架至少要规定：**恢复 = 停 DSH（或先卸载插件）→ pnpm omw restore <generationId> → verifySnapshot → 启动**；并明确「运行中不允许 restore」，而不是留给实现者试。
3. **快照是什么的边界**：只 .tdb？含 audit.jsonl？不含 persona.md（它是 assets/ 里随包发布的，AD-11）？不含 config（在 patch YAML 与 env 里）？不写清，用户会以为「恢复」能救回审计记录与配置。
4. **7 份的排序与失败快照**：按 generationId 还是 mtime 排序？「创建后立刻 verifySnapshot 失败」的那一份，算不算 7 份里的一份、留还是删？（AD-15 的删除豁免只覆盖 src/ops/snapshots.ts，所以删是允许的——但没规定该不该删。）

**最小补法**：把 AD-14 的 Rule 换成四句（保留原有内容，补齐这四点）：

> 每日一次由 seams/schedule 注册：ctx.timer 在 snapshot.atLocalHour 触发；**启动时检查最近一次成功快照的日期，若早于今日则立即补做一次**（快照是备份，不是 dream，「错过不补做」不适用）。触发前先判空闲（与 OPS-9 同一判据）；忙碌则延后 10 分钟重试，最多 6 次。
>
> 快照内容 = {oh-my-whale.tdb} 单文件 + manifest.json；不含 audit、config、persona。快照目录命名 <utc-iso>-g<generationId>，按 generationId 单调排序取最近 7 份；verifySnapshot 失败的那份保留并在 manifest 标 verified=false，**不计入 7 份**，且 doctor 报出。迁移前强制快照，与每日快照同一目录、同一命名。
>
> 恢复只在插件未加载时进行：pnpm omw restore <id> 要求库文件无写句柄，检测到 DSH 正在运行即拒绝并提示「先退出 DSH」；恢复后必须 verifySnapshot 通过才允许下次启动，且必须重载插件（AD-13）。

再加一条到 scripts/ 契约（见 OPS-4）：snapshot / restore / verify 三个子命令必须有**退出码**语义（0 成功、1 校验失败、2 前置条件不满足），否则没法挂进任何自动化。

---

### OPS-4 · S1 · 「怎么知道它今天没在拖慢 DSH」不可判定

**位置**：AD-20。

**现象**：AD-20 定义了审计行的字段（chars / tokens / items / truncated / prefix_unchanged、elapsed_ms / degraded），这一层做得比多数设计好。但它只到「有数据」，没到「有判据」：

- **没有阈值**：elapsed_ms 记了，多少算慢？prefix_unchanged 记了，命中率掉到多少要报警？
- **没有读者**：scripts/（:223）只有 snapshot / verify / migrate --dry-run，没有 audit-report 或 doctor。用户要回答「今天有没有变慢」，只能自己 grep JSONL 再用 Excel 算。
- **degraded 无取值定义**：布尔？枚举？哪些情形算 degraded（召回超时、向量路径缺席、embedding 熔断、注入裁剪）？
- **审计自身可能成为变慢的原因**：audit.jsonl 单文件、retainDays 30，没有轮转（OPS-7）；每轮两次同步 append 到一个不断增长的文件，且 AD-20 没说「审计写失败不得影响注入」。这条必须显式豁免，否则实现者会为了「审计完整」把注入包在 try/catch 里同步等 IO。
- **真正会拖慢 DSH 的那一步没被管**：AD-4 的 agent/turn-stopping 去抖抽取是**每轮一次外部 LLM 调用**（SOLUTION-DESIGN 第 12.4 节自己也承认「长对话会累积」）。骨架没有一句规定它必须异步排队、不得阻塞下一轮首个 token、也不得与 dream 并发抢同一事件循环。

**最小补法**：AD-20 末尾追加一段「判据与读者」，并把 scripts/ 那一行的 CLI 列表补全：

> 判据（dogfood 期只看这三条，不做评分卡）：① 注入渲染 + 召回 + 审计写三项自计时之和 p95 <= 30ms/轮；② 召回 elapsed_ms p95 <= 800ms 且 degraded=true 比例 < 5%；③ 写入同步路径（不含异步 embedding 与抽取）p95 <= 10ms。
>
> 读者：pnpm omw audit-report --since 24h 输出上述三项 p95/比例、注入 tokens 均值、topK 命中分布、degraded 原因直方图，并与上一周期并排。**没有这条命令，「有没有拖慢」这个问题在架构上就是不可回答的。**
>
> 审计写入必须异步（appendFile 队列 + 单次 flush 上限），写失败只记一条内存计数并在下一行体现，**不得使注入失败或变慢**；audit 按本地日期分文件（audit-YYYY-MM-DD.jsonl），保留 retainDays 天。
>
> degraded 取值固定为枚举：recall_timeout | vec_unavailable | embed_circuit_open | budget_truncated（可多值）。
>
> 抽取必须跑在 turn-stopping 之后的后台队列：不阻塞下一轮首个 token；与 dream 互斥（同一条串行队列），队列深度上限 1，超出则丢弃本轮抽取并记 extract_dropped（宁可少记，不可排队）。

**未证实**：DSH 是否暴露逐轮首 token 延迟给插件。所以判据只使用插件侧可自计时的三项——这样即使宿主不给指标，结论也可复算。

---

### OPS-5 · S2 · 故障的唯一出口是「宿主日志写一行原因」，但日志在哪、长什么样没定

**位置**：AD-13（「只向宿主日志写一行原因」）、AD-18。

**现象**：这是「坏 → 修」链路的起点，也是唯一出口，但三件事都没定：写到哪个文件/哪一级、行格式（有没有稳定前缀与错误码）、用户怎么知道去看。SOLUTION-DESIGN.md:207-214 的降级矩阵很好，但它不在骨架里，而骨架是实现者的唯一输入；矩阵里「用户可见 = 无记忆的 DSH」这句话，用户没法验证——没有记忆和记忆正常，在注入层都是「这轮没有记忆段」。

**最小补法**：AD-13 补两句，并在 scripts/ 加 doctor：

> 失败行格式固定：**[omw] startup_failed code=<enum> reason=<单行> root=<path> hint=<一句话可执行提示>**，code 取值 {db_open_failed, snapshot_verify_failed, dim_mismatch, config_immutable_mismatch, contract_version_ahead, resource_exhausted}；同一行同时以 kind=startup_failure 追加进当天的 audit 文件（审计目录不可写时省略，不影响主流程）。
>
> pnpm omw doctor 是「坏」的唯一入口：不加载库也能跑，输出 resolved root、库文件是否存在/大小、dim、最近一次成功快照（id + 时间 + 校验结果）、上次注入时间、vec_state 三态计数、embedding 熔断状态、当前 config 摘要（脱敏）。**任何一条为红，doctor 直接给出下一步命令**（例如「无快照 → pnpm omw snapshot」「dim 不符 → pnpm omw migrate --dim <n> --dry-run」）。

---

### OPS-6 · S2 · 落盘 root 未定，而所有运维动作都依赖它

**位置**：:242「<plugin-data>/oh-my-whale/{...}；实际 root 由 storage domain 决定，M0 确认」+ Open Question 3。

现状合理（用户已裁定走 storage domain，DomainSpec{name, version, layout}），但缺一条纪律：**在 root 未定期间，任何脚本都不得硬编码路径**。scripts/snapshot 若写死 ./data，M0 一次 root 变更就要改三处，且旧快照会「消失」（其实还在，只是没人找得到）。

**最小补法**：在「运行与部署包络」的「数据落盘」那条后面加一句 + 给 M0 加一条出口条件：

> 所有 ops 脚本与 doctor 一律经 store/paths.ts 的 resolveDataRoot() 取路，禁止任何位置出现字面路径；首次启动把 resolved root 打进 [omw] ready 行与 audit 首行，作为「数据到底在哪」的唯一权威答案。
>
> M0 出口条件追加：记录实测 root 绝对路径、可用容量与配额（Open Question 3 结案），写入「运行与部署包络」。

---

### OPS-7 · S2 · 「审计保留 30 天」没有机制，且与 AD-15 的删除禁令边界不清

**位置**：AD-20（保留 30 天）× AD-15（delete( 全仓禁止，唯一豁免是 src/ops/snapshots.ts）。

AD-15 的 grep 门禁针对的是 TriviumDB 的 delete( / unlinkLabel(，理论上不拦 fs.unlink；但**实现者读到的规则是「删除只在一个文件里被允许」**，他会把审计轮转也塞进 snapshots.ts，或者干脆不写轮转（单文件无限增长）。两种结果都不好。

**最小补法**：AD-15 的豁免名单从「一个文件」改为「两个文件、两个目的」，并在 AD-20 指名轮转归属：

> AD-15 豁免：src/ops/snapshots.ts（快照目录清理）与 src/ops/audit-rotate.ts（按日切分与过期删除），两者文件头各写一行豁免注释；其余位置出现删除 API 一律 CI 阻断。

---

### OPS-8 · S2 · embedding 密钥缺失与鉴权失败，与「网络慢」混在一条降级路径里

**位置**：AD-19（重试 → failed → 连续 3 次熔断 10 分钟）。

AD-19 解决的是「慢」，没解决「根本用不了」：

- **缺 key 时启动行为不在 AD-13 列表**。实现者要么猜「整体 no-op」（错：库是好的，注入与文本召回都可用），要么猜「照跑」。必须写死。
- **401/402（key 无效/欠费）与超时/5xx 应不同处理**：前者重试毫无意义，还会在每轮烧 3 次请求；应立即熔断、doctor 报 auth_failed、并在 audit 固定写一条，直到配置变更。AD-19 的「有限次重试后 failed」会把一个配置错误变成 10 分钟一轮的无效重试。
- **没有请求预算**：AD-10 给 dream 设了 token 上限，embedding 一条写就可能一次调用，长会话日调用量无界；embedding.dailyRequestBudget 建议进配置面（OPS-2）。

**最小补法**：AD-19 追加一段：

> 分类处理：ECONNRESET / 超时 / 5xx → 计入 AD-19 的 3 次熔断路径；**HTTP 401/402/403/404(model) 视为配置错误，立即熔断且不重试**，code 取 auth_failed | billing | model_not_found，doctor 与 audit 各报一次，直到 key/model/baseUrl 变更（重启）才解除。缺 OMW_SILICONFLOW_API_KEY 时：**不 no-op**——库照开、注入照常、文本与图召回可用，所有新节点 vec_state=pending，启动日志 code=embedding_unconfigured（与 AD-13 的库故障区分开，明确写进 AD-13 的「不属于全停」清单）。日请求数达 embedding.dailyRequestBudget 后转 pending 排队，次日续。

---

### OPS-9 · S2 · dream 的运行时刻、时区、让路规则缺失

**位置**：AD-10（「周期标记 dream_cycle:<date> 由唯一索引保证一天一次」「错过不补做」）。

缺三样，都会直接影响「今天有没有被拖慢」：

1. **几点跑**：memlog 有「夜间一次 + 空闲兜底」的裁定，骨架只落了「一天一次」。实现者可能写成「启动就跑一次」，于是每次开机都在前台抢 CPU/事件循环跑 8 步。
2. **哪个时区的 date**：Conventions 规定「时间一律 ISO-8601 UTC」。若 dream_cycle:<date> 用 UTC 日期，Asia/Shanghai 用户的「一天」在本地 08:00 才翻页——凌晨 2 点的 dream 与当天 23 点的 dream 会落进同一个 UTC 日，第二晚什么都不跑。这不是风格问题，是**行为错**。
3. **用户在用的时候让不让路**：8 步里 ③④⑤⑧ 是 LLM 调用，可能跑十几分钟。

**最小补法**：AD-10 补三句：

> 调度：ctx.timer 在本地时区 dream.atLocalHour（默认 3）触发；触发时若距最近一次用户活动 < 15 分钟则延后至空闲，当日已过触发点且未跑，则下次「连续空闲 >= 15 分钟」时补跑一次（dream 允许补做，与 AD-14 快照补做同源；「错过不补做」仅指**跨日**不追补历史日期）。dream_cycle:<date> 的 date 取**本地日期**（记录时间戳仍为 UTC）——理由：周期语义是「人的一天」，不是「UTC 的一天」，此处显式偏离 Conventions 的 UTC 约定并注明原因。运行期间若检测到用户活动，在**当前步骤边界**让路：写完 dream_log 后退出，下次续跑。

---

### OPS-10 · S3 · 升级/降级没有契约版本门

AD-21 给 decision 带了 contract_version，但没规定**打开库时比对**。场景：用户回滚到旧版插件，旧版打开新版写过的库 → 静默按旧 schema 解释新字段（未证实 TriviumDB 是否自带 schema 版本拒绝），最坏结果是错读而非报错。

**最小补法**（可并入 AD-13）：

> 库内记录 schema_version 与 contract_version；打开时若库版本 > 插件支持版本 → 按 AD-13 no-op，code=contract_version_ahead，提示「升级插件或从快照恢复」；若库版本 < 插件 → 先 pnpm omw migrate --dry-run 出 diff，人工确认后再执行（AD-14 迁移前快照）。

---

### OPS-11 · S3 · 卸载与数据留存未定义

AD-1 说「随 fiber 销毁由 ctx 回收」，那说的是进程内资源，不是磁盘。卸载后 oh-my-whale.tdb + 7 份快照 + audit 留在 dataDir 里，没人告诉用户它们在哪、要不要删、删了算不算违反「不做物理删除」。用户问「我想彻底清掉这只鲸的记忆」时，实现者没有答案。

**最小补法**：scripts/ 加一个 omw uninstall：打印将删除的绝对路径清单 + 体积，要求 --yes，且**只删 dataDir 下的三个子项**（tdb、snapshots、audit），不碰 profile 与 assets；AD-15 豁免名单加第三个文件 src/ops/uninstall.ts。

---

### OPS-12 · S3 · mnemon 替换缺「先关掉谁」的前置步骤（现役入口未证实）

AD-16 只定义了「怎么迁」与「怎么回退」（legacyMnemonInject），没定义「替换前 mnemon 是怎么被启用的、怎么关」。实测本机 web profile 的 cordis.patch.yml 与 package.json 里**都没有** mnemon 相关条目（memlog 也记着 billion-context 的启用层未证实）——所以现役入口在哪，骨架与证据都不知道。

**最小补法**：AD-16 补一句 + 一个 M0 出口条件：

> 替换前置：迁移前先确认 mnemon 的现役启用点（profile 的 dsh.profile.bundles / cordis.patch.yml 条目 / 独立插件目录），记入 M0 台账；替换 = 关闭该启用点 + 打开 legacyMnemonInject=false，两者必须在同一次重启内完成，不得出现两个注入源并存的中间态（否则前缀缓存与预算都会被双写）。**现役启用层未证实**，M0 必须实测。

---

## 3. 最小补丁汇总（改哪里，一次改完）

| # | 动作 | 目标位置 |
| --- | --- | --- |
| 1 | 重写「运行形态」bullet 为三步启用 + 三条验证 + 停用路径；cordis.yml → cordis.patch.yml | 「运行与部署包络」（:239） |
| 2 | 新增「配置面」一节（19 键表 + 三条规则：密钥只走 env、未知键 fail-fast、不可变键） | 「运行与部署包络」之后 |
| 3 | AD-14 补：触发者 + 启动补做 + 空闲让路 + 快照内容边界 + 7 份排序 + 失败快照处置 + 「恢复必须停库」 | AD-14 |
| 4 | AD-20 补：三条 p95 判据 + audit-report + degraded 枚举 + 审计异步且不得拖慢注入 + 按日分文件 + 抽取后台串行队列 | AD-20 |
| 5 | 新增 AD-23「运维面唯一入口」：doctor / snapshot / restore / migrate / audit-report / uninstall 子命令、退出码语义（0/1/2）、resolveDataRoot() 纪律、日志行格式 | 新 AD |
| 6 | AD-13 补：失败行固定格式 + code 枚举 + 「embedding 未配置不属于全停」+ contract_version 门 | AD-13 |
| 7 | AD-19 补：401/402/403 立即熔断不重试；缺 key 的行为；日请求预算 | AD-19 |
| 8 | AD-10 补：本地时区触发 + 空闲让路 + 步骤边界退出 + dream_cycle 用本地日期（显式偏离 UTC 并说明） | AD-10 |
| 9 | AD-15 豁免名单扩为三个文件（snapshots / audit-rotate / uninstall） | AD-15 |
| 10 | AD-16 补：替换前关闭现役入口，禁止双注入并存；现役层未证实 → M0 实测 | AD-16 |
| 11 | 闸门表加 G0-5：干净 profile 装一次 + 卸载干净 | Gates |
| 12 | Open Question 3（root/配额）改为 M0 出口条件，结案时回填「运行与部署包络」 | Open Questions / Gates |

补完之后，五件事的答案分别落在：装 → 「运行与部署包络」（三步 + G0-5）；跑 → 「配置面」；坏 → AD-13（日志行 + code 枚举）+ doctor；修 → AD-14（恢复步骤）+ AD-23（CLI 与退出码）；看 → AD-20（三条 p95 + audit-report）。

---

## 4. 这份骨架做得对、不要改掉的地方

写下来是为了防止后续修订把好的部分一起削掉：

- **AD-13 的「整体 no-op + 恢复需重载，不做进程内自愈」**：这是运维上最省事的一种故障形态（没有半活状态，没有重试风暴）。OPS-5 / OPS-8 只补它的**可发现性**，不动这条语义。
- **AD-18 注入与工具解耦降级**：把「一处异常拖垮整条链路」挡住，运维上等价于「少几个按钮，不是全黑」。
- **AD-3 禁止节点 id 出现在导出/配置/日志/flag 负载**：这直接决定了「库重建后运维脚本还能不能跑」。很多设计就是死在这一条上。
- **AD-22 撤销是一个操作单元**：它把「删错了」从「整库回滚」（需要停机 + 丢当天数据）降级为「一次事务」，这是运维成本上最大的单项收益。
- **AD-15 静态门**：有了它，上面那些「禁止」才有 CI 兜底，而不是文档承诺。

---

## 5. 本次未验证的事项（不要当成已核实）

1. Windows 上「插件持句柄时覆盖 .tdb」的具体失败形态（EPERM / EBUSY / 静默成功）——**未证实**；OPS-3 的补法按最保守方向（要求停库）写，不影响正确性。
2. DSH 是否向插件暴露逐轮首 token 延迟——**未证实**；OPS-4 的判据只依赖插件自计时，故不阻塞。
3. cordis.patch.yml 改动是否需要完整重启（是否存在热重载路径）——**未证实**；补法按「重启」写。
4. storage domain 的实际 root、容量与配额——骨架已标为 Open Question 3，本次未实测。
5. mnemon 现役启用层——本次实测 web profile 未见相关条目，但可能在其他 profile 或已卸载，**未证实**。
