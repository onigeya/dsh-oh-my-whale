# DSH 宿主能力（风格层落点）digest

> 维度：d3-host。仅使用本机 DSH 安装文档与已安装插件包（README/配置），未读取本项目任何文件。访问日期：2026-11-22。文档无发布日期字段，证据表“日期”列记“未标注（随安装版本）”。

## 范围与结论（≤5 条）

1. 稳定风格契约应做成**静态 PromptSection**：它被渲染进一个 system/message 表面节点，文本一变就“原地替换”，因此字节稳定 = 前缀缓存稳定；任何逐轮变化都应剥离出去。
2. 逐轮动态状态（关系阶段/语域/强度）应走 **PromptContext**：文档明确定位为 cache-safe counterpart，只在变化时、追加在保留历史之后落成 user-role 快照；它不是免费通道，变化即新增一段历史。
3. 生成后只能**审计**、不能**否决或回改**：assistant/message 是 append-only 日志中的不可变消息，agent/turn-stopping 只能通过 agent.steer() 追加一步，不能撤回已提交文本；唯一技术缝隙 llm/stream 被文档要求“只读、不得改写”。
4. 卡片/通知文案没有统一出口：Web 端是注册式 React 插槽（组件拿不到 ctx，无文本后处理管道）；本机 DSH 文档中 ui_card 零命中，卡片生成路径属“未记载”。
5. 异步审计可行但受限：jobs 的 job/settled 可晚于 turn/end，schedule 支持 new_once/new 目标做夜间批处理，但每任务最小间隔 60s、Host 必须常驻；容量/并发上限文档未载。

## 证据表

