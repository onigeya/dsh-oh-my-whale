# DSH 宿主落点核查（本机 @deepseek-ai/dsh 0.2.2-rc.5，2026-11-22）

用途：判断参考项目的机制「能搬到哪、代价是什么」。这是宿主事实，不是参考项目证据，也不是产品需求。

## 1. Prompt 注入的两条通道，成本不同
- `PromptSection`：注册后参与 system prompt 组装，按 order 升序拼接；agent-loop 渲染为 `system/message` 表面节点（首步作为 node 0，文本变化时原地替换）。→ 内容随轮变化会改动前缀，迫使上游缓存失效（system-prompt.md:46）。
- `PromptContext`：cache-safe 对位物；其完整快照只会在内容变化或压缩移除后，追加在保留的模型历史之后（system-prompt.md:78）。
- 结论：稳定人设应当走 section 且保持字节级稳定；易变状态（情绪/关系/今天的心情）应走 PromptContext 或工具按需取，不要塞进 section。

## 2. 主动行为有宿主级定时器
- Schedule 独立于会话激活保存任务，七种时序：after / at / every / daily / weekly / cron / rrule；目标可复用会话、新建并复用、或每次新建（schedule.md:5,10）。
- 含义：「主动问候 / 夜间反思 / 日程推进」不必等用户开口；但送达即产生会话与 token 成本，需要节流与安静时段策略。

## 3. 有持久化 KV 与 GUI 扩展点
- `ctx.storage` 是可选能力 seam，domain KV（`ctx.storage.domain`）给插件存结构化状态（storage.md:5）。
- Web 客户端用 `ctx.slots.register()` 注入 UI，注册随 Cordis effect 生命周期移除（slots.md:5,27）；会话内还有 ConversationNodeDefinition + keyed renderer（见 extension-cookbook）。
- 含义：人格/关系/心情面板可以做成 DSH 内视图，不必另开 App。

## 4. 会话日志只读，不能塞自定义事件
- 读写都走 `SessionHandle`；读句柄上的写操作抛 `SessionReadOnlyError`；活跃会话的写句柄由生命周期 owner 持有，第二个 `open(id,'write')` 抛 `SessionAlreadyOwnedError`（persistence.md:11,112）。
- persistence catalog 逐条形貌固定（persistence-catalog.md），没有「插件自定义持久化事件」的位置。
- 含义：状态必须落在插件自己的存储（KV / 文件 / DB），不能污染宿主事件流。

## 5. 长期记忆的原料还在
- 压缩是 surfaceOp 遮蔽：summary 以 `user/message` 的 replace 覆盖旧节点，日志只增不改（compaction.md:11）。
- 含义：离线反思/巩固可以从原始历史里挖料，而不只是吃摘要。

## 6. 对「拟人化」的直接约束（待与参考项目交叉验证）
- 人设常驻文本越短越稳；状态越动态越应外置。
- 任何「每轮变化的人格描述」都会同时付出 token 与缓存两份成本。
- 主动消息是可行的，但宜人化首先要解决「不打扰」，这需要宿主侧节流与用户偏好。
