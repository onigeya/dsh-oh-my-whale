# D1 digest — What-If 模拟器骨架：状态表示 → 候选采样 → 多分支 rollout → 打分筛选

研究员: d1-simulator | 轮次: r1

## 结论（按重要性排序，每条一行主张）

1. 四者共享同一控制骨架（观测→状态摘要→候选动作→前向模拟→打分→选一个动作执行），但“模拟器”分两档实现：WebDreamer / SimuRA / ITP 用 LLM 直接预测未来状态文本；WebATLAS 不预测，而是把历史 `(o_t, a_t, o_{t+1})` 存成 cognitive map，模拟等于查表回放。
2. WebDreamer 不是 MCTS：它做 MPC 式 `argmax_a score(sim(o_t,a))`，搜索结构是“每个候选动作 × 多条独立轨迹 × 固定深度 H”，没有树展开、没有回溯、没有节点价值回传；MCTS 一词在全文未出现（论文只在 related work 提 tree search 作为对照基线）。
3. WebDreamer 的打分是 LLM critic 而非 reward model：三档（complete=1.0 / on track=0.5 / incorrect=0），对同一动作的多条轨迹分数取平均；候选动作先 top-k 采样，再由 LLM 做一次 self-refine 过滤掉不该模拟的动作。
4. WebDreamer 没有“模拟太贵就退回直接执行”的自适应开关；论文只做了“完全移除模拟、让 scorer 直接给候选动作排序”的消融，以及“模拟比真实 tree search 快 4–5 倍但仍比 reactive 慢约 2 倍”的延迟数据。
5. SimuRA 的状态是**自然语言摘要**（discrete natural language summary，token 级分解），不是符号结构、也不是连续 embedding；它把动作空间拆成“想象用抽象意图 A′（自然语言）”与“执行用具体动作 A”，以缩短 rollout 步数。
6. SimuRA 论文声称可用 DFS / MCTS，但实现参数是 `M=N=20`、`T=t+1`、实际用 DFS——即名义上是树搜索，规模上是“每个候选 20 条采样、深度 1 步”的前瞻；模拟结果用于**选择动作序列的第一步**，不存在显式的“校验/修正已有计划”步骤。
7. ITP 的 POIMDP 把“可观测状态 s_t”与“想象状态 ŝ_{t+i}”分开：s_t 是文本观测，ŝ 由世界模型生成；K_t=0 时想象轨迹为空、策略退化为标准 POMDP；想象轨迹先经 `Reflect(τ̂)` 变成反馈文本，再条件化下一个动作，**不是直接执行想象出的第一个动作**。
8. ITP 代码与论文一致地实现了“自适应 K”（k_head 线性层 + LLM 解析式 decide_k），但**没有实现多分支反事实对比**：orchestrator 每个 step 只调用一次 `world_model.imagine(k)`，得到一条链、一次反思、一个动作。
9. WebATLAS 的三环应更正为**四模块**：Planner / Actor / Critic / Memory；“Simulator”不是独立模块，就是 cognitive map 的检索 `M(o_t, a_t)`。critic 的价值函数由 LLM 依据 goal alignment、recoverability、plan consistency、outcome risk 打分，LAS 再用转移不确定性 `∏(1-U(s,a))` 折算轨迹价值。
10. 可迁移到符号记忆图谱的只有**骨架与打分接口**；四篇里的具体模拟器全部依赖“环境可执行、观测可回放、任务是回合制”的前提，迁到 L1/L2/L3 记忆图上会同时坏在状态转移无真值、动作空间不可枚举、目标函数缺失三处。

## 证据表

