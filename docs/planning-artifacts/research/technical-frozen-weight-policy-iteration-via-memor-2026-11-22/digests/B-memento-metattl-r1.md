# B · Memento / Memento-Skills / Meta-TTL — 冻结权重下的案例库策略迭代（r1）

- 检索与核对时间：accessed=2026-11-22（Asia/Shanghai）
- 来源：5 个一手来源（Memento 仓库源码+README、Memento 论文 arXiv 2508.16153v2、Memento-Skills 仓库源码+README、Memento-Skills 论文 arXiv 2603.18743v1 摘要、meta-ttl 仓库源码+README）。预算上限 8 个来源 / 20 次工具调用，实际 5 个来源 / 约 20 次。
- 未读来源已在 §6 Gaps 显式列出；凡未取到证据的判断均标注「未验证推测」。

## 0. 核心结论：这三个系统「迭代的到底是什么对象」

三者的记忆都是自然语言，但被迭代的对象完全不同，这是本次研究最关键的一条：

| 项目 | 迭代对象 | 是否改 prompt 模板 | 是否有梯度 | 选择/接受机制 |
| --- | --- | --- | --- | --- |
| Memento | **案例库内容**（question → plan 文本 + reward 标号） | 否，`META_SYSTEM_PROMPT` 是常量 | 否（LLM 冻结）；参数化变体只训练一个小的**检索交叉编码器** | 检索 top-k 后按 reward 拆正/负例直接进 prompt，无接受/拒绝 |
| Memento-Skills | **技能库**（磁盘上的 SKILL.md + 脚本文件），以及每个技能的 utility 计数 | 演化用 prompt 是模板常量；被改写的是**技能文件本身** | 否 | 失败归因到单个技能 → 重写 → 合成测试 + judge 打分取最优 → 通过才原子部署 |
| Meta-TTL | **一个 meta-prompt 文本**（`best_prompt.txt`） | 是，这就是被优化的对象 | 否（reflective 优化，非梯度） | 同一验证集上按任务 z-score 均值比较 + accept_margin，接受或保留原策略 |

一句话：**Memento 迭代「经验条目」，Memento-Skills 迭代「可执行技能件」，Meta-TTL 迭代「一条指令」**。前两者的「策略」隐含在检索到的文本里，只有 Meta-TTL 把策略显式写成一个可版本化、可 A/B 的文本对象。

## 1. 发现表（claim / 证据 / publisher / pub_date / accessed / confidence / class）

> class：源码=仓库第一手代码；论文=arXiv 第一手；README=仓库第一手文档；推断=本文分析。

