# D2 digest — 算力经济学与触发条件：什么时候值得模拟、模拟多深
研究员: d2d4-budget-reliability | 轮次: r1

## 结论（按重要性排序，每条一行主张）
1. **没有一篇论文提供独立的“模拟收益评估器”（先估这次模拟值不值，再决定模拟与否）。** ITP 用 LLM 自评选步长 / 线性 K-head + 专家动作似然减成本惩罚；WebDreamer 用三档打分对多条模拟取均值；WebATLAS 用认知地图真实转移 + 不确定性连乘折扣。三者都是“先模拟、再打分”。
2. **“模拟越深越好”在两侧都被实测否证：收益随深度非单调、成本单调上升。** ITP：fixed-k 成功率“先升后降”，成本随 k 急剧上升（arxiv-2601.08955.txt:934）。WebDreamer：H=1 最有效，2–3 步反而下降（arxiv-2411.06559.txt:464、637-640）。可复用结论：深度上界必须很小，网页域 H=1 就够。
3. **ITP 的自适应信号不是不确定性、也不是预测误差，而是“朝最终目标的进度估计”。** ITP_I 让 LLM 读指令+状态直接选 K_t（arxiv-2601.08955.txt:398、407）；ITP_R 把 K 变成可学习分布 P(K_t|s_t)，伪标签为 argmax_k[log p(a*|s,τ̂(k)) − λ_K·k]（:423、432），在线阶段奖励 r_env − λ_K·K_t − λ_step，用 A2C 联合优化（:458-466）。
4. **决策深度在代码里是“欠账式”实现：一次 temperature=0.8 的采样 + 首个整数解析，失败就静默回退 K=1。** repos/itp/itp/policy.py:48-69（decide_k：max_new_tokens=decision_tokens、do_sample、stop=["\n"]；except → k=min(max_k,1)）。这意味着“自适应”是随机采样而非校准估计。
5. **K_max 在代码默认为 5，论文正文只说“见附录 C”。** repos/itp/configs/itp_r.yaml:3（kmax: 5）、README.md:141（--kmax 5）；K-head 为 Linear(hidden_size, kmax+1)（repos/itp/itp/training/train_adaptive_k.py:224）。ITP 的 NB 正是以 K_max=5 的成本作分母（arxiv-2601.08955.txt:929-932）。
6. **ITP 的预算是 token，不是调用次数或钱。** 成本 T=Σ_t(T(π_θ)+T(M_φ))，NB(k)=(T̄(k)−T̄(0))/(T̄(K_max)−T̄(0)) 归一到 [0,1]（arxiv-2601.08955.txt:925-931）。论文只给“更高 SR + 显著更低预算”的曲线关系，**没有单一百分比节省数字**（:935）→ 未报告。
7. **ITP 有真实部署延迟：单步决策 p50 14.2s / p95 31.8s / p99 44.7s；想象 7.8/18.9/28.5s vs 策略 5.1/11.6/17.4s；吞吐 43.5→24.0 tok/s；11.8 episodes/hour；VRAM 31.0/38.4 GB。** arxiv-2601.08955.txt:1895-1917。这是“模拟爆炸”的实测代价，想象耗时约为策略的 1.5 倍以上。
8. **WebDreamer 没有 MCTS：全文 grep MCTS/rollout/prune 命中 0。** 它是 MPC 式“候选 top-k → self-refine 剪枝 → 每候选多条模拟 → 打分取最大”（arxiv-2411.06559.txt:397-423、436）。剪枝发生在模拟之前，因此“剪枝”实为候选裁剪而非搜索树裁剪。
9. **WebDreamer 的模拟规模在代码里很小：默认 num_of_sim=3、steps=1、num_workers=15，单次模拟内层打分 n=10。** repos/webdreamer/simulation_scoring.py:443-460、416-421。论文只说“simulates multiple trajectories per action”（arxiv-2411.06559.txt:388），未给数字。
10. **WebDreamer 的“模拟爆炸”量化对照：树搜索约 10 倍延迟，WebDreamer 比树搜索高效 4–5 倍，但仍比反应式基线慢约 2.1–2.8 倍。** 墙钟 68.3/749.2/183.6 s（Classifieds）、83.5/972.1/233.7（Reddit）、87.7/785.7/179.4（Shopping）；步数 3.4/9.9/4.1 等（arxiv-2411.06559.txt:558-603）。
11. **“完全不模拟”的唯一对照是 Reranking：去掉模拟、只用 reward model 给候选打分，有小幅提升但远落后 WebDreamer。** arxiv-2411.06559.txt:617-622。论文没有给出任何“按状态决定要不要模拟”的策略。
12. **WebATLAS 的分支 N 与深度 D 在正文只有符号、没有数值；成本控制靠“概念空间模拟（不执行真实动作）+ 不确定性折扣 + 偏差触发重规划”，无显式调用次数上限。** arxiv-2510.22732.txt:372-374、464-475、502-504。
13. **SimuRA 的成本论证纯定性：在意图级抽象动作上模拟，可比原子动作 roll-out 更短、误差累积更少，并支持跨动作空间迁移；无加速比、无 token 数字。** arxiv-2507.23773.txt:413-421。

