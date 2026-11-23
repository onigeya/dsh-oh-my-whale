# D4 digest — 可靠性边界：LLM 世界模型什么时候不可信
研究员: d2d4-budget-reliability | 轮次: r1

## 结论（按重要性排序，每条一行主张）
1. **四篇里最核心的可靠性问题是“模拟内动作幻觉”，而它不是被检测出来的，是被缩短深度压下去的。** WebDreamer：模拟中的动作提议偏向“看起来相关”的动作，即使该动作在预测状态下不可用；horizon 增到 2–3 时不同动作的模拟轨迹“都显得大致正确”、彼此不可区分（arxiv-2411.06559.txt:637-639）。处置方式：回到 H=1（:464）。
2. **有明确的“模拟负收益”陈述（方向性，无数字）：直接模拟全部候选动作会引入额外噪声、反而损害性能，所以必须先 self-refine 剔除不相关候选。** arxiv-2411.06559.txt:623-625。同构证据：ITP 称过度 roll-out 会放大模型误差（arxiv-2601.08955.txt:397），fixed-k 成功率峰值后下降（:934）。
3. **WebATLAS 直接否定“让 LLM 凭想象预测结果”的可信度**：“LLMs are not explicitly trained to be a world model, this behavior is prone to hallucination and is not robust enough”（arxiv-2510.22732.txt:487）。其替代方案是把模拟锚定在真实观测过的转移上（认知地图）。
4. **WebATLAS 是唯一给出显式校准机制的：用转移不确定性 U(s,a) 对轨迹价值连乘折扣 Ṽ(τ)=V(τ)·∏(1−U(s,a))。** arxiv-2510.22732.txt:473-477。但 U 如何计算、ε 取值多少，已读段落未给 → 未验证。
5. **WebATLAS 还给了“模拟与真实不一致”的运行时处置：观测偏离预期超过 ε 就重规划**（replan=1[‖o_obs−ô_exp‖>ε]，:502-504）；认知地图命中未探索节点时返回“通用占位观测”（:452）——承认覆盖空洞，用占位符而非编造兜底。
6. **ITP 的“自适应深度”不是校准：代码是 temperature=0.8 采样 + 首整数解析，失败静默回退 K=1**（repos/itp/itp/policy.py:48-69）。即深度选择本身带随机性、且没有风险/置信度输入；解析失败时系统仍继续决策，不报错、不降级标记。
7. **SimuRA 的可靠性主张只有一句自述、无数字：“概念级分解在实践中减少幻觉、使规划更稳健”**（arxiv-2507.23773.txt:406）；同时承认顺序 roll-out 会增加多步低层预测的误差累积机会（:415-416），对策是抬高抽象层级、缩短 roll-out（:421）。
8. **Memento 走“不模拟、改用可验证经验检索”路线：用成功/失败案例库替代想象，用 SimpleQA 度量抗幻觉，并报告“离线执行器→实时工具通常降低幻觉”。** arxiv-2508.16153.txt:1001-1003、522-526、1383。说明有 ground truth 的域，检索优于生成式模拟。
9. **对“低算力、长时程、无环境回放”的陪伴/个人助理场景，论文证据支持：多步生成式推演（WebDreamer H≥2、SimuRA 深层 atomic roll-out）不可信；可迁移的是“检索真实转移 + 不确定性折扣 + 偏差触发重规划”。** 依据：负收益与幻觉累积都出现在“深度↑ + 纯生成”组合（arxiv-2411.06559.txt:637-640、arxiv-2601.08955.txt:397/934），而 WebATLAS 的可信度来源正是真实观测（:487、451-452）。**注意：没有论文在该场景做过实验，此条属推断而非实测。**
10. **没有任何论文报告“模拟后决策更差”的量化数字（如 SR 下降 X 点）。** 负收益只有趋势图与定性句（WebDreamer 图 4/5、ITP 图 4a）→ 幅度未报告。
11. **代码层存在论文未提的失真来源：WebDreamer 的单次模拟用裸 except 吞掉异常并返回 None，模拟失败被静默丢弃、不计入统计。** repos/webdreamer/simulation_scoring.py:426-431。