| # | claim | 证据位置 | publisher | pub_date | confidence | class |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | 案例库条目只有三个字段：`{question, plan, reward}`，**不含**轨迹、反思、工具调用序列 | `client/no_parametric_cbr.py:591-597` | Memento-Teams/Memento | 仓库 pushed 2025-10-05 | high | 源码 |
| F2 | 完整轨迹（MetaCycle / ExecStep / ToolCallRecord / QueryRecord）确实被采集，但只写入 `../result/result_round_0.jsonl`，**不进入案例库** | `client/no_parametric_cbr.py:283-312`（结构体）、`474-482`（构造）、`579-581`（写 result） | 同上 | 同上 | high | 源码 |
| F3 | 论文把案例定义为 `(s_t, a_t, r_t)`，写入是集合追加：`Write(s_t,a_t,r_t,M_t)=M_{t+1}=M_t ∪ {(s_t,a_t,r_t)}`；`s_t` 用**冻结文本编码器**编码，`a_t`/`r_t` 保留原样 | 论文 eq.(12) 及 Memory Storage 段 | arXiv 2508.16153v2 | 2025-08-22 首发 / 2025-08-25 v2 | high | 论文 |
| F4 | 非参数检索：句向量 + 余弦相似度 top-k。模型 `princeton-nlp/sup-simcse-bert-base-uncased`，`MEMORY_TOP_K` 默认 **8**（`np_memory.py` 内部默认 5），返回 `{rank, score, question, plan, line_index}` | `memory/np_memory.py:38-62, 65-101`；`client/no_parametric_cbr.py:108, 114-115` | Memento-Teams/Memento | 2025-10-05 | high | 源码 |
| F5 | 参数化检索：交叉编码器二分类，`softmax(logits)[:,1]` 作为匹配概率，对**全库**逐条打分后排序取 top-k | `memory/parametric_memory.py:10-46` | 同上 | 2025-10-05 | high | 源码 |
| F6 | 检索结果的用法：按 `reward==1` 拆成 Positive / Negative 两组，正例渲染成「id. description」的计划步骤，负例渲染原始 plan 文本，末尾固定指令「Focus on the positive examples and avoid the patterns shown in negative examples」 | `client/no_parametric_cbr.py:131-172` | 同上 | 2025-10-05 | high | 源码 |
| F7 | 注入方式：这段记忆文本作为**一条 user 消息**插在原始问题之后、planner 首轮之前（不是改 system prompt） | `client/no_parametric_cbr.py:403-410` | 同上 | 2025-10-05 | high | 源码 |
| F8 | reward 回写：`gpt-4o-mini` 当 judge，对比预测与 ground-truth 列表，输出 correct/incorrect → 1/0 | `client/no_parametric_cbr.py:38-56, 504-527, 564-565` | 同上 | 2025-10-05 | high | 源码 |
| F9 | 写入时机：每题结束后**无条件 append**，成功与失败都写；无去重、无合并、无淘汰、无质量阈值；写完重新加载整个 JSONL | `client/no_parametric_cbr.py:587-606` | 同上 | 2025-10-05 | high | 源码 |
| F10 | 参数化变体的写入多了一步：把「本轮检索到的案例 + 最终对错」写成 pairwise 训练数据（`save_training_data`），条目字段为 `{case, case_label, plan}` | `client/parametric_memory_cbr.py:418-438` | 同上 | 2025-10-05 | high | 源码 |
| F11 | planner 上下文 = system + 共享历史（含记忆文本、历次计划、executor 结果）；executor 上下文 = system + **同一份共享历史** + 当前子任务描述；`MAX_CYCLES=3`，每轮任务执行完重规划一次 | `client/no_parametric_cbr.py:318, 410, 440-442, 468` | 同上 | 2025-10-05 | high | 源码 |
| F12 | MCP 只覆盖工具层：客户端用 stdio 拉起 `server/*.py`（python）或 `.js` MCP server，把 MCP tool schema 转成 OpenAI function calling；planner/executor 双环是自研代码，不是 MCP | `client/agent.py:10-11, 169-183, 185-201, 237-246`；README:45-46 称 `server/ai_crawl.py`、SerpAPI 为 MCP | 同上 | 2025-10-05 | medium-high | 源码 |
| F13 | M-MDP 的组成：记忆增强 MDP + 神经案例选择策略；经验存于 episodic memory（可微分或非参数两种）；**策略更新走「记忆重写」，策略改进走「记忆读取（检索）」**；参数化设置下 Write 在线更新一个 Q-function 来塑形检索分布 | 论文 Abstract + Memory Read/Write 段（Appendix B 详述 Q-function） | arXiv 2508.16153v2 | 2025-08-22 | high | 论文 |
| F14 | GAIA validation 87.88%（Pass@3，榜上第一），test 79.40% | 论文 Table 2 | 同上 | 2025-08-22 | high | 论文 |
| F15 | 同表基线（val）：Alita 87.27、Skywork Super Agents 82.42、Langfun 79.39、AWorld 77.58、Manus 73.30、OpenAI DeepResearch 67.40、OWL-Workforce 69.09、Open Deep Research 55.15；（test）Su Zero Ultra 80.40、h2oGPTe v1.6.33 79.73、Memento 79.40 | 论文 Table 2 | 同上 | 2025-08-22 | high | 论文 |
| F16 | 分层看：val L1 96.23 / L2 90.70 / L3 61.54；test L1 90.32 / L2 75.47 / L3 71.43 —— Level 3 仍是短板 | 论文 Table 2 | 同上 | 2025-08-22 | high | 论文 |
| F17 | DeepResearcher 七数据集加权平均：Memento（GPT-4.1 + o4-mini）66.6 F1 / 80.4 PM，对比 training-based 的 DeepResearcher（Qwen2.5-7B）51.8 / 60.5 | 论文 Table 1 及表注 | 同上 | 2025-08-22 | high | 论文 |
| F18 | 案例库带来的增益：OOD 任务 **+4.7 到 +9.6 绝对点** | 论文 Abstract | 同上 | 2025-08-22 | high | 论文 |
| F19 | 消融设计了三档：static executor（无 planner/无记忆/无工具）、Online Executor（同 executor + 实时检索与 MCP 工具）、Memento (w/o CBR)（关闭 episodic memory） | 论文 §5.3 | 同上 | 2025-08-22 | high | 论文 |
| F20 | Memento-Skills 明说「研究配置保持 θ 冻结，把可复用行为存进外部 skill memory M」，架构是 Read–Execute–Reflect–Write | README:83, 92 | Memento-Teams/Memento-Skills | 仓库 pushed 2026-08-17 | high | README |
| F21 | 技能产物是**文件目录**（`SKILL.md` + 脚本，如 `builtin/skills/skill-creator/`），演化引擎直接读写技能目录里的文本文件并做整树替换 | `core/skill/evolution/engine.py:6-10, 607-653`；`builtin/skills/skill-creator/SKILL.md` | 同上 | 同上 | high | 源码 |
| F22 | 技能级统计：`record_outcome` 累计 success/failure，`utility = success/(success+failure)`；失败先归因到**一个**被用过的技能（`ATTRIBUTION_PROMPT` → `failure_mode`），再按 `REWRITE_PROMPT`/`DISCOVERY_REWRITE_PROMPT` 生成候选，合成测试 + judge 打分（0–1）取最优，成功才原子部署、失败保留原树 | `engine.py:153-176, 361-376, 409-467, 554-566, 736-752` | 同上 | 同上 | high | 源码 |
| F23 | 技能路由用 **BM25 + 语义向量混合检索** | README:245 | 同上 | 同上 | high | README |
| F24 | Memento-Skills 的评测只在 HLE 与 GAIA 上给了**曲线图**，正文无任何数字表，只说「多轮 reflective learning 后提升」 | README:291-310 | 同上 | 同上 | high | README |
| F25 | 存在配套论文《Memento-Skills: Let Agents Design Agents》arXiv 2603.18743v1（2026-03-19），摘要自述为「agent-designing agent：自主构建……」 | arXiv API 查询结果 | arXiv | 2026-03-19 | high | 论文(摘要) |
| F26 | Meta-TTL 的双层：外层在**任务间**学一个 meta-prompt；内层 TTL 里 meta-agent 读 actor 上一次尝试并写下一轮 guidance，**actor 每 episode 重置，guidance 是唯一跨 episode 载体** | README:5-8, 10-17 | zzzlou/meta-ttl | 仓库 pushed 2026-09-26 | high | README |
| F27 | BIS 的实际实现：先把 current 与 proposal 放到**同一验证集**上打分，用 `TaskScoreHistory.normalize` 转成**逐任务 z-score**，再比均值：`accepted = mean_z[candidate] > mean_z[star] + accept_margin` | `meta_learner/optimizer.py:371-392`（阈值字段 `:78, 96`） | 同上 | 同上 | high | 源码 |
| F28 | 两阶段反思：stage1 `FACT_ATTRIBUTION_PROMPT` 抽出 task-specific facts（`<facts>`）；stage2 `META_STRATEGY_SYSTEM_PROMPT` 要求「诊断**适应失败**而不是任务失败」「重写 meta-prompt 时不得含任何任务特定知识」「触发条件必须是任何日志里都看得见的东西」「不超过 350 行」；user prompt 里 facts 块显式标注「keep ALL of this out」 | `meta_learner/reflection.py:20-97, 175-239` | 同上 | 同上 | high | 源码 |
| F29 | 仓库**没有任何 benchmark 数字**，README 无结果章节；`outputs/` 被刻意排除出版本库（内容 404） | README:32-33；`gh api contents/outputs` → 404 | 同上 | 同上 | high | README/仓库 |
| F30 | 可跑入口 6 个：`jericho_meta.train`、`tau2_meta.train`、`webarena_meta.train`、`jericho_agent.evaluate`、`tau2_agent.evaluate`、`webarena.evaluate_webarena`；产物 `meta_state.json` / `best_prompt.txt` / `iterations.jsonl` / `val_scores.csv` / `prompts/` / `reflection/`，且可断点续跑 | README:46-89, 91-111；`webarena_meta/{train,evaluate_validation,adapter,dataset}.py` 存在 | 同上 | 同上 | high | README/源码 |

