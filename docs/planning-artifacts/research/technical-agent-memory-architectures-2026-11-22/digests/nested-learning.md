# Nested Learning（嵌套学习）

> 调研日期：2026-11-22 ｜ 取源：arXiv abs/HTML、github.com / raw.githubusercontent.com ｜ 预算内工具调用 17 次
> 研究防火墙：本条只依据公开一手/代码来源，未读取委托方任何文件；项目背景不作为证据。
> 引用体例：`arXiv:2512.24695v1 §X` + 期刊式段落号（本文引用处标注 HTML 版本的段落行号 `L###`，正文行号以 `arxiv.org/html/2512.24695v1` 为准，因为 v1 无页码可引）。区分标记：**【论文】**=论文原文；**【代码】**=仓库代码/README；**【推断】**=我的判断；**【未证实】**=本轮未能取证。

---

## 1. 身份确认

### 1.1 一手来源

| 项 | 内容 | 证据 |
|---|---|---|
| 标题 | Nested Learning: The Illusion of Deep Learning Architectures | arXiv abs 页 Title 字段 |
| arXiv | **2512.24695**（v1，唯一版本） | abs 页 "Submission history: [v1] Wed, 31 Dec 2025 07:59:43 UTC"；无 v2/v3 |
| 作者 | Ali Behrouz, Meisam Razaviyayn, Peilin Zhong, Vahab Mirrokni（Google Research） | abs 页 Authors |
| 分类 | cs.LG（主）；cs.AI | abs 页 Subjects |
| 发表 | Comments 字段："A version of this work is published at Neural Information Processing Systems (NeurIPS) 2025" | abs 页 Comments |
| DOI | 10.48550/arXiv.2512.24695 | abs 页 |
| 全文 | https://arxiv.org/html/2512.24695v1 （本轮全部引文取自此处）；PDF: https://arxiv.org/pdf/2512.24695v1 | — |

**核心主张【论文，Abstract, L70】**（原文）：

> "we present a new learning paradigm, called Nested Learning (NL), that coherently represents a machine learning model with a set of nested, multi-level, and/or parallel optimization problems, each of which with its own 'context flow'."

摘要列三项贡献（原文续）：

> "(1) Expressive Optimizers: We show that known gradient-based optimizers, such as Adam, SGD with Momentum, etc., are in fact associative memory modules that aim to compress the gradients' information (by gradient descent) … (2) Self-Modifying Learning Module: … we present a sequence model that learns how to modify itself by learning its own update algorithm; and (3) Continuum Memory System: We present a new formulation for memory system that generalizes the traditional viewpoint of 'long-term/short-term memory'. Combining our self-modifying sequence model with the continuum memory system, we present a continual learning module, called Hope…"

即：**这是一个"把模型+优化器+训练过程统一重写为多层嵌套优化问题"的理论框架**，附带两个可训练产物（自修改 Titans 块、CMS 记忆链）与一个骨干模型 Hope。

### 1.2 命名陷阱（同名不同物）

arXiv 上至少还有 4 篇标题含 "Nested Learning" 但与本文无关的论文，检索时必须用全称或 ID：

- arXiv:2007.06402 *Nested Learning For Multi-Granular Tasks*（2020，Achddou 等）— 多粒度任务，无关。
- arXiv:1811.09131 *BRDF Estimation of Complex Materials with Nested Learning*（2018）— 图形学，无关。
- arXiv:2406.12779 *Composited-Nested-Learning … Nested Named Entity Recognition*（2024）— NER，无关。
- arXiv:2605.27454 *NL-MambaXCT … Nested-Learning Mamba*（2026）— 工业 CT，无关。

引用本文的后续工作（第三方，非作者团队）：arXiv:2605.16350 *Federated Nested Learning*；arXiv:2601.13186 / arXiv:2605.29055（Gosmar & Dahl，把 "Nested Learning" 与 agentic AI、semantic caching 并列）；arXiv:2605.26678 *NestedKV*。**这些是引用者，不能当作本文内容。**

### 1.3 与 HOPE / Titans / CMS 的关系：同源，但关系不是"四个项目"

