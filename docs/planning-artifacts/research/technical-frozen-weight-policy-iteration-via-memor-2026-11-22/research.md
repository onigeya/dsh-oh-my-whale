---
title: 'technical research: 冻结权重下的策略迭代（记忆库/案例库路线）'
type: 'technical'
topic: 'frozen-weight policy iteration via memory and case libraries'
decision: 'DSH 插件层自进化底座：prompt/案例注入 vs 候选重排 vs 推理代理层——选哪条，以什么形式落地'
source: 'user-provided candidate list (2026-11-22) + 一手仓库源码 / arXiv 论文 / 官方规范核对'
status: draft
preset: 'standard'
validation: 'normal'
created: '2026-11-22'
updated: '2026-11-22'
---

# technical research: 冻结权重下的策略迭代（记忆库/案例库路线）

**Decision this research serves:** DSH 插件层的自进化底座选哪条路线——prompt/案例注入、候选重排（原 "logits 调制"），还是推理代理层；以及迭代对象应该是什么。

## 摘要

**一句话结论：在 DSH 这种纯 API 宿主上，"用记忆做策略迭代"唯一能落地的形态是「有界、可回滚、带验证闸门的文本策略对象 + 检索注入」，而不是任何形式对模型分布的直接干预。**

支撑这个结论的四条证据链都很硬：

1. **JitRL 自称"直接调制 logits"，但代码里做的是候选重排。** 论文给的是 `z'(s,a) = z(s,a) + β·A(s,a)` 的 KL 闭式解 [1]，实现却是"用 API 的 `top_logprobs` 拿 top-k 候选 → 概率空间加 advantage → 贪心取最大"，β 硬编码为 1 [2]。第三方 issue #4 已逐条指出这个差异，作者 36 天未回应 [3]。也就是说：**业界最激进的"改 logits"路线，在工程上早就退化成"对已生成候选重排"**——它连本地推理都不需要，README 明确支持 GPT-4o / Claude-3.5 / Gemini 走 OpenRouter [2]。
2. **DSH 连这条退化路线都缺一环。** `GenerateOptions` 里没有 logprobs、没有 logit_bias、没有 n [24]；`llm/stream` 瀑布对正常对话请求是 deep-frozen、只读 [24]。所以 DSH 上能做的不是"对 top-k 重排"，而是"**多次采样后重排**"——多花 N 倍调用换候选多样性。
3. **项目的"迭代对象"分三档，成熟度差别巨大。** Memento 迭代案例条目（`{question, plan, reward}` 三字段，只增不减）[7][8]；Memento-Skills 迭代**磁盘上的可执行技能文件**，带"合成测试 + judge 打分 + 原子部署 + 失败保留原树"的闸门 [9]；Meta-TTL 迭代**一条 meta-prompt 文本**，用逐任务 z-score 的 BIS 加 accept_margin 决定是否替换 [11]。**只有后两者具备"可版本化、可回滚、可 A/B"的性质**——这才是自进化功能该迭代的对象。
4. **六个项目里没有一个是靠"记忆越多越好"取胜的。** JitRL 把无限增长当特性、报告检索开销可忽略 [1]；Memento 写入无去重、无淘汰、无质量阈值 [8]；AWM 只把二值判定为成功的轨迹归纳进库、只增不减（论文正文未明言「只收成功」，这是 `pipeline.py` 的代码事实）[5][6]。它们的共同前提是"有一个可验证的任务成功信号"（WebArena 分数、GAIA 答案、Jericho 游戏分）。**对话陪伴 Agent 没有这个信号**，这是最大的移植风险。

**给 DSH 的推荐**：主线走「案例库 + 运行时上下文注入 + 离线 dream 里做归因与提炼 + 用既有评测集做 A/B 闸门」，即 Memento 的读路径 × Meta-TTL 的接受准则 × Memento-Skills 的验证闸门。**候选重排留作可选增强**（等 DSH 暴露 `top_logprobs`）。**推理代理层不推荐**（除非自托管推理端点）。

---

## 1. 决策与判据

这次研究要回答的不是"哪个项目最好"，而是**DSH 插件层的自进化功能，应该迭代什么对象、用什么信号驱动、以什么形式落地**。因此判据按"硬门槛 → 加权偏好"排序：

| 类型 | 判据 | 为什么是硬门槛 |
|---|---|---|
| 硬门槛 | 在纯 API 宿主上可实现 | 不可实现的方案再优雅也是零 |
| 硬门槛 | 不需要 ground-truth 标签 | 对话陪伴场景没有标准答案 |
| 硬门槛 | 可回滚、可关闭 | 自进化一旦改坏，必须能退回上一版 |
| 加权偏好 | 效果可测量 | 没有 A/B 就没有"进化"，只有"漂移" |
| 加权偏好 | 单次交互的额外成本 | 每轮多 N 次调用会直接吃掉可用性 |
| 加权偏好 | 与现有 DSH 缝的贴合度 | 越贴合，工程量越小 |

### 1.1 三个术语的约定

同一件事在不同项目里叫法不同，本报告统一如下，后文不再解释：

| 本报告的叫法 | 指什么 | 别名 / 出处 |
|---|---|---|
| **注入** | 把检索到的文本放进 prompt 或 runtime context，不改解码过程 | "prompt 注入"、"in-context 增强"（AWM、Memento） |
| **候选重排** | 对已生成的候选答案/动作重新打分排序 | 项目自称 "logits 调制"（JitRL），实际是 rerank |
| **代理层** | 在模型之外架一层服务，多次调用 + 选优 | "推理代理"（OptiLLM）、"test-time compute" |

> 这张表本身就是一条结论：**三个项目用了"调制"这个词，但只有 LTPO 真的动了输入向量。** 其余两个分别落在"注入"和"候选重排"上。

关于"dream 离线阶段"：这是**用户自建概念**（离线巩固阶段），不是这六个项目里的术语。本报告按"离线批处理巩固"理解，并在第 7 节给出它对应到哪些机制。

---

## 2. 机制面：六条路线分别在哪一环动手

把"记忆 → 策略迭代"拆成四环，六个项目各在不同环上动手。这张表是全报告的地图。