## 2. 机制闭环

### 2.1 Memento：状态=问题+历史，记忆=「问题→计划」对，读=相似度检索，写=判题后追加

**状态表示**：工程上 `s_t` 就是当前问题文本（`s_t` 用冻结句向量编码），案例三元组 `(s_t, a_t, r_t)` 的 `a_t` 在本实现里被具体化为 **planner 产出的整段 plan JSON**，`r_t` 是 0/1。论文的 M-MDP 里状态还含交互历史，但落到案例库只保留「问题→计划」这一层抽象——executor 的工具调用轨迹被丢掉了（F1/F2）。这是理解 Memento 的关键：它把「策略」压缩成「计划文本」，而不是「动作序列」。

**检索**：非参数版是 SimCSE 句向量余弦 top-8；参数化版是一个交叉编码器对 (query, case_text+plan) 打分，softmax 取正类概率（F4/F5）。打分对 reward **不敏感**——reward 只在拼 prompt 时用来分正负例。

**作用到模型输出**：唯一通道是 prompt。记忆文本作为一条 user 消息插在问题之后（F7），正例给出「好计划长什么样」，负例给出「别这么规划」。因此策略改进 = 检索分布 + 正负例配比的改进，模型权重不动。

**写**：judge 出 0/1 → append `{question, plan, reward}` → 重新载入全库（F8/F9）。没有质量过滤、去重、合并、淘汰，库只增不减。参数化版额外把「检索到的案例 + 本轮对错」写成 pairwise 训练数据，供重训检索器（F10）。