## 证据表
| # | 主张 | 证据定位 | 出处类型 | 置信度 |
|---|---|---|---|---|
| 1 | ITP 成本=episode token 总和，NB 归一到 [0,1] | arxiv-2601.08955.txt:925-931 | 论文声称 | high |
| 2 | fixed-k 峰值后下降、成本随 k 急升；自适应更低预算更高 SR | arxiv-2601.08955.txt:934-935 | 论文声称（图 4a，趋势无数字） | high |
| 3 | 自适应优于随机 lookahead（140 任务/14 折） | arxiv-2601.08955.txt:939-945 | 论文声称 | high |
| 4 | ITP_I 由 LLM 分析指令+状态选 K_t | arxiv-2601.08955.txt:398、407 | 论文声称 | high |
| 5 | K-head 为骨干上的线性层，输出 K 分布 | arxiv-2601.08955.txt:423 | 论文声称 | high |
| 6 | 伪标签 argmax_k[log pθ0(a*|s,τ̂(k)) − λ_K·k] | arxiv-2601.08955.txt:429-436 | 论文声称 | high |
| 7 | 在线奖励 r=r_env−λ_K·K_t−λ_step，A2C 联合优化 | arxiv-2601.08955.txt:458-466 | 论文声称 | high |
| 8 | WM 训练 bf16/2×A100；rollout 采集 9.5 GPU-hours（1×A100） | arxiv-2601.08955.txt:1878-1884 | 论文声称 | high |
| 9 | 部署延迟 p50/p95/p99 14.2/31.8/44.7 s；想象 7.8/18.9/28.5 s；策略 5.1/11.6/17.4 s；43.5/31.2/24.0 tok/s；11.8 ep/h；VRAM 31.0/38.4 GB | arxiv-2601.08955.txt:1895-1917 | 论文声称 | high |
| 10 | decide_k：采样 temperature 0.8，解析首个整数，异常回退 K=1，并 clamp 到 [0,max_k] | repos/itp/itp/policy.py:48-69 | 代码实现 | high |
| 11 | K_max 代码默认 5；K-head 输出 kmax+1 类 | repos/itp/configs/itp_r.yaml:3；repos/itp/itp/training/train_adaptive_k.py:224 | 代码实现 | high |
| 12 | WebDreamer 无 MCTS/rollout/prune 术语 | arxiv-2411.06559.txt（grep 命中 0） | 未找到证据（阴性） | high |
| 13 | Algorithm 1：get_candidate → self_refine → argmax score(sim(o,a)) → execute | arxiv-2411.06559.txt:397-423 | 论文声称 | high |
| 14 | 打分三档 1.0/0.5/0，多轨迹多评分取均值 | arxiv-2411.06559.txt:430-433 | 论文声称 | high |
| 15 | 终止：stop 动作 / 达 max steps / 同动作重复 >3 次 | arxiv-2411.06559.txt:439 | 论文声称 | high |
| 16 | H=1 最有效且最省；仅用 H=1 训练转移函数 | arxiv-2411.06559.txt:464 | 论文声称 | high |
| 17 | H∈{1,2,3}：H=2/3 递减，因模拟内动作幻觉与误差累积 | arxiv-2411.06559.txt:629-640 | 论文声称（图 5） | high |
| 18 | 去掉模拟仅重排：小幅提升但远落后 | arxiv-2411.06559.txt:617-622 | 论文声称（图 4） | high |
| 19 | 树搜索 ~10× 延迟；WebDreamer 比树搜索高效 4–5×；墙钟 68.3/749.2/183.6 s 等 | arxiv-2411.06559.txt:557-603 | 论文声称（表 2） | high |
| 20 | 代码默认 num_of_sim=3、steps=1、num_workers=15、n=10 | repos/webdreamer/simulation_scoring.py:443-460、416-421 | 代码实现（默认参数） | high |
| 21 | WebATLAS：N 候选、critic 对每候选 D 步 roll-out；V(τ)·∏(1−U(s,a)) | arxiv-2510.22732.txt:372-374、464-475 | 论文声称（N、D 无数值） | medium |
| 22 | 重规划触发 ‖o_obs−ô_exp‖>ε（ε 未给值） | arxiv-2510.22732.txt:502-504 | 论文声称 | medium |
| 23 | SimuRA 抽象动作模拟缩短 roll-out、减少误差累积（无数字） | arxiv-2507.23773.txt:413-421 | 论文声称 | medium |
| 24 | Dreamer4 代码中想象视野是显式参数（horizon 传入 train_agent_in_imagination），但具体默认值未在所读区间确认 | repos/dreamer4/train_halfcheetah_imagination_rl.py:746、754、803 | 代码实现 | medium |