| 项目 | ① 记忆存什么 | ② 怎么检索 | ③ 怎么变成"偏好" | ④ 什么信号触发写入 | 是否真·策略迭代 |
|---|---|---|---|---|---|
| **JitRL** | step 级 `(s, a, G_t)`，G 是折扣回报 | Jaccard 词面匹配 + URL 硬过滤，k≈10，阈值随步数衰减 | **候选重排**：advantage 加在 top-k 候选分数上取 argmax | LLM Evaluator 事后逐步打分 | 是，但退化为 rerank |
| **AWM** | 工作流 = 自然语言描述 + 抽象动作序列 | **WebArena 主路径无检索**，全量注入 7.3–7.4 条 | prompt few-shot 注入 | LLM evaluator 二值标签，仅成功轨迹入库（代码级） | 否，是 in-context 增强 |
| **Memento** | 案例 `{question, plan, reward}`，**不含轨迹** | SimCSE 句向量余弦 top-8（参数化版：交叉编码器） | 按 reward 拆正/负例塞进一条 user 消息 | gpt-4o-mini judge 判对错，**无条件 append** | 弱，是检索分布改进 |
| **Memento-Skills** | **技能文件**（SKILL.md + 脚本） | BM25 + 向量混合路由 | 技能被真正执行 + 内容进上下文 | 执行结果 → utility 计数 → 失败归因 | **是**，带验证闸门 |
| **Meta-TTL** | **一条 meta-prompt** | 不适用（全局唯一） | 作为 meta-agent 的 system 指令 | 验证集 z-score 比较，BIS + accept_margin | **是**，可 A/B |
| **LTPO** | **无跨题记忆** | 无 | 改写输入 embedding → 一次解码 | 每题的置信度 reward | 否，是单实例 bandit |
| **OptiLLM**（主路径） | 无记忆 | 无 | 多次采样 + 拼 prompt + 选优 | 无 | 否，开环 |
| **OptiLLM SPL 插件** | **策略库**（显式策略文本 + 历史表现） | 相似度 + 历史表现选策略 | 策略进 system prompt | 评测后把策略写盘 | **是**（无闸门） |

**三条结构性观察**：

1. **"改分布"这一环的可行方案，实际只有三种**：改 prompt（AWM / Memento）、改候选排序（JitRL）、改输入向量（LTPO）。前两者纯 API 可行，最后一个必须白盒。
2. **"什么信号触发写入"比"存什么"更能决定系统性格**。JitRL 存失败经验（负 advantage 精确作用在出错状态上），AWM 只存成功——这直接导致 JitRL 论文能批评 AWM "plateau early, over-rely on established memory patterns, inhibit further exploration" [1][5]。
3. **只有 Meta-TTL 和 Memento-Skills 有"接受/拒绝"机制**。其余四个都是"写进去就用"，没有闸门——这是它们距"自进化"还差一步的地方。

### 2.1 清单之外的横切对照

用户的清单没有覆盖这一批，但它们决定了"记忆型路线"的整体坐标，且全部核对到了摘要级 [17][18][19][20][21][22][23]：

| 工作 | 记忆形态 | 与本次主题的关系 |
|---|---|---|
| ExpeL [17] | 跨任务抽取的自然语言 insight 池，推理时检索相似经验注入 | 摘要明确以"权重不可得"为动机（不主张时间上的最早） |
| Reflexion [18] | 反思文本写进 episodic memory buffer，下次试验读入 | 明确"not by updating weights, but through linguistic feedback" |
| Voyager [19] | **可执行代码技能库** + 自动课程 + 迭代 prompting | 技能库路线的最早完整实现，bypass 参数微调 |
| Dynamic Cheatsheet [20] | 持久演化的策略/代码片段记忆，无需 ground-truth | 无标签场景的记忆复用先例 |
| ACE [21] | context 作为演化 playbook，generation→reflection→curation | 明确针对 brevity bias 与 context collapse 两个失效模式 |
| MemRL [22] | episodic memory 上做 runtime RL | 仅取到标题与日期，机制未验证，**不可引用数字** |
| SEAL [23] | **改权重**（self-edit → SFT） | 本主题唯一的反例，用于划清"冻结权重"的边界 |

**一个明确空白**：没有任何一篇做了"prompt 注入 vs 参数微调 vs 候选重排"的系统性量化比较。唯一可用的受控对比是 LTPO Table 2（且只在数学推理任务上）[12]。

---

## 3. JitRL 与 AWM：记忆到候选重排 vs 纯 prompt 注入

### 3.1 JitRL 的真实链路

> **本节要点**：论文写的是 logits 加性，代码做的是「概率空间加性 + 贪心取最大」。这条差异是整份报告的第一个支点。

**记忆结构**：论文定义为 `M = {(s_i, a_i, G_i)}`，第三元是**折扣回报** `G_t = Σ γ^{u-t} r_u`，不是即时 reward——README 写 `<state, action, reward>` 是措辞不严谨 [1]。state 不是原始 DOM：WebArena 用**正则化 URL**（把 `/edit/123` 与 `/edit/456` 折叠成同一页面类型）+ 本地动作历史，Jericho 压成 `[State: 名词][Action: 动词]` 加 SUMMARY/PROGRESS/LOCATION 三层 [1]。action 是**语义动作**：`click('1240')` 归一化成 `click(<combobox[Sort by:]>)` [1][2]。代码落盘是 episode 级 jsonl + 每步元数据（reward、llm_step_score、future_rewards[]、discounted_reward、normalized_action）[2]。

**检索**：**没有 embedding**。代码里 `self.encoder_available = False  # Disable embedding to save costs`，日志打印 "Using BM25 for retrieval (vector embedding disabled to save costs)" [2]。论文用 Jaccard over tokenized state [1]；代码是 `0.7 * history_sim + 0.3 * task_sim`，task 相似度阈值 0.27，最终阈值随步数从 0.8 线性降到 0.7（max_steps=20），k=10 [2]。**没有去重、没有聚类、没有淘汰** [2]。

**advantage 估计**：三段式，全部是邻域均值。
- `V(s) = (1/|N(s)|) Σ G_i`（状态值 = 检索邻域的回报均值）
- `Q(s,a) = (1/|N(s,a)|) Σ G_j`（动作值 = 同动作子集的回报均值）
- `A(s,a) = Q(s,a) − V(s)`（**是差值，不是加权平均**）
- 未见动作以概率 λ 赋 `V(s) + α/|N(s)|`，否则 0——这是一个"计数衰减的 UCB"，把"记忆里没见过"当不确定性而非零价值 [1]。代码里 λ=0.05、α=1 是硬编码常量，论文只写"以概率 λ"（数值出处是代码，不是论文）[2]

**"logits 调制"的真相**：论文的闭式解是 `π*(a|s) ∝ π_θ(a|s)·exp(β·A(s,a))`，取对数得 `z'(s,a) = z(s,a) + β·A(s,a)` [1]。但代码是：