**双环**：planner 看到 system + 共享历史（问题、记忆块、自己的计划、executor 返回的结果），executor 看到**同一份**共享历史 + 当前子任务描述；executor 内部循环调用 MCP 工具直到产出文本；每轮任务做完 planner 带着新结果重规划，最多 3 轮（F11）。环间传递的信息就是共享历史里的自然语言结果，没有结构化信道。

### 2.2 Memento-Skills：状态=会话，记忆=技能文件，读=混合检索路由，写=归因后重写技能

**记忆形态**：不是案例文本，而是**可执行技能目录**（`SKILL.md` 说明书 + 脚本）。系统提示词里明确 θ 冻结、行为存在外部 `M`（F20/F21）。

**读**：技能路由用 BM25 + 向量混合检索（F23），选中技能后按其 `SKILL.md` 执行。

**写**：执行结果回流成 `record_outcome(skill, success)`，维护 `utility = success/(success+failure)`；失败时先归因到**一个**技能并给出 `failure_mode`，再用 rewrite prompt 生成新版本（含「discover」新技能分支），对候选跑合成测试并由 judge 打 0–1 分，取最优者；只有通过才整树原子替换，否则保留原树（F22）。这比 Memento 多了一个**验证闸门**，也是它更接近「自进化」的地方：产物是可复用、可测试、可回滚的代码/说明书，而不是一段提示文本。

