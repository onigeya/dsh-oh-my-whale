# 追加材料：技术选型与机制细节

> 本文件承接「该留但不属于 PRD 主体」的深度。本文件引用的 `src/…`、`test/…`、`store/…` 均为**计划路径**（仓库当前只有文档，尚未有代码），落地时以 epics/stories 的实际结构为准。所有 AD 编号指向 `docs/planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/ARCHITECTURE-SPINE.md`；PRD 只写要什么，这里写打算怎么做、以及为什么不是别的做法。

## 1. 存储与身份

- **单文件库，不设适配层**（AD-2）：业务代码只经 `store/` 的具名函数访问 TriviumDB，不引入通用 repository 接口。理由是适配层会把图扩散、payload 过滤、快照校验、字段 CAS 全部削平成 CRUD。只在出现第二个存储后端时才允许抽象。
- **身份是业务键**（AD-3）：`mem_key = <kind>:<subj>:<pred>[:<obj_norm>]`。唯一索引建在 `(mem_key, active_slot)`——活动版本 `active_slot = 1`，被改写时写入 `superseded_at` 的毫秒数，于是「同键至多一条未失效」由数据库在 insert 与 updatePayload 上强制（0.9.3 实测抛 `TDB_UNIQUE_CONSTRAINT`）。`(mem_key, valid_from)` 只建普通复合索引供历史查询。节点 id 是存储局部量，禁止进导出、配置、日志与标记负载。
- **归一化带版本**：`obj_norm` 的算法带 `norm_version` 并写进 payload；换算法必须走一次 `ops/rekey` 迁移（先快照、每条改动写决策账本），禁止静默升级。

## 2. 写路径

- 事务 op 只有 `insert` / `updatePayload` / `link` / `upsertEdge` 等整体替换形态；`delete` / `unlink` 字面量全仓禁止（AD-5）。「删除」= 打 `superseded_at`。三个具名豁免：快照目录清理、审计/日志轮转、卸载前导出。
- 补丁表由领域层依「本轮读到的活动版本」算出**完整最终 payload**，写入口单写者串行提交；冲突以唯一索引抛错为准，抛错即写 `rejected`，不用 CAS。
- 抽取异步：`agent/turn-stopping` 监听器**同步返回**，只做三件事（解析会话、记录待抽取 turn、返回）；去抖与最大等待走进程内定时器（每会话一个），因为该事件被 await 之后才允许边界提交，睡在监听器里等于每个回合多等 3–10 秒。
- 会话由接缝层从 agent 解析，seq 区间由持久游标推进，同一 turn 按 turn 号去重——否则全局去抖会把两个会话并成一个。

## 3. 注入与召回

- 两条注入通道各管一档（AD-7）：身份段走 `systemPrompt.section()`（结果被提交为节点 0，文本一变就击穿前缀缓存，所以不许承载逐轮变化），状态尾巴走 `systemPrompt.context()`（宿主提供的 cache-safe 通道）。
- 召回三段（AD-8）：① 候选 250ms（本地检索放 worker 线程，用原生 RequestContext 定期限——单次 `search()` 是同步调用、没有 timeout 参数）；② 重排 600ms（默认开启，失败只降不空）；③ 注入 20ms。合计硬上限 1000ms，到点交候选。
- 「未失效」过滤器只在一处构造：`store/filters.ts` 的 `liveOnly()`，表达式为 `superseded_at: {$exists: false}`。该操作符未进 0.9.3 的类型声明，本地放宽并钉死版本，M0 补一条语义测试。
- 熔断与缓存：连续 3 次重排超时熔断 10 分钟；结果按（查询指纹, 候选指纹）缓存 10 分钟；日上限见配置。

## 4. 固化

- 八步权威清单与模型边界见 AD-10。①②⑥⑦ 的依赖对象不含模型客户端，由 `test/dream/no-llm.test.ts` 断言。
- 每步产出 diff 后独立提交一条 `dream_log`（阶段、种子、diff、tokens）；崩溃从最后完成阶段续跑。
- 周期标记 `dream_cycle:<date>` 取本地时区日期并把时区与偏移写进节点，夜间窗口本地 02:00–05:00，唯一索引保证一天一次。
- 预算三层取最小：阶段预算 ≤ 日 token 上限 ≤ provider 配额；命中停在段边界并记截断。