```python
normalized_prob = math.exp(candidate.logprob)          # logprob → 概率
corrected_logprob = normalized_prob + 1 * normalized_advantage   # β 硬编码 1
best = max(candidates, key=corrected_logprob)          # 贪心，不是采样
```

即：**概率空间加性 + 贪心 argmax**，作用位置是**动作最后一个 token 的 top-k 候选**（`top_logprobs` 参数），不是逐 token 重加权整条序列 [2]。还有一个关键设计——**候选集扩张**：`C ← C_LLM ∪ {记忆里在该状态出现过的动作}`，补进来的动作基础分设为 0 [1]。这解决了"记忆里的好动作如果没进 top-k 就永远学不到"的问题。

第三方 issue #4（2026-10-17，open，0 评论）逐条列出这些差异，并追问"论文数字用的是哪套规则"，作者截至 2026-11-22 未回应 [3]。

**为什么它仍然成立**：作者自己在 issue #2 里解释过 prompt 与 logits 的差距来源——(a) **通道可靠性**：prompt 注入依赖长上下文注意力，logit 修正"把 advantage 以校准过的数值直接加在动作分布上"；(b) **粒度与 credit assignment**：记忆是 step 级，每步以当前状态为 key 检索，失败经验以负 advantage 精确作用在**出错的那个状态**上，而 trajectory 级 prompt 一旦偏航就失配 [4]。同一个回复里作者也承认："JitRL 用到的信息原则上都能用文字表达，所以这个差距可能随模型的指令遵循和长上下文能力增强而收窄" [4]。

**效果**：WebArena 平均成功率 46.98 / Final 51.35，同表记忆类基线集中在 39–43（Static Memory 约 35.6），JitRL 领先约 4–6 个点 [1]；WebArena-Lite Final 60.00 vs WebRL 46.06、SFT 23.00 [1]；成本 $290 vs WebRL ~$9900 [1]。消融上 Admin 52.31 vs prompt 注入 48.35、Reddit 57.64 vs 54.57——**只有两个站点，缺 GitLab/Map/Shopping** [1]。

> 数字归属说明：Table 1 里 AWM / Reflexion / Static Memory / EvoTest 那几行的对应关系，两位独立核对者读出的结果不一致（行跨页换行导致 off-by-one）。这里只报区间，不点名单个项目——**要逐行引用请回原表**。这不是谨慎，是那一列确实容易被读错。

> ⚠️ **README 的 Results 表与论文表格对不上**，还含论文没有的 Detective 条目（论文 Jericho 只报 Library/Zork1/Zork3）。引用数字一律以论文表格为准 [1][2]。

### 3.2 AWM：没有检索器的全量注入

workflow 是**自然语言子程序 + 抽象动作模板** `W = {(d_j, P_j^d)}`，抽象的关键是把 example-specific 值换成占位符（"dry cat food" → `{product-name}`），粒度降到子任务 [5]。归纳者是 LLM 本身（gpt-4/gpt-3.5，temp 0.0），归纳 prompt 要求"每个 workflow 至少两步、不要生成相似 workflow、用描述性变量名" [5]。

**WebArena 主路径上它没有检索打分器**——这是与 JitRL 最本质的差异（不只是"不碰 logits"）。Mind2Web 侧仓库另有 `workflow/retrieve.py`，那是复现基线用的，不是主路径 [6]。offline 时把所有训练样本拼成一个大 prompt 一次性归纳，测试时全量注入；online 时只把**成功轨迹**（LLM evaluator 二值标签）归纳后累积，也是全量注入 [5]。仓库里就是五个站点各一个静态 `.txt` 直接当 few-shot 示例拼进 prompt [6]。

一个示例产出 7.3–7.4 条 workflow，作者评价"efficient and do not add too much content" [5]。**论文没有做"多少条之后收益饱和/下降"的实验**；最接近的是 Table 11：offline + online 合并的得分落在两者之间，作者明确说"not fully compatible" [5]。

**AWM 自陈的失效模式**：workflow 会诱导 agent 走与实际页面状态不符的动作，作者称之为"Learn to diverge from workflow guidelines"的困难，AWM 的 action F1 反而低于 MindAct [5]。

**效果**：WebArena 总成功率 35.5（BrowserGym 23.5，+12.0 绝对点 / +51.1% 相对），平均 5.9 步；Mind2Web cross-task 50.6 Elem Acc；cross-domain 泛化 +14.0~16.9 Step SR [5]。

### 3.3 这一组的净判断

| 维度 | JitRL | AWM |
|---|---|---|
| 是否真"策略迭代" | 是，但退化为**候选重排** | 否，in-context 示例增强 |
| 写入信号 | LLM Evaluator 逐步打分 → 折扣回报；**失败经验以负 advantage 入库** | 二值成功标签；仅成功轨迹入库（代码级，论文未明言） |
| 检索 | Jaccard/BM25 词面 + URL 硬过滤，k≈10 | 无检索，全量注入 |
| 碰 logits | 论文说碰；代码碰的是概率分数 | 完全不碰 |
| 记忆淘汰 | 无（作者视为特性） | 无 |
| 闭源 API 可用 | **可以**（top_logprobs，或 verbalized 降级让模型自报置信度） | 可以 |

**对 DSH 的直接含义**：JitRL 的思路在 DSH 上要降级两档——从"logit 加性"降到"候选重排"，再因为 DSH 没有 `top_logprobs` 降到"多次采样重排"。而降级到这个程度后，它相对 prompt 注入的优势还剩多少，**没有任何证据**（JitRL 的消融只对比过真正的 top-k 重排，没对比过"多次采样重排"）。

---

## 4. Memento / Memento-Skills / Meta-TTL：迭代对象的三次分化

这一节回答用户最关心的问题：**案例库到底怎么读写、reward 怎么回写、策略迭代迭代的到底是什么。**

### 4.1 Memento：案例库比宣传的薄

> **本节要点**：案例条目只有 `{question, plan, reward}` 三个字段，完整轨迹不入库；写入无去重、无淘汰。

**案例条目只有三个字段**：`{question, plan, reward}` [8]。完整轨迹（MetaCycle / ExecStep / ToolCallRecord）确实被采集，但只写进 `result/result_round_0.jsonl`，**不进入案例库** [8]。论文的形式化是 `Write(s,a,r,M) = M ∪ {(s,a,r)}`，`s` 用冻结文本编码器编码 [7]。