## 证据表
| # | 主张 | 证据定位 | 出处类型 | 置信度 |
|---|---|---|---|---|
| 1 | 模拟内动作提议幻觉：偏向“看似相关”但预测状态下不可用的动作 | arxiv-2411.06559.txt:637-639 | 论文声称 | high |
| 2 | H=2/3 时轨迹彼此不可区分、误差累积；H=1 最优 | arxiv-2411.06559.txt:464、637-640 | 论文声称 | high |
| 3 | 直接模拟全部动作引入噪声、负向影响性能 | arxiv-2411.06559.txt:623-625 | 论文声称 | high |
| 4 | 去掉 self-refine 性能下降（无法过滤明显不相关候选） | arxiv-2411.06559.txt:623-624 | 论文声称 | high |
| 5 | 过度 roll-out 放大模型误差；fixed-k 成功率峰值后下降 | arxiv-2601.08955.txt:397、934 | 论文声称（趋势图） | high |
| 6 | LLM 未被训练为世界模型，凭想象预测易幻觉、不够稳健 | arxiv-2510.22732.txt:487 | 论文声称 | high |
| 7 | 校准：Ṽ(τ)=V(τ)·∏(1−U(s,a)) | arxiv-2510.22732.txt:473-477 | 论文声称（U 定义未在所读段） | medium |
| 8 | 偏差触发重规划：‖o_obs−ô_exp‖>ε | arxiv-2510.22732.txt:502-504 | 论文声称（ε 无数值） | medium |
| 9 | 认知地图未命中→通用占位观测（承认覆盖空洞） | arxiv-2510.22732.txt:451-452 | 论文声称 | high |
| 10 | 可信度来自“真实观测”而非 LLM 生成 | arxiv-2510.22732.txt:485-487 | 论文声称 | high |
| 11 | SimuRA：概念分解“实践中减少幻觉”（无量化） | arxiv-2507.23773.txt:406 | 论文声称（弱证据） | medium |
| 12 | SimuRA：顺序 roll-out 低效且增加误差累积；抬高抽象层级缓解 | arxiv-2507.23773.txt:413-421 | 论文声称 | medium |
| 13 | 无环境 grounding 的 LLM 会幻觉答案（Kayak 例） | arxiv-2507.23773.txt:506-512 | 论文声称（示例） | high |
| 14 | Memento 用 SimpleQA 抗幻觉；案例库积累成功/失败经验 | arxiv-2508.16153.txt:1001-1003、522-526 | 论文声称 | medium |
| 15 | 离线执行器→实时工具“通常降低幻觉” | arxiv-2508.16153.txt:1383 | 论文声称 | medium |
| 16 | 作者自陈局限：世界模型表征“仍在婴儿期”，需要真正 counterfactual what-if；鲁棒性须用 UI 漂移/鉴权/随机失败/长时程压力测试来测 | arxiv-2510.22732.txt:739、747 | 论文声称（自陈） | high |
| 17 | ITP decide_k 为 0.8 温度采样 + 首整数解析，异常回退 K=1 | repos/itp/itp/policy.py:48-69 | 代码实现 | high |
| 18 | WebDreamer 模拟异常被裸 except 静默丢弃（return None） | repos/webdreamer/simulation_scoring.py:426-431 | 代码实现 | high |
| 19 | PGR 未找到关于模拟幻觉/校准的陈述（grep hallucin/unreliab/miscalibrat 仅命中 HTML 转换样板） | arxiv-2605.14177.txt | 未找到证据（阴性） | high |
| 20 | Dreamer4 代码中未命中 exploit 相关处理（仅查 train_halfcheetah_imagination_rl.py） | repos/dreamer4/train_halfcheetah_imagination_rl.py（grep exploit n=0） | 未找到证据（阴性，单文件） | medium |

## 机制细节（可复用的设计参数）
- 失真检测手段（实际做法）：① 深度上限（WebDreamer H=1）；② 候选预剪枝（self-refine，防模拟噪声）；③ 观测-预期偏差阈值触发重规划（WebATLAS ε）；④ 不确定性折扣（WebATLAS U 连乘）；⑤ 未命中返回占位符而非生成（WebATLAS）。
- 校准：只有 WebATLAS 有显式不确定性折扣；无人做概率校准（如 ECE），也无人做“模拟-真实”一致性离线评测集（本次取证范围内未找到）。
- 负收益规避设计：WebDreamer 的“先剪枝再模拟”本质是“少模拟”换稳定；ITP 的 λ_K 直接给“多想象”记负分；代码层无任何“模拟质量门”——失败即丢弃。
- 对 Dreaming 的边界建议（基于上述证据）：可做“对已发生真实交互的重放式反事实”（有 ground truth 可校验）；不可做“多步自由生成的人际/情绪后果推演”（无回放、无校验，正是 WebDreamer 报告失效的区间）。

## 论文说 vs 代码做（若触达代码）
- 论文强调“模拟多条轨迹以覆盖更广结果分布”（arxiv-2411.06559.txt:388），代码默认每条动作 3 条、深度 1（repos/webdreamer/simulation_scoring.py:443-447）。
- 代码 single_action_simulation 失败即 return None（:426-431），上层只收集 result 为真的项（:464-465）→ 模拟失败被静默排除，成功率统计不含“模拟崩了”的样本。论文未提这一点。
- 论文称 ITP_I 自适应选步长（:407），代码是随机采样+回退（repos/itp/itp/policy.py:48-69）；K_max 论文推给附录 C，代码默认 5（repos/itp/configs/itp_r.yaml:3）。
- memento / dreamer4 的可靠性相关实现（案例库打分、模型利用防护）本次仅做关键词级检索，未做代码级确认 → 未验证。

## 线索与未解问题
- U(s,a) 的定义、ε 取值、占位观测对决策质量的影响幅度：未验证（需读 WebATLAS 附录）。
- 是否存在“关掉模拟后 SR 上升”的定量消融：未找到；WebDreamer 的 Reranking 对照只说明“模拟有用但增益有限”。
- Dreamer4/Dreamer V3 的“想象训练导致策略利用模型漏洞（model exploitation）”证据：未取证，建议下一轮补——这是可靠性维度最关键的一类负收益。