- **Hope 不是另一篇论文**：它是本文 §8（L602–L673）提出的架构实例，"A neural learning module that incorporates self-modifying Titans followed by Continuum Memory System"（§8.3, L662–L663）。注意论文里写的是 **"Hope"（首字母大写，全文 90 次），全文 "HOPE" 全大写 0 次**——把它写成 HOPE 是社区习惯。
- **CMS 不是外部项目**：Continuum Memory System 是本文 §7（L527–L600）新提出的记忆形式（§7.1, L529）。
- **Titans 是前作**：§8.1 标题即 "Deep Self-Referential Titans"（L606），参考文献中有 "Titans: learning to memorize at test time"（L1531）。其 arXiv 号为 **2501.00663**。【推断】该编号来自第三方面向论文的引用与参考文献标题匹配，本轮未直接打开 2501.00663 的 abs 页核对（见 §7 缺口）。

结论：**Nested Learning（框架）→ CMS（记忆形式）+ Self-Referential Titans（记忆块）→ Hope（骨干模型）** 是同一条研究线（Behrouz 等，Google Research）的四层关系，不是四个独立系统，也不存在"nmem 实现了其中若干模块"这种拼装叙事。

---

## 2. 一句话定位

Nested Learning 是一篇**理论/架构论文**：它主张"学习 = 在多个时间尺度上压缩自己的 context"，据此把 MLP 层重排成一串**更新频率递减、按固定周期用梯度更新**的块（CMS），并叠在自修改 Titans 之上得到语言模型骨干 Hope；它**不提供**条目级记忆 API、冲突裁决、信念修正或离线调度，因此**不是 agent 记忆系统**，而是一种"训练期持续学习"的模型设计。

---

## 3. 多层记忆栈机制（论文原文）

### 3.1 层级怎么分：按"单位时间更新次数"排序

**【论文 §3.2, Definition 2, L199】**：

> "For any component of A, which can be a parametric component (e.g., learnable weights or momentum term in gradient descent with momentum) or a non-parametric component (e.g., attention block), we define its frequency, denoted by f_A, as its number of updates per unit of time."

**【论文 §3.2, L200】**：

> "we sort the components into an ordered set of 'levels', where (1) components in the same level have the same frequency update, and (2) the higher the level is, the lower [its frequency]…"

即：**层 = 更新频率的等价类**，频率越高层级越低（越"快"）。这不是按"语义/情节/程序"这类认知分类分层，而是纯粹按**每单位时间被更新多少次**分层。

### 3.2 每层的时间尺度：chunk size 与频率成反比

**【论文 §7.1, L530】**（定义）：

> "Continuum Memory System (CMS) is formalized as a chain of MLP blocks MLP^{(f_1)}(·),…,MLP^{(f_k)}(·), each of which associated with a chunk size of C^{(ℓ)} := max_i C^{(i)} / f_ℓ"

**【论文 §7.1, 式(70), L531】**：

> "y_t = MLP^{(f_k)}( MLP^{(f_{k−1})}( ⋯ MLP^{(f_1)}(x_t) ) )"

**【论文 §7.1, 式(71), L533–L537】**（写入规则，本文最关键的一段）：

> "where the parameters of ℓ-th MLP block, i.e., θ^{(f_ℓ)}, are updated every C^{(ℓ)} steps:
> θ^{(f_ℓ)}_{i+1} = θ^{(f_ℓ)}_i − Σ_{t=i−C^{(ℓ)}}^{i} η^{(ℓ)}_t f(θ^{(f_ℓ)}_t; x_t)   if i ≡ 0 (mod C^{(ℓ)}),   else 0.
> Here η^{(ℓ)}_t are learning rates … and f(·) is the error component of an arbitrary optimizer (e.g., ∇L(θ^{(f_ℓ)}_t; x_t) in gradient descent). **The conventional Transformer block is a special instance of this formulation, where k=1 and frequency of update is zero.**"

由此可读出三层时间尺度（论文给出的极端点）：

| 层 | 更新频率 | 更新周期 | 参数性质 | 证据 |
|---|---|---|---|---|
| 序列/注意力块 | f = ∞（每 token） | 每步 | **非参数**，"perfect memories (forcing to cache all past tokens) with frequency update of infinity" | §8, L603 |
| 高频 MLP 块 | f_1（最高） | 每 C^{(1)} = max C / f_1 步 | 参数，快适应、短时保持 | 式(70)(71)；§1.2, L101 |
| 低频 MLP 块 | f_k（最低） | 每 C^{(k)} 步 | 参数，持久知识 | 同上 |
| 最外层（预训练） | 最低 | 整个 context flow 一次 | 参数 | §7, L528："pre-training is the phase that the most outer level of the learning module is updated over its limited context flow" |

**【论文 §1.2, L101】** 对这条频谱的解释：

> "higher-frequency neurons are responsible for fast adaption but store memories/knowledge for a short period of time, while lower frequency neurons are responsible for more persistent knowledge."

