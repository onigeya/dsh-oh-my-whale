# R5 · OpenCharacters × HerAndHim：拟人化 / 宜人化拆解

访问日期 **2026-11-22**。OC = josephrocca/OpenCharacters @ `1aec478fd1d2e7f601272b80d3b56063ab929781`；HH = ericwang915/HerAndHim @ `08bb1c2740eba1e7cfe25378ea1adca34a9b5568`。

## 1 概览
- **OC**：浏览器端单页角色扮演应用。401★，MIT，23 个 blob，`index.html` 7940 行 + `utils.js` 618 行；最近提交 2025-03-29，README 自述"maintenance mode"，**低活跃但代码完整**。
- **HH**：自托管陪伴引擎（Python）。37★，AGPL-3.0，240 个 blob、20 个 `tests/test_*.py`；最近提交 2026-10-06（近三月有安全、TTS、dashboard 加固提交），**活跃**。

## 2 架构与关键机制
OC 全前端：Dexie/IndexedDB 存 characters / threads / memories / lore；一轮回复是多次串行调用（记忆检索 query → embedding 相似度 → 主回复）。HH 分层：`core/agent.py` 组装 prompt，`core/memory/`（MEMORY.md + affect jsonl），`scheduler/`（planner、proactive、heartbeat），`channels/telegram_bot.py`。

核心数据模型（字段级）：
- OC memory：`{summaryHash, threadId, text, characterId, embeddings:{model→vec}, status:"current", index, triggers:[]}`（index.html:3792）；lore：`{bookId, bookUrl, text, embeddings:{model→vec}, triggers:[]}`（index.html:6521）。`triggers` 恒为空数组。
- HH 情绪事件：`{ts, topic, sentiment, intensity, context_summary}`（emotional_graph.py:227-233）；关系四维 `{relationship_temperature, trust, intimacy, understanding}` 0–100，默认 50（emotional_graph.py:451-459）；里程碑 `{first_chat_date, total_proactive_messages, triggered_milestones, last_proactive_count_trigger, deep_emotion_detected}`（milestones.py:53-61）。

## 3 拟人化
**人设定义**：OC 用 roleInstruction + initial messages + reminder 三段纯文本，支持多条 `[SYSTEM]/[AI]/[USER]` 混排并做 `{{char}}`/`{{user}}` 替换（index.html:4321-4343）。HH 用 Soul / Persona / Profile 三个 Markdown（agent.py:397-399）。

**防漂移**：HH 把身份三段做成跨轮 byte-identical 的稳定前缀，注释明说为命中 provider 前缀缓存省 60–80% 输入 token（agent.py:393-396）；易变事实每轮重注入——当前时间与用户时区（:1455）、`today_plan.md` 的**当前时段**（:1474-1485）、今日穿搭（:1489-1501）、宠物"永不换物种/颜色"（:1505-1518）、关系阶段语气（:1520-1556），最后一行锁死输出语言（:1691）。OC 只有 reminder：永不摘要、永远最后一条（index.html:4345-4364；docs/instruction-and-reminder.md）。

**情绪/关系演进**：HH 每轮后跑一次情感 sidecar，输出 JSON `{sentiment, intensity, topic, summary, follow_up}`（emotional_graph.py:35-54），追加事件并按 +3×intensity / −2×intensity 更新四维（:425-461），事件 90 天或 1 万条裁剪（:31-33）。`closeness=(intimacy+trust)/2` 分三档：<45 生疏、<70 熟络、≥70 深度绑定，**直接翻译成语气规则**（agent.py:1528-1550）。OC 无情绪状态，只有记忆与 lore。

**在线 vs 离线**：HH 日程离线跑——每日 00:01 生成 24h 计划写入 `today_plan.md`（planner.py:913-918），对话时只读；情绪抽取在线同步。OC 全在线，无离线任务。

## 4 宜人化
**主动性**：HH 每 5 分钟 tick（`CronTrigger(minute="*/5")`，proactive.py:619-627），基础概率 2/288–5/288 每 tick（:400-403），负面情绪 ×2.5（:460）、沉默 >12h ×1.5（:469），每日上限 6（:389），安静时段默认 0–8 点（:393），生日/面试等个人日期**跳过掷骰直接发**（:450-457），wishlist 优先占用额度（:543）。形态：Telegram 文本 + 15% 概率附图（:603）。

**节奏与语气**：主动消息 prompt 按时段给 hint，随机 0–2 条"人味"补充（:247-251），硬约束每段 10–50 字、最多 2–3 段、无前缀无引号（:326-329）。

**打扰防护**：用户隔 ≥20 分钟回来附 gap note（telegram_bot.py:368-373）；她发过没被回的次数在用户回话时读取并清零（:374-379），转成"可以小吃醋"的语气，但要求"一次情绪、然后放过"（agent.py:1380-1399）。**未见"未回复则暂停主动发送"的硬退避**——只有每日上限与安静时段。