**读**：非参数版 SimCSE 句向量余弦 top-8（`princeton-nlp/sup-simcse-bert-base-uncased`）；参数化版是交叉编码器对 (query, 案例) 二分类，取 `softmax(logits)[:,1]` 对全库逐条打分 [8]。**打分对 reward 不敏感**——reward 只在拼 prompt 时用来分正负例。

**用**：检索结果按 `reward==1` 拆成 Positive / Negative 两组，正例渲染成"id. 描述"的计划步骤，负例渲染原始 plan，末尾固定指令 "Focus on the positive examples and avoid the patterns shown in negative examples"。这段文本作为**一条 user 消息**插在原始问题之后、planner 首轮之前（不是改 system prompt）[8]。

**写**：gpt-4o-mini 当 judge 对比预测与标准答案，输出 correct/incorrect → 1/0（`llm_judge`，L504–565）；每题结束后**无条件 append**，成功失败都写（L569–575、592–594）；**无去重、无合并、无淘汰、无质量阈值**，写完重新加载整个 JSONL [8]。

> 一处细节修正：**注入的条数**是有上限的（`MEMORY_MAX_POS_EXAMPLES` / `MEMORY_MAX_NEG_EXAMPLES` 环境变量，L150、L163），但**库本身**没有上限。这两件事经常被混为一谈——限制 prompt 长度不等于限制记忆增长。

**双环**：planner 看 system + 共享历史（问题、记忆块、自己的计划、executor 结果）；executor 看**同一份**共享历史 + 当前子任务描述；`MAX_CYCLES=3`，每轮任务做完重规划一次 [8]。环间传递就是自然语言结果，没有结构化信道。

**MCP 只覆盖工具层**：客户端用 stdio 拉起 `server/*.py` 或 `.js` MCP server，把 MCP tool schema 转成 OpenAI function calling；planner/executor 双环是自研代码，不是 MCP [8]。这一点很重要——**MCP 是工具接入协议，不是记忆协议**，别指望它承载案例库。

**效果**：GAIA val 87.88%（L1 96.23 / L2 90.70 / L3 61.54），test 79.40%（L1 90.32 / L2 75.47 / L3 71.43）；OOD 增益 +4.7~+9.6 绝对点 [7]。

> ⚠️ 方法学提醒：Table 1 里 Memento 用 GPT-4.1 + o4-mini，而 prompt-based 与 training-based 基线用 Qwen2.5-7B，**不是同底座 ± 梯度的受控对比**。"记忆超过微调"这个读法不成立；干净的因果量是 OOD 的 +4.7~9.6（同一 agent 开关案例库）[7]。

### 4.2 Memento-Skills：唯一带验证闸门的可执行技能库

这是用户清单之外、机制上最接近"自进化"的一项（价值判断，非论文结论；论文只取到摘要）[9][10]。

**产物形态**：不是文本案例，而是**磁盘上的技能目录**（`SKILL.md` 说明书 + 脚本文件，如 `builtin/skills/skill-creator/`）。演化引擎直接读写技能目录里的文本文件并做整树替换 [9]。

**写路径（这是关键）**：
1. `record_outcome(skill, success)` 累计 success/failure，维护 `utility = success/(success+failure)`
2. 失败时先用 `ATTRIBUTION_PROMPT` 归因到**一个**被用过的技能，产出 `failure_mode`
3. 按 `REWRITE_PROMPT` / `DISCOVERY_REWRITE_PROMPT`（"discover" 分支可以造新技能）生成候选
4. 对候选跑**合成测试 + judge 打 0–1 分**，取最优
5. 通过才**原子部署**，失败保留原树 [9]

**读**：技能路由用 BM25 + 语义向量混合检索 [9]。

**评测的弱点**：只在 HLE 与 GAIA 上给了**曲线图**，正文无数字表 [9]。但机制本身——"归因 → 重写 → 测试 → 原子部署/回滚"——是六个项目里唯一完整的自进化闭环。

### 4.3 Meta-TTL：唯一把策略显式成一个可 A/B 的文本对象

**双层**：外层在**任务间**学一个 meta-prompt；内层 TTL 里 meta-agent 读 actor 上一次尝试、写下一轮 guidance，**actor 每 episode 重置，guidance 是唯一跨 episode 载体** [11]。

**接受机制（BIS 的真实实现）**：把 current 与 proposal 放到**同一验证集**上打分 → 用 `TaskScoreHistory.normalize` 转成**逐任务 z-score** → 比均值：`accepted = mean_z[candidate] > mean_z[star] + accept_margin` [11]。

这个设计很妙：不同任务的原始分量纲不同（0/1、分数、成功率），先按任务历史标准化再平均，**避免"一个任务大涨掩盖另一个任务大跌"**。是单候选爬山（每轮只提一个 candidate，接受/拒绝），**不是进化搜索、也不是 best-of-n**——用户清单里"进化搜索"的说法与代码不符。

**两阶段反思**：stage1 用 `FACT_ATTRIBUTION_PROMPT` 抽出 task-specific facts；stage2 要求"诊断**适应失败**而不是任务失败""重写 meta-prompt 时不得含任何任务特定知识""触发条件必须是任何日志里都看得见的东西""不超过 350 行"，且 user prompt 里 facts 块显式标注 "keep ALL of this out" [11]。这是把"事实"与"策略"强制分离的工程手段，值得直接抄。

**成熟度警告**：仓库**没有任何 benchmark 数字**，README 无结果章节，`outputs/` 被排除出版本库 [11]。Jericho / WebArena-Lite / tau2 的任何数字本轮均未获得。**它只能作为机制参考，不能作为效果证据。**

### 4.4 三者对"策略迭代"的回答

| 项目 | 被迭代的对象 | 可版本化 | 可回滚 | 有闸门 | 适用性 |
|---|---|---|---|---|---|
| Memento | 案例条目（只增） | 否 | 否 | 否 | 读路径可抄，写路径危险 |
| Memento-Skills | 技能文件 | 是（目录） | 是（保留原树） | **是** | **最接近自进化** |
| Meta-TTL | 一条 meta-prompt | 是（`best_prompt.txt`） | 是（保留 current） | **是**（BIS） | **接受准则可抄** |

**这是本报告对用户最有用的一个判断**：自进化功能的安全性不取决于"记忆多聪明"，而取决于**被迭代对象是否可版本化、可回滚、有闸门**。案例库（Memento 式）三个都不满足；技能文件与策略文本两个都满足。

---

## 5. LTPO 与 OptiLLM：无梯度测试时优化，与代理层的真实边界

