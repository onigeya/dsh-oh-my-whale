# Digest A：JitRL 与 Agent Workflow Memory (AWM)
**主题**：冻结 LLM 权重下，用记忆库实现策略迭代（无梯度更新）
**检索日期**：accessed = 2026-11-22 ｜ **作者**：researcher-a
**来源预算**：8 个一手来源（JitRL README / JitRL WebArena agent 源码 / JitRL cross_episode_memory 源码 / JitRL arXiv PDF v4 / JitRL GitHub issues / AWM README / AWM arXiv PDF v1 / AWM workflow 样例文件）

> class 标记：论文 = arXiv 原文；源码 = 仓库代码原文；README = 仓库自述；issue = GitHub issue 中的真实提问/作者答复。
> 所有非「论文/源码」的数字都显式标注为自述，不与论文表格混用。

---

## 0. 一句话结论

- **JitRL 的「logits 调制」在工程上不是注入 logits，而是用 API 返回的 top_logprobs 对已解码出的 top-k 候选动作做概率加性重排 + 贪心 argmax**。因此它**不需要 vLLM、不需要本地权重**，反而天然支持 OpenRouter 上的闭源模型——代价是放弃了论文 Eq.(10) 的分布采样语义（源码 + issue #4 双重证据）。
- **AWM 完全不碰输出分布**，只把「自然量子程序 + 抽象动作模板」形式的 workflow 作为 in-context 示例注入 prompt；它没有 top-k 检索打分器，是近乎全量注入。
- 两者在 JitRL 论文自己的 Table 1 上同台对比：WebArena 平均成功率 JitRL 46.98 vs AWM 41.08（Avg），Final 51.35 vs 42.12。

---

## 1. 发现清单

### 1.1 JitRL — 记忆结构

| # | claim | 证据位置 | publisher | pub_date | confidence | class |
|---|---|---|---|---|---|---|
| J1 | 记忆形式上定义为 M = {(s_i, a_i, G_i)}_{i=1..N}，第三元是**折扣回报 G_t**，不是即时 reward。G_t = Σ_{u=t..T} γ^(u−t) r_u。 | arXiv 2601.18510v4 §4.1，PDF 文本行 164-166、191 | arXiv / NUS 作者 | 2026-09-27 (v4) | high | 论文 |
| J2 | state 序列化：WebArena 侧是**正则化 URL**（把 .../customer/edit/123 与 /456 折叠成同一「generic view」）+ 本地动作历史（如搜索框已输入文本）；Jericho 侧压成 [State: nouns...] [Action: verbs...]，另加 [SUMMARY] / [PROGRESS] / [LOCATION] 三层上下文。 | 同上 §4.1 + Appendix F「State Representation」，PDF 行 949-963 | 同上 | 同上 | high | 论文 |
| J3 | action 是**语义动作**，不是 token 序列。WebArena 把 click('1240') 归一化成 click(<combobox[Sort by:]>)（element id → accessibility tree 描述）；Jericho 把输出空间硬约束到游戏引擎给的合法动作集。代码由 normalize_action / denormalize_action 实现。 | Appendix F「Action Handling」PDF 行 998-1007；WebArena/memory_agents/jitrl_agent.py:209, 271-273 | 同上 | 同上 | high | 论文 + 源码 |
| J4 | reward 来自 **LLM Evaluator 的事后逐步打分**，不是环境分数。映射 E: τ → {r_t}_{t=1..T}，每步一个标量表示该动作对任务成功的贡献；随后聚合成 G_t。环境分数/成功标志只在 episode 末尾作为输入之一给 Evaluator。 | §4.1「Reflective Step-wise Rewards」PDF 行 175-191；jitrl_agent.py:147-202（end_episode 调 cross_mem.add_episode，最后一步失败时置 reward=-10，见 cross_episode_memory.py:831） | 同上 | 同上 | high | 论文 + 源码 |
| J5 | 代码里的实际记忆写盘路径是 **episode 级 jsonl + step 元数据**，字段含 reward、llm_step_score、future_rewards[]、discounted_reward、normalized_action。检索时若 reward 为 0/None 则回退用 llm_step_score 累加折扣回报。 | WebArena/memory_agents/utils/cross_episode_memory.py:294-311, 560-569, 722-831 | liushiliushi/JitRL | pushed 2026-09-22 | high | 源码 |

> 注：论文三元组写 <s, a, G>，README 与概览写 <state, action, reward>。**以论文为准：存的是折扣回报 G_t**，reward 只是中间量。这是一处 README 与论文的措辞不一致。

### 1.2 JitRL — 检索