## 5. 治理

- 决策账本字段（AD-21）：`{ts, actor, kind, op_id, affected[], target_mem_key, from?, to?, reason, precedent_id?, contract_version}`；断言自身另带 `actor`、`cause`、`prompt_version`，固化产物带周期标识。
- 撤销（AD-22）：`affected[]` 闭包只含状态节点与边（边以 `(from_key, label, to_key)` 表达，绝不用节点 id）；账本类对象（决策、固化日志、拒收记录、周期标记）永不撤销，比较时也排除——否则追加撤销记录会让判据自我否决。
- 节点 kind **16** 个（记忆侧 14 + CAP-7 账本型 2，见 `epics.md:130`）：`assertion` `evidence` `entity` `episode` `scene` `pref` `persona_state` `flag` `pred` `whatif` `decision` `dream_cycle` `dream_log` `rejected`，加上 CAP-7 新增的 `fold` 与 `req_ledger`（2026-11-25 补记，`CONTEXT-GOVERNANCE.md:374`）；edge label 11 个：`supersedes` `contradicts` `supports` `refutes` `enriches` `about` `part_of` `derived_from` `anchor` `in_episode` `covers`。`flag` 与 `decision` 是节点不是边；`supported_by` 这类把证据挂在断言上的写法已废弃，统一用 evidence → assertion 的 `supports` / `refutes` 表达极性。

## 6. 运维面

- 启用三步：依赖与 profile bundles → 改宿主补丁文件（**不是**生成物）→ 重启后体检全绿。
- 配置单一出处（AD-26）：`src/seams/config.ts` 的 zod schema 是唯一真相；环境变量只承载 `SILICONFLOW_API_KEY`。主要默认值：`db.dim` 1024、`recall.topK` 5（硬上限 8）、`recall.timeoutMs` 250、`rerank.timeoutMs` 600、`rerank.cacheTtlMs` 600000、`rerank.endpoint` `/systemone`、`rerank.model` `SemIf`（score 任务，备选 `Kev-4b`）、`recall.deadlineMs` 1000、`inject.personaMaxChars` 1200、`inject.tailMaxTokens` 30、`dream.extractModel` `Qwen/Qwen3.5-9B`、`dream.verifyModel` `deepseek-ai/DeepSeek-R1-0528-Qwen3-8B`、`budget.dreamModelCallsPerDay` 40、`snapshot.keep` 7、`budget.rerankCallsPerDay` 800、`budget.extractionCallsPerDay` 2000、`budget.embeddingCallsPerDay` 5000、`dream.dailyTokenCap` 200000。
- 错误码固定（**十一个**，2026-11-25 由八个扩入 CAP-9 的三个）：`OMW_DB_OPEN` `OMW_SNAPSHOT_VERIFY` `OMW_DIM_MISMATCH` `OMW_EMBED_AUTH` `OMW_EMBED_QUOTA` `OMW_EMBED_TIMEOUT` `OMW_EXTRACT_FAIL` `OMW_DREAM_BUDGET` `OMW_ROUTE_LOAD` `OMW_ROUTE_DISPATCH` `OMW_ROUTE_MISMATCH`。**注意这是两套封闭集，不要混**：上面十一个 `OMW_*` 只用于运行日志与 `/omw doctor`（`omw.log` 的 `code` 字段）；工具返回值另有一套 `E_*` 封闭集，基线是 `E_BUDGET` / `E_TIMEOUT` / `E_DEGRADED` / `E_BOUNDARY` / `E_GATE_DOWN`（AD-25）。CAP-7 只在**后者**上新增两个码：`E_FOLD_BLOCKED`（要求账本核对失败）、`E_FOLD_NOT_SMALLER`（双重严格缩小不成立），见 AD-40。**占位期另用 `E_NOT_IMPLEMENTED`**：`forget` 与 `explain` 两个工具当前仍返回它（`src/seams/tools.ts`），落地后删除，届时 `E_*` 集合才真正封闭。
- 体检命令（聊天内 `/omw doctor`）**实际输出七行**，但**验收归属分成两笔**：前五项属 FR-17（Epic 1 的 Story 1.2 AC 只对这五项负责，见 PRD §4.16 第 1 行），后两项是 CAP-7 与 CAP-9 各自追加、由各自的 FR 验收。**注意第 5 项的判据已被替换**：`epics.md:266` 的 Story 1.2 AC 写的是「注入段已注册」，而本表第 5 项是「`omw-main` preset 内该段可见 ∧ profile 位未注册该段」（AD-46）。这不是扩展而是替换，照旧判据实现会把装对的环境判成 fail，差异已登记在 PRD §4.16 第 4 行。七件事的权威表见骨架 `ARCHITECTURE-SPINE.md` 的 doctor 段：库能开、快照校验过、维度匹配、凭据可用（以上记忆位）；人格段在主对话 preset 内可见（判据：`omw-main` preset 内该段可见 **且** profile 位未注册该段，见 AD-46）；折叠接管是否生效、fold 表可读、账本存在（CAP-7）；`routing.json` 可读且 schema 通过（CAP-9）。
- 命令面只有聊天内斜杠命令：不提供任何进程外 CLI（无 `bin`、无面向用户的 `scripts/` 命令）。`scripts/` 是开发期工具与评测驱动。子进程按 NFR-13 收敛：仅本地量测一类的**一次性短命**子进程允许（带超时、退出即回收），不常驻、不监听端口、不以后台服务形式存在。
- 命令全集（2026-11-26 P0-3 定形为十条平铺注册，均经 `ctx.commands.register`，结果用消息文本报告、无退出码语义）：`/omw-doctor`、`/omw-pred-promote`、`/omw-evidence`、`/omw-history`（原 `version-chain`，P0-4 并名）、`/omw-ledger`、`/omw-stats`、`/omw-explain`、`/omw-flag-queue`、`/omw-export`、`/omw-brief`（FR-39 新增，只读、不推送）。
- 快照：启动时检查「今天有没有已校验快照」，缺则补做；目录名带尝试序号（创建撞名会抛错，属预期分支）；恢复必须先停库。

