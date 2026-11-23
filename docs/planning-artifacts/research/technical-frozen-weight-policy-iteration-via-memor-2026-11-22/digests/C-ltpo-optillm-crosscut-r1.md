# C — LTPO / OptiLLM / 横切：冻结权重下的策略迭代（r1）

- 研究者：researcher-c（深度研究员）
- accessed: 2026-11-22
- 预算说明：计划上限 8 个来源 / 20 次工具调用，实际略超（~9 个来源、~22 次调用）。超支部分用于把 LTPO 论文正文与源码对齐、以及核对 OpenAI/vLLM 的官方参数规范。**未做**：Anthropic 官方文档核对、ACE 的具体数字、MemRL 正文、SPL 插件实现。这些在 §6 gaps 中列明。
- 证据分级：`class` 一栏用 `一手-源码` / `一手-论文` / `一手-规范` / `一手-元数据` / `推断` 标注。

---

## 0. 一句话结论

- **LTPO 是"测试时把 10 个输入 embedding 当参数、用模型自身 top-k 置信度当 reward 做 REINFORCE"的纯白盒方法**：它的 reward 不是熵、不是 top-1 概率，而是"top-k 平均负对数概率"；它必须读 logits，因此在纯 API 客户端上**不可实现**，且论文只在 5 个数学数据集上验证，作者唯一承认的局限是"置信度 ≠ 正确性"，**没有讨论 agent/工具环境**。
- **OptiLLM 是一个不做 logits 干预的纯文本代理**：所有 20+ 技术都退化为"多次采样 + 拼接 prompt + 再选优"，它从不请求 logprobs，需要概率的技术（cot_decoding / entropy_decoding / autothink / deepconf）只对自带本地推理服务生效；核心代码**没有缓存、没有跨请求学习**。
- **横切层面已有的真实路线**：ExpeL / Reflexion / Voyager / Dynamic Cheatsheet / ACE / MemRL 全部真实存在且都是"冻结权重 + 文本记忆"，SEAL 是唯一改权重的反例。**没有找到**系统性量化比较 prompt 注入 vs 微调 vs logits 调制的综述；唯一可用的受控对比是 LTPO 论文 Table 2。

---

## 1. 发现表（claim / 证据 / publisher / pub_date / confidence / class）

### 1.1 LTPO（arXiv 2510.04182 + github.com/ltpo2025/LTPO）