**作用到模型输出**：技能内容进入上下文 + 技能脚本被真正执行，模型权重依旧不变。

### 2.3 Meta-TTL：状态=一次 TTL 会话，记忆=一条 meta-prompt，读=拼进 meta-agent，写=BIS 通过才落盘

**内层（TTL session）**：actor 从零开始试，失败后 meta-agent 读这次尝试、写一段 guidance，actor 带着 guidance 重试；**actor 在每个 episode 之间重置，guidance 是唯一跨 episode 的信息**（F26）。注意：这段 guidance 是**任务内**的，任务结束就丢，不进任何库。

**外层（meta-training）**：抽一个 proposal 任务跑完整 TTL 会话 → 两阶段反思（先抽 task facts，再抽象成「适应失败」层面的规则）→ 得到新 meta-prompt 候选 → 在**同一批验证任务**上分别跑 current 与 candidate → 逐任务 z-score 后比均值，超过 `accept_margin` 才接受（F27/F28）。

**作用到模型输出**：meta-prompt 是 meta-agent 的 system 指令，间接决定它写出的 guidance；actor 权重不变。

**接受机制的性质**：单候选爬山（每轮只提一个 candidate，接受/拒绝），不是进化搜索、也不是 best-of-n（代码里没有候选池或种群）。它的「平衡」来自 z-score 归一化：不同任务原始分量纲不同（0/1、分数、成功率），先按任务历史标准化再平均，避免「一个任务大涨掩盖另一个任务大跌」。

## 3. 关键数字（全部来自论文，非仓库自述）

| 指标 | Memento | 最强基线 | 来源 |
| --- | --- | --- | --- |
| GAIA val（Pass@3） | **87.88%**（L1 96.23 / L2 90.70 / L3 61.54） | Alita 87.27 | 论文 Table 2 |
| GAIA test | **79.40%**（L1 90.32 / L2 75.47 / L3 71.43） | Su Zero Ultra 80.40（Memento 非第一） | 论文 Table 2 |
| DeepResearcher 加权平均 | 66.6 F1 / 80.4 PM | training-based DeepResearcher 51.8 / 60.5 | 论文 Table 1 |
| OOD 增益（案例库） | **+4.7 ~ +9.6 绝对点** | — | 论文 Abstract |

**关于「不更新权重 vs 更新权重」的定量表述**（A5）：论文**没有**给出「达到微调效果的 X%」这类比例句。它给的是同表对比——Memento 66.6 F1 对 training-based 的 51.8 F1（Table 1），措辞是 “outperforming the state-of-the-art training-based method”（Abstract）。需要注意一个方法学问题（**本文推断**）：Table 1 表注说明 prompt-based 与 training-based 基线都用 Qwen2.5-7B，而 Memento 用 GPT-4.1 + o4-mini，**不是同底座 ± 梯度的受控对比**，所以这个「超过」不能直接读成「记忆等价于/优于同模型微调」。真正干净的因果量是 OOD 的 +4.7~9.6（同一 agent 开关案例库）。

**消融**：论文设了三档基线（static executor / Online Executor / w/o CBR），但本轮未取到「w/o CBR」的具体数值，只取到 OOD 增益区间。这是 §6 的 gap，不要用别的数字替代。

## 4. 失败模式 / 负迁移

- 论文正文中检索 `negative transfer` **无命中**，也未发现「案例越多越差」的曲线描述（检索范围内）。这是**阴性结果**，不等于论文证明不存在——只能说：在本次取到的正文片段里没有报告。
- 源码层面能看到三个结构性风险（**源码观察，非论文结论**）：(a) 写入无去重/无淘汰，库随任务数线性膨胀，检索 top-8 的竞争会越来越激烈；(b) 非参数检索打分**只看语义相似度、不看 reward**，同分情况下失败案例与成功案例机会均等；(c) 负例以「avoid these patterns」的形式进入 prompt，属于弱约束，模型可能被错误示范带偏——但仓库没有任何量化验证。
- Memento-Skills 的失败处理更保守：合成测试 + judge 不过就保留原树（F22），这本身就是对「改坏技能」的防护；但 judge 与被改技能同源，存在自我确认风险（**未验证推测**）。

