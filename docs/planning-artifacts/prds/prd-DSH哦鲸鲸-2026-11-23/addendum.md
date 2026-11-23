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
- 节点 kind 13 个：`assertion` `evidence` `entity` `episode` `scene` `pref` `persona_state` `flag` `whatif` `decision` `dream_cycle` `dream_log` `rejected`；edge label 11 个：`supersedes` `contradicts` `supports` `refutes` `enriches` `about` `part_of` `derived_from` `anchor` `in_episode` `covers`。`flag` 与 `decision` 是节点不是边；`supported_by` 这类把证据挂在断言上的写法已废弃，统一用 evidence → assertion 的 `supports` / `refutes` 表达极性。

## 6. 运维面

- 启用三步：依赖与 profile bundles → 改宿主补丁文件（**不是**生成物）→ 重启后体检全绿。
- 配置单一出处（AD-26）：`src/seams/config.ts` 的 zod schema 是唯一真相；环境变量只承载 `SILICONFLOW_API_KEY`。主要默认值：`db.dim` 1024、`recall.topK` 5（硬上限 8）、`recall.timeoutMs` 250、`rerank.timeoutMs` 600、`rerank.cacheTtlMs` 600000、`rerank.endpoint` `/systemone`、`rerank.model` `SemIf`（score 任务，备选 `Kev-4b`）、`recall.deadlineMs` 1000、`inject.personaMaxChars` 1200、`inject.tailMaxTokens` 30、`dream.extractModel` `Qwen3.5-4B`、`dream.verifyModel` `DeepSeek-R1-0528-Qwen3-8B`、`budget.dreamModelCallsPerDay` 40、`snapshot.keep` 7、`budget.rerankCallsPerDay` 800、`budget.extractionCallsPerDay` 2000、`budget.embeddingCallsPerDay` 5000、`dream.dailyTokenCap` 200000。
- 错误码固定八个：`OMW_DB_OPEN` `OMW_SNAPSHOT_VERIFY` `OMW_DIM_MISMATCH` `OMW_EMBED_AUTH` `OMW_EMBED_QUOTA` `OMW_EMBED_TIMEOUT` `OMW_EXTRACT_FAIL` `OMW_DREAM_BUDGET`。
- 体检命令查五件事：库能开、快照校验过、维度匹配、凭据可用、注入段已注册。
- 快照：启动时检查「今天有没有已校验快照」，缺则补做；目录名带尝试序号（创建撞名会抛错，属预期分支）；恢复必须先停库。

## 7. 技术栈与里程碑

- 技术栈：Node 24.21.0 / TypeScript 7.0.2 / pnpm 12.18.0 / triviumdb 0.9.3 / DSH 0.2.2-rc.5 / vitest 5.1.1 / eslint 10.15.0 / react 19.3.1 / zod 4.6.7；外部模型全部走 SiliconFlow 三条通道：embedding `BAAI/bge-m3`（dense 1024，2026-11-23 实测；G0-2 已通过）；System One 打分 `SemIf`（`POST /systemone` 的 score 任务，只产分数；剪枝由阈值 + top-k 确定性地做；备选 `Kev-4b`；Alpha 端点、当前免费，待 G0-7 实测）；固化提炼 `Qwen3.5-4B` 与核验 `DeepSeek-R1-0528-Qwen3-8B`（chat completions，模型 id 待 G0-8 实测）。三个通道各自熔断、各自预算（AD-23）。
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
| FR-12 | 三级裁决 | AD-9、AD-22 |
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

**核对规则**：每个 AD 至少被一条 FR 以语义覆盖（26/26），且每条映射都能在 PRD 正文找到对应可测结果；AD-12 只挂 FR-16（关系数值与越界），AD-15 只挂静态门相关的 FR-3 / FR-17，AD-24 只挂治理只读出口 FR-11 / FR-23，AD-25 只挂工具契约 FR-1 / FR-4 / FR-11 / FR-13 / FR-22，AD-23 只挂外部 provider 出口 FR-18 / FR-20。