| # | claim | 证据位置 | publisher | pub_date | conf | class |
|---|---|---|---|---|---|---|
| L1 | "隐式 thought 向量"**不是** hidden state，而是**占位 token 经 embedding 层得到的输入向量** `e_i = Embed([THINK])`，维度 = d_model；默认 **10 个** token 位置，插在 user prompt 末尾、assistant 生成提示之前 | 论文 §3.1 式(1)（"Their initial embedding vectors … are obtained by passing the placeholder tokens (e.g., [THINK]) through the model's embedding layer"）；源码 `ltpo.py` `build_inputs()` L13–L40（llama→`<|reserved_special_token_i|>`，qwen→`<|endoftext|>`，mistral→`<unk>`），`main.py` `--num_thought_tokens` 默认 10 | arXiv / GitHub ltpo2025 | 2025-10-05 / repo HEAD | high | 一手-论文+源码 |
| L2 | 优化变量**只有这 10×d_model 个数**，模型权重冻结（`model.eval()`，无任何 weight optimizer） | `ltpo.py` `generate()` L~170–200：`torch.nn.Parameter(inputs_embeds[...].clone().detach().requires_grad_(True))`，`optimizer = Adam([thought_hidden_states], ...)`；`main.py` L~95 `model.eval()` | 同上 | 同 | high | 一手-源码 |
| L3 | reward = **top-k 平均负对数概率**，再对 thought 位置取平均。**既不是熵，也不是 top-1 概率**；默认 k=10 | 论文 §3.2 式(4)(5)；源码 `ltpo.py` `get_confidence()` L~120–L140：`probs=softmax(logits)`；`topk=torch.topk(probs[idx], k=k)`；`confidence -= sum(log(topk+1e-10))/k`；再 `/num_tokens` | 同上 | 同 | high | 一手-源码 |
| L4 | 更新式是**高斯平滑的 score-function 估计（REINFORCE 家族）**：`θ ← θ + lr · R(θ+ε) · ε/σ²`，`ε~N(0,σ²I)`；单样本、无 baseline、σ 每步 ×0.99 | 论文 §3.2 式(2)(7)(8)(9)(10)（"For our Gaussian policy … the log-probability gradient term can be simplified"）；源码 `ltpo.py` L~205–L218：`epsilon=torch.normal(0,sigma,...)`；`grad_ascent = lr * reward * epsilon / sigma**2`；`thought_hidden_states += grad_ascent`；`sigma *= sigma_decay`（默认 0.1、0.99） | 同上 | 同 | high | 一手-论文+源码 |
| L5 | **代码默认走 REINFORCE 路径，但仓库另有一条反向传播路径**：`--use_auto_grad` 打开时直接对 reward 调 `backward()` 穿过冻结模型更新 embedding。这**与论文"reward 对输入不可微、故必须用策略梯度"的说法矛盾**——置信度 reward 对 inputs_embeds 实际是可微的 | `main.py` `--use_auto_grad`（`action="store_true"`，默认 False）；`ltpo.py` L~196–L204 `reward.requires_grad_(True); reward.backward(retain_graph=True)`；论文 §3.2 "Since the reward function is non-differentiable with respect to the input latent vectors, we cannot use standard backpropagation" | 同上 | 同 | high | 一手-源码（与论文口径冲突，属"论文说法过强"） |
| L6 | 备用 reward：`--disable_conf_reward` 时改用一个**LLM-as-judge 打分器**（把 soft token 塞进 prompt，要求输出 0–1 分，格式 `THE SCORE IS: x`）——即 VERA 式自评 | `reward.py` L1–L75（`VERA_ANSWER_SYMBOL = "THE SCORE IS:"`；`get_reward()` 替换 `inputs_embeds[start:end]` 后 `model.generate`，`extract_score()` 正则解析） | 同上 | 同 | high | 一手-源码 |
| L7 | 评测**只在数学推理**：GSM8K / MATH-500 / ASDiv-Aug / AIME2024 / AIME2025；4 个模型（LLaMA-3.1-8B、LLaMA-3.2-3B、Qwen-2.5-7B、Qwen-3-14B）。无 agent、工具、检索、多轮环境 | 论文 §4.1 Datasets；Table 1 | 同上 | 同 | high | 一手-论文 |
| L8 | 主结果（accuracy %）：LLaMA-3.1-8B 平均 48.66 vs Zero-Shot CoT 42.35（**+6.31**）、CoT-Unk 45.94、SoftCoT 41.55；AIME2024 16.67 vs CoT 6.67；AIME2025 6.67 vs 0.00 | 论文 Table 1 | 同上 | 同 | high | 一手-论文 |
| L9 | Qwen-2.5-7B：平均 56.79 vs CoT 54.53（+2.26）、SoftCoT 47.88（**+8.91**）；AIME2024 **16.67** vs CoT 10.00；AIME2025 **13.33** vs 10.00。SoftCoT 在 AIME24/25 全模型 **0.00%**（作者归因于其静态投影在 GSM8K 上训练、OOD 崩溃） | 论文 Table 1、§4.2 | 同上 | 同 | high | 一手-论文 |
| L10 | 与"要训练"的方法对比（LLaMA-3.1-8B，GSM8K / MATH-500 / AIME2024）：LTPO(不训练) 81.27/49.00/16.67 vs Genius(训练) 78.09/47.60/3.33 vs SimpleRL-Zoo(训练) 79.20/23.00/0.00 vs SoftCoT(训练) 80.36/39.80/0.00 | 论文 Table 2、§4.3 | 同上 | 同 | high | 一手-论文（**唯一可用的"冻结 vs 微调"受控对比**） |
| L11 | 推理耗时（LLaMA-3.1-8B，秒/题，3 次平均）：LTPO 平均 **20.79** < SoftCoT 22.32 < Zero-Shot CoT 41.33；理由是优化循环里是"定长输入的一次 forward 算 reward"，不做自回归解码 | 论文 Table 3、§4.4 | 同上 | 同 | high | 一手-论文（**注**：正文该句的步数数值在 HTML 抽取中丢失，未取到） |
| L12 | 消融：thought token 数 1→16 性能稳定（SoftCoT >4 就崩）；用"best reward 那一步"的向量优于最后一步（轨迹非单调）；top-k 的 k 从 5 到 100，LLaMA-3.1 准确率只变 88.63–89.11（<0.5pp），最优 k 偏小 | 论文 §4.5.1–4.5.3、Table 4、Figure 2 | 同上 | 同 | high | 一手-论文 |
| L13 | 作者承认的唯一局限：**置信度与正确性会背离**（"confidently incorrect"），给出 qualitative 例：错误解 reward 6.375 > 正确解 4.781，并用 Theorem B.1（梯度需正相关）/B.2（置信度局部极大但正确性低的"陷阱"）形式化 | 论文 Appendix B（B.1 例、B.2 定理）；§3.2 末段亦承认 | 同上 | 同 | high | 一手-论文 |
| L14 | 作者**没有**讨论"能否用于 agent/环境交互"，也没有把稀疏的外部 verifier reward 接进来；只提 future work 是"incorporating uncertainty estimation or other signals" | 论文 Appendix B.1 末句；全文（§1–§5 + Appendix A–D）无 agent/tool/env 章节 | 同上 | 同 | high（"没讨论"是可核验的缺失） | 一手-论文 |
| L15 | 方法**结构性依赖 logits**：reward 需要 `model(**inputs)['logits']` 全量 forward | `ltpo.py` `get_confidence()` L~124：`logits = model(**inputs, return_dict=True)['logits'][0]` | GitHub | HEAD | high | 一手-源码 |