## 7. 技术栈与里程碑

- 技术栈：Node 24.21.0 / TypeScript 7.0.2 / pnpm 12.18.0 / triviumdb 0.9.3 / DSH 0.2.2-rc.5 / vitest 5.1.1 / eslint 10.15.0 / react 19.3.1 / zod 4.6.7；外部模型全部走 SiliconFlow 三条通道：embedding `BAAI/bge-m3`（dense 1024，2026-11-23 实测；G0-2 已通过）；System One 打分 `SemIf`（`POST /systemone` 的 score 任务，只产分数；剪枝由阈值 + top-k 确定性地做；备选 `Kev-4b`；Alpha 端点、当前免费，G0-7 已实测）；固化提炼 `Qwen/Qwen3.5-9B`（原定 4B 无响应，按预案换同族；G0-8 已实测）与核验 `deepseek-ai/DeepSeek-R1-0528-Qwen3-8B`（chat completions）。三个通道各自熔断、各自预算（AD-23）。
- M0 八道硬闸门：原生模块在 Windows + Node 24 下加载成功（已实测通过，保留为回归项）；embedding 实测维度等于建库维度且单次 <2s（已实测：1024，255–408ms）；压缩后旧 seq 仍能读回原文（已实测：两个真实会话缺号 0）；单条记忆跑通写入-注入-召回闭环；插件在宿主真正启用并完成一次注入；TS 7 + eslint 10 下跨层 import 必须被拦下；`POST /systemone` 打分通道 `answers` 键与候选一一对应、600ms 预算内、断网降级记 `rerank_unavailable`；固化提炼（`Qwen/Qwen3.5-9B`；原定 4B 无响应后按预案换同族）与核验（`deepseek-ai/DeepSeek-R1-0528-Qwen3-8B`）在 SiliconFlow 可用、能读 token 用量，且对缺证据的产物必须判不通过（2026-11-23 已实测通过，见骨架 G0-8）。任一不过不进 M1。

## 8. 被否掉的方案

见 `briefs/brief-DSH哦鲸鲸-2026-11-22/addendum.md` §2：参数式固化、四包服务化 + 多存储后端、只做 ADD 不裁决、召回即写入、FSRS + ACT-R 双理论、把裁决完全交给人、完全交给模型、梯度式连续记忆（CMS）。八条在架构侧均未被重新引入。