## 机制细节（可复用的设计参数）
- 状态表示：ITP/SimuRA 用自然语言状态；WebDreamer 只描述“动作造成的界面变化”（arxiv-2411.06559.txt:428）；WebATLAS 用认知地图三元组 (o,a,o')+LLM 摘要，模拟时检索真实转移（:436-451）。
- 分支/采样：WebDreamer = top-k 候选 → self-refine 删减 → 每候选 3 条轨迹（代码默认）→ H 步；WebATLAS = N 候选 × D 步 beam 式；ITP = 单条 K_t 步想象，无分支（:372-388）。
- 打分/剪枝：WebDreamer 三档分均值；WebATLAS V(τ)·∏(1−U)；ITP 无独立打分器，靠 LLM 反思 Reflect(τ̂) 后重选动作（:409-414）。
- 预算控制：ITP 用 λ_K 直接惩罚步长（训练期）+ K-head 采样（推理期）；WebDreamer 靠 H=1、候选剪枝、终止条件；WebATLAS 靠不执行真实动作与不确定性折扣，无调用次数上限。
- 可搬运到 Dreaming 的最小集：K_max 取 2 以内的小上界；只对“关键/冲突状态”开模拟；用 token/秒而非调用次数计量；用不确定性折扣而非 LLM 自信；先剪候选再模拟。

## 论文说 vs 代码做（若触达代码）
- 论文：“simulates multiple trajectories per action to capture a wider range of possible outcomes”（arxiv-2411.06559.txt:388）。代码默认 3 条、steps=1（repos/webdreamer/simulation_scoring.py:443-447）。
- 论文 Algorithm 1 写单次 score(sim(o_t,a))；代码对每个 (action, sim_idx) 跑一次 multiple_step_change_prediction(k=steps)，再 evaluate_simulation_inner(n=10) 多次打分（:427-429）→ 实际调用量 ≈ 候选数 × 3 × (1 次世界模型 + 10 次打分)，15 线程并发摊薄延迟（:447、453）。
- 论文把 K_max 推到附录 C（arxiv-2601.08955.txt:932）；代码配置写死 5（repos/itp/configs/itp_r.yaml:3）。
- 论文称 ITP_I “自适应选择” horizon（:407）；代码是一次随机采样 + 首整数解析，失败静默回退 1（repos/itp/itp/policy.py:64-69）——不是评估式选择。
- memento 仓库 27 个 py 文件、文件名无 horizon/q_value 等关键词命中 → 其代码层“检索预算”未验证。

## 线索与未解问题
- WebATLAS 的 N、D、ε 数值与调用次数/成本表：已读段落未见 → 未验证（需附录/表格）。
- Dreamer4 想象视野的默认值与“想象步数 vs 真实环境步数”的换算：未验证；这是最接近“离线 dreaming 值不值”的证据，建议 D2 下一轮补。
- PGR 的检索/推演预算数字：本次 grep 未命中相关段 → 未验证。