### 1.2 OptiLLM（github.com/algorithmicsuperintelligence/optillm）

| # | claim | 证据位置 | publisher | pub_date | conf | class |
|---|---|---|---|---|---|---|
| O1 | 架构 = OpenAI 兼容的 FastAPI 代理（`/v1/chat/completions`），转发到任意 OpenAI 兼容 `base_url`；自己**不持有模型**（除非启用内置本地推理服务） | README "How requests flow"；`server.py` 全篇 | GitHub optillm | HEAD | high | 一手-源码+README |
| O2 | 技术选择**不是自动路由**：服务端 `--approach` 默认 `"auto"`（`server.py` L1267），auto 的含义是"看请求里带没带指示"，没有基于题目难度的分类器 | `server.py` L1267 `("--approach", ..., "auto", ...)` | 同上 | 同 | high | 一手-源码 |
| O3 | 三条选择通道：① model 名前缀（`moa-gpt-4o-mini`）② `extra_body={"optillm_approach": ...}` ③ prompt 里的 `<optillm_approach>tag</optillm_approach>`；另支持 `&`（串行流水线）与 `|`（并行）组合 | README "Selecting a technique" / "Combining techniques"；`server.py` `parse_combined_approach()` L381–L413 | 同上 | 同 | high | 一手-README+源码 |
| O4 | **优先级在代码里与 README 不一致**：代码是"prompt tag 覆盖请求字段、请求字段覆盖服务端默认值"（L874 取 body → L885–889 tag 优先 → L891 再拼 model 前缀）；README 却写"1 模型名前缀 2 extra_body 3 prompt tag"。按代码为准 | `server.py` L874 `optillm_approach = data.get('optillm_approach', server_config['approach'])`；L888–889 `if message_optillm_approach: optillm_approach = ...`；L891–892 `if optillm_approach != "auto": model = f"{optillm_approach}-{model}"` | 同上 | 同 | high（冲突本身可核验） | 一手-源码（README 说法存疑） |
| O5 | 已注册技术 20 个左右：`none, mcts, bon, moa, rto, z3, self_consistency, pvg, rstar, cot_reflection, plansearch, leap, re2, cepo, mars` + 插件 `spl, deepthink, longcepo` 等 + 仅本地 `deepconf, cot_decoding, entropy_decoding, thinkdeeper, autothink` | `server.py` L204–L205 `known_approaches = [...]`；README "Techniques" 表 | 同上 | 同 | high | 一手-源码 |
| O6 | **MoA 实现是"3 采样 → 1 次批评 → 1 次合成"的三段式，不是论文里的多层多 agent MoA**：先 `n=3, temperature=1` 拿 3 个候选，再用一条 prompt 让模型一次批评三者（`temperature=0.1`），最后把 3 候选+批评一起喂回让模型写最终答案（`temperature=0.1`）。无分层、无 per-agent 不同 persona | `moa.py` L20–L31（n=3,temp=1）、L117–L145（critique prompt, temp 0.1）、L170–L203（final prompt, temp 0.1） | 同上 | 同 | high | 一手-源码 |
| O7 | **best-of-n 是 LLM 自评分选优**：`n` 个候选（temp=1），逐个让同一模型"0–10 打分、只回数字"，取最大分那条；解析失败按 0 分 | `bon.py` L7–L31（n, temp 1）、L101–L115（rating prompt "Rate ... 0 to 10 ... Respond with only a number", temp 0.1）、L133–L142 `best_index = ratings.index(max(ratings))` | 同上 | 同 | high | 一手-源码 |
| O8 | **self-consistency 是"字符串相似度聚类 + 频次投票"**：采样 5 条（temp=1），用 `difflib.SequenceMatcher().ratio() >= 0.8` 贪心聚类，输出簇内频次最高者；**不做答案抽取、不做语义等价判断** | `self_consistency.py` L10（num_samples=5, threshold=0.8）、L23–L53（循环采样）、L55–L69（聚类）、L71–L80（按 frequency 汇总） | 同上 | 同 | high | 一手-源码 |
| O9 | **不请求 logprobs**：整个 OpenAI 兼容链路里 logprobs 只出现在"把上游响应原样透传"的位置，没有任何技术读取或使用它 | `server.py` L1156 `'logprobs': choice.get('logprobs')`、L1171 `'logprobs': None`；全文件 grep `logprob` 仅此 2 处 | 同上 | 同 | high | 一手-源码 |
| O10 | 需要概率/连续空间的技术**只对内置本地推理服务**生效，因为它们直接操作 torch logits：如 cot_decoding 里 `calculate_confidence(logits, answer_ids)` 接收的是 `List[torch.Tensor]`；README 明确标注 Deep Confidence / CoT Decoding / Entropy Decoding / Thinkdeeper / AutoThink 为 "Local only" | `cot_decoding.py` L6–L52（`import torch`、`def calculate_confidence(logits: List[torch.Tensor], ...)`）；README Techniques 表 "Local only" 列；README Providers 表（OptiLLM 内置服务 "supports logprobs and decoding techniques"） | 同上 | 同 | high | 一手-源码+README |
| O11 | **核心没有缓存、没有跨请求学习**：server.py 中无 cache/kv/经验存储逻辑；`conversation_logger` 只是把每次 provider 调用写日志用于排查。README 的 "System Prompt Learning (spl)" 插件声称能跨请求积累策略，但仓库里 `optillm/plugins/spl/__init__.py` 仅 7 行占位（未实现），**本次未验证其真实实现** | `server.py` 全文 grep `cache|Cache|stats|lru|persist` 无命中；`spl/__init__.py` 7 行 docstring | 同上 | 同 | medium（spl 部分未验证） | 一手-源码 |
| O12 | 仓库自述的收益数字（**营销口吻，按仓库自述处理，非论文**）：MARS on Gemini-2.5-Flash-Lite AIME2025 43.3→73.3（+30.0）；CePO Llama-3.3-70B Math-L5 51.0→69.6（+18.6）；PlanSearch GPT-4o-mini LiveCodeBench pass@5 +20%；MoA GPT-4o-mini "matches GPT-4" on Arena-Hard-Auto | README "Results" 表 | 同上 | HEAD | low（无出处、无评测协议） | 一手-README（自述/营销，需谨慎） |

