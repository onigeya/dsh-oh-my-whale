# D6 digest — 近邻方法：Dreamer 4 / Dreamer V3 的可迁移与不可迁移边界
研究员: d3d6-memory-neighbors | 轮次: r1

## 结论（按重要性排序，每条一行主张）
1. 不可迁移的核心：Dreamer 的"想象"之所以有价值，是因为想象轨迹能回传梯度去更新 policy/value/world-model；符号记忆层没有可微潜空间、没有梯度，把同一套 rollout 搬过来只能得到文本轨迹，无法"在想象中训练"，只能用于检索与排序。
2. 具体不可迁移的四件：RSSM 隐状态 {h_t,z_t} 与 KL/重建损失（V3）、diffusion + shortcut forcing 的连续潜空间（D4）、tokenizer 的量化潜变量、value/reward head 的 TD/λ-return 梯度学习（两者）。
3. 可迁移之一——回放采样策略：想象 rollout 必须从真实数据的 context 起步（D4:482），且每个 context 只开 1 条 rollout 以保多样性、省内存（D4:483）；replay ratio 越大越稳（V3:401）。符号层对应做法：Dreaming 的每条 What-If 必须锚定一条真实 L1 事实/场景作为起点，一锚点一分叉。
4. 可迁移之二——想象轨迹的用途：Dreamer 用于训练（policy 改进），WebATLAS/WebDreamer 用于决策时的 lookahead 打分。符号层只能取后者：想象产物作为候选排序/检索扩展的上下文，不能作为学习信号。
5. 可迁移之三——真实信号校正：Dreamer V3 把 critic loss 同时加在 replay 的真实起点上（β_repval=0.3），用想象 return 作 on-policy 标注；这是"想象必须被真实数据钉住"的机制原型。符号层的等价物是"每条假想必须挂真实来源指针 + 执行后回填结果"。
6. 论文自己承认 LLM 世界模型不可靠：WebATLAS 直言 LLM 未被训练成世界模型、易幻觉，因此改用真实观测查表；WebDreamer 把失败主因归为"模拟中的动作提议幻觉"；ITP 指出"过度 rollout 会放大模型误差"并据此做自适应 horizon。
7. Horizon 不该是常数：ITP 用 K_t∈{0,…,K_max} 按任务进度自适应选择（论文声称），与 Dreaming 批式推演的"每次推几步"直接对应。

## 证据表
| # | 主张 | 证据定位 | 出处类型 | 置信度 |
|---|---|---|---|---|
| 1 | V3 world model 为 RSSM，把观测编码为离散表示 z_t | arxiv-2301.04104.txt:163-164 | 论文声称 | high |
| 2 | actor/critic 纯在想象轨迹上学习，状态 s_t={h_t,z_t} | arxiv-2301.04104.txt:264-266 | 论文声称 | high |
| 3 | 想象 horizon T=16，用 λ-return bootstrap 跨越 horizon | arxiv-2301.04104.txt:269, 278-283 | 论文声称 | high |
| 4 | critic loss 同时施加于 replay buffer 起点，β_repval=0.3 | arxiv-2301.04104.txt:298-300 | 论文声称 | high |
| 5 | replay ratio 越高性能越好（与模型规模并列的可调杠杆） | arxiv-2301.04104.txt:401 | 论文声称 | high |
| 6 | D4 world model 基于 diffusion，需 shortcut forcing 才能实时 | arxiv-2509.24527.txt:190, 217, 252 | 论文声称 | high |
| 7 | D4 tokenizer 把图像压到低维潜空间，动力学在潜空间展开 | arxiv-2509.24527.txt:348, 363-367 | 论文声称 | high |
| 8 | D4 想象 rollout 从数据 context 起步，每 context 仅 1 条 | arxiv-2509.24527.txt:482-483 | 论文声称 | high |
| 9 | D4 rollout 由 transformer 自回归展开，z 来自 flow head、a 来自 policy head | arxiv-2509.24527.txt:484-485 | 论文声称 | high |
| 10 | D4 只更新 policy/value 头，transformer 冻结 | arxiv-2509.24527.txt:471-472 | 论文声称 | high |
| 11 | D4 策略目标 PMPO 只用 advantage 符号，忽略幅度 | arxiv-2509.24527.txt:495-498 | 论文声称 | high |
| 12 | D4 value head 用 TD 学 λ-return，γ=0.997 | arxiv-2509.24527.txt:487-491 | 论文声称 | high |
| 13 | LLM 未被训练为世界模型、易幻觉，故 WebATLAS 改用真实观测 | arxiv-2510.22732.txt:487 | 论文声称 | high |
| 14 | WebDreamer 把失败主因归为模拟内动作提议幻觉 | arxiv-2411.06559.txt:638 | 论文声称 | high |
| 15 | WebDreamer 在提示中声明"模拟状态由世界模型预测，可能不真实" | arxiv-2411.06559.txt:1419 | 论文声称 | high |
| 16 | ITP：短 horizon 漏长依赖，过度 rollout 放大模型误差且浪费算力 | arxiv-2601.08955.txt:397 | 论文声称 | high |
| 17 | ITP 用 K-head 预测 horizon 分布 K_t∈{0..K_max}，按目标与进度自适应 | arxiv-2601.08955.txt:372, 407, 423-430 | 论文声称 | high |
| 18 | WebDreamer 打分=20 次采样投票，1.0/0.5/0.0 取均值 | repos/webdreamer/simulation_scoring.py:114-149 | 代码里实际实现 | high |
| 19 | D4/V3 想象训练循环的代码实现细节 | 未读 repos/dreamer4（30 文件） | 未找到证据 | — |