## 9. FR → AD 追溯表

供 `bmad-create-epics-and-stories` 直接引用：每个 FR 约束在哪些 AD 之下，story 的验收不得越过这些不变量。

| FR | 主题 | 受约束的 AD |
| --- | --- | --- |
| FR-1 | 写入并追到来源 | AD-2、AD-4、AD-6、AD-21、AD-25 |
| FR-2 | 写入原子性 | AD-4、AD-5 |
| FR-3 | 改写留版本、无业务删除 | AD-3、AD-5、AD-15、AD-21 |
| FR-4 | 召回只读有界 | AD-8、AD-25 |
| FR-5 | 三段召回与退路 | AD-8、AD-19、AD-23 |
| FR-6 | 注入单出口与预算 | AD-7、AD-11、AD-20 |
| FR-7 | 注入与召回可核 | AD-8、AD-20、AD-26 |
| FR-8 | 八步与提炼/核验边界 | AD-10、AD-14、AD-17、AD-23 |
| FR-9 | 断点续跑 | AD-10、AD-21 |
| FR-10 | 预算三层与触发补跑 | AD-10、AD-26 |
| FR-11 | 治理三问 | AD-21、AD-24、AD-25 |
| FR-12 | 三级裁决 | AD-9、AD-22、AD-27 |
| FR-13 | 撤销是操作单元 | AD-5、AD-22、AD-25 |
| FR-14 | 推断可结算 | AD-6、AD-17 |
| FR-15 | 身份不依赖库 | AD-11、AD-13 |
| FR-16 | 状态可缺席、关系数值化 | AD-7、AD-12、AD-20 |
| FR-17 | 启用三步与体检 | AD-1、AD-15、AD-26 |
| FR-18 | 降级两档 | AD-13、AD-18、AD-19、AD-23 |
| FR-19 | 快照与恢复 | AD-14 |
| FR-20 | 成本上限 | AD-23、AD-26 |
| FR-21 | 迁移幂等且可回退 | AD-2、AD-3、AD-16 |
| FR-22 | 抽取判定与读取边界 | AD-4、AD-6、AD-17、AD-25 |
| FR-23 | 治理查询命令 | AD-21、AD-24 |
| FR-24 | 全量导出 | AD-3、AD-5 |
| FR-34 | 写入侧精确去重 | AD-3、AD-4、AD-6 |
| FR-35 | 写放大抑制（不变不写） | AD-3、AD-5、AD-21 |
| FR-36 | 热度读时投影 | AD-8、AD-20 |
| FR-37 | 归档与晋升 | AD-5、AD-10、AD-21 |
| FR-38 | 实体别名归并 | AD-3、AD-9、AD-17 |
| FR-39 | 只读简报命令 | AD-5、AD-24 |
| FR-40 | 证明四列 | AD-17、AD-21 |
| FR-41 | 全局一致性闸门 | AD-9、AD-12 |
| FR-42 | 三值结论 | AD-8、AD-17 |
| FR-43 | 部分证明与缺口 | AD-8、AD-17 |
| FR-44 | 契约层准入判据 | AD-9、AD-21、AD-25、AD-27 |
| FR-45 | 证据计数信念投影 | AD-17、AD-21 |
| FR-46 | 第 0 级观测折叠 | AD-28、AD-35、AD-37、AD-42 |
| FR-47 | 要求账本 | AD-29、AD-31、AD-37 |
| FR-48 | 可逆指针 | AD-30、AD-6 |
| FR-49 | 折叠工具面 | AD-40 |
| FR-50 | 治理五档降级 | AD-36、AD-13、AD-18 |
| FR-51 | 折叠经济性审计 | AD-39、AD-20 |
| FR-52 | 身份免疫 | AD-38、AD-11 |
| FR-53 | 注意力池 | AD-42、AD-45、AD-7 |
| FR-54 | 低密度清理 | AD-44、AD-42 |
| FR-55 | 推演结算字段 | AD-10、AD-17 |
| FR-56 | 四类可校验推演 | AD-10、AD-17 |
| FR-57 | 符号覆盖率闸门 | AD-10 |
| FR-58 | 不确定性折扣 U | AD-17、AD-45 |
| FR-59 | 观看结论自检 | AD-20、AD-25（**Deferred**） |
| FR-60 | 帧覆盖率报数 | AD-20、AD-39（**Deferred**） |
| FR-61 | 零 token 量测 | AD-20、NFR-13（**Deferred**） |
| FR-62 | 图版计价与图片上限 | AD-20、AD-45（**Deferred**） |
| FR-63 | 人格漂移探针 | AD-11、AD-13 |
| FR-64 | 污染判据四条 | AD-11 |
| FR-65 | 人格写入闸门 | AD-12、AD-13 |
| FR-66 | 关系阶段字段 | AD-12 |
| FR-67 | 不讨好约束 | AD-11 |
| FR-68 | 入站危险信号 | AD-12、AD-13 |
| FR-69 | 偏好晋升闸门 | AD-7、AD-12 |
| FR-70 | 降级仍是她 | AD-11、AD-13 |
| FR-71 | 人格体检只报告 | AD-11 |
| FR-72 | 双重严格缩小 | AD-32 |
| FR-73 | 前缀不可重折 | AD-33 |
| FR-74 | 触发时机 | AD-34 |
| FR-75 | 模型选段代码守门 | AD-29、AD-43 |
| FR-76 | 提示词契约 | AD-41 |
| FR-77 | 自有文案门禁 | AD-20 |