### 1.3 横切：冻结权重 + 记忆的代表工作

| # | 名称 | 是否真实存在 | 一句话机制 | 证据 | pub_date | conf |
|---|---|---|---|---|---|---|
| X1 | **ExpeL** | 是，arXiv 2308.10144 | 在训练任务上自主收集轨迹，跨任务抽取自然语言"insight"存入经验池；推理时检索相似经验注入 prompt，**权重不动**；明确针对"GPT-4/Claude 只有 API、权重不可得"的场景 | arXiv abs 页 `citation_title`="ExpeL: LLM Agents Are Experiential Learners" + abstract | 2023-08-20 | high |
| X2 | **Reflexion** | 是，arXiv 2303.11366 | 用语言化反馈（标量或自由文本）做"言语强化"：把反思文本写进 episodic memory buffer，下一次试验时读入，**不更新权重** | arXiv abs 页 abstract："not by updating weights, but instead through linguistic feedback … maintain their own reflective text in an episodic memory buffer" | 2023-03-20 | high |
| X3 | **Voyager**（技能库） | 是，arXiv 2305.16291 | Minecraft 终身学习：自动课程 + **可执行代码技能库**（存/取复杂行为）+ 迭代 prompting（环境反馈/执行错误/自验证改程序）；全程 GPT-4 黑盒调用，**bypass 参数微调** | arXiv abs 页 abstract 三条组件原文 | 2023-05-25 | high |
| X4 | **Dynamic Cheatsheet** | 是，arXiv 2504.07952 | 给黑盒 LM 一个**持久、演化的记忆**：把策略/代码片段/解题洞见存起来跨题复用，无需 ground-truth 标签或人工反馈 | arXiv abs 页 abstract | 2025-04-10 | high |
| X5 | **ACE (Agentic Context Engineering)** | 是，arXiv 2510.04618 | 把 context 当"演化 playbook"，用 **generation → reflection → curation** 的模块化流程增量维护；针对 brevity bias 与 context collapse 两个失效模式；离线（system prompt）与在线（agent memory）都适用 | arXiv abs 页 abstract | 2025-10-06 | high |
| X6 | **MemRL** | 是，arXiv 2601.03192（v2） | 标题级机制：**在 episodic memory 上做 runtime RL 的自演化 agent**。正文未读，具体 reward/更新式未验证 | arXiv API `search_query=all:MemRL` 返回 entry 1：title + id + published | 2026-01-06 | medium（仅标题/存在性） |
| X7 | **SEAL (Self-Adapting LLMs)**——反例 | 是，arXiv 2506.10943 | 模型自己生成"self-edit"（改写知识、指定超参、造数据），再 **SFT 产生持久权重更新**；用更新后模型的下游表现做 RL reward 来训练"怎么自我编辑"。**这条会改权重** | arXiv abs 页 abstract | 2025-06-12 | high |