| # | 主张 | 证据定位 | 出处类型 | 置信度 |
|---|---|---|---|---|
| 1 | WebDreamer 用 `sim(o,a)` 预测结果再 `score(τ)` 选动作，MPC 式重复 | arxiv-2411.06559.txt:378-381, 411 | 论文声称 | high |
| 2 | 轨迹深度 H 是可配置参数；每个动作模拟多条轨迹 | arxiv-2411.06559.txt:388, 427 | 论文声称 | high |
| 3 | 状态变化用“简洁自然语言描述”，只写动作效果 | arxiv-2411.06559.txt:428 | 论文声称 | high |
| 4 | 打分三档 1.0/0.5/0，多轨迹取平均 | arxiv-2411.06559.txt:432-433 | 论文声称 | high |
| 5 | 候选动作 = top-k 采样 + LLM self-refine 过滤 | arxiv-2411.06559.txt:436；repos/webdreamer/controller.py:44-136 | 论文+代码 | high |
| 6 | 观测空间用截图（VWA 加 Set-of-Mark） | arxiv-2411.06559.txt:486 | 论文声称 | high |
| 7 | 代码里世界模型输入是截图 image_url；可选 change/html/accessibility 三种输出格式 | repos/webdreamer/world_model.py:36-59, 144-172 | 代码实现 | high |
| 8 | 代码默认 `num_of_sim=3, steps=1, n=10`，分数对 n 次采样取均值 | repos/webdreamer/simulation_scoring.py:443-447, 251-271, 484-492 | 代码实现 | high |
| 9 | README 示例用 `format='accessibility', k=3`，与论文图示“two-step”不同 | repos/webdreamer/README.md:58 | 代码实现 | high |
| 10 | 移除模拟阶段后改为让 scorer 直接重排候选（消融） | arxiv-2411.06559.txt:613-619 | 论文声称 | high |
| 11 | 延迟：reactive 87.7s / tree search 785.7s / WebDreamer 179.4s（Shopping） | arxiv-2411.06559.txt:583-603 | 论文声称 | high |
| 12 | SimuRA 世界状态 = 自然语言摘要，token 分解，便于各模块独立评估 | arxiv-2507.23773.txt:394-406 | 论文声称 | high |
| 13 | 想象动作 A′ 与执行动作 A 分离，A′ 用自然语言表示 | arxiv-2507.23773.txt:417-422 | 论文声称 | high |
| 14 | 决策公式：encoder→planner(policy+WM+critic)→actor | arxiv-2507.23773.txt:426-449 | 论文声称 | high |
| 15 | 树搜索“如 DFS 和 MCTS”，实现参数 M=N=20、T=t+1 | arxiv-2507.23773.txt:456, 492 | 论文声称 | high |
| 16 | 可观测状态即文本、文本观测当状态表示 | arxiv-2601.08955.txt:337-338 | 论文声称 | high |
| 17 | POIMDP：K_t∈{0..Kmax}，K_t=0 退化为 POMDP | arxiv-2601.08955.txt:368-372 | 论文声称 | high |
| 18 | 想象轨迹 τ̂ 经 Reflect 后进入策略，a_t∼π(·|s_t, Reflect(τ̂)) | arxiv-2601.08955.txt:407-414 | 论文声称 | high |
| 19 | ITP_R 用 K-head 预测视界分布，reward 含 −λ_K·K_t 惩罚，A2C 联合优化 | arxiv-2601.08955.txt:423, 457-466 | 论文声称 | high |
| 20 | 代码：`k_head = nn.Linear(hidden_size, kmax+1)` | repos/itp/itp/training/train_adaptive_k.py:224 | 代码实现 | high |
| 21 | 代码：每步只 imagine 一次，单条 foresight，一次 reflect_and_act；max_k=5 | repos/itp/itp/orchestrator.py:25-40 | 代码实现 | high |
| 22 | 代码：decide_k 解析 LLM 文本，clamp 到 [0,max_k]，解析失败默认 1 | repos/itp/itp/policy.py:48-68 | 代码实现 | high |
| 23 | WebATLAS 是四模块（Planner/Actor/Critic/Memory），不是三环 | arxiv-2510.22732.txt:342-358 | 论文声称 | high |
| 24 | 模拟即 cognitive map 检索 `ô_{t+1}=M(o_t,a_t)`；未命中返回 generic placeholder | arxiv-2510.22732.txt:436-452, 464-470 | 论文声称 | high |
| 25 | critic 打分依据：goal alignment、state viability、action coherence、plan consistency、outcome risk | arxiv-2510.22732.txt:384-386 | 论文声称 | high |
| 26 | LAS 轨迹价值乘 `∏(1−U(s,a))` 置信加权 | arxiv-2510.22732.txt:472-479 | 论文声称 | high |
| 27 | WebDreamer 全文无 MCTS；只有 tree search（真实交互）作基线 | arxiv-2411.06559.txt:299-306, 557-559 | 未找到证据（MCTS） | high |
| 28 | WebATLAS 的 N（候选数）、D（深度）、U 的估计方法在正文未给 | arxiv-2510.22732.txt:372-386, 473-475 | 未找到证据 | medium |