### 5.1 LTPO：优化的是输入 embedding，不是 hidden state，也没有记忆

"隐式 thought 向量"**不是**某一层的 hidden state，而是占位 token 经 embedding 层得到的**输入向量** `e_i = Embed([THINK])`，默认 10 个位置，插在 user prompt 末尾 [12][13]。优化变量只有这 10×d_model 个数，模型权重全程 `model.eval()` [13]。

reward 不是熵、也不是 top-1 概率，而是**top-k 平均负对数概率**再对位置取平均（k=10）：一次定长 full forward 拿 logits → softmax → 每位置取 top-k → `-(1/k)Σ log p` → 位置间平均 [12][13]。更新是**高斯平滑的 score-function 估计**：`θ ← θ + lr·R(θ+ε)·ε/σ²`，单样本、无 baseline、σ 每步 ×0.99 [12][13]。

**一个论文没说的矛盾**：仓库另有 `--use_auto_grad` 路径，直接对 reward 调 `backward()` 穿过冻结模型更新 embedding。这说明置信度 reward 对 inputs_embeds **其实可微**，论文"reward 对输入不可微、故必须用策略梯度"的说法过强——若可微，它实质更接近 prompt tuning / LatentSeek [13]。

**它没有记忆**：每题独立优化 10 步就丢弃，不写任何经验库，无检索 [13]。它是**单实例、无记忆、纯 exploit 的 bandit**。

**评测只在数学推理**：GSM8K / MATH-500 / ASDiv-Aug / AIME2024 / AIME2025，四个 3B–14B 模型，无 agent、工具、检索、多轮环境；作者唯一承认的局限是"置信度 ≠ 正确性"（给出错误解 reward 6.375 > 正确解 4.781 的例子），**全文没有讨论 agent 场景** [12]。

**数字**：LLaMA-3.1-8B 平均 48.66 vs Zero-Shot CoT 42.35；Qwen-2.5-7B 56.79 vs SoftCoT 47.88 [12]。最有价值的是 Table 2 那组**唯一可用的"冻结 vs 微调"受控对比**：GSM8K/MATH-500/AIME2024 上 LTPO（不训练）81.27/49.00/16.67，训练过的 Genius 78.09/47.60/3.33、SimpleRL-Zoo 79.20/23.00/0.00 [12]。

> ⚠️ AIME 只有 30 题，1 题 = 3.33pp，这些差距统计意义很弱。

### 5.2 OptiLLM：不做 logits 干预的纯文本编排器

OpenAI 兼容 FastAPI 代理，自己不持有模型（除非启用内置本地推理服务）。注册约 20 个 approach：`none, mcts, bon, moa, rto, z3, self_consistency, pvg, rstar, cot_reflection, plansearch, leap, re2, cepo, mars` + 插件，另有 5 个标记 "Local only"（deepconf / cot_decoding / entropy_decoding / thinkdeeper / autothink）[14]。

**关键：作为代理时它不使用 logprobs。** `server.py` 里 `logprob` 只有 2 处——L1156 把上游响应原样透传、L1171 写死 `None` [14]。需要概率的技术只能跑在它内置的本地推理服务上：那条路径由 `optillm/inference.py` 自己算 `torch.log(probs)` / `torch.topk`（L165-182）[14]。**代理路径与服务内路径必须分开看**，混起来会得出「OptiLLM 完全不用概率」的错误结论。

所以 20 多个技术全部退化为"多次采样 + 拼 prompt + 选一条"：
- **MoA** = 3 采样（temp=1）→ 1 次批评（temp=0.1）→ 1 次合成（temp=0.1），不是论文里的多层多 agent [14]
- **best-of-n** = 同一模型给每个候选打 0–10 分、只回数字、取最高 [14]
- **self-consistency** = `difflib.SequenceMatcher().ratio() >= 0.8` 贪心聚类 + 簇内频次投票，不做答案抽取、不做语义等价 [14]

**但它的 SPL 插件恰恰就是"冻结权重下做策略迭代"**——这一点我最初判断错了，必须更正。

`optillm/plugins/spl/` 是一个完整插件（`strategy.py` 24KB、`main.py` 11KB、`evaluation.py` 11KB、README 14KB），`__init__.py` 那 117 字节只是 re-export。它实现的是 Karpathy 提的「第三种学习范式」：模型从自己的解题经验里生成、评估、精炼**显式策略**，把策略库累积起来，遇到新问题时**按相似度与历史表现选择性应用** [14]。

它自带的评测（gemini-2.0-flash-lite，OptiLLMBench 训练 400 / 测试 100）：

| Benchmark | Baseline | With SPL | 提升 |
|---|---|---|---|
| OptiLLMBench | 61% | 65% | +4.0 |
| MATH-500 | 85% | 85.6% | +0.6 |
| Arena Auto Hard | 29% | 37.6% | +8.6 |
| AIME24 | 23.33% | 30% | +6.67 |

> ⚠️ 这组数字来自**仓库自述**（含训练/测试划分描述，但无独立复现），按仓库自述处理，不能当论文结论引用。

**这意味着**：用户清单里把 OptiLLM 归为"工程参考、不是 RL 记忆路线"，低估了它。SPL 与 Meta-TTL 是同一族——都是"把策略显式成一个可累积、可选择的文本对象"，区别只是 SPL 走相似度检索、Meta-TTL 走 BIS 接受闸门。**SPL 没有闸门**（策略写盘后不 A/B、不回滚），这正是我在第 7 节要补的那一环。

至于代理层本身：`server.py` 确实没有 cache / KV / 经验存储，`conversation_logger` 只写调试日志。**主路径开环、插件闭环**，两者要分开说。

顺带一个教训：README 写的技术选择优先级（模型名前缀 > extra_body > prompt tag）与代码实际行为（prompt tag 覆盖请求字段，请求字段覆盖服务端默认值）**不一致**，代码为准 [14]。

### 5.3 纯 API 客户端到底能改什么

| 手段 | 能做什么 | 不能做什么 |
|---|---|---|
| `logit_bias` | 按 token id 加减 [-100,100] 偏置 | 需 tokenizer 的 token id（per-model）、粒度粗、无法 top-k 重排、很多兼容实现不支持 [15] |
| `logprobs` + `top_logprobs` | **观测**：每位置 top-N 候选的 log 概率 | **不能写**：无法强制选某个候选；N ≤ 20 [15] |
| `n` 多候选 | 一次请求拿多条 | 新模型直接拒绝显式 `n`（连 `n=1` 都拒），按全部候选计费 [15] |
| `temperature` / `top_p` | 调分布形状 | 只调形状，不调方向 |
| `seed` | 可复现性尝试 | 已 deprecated，"best effort" [15] |
| 服务端 `allowed_token_ids` / `structured_outputs`（vLLM） | 真·token 级约束 | 属服务端能力，托管 API 不保证暴露 [16] |