## 机制细节（可复用的设计参数）
- 状态表示（不可照搬）：V3 = 离散潜变量 z_t + 递归 h_t；D4 = diffusion 潜 token + transformer。两者都要求"预测下一潜状态"可微。符号层没有连续"下一状态"，只有文本。
- 分支/采样：D4 一个 context 一条 rollout，靠 batch 内大量不同 context 提供多样性；V3 一次想象 T=16 步。没有树搜索，没有分支剪枝——V3 明说动作直接从 actor 采样、不做 lookahead planning（265 行）。
- 打分/剪枝：Dreamer 没有"给轨迹打分再剪枝"，只有 value 函数 + λ-return；剪枝发生在符号层方法（WebATLAS/WebDreamer），不在 Dreamer。
- 预算控制：horizon 固定（V3 T=16）或自适应（ITP K_t）；replay ratio 是主要成本杠杆（V3:401）。
- 真实信号校正点：① critic 在 replay 起点上的 loss（V3:298-300）；② D4 的 reward head 给想象轨迹打奖励（485）；③ WebATLAS 的 replan 触发（‖o_obs−ô_exp‖>ε，504 行）；④ WebATLAS 的不确定性折扣（475 行）。

## 论文说 vs 代码做（若触达代码）
- "Dreamer 会做 lookahead 规划"是常见误读：V3 正文 265 行明确 select actions by sampling from the actor network without lookahead planning。Dreamer 的"想象"发生在训练时，不是推理时。搬用到记忆插件时，这一条决定了它只能对应"离线 Dreaming 阶段"，不能对应"在线决策"。
- WebDreamer 的评分实现（唯一代码级验证）：n=20 次采样、多模型均分、解析失败即 0.0（simulation_scoring.py:121-144）。这意味着打分离散度大且失败会静默降为最差分；与论文口径的差异未在本次取证范围内核对（未读其评分章节）。
- 未验证：dreamer4 仓库（30 文件）、itp 仓库（150 文件）未读；上述 Dreamer 相关结论全部来自论文正文，不是代码。

## 线索与未解问题
- Dreamer 4 的"每 context 一条 rollout"与 Memento 的"每轨迹只存最后一步"是同一种去冗余直觉，可作为 Dreaming 重放抽样的一条硬约束候选。
- ITP 的 K-head 需要监督信号（用 teacher-forced 专家动作 rollout 反推 horizon），符号层没有"专家动作"，替代方案未找到证据。
- "想象轨迹必须被真实信号校正"在 Dreamer 里是 loss 项，在 WebATLAS 里是 replan 触发器；符号层最接近的是"假想→假设→下次真实交互时验证→回填命中/落空"，三篇论文均未实现该闭环，属未找到证据。