## 机制细节（可复用的设计参数）

- **状态表示**
  - WebDreamer：状态 = 截图 + “动作效果”的自然语言增量描述；H 步后状态是“初始截图 + 累积变更文本”，不生成完整页面（`format="html"/"accessibility"` 是可选项）。论文 §4 明确用截图作为 observation space。
  - SimuRA：状态 = encoder 生成的自然语言摘要序列 `ŝ_t = [m(s̃_1,a′*_1), …, s̃_t]`，即“过去摘要 + 已选想象动作”的拼接；属于离散符号但不属于结构化 schema。
  - ITP：s_t = 文本观测（等价于环境状态），ŝ = 世界模型生成的下一个文本状态；纯自然语言链。
  - WebATLAS：状态 = 原始观测 o_t（HTML/URL/摘要）+ cognitive map 中的 `(o_t,a_t,o_{t+1})` 三元组 + 语义记忆中的站点规则。
- **分支/采样**
  - WebDreamer：候选 top-k → LLM 过滤 → 每候选 `num_of_sim`（代码默认 3）条独立轨迹，深度 `steps`（代码默认 1，README 示例 3）。
  - SimuRA：从 policy 采样 M=20 个想象动作 → 聚类成不同动作 → 每个动作采样 N=20 次 critic 评分；深度 T=t+1。
  - ITP：单条链，长度 K_t 由策略选择；无并列分支。
  - WebATLAS：Actor 产 N 个候选（正文未给数值），每个候选沿 cognitive map 展开 D 步（正文未给数值），形成 beam 式多步轨迹。
- **打分/剪枝**
  - WebDreamer：LLM 三档（1/0.5/0），轨迹分数 = n 次采样的均值；动作分数 = 其所有轨迹分数均值；无阈值剪枝，只有 argmax。
  - SimuRA：critic v(ŝ_T) 给出目标达成度，聚合成期望回报；按最高期望成功选序列，只执行第一步。
  - ITP：无独立 critic；用 `Reflect(τ̂)` 让策略自我评估“进展/瓶颈/灾难性失败”，再选动作；ITP_R 用环境奖励 + 视界惩罚训练价值头。
  - WebATLAS：LLM 五维评估 → V(τ̂) × 转移置信度乘积 → 选最优轨迹的首个动作。
- **预算控制**
  - WebDreamer：靠“少而并行”的模拟（3 轨迹 × 深度 1–3）+ 候选过滤；延迟约为 reactive 2 倍、tree search 的 1/4。
  - SimuRA：靠抽象动作 A′ 合并多步执行，减少 rollout 步数；固定 20×20 采样。
  - ITP：把 K_t 本身变成可学习/可预测变量，训练时用 `−λ_K K_t` 惩罚；推理时 max_k=5。
  - WebATLAS：靠记忆查表替代生成，模拟几乎零 token 预测成本，成本转移到离线探索建图。

## 论文说 vs 代码做（代码取证：webdreamer、itp；simura/webatlas 无公开代码，未验证）