### 1.4 纯 API 客户端能用的输出分布干预手段（G5）

| 手段 | 真实可用性 | 限制 | 证据 |
|---|---|---|---|
| `logit_bias` | OpenAI 官方参数存在：token-id → [-100, 100] 的 map，"bias is added to the logits generated by the model prior to sampling"；-100/100 近似禁用/独选 | 需要 **tokenizer 的 token id**，且是 per-model 的；只能改"指定 token 的相对倾向"，无法做 top-k 重排；很多兼容实现不支持 | OpenAI OpenAPI spec（openai/openai-openapi master `openapi.yaml`）L46333–L46362 |
| `logprobs` + `top_logprobs` | OpenAI 支持：`logprobs: true` 返回输出 token 的 log 概率；`top_logprobs` 取 0–20，"每个位置返回最多 N 个最可能 token 的 log 概率"，且必须 `logprobs=true` | **只能读、不能写**：拿到的是"已采样 token + 每位置 top-N 候选"，不能强制模型选某个候选；实际返回数可能少于请求数 | 同上 L46218–L46235、L46363–L46375 |
| `n` 多候选 | 官方 spec 里 `n: 1..128`；"Newer models reject an explicit `n`, even `n=1`" | 新模型直接拒绝显式 n；且按所有候选计费 | 同上 L46388–L46399 |
| `seed` | 存在但**已标记 deprecated**，"our system will make a best effort" | 只是 best-effort，不保证可复现 | 同上 L46409–L46420 |
| `temperature` / `top_p` / `top_k` / `min_p` | vLLM 的 `SamplingParams` 全支持：`temperature`(1.0)、`top_k`(0)、`min_p`(0.0)、`seed` | OpenAI 官方只暴露 temperature/top_p；top_k/min_p 是 vLLM 侧参数，走 OpenAI 兼容 API 时通常不透传 | vLLM `vllm/sampling_params.py` L308/L318/L321/L325（字段与默认值） |
| 服务端 token 级约束 | vLLM 有 `allowed_token_ids: list[int]`（"only retains scores for the given token ids"）与 `structured_outputs`（JSON schema/grammar） | 属于服务端能力；纯 API 客户端只能依赖厂商是否暴露（OpenAI 的 structured outputs 本次未核验） | vLLM 同上 L414–L430 |
| 概率类"技术"（CoT-decoding / entropy-decoding / autothink） | **不可用**：它们直接吃 torch logits | 见 O10 | OptiLLM `cot_decoding.py` L6–L52 |

> 结论（G5）：纯 API 客户端真正能"改分布"的只有 `logit_bias`（需 token id，粒度粗）+ `temperature/top_p`（只调形状，不调方向）；`logprobs` 只提供**观测**能力（可用于重排、置信度估计、拒绝采样），不提供**控制**能力。要"重排"只能靠重新请求（n 或循环采样）而不是改分布。

