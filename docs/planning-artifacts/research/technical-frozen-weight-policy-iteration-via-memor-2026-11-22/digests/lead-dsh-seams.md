# DSH 宿主缝（lead 自证，2026-11-22）

作用：为「落地判断」维度提供一手证据——DSH 插件层到底能改什么、不能改什么。

## 1. 模型请求是 provider-neutral 的，不带概率信息

`C:\Users\ellio\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-llm\lib\types\types.d.ts:538` 的 `GenerateOptions` 字段全集：
provider, model, reasoningEffort, messages, system, tools, toolHistory, temperature, maxTokens, stop, signal, sessionId, purpose。

→ **没有 logprobs、没有 logit_bias、没有 n（多候选）**。也就是说 DSH 的通用调用面既不请求 token 概率，也无法按 token 施加偏置。

`C:\Users\ellio\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-llm\lib\types\call-config.d.ts:10-16` `LlmCallControls` 同理，只有 reasoningEffort / temperature / maxTokens / stop。

## 2. llm/stream 瀑布存在，但 loop 请求是深冻结的

`C:\Users\ellio\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-llm\lib\types\index.d.ts:31-46`：
`'llm/stream'(options: GenerateOptions, next) => AsyncIterable<StreamChunk>`，注释明确：
> A LOOP-built request carries the process-local markAgentLoopRequest identity and arrives deep-frozen (mutation throws): its content is a pure function of the session log, so listeners **read it, never rewrite it**.

→ 插件无法在瀑布里改写正常对话请求的 prompt；只能在组装之前（prompt section / runtime context / pre-step）或替换 adapter 才能改变输入。

## 3. 可用的介入面（按“改什么”排序）

| 缝 | API | 证据 | 性质 |
|---|---|---|---|
| 稳定系统提示 | `systemPrompt.section({name, order, text})` | deep-ptc-dsh-plugin-dev 技能；改一次会把整段系统提示重新追加进历史 | 贵，只适合不变文本 |
| 每轮运行态上下文 | `systemPrompt.context({name, order, text, required})` | 同上：文本变化时才追加一条 user 消息，压缩后自动重发 | **注入检索结果的天然缝** |
| 每步改历史 | `agent/pre-step` 瀑布 + `session.append(..., { surfaceOp: { op: 'replace', startSeq, endSeq } })` | 同上 | 可替换模型看到的历史，不改用户看到的消息 |
| 持久记录 | `appendPluginRecord(session, type, data)` + `sessionProjections.register` | 同上 | 案例库/轨迹库的落盘与折叠 |
| 主动发消息 | `agent.steer / inject / followup` | 同上 | 外部触发（定时 dream） |
| 请求体加字段 | `DeepSeekLlmApiExtensionMap` 声明合并 + `DeepSeekLlmApiExtensionProvider.prepare(request)` 返回 `fields` 合并进顶层 body | `C:\Users\ellio\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-deepseek-llm-api-extensions\lib\types\types.d.ts`（"Merge-extensible table of top-level DeepSeek request extension fields"、"Detached top-level fields to merge into the base request"） | **provider 专属逃逸口**：理论上可塞 `logit_bias`，但仅对 DeepSeek adapter 生效，且需服务端真的接受该字段 |
| 换 adapter | 注册自己的 `llm` adapter（dsh-llm-* 模式） | `index.d.ts` adapter registry | 只有自托管 vLLM 之类才谈得上真 logits 干预 |

## 4. 结论（待与研究结论合并）

- 纯 API 客户端路径上，**「logits 调制」不成立**：拿不到 logits，也没有 logprobs 可用。
- 成立的只有：prompt/context 注入（AWM / Memento / Meta-TTL 路线）、多候选重采样后重排（用多次调用代替 n）、provider 专属 body 扩展（需自托管端点）。
- 因此 JitRL 的「记忆→advantage→logits」链路在 DSH 上只能保留**记忆→advantage→候选重排/注入强度**这一半，调制对象从 logits 变成「上下文权重」。