- **WebDreamer 深度**：论文图示与正文示例是 two-step（arxiv-2411.06559.txt:387, 394），但代码 `evaluate_simulation` 默认 `steps=1`（simulation_scoring.py:446），README 示例传 `k=3` 且 `format='accessibility'`（README.md:58）。→ 论文的“两步”只是示意，实际扫描过 1–3 步；且 accessibility 格式与论文“截图观测”的叙述不一致（论文 486 行说用截图）。
- **WebDreamer 打分数**：论文说“多个模拟轨迹与评分取平均”（433 行），代码里是两层平均——每次模拟内部对 n=10 个 critic 采样取均值（simulation_scoring.py:251-271），再对 num_of_sim=3 条轨迹取均值（484-492）。粒度比论文描述更细。
- **ITP 自适应视界**：论文 ITP_R 用 K-head 预测分布（423 行），代码确有 `nn.Linear(hidden_size, kmax+1)`（train_adaptive_k.py:224）；但推理路径 orchestrator 用的是 LLM 文本解析的 `decide_k`（policy.py:48-68），且解析失败默认 k=1、上限 max_k=5（orchestrator.py:25）。→ “学习出的 K-head”只出现在训练脚本，推理默认走 LLM 判断。
- **ITP 多分支**：POIMDP 公式允许对 τ̂ 条件化，但代码每步只 imagine 一条链（orchestrator.py:34），没有“候选动作 × 多轨迹”的对比。→ 论文的“批量反事实”能力在代码里不存在，只有单链前瞻。
- **SimuRA 的树搜索**：论文写“可用 DFS 和 MCTS”（456 行），同段又给 `M=N=20, T=t+1`（492 行）；后者意味着树深只有 1 层，MCTS 的“回传/扩展”在该配置下无实际作用。无代码可核，标注为论文内部不一致而非代码偏差。
- **WebATLAS 的“Simulator”**：问题清单假设存在独立 Simulator 模块，正文实为四模块，模拟由 memory 检索承担（436-452、464-470）；N、D、U 的估计方式均未在正文给出（未找到证据）。

## 骨架对比表

| 维度 | WebDreamer (2411.06559) | SimuRA (2507.23773) | ITP (2601.08955) | WebATLAS (2510.22732) |
|---|---|---|---|---|
| 状态表示 | 截图 + 动作效果文本增量 | 自然语言摘要序列（token 分解） | 文本观测 s_t / 世界模型生成 ŝ | 原始观测 + cognitive map 三元组 + 语义规则 |
| 模拟器实现 | LLM（GPT-4o / Dreamer-7B）预测状态变化 | LLM 世界模型预测下一步摘要 | LLM 世界模型（Qwen3-8B 训练） | **记忆检索查表**，非生成式预测 |
| 候选动作来源 | top-k 采样 + LLM self-refine 过滤 | policy 采样 M=20 个想象动作后聚类 | policy 直接采下一个动作（单链） | Actor 产 N 个候选（N 未给） |
| 分支数 × 深度 | 每动作 3 条 × 深度 1–3 | 聚类后动作 × 20 次评分，深度 1 | 1 条 × K_t（≤5） | N 候选 × D 步 beam（D 未给） |
| 打分函数 | LLM 三档 1/0.5/0，多层平均 | LLM critic 终端状态价值 + 折扣回报 | Reflect 文本反馈（无标量 critic） | LLM 五维价值 × 转移置信度 |
| 搜索算法 | MPC / argmax，无树 | 声称 DFS/MCTS，实为深度 1 枚举 | 无搜索，单链前瞻 | beam search over 记忆图 |
| 预算控制 | 固定小预算并行模拟 | 固定 20×20 采样 | 自适应 K_t（学习或 LLM 判断） | 离线建图，在线零生成成本 |
| 放弃/回退机制 | 无自适应回退，仅消融对照 | 无（reactive 仅作 baseline） | K_t=0 时退化为 reactive | 未命中记忆返回占位观测，等于降级为无前瞻 |
| 真实环境依赖 | 需真实网页执行动作、截图 | 需可执行网页 + accessibility tree | 需可执行文本环境（ALFWorld/ScienceWorld 等） | 需离线探索真实站点建图 |