---

## 2. 机制闭环（状态 / 记忆 / 检索 / 打分 / 作用到输出）

### 2.1 LTPO —— "把 10 个 embedding 当成 per-instance 的可训练参数"

- **状态怎么表示**：`θ ∈ R^{10 × d_model}`，物理上就是 prompt 尾部 10 个位置的 `inputs_embeds`。它不是某一层的 hidden state（论文式(1) 明确由 embedding 层给出），但**在计算上等价于**"把 hidden vector 直接当输入喂回去"，所以源码里变量名叫 `thought_hidden_states`（`ltpo.py` L~175）。初始化 = 占位 token 的 embedding；对 LLaMA 用 `<|reserved_special_token_i|>`、Qwen 用 `<|endoftext|>`、Mistral 用 `<unk>`。
- **记忆存什么**：**没有跨题记忆**。每个问题独立优化 10 步，优化完就丢弃；不写任何经验库。这是它与 §1.3 那批"记忆型"工作的根本区别。
- **怎么检索**：无检索。
- **怎么打分**：一次 full forward（prompt+θ 定长），取 10 个 thought 位置的 logits → softmax → 每位置取 top-k(=10) 概率 → 每个位置算 `-(1/k)Σ log p` → 10 个位置再平均。分值恒 ≥0，越大越"自信"。
- **怎么作用到输出**：把最优那一步的 θ 写回 `inputs_embeds`，然后**只解码一次**（greedy），得到最终答案。
- **闭环性质**：这是一个**单实例、无记忆、纯 exploit 的 bandit**——用 `R·ε/σ²` 做梯度，σ 单调衰减到接近 0，10 步后收敛；没有 baseline、没有 advantage、没有 value 函数，因此**方差全压在单个样本的 reward 上**（这也是它只能用"密集的置信度"而不能用"0/1 正确率"的原因）。

### 2.2 OptiLLM —— "把推理时算力包装成 OpenAI 兼容 API 的文本编排器"

- **状态怎么表示**：无内部状态。状态 = 请求里的 messages + 服务端配置（`server_config['approach']`、`n`、`base_url`）。
- **记忆存什么**：只有 `conversation_logger` 的磁盘日志（用于 debug），**不参与后续请求**。
- **怎么检索**：无。
- **怎么打分**：全部用"再问一次模型"代替：best-of-n 用 0–10 自评分（`bon.py` L101–L142）；MoA 用一次 critique 调用（`moa.py` L117–L167）；self-consistency 用字符串相似度聚类频次（`self_consistency.py` L55–L80）。**没有一处使用概率**。
- **怎么作用到输出**：拼 prompt / 多采样 / 选一条返回。对模型内部**零干预**。
- **闭环性质**：开环。同一个请求重复 100 次，行为完全一致（除采样随机性）；不存在"越用越强"。

### 2.3 横切那一批（作为对照的"另一种闭环"）

- **状态**：自然语言经验（ExpeL insight 池、Reflexion 反思 buffer、Voyager 代码技能库、DC cheatsheet、ACE playbook）。
- **写入**：任务结束后由模型自己总结/反思写入（ACE 还加了 curation 防 context collapse）。
- **检索**：相似度检索 top-k 注入 prompt（ExpeL）、或直接全量拼进上下文（DC/ACE 的 playbook）。
- **打分**：多数**没有显式打分**——靠"检索相似度"或"全量塞进去"；ACE 的 curation 用 LLM 自己判断该保留/合并哪条。**这正是 LTPO 的置信度打分可以补位的地方**（见 §4）。
- **作用到输出**：改 prompt（in-context），不改权重、不碰 logits。

---

## 3. 关键数字汇总（并标注来源性质）