**核对规则**：每个 AD 至少被一条 FR 以语义覆盖（AD-1…AD-55，共 55 条），且每条映射都能在 PRD 正文找到对应可测结果；AD-12 只挂 FR-16 与新增的 FR-66 / FR-68（关系数值与越界），AD-15 只挂静态门相关的 FR-3 / FR-17，AD-24 只挂治理只读出口 FR-11 / FR-23 / FR-39，AD-25 只挂工具契约与自检面 FR-1 / FR-4 / FR-11 / FR-13 / FR-22 / FR-44 / FR-59（FR-59 已 Deferred，AD-25 不因此失去覆盖），AD-23 只挂外部 provider 出口 FR-18 / FR-20，AD-27 只挂裁决与契约层准入 FR-12 / FR-44（谓词基数由声明决定，故不出现在写入面），AD-37 只挂折叠与账本 FR-46 / FR-47（检查点单向、不可逆，故不出现在任何召回或写入面）。AD-28…AD-45（上下文治理）由 FR-46…FR-54 与 FR-72…FR-76 覆盖；AD-46…AD-55（入口与路由）由 FR-25…FR-33 覆盖，不在本表重列——它们属 CAP-9，其追溯见 `entry-routing.md` §十（FR 正文 :462–471、AD 段 :434 起）。
## 10. 扩展组的机制细节（2026-11-25，对应 PRD §4.8–§4.15）

PRD 只写要什么；这里写打算怎么做、以及数值为什么是那个数。凡标「待标定」的，指 PRD §8.2 已登记、标定前不得作验收判据。

### 10.1 记忆卫生（FR-34…FR-39）

- 去重指纹 = `sha256(norm_version ‖ mem_key ‖ canonical(content))`；`canonical` 与 FR-35 的字节比对共用同一规范化函数（行尾统一、去尾随空白），否则两条会各算各的。
- 去重窗口是「同谓词同主体全历史未失效版本」，落在唯一索引 `(mem_key, active_slot)` 的读路径上，不额外建表；窗口大小由该键的版本数天然界定（改写会留旧版本，所以窗口会随时间变宽——这是可接受的，因为同键历史本来就少）。
- 近重复相似度用本地字符串相似度（字符级 n-gram Jaccard 或等价物），**不调 embedding**——调 embedding 会让每次写入多一次外部调用，与 FR-20 的日上限打架。0.9 是起点，标定目标是「误报率 <5% 且真实重复召回 >80%」。
- `possible_duplicate` flag 的负载：`{mem_key_a, mem_key_b, similarity, norm_version}`；处置走治理路径，不在写入侧自动合并。
- 归档阈值与 `dream.pruneIdleDays` 一起定义在 `seams/config.ts`；归档 = 打 `valid_to`，不是 delete（AD-5）。
- 别名归并的确定性规则清单（封闭）：`NFKC` 归一 → 去空白 → 小写 → 去常见行政后缀（市 / 省 / 区 / 县 / 路 / 街 / 号）→ 全半角统一。规则集带 `alias_version`，换规则走一次 `ops/rekey`（同 §1 的 `norm_version` 纪律）。
- `/omw brief` 输出固定在 `<dsh home>/storages/<domain>/reports/brief-<date>.md`；只读打开库（`readonly: true`），不进注入与召回。