| # | claim | 证据位置 | publisher | pub_date | confidence | class |
|---|---|---|---|---|---|---|
| J6 | **没有 embedding**。相似度是 **Jaccard**：J(s,s_i) = \|T(s)∩T(s_i)\| / \|T(s)∪T(s_i)\|，T(·) 为 state 表示的分词集合。 | Appendix F「Retrieval Similarity Metric」式(24)，PDF 行 975-981 | arXiv 作者 | 2026-09-27 | high | 论文 |
| J7 | **代码显式关闭了向量检索**：self.encoder_available = False  # Disable embedding to save costs，日志打印 Using BM25 for retrieval (vector embedding disabled to save costs)。即 embedding 模型字段（text-embedding-ada-002, dim 1536）仍在构造函数签名里，但**不参与检索**。 | cross_episode_memory.py:24, 45-59 | liushiliushi/JitRL | pushed 2026-09-22 | high | 源码 |
| J8 | WebArena 是**两阶段层级匹配**：先按 Regularized URL 过滤到同一页面类型，再在该子集内算有效状态（当前 filter/输入框）的 Jaccard。 | Appendix F「Memory Retrieval」PDF 行 983-989 | arXiv 作者 | 2026-09-27 | high | 论文 |
| J9 | 代码里的合成相似度是 similarity = 0.7 * history_sim + 0.3 * task_sim；task 过滤用 _jaccard(..., ngram=1) 且阈值 task_similarity_threshold = 0.27；**阈值随步数线性衰减**：dynamic_threshold = r − 0.1 * (step_count / max_steps)，max_steps = 20。 | cross_episode_memory.py:24, 451-462, 498-507, 557, 596-598 | 同上 | 同上 | high | 源码 |
| J10 | **top-k 与阈值可配，论文与代码取值不同**。论文说 k 在 8–14 之间表现稳健，超出则退化（k 小则估计方差大，k 大则噪声多、延迟收敛）。WebArena 代码调用处写死 k=10, r=0.8。Jericho 侧 README 暴露 --retrieval_top_k（示例 10）与 --retrieval_threshold（示例 0.8）。 | 论文 §5.6 + Figure 4，PDF 行 501-507；jitrl_agent.py:1119；README「Custom Retrieval Parameters」 | arXiv 作者 / 仓库 | 2026-09-27 / 2026-09-22 | high | 论文 + 源码 |
| J11 | 论文里 Jericho 的检索权重是 **0.75 state + 0.25 history**，且额外用 Jaccard 做词面重叠过滤。这与 WebArena 代码里的 0.7/0.3 是**不同实现的两套权重**，不要混用。 | Appendix F「Memory Retrieval」PDF 行 991-993 | arXiv 作者 | 2026-09-27 | high | 论文 |
| J12 | **未发现去重或聚类机制**。检索只做过滤 + 排序 + 截断（retrieve_similar_with_vector 末尾 return filtered_trajectories，注释写 "all high similarity (>0.98) + additional medium similarity if needed to reach k"，但代码并未实现该合并逻辑）。 | cross_episode_memory.py:600-702 | liushiliushi/JitRL | pushed 2026-09-22 | high | 源码 |

### 1.3 JitRL — advantage 与 logits 调制