| 数字 | 值 | 来源 | 性质 |
|---|---|---|---|
| LTPO vs Zero-Shot CoT（LLaMA-3.1-8B 平均） | 48.66 vs 42.35（+6.31） | 论文 Table 1 | 同行评审前 preprint（ICLR 2026 投稿，OpenReview id r1WEQzkCQv） |
| LTPO vs SoftCoT（Qwen-2.5-7B 平均） | 56.79 vs 47.88（+8.91） | 论文 Table 1 | 同上 |
| LTPO AIME2024（Qwen-2.5-7B） | 16.67 vs CoT 10.00；SoftCoT 0.00 | 论文 Table 1 | 同上；n 很小（AIME 30 题，1 题=3.33pp），**统计意义弱** |
| LTPO 不训练 vs Genius/SimpleRL-Zoo 训练（AIME2024） | 16.67 vs 3.33 / 0.00 | 论文 Table 2 | 同上 |
| LTPO 平均耗时 | 20.79s vs CoT 41.33s | 论文 Table 3 | 同上；单卡 A100 级，3 次平均 |
| top-k 敏感性 | k=5..100 准确率 88.63–89.11（<0.5pp） | 论文 Table 4 | 同上 |
| Dynamic Cheatsheet：Claude 3.5 Sonnet AIME | "accuracy more than doubled" | arXiv 2504.07952 abstract | 摘要级，无具体绝对值 |
| Dynamic Cheatsheet：GPT-4o Game of 24 | 10% → 99% | 同上 | 摘要级 |
| OptiLLM 自述：MARS AIME2025 | 43.3 → 73.3 | README Results | **仓库自述、营销语气、无协议**，low |
| OptiLLM 自述：CePO Math-L5 | 51.0 → 69.6 | README Results | 同上 |

**关于"prompt 注入 vs 参数微调 vs logits 调制"的量级差距**：本轮**没有找到**系统性综述或统一 benchmark 给出三者可比数字。唯一可引的受控对比是 LTPO Table 2（冻结+测试时优化 vs 全参微调，在 GSM8K/MATH-500/AIME24 上互有胜负，AIME 上冻结侧反而更高）。**这是一个明确的 gap**（见 §6）。

---

## 4. 可借鉴：置信度 / advantage 能不能搬到"检索到的案例打分"

这一节是**我的分析（class=推断）**，不是检索到的结论，明确标注以便与上面的证据区分。

1. **LTPO 的 reward 本质是"给定前缀，模型对下一个 token 有多确定"**。把它搬到检索场景，最自然的映射不是给"案例"打分，而是给**"案例插入后的上下文"打分**：把候选案例 c 拼进 prompt，取案例末尾位置的 top-k 平均负对数概率作为 `conf(c)`。
2. **但它有一个致命偏差**：`conf` 高的案例往往是"和 query 风格最像、最容易被模型预测"的案例，而不是"最有信息量"的案例——这与 LTPO Appendix B 的 "confidently incorrect" 同源。直接 maximization 会退化成"选最平庸的案例"。
3. **更稳的写法是把 conf 当 baseline 而不是 reward**：用 `A(c) = conf(c) - conf(∅)`（相对"不插案例"的置信度增益）作为 advantage，只保留 `A(c) > 0` 的案例并按 A 排序。这等价于"案例带来的信息增益"，且天然抵消了"风格相似"这一 confound。**这是 LTPO 的 REINFORCE 骨架（无 baseline）缺失的部分**。
4. **可执行的打分器（纯 API 也能做）**：`logprobs=true, top_logprobs=20` 拿到插入案例后答案段的每 token log 概率，取平均 → 这就是 API 版的 `conf`；再用 `A = mean_logp(with case) - mean_logp(without case)` 做对照。**成本 = 每个候选案例一次额外请求**，不需要 logit_bias，也不需要白盒。
5. **注意**：LTPO 的 top-k 形式在 API 上只能近似——OpenAI 返回的是"每位置的 top-N 候选"，N≤20，且只对**已生成**的 token 给出（不是对"thought 位置"）。所以 API 版只能算"答案段的平均 logprob"，拿不到"thought 位置的置信度"。这是白盒/黑盒的真实分界。

---

## 5. 每条目的"机制闭环"一句话版

- **LTPO**：状态=10 个输入 embedding；无记忆；无检索；打分=top-k 负对数概率；作用=改写输入序列 → 一次解码。
- **OptiLLM**：状态=请求；无记忆；无检索；打分=再问模型（自评分/批评/字符串相似度）；作用=拼 prompt + 多采样。
- **ExpeL/Reflexion/Voyager/DC/ACE**：状态=自然语言经验库；写入=任务后自反思；检索=相似度或全量；打分=多无显式打分；作用=改 prompt。
- **SEAL（反例）**：状态=权重；写入=SFT；检索=无；打分=下游表现；作用=改参数。

---

## 6. gaps：找过但没找到 / 没来得及看