## 5. Leads（值得追）

1. **Memento 论文 Appendix B**：Q-function 如何在参数化设置里塑形检索分布——这是「记忆重写」到底重写什么的核心，本轮只读到一句概述。
2. **Memento 论文 §5.3 的消融表**：拿到 w/o CBR 的具体数值，才能量化「案例库本身」的贡献（目前只有 OOD 区间）。
3. **`memory/train_memory_retriever.py`**：pairwise 训练信号如何从 (case_label, 最终对错) 构造，是否做了 hard negative——决定参数化检索器能否学到「避开失败案例」。
4. **Memento-Skills 论文 2603.18743 全文**：README 只有图，论文里应有 HLE/GAIA 的轮次数字与技能库增长曲线。
5. **meta-ttl 的 `meta_learner/normalizer.py`**：z-score 的 horizon 处理（代码注释提到把分数投到固定 horizon `[1,...,1]`）会影响 BIS 在早期轮次的稳定性。

## 6. Gaps（找过但没拿到）

- 未逐个打开 `server/*.py` 确认 MCP 装饰器写法（只从客户端 stdio 连接逻辑 + README 表述推断 server 侧是 MCP server）。
- 未读 `train_memory_retriever.py` 的损失函数与负采样细节。
- 未取到 Memento 消融表的具体数值；未查 GitHub Issues 里的复现/负迁移报告（预算用尽）。
- Meta-TTL 未找到配套论文或项目页（README 无链接，仅仓库）；三个 benchmark 的**任何**数字都未获得——这本身就是对其成熟度的判断依据。
- Reflexion / ExpeL / ACE 原文本轮**未检索**，因此三者的差异对比只能给结构性判断（见下），属**未验证推测**，不应作为结论引用。

### 附：与 Reflexion / ExpeL / ACE 的差异（未验证推测，仅作假设）

仅从 Meta-TTL 侧可证实的性质看，它的差异点在「优化对象在任务之外、且有验证闸门」：Reflexion 类方法把反思写进**当前任务的**记忆并在同任务重试；Meta-TTL 的 guidance 同样任务内，但它额外把「什么样的 guidance 有效」蒸馏进一个**跨任务复用的 meta-prompt**，并用同验证集上的 z-score 比较决定是否替换。前者是「一次任务内的自我修正」，后者是「跨任务的修正策略学习」。ExpeL/ACE 一类据称以「经验池/可增删的 playbook」为核心（**本会话未取证**），与 Meta-TTL 的单文本策略对象形成对照。此处不下结论。

## 7. 来源清单

1. `Memento-Teams/Memento`（stars 2714，created 2025-06-20，pushed 2025-10-05）：README.md、memory/np_memory.py、memory/parametric_memory.py、client/agent.py、client/no_parametric_cbr.py、client/parametric_memory_cbr.py
2. arXiv 2508.16153v2《Memento: Fine-tuning LLM Agents without Fine-tuning LLMs》，published 2025-08-22，v2 2025-08-25（ar5iv 全文快照）
3. `Memento-Teams/Memento-Skills`（stars 1593，created 2026-02-13，pushed 2026-08-17）：README.md、core/skill/evolution/engine.py、builtin/skills/skill-creator/SKILL.md
4. arXiv 2603.18743v1《Memento-Skills: Let Agents Design Agents》，2026-03-19（仅摘要）
5. `zzzlou/meta-ttl`（stars 5，created 2026-04-01，pushed 2026-09-26）：README.md、meta_learner/optimizer.py、meta_learner/reflection.py