**一句话**：纯 API 客户端真正能"改分布"的只有 `logit_bias`（需 token id，粒度粗）与 `temperature/top_p`（只调形状）；`logprobs` 只提供**观测**能力。要"重排"只能靠重新请求，而不是改分布。

### 5.4 可借鉴：把置信度当 advantage 而不是 reward（分析，非检索结论）

LTPO 的 reward 本质是"给定前缀，模型对下一个 token 有多确定"。搬到检索场景，最自然的映射不是给案例打分，而是给"**案例插入后的上下文**"打分：把候选案例 c 拼进 prompt，取案例末尾位置的 top-k 平均负对数概率作为 `conf(c)`。

但它有致命偏差：`conf` 高的案例往往是"和 query 风格最像、最容易被预测"的案例，而不是最有信息量的——与 LTPO 的 "confidently incorrect" 同源。直接最大化会退化成"选最平庸的案例"。

更稳的写法是**把 conf 当 baseline 而非 reward**：`A(c) = conf(c) − conf(∅)`，只保留 `A(c) > 0` 的案例并按 A 排序。这等价于信息增益，且天然抵消"风格相似"这一 confound——**这正是 LTPO 的 REINFORCE 骨架（无 baseline）缺失的那一块**。

纯 API 可实现：`logprobs=true, top_logprobs=20` 拿插入案例后答案段的每 token log 概率取平均即 API 版 `conf`；成本是每个候选案例一次额外请求。但只能算"答案段的平均 logprob"，拿不到"thought 位置的置信度"——这是白盒/黑盒的真实分界。

---

## 6. 宿主可落地性：DSH 插件层能改什么、不能改什么

这一节是对本机 DSH 0.2.2-rc.5 的 `.d.ts` 一手核对，不是文献结论。所有候选路线都必须先过这一关。

### 6.1 通用调用面不携带概率信息

`dsh-llm` 的 `GenerateOptions`（`dsh-llm/lib/types/types.d.ts:538`）字段全集：provider、model、reasoningEffort、messages、system、tools、toolHistory、temperature、maxTokens、stop、signal、sessionId、purpose。`LlmCallControls`（`call-config.d.ts:10`）只有 reasoningEffort / temperature / maxTokens / stop [24]。

**没有 logprobs，没有 logit_bias，没有 n。** DSH 作为纯 API 客户端，既不请求 token 级概率，也无法按 token 施加偏置——JitRL 式的候选重排在通用路径上**不可实现**（不是"难"，是没有入口）。

### 6.2 llm/stream 瀑布对正常对话请求只读

`llm/stream` 签名（`dsh-llm/lib/types/index.d.ts:31-46`）为 `(options: GenerateOptions, next) => AsyncIterable<StreamChunk>`，注释明确：loop 组装的请求带 `markAgentLoopRequest` 身份且 **deep-frozen（mutation throws）**，"listeners read it, never rewrite it" [24]。

插件不能在这一层改写对话 prompt；要改输入只能在请求组装之前介入，或替换 adapter。

### 6.3 真正可用的四个介入面

| 缝 | 能改什么 | 代价 / 限制 |
|---|---|---|
| `systemPrompt.section({name, order, text})` | 稳定系统提示 | 文本一变，整段系统提示重新追加进历史（数万未缓存 token），只适合不随请求变化的规则 |
| `systemPrompt.context({name, order, text, required})` | 每轮运行态快照（user 消息追加，文本变化才发，压缩后自动重发） | **注入检索案例/工作流的天然缝**；所有 context 合并成一条快照，任一变化全部重发，须保持短 |
| `agent/pre-step` 瀑布 + `session.append(..., { surfaceOp: { op: 'replace' } })` | 模型看到的历史（用户看到的聊天不变） | 替换早期节点会让前缀缓存从该点失效一次 |
| `appendPluginRecord` + `sessionProjections.register` | 持久事件 + 可折叠状态 | 记录要小，fold 要纯，解析要宽容 |

另有 `agent.steer / inject / followup` 三条主动发消息通道，适合由定时任务驱动的离线 dream 阶段。

### 6.4 候选重排与 logits 调制只剩两条窄路，都要求控制端点

1. **provider 专属请求体扩展**：`DeepSeekLlmApiExtensionMap` 是 merge-extensible 的顶层字段表，extension provider 的 `prepare(request)` 为每个请求产出一个字段值，合并后的 `fields` 由 `PreparedDeepSeekLlmApiExtensions` 承载并写进请求体 [25]。理论上可塞 `logit_bias`，但（a）只对 DeepSeek adapter 生效，（b）服务端必须真的接受并执行该字段。
2. **换 adapter**：自己注册 `llm` adapter 指向自托管 vLLM/SGLang，才谈得上真正的 logits 干预。

**判断**：只要模型走托管 API，"logits 调制"在 DSH 上不是工程选项。JitRL 的完整链路（记忆 → advantage → logits）在宿主侧只能保留前半段，调制对象必须从 logits 换成「注入什么、注入多少、注入多强」。

---

## 7. 取舍矩阵与推荐

### 7.1 三条路线对着六条判据打分

评分 1–5（5 最好）；"可行性"是按本机 DSH 现状判的硬门槛。

| 判据 | A. 案例/工作流注入<br>（Memento 读路径 + AWM） | B. 候选重排<br>（JitRL，需 top_logprobs） | C. 推理代理层<br>（OptiLLM 式独立代理） |
|---|---|---|---|
| 纯 API 可实现 | **5**（只需 context 缝） | 1（DSH 无 logprobs；需改 adapter 或扩展） | 3（可行，但要绕开 DSH 的 llm 服务另起一套） |
| 无需 ground-truth | 3（需 LLM judge 或用户反馈） | 3（同） | 2（多为数学/代码类任务设计） |
| 可回滚可关闭 | **5**（换一版文本即回滚） | 2（advantage 参数与记忆耦合，难回滚） | 3（换 approach 即回滚，但状态在代理侧） |
| 效果可测量 | 4（同一评测集 A/B） | 4 | 3（不同 approach 不可比） |
| 单次交互额外成本 | **5**（0 次额外调用） | 2（top-k 重排本身不贵，但取 logprobs 需改链路） | 2（MoA 一类是 3–6 倍调用） |
| 与 DSH 缝贴合度 | **5**（`systemPrompt.context` + `pre-step` 直接对应） | 2 | 2（要架在 DSH 之外） |
| **加权结果** | **最优** | 次优，且当前不可用 | 不推荐（除非自托管） |

