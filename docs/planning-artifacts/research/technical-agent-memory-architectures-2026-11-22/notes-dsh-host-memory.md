# DSH 宿主的「记忆」现实基础（侦察结果）

采集：2026-11-22。来源：本机 npm 包 @deepseek-ai/dsh 0.2.2-rc.5 文档与目录实测（$D=包目录，$H=C:\Users\ellio）。

## 1. 会话持久化 — 查证到
- 日志位置：`$H\.dsh\sessions\<cwd转义>\session-<uuid>\session.v4.jsonl.zstd`
- 格式：逻辑 JSONL，物理为校验分帧 zstd；批量 fsync 追加、撕尾截断（`$D\docs\subsystems\persistence.md:341`）
- 读：插件用 `ctx.sessionPersistence.open(id,'read')`，读不取所有权（persistence.md:7,405）；跨会话检索有 session-query + SQLite 全文索引（session-query.md:5）
- 写：需单写者租约；活跃会话已被生命周期 owner 持有，他人 `open(...,'write')` 抛 `SessionAlreadyOwnedError`（persistence.md:11,112）

## 2. 压缩后原始历史仍可取回 — 查证到
- 压缩不删历史：summary 以 `user/message` 的 `surfaceOp:{replace,startSeq,endSeq}` 遮蔽旧节点，`compaction/summary` 记 `shadowedSeqs`（compaction.md:11,16,68）
- `surfaceOp` 只改表面，日志只增不改（persistence.md:376）
- session-query 把事件分为 current / replaced / raw-log-only（session-query.md:11,14）
- 反压缩靠外部插件 billion-context 的 `decompress`（原文存 node:sqlite index.db）；核心 dsh-compaction-basic 无此 API

## 3. 项目级载体
- PROJECT-CARDS.md：属第三方插件 dsh-deep-ptc-mode，另双写 KV `$H\.dsh\storages\deep-ptc-project-cards.json`
- AGENTS.md：由 dsh-agent-instructions 从 cwd 向上发现，会话首个请求注入；子目录版按需 agent.inject()（extension-cookbook.md:113-114）
- skills：扫描 rank `<projectRoot>/.dsh/skills`(100) < `.agents/skills`(200) < `<dshHome>/skills`(400)；模型只看到 name+description，正文调用时加载
- docs/ 目录：无自动加载机制

## 4. 已有的跨会话记忆插件
- 查证到 `$H\.dsh\apps\dsh-tavern\node_modules\dsh-mnemon`@0.5.31（含 dsh-mnemon-provider-hindsight@0.5.6）：三层——每轮注入 USER.md/MEMORY.md、项目文档、记忆空间按需召回
- 另见 hindsight-coding-agent 留痕 `%LOCALAPPDATA%\Temp\hindsight-dsh\session-*.json`
- 未确认：bundles 里无 hindsight 接线，只有 skill，实际是否生效无法确认

## 5. 插件扩展面 — 查证到（extension-cookbook.md:104-132）
- Prompt 注入：`ctx.systemPrompt.section()`（:112）；cache-safe 版 PromptContext（system-prompt.md:44,78）；每步前置 `agent/pre-step`
- 工具：`ctx.tools.register()`（:115）
- 事件：`session/event`、`agent/assistant-stream`、`tools/pre-execute|post-execute`、`agent/turn-stopping`（:106,128）
- GUI：ConversationNodeDefinition + keyed renderer、slots（:128-129）
- 官方自述插件类别："Memory | section provider + tool"（:126）

## 6. 限制（含对常见假设的纠正）
- 不能改宿主日志；不能自造持久化事件类型（未知事件 fail-closed，仅 ignorable:true 留存，persistence.md:193）
- **定时任务存在**（dsh-schedule，cookbook:127）
- **持久化 KV 存在**（`ctx.storage` domain KV，storage.md:5,34-47）