### 3.3 写入由什么驱动：**梯度 + 固定周期**，不是惊喜度、不是事件触发

这一点必须说死，因为传闻里最容易出错：

1. **写入信号就是梯度**。式(71) 的 `f(·)` 被明确定义为 "the error component of an arbitrary optimizer (e.g., ∇L(θ_t; x_t) in gradient descent)"（L537）。
2. **论文里的 "surprise" 是梯度的同义词，不是独立的启发式打分**。**【论文 §3.1, L150/L152】**：

   > "W_{t+1} = W_t − η_{t+1} ∇_W L(W_t; x_{t+1})  [标注为 'Surprise']"
   > "∇_W L(W_t; x_{t+1}) is the surprise metric that shows how much the current input is different from previously observed data."

   也就是说，"惊喜度"= ‖∇L‖ 的语义，**没有**"用 LLM 或启发式给记忆条目打惊讶分再决定是否写入"这种机制。全文 "surprise" 17 次，全部在"梯度=惊讶信号"的语境（§3.1、§3.2、§4.1）。
3. **写入时机是确定性周期**。**【论文 §7.1, L559】**：

   > "In the CMS design, at each time, updates are restricted to blocks approaching their scheduled update time (based on their frequency)."

   即 `i ≡ 0 (mod C^{(ℓ)})`。没有"重要事件触发写入""冲突时立即写入""夜间批量重放"这类条件。全文 "periodic" 0 次，调度完全由模运算决定。

### 3.4 层与层之间怎么传递知识：三种 CMS 变体，全靠"元学习初始状态"

**【论文 §7.1, L539–L553】** 给出三种连接方式：

- **Nested CMS（式72, L541–L543）**：第 s+1 层 MLP 的**初始状态**在第 s 层被元学习；"at the end of the optimization process of each block … the value of the memory will be **re-initialized** to θ_0^{(f_{s+1})}"。
- **Sequential CMS（式73, L545–L548）**：所有块串联，初始状态由最低频层反向传播统一学习。
- **Independent / head-wise CMS（式74, L551）**：

  > "y_t = Agg( MLP^{(f_k)}(x_t), MLP^{(f_{k−1})}(x_t), ⋯, MLP^{(f_1)}(x_t) )"
  > "The above Agg(·) is an arbitrary function … one straightforward and simple design choice is to use a learnable weighted sum of the input."

**关键**：层间交互只有"初始化 / 反向传播 / 加权求和"这三种**数值**方式。**没有**读-写协议、没有条目迁移、没有"从快层晋升到慢层"的符号化规则。所谓"晋升"在论文里唯一的对应物是梯度把快层信息压进慢层参数。

### 3.5 它为什么声称能缓解遗忘（论文自己的说法）

**【论文 §7.1, L555】**：

> "when updating an arbitrary block of MLP^{(f_s)}(·) …, the potentially forgotten knowledge from MLP^{(f_s)}(·) is still stored in other components such as MLP^{(f_{s'})}(·), where s' < s."

**【论文 §10, L1423】**（作者自认的边界）：

> "catastrophic forgetting is not 'solved' in general. From nested learning viewpoint …, catastrophic forgetting is a natural consequence of compression, where the limited capacity of the network forces the model to forget so that it retains capacity for new information."

### 3.6 神经科学动机 ≠ 实现机制（重要区分）

论文 §1.1 用睡眠巩固做**类比**。**【论文 §1.1, L82】**：

> "An 'offline' consolidation (also known as systems consolidation) process repeats the replay of the recently encoded patterns—during sharp-wave ripples (SWRs) in the hippocampus, coordinated with cortical sleep spindles and slow oscillations…"

**【推断】** 这段只解释"为什么需要多时间尺度"；论文**没有**把 SWR/睡眠映射成任何调度器。证据：全文 "sleep" 共 10 次，其中 **1 次在正文 §1.1（L82）**，其余 9 次全部出现在参考文献标题里（L1691, L1709, L1933, L2028, L2108, L2159, L2237, L2434, L2548）；"dream" **0 次**。方法章节（§7、§8）的更新规则里没有任何离线阶段。

---

## 4. 开源实现现状

### 4.1 官方实现：**没有**（截至 2026-11-22）