### 7.2 先看最强的反对意见

> **"这一整套只是把 prompt 工程包装成自进化。"**

这个批评有相当分量，必须诚实记录。JitRL 论文对 AWM 的批评正是这一类："memory-based approaches plateau early, because they over-rely on established memory patterns, which inhibit further exploration" [1]。而且作者本人也承认 prompt 与 logits 的差距"可能随指令遵循与长上下文能力增强而收窄" [4]。

**反驳的唯一有效方式是闸门**：如果每一轮演化都必须过验证集 A/B，那它至少不是"漂移"，而是"有选择的漂移"。这也是为什么第 7.2 节把闸门列成独立部件而不是配件——**没有闸门的注入系统不配叫自进化**。

### 7.3 推荐：A 为主线，B 留接口，C 只在自托管时考虑

**主线（A）——「有界文本策略对象 + 检索注入 + 离线闸门」**，由三个可独立开关的部件组成：

| 部件 | 抄谁 | 落地到 DSH 的哪个缝 |
|---|---|---|
| ① 案例库（只读注入） | Memento 读路径：正例给"好计划长什么样"，负例给"别这么规划" | `systemPrompt.context` 注入一条短快照 |
| ② 迭代对象 = 技能/工作流文件（**不是**案例库） | Memento-Skills：`SKILL.md` + 脚本，可 diff、可回滚 | 工作区文件 + `appendPluginRecord` 记版本 |
| ③ 接受闸门 | Meta-TTL：同验证集逐任务 z-score + accept_margin | 既有评测集跑 A/B，通过才替换 |
| ④ 离线 dream | Meta-TTL 外层反思 + Memento-Skills 写路径 | `dsh-schedule` 定时唤起 + `agent.followup` |

**为什么案例库只读不写**：Memento 的写路径（judge 判对错 → 无条件 append → 无去重无淘汰）在对话陪伴场景会迅速退化——没有 ground truth 的 judge 会反复把"模型自己觉得好"的内容写进去，形成自我确认回路。**案例库可以自动写，但必须先进暂存区，等 dream 阶段归因 + 闸门通过后再提升。** 这是把 Memento 的读路径与 Memento-Skills 的写路径拆开用的关键。

**关于 dream 阶段的具体形态**（回答用户"dream 离线阶段和案例重放结合"）：

1. **重放**：取出当期 episode 轨迹（DSH 的 append-only session log 天然可重放）
2. **归因**：失败先归因到**一个**被用过的技能/策略条目（抄 `ATTRIBUTION_PROMPT` 的做法）
3. **提炼**：两阶段——先抽 task-specific facts，再抽象成"适应失败"层面的规则，且**禁止把任务特定知识写进策略**（抄 Meta-TTL 的 `keep ALL of this out`）
4. **闸门**：候选在验证集上与 current 比，逐任务 z-score 均值 > current + margin 才接受（抄 BIS）
5. **部署**：通过才原子替换，失败保留原树（抄 Memento-Skills）

**一条被清单漏掉的现成骨架**：OptiLLM 的 SPL 插件（见 5.2）已经实现了这条主线的核心——策略库 JSON 落盘、按相似度与历史表现选择、评测后写回。差别只在它**没有闸门**（写完就用，不 A/B、不回滚）。要自建，最短路径是把 SPL 的 `strategy.py` 读一遍，然后补上 Meta-TTL 的 BIS 接受准则。

**B 的留口方式**：在 advantage 计算里预留"候选重排"接口，但当前实现退化为"注入强度调节"——即把 `A(c)` 用于决定注入几条、注入多强，而不是用于改候选排序。等 DSH 暴露 `top_logprobs` 再升级。

### 7.4 最便宜的可逆性对冲

- 所有注入内容走 `systemPrompt.context`（文本变化才重发，删掉即恢复），**不要**写进 `systemPrompt.section`（改一次全量重发，且难以局部回退）
- 技能/策略文件放在工作区可被 git 管理的位置，每次演化一个 commit
- 闸门失败时**保留原树**而不是"回滚"——少一步操作，少一次出错机会
- 整个功能一个开关，关掉后 `text` 函数返回 `''`（DSH 明确要求 context 的 text 函数"never throw, return '' on error"）

---

## 8. 还缺什么

真正没解决的是这四条（其余已在正文就近标注，不再重复）：

1. **"注入 vs 微调 vs 候选重排"没有系统性量化比较**。三路检索都没找到综述或统一 benchmark，唯一把"冻结 + 测试时优化"与"参数训练"放进同一张表的是 LTPO Table 2（Genius / SimpleRL-Zoo / SoftCoT 都是训练型方法），但它是附带对比，不是为回答这个问题设计的，且只在数学推理上 [12]。这是本报告最大的空白。
2. **"多次采样后重排"相对"注入"是否还有优势，无证据**。这直接决定 B 路线值不值得等 DSH 的 `top_logprobs`。
3. **对话陪伴场景的 judge 可靠性未验证**。六个项目的写入信号都依赖一个比任务更容易验证的 oracle（答案对错、游戏分数），陪伴场景没有等价物。
4. **Memento 消融表的具体数值未取到**（只有 OOD 增益区间 +4.7~9.6），"案例库本身"的净贡献无法精确量化 [7]。

## 9. Staleness map（这些结论最快过期）

**最早复核日 2024-12-11**（AWM 的 WebArena 数字）。**已有 5 条过期**，全部是 benchmark 类：

| 过期日 | 条目 | 结论 |
|---|---|---|
| 2024-12-11 | AWM WebArena 总成功率 35.5 [5] | 距今近两年，只能当历史基线 |
| 2026-09-11 | AWM 无检索、全量注入 7.3–7.4 条 [5] | 若 AWM 发布 v2 需重核 |
| 2025-11-25 | Memento GAIA val 87.88 / test 79.40 [7] | 榜已变（test 上 Memento 已非第一） |
| 2025-11-25 | Memento 案例库 OOD 增益 +4.7~9.6 [7] | 同上 |
| 2026-01-05 | LTPO 平均 48.66 vs CoT 42.35 [12] | 数学基准已被后续方法刷过 |