## 只在自然语言/网页环境成立的设计，迁到符号化记忆图谱会坏在哪

1. **“模拟 = 预测下一段文本/下一张截图”**（WebDreamer、SimuRA、ITP）依赖一个**有真值、可回放**的观测流来定义“状态转移”。L1/L2/L3 记忆图没有 `o_{t+1}` 真值：一条假想“新增偏好”之后世界变成什么样，既不能截图验证，也没有环境 reward。照搬会得到流畅但不可校验的文本，正是这些论文用 grounding 想避免的幻觉。
2. **“候选动作 = 可执行动作空间里的 top-k”**依赖动作可枚举且执行代价低。记忆图的操作（新增/合并/改写/失效化 L1 事实、重划 L2 场景、更新 L3 画像）组合爆炸，且“执行”没有廉价沙箱；WebATLAS 的 beam search 假设分支因子小（页面上十几个可点元素），迁过来会直接失效。
3. **“critic 打 0/0.5/1 表示任务完成进度”**依赖存在一个**回合制任务目标**。Dreaming 是离线固化，没有 episode、没有 task success；同一段反事实推演对该不该保留哪条记忆的价值，无法用“是否完成任务”表达。必须换目标函数（如：与现有 L1 的矛盾数、来源指针可支撑率、覆盖增益），而四篇都没有给这种非任务型打分。
4. **WebATLAS 的查表模拟**迁移性最好也最差：它只需要 `(状态, 动作, 下一状态)` 三元组，形式上与记忆图同构；但它的三元组来自**真实站点探索**，而记忆图的三元组来自“过去对话里发生过的编辑”，覆盖极稀疏，未命中就退化成占位符——正文自己承认这一点（452 行）。迁过来会大部分时间处于“未命中”。
5. **SimuRA 的“抽象动作 A′ 用自然语言”**在记忆图上反而可用：把“合并两条冲突偏好”当作一个抽象意图、把具体 SQL 编辑当作 actor 的下层动作，是其分层思想的直接移植；但它的 critic 仍需要一个可评估的终端状态，这一步在记忆图上缺真值。
6. 结论：可迁移的是**骨架 + 接口**（状态快照 → 候选生成器 → 转移函数 → 打分器 → 选择器，且打分器可插拔）；不可迁移的是**转移函数与打分器的具体实现**。符号记忆图的天然优势是可以用“来源指针可追溯 / 逻辑一致性检查”替代 LLM 预测做校验，这一点四篇都没有涉及——属于本研究可提出的新设计，而非论文证据。

## 线索与未解问题

- WebDreamer 的 Dreamer-7B 是 Qwen2-VL-7B 微调（552 行），说明“世界模型”可被蒸馏成小模型；记忆图场景是否需要训练一个“记忆转移模型”，还是直接用 LLM + 规则校验，需要 D2/D3 维度配合判断。
- SimuRA 论文内部矛盾（MCTS 声称 vs T=t+1 配置）无代码可核，建议标注为“论文自述不一致”，不要当作已实现的多步树搜索。
- WebATLAS 的 N、D、U 三个关键超参在正文缺失；若后续要复现其 LAS，需要查附录或代码（本仓无 webatlas 代码）。
- ITP 的 K-head 只在训练脚本出现，推理走 LLM 解析；若“哦鲸鲸”要做自适应预算，LLM 判断式（decide_k）比训练一个 head 更现实，但需评估每次判断的 token 成本。
- 未触达：PGR / Memento / Dreamer V3 / Dreamer 4 不在 D1 范围，未读；其“想象 rollout”与“记忆检索”细节应由对应维度研究员给出。