| # | claim | 证据位置 | publisher | pub_date | confidence | class |
|---|---|---|---|---|---|---|
| J13 | 值估计是**邻域均值**，不是加权均值、也不是差值回归：V(s) := (1/\|N(s)\|) Σ_{i∈N(s)} G_i（式4）。动作值 Q(s,a) := (1/\|N(s,a)\|) Σ_{j∈N(s,a)} G_j，N(s,a) = {(s_i,a_i,G_i) ∈ N(s) : a_i = a}（式5）。 | §4.2 式(4)(5)，PDF 行 185-208 | arXiv 作者 | 2026-09-27 | high | 论文 |
| J14 | 未见动作用**乐观探索**：以概率 λ 赋 Q(s,a) := V(s) + α/\|N(s)\|，否则 Q(s,a) = 0。bonus 随记忆覆盖度增大而衰减。 | §4.2 式(6)，PDF 行 210-223 | 同上 | 同上 | high | 论文 |
| J15 | advantage = 动作值减状态基线：A(s,a) = Q(s,a) − V(s)（式7）。**是差值，不是加权平均**。 | §4.2 式(7)，PDF 行 225-234 | 同上 | 同上 | high | 论文 |
| J16 | 代码与公式一一对应：action_advantages[a] = action_avg_rewards[a] − overall_avg_reward；未见动作以 exploration_prob = 0.05 概率赋 overall_avg_reward + alpha/max(count,1)（alpha = 1），否则 0；随后把 advantage 按最大正值（或最大负绝对值）归一化到 [−1,1]。 | jitrl_agent.py:285-349（exploration_prob=0.05 在 306 行，alpha = 1 在 308 行） | liushiliushi/JitRL | pushed 2026-09-22 | high | 源码 |
| J17 | **闭式解的目标函数**：π* = argmax_{π'} E_{a∼π'}[A(s,a)] − (1/β) D_KL(π' ‖ π_θ)（式8/11）。解为 π*(a\|s) ∝ π_θ(a\|s) exp(β A(s,a))（式9），取对数得**加性 logit 更新** z'(s,a) = z(s,a) + β·A(s,a)（式10/12）。β 是控制 KL 约束强度的温度超参。 | §4.3 式(8)(9)(10) + Theorem 4.1 式(11)(12)，PDF 行 240-267 | arXiv 作者 | 2026-09-27 | high | 论文 |
| J18 | 理论部分共三条：Theorem 4.1（logit 更新是 KL 约束目标的精确闭式解）、Theorem 4.2（V_t/Q_t/A_t 在非平稳策略下依概率收敛到真值）、Theorem 4.3（策略更新一致性）。 | §4.4，PDF 行 206-267、837 | 同上 | 同上 | high | 论文 |
| J19 | **候选集扩张**：C ← C_LLM ∪ {a_i : (s_i,a_i,G_i) ∈ N(s)}（式23）。对不在 LLM top-k 里的历史动作，把其基础 logit 初始化为**中性值 z(s,a) = 0**。这是把记忆里的动作「塞回」候选池的关键一步。 | Appendix F「Augmented Candidate Set」式(23)，PDF 行 965-973 | 同上 | 同上 | high | 论文 |
| J20 | **代码里的实现是概率空间加性、不是 logit 空间加性**：corrected_logprob = normalized_prob + 1 * normalized_advantage。**β 被硬编码为 1**，而 normalized_prob = exp(candidate.logprob)（把 logprob 转成概率）。随后 max(..., key=corrected_logprob) **贪心选最大**，而不是从 softmax 采样。 | jitrl_agent.py:366-390（关键行 377-378）、:1129-1132（贪心选择）、:1020-1043（normalized_prob = math.exp(candidate.logprob)） | liushiliushi/JitRL | pushed 2026-09-22 | high | 源码 |
| J21 | **作用位置**：只作用在**动作的最后一个 token** 的 top-k 候选上（last_token_logprob = res_obj.choices[0].logprobs.content[-2]，取 top_logprobs[:top_actions]）。不是逐 token 重加权整条序列。 | jitrl_agent.py:1020-1043 | 同上 | 同上 | high | 源码 |

### 1.4 JitRL — 工程约束（关键）

| # | claim | 证据位置 | publisher | pub_date | confidence | class |
|---|---|---|---|---|---|---|
| J22 | **不需要 vLLM、不需要本地权重**。全部推理走 OpenRouter API；README 的 Supported Models 表显式列出 OpenAI gpt-4o/gpt-4-turbo/gpt-4o-mini、Anthropic claude-3.5-sonnet/claude-3-opus、Google gemini-2.5-flash/pro、Meta、Mistral。 | README「Supported Models」与「Key Features: Multi-model Support」；jitrl_agent.py:912-920（top_logprobs=self.args.top_actions，标准 OpenAI 兼容参数） | liushiliushi/JitRL | pushed 2026-09-22 | high | README + 源码 |
| J23 | 因为只能拿到 API 的 top-k logprob，**必须存在一个「verbalized」降级模式**：logit_mode ∈ {'token','verbalized'}，verbalized 模式不问 logprob，改让模型自报 confidence（%），再 confidence/100 当概率用。 | jitrl_agent.py:87, 649-650, 776, 856, 913, 1045-1063 | 同上 | 同上 | high | 源码 |
| J24 | **作者已知论文公式与代码不一致，但截至 2026-11-22 未公开回应**。第三方 issue #4（2026-10-17 提交，state=open，**0 条评论**）逐条指出：Jericho/WebArena 都是把归一化 advantage 加到 normalized_prob 而非 logit；最终是取最大 adjusted score 而非 softmax 采样；并追问「这是有意的实践变体吗」「论文数字用的是哪套规则」「公开仓库是否与实验版本不同」。 | https://github.com/liushiliushi/JitRL/issues/4（正文引用 jitrl_agent.py#L707-L734、#L375-L387、#L769-L773、WebArena #L366-L378、#L1129-L1132 与 commit 143d221） | sytmrrow（第三方） | 2026-10-17 | high | issue |
| J25 | **作者承认 prompt 与 logits 的差距可能是暂时的**：「JitRL 用到的信息原则上都能用文字表达，所以第 1 点的差距可能随模型的指令遵循和长上下文能力增强而收窄。不过就我们目前测过的所有模型而言，JitRL 还是有优势的。」 | https://github.com/liushiliushi/JitRL/issues/2，作者 liushiliushi 回复 | liushiliushi（作者本人） | 2026-07-14 | high | issue |
| J26 | 作者在同一回复里给出机制辩护：差距来自 (1) **通道可靠性**——prompt 注入依赖长上下文注意力，logit 修正「把 advantage 以校准过的数值直接加在动作分布上」；(2) **粒度与 credit assignment**——记忆是 step 级 <state, action, reward>，每步以当前状态为 key 检索，失败经验以负 advantage 精确作用在出错的那个状态上，而 trajectory 级 prompt 一旦偏航就失配。 | 同上 | 同上 | 2026-07-14 | high | issue |

> 工程结论（有证据支撑，非推测）：JitRL **可以**跑闭源 API 模型，所以「商业 Agent 产品里根本不成立」的说法不成立；但真实机制是 **top-k 候选重排（rerank）**，等价于把记忆当作一个作用于解码候选的打分先验。它的能力上界被 API 的 top_logprobs 上限和「只能重排已生成候选」这一事实锁死——**它无法提升一个根本没进 top-k 的动作的概率**，除非该动作恰好来自记忆候选集（式23 的补集机制）。

### 1.5 JitRL — 记忆规模与淘汰

| # | claim | 证据位置 | publisher | pub_date | confidence | class |
|---|---|---|---|---|---|---|
| J27 | **跨 episode 记忆库没有淘汰/合并/上限机制**。cross_episode_memory.py 中检索到 max_tokens=1000（LLM 摘要用）与 max_steps=20（阈值衰减用），**没有** max_entries / evict / prune / merge。唯一的上限是 **episode 内** prompt 记忆：add_to_memory 里 if len(self.memory) > self.args.max_memory: self.memory.pop(0)（FIFO），作用对象是 self.memory 而非 cross-episode bank。 | cross_episode_memory.py 全文 grep（无命中淘汰逻辑）；jitrl_agent.py:130-134 | liushiliushi/JitRL | pushed 2026-09-22 | high | 源码 |
| J28 | 论文把**无限增长当成特性**：把记忆按 500 条一 bin 切分，报告「JitRL's performance continuously improves as memory grows, while retrieval overhead remains negligible compared to LLM inference time」（Table 19，Library 游戏 50 episodes）。**没有报告收益饱和或下降的拐点。** | Appendix N「Scalability of JitRL」，PDF 行 1409-1414 | arXiv 作者 | 2026-09-27 | high | 论文 |

### 1.6 AWM — workflow 抽象与归纳

| # | claim | 证据位置 | publisher | pub_date | confidence | class |
|---|---|---|---|---|---|---|
| A1 | workflow 是**自然语言子程序 + 抽象动作模板**，形式化 I(E) → W = {w} = {(d_j, P_j^d)}，d_j 是自然语言描述、P_j^d 是步骤序列。**不是**代码、不是纯步骤模板。 | arXiv 2409.07429v1 §2 式，PDF 行 184-187 | CMU / MIT 作者 | 2024-09-11 | high | 论文 |
| A2 | 归纳者是 **LLM 本身**（与动作生成同一个模型，gpt-4 或 gpt-3.5-turbo，temperature 0.0）。归纳 prompt 明确要求：抽取「commonly reused sub-routine」、**每个 workflow 至少两步**、不要生成相似/重叠的 workflow、用描述性变量名替换非固定元素。 | §2「LM-based Workflow Induction」+ Appendix A.1 归纳 prompt，PDF 行 189-206、931-935；§3.2 行 469-470 | 同上 | 同上 | high | 论文 |
| A3 | **抽象化的关键是去掉 example-specific 值**：把 "dry cat food" 换成 {product-name}，并把粒度降到子任务（"search for a product on Amazon"）而非整条任务指令。workflow 之间按**模型输出的双换行**切分。 | §2，PDF 行 193-206 | 同上 | 同上 | high | 论文 |
| A4 | 实际产物形态（仓库样例）：## shopping: Browse Products in a Specific Category 标题 + 自然语言解释 + hover('main category id') / click('subcategory id') 这类**抽象后的动作调用**，与 <action>...</action> 的 few-shot 示例混排。 | webarena/workflow/shopping.txt（首屏为 ## Concrete Examples + Query + <action> 块）；论文 Appendix A.2，PDF 行 941-973 | zorazrw/agent-workflow-memory | 仓库 pushed 2025-12-22 | high | 源码 + 论文 |

### 1.7 AWM — offline vs online、检索与注入

| # | claim | 证据位置 | publisher | pub_date | confidence | class |
|---|---|---|---|---|---|---|
| A5 | **offline**：把所有训练样本拼成**一个大 prompt** 一次性喂给 LM，产出 W_offline；所有测试任务共用同一份 workflow 记忆，L(q, M + W_offline, o) → a。 | §2.3「Offline Scenario」，PDF 行 227-237 | 同上 | 2024-09-11 | high | 论文 |
| A6 | **online**：无监督、流式。对第 t 个测试指令先正常求解得到轨迹 e_t = (q_t, {p_t})，再用 LLM 评估器（Pan et al. 2024）输出二值标签 L_eval(e_t) ∈ {0,1}，**成功才归纳并累积**进记忆，随后服务后续测试。 | §2.3「Online Scenario」，PDF 行 239-262 | 同上 | 同上 | high | 论文 |
| A7 | **没有 top-k 检索打分器**。论文的注入方式是「把 workflow 集合整合进 agent memory 作为辅助上下文」M + W → M_W，没有相似度、没有 embedding、没有阈值。仓库里是静态 workflow/<site>.txt 直接拼进 prompt。 | §2 式 L(q, M_W, o) = L(q, M+W, o) → a，PDF 行 209-219；webarena/workflow/*.txt（gitlab/map/reddit/shopping/shopping_admin 五个站点各一份） | 同上 | 同上 | high | 论文 + 源码 |
| A8 | **注入条数量级**：神经归纳产出 **7.3–7.4 个 workflow / 示例**；WebArena 上 utility rate 0.94、function overlap 0.08；Mind2Web 上 coverage 0.40、overlap 0.20、utility 0.91。作者评价 7.3–7.4「efficient and do not add too much content to the memory」。 | Appendix「Quality evaluation」Table 10，PDF 行 1016-1045 | 同上 | 同上 | high | 论文 |
| A9 | AWM 论文**没有**给出「多少条 workflow 之后收益饱和/下降」的曲线或拐点。最接近的证据是 Table 11：AWM_off+on（offline 与 online workflow 合并）得分落在 offline 与 online 之间，作者明确说「Rather than an additive effect, workflows induced offline and online are **not fully compatible**」。 | Appendix C，Table 11，PDF 行 1076-1096 | 同上 | 同上 | high | 论文 |
| A10 | 归纳方式消融：rule-based（按动作序列去重、剔除不可执行步骤）vs LM-based。WebArena 上 **持平**（AWM_rule 35.6 vs AWM_lm 35.5，SR），但 LM 版少 0.4 步；Mind2Web 上 LM 版 **+2.8**。 | §4.1 Table 5/Table 6，PDF 行 575-597 | 同上 | 同上 | high | 论文 |

### 1.8 交叉：JitRL 论文对 AWM 的定位

| # | claim | 证据位置 | publisher | pub_date | confidence | class |
|---|---|---|---|---|---|---|
| X1 | JitRL 论文把 AWM 列为**训练自由基线**并在同表对比：WebArena Avg/Final — AWM 41.08/42.12，Reflexion 41.36/43.00，Static Memory 35.63/36.30，EvoTest 39.37/40.32，**JitRL 46.98/51.35**。 | Table 1，PDF 行 351-363 | arXiv 作者（JitRL） | 2026-09-27 | high | 论文 |
| X2 | JitRL 作者对 AWM 失败模式的解释：「Memory-based approaches (Memory, AWM) **plateau early**, because they **over-rely on established memory patterns, which inhibit further exploration** and cause the agents to converge to suboptimal policies.」（Jericho 语境） | §5.2.2，PDF 行 392-394 | 同上 | 同上 | high | 论文 |
| X3 | **不可直接比较**：AWM 的 WebArena 主结果用 GPT-4 + **online** 设置且只有 test 集；JitRL Table 1 未说明是否同 backbone/同设置对齐。两者跨论文引用存在 backbone 与设置差异风险。 | AWM §3.1 PDF 行 328-330（"we only conduct AWM in the online setting"）；JitRL Table 1 | 双方 | — | medium | 论文（推断性对比，需谨慎） |

---

## 2. 机制闭环叙述

### 2.1 JitRL

**状态怎么表示**：不喂原始 DOM/长文本。WebArena 用「正则化 URL + 本地动作历史」当结构化代理——把 .../edit/123 与 .../edit/456 折叠成同一页面类型，从而让「同类页面上的经验」跨实例迁移；Jericho 用 [State: 名词][Action: 动词] 的压缩摘要，外加全局 [SUMMARY]、[PROGRESS]、剪枝过的 [LOCATION] 轨迹。设计原则是「功能等价的状态映射到相似表示」。

**记忆存什么**：(s_t, a_t, G_t) 三元组，**step 级**粒度，不是整条轨迹。G_t 是折扣回报，r_t 由 episode 结束后 LLM Evaluator 对整条轨迹做 reflective step-wise 打分得到。代码层面落成 jsonl：episode 记录 + 每步 future_rewards[]，检索时用当前 γ 现算 discounted_reward（所以 γ 可以换而不必重算历史）。

**怎么检索**：**纯词面，不是语义向量**。Jaccard over tokenized state；WebArena 先按正则化 URL 硬过滤再做 Jaccard；代码里合成 0.7·history + 0.3·task，task 相似度阈值 0.27，最终阈值随步数从 r 线性降到 r−0.1（r=0.8, max_steps=20），取 k=10。**没有去重、没有聚类、没有 embedding**（embedding 代码路径被显式关闭以省成本）。

**怎么打分**：对检索邻域取**未加权均值**得 V(s)；对同一动作子集取均值得 Q(s,a)；A = Q − V。未见过的动作以 5% 概率给 V(s) + α/|N(s)| 的乐观奖励（α=1），否则 0——这实际上是一个「计数衰减的 UCB 式探索」，把「记忆里没见过」当成不确定性而非零价值。

**怎么作用到模型输出**：把 β·A 加到每个候选的分数上，β=1 硬编码。候选集 = LLM 的 top-k token ∪ 记忆里在该状态出现过的历史动作（后者的基础分设为 0）。**作用位置是动作最后一个 token 的 top-k 候选**，最后取 argmax 执行。论文写的是 logit 空间加性再 softmax 采样；代码是概率空间加性再贪心。这个 gap 已由第三方 issue #4 公开指出，作者未回复。

**闭环的关键不对称**：advantage 来自「历史折扣回报的邻域均值」，与当前策略 π_θ 的输出**没有耦合**——不需要 importance sampling、不需要 baseline 网络。代价是 J13 的 V/Q 都是**历史策略下的回报**，Theorem 4.2 的收敛性依赖「记忆无限增长 + 策略漂移可控」的假设，而 J28 表明记忆确实不淘汰。

### 2.2 AWM

**状态怎么表示**：不做特殊状态抽象。用的是 agent 原本的 observation（WebArena 为 accessibility tree，Mind2Web 为元素过滤后的页面表示）加 think/action 的 ReAct 式格式。

**记忆存什么**：workflow = (自然语言描述 d_j, 抽象动作序列 P_j^d)。抽象体现在把具体值替换成变量占位（{product-name}、{RepositoryName}、'<forum link id>'），粒度降到子任务。一个示例产出 7.3–7.4 条。

**怎么检索**：**没有检索**。这是与 JitRL 最本质的差异之一（不只是「不碰 logits」）。offline 时全部 workflow 一次性进 prompt；online 时随时间累积、全量注入。仓库里是五个站点各一个静态 .txt，直接当 few-shot 示例拼接。

**怎么打分**：没有打分。唯一的筛选信号是 online 模式下 LLM evaluator 的二值成功标签——**只有成功的轨迹才会被归纳**（对比 JitRL：失败经验以负 advantage 显式入库并作用在出错状态上）。

**怎么作用到模型输出**：只改 prompt。零梯度、零 logits、零解码干预。

**AWM 的隐性失效模式**（论文自陈）：workflow 会诱导 agent 走与实际页面状态不符的动作，作者称之为「Learn to diverge from workflow guidelines」的困难——AWM 的 action F1 反而低于 MindAct（PDF 行 507-512）。以及 offline+online workflow 不完全兼容、不产生加性收益（A9）。

---

## 3. 关键数字

### 3.1 JitRL（全部来自论文，非仓库自述）

| 表 | 设置 | 数字 |
|---|---|---|
| Table 1 | WebArena 全站 Avg / Final SR (%) | **JitRL 46.98 / 51.35**；AWM 41.08 / 42.12；Reflexion 41.36 / 43.00；EvoTest 39.37 / 40.32；Static Memory 35.63 / 36.30 |
| Table 1 分站（JitRL Avg） | Admin / GitLab / Map / Reddit / Shopping | 52.31 / 40.78 / 37.66 / 57.64 / 41.67 |
| Table 2 | WebArena-Lite Final SR (%)，与权重更新法比 | **JitRL 60.00**；WebRL 46.06；SFT 23.00 |
| Table 3 | Jericho Avg / Final | Library **25.9 / 30**（GRPO 21.5/26，AWM 13.2/14）；Zork1 **53.0 / 69**（GRPO 46.8/54，AWM 22.9/25）；Zork3 **3.1 / 5**（GRPO 2.6/4，AWM 1.0/1） |
| Table 8 | 消融：Logit vs Prompt（同一份检索结果） | Admin **52.31 vs 48.35**；Reddit **57.64 vs 54.57** |
| Table 9 | 成本 | JitRL **$290**；WebRL **~$9900**；AWM $250；Reflexion $230 |
| §5.6 / Fig.4 | k 敏感性 | k ∈ [8,14] 稳健，过小方差大、过大噪声多 |
| Appendix N | 记忆规模 | 按 500 条/bin，性能随记忆增长**持续提升**，检索延迟相对推理可忽略；**无饱和拐点** |

**消融的完整性缺口**：Table 8 只报了 Admin 与 Reddit **两个站点**，缺 GitLab/Map/Shopping；且没有「去掉记忆只留 logits 调制」这一臂（因为无记忆就无 advantage，该臂在机制上不可构造）。你问的「去掉 logits 调制 vs 去掉记忆 vs 纯 prompt 注入」三臂中，**只有「纯 prompt 注入」这一臂被真正做过**，另两臂在论文里不存在。

### 3.2 AWM（全部来自论文）

| 表 | 设置 | 数字 |
|---|---|---|
| Table 1 | WebArena Total SR (%)，gpt-4-0613, temp 0.0 | **AWM 35.5**（README 与 Table 5 写 35.6，为 AWM_rule）；BrowserGym 23.5（+12.0 abs / +51.1% rel）；SteP（人工写 14 条 workflow）32.0；AutoEval 28.6；WebArena 原论文 33.0 |
| Table 1 | 平均步数 | AWM 5.9 步；比 BrowserGym 少约 2.0 步；比 AutoEval 少 40.8 步 |
| Table 3 | Mind2Web cross-task（gpt-4） | **AWM 50.6 Elem Acc / 57.3 AF1 / 45.1 Step SR / 4.8 Task SR**；MindAct 41.6 / 60.6 / 36.2 / 2.0；Synapse(gpt-3.5) 34.0 / – / 30.6 / 2.4 |
| Table 3（gpt-3.5） | 同上 | AWM 39.0 / 52.8 / 34.6 / 2.8；MindAct 20.3 / 56.6 / 17.4 / 0.8 |
| Table 4 | 泛化（gpt-4，绝对点提升） | cross-task +7.4–8.9、cross-website +3.6–3.8、cross-domain **+14.0–16.9** Step SR |
| Table 5/6 | 归纳方式 | WebArena：rule 35.6 vs lm 35.5（持平，lm 少 0.4 步）；Mind2Web：lm **+2.8** |
| Table 10 | workflow 质量 | 7.3–7.4 条/示例；WebArena utility 0.94 / overlap 0.08；Mind2Web coverage 0.40 / overlap 0.20 / utility 0.91 |

### 3.3 仓库自述数字 vs 论文（**不一致，需警惕**）

README 的 Results 表**无法与论文表格对齐**，且措辞不同（称 "Memory Agent" 而非 JitRL）：

| README 自述 | 论文对应值 | 差异 |
|---|---|---|
| Zork1 35.2 → 52.8（+50%） | Zork1 38.8 → 53.0（Avg） | baseline 差 3.6，JitRL 差 0.2 |
| Library 18.5 → 28.3（+53%） | Library 13.6 → 25.9（Avg） | 均差约 5 |
| Detective 180 → 265（+47%） | **论文 Jericho 只报 Library / Zork1 / Zork3，无 Detective** | README 有论文没有的条目 |
| WebArena-Lite GPT-4o 32.5% → 41.2% | 论文 Table 2 是 Final SR，JitRL 60.00（backbone 为 Llama-3.1-70B 系列，非 GPT-4o） | 设置与 backbone 都对不上 |

→ **结论：README 的 Results 表不可作为引用依据，一律以论文表格为准**（confidence: high，class: README vs 论文对照）。

---

## 4. Leads 与 Gaps

### 值得追的线索

1. **issue #4 是否会有作者回复**（https://github.com/liushiliushi/JitRL/issues/4，open，0 评论，截至 2026-11-22）。这是判断「论文数字到底用哪套更新规则」的唯一权威通道。若能拿到回复，可直接定性 J20 的严重程度。
2. **beta 在代码里是否真的处处为 1**。目前只在 WebArena jitrl_agent.py:378 确认硬编码为 1；Jericho jitrl_agent.py 的对应段（issue #4 引用的 L375-387）尚未逐行核对，可能存在 --beta 参数。
3. **Jericho 主实验的 backbone 是 Qwen3-32B（Table 14/20 语境），WebArena 主实验是 Gemini-2.5-flash**。你关心的「是否只在小模型上有效」需要按 backbone 逐表拆解——JitRL 论文 Table 12/13 有同 backbone 对照（Llama-3.1-70B），值得单独核对是否仍全面胜出。
4. **AWM 的 workflow 注入是否真的无检索**。仓库有 webarena/agents/basic 与 legacy 两个目录未读，可能存在按站点/任务挑 workflow 的逻辑。这会影响「AWM vs JitRL」的对比公平性判断。
5. **AWM 是否有后续版本（v2+）补做了记忆规模曲线**。本次只取到 v1（2024-09-11），arXiv 上 v2 下载失败（export.arxiv.org 对 v2 返回失败）。

### 找过但没找到（gaps）

| gap | 尝试 | 状态 |
|---|---|---|
| JitRL「记忆规模 vs 收益」的饱和/下降拐点 | 检索论文 Appendix N 全文 | **论文明确说持续提升，无拐点**；这本身即结论 |
| JitRL 的「去掉记忆、只留 logits 调制」消融臂 | 检索 §5.6 与 Table 8 | **不存在**（机制上不可构造） |
| JitRL Table 8 的完整五站点消融 | 检索 §5.6 | **只有 Admin/Reddit 两站** |
| AWM「多少条 workflow 后饱和/下降」 | 检索 §3、§4、Appendix C | **论文未做该实验**；最接近的是 Table 11 的「offline+online 非加性」 |
| JitRL 的第三方**复现**（非静态代码审阅）报告 | 只查了仓库 issues（4 条，其中 #4 为静态审阅） | **未找到真实复现报告**；未检索 Reddit/Twitter/博客（预算耗尽） |
| AWM 的第三方复现/批评 | 未检索 | **未覆盖**（预算耗尽） |
| JitRL 是否支持 Claude 的实际证据 | README 列出 claude-3.5-sonnet，但 WebArena README 示例与论文主实验均未用 Claude | **仅有 README 声明，无实验证据**（class: README，confidence: medium） |

### 未验证推测（明确标注，勿当结论）

- JitRL 的 greedily-rerank 变体在**指令遵循强的闭源大模型**上相对 prompt 注入的优势可能进一步收窄——作者本人在 issue #2 已作此表态（J25），但这是作者的**预期**而非测量结果。
- AWM 的全量注入在 workflow 数量线性增长后会撞上下文窗口上限，但我没有找到论文对此的讨论或实验。

---

## 5. 对「冻结权重 + 记忆库做策略迭代」这一命题的净判断

| 维度 | JitRL | AWM |
|---|---|---|
| 是否真的「策略迭代」 | **是，但退化为候选重排**。有显式的 V/Q/A 估计与加性更新规则，形式上对应 KL 正则策略改进的闭式解；受限于 API top-k，实际是 rerank | **否**。是 in-context 示例增强，属 prompt 工程 / 检索增强，无策略改进算子 |
| 记忆写入信号 | LLM Evaluator 的 step-wise reward → 折扣回报 G_t，**失败经验以负 advantage 入库** | LLM Evaluator 的**二值成功标签**，只收成功轨迹 |
| 检索 | Jaccard / BM25 词面匹配 + URL 硬过滤，k≈10，阈值随步数衰减 | 无检索，全量注入，7.3–7.4 条/示例 |
| 是否碰 logits | 论文：是（z'=z+βA）；代码：**碰的是概率分数，不是 logits** | 完全不碰 |
| 记忆淘汰 | 无（无限增长，作者视为特性） | 无（只增不减），但单条 workflow 更短 |
| 可迁移到闭源 API | **可以**（OpenRouter + top_logprobs / verbalized 降级） | 可以（纯 prompt） |
| 主要风险 | 论文-代码不一致（issue #4 未答复）；优势幅度依赖 backbone 与 prompt 基线强度 | 收益可能被更强的 prompt/上下文能力吸收；workflow 会误导动作选择（AF1 反降） |

---

## 6. 来源清单

| # | 来源 | URL / 路径 | 类型 | 日期 |
|---|---|---|---|---|
| S1 | JitRL README | https://github.com/liushiliushi/JitRL (README.md) | 仓库自述 | pushed 2026-09-22 |
| S2 | JitRL WebArena agent 源码 | WebArena/memory_agents/jitrl_agent.py（1450 行） | 源码 | commit 143d221 系 |
| S3 | JitRL cross-episode memory 源码 | WebArena/memory_agents/utils/cross_episode_memory.py（1200 行） | 源码 | 同上 |
| S4 | JitRL 论文 | arXiv:2601.18510v4（PDF，23+ 页含附录） | 论文 | v4 2026-09-27 |
| S5 | JitRL GitHub issues #1/#2/#4 | https://github.com/liushiliushi/JitRL/issues | issue | 2026-06-10 ~ 2026-10-17 |
| S6 | AWM README | https://github.com/zorazrw/agent-workflow-memory | 仓库自述 | pushed 2025-12-22 |
| S7 | AWM 论文 | arXiv:2409.07429v1（PDF） | 论文 | 2024-09-11 |
| S8 | AWM workflow 样例 | webarena/workflow/shopping.txt | 源码/数据 | — |

**仓库元数据**（accessed 2026-11-22）：JitRL 211 stars / 18 forks / 1 open issue / created 2026-01-25；AWM 487 stars / 52 forks / pushed 2025-12-22。