**没到期的**：所有 `mechanism` 类（2028 年复核）、DSH 的 `host-api`（2026-12-22）、OptiLLM 的 `engineering`（2026-12-16）、纯 API 能力（2026-12-18）。

**怎么用这张表**：机制与工程结论可以放心用；**任何 benchmark 数字引用时必须带日期与 backbone**，因为它们过期最快，而"JitRL 46.98 胜过 AWM"这种跨论文比较本身就带着设置差异——AWM 自家论文报 35.5，JitRL 复现的是 39–41 区间，backbone 与 online/offline 设置都不同。

<details>
<summary>复核窗口是怎么算的</summary>

用 `recon_kit.py staleness` 算的，不是手写的。类目 → 窗口的映射按 technical pack 的 freshness 条：

| class | 含义 | 窗口 | 依据 |
|---|---|---|---|
| `mechanism` | 源码里读出来的实现事实 | 24 个月 | 代码改动才失效，最耐用 |
| `engineering` | 仓库当前实现状态 | 1 个月 | 仓库活跃，随时可能变 |
| `api-capability` | OpenAI / vLLM 官方参数 | 1 个月 | 规范随版本变动 |
| `host-api` | 本机 DSH `.d.ts` | 1 个月 | 升级即失效 |
| `benchmark` | 论文报告的数字 | 3 个月 | 领域跑得快，基线会被刷 |

</details>

## 10. 来源

| # | 来源 | URL | 类型 | 日期 |
|---|---|---|---|---|
| 1 | JitRL 论文 arXiv 2601.18510v4《Just-In-Time Reinforcement Learning》 | https://arxiv.org/abs/2601.18510 | 论文 | 2026-09-27 (v4) |
| 2 | JitRL 仓库 liushiliushi/JitRL（`jitrl_agent.py`、`cross_episode_memory.py`、README） | https://github.com/liushiliushi/JitRL | 源码 | pushed 2026-09-22 |
| 3 | JitRL issue #4（第三方逐条指出论文-代码不一致） | https://github.com/liushiliushi/JitRL/issues/4 | issue | 2026-10-17 |
| 4 | JitRL issue #2（作者回应 prompt vs logits 的差距来源） | https://github.com/liushiliushi/JitRL/issues/2 | issue | 2026-07-14 |
| 5 | AWM 论文 arXiv 2409.07429v1《Agent Workflow Memory》 | https://arxiv.org/abs/2409.07429 | 论文 | 2024-09-11 |
| 6 | AWM 仓库 zorazrw/agent-workflow-memory | https://github.com/zorazrw/agent-workflow-memory | 源码 | pushed 2025-12-22 |
| 7 | Memento 论文 arXiv 2508.16153v2《Fine-tuning LLM Agents without Fine-tuning LLMs》 | https://arxiv.org/abs/2508.16153 | 论文 | 2025-08-25 (v2) |
| 8 | Memento 仓库 Memento-Teams/Memento（`no_parametric_cbr.py`、`np_memory.py`、`parametric_memory.py`、`agent.py`） | https://github.com/Memento-Teams/Memento | 源码 | pushed 2025-10-05 |
| 9 | Memento-Skills 仓库 Memento-Teams/Memento-Skills（`core/skill/evolution/engine.py`、README） | https://github.com/Memento-Teams/Memento-Skills | 源码 | pushed 2026-08-17 |
| 10 | Memento-Skills 论文 arXiv 2603.18743v1《Let Agents Design Agents》（仅摘要） | https://arxiv.org/abs/2603.18743 | 论文 | 2026-03-19 |
| 11 | meta-ttl 仓库 zzzlou/meta-ttl（`meta_learner/optimizer.py`、`reflection.py`、README） | https://github.com/zzzlou/meta-ttl | 源码 | pushed 2026-09-26 |
| 12 | LTPO 论文 arXiv 2510.04182《Thinking on the Fly》 | https://arxiv.org/abs/2510.04182 | 论文 | 2025-10-05 |
| 13 | LTPO 仓库 ltpo2025/LTPO（`ltpo.py`、`main.py`、`reward.py`） | https://github.com/ltpo2025/LTPO | 源码 | 2025-10 |
| 14 | OptiLLM 仓库 algorithmicsuperintelligence/optillm（`server.py`、`moa.py`、`bon.py`、`self_consistency.py`、`cot_decoding.py`、README） | https://github.com/algorithmicsuperintelligence/optillm | 源码 | pushed 2026-11-16 |
| 15 | OpenAI OpenAPI spec（`logit_bias` / `logprobs` / `n` / `seed` 字段定义） | https://github.com/openai/openai-openapi/blob/master/openapi.yaml | 规范 | 2026-11 |
| 16 | vLLM `vllm/sampling_params.py`（top_k / min_p / allowed_token_ids / structured_outputs） | https://github.com/vllm-project/vllm/blob/main/vllm/sampling_params.py | 规范 | 2026-11 |
| 17 | ExpeL arXiv 2308.10144 | https://arxiv.org/abs/2308.10144 | 论文 | 2023-08-20 |
| 18 | Reflexion arXiv 2303.11366 | https://arxiv.org/abs/2303.11366 | 论文 | 2023-03-20 |
| 19 | Voyager arXiv 2305.16291 | https://arxiv.org/abs/2305.16291 | 论文 | 2023-05-25 |
| 20 | Dynamic Cheatsheet arXiv 2504.07952 | https://arxiv.org/abs/2504.07952 | 论文 | 2025-04-10 |
| 21 | ACE (Agentic Context Engineering) arXiv 2510.04618 | https://arxiv.org/abs/2510.04618 | 论文 | 2025-10-06 |
| 22 | MemRL arXiv 2601.03192（仅标题与存在性，机制未读） | https://arxiv.org/abs/2601.03192 | 论文 | 2026-01-06 |
| 23 | SEAL arXiv 2506.10943（改权重的反例） | https://arxiv.org/abs/2506.10943 | 论文 | 2025-06-12 |
| 24 | DSH `dsh-llm` 类型定义：`types.d.ts:538`（GenerateOptions）、`call-config.d.ts:10`（LlmCallControls）、`index.d.ts:31-46`（llm/stream 瀑布） | 本地：`@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/` | 源码 | 0.2.2-rc.5 |
| 25 | DSH `dsh-deepseek-llm-api-extensions` `types.d.ts`（DeepSeekLlmApiExtensionMap 请求体扩展） | 本地：`@deepseek-ai/dsh-deepseek-llm-api-extensions/lib/types/` | 源码 | 0.2.2-rc.5 |