| 检查项 | 结果 |
|---|---|
| v1 全文中的 GitHub 链接 | 仅 3 条，全部是 arXiv/LaTeXML 模板链接（`github.com/arXiv/html_feedback`、`github.com/brucemiller/LaTeXML/…`）。**无作者代码仓库链接** |
| Google Research 博客 | 本轮未取到对应博文 →【未证实】是否存在 |
| 社区仓库自述 | smallhours19/nested-learning-hope README："**No official code for HOPE has been released**, so this implementation was built from what is available…"；docs/DEVIATIONS.md 首段："No official code exists at the time of writing." |

【推断】结合"论文只有 v1、无 code availability 段落、无 GitHub 链接"，可判定**作者未发布官方实现**。这一结论的证据强度：一手（论文全文无链接）+ 代码仓自述（二手，但与一手一致）。

### 4.2 社区实现（两个，均为自建复现，非官方）

| 仓库 | ★ | 最近提交 | 结构 | 忠实度评估 |
|---|---|---|---|---|
| [Ray0907/Hope](https://github.com/Ray0907/Hope) | 3 | 2026-01-03T06:25:32Z | `src/{config,model,optimizers}.py`、`train.py`、`example.py`、`test_hope.py` | **玩具级**。README 声称实现 "Self-Modifying Titans (Eq. 28-29)" 与 "CMS (Eq. 30-31)"，但**论文 v1 中 CMS 是式(70)(71)、Titans 更新是式(96)**——编号对不上【推断：按早期预印本编号或凭记忆撰写】。作者 2025-12-08 起提交，比 arXiv v1（2025-12-31）更早，说明其依据的是更早流传的稿件版本。无预训练结果、无 CI。 |
| [smallhours19/nested-learning-hope](https://github.com/smallhours19/nested-learning-hope) | 2 | 2026-09-04T14:17:53Z | README + `docs/DEVIATIONS.md` + `docs/STABILITY.md` + `assets/loss_curves.png` + CI badge + `pyproject.toml` | **目前最认真的公开复现**，但**明确偏离论文**：`docs/DEVIATIONS.md#D1` 记载"Paper: Eq. 91 defines the memory as a two-layer residual MLP … We ship: a plain matrix memory M(x)=x+Wx … `HOPEConfig(deep_mem_learnable=True)` provides the paper's Eq. 91 deep memory exactly as written"。即**默认配置不是论文的记忆形式**。有 30.6M 参数 byte-level FineWeb-Edu 预训练曲线。 |

关于 lucidrains / google-deepmind：GitHub API 在本轮触发 403 限流，**未能完整枚举**，因此"lucidrains 没有 hope/nested-learning 仓库"这句话**【未证实】**，不能下断言。可以确定的是：GitHub 仓库搜索（按 star 排序）中，与本论文直接相关的只有上述两个小仓库（★3、★2），不存在任何高 star 的官方或半官方实现。

### 4.3 判定

- **有可运行代码**：是（两个社区复现，均含训练脚本）。
- **有论文级 CMS 实现**：**部分是**——smallhours19 实现了"多频率 MLP 链 + 周期更新"的骨架（式70/71），但主记忆默认用矩阵而非论文式(91)的深度 MLP；Ray0907 的公式编号与 v1 不符，忠实度无法确认。
- **有官方实现**：**没有**。
- **有已发布权重/可对比基准**：两个仓库都未提供官方可比权重 → 无法验证论文实验数字。

---

## 5. 有无"冲突裁决 / 信念修正 / dream 调度"

### 5.1 关键词计数（对 v1 全文 HTML 去标签后统计，大小写不敏感）

| 词 | 命中 | 说明 |
|---|---|---|
| `conflict` | **0** | 全文无此概念 |
| `dream` | **0** | 无 |
| `vote` | **0** | 无 |
| `promote` | **0** | 无（"晋升"在论文里没有对应词） |
| `contradiction` | **0** | 无 |
| `belief` | 2 | 均为"我们对架构异构性的 belief 需要被重审"（§1.1, L89），**不是**"agent 的信念" |
| `sleep` | 10 | 1 处正文（§1.1, L82，神经科学类比）+ 9 处参考文献标题 |
| `consolidat` | 15 | 集中于 §1.1 神经动机与参考文献；方法章节未定义 consolidation 算子 |
| `surprise` | 17 | 全部为"梯度=惊讶信号"的等价表述（见 §3.3） |
| `forget` | 19 | 全部在"catastrophic forgetting / 遗忘是压缩的代价"语境 |

### 5.2 逐项裁定

- **冲突裁决：无。** 当两个频率块对同一输入给出不同输出时，处理方式是式(70) 的**串联复合**或式(74) 的 `Agg(·)`（"an arbitrary function … a learnable weighted sum"，L551–L553）。没有比较、优先级、投票或仲裁逻辑。全文 0 次 `conflict`。
- **信念修正：无（在 agent 语义上）。** 知识以**参数**形式存在，"修正"= 下一次梯度更新覆盖旧参数（式71）。没有条目、没有来源、没有置信度、没有时间戳，因此不存在"修正某条信念"这个操作。作者自己承认遗忘未被解决（L1423）。
- **dream / 夜间调度：无。** 更新时机是确定性模运算 `i ≡ 0 (mod C^{(ℓ)})`（式71, L534）与 "scheduled update time (based on their frequency)"（L559）。没有离线重放、没有生成式回放、没有批处理窗口。睡眠只出现在 §1.1 的生物学类比（L82）。
- **"证据投票晋升"：无。** 论文没有"证据""投票""晋升"三个概念的任何技术对应物。
- **"多层记忆栈"：有，但含义不同。** 论文确实有"多层"，但层是**参数块按更新频率排序**（Def 2），栈是**同一个前向通路里的 MLP 链**（式70），不是可增删的记忆条目容器。

### 5.3 所以它是不是 agent 记忆系统？——判断与依据

**不是。** 依据（全部可核）：

1. **唯一的跨层写通道是梯度**：式(71) 的更新项是 `η·f(θ;x)`，`f` 被定义为优化器的误差项（L537）；式(72)(73) 的层间传递是对初始状态的元学习（L541–L548）。
2. **没有条目级 CRUD**：CMS 的状态就是 MLP 权重矩阵，没有 id/内容/来源/时间字段。
3. **没有检索接口**：读 = 前向传播 `M(q)`（§3.2, L212–L213："we use M_i^{(k)}(q) to refer to the forward pass process (i.e., retrieval process) of the memory"），不是 query→candidates→rerank 的检索管线。
4. **没有调度器**：更新由 `i mod C^{(ℓ)}` 决定，没有 job、没有队列、没有触发条件。
5. **需要训练回路**：Hope 是"要预训练的语言模型骨干"（§9.3 语言建模、§8.2 训练并行化），不是一个可插到现有 agent 上的运行时组件。

一句话：**它是"多层不同更新频率的 MLP 链 + 梯度"，再叠一个自修改 Titans 块。** 这个判断不是我贬低它，而是论文自身范围（§10, L1420："both architectures and optimizers are instances of nested systems of associative memories that compress their own context"）。

---

## 6. 可迁移性（本地 / 无训练回路 / 只有 LLM API 的 agent 插件）

前提：插件只能调 LLM API，没有梯度、没有本地权重、没有反向传播。逐条判定：

| 论文概念 | 能否迁移 | 迁移后的形态 | 依据与风险 |
|---|---|---|---|
| **更新频率分层**（Def 2, L199–L200） | ✅ 可迁移为**设计原则** | 把记忆分为"每轮对话 / 每日 / 每周"三档，各档写入周期不同 | 这是隐喻映射：论文的 f 是"每单位时间更新次数"，插件里可映射为"每 N 次会话合并一次"。**论文不提供任何证据支持这种映射**，属于工程启发式，需自行 A/B。 |
| **周期边界批量写入**（式71 的 chunk 语义：块内并联、边界更新） | ✅ 可迁移 | 攒批写入：会话内只追加，周期边界做一次 LLM 合并/摘要/去重 | 式(71) 的 `Σ_{t=i−C}^{i}` 就是"chunk 内累积、边界一次更新"的数学形式。无梯度时用 LLM 摘要替代梯度下降，语义等价性未经验证。 |
| **上下文生命周期与重初始化**（式72：context 结束后 re-initialize 到 θ_0） | ✅ 可迁移 | "会话级 scratchpad（结束即清空）"vs"跨会话持久层（有元学习得到的初始态）" | L543 原文支持"每个 context 结束重初始化"这一结构。 |
| **层间知识传递 = 元学习初始状态**（式72/73） | ⚠️ 只能弱迁移 | 用"上次会话的摘要作为本次会话的 system prompt 种子" | 这对应"初始状态由外层决定"，但外层更新在论文里是梯度（L541），插件里只能靠人写规则或 LLM 归纳。 |
| **记忆 = 参数压缩** | ⚠️ 只能类比 | "压缩"= LLM 摘要，不是参数融合 | 论文的压缩有明确目标函数（∇L）；LLM 摘要没有可验证的压缩保真度指标。 |
| **梯度写入 / delta rule / M_t 更新**（式96） | ❌ 不可迁移 | — | 需要可微参数与反向传播。无梯度就没有 `∇L`，也就没有论文定义的 surprise。 |
| **surprise 驱动写入** | ❌ 不可迁移（且容易被误读） | 若要用"惊讶度"，必须自建打分器（如 embedding 距离/LLM 自评） | 论文的 surprise **就是梯度**（L150/L152），不是可独立计算的启发式。把它移植成"LLM 判断新信息是否意外"是**另一个机制**，不能引论文为依据。 |
| **CMS 作为 MLP 链** | ❌ 不可迁移 | — | 需要训练好的多层权重与频率调度器（式70/71）。 |
| **Hope 骨干 / 自修改 Titans** | ❌ 不可迁移 | — | 需预训练（§8.2 讨论训练并行化），且无官方权重可用（§4.1）。 |

**净结论**：可迁移的只有两条**结构性直觉**——(a) 多时间尺度分层，(b) 在周期边界做批量合并而不是每步都写。二者都不是论文的"机制"，而是从式(71) 的 chunk 结构里读出的工程模式；把它们称为"实现了 Nested Learning"会是失实的。**任何依赖"梯度/参数/surprise=∇L"的部分，在没有训练回路的插件里都不成立。**

---

## 7. 未证实与缺口

1. **Google Research 博客**：本轮未取到对应博文，是否存在官方博文【未证实】（取源预算内未覆盖）。
2. **lucidrains 系列是否有 hope/nested-learning 实现**：GitHub API 403 限流，未能完整枚举【未证实】。不能据此断言"没有"。
3. **google-deepmind 是否有实现**：未检索【未证实】。
4. **Titans 的 arXiv 编号 2501.00663**：论文参考文献只给标题（L1531），编号来自第三方 README 匹配【推断，高置信】。
5. **NeurIPS 2025 正式版与 arXiv v1 的差异**：abs 页称 "A version of this work is published at NeurIPS 2025"，但 arXiv 只有 v1（2025-12-31）。正式版是否修改了 CMS 公式/编号【未证实】；这可能解释 Ray0907 的编号差异。
6. **Ray0907/Hope 实现忠实度**：未逐行读代码核对式(70)(71)(96)【未证实】；仅据 README 与文件结构判断为玩具级。
7. **论文实验数字**（§9 各表）本轮未核对，本摘要只做机制核实，不做效果评价。
8. **"nmem 实现了嵌套学习"这一说法的原始出处**：不在本委托书范围内，未追查；本摘要只证明"论文本身不含冲突裁决/信念修正/dream 调度/证据投票"。

---

## 8. 来源清单

| # | 来源 | 类型 | 用途 | 访问 |
|---|---|---|---|---|
| 1 | https://arxiv.org/abs/2512.24695 | 一手（元数据） | 标题/作者/日期/版本/NeurIPS 说明/DOI | 2026-11-22 |
| 2 | https://arxiv.org/html/2512.24695v1 | 一手（全文） | 全部 §3/§5/§7 引文与关键词计数 | 2026-11-22 |
| 3 | https://arxiv.org/pdf/2512.24695v1 | 一手（PDF） | 与 HTML 同源，未单独引用页码 | — |
| 4 | https://export.arxiv.org/api/query?search_query=ti:%22Nested%20Learning%22 | 一手（检索） | 排除同名论文，确认唯一相关条目 | 2026-11-22 |
| 5 | https://github.com/Ray0907/Hope | 代码（社区） | ★3；最近提交 2026-01-03 | 2026-11-22 |
| 6 | https://raw.githubusercontent.com/Ray0907/Hope/main/README.md | 代码（社区） | 公式编号不符的证据 | 2026-11-22 |
| 7 | https://github.com/smallhours19/nested-learning-hope | 代码（社区） | ★2；最近提交 2026-09-04 | 2026-11-22 |
| 8 | https://raw.githubusercontent.com/smallhours19/nested-learning-hope/main/docs/DEVIATIONS.md | 代码（社区） | "No official code exists"、D1 偏离（式91→矩阵记忆） | 2026-11-22 |
| 9 | https://github.com/Ray0907/Hope/commits/main.atom ；https://github.com/smallhours19/nested-learning-hope/commits/main.atom | 代码（社区） | 精确提交时间 | 2026-11-22 |

**未采用的来源**：无博客/推文被用作证据（仅代码仓 README 作为"官方无代码"的旁证，且与论文一手证据一致）。
