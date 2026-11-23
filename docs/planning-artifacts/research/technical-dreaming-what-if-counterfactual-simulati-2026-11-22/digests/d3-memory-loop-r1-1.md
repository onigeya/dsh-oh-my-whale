# D3 digest — 模拟 ↔ 记忆的双向闭环（WebATLAS / Memento / PGR）
研究员: d3d6-memory-neighbors | 轮次: r1

## 结论（按重要性排序，每条一行主张）
1. 三篇论文里没有一篇把"模拟/想象产物"作为事实写回长期记忆：WebATLAS 写回的是经 memory agent 策展的转移摘要，Memento 写回的只有真实执行的 (s,a,r)，PGR 的想象探针只当查询用、从不入库——"假想不入库"是三者共同的默认防污染线。
2. WebATLAS 的模拟器不是 LLM 幻想状态，而是把记忆当转移函数查表：ô_{t+1}=M(o_t,a_t)，未命中节点返回通用占位观测；这让"记忆即世界模型"成为可实现的结构，而不是提示词约定。
3. WebATLAS 用转移不确定性折扣给想象轨迹打分：Ṽ(τ̂)=V(τ̂)·∏(1−U(s,a))——这是"假想可信度"唯一的显式数学形式，可直接映射为符号层的 confidence 折扣。
4. Memento 的"反事实分支"实际形态是检索到的成功+失败 case 列表，不是分支树、也不是假设轨迹：case=(s_t,a_t,r_t)，s 用冻结文本编码器向量化，a/r 保留原文。
5. Memento 把 Q 值放进记忆库的做法有代价，且代码实现与论文描述不一致：论文说 Write 时在线更新 Q 函数（Eq.15、§4.2），代码里是一个离线训练好的成对分类器对 (query, case) 打分，case bank 中没有存任何 Q 字段。
6. Memento 的 case bank 只增不删（Eq.12 是集合并），论文自己报告 K 增大后性能 plateau 甚至略降——这是"记忆只增不减会反噬"的直接证据。
7. PGR 把 query 展开成 L 个未来步骤探针（CoT 或 ToT 树），每个探针当作独立子查询去检索，再用检索到的事实在第 2 阶段重写探针，形成 simulate→retrieve→refine 的迭代闭环；终止条件是新增事实 |Δ^i|<δ 或达到 I_max。
8. PGR 的提升数字（MemoryQuest）：recall 0.723 vs Mem0 0.256 / GraphRAG 0.160；RecallExact 0.326 vs 0.015；query-only 基线总 recall 0.58。论文报告的唯一负面是成本（LLM 调用数），未报告任何数据集上"反而变差"的实证。

## 证据表
| # | 主张 | 证据定位 | 出处类型 | 置信度 |
|---|---|---|---|---|
| 1 | 三层记忆：Working / Cognitive Map(转移图) / Semantic(站点规则) | arxiv-2510.22732.txt:396-408 | 论文声称 | high |
| 2 | 认知地图单元 =(o_t,a_t,o_{t+1})，摘要强调"相邻观测的差异"与"新可用动作" | arxiv-2510.22732.txt:436-449 | 论文声称 | high |
| 3 | 检索键 (o_t,a_t) → o_{t+1}+摘要；未探索节点返回 generic placeholder | arxiv-2510.22732.txt:451-452 | 论文声称 | high |
| 4 | 模拟即查表：ô^i_{t+1}=M(o_t,a^i_t)，重复 D 次得到长度 D 的轨迹集 | arxiv-2510.22732.txt:464-472 | 论文声称 | high |
| 5 | 不确定性折扣打分 Ṽ=V·∏(1−U) | arxiv-2510.22732.txt:473-479 | 论文声称 | high |
| 6 | U(s,a) 的具体定义 | 正文未给出（475 行仅引用符号） | 未找到证据 | — |
| 7 | 重规划触发：‖o_obs−ô_exp‖>ε；计划更新用 memory writer 蒸馏的 exploration digest | arxiv-2510.22732.txt:502-511 | 论文声称 | high |
| 8 | 模拟期间可更新记忆，retain/update/forget 由 memory agent 决定 | arxiv-2510.22732.txt:513-517 | 论文声称 | high |
| 9 | 记忆构建：好奇心探索 + LLM 轨迹挖掘成摘要，固定 memory budget | arxiv-2510.22732.txt:420-432 | 论文声称 | high |
| 10 | case=(s_t,a_t,r_t)，Write 为集合并 | arxiv-2508.16153.txt:515-522 | 论文声称 | high |
| 11 | 非参数检索 = cosine top-K；参数检索 = Q top-K | arxiv-2508.16153.txt:525-535, 557-562 | 论文声称 | high |
| 12 | 检索结果是"成功与失败 case 的混合"，作为类比参考注入规划 | arxiv-2508.16153.txt:525-527 | 论文声称 | high |
| 13 | Q 目标为单步（无 bootstrap）二分类 CE，r∈{0,1} | arxiv-2508.16153.txt:539-555 | 论文声称 | high |
| 14 | K 增大后性能 plateau/略降，"小而高质量的记忆"更优 | arxiv-2508.16153.txt:1165-1166 | 论文声称 | high |
| 15 | 代码：Q 是成对分类器 softmax[:,1]，非记忆库中的 Q 字段 | repos/memento/memory/parametric_memory.py:10-45 | 代码里实际实现 | high |
| 16 | 代码：非参数检索为 cosine top-k，无剪枝/淘汰 | repos/memento/memory/np_memory.py:65-101 | 代码里实际实现 | high |
| 17 | PGR 两阶段：初始探针 S^0 与个性化探针 S^i；Δ^i 为迭代新事实 | arxiv-2605.14177.txt:363-415 | 论文声称 | high |
| 18 | 超参 δ=5, I_max=10, K=5/探针, τ=0.3, τo=0.6 | arxiv-2605.14177.txt:571-572 | 论文声称 | high |
| 19 | MemoryQuest: 0.723 vs 0.256 vs 0.160；RecallExact 0.326 vs 0.015；query-only 0.58 | arxiv-2605.14177.txt:677-682 | 论文声称 | high |
| 20 | 唯一负面=计算开销大、不适合实时；未报告质量下降的数据集 | arxiv-2605.14177.txt:790-791 | 论文声称 | high |