1. **"prompt 注入 vs 参数微调 vs logits 调制"的系统性量化比较**：没有找到综述或统一 benchmark。检索工具（web_search）两次 60s 超时，未能做宽口径检索；只有 LTPO Table 2 这一条受控对比。**这是本轮最大的空白**。
2. **LTPO 是否在 agent 任务上试过**：论文全文（含 Appendix A–D）无 agent/tool/多轮环境章节；作者只承认"置信度≠正确性"。作者**没有**讨论"每步一次完整 forward"在 agent 里会爆炸的问题——这个批评是我方推断，不是作者观点。
3. **LTPO 论文 Table 3 里 LTPO 的优化步数**：HTML 抽取丢失（显示为 "LTPO ( )"），未取到具体值。
4. **Anthropic API 的 logprobs/logit_bias 支持情况**：未核验官方文档（预算原因），不做断言。
5. **OpenAI structured outputs / 工具调用约束的官方规范**：本次只核验了 vLLM 的 `structured_outputs`/`allowed_token_ids`，OpenAI 侧未查。
6. **MemRL 正文**：只从 arXiv API 拿到标题与日期（2601.03192，2026-01-06），机制细节（reward 定义、更新式、是否改权重）未读，**不能引用其数字**。
7. **ACE 的具体提升数字**：只读到摘要"consistently outperforming strong baselines"，未取表。
8. **OptiLLM 的 SPL 插件**：`optillm/plugins/spl/__init__.py` 仅 7 行占位，无法确认"跨请求学习"是否真实实现；README 的宣称与代码不符，需追 issue/其他分支。
9. **PlanSearch / RStar / ReRead 的实现细节**：只读了 README 描述与文件存在性，未逐行读源码（预算原因）。README 对其描述分别是"search over candidate plans"、"R* algorithm"、"process queries twice"。
10. **OptiLLM 的 stars 数**：用户给的是 4344，本轮未用 `gh repo view --json stargazerCount` 复核。

---

## 7. leads（值得追）

- **L1+L14 的组合**：LTPO 的"每步一次定长 forward"在 agent 里可以改成"每个工具调用后对下一步 action 的置信度打分"，但那需要 logits → 只有本地部署可行。**做纯 API 版就必须换成 §4.4 的 logprobs 近似**。
- **L5 的矛盾值得追**：如果 reward 可微，那么"冻结权重的梯度上升"其实等价于 **prompt tuning / LatentSeek**，LTPO 的"policy gradient"卖点就被削弱。查 LatentSeek（README 致谢里点名）与 SoftCoT 的做法可以直接对照。
- **O11 + X4/X5 的对照**：OptiLLM 没有记忆，Dynamic Cheatsheet/ACE 有；把 DC/ACE 的记忆层套在 OptiLLM 的代理层上，是"纯 API 也能做策略迭代"的最短路径。
- **O5 的技术清单里 `cepo`（Cerebras Planning and Optimization）** 是唯一明确组合了 best-of-N + CoT + self-reflection + self-improvement 的，与 LTPO 的"自评 reward"最接近，值得单独读 `optillm/cepo/`。
- **X6 MemRL 的标题**（"runtime RL on episodic memory"）几乎是"LTPO 的 reward 思路 + 记忆"的合体，若正文确认它用 Q 值/advantage 对记忆条目排序，就是本主题最直接的先行工作。

---

## 8. 引用清单（可点开核对）

- LTPO 论文：https://arxiv.org/abs/2510.04182 （HTML: https://arxiv.org/html/2510.04182v1）
- LTPO 源码：https://github.com/ltpo2025/LTPO/blob/main/ltpo.py 、`main.py` 、`reward.py`
- OptiLLM：https://github.com/algorithmicsuperintelligence/optillm （README、`optillm/server.py`、`optillm/moa.py`、`optillm/bon.py`、`optillm/self_consistency.py`、`optillm/cot_decoding.py`）
- OpenAI OpenAPI spec：https://github.com/openai/openai-openapi/blob/master/openapi.yaml
- vLLM SamplingParams：https://github.com/vllm-project/vllm/blob/main/vllm/sampling_params.py
- ExpeL https://arxiv.org/abs/2308.10144 ｜ Reflexion https://arxiv.org/abs/2303.11366 ｜ Voyager https://arxiv.org/abs/2305.16291 ｜ Dynamic Cheatsheet https://arxiv.org/abs/2504.07952 ｜ ACE https://arxiv.org/abs/2510.04618 ｜ MemRL https://arxiv.org/abs/2601.03192 ｜ SEAL https://arxiv.org/abs/2506.10943