### 10.2 证明式召回（FR-40…FR-45）

- 推导四列落 payload：`{derivation: 'direct'|'rule'|'dream', rule_id?, justification_id?, depth: number}`——**首列叫 `derivation` 不叫 `origin`**，`origin` 已被 `observed | inference` 占用（见 `data-model.md` §3 的 `assertion` 行），且 AD-17 据它要求 `origin=inference` 必带 `falsifier` 与 `settle_state`；`derivation ∈ {rule, dream} ⇒ origin = inference`（与 `SPEC.md:93` 一致）；`justification_id = sha256(sorted(前提业务键集合))`，只含业务键，不含节点 id（与 AD-3 一致，保证重建库后同 id）。
- 规则集是封闭登记的常量表（不是可写的 Datalog 引擎，G:403–413 已否自研引擎）：每条规则有稳定 `rule_id`、形状与所需前提；新增规则先改表再动代码。
- 一致性检查的邻域定义：查询涉及的 `(subj, pred)` 对 + 一跳邻居；全库检查须显式开启并带 `consistency.checkTimeoutMs`（默认 5000）。检出冲突产出 `{subj, pred, a_key, b_key, reason}`。
- 三态判定不看模型分数：`CERTAIN` = 有闭合证明链且该链未命中任何未解决冲突；`REFUTED` = 有 `refutes` 边形成的反证且无反反证；其余 `POSSIBLE`。判定函数是纯函数，可直接单测。
- 缺口枚举上限 `recall.gapMax`（默认 3）；超出预算只返回已闭合子树，并标 `gap_truncated`。
- 契约层准入 P1/P2/P3 的判据：P1 有可回读证据指针（不是空引用）；P2 与现有契约无矛盾，或有显式 `precedence` 数值可排序；P3 在当前概念数上限内（`tbox.maxConcepts`，默认 10）。
- 置信带：`support_count` / `refute_count` / `source_independence`（去重后的独立来源数）三元组投影到区间；不落库、只读时算，折扣曲线 `confidence.decayHalfLifeDays` 待标定。
- `surprise` 只做预算分配（写入优先级、固化抽样权重），**禁止**参与真假判定——这是与「模型自评」划清界限的那条线。

### 10.3 上下文治理（FR-46…FR-54、FR-72…FR-76）

架构侧细节见 `CONTEXT-GOVERNANCE.md`，此处只登记 PRD 相关接缝：

- 分期与本 PRD 的对应（**2026-11-25 两次裁定：先改判第 1 级进 v1，再把它与第 0 级一起拆到新开的 Epic 8**）：Epic 8 交付 AD-28…AD-45 全组，即第 0 级（AD-28/30/31/35/36/38/39/40/42/43/44/45）与第 1 级（AD-29/32/33/34/41）同批。**不可分批放行**——启用 CAP-7 必须替换宿主的 `compaction-basic`（`CONTEXT-GOVERNANCE.md:400`），第 0 级只折工具输出、对散文零覆盖，只交第 0 级等于拿掉通用压缩器换一个更窄的。两次改判前的写法（「第 1 级推 Epic 8+」「两半都归 Epic 3」）均已废止。折叠阶梯一律写「第 n 级」，`L0–L3` 只指记忆分层（见 PRD §3）。
- 第 0 级的四条判据取值从 `govern.observationMaskChars`（默认 4000）与「同路径被取代」的哈希比对得到；判据集合封闭，扩展须先改 FR-46。
- 要求账本字段与极性核对规则见 AD-31；核对失败即 `fold_blocked`，历史不动。退役复燃记 `RETIRED_REINTRODUCED`。
- 注意力池的 token 估算来源必须单一：用宿主计数器，缺失时用同一套本地估算器，不得两处混算（AD-45）。
- 折叠审计行的字段集合在 FR-51 已列全；`economics_unavailable` 与 `unknown` 是两个不同标记，前者表示宿主不给数，后者表示这次的数没取到。
- 错误码归属：`E_FOLD_BLOCKED` / `E_FOLD_NOT_SMALLER` 加在**工具返回**的 `E_*` 封闭集上（AD-40），不进日志侧的 `OMW_*` 十一个（§6 FR-18）；`fold_blocked`（小写下划线）是审计行里的状态标记，不是错误码，三者别混写。