## 机制细节（可复用的设计参数）
- 经验单元（WebATLAS）：三元组 + 两段摘要（观测 diff、新增 affordance）+ 原始观测并存（fidelity 与 abstraction 双轨）。检索键是 (状态, 动作)，不是纯状态。
- 经验单元（Memento）：state_text→向量, action 原文, reward 0/1；粒度是"一条轨迹的最终步"（论文称只把每条轨迹最后一步写入，保持 case bank 紧凑）。
- 分支/采样：WebATLAS 对全部候选动作各模拟 D 步（等价 beam search，宽度=候选数）；PGR 的分支是探针树（ToT），每层 L 个节点，靠检索结果重写；Memento 无分支，K 个 case 并列。
- 打分/剪枝：WebATLAS 唯一显式打分 = 不确定性折扣后的价值；PGR 无打分，靠"新增事实数"收敛；Memento 用 Q 或 cosine 排序后 TopK，无淘汰。
- 预算控制：WebATLAS 固定 memory budget + 探索子代理数量；PGR 用 δ/I_max 双终止；Memento 用 K（但论文发现 K 大有噪声）。
- 防污染位置：WebATLAS 的 memory agent 是唯一写入闸门（retain/update/forget 三选一）；Memento 的闸门是"只写真实执行步"；PGR 的闸门是"探针不入库"。

## 论文说 vs 代码做（若触达代码）
- Memento 的 Q 值：论文 512-513 行称 parametric 设置的 Write 会在线更新 Q 函数、Read 由学到的 Q 驱动；代码 parametric_memory.py 只做 load_state_dict(torch.load(model_path)) 后成对打分（10-31 行），retrieve() 对全池打分返回 score（33-45 行）。case bank 里没有 Q 字段，也没有 Write 时的在线更新路径。→ 论文的"Q 值存进记忆库"在代码里是"外挂一个打分模型"，代价从"库内元数据"变成"一个需要离线训练与 GPU 推理的分类器"。
- Memento 的相似度：论文 Eq.13 写 cosine similarity（534-535 行）；非参数代码一致（np_memory.py:85-87）。参数化路径的"相似度"实际是分类器概率，与 cosine 不同源。
- WebDreamer 打分（为 D6 佐证，非本维度主张）：simulation_scoring.py:114-149 对每个候选做 n=20 次采样（按模型数均分），解析 Status: success/failure 与 On the right track 映射为 1.0/0.5/0.0，取均值；解析失败默认 0.0。即打分是蒙特卡洛投票，不是单次 LLM 评判。
- 未验证：WebATLAS / PGR 无可读仓库，其记忆写入与探针实现只有论文正文依据；ITP、Dreamer4 代码未纳入本维度。

## 线索与未解问题
- WebATLAS 的 U(s,a) 没有定义 → 若要在符号层复刻"不确定性折扣"，需自定义（例如来源指针缺失、时间衰减、冲突计数）。
- Memento 只把轨迹最后一步写库，等价于"每个 episode 只留一个决策点"；与 Dreaming 的重放抽样粒度问题直接对应，值得与其他维度交叉验证。
- PGR 的探针是"未来步骤"而非"反事实分支"，它优化的是召回不是决策；把它当 What-If 用会偏离原论文的适用面。
- 三者都没有"假想记录"的独立存储与 provenance 字段——没有任何论文给出"如何区分假想与真实"的正例，只有"干脆不写"的负例。这是本项目若要落地需自创的部分。