| # | 主张 | 来源（URL 或 仓库路径:行号） | 发布者 | 日期 | 访问日期 | 置信度 | 类别 |
|---|---|---|---|---|---|---|---|
| 1 | PromptSection 由 name/order/text/interpolate/complete 组成；text 可为静态串或每次装配求值的函数 | docs/subsystems/system-prompt.md:50-73 | DeepSeek（DSH 官方文档） | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 2 | 段按 order 升序、同序按 code-unit 名称排序；重复注册抛错；仓库贡献者用 getSectionOrder() 取中央分配序号 | docs/subsystems/system-prompt.md:52-57,129-147 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 3 | 渲染结果提交为 system/message 表面节点：首步作为节点 0，**渲染文本变化时原地替换**；声明 systemPromptUpdate:'in-history' 时改为追加在缓存历史之后 | docs/subsystems/system-prompt.md:46 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 4 | interpolate:false 保留字面量（含形似变量的目录名），可用于锁定字节 | docs/subsystems/system-prompt.md:64-65,96 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 5 | PromptContext 是 cache-safe counterpart；装配解析排序，agent-loop 仅在**变化或 compaction 移除后**把完整快照追加在保留历史之后（durable user-role 快照） | docs/subsystems/system-prompt.md:78,81-93 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 6 | required:true 使运维型 context 在可选运行时上下文被抑制时仍保留；suppressRuntimeContext() 可整段抑制 | docs/subsystems/system-prompt.md:91-96,157-163 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 7 | system-prompt/assemble 瀑布返回文本具权威性；但若注册了 complete 段，瀑布后会被恢复为该 scope 唯一提示段——监听者无法增删替换 | docs/subsystems/system-prompt.md:218,226-228 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 8 | 注册/释放段与 context 均发出 system-prompt/change（unfiltered 全局通知） | docs/subsystems/system-prompt.md:129,242-252 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 9 | assistant/message 在模型调用成功后写入，记录每次成功调用（含空内容与 max-tokens），内嵌精确 compact 流；turn/end 在其后 | docs/agent-lifecycle.md:53-55,81,85 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档（生成图） |
| 10 | agent/turn-stopping 是 turn 关闭前的 serial 检查点，仅在无工具/无新 steer 时运行；**提出异议的方式是 steer，机器重读 inbox**——不是否决 | docs/agent-lifecycle.md:70-72；docs/subsystems/core.md:406,1092-1114 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 11 | SDK 侧可重放数据应消费 session/event；agent/* 是实时协调 API（队列/状态/提示拦截/请求构造/steering/continuation） | docs/agent-lifecycle.md:91 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 12 | Session 是 append-only 的 SessionEvent 日志，是唯一真相源；LLM 历史由 deriveMessages() 派生而非另存 | docs/subsystems/core.md:415-419 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 13 | Message 是“已标识、不可变的 role/source/content 值” | docs/subsystems/llm-streaming.md:50 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 14 | llm/stream 是每次流式模型调用外的瀑布：可 next() 取适配器流，**或直接 yield 自己的 chunk 短接**；但 loop 构造的请求深冻结（改动抛错），listeners read it, never rewrite it | docs/subsystems/llm-streaming.md:1236-1253 | DeepSeek | 未标注 | 2026-11-22 | 高（机制）/中（是否允许变换产出流，未明写） | 一手文档 |
| 15 | projection unit 是纯同步 fold + 可选 wire view；rendering belongs to the slot system, never this layer；注册表只订阅一次 session/event 并 eager fold | docs/subsystems/session-projection.md:5,44-55,77-88,336 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 16 | Web 端插槽是类型化 React 组合系统：编译期 SlotMap + 运行时声明，cardinality/scope/priority 决定渲染 | docs/subsystems/slots.md:5,21-25,60-69 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 17 | 插槽组件**永远拿不到 ctx**；共享状态走声明的 store，文案通过声明的 locale 命名空间 t 获得 | docs/subsystems/slots.md:101,120 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 18 | 客户端插槽目录是每个 key 的穷尽契约（cardinality/scope/props）；新增子插槽只能在拥有并渲染该位置的组件里声明 | docs/subsystems/slots.md:221,226 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 19 | domain 写入串行于**每域一条写链**：后端持久化 → 改内存 → 发 domain/changed；update(key,fn) 是链上原子的读改写；读是同步内存读 | docs/subsystems/storage.md:143 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 20 | layout 可选 single（整单元一个文档）或 per-record（大/稀疏/可单条丢弃）；版本靠 version+compatibleVersions，无值迁移 runner | docs/subsystems/storage.md:60-67,100-110 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 21 | domain/changed 是**进程内**通知、非事务参与者；跨进程变更推送是已记录的局限 | docs/subsystems/storage.md:170 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 22 | job/settled 可晚于 turn/end；turn 完成不代表 owned jobs 已停止；需要后续结算的消费者要保留 Session 订阅或读持久历史 | docs/subsystems/jobs.md:27-31 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 23 | 输出环形缓冲有界：超出 live cap 丢最旧字节，读者得到 lossy read 而非报错；settled 后裁剪到 settled cap | docs/subsystems/jobs.md:455 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 24 | Schedule 目标三型：复用现有 Session / 建一个并复用（new_once，省略时默认）/ 每次投递新建（new）；投递回执只确认 inbox 写入，不代表模型完成 | docs/subsystems/schedule.md:5,75-84,118 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 25 | 单任务最小投递间隔 60s；new 目标的 newSessionIntervalSeconds 可上调至一周；**Host 必须运行**；宕机只补最近一次到期 | docs/subsystems/schedule.md:24,129,131 | DeepSeek | 未标注 | 2026-11-22 | 高 | 一手文档 |
| 26 | mnemon 未装进全局 npm 根，而作为 apps/dsh-tavern 依赖存在（dsh-mnemon 0.5.31） | C:/Users/ellio/.dsh/apps/dsh-tavern/tavern-plugin/package.json:21；同目录 node_modules/dsh-mnemon | omdsh-dev | 未标注 | 2026-11-22 | 高 | 一手包元数据 |
| 27 | mnemon 每轮把紧凑 USER.md 与 MEMORY.md 注入上下文；项目档案/长期证据按需召回 | .../dsh-mnemon/README.zh-CN.md:36,69-73 | omdsh-dev | 未标注 | 2026-11-22 | 高 | 一手 README |
| 28 | mnemon 的 Strategy 决定哪些常驻/哪些可检索/用哪些工具与预算，Core 校验成本轮**唯一不可变 View**，由 DSH 宿主固定到该轮 | .../dsh-mnemon/README.zh-CN.md:103-104 | omdsh-dev | 未标注 | 2026-11-22 | 中（营销化表述，但机制具体） | 一手 README |
| 29 | mnemon 默认配置：routingGuidance=true、lifecycleEnabled=true、recallMode=guided、writebackMode=guided、idleReviewMs=30000、timeoutMs=10000、defaultRecallLimit=10 | .../dsh-mnemon/cordis.patch.yml:22-43 | omdsh-dev | 未标注 | 2026-11-22 | 高 | 一手配置 |

## 机制拆解（可抄什么 / 不能抄什么）

**可抄 1：把“风格契约”沉淀为常量文本 + 稳定 order。**
PromptSection.text 接受静态串（证据 1），配合 interpolate:false（证据 4）即可保证每次装配产出同一字节串；同一 order 下按名称排序（证据 2），所以只要 name 不变、内容不变，system/message 节点就不会被替换（证据 3），前缀缓存自然稳定。**不能抄**：把“今天关系阶段是 X”这类每轮变化的句子拼进同一段——那等于每轮替换 system 节点，整段前缀作废（这正是文档把动态物分给 PromptContext 的原因）。

**可抄 2：动态状态用 PromptContext 的“变化才落地”语义。**
它只在内容变化或 compaction 移除后追加（证据 5），因此天然是状态机式而非每轮复读。设计上应把关系阶段/语域/强度做成**离散快照**（如 stage=熟悉|亲近），阶段不变就不写；变了才追加一条 user-role 快照。代价是这些快照会永久占据历史（除 compaction），所以每条 token 预算必须硬约束。**不能抄**：把它当“每轮系统提醒”——那会退化成每轮追加一段，反而比静态段更贵。

**可抄 3：生成后审计用“事件 + 投影”而不是“改文本”。**
assistant/message 是不可变消息（证据 13），日志 append-only（证据 12），投影层只做只读读模型且明确“渲染不归这层”（证据 15）。正确姿势：监听 session/event（证据 11）→ 取本条 assistant 文本与工具摘要 → 算风格分 → 写进自有投影供 UI 显示 / 写进 domain KV。**不能抄**：试图在 turn-stopping 里“改上一句”——那里只有 agent.steer() 追加一步（证据 10），用户会看到“再说一遍”的追加文本，属于产品级代价而非透明修复。

**可抄 4：卡片与通知只覆盖“自己产出的文案”。**
Web 插槽组件无 ctx、文案来自 owner props 与 locale t（证据 17），插槽 key 是穷尽契约（证据 18）——没有全局“文本后处理”钩子。风格层能约束的是自己 ui_card/通知工具的入参文案，以及自己注册的插槽组件内文案；DSH 内建状态/通知文案无统一出口（见“未找到”）。**不能抄**：假设有“渲染前统一改写”管道。

**不可抄：用 llm/stream 改写产出文本。**
机制上该瀑布允许直接 yield 自己的 chunk（证据 14），但同一段文档要求 loop 请求“只读不改写”，且 assistant/message 要内嵌“精确 compact 流”（证据 9）——改写会让持久证据与 provider 实际输出不一致，破坏可重构性。**判定：技术上可能、架构上违规、不建议 v1 采用。**

## 可行 / 有代价 / 不可行矩阵

| 能力 | 判定 | 代价与边界 | 证据 |
|---|---|---|---|
| 稳定风格契约注入（静态 PromptSection，字节稳定） | **可行** | 文本一变即 system/message 原地替换 → 前缀缓存作废；须保证 name/order/text 三者都不动 | 1,2,3,4 |
| 每轮动态状态（阶段/语域/强度）注入 | **可行（有代价）** | 用 PromptContext；变化才追加，但追加即永久占历史；required 可防被抑制 | 5,6 |
| 覆盖/替换整段系统提示 | **不可行** | complete 段恢复后，assemble 监听者无法增删替换该 scope 提示 | 7 |
| turn 结束拿到完整 assistant 文本 + 工具摘要 | **可行** | session/event 有 assistant/message（含 compact 流）与 tool/*；实时面走 agent/* | 9,11,12 |
| 阻塞/否决一个 turn | **不可行** | turn-stopping 只有 steer 语义；抛错是否阻断未记载 | 10 |
| 改写已生成的 assistant 文本 | **不可行** | append-only + 不可变 Message；无改写 API | 12,13 |
| 通过 llm/stream 变换输出 | **有代价/不建议** | 机制可短接 yield，但文档要求只读，且破坏证据一致性 | 9,14 |
| Web 渲染前拦截文案 | **不可行** | 插槽组件注册制、无 ctx、无文本后处理管道 | 16,17,18 |
| 自有卡片/通知文案风格化 | **可行** | 仅限自己产出的 payload；DSH 内建文案无出口（未记载） | 17,18 |
| turn 后异步审计（jobs） | **可行** | job/settled 可晚于 turn/end；输出环形缓冲有界、会 lossy | 22,23 |
| 夜间批量评审（schedule） | **可行（有代价）** | 每任务 ≥60s、new 目标可上调到一周、Host 必须常驻、宕机只补一次 | 24,25 |
| 评分/风格状态存储（domain KV） | **可行** | 单域单写链、update 原子；无跨进程推送；容量无记载 | 19,20,21 |
| 与 mnemon 共存 | **可行（需定序）** | mnemon 每轮注入 USER.md/MEMORY.md 并 pin 唯一 View；风格层若也用 per-turn context，两者会在同一 history 位置竞争，应合并到同一条快照或明确先后 | 26,27,28,29 |

## 线索与未找到

- **未记载：前缀缓存的计费/TTL 细节**。文档只有 cache-safe 定性（证据 5），没有缓存命中度量、失效宽限期或 token 折扣数字，无法给出“每次改动损失多少 token”的定量结论。
- **未记载：agent/turn-stopping 监听者抛错是否阻断 turn**。文档只描述 steer 路径（证据 10），未写 rejection 语义。
- **未记载：ui_card**。在本机 DSH docs/ 全目录 grep 零命中；卡片属 Deep PTC 插件工具，本机文档不覆盖其生成/渲染路径。
- **未记载：domain KV 容量/配额**。docs/subsystems/storage.md 只写 layout、版本、写链与事件，没有单域大小上限或配额。
- **未记载：jobs 并发上限**。docs/subsystems/jobs.md 未见并发/排队上限数字（只写 start 原子、list 按调用方作用域）。
- **未核对线索**：grep 命中 docs/subsystems/session.md:296,300 提到每个 surface 事件都带 surfaceOp，暗示存在“表面替换”机制；本轮未展开该文件，**是否存在对既有 assistant 文本的替换式 surface op 仍未确认**——若存在，是唯一可能推翻“完全不可改写”结论的点，建议下一轮定向核对。
- **mnemon 安装范围**：仅见于 .dsh/apps/dsh-tavern 的依赖树，全局 npm 根未见；是否在某个 profile 中启用未确认（只确认“包存在”）。