### 10.4 推演结算（FR-55…FR-58）

- `whatif` 节点 payload 扩展（相对 data-model.md 现有字段）：新增 `edit_op`（结构化改动描述）、`predicted_delta`（预期变化，含目标键与期望值）、`verified_at`（结算时点）、`outcome`（`hit` / `miss` / `undecidable`）。四个字段缺任一不得提交。
- 结算窗口：`dream.whatifSettleSessions`（会话数）与 `dream.whatifSettleDays`（天数），先到者为准；两者默认值待标定。
- 四类推演的判定方式：一致性 → 用 FR-41 同一套冲突检测；可答性 → 用固定问题集的可召回性变化；剪枝后悔 → 归档条目是否在窗口内被重新命中；真值敏感 → 参数扰动下结论是否翻转。前两类可用符号判定，后两类需 FR-57 闸门通过。
- 不确定性折扣 `U` 的合成：`U = 1 - Π(1 - w_i * factor_i)`，四项 factor 分别来自无来源、陈旧度、未决 flag 数、冲突数；权重 `uncertainty.weights` 待标定，未标定前 `U` 只展示不硬过滤。

### 10.5 视频素材（FR-59…FR-62，**整组 Deferred**）

> **2026-11-25：整组移出 v1。** 以下机制**不删**，作为「已想清楚、等前提成立再用」的记录；四条 FR 的编号保留不复用，重启条件见 PRD §6.2 第 6 条（CAP-8 正式立项并写出自己的 AD 之后按届时的能力面重写）。本小节任何数值都**不是** v1 的验收依据。

- 七个观看审计码（封闭集，出自 `FUSION-DESIGN.md:231–239`）：`FRONT_BIAS`（只用首帧就下结论）、`SHEET_READ`（把分镜图/封面当正片内容）、`NO_EVIDENCE`（无时间戳证据就给断言）、`SPAN_GAP`（结论跨越未采样区间）、`AUDIO_AS_VISUAL`（把音频转写当画面描述）、`SINGLE_SOURCE`（只凭单路信号定论）、`STALE_FRAME`（引用了已判为覆盖不足的区间）。新增码必须先改 FR-59。
- 量测层输出 `timeline.json`：`{keyframes[], sceneCuts[], audioEnergy[], durationMs, probeVersion}`；调用形态为一次短命子进程，`spawn` 后立即 `unref` 不必——必须显式 `await exit` 并 `kill` 兜底超时。
- 超时与回收：`video.probeTimeoutMs`（默认 120000）；临时文件写系统临时目录并在 `finally` 删除；失败重试上限 1 次。
- 图版计价：`video.sheetPriceTokens`（一版固定价）、`video.maxImagesInContext`（默认 3）。一版 4 帧与 8 帧同价，因此采样密度在预算内可以加密——这是 FR-60 能重采的经济前提（`research.md:44`）。
- 帧覆盖率：`coverage = 至少取到一帧的 60s 窗口数 / 总窗口数`；低于 `video.coverageFloor`（默认 0.95）触发密度重跑，重跑上限一次。

### 10.6 人格保真（FR-63…FR-71）