**出错处理**：未见。主动生成失败仅记日志 return（proactive.py:520-522），用户侧无反馈。

**油腻/越界风险**：HH 刻意让"needy"合法、允许她抱怨自己的小事（proactive.py:130-132），这是双向感设计；对象不匹配时即为油腻。亲密阶段靠数据阈值触发称呼与身体性措辞，缺少用户显式许可。

## 5 可迁移机制（面向 DSH 插件宿主）
1. **稳定/易变分层 prompt** → 稳定段用 prompt section，易变段（时间、日程当前时段、关系阶段）压成一条末尾注入或工具返回值 → 成本：易变段每轮进 prompt 会破坏前缀缓存，**绝不能插在稳定段之前**；风险：DSH 无 provider 侧缓存承诺，HH 的 60–80% 收益不可直接套用。
2. **四维关系 + 阈值→语气档** → domain KV 存 4 个 0–100，离线定时任务按当日情绪事件结算，渲染成一条短 section → 成本低；风险：数值化亲密会"演"亲密，须照抄 HH 的"earn intimacy rather than performing it"。
3. **概率门控主动消息** → 定时任务（5–15 分钟）只跑门控（上限/安静时段/概率/事件抢占），命中才调模型 → 成本：空转几乎为零；风险：2/288–5/288 × 288 tick ≈ 每天 2–5 条，节奏要与产品预期对齐。
4. **未回复计数** → domain KV 计数 + 回复时读取；GUI 节点可显示"她今天发了 2 条你没回" → 风险：情绪勒索，需"一次性释放 + 上限"。
5. **记忆写入纪律 + 合并去重** → 工具注册 `remember/recall`，写入前一次小模型做 NOOP/UPDATE/DELETE 归并（manager.py:127-155）→ 成本：每次写入一次 LLM 调用；风险：key 漂移、延迟。
6. **危机覆盖层** → 正则前置、仅疑似时一次 4-token 分类（safety.py:120-157），**命中才注入置顶指令** → 不要常驻，否则吃 token 且破坏缓存。

## 6 不可迁移 / 风险
- **AGPL-3.0（HH）**：把代码搬进分发型插件有传染风险，只借设计不借实现。
- HH 依赖 `~/.herandhim/context` 文件系统 + 常驻 APScheduler + Telegram + 可选 ComfyUI/TTS；DSH 会话日志只读、不能写自定义持久化事件，MEMORY.md / today_plan.md 必须换成 domain KV。
- OC 是浏览器 IndexedDB 应用（MIT，无授权障碍），但检索/摘要算法需重写，且依赖前端 embedding 调用。
- 两者的日程与自拍都是**虚构仿真**，不是真实日历或真实照片。

## 7 证据清单
1. `index.html:4321-4343` roleInstruction 解析、前插与占位替换
2. `index.html:4345-4364` reminder 追加为最后一条 `_isReminder`
3. `index.html:4391-4401` memories 与 lore 合并进同一检索池
4. `index.html:4404-4423` 记忆检索 query 的额外 LLM 调用（取最近 10 条，最多 10 个 keyphrase）
5. `index.html:4632-4647` 按 0.075 预算的裁剪循环（记忆与 lore 按分数竞争）
6. `index.html:4286-4290` 摘要 system 消息插入位置（`_isSummary`）
7. `herandhim/core/agent.py:393-400` 为前缀缓存保持稳定前缀的显式注释
8. `herandhim/core/agent.py:1520-1556` 关系四维 → 三档语气规则
9. `herandhim/scheduler/proactive.py:419-484` 5 分钟 tick 的完整门控链
10. `herandhim/core/safety.py:120-157` 正则优先 + 单次分类的两级风险判定
11. `herandhim/core/memory/emotional_graph.py:425-461` 情绪事件 → 关系数值
12. `herandhim/core/agent.py:492-525` 记忆写入纪律（画像抽取的实际载体）

## 8 未找到证据的宣称 / 开放问题
- OC README 称"Give your character an internal thought process that runs alongside the chat" —— **核心代码未见独立内部思考模块或额外推理调用**。实际做法是 reminder 里以 `[AI]` 身份写 `(Thought: ...)`（docs/instruction-and-reminder.md:40,44），加上 custom code 的 iframe 事件钩子。即"角色内部思考"是写作约定，不是机制。
- OC docs 称 lore/memories 数量不影响成本 —— **代码实际**每次回复固定多一次 query 生成调用（index.html:4412-4423），且每条入库需预计算 embedding，缺 embedding 直接抛错（:4455-4462）。"条数不加价"仅在每轮 token 上成立。
- HH SAFETY.md 称 web 面板有常驻 AI 声明，本次未核实 `web/app.py`。
- 未运行测试、未启动应用；以上均为静态阅读结论，运行时行为（尤其并发 tick、缓存命中率）未验证。
- 开放问题：HH 的 `unanswered` 计数只改语气、不回退发送频率，长期不回复的用户会持续收到每日 6 条上限内的消息——这是产品取向还是缺口，需产品决策。