- 探针题集落 `eval/persona-probe.jsonl`，每条含 `{id, category: identity|tone|boundary, prompt, expected_points[], rubric}`；版本号写进文件名与报告。
- 污染判据的四个量：综合分（rubric 逐条打分均值）、文本 diff 占比（按规范化后的字符级编辑距离 / 较长者长度）、新增违规条数（命中边界条款）、关键词漂移率（`persona.md` 的关键词集合相对基线的对称差比）。**四个阈值全部入配置**（`persona.pollutionThresholds`）并标待标定（PRD §8.2 的 T4），起点值 15 分 / 50% / 1 条 / 未定；标定前这些数字只用于产出报告、**不自动阻断发布**——写死研究里的数字会违反假设 A6。
- 人格写入白名单在 `persona_state_write` 的 schema 里表达（zod `.strict()` + 列名字典），不是运行时判断；非法迁移在工具执行前返回拒绝（与 FR-16 同一拦截点）。
- 关系阶段推导：四维 → 阶段的映射是常量表 `{temperature, trust, intimacy, understanding} → stage`，阈值写死；`stageHistory` 每次迁移追加一条 `{ts, from, to, cause}`。
- 讨好探针与漂移探针分开存放、分开报告，**不合成总分**——合成就没法说清是「变冷了」还是「变软了」。
- 入站危险信号：确定性正则前置（命中即置顶固定指令），未命中才做一次小分类；`persona.inboundGuard` 可关闭，关闭后行为与原版本逐字相同。
- 「降级仍是她」的三条验收记录落 `eval/degradation-persona.md`：库不可用、向量路径失效、固化失败各一条，每条记 `sha256(personaText)` 与注入文本。

### 10.7 自有文案门禁（FR-77）

- 规则表落 `assets/copy-rules.json`：`{required[], maxLen{}, bannedPatterns[], approvedPhrases[]}`；检查是纯函数，可在测试里直接调。
- 片段 diff 用字符级编辑距离；触及 `approvedPhrases` 即要求显式确认（`copy_confirm` 布尔入参），不确认就拒绝提交。
- 只作用于本插件自产文本的**生成前**；助手消息不进这条路径（§5 非目标不变）。

### 10.8 新增 FR 的 Epic 归属（供 `bmad-create-epics-and-stories` 直接消费）

| Epic | 新增 FR | 条数 | 对应硬闸门（PRD §7.1） |
| --- | --- | --- | --- |
| **Epic 3**（治理面与证明链） | FR-39、FR-40、FR-41、FR-44、FR-45、FR-58、FR-77 | 7 | G-E3-1、G-E3-2、G-E3-4 |
| **Epic 8**（上下文治理两半，2026-11-25 新开，**属 v1**） | FR-46、FR-47、FR-48、FR-49、FR-50、FR-51、FR-52、FR-53、FR-54、FR-72、FR-73、FR-74、FR-75、FR-76 | 14 | **G-E8-0（前置）、G-E8-1、G-E8-2** |
| Epic 4（自动抽取增量） | FR-34、FR-35、FR-69 | 3 | G-E4-1 |
| Epic 5（召回与成本增量） | FR-36、FR-42、FR-43 | 3 | G-E5-1 |
| Epic 6（固化增量） | FR-37、FR-38、FR-55、FR-56、FR-57 | 5 | G-E6-1 |
| Epic 7（人格与迁移增量） | FR-65、FR-66、FR-68、FR-70 | 4 | G-E7-1 |
| **Epic 9**（人格保真新能力面，**不属 v1**） | FR-63、FR-64、FR-67、FR-71 | 4 | 不设 v1 闸门 |
| Deferred（前提不成立） | FR-59、FR-60、FR-61、FR-62 | 4 | 不设 v1 闸门 |

合计 44 条：v1 内 36 条（Epic 3 七条 + Epic 8 十四条 + Epic 4/5/6/7 十五条）、推 Epic 9 四条、Deferred 四条。**Epic 8 是 2026-11-25 第二次裁定的产物**：Epic 3 原本一次拿了 21 条，混了治理查询与上下文治理两类几乎不重叠的代码面，违反「增量可独立交付」；拆分界线是「是否替换宿主的既有机制」——替换的进 Epic 8，只在既有面上补缺口的留 Epic 3–7。**怎么切成 story 不在 PRD 预设**（见 PRD §6.1）。Epic 1 与 Epic 2 **零新增**（用户约束 C1）；三处碰到已交付契约的地方按 PRD §4.16 分层处理：原有语义归还既有 epic，新增项自带检查。Epic 3 收窄为 7 条增量 + 既有 5 条；它与 Epic 8 的分工界线就是上面那条「是否替换宿主的既有机制」——二者**都不得回填 Epic 1/2**，也不得前移到 v1.5 当已交付；人格四条归 Epic 9，不属 v1。
