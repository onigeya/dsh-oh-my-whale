# 来源抽取：记忆架构线（agent-memory-architectures）

来源目录：`docs/planning-artifacts/research/technical-agent-memory-architectures-2026-11-22/`（research.md 194 行 + 10 份 digests）

## 一句话结论

最值得进产品的是「写入侧去重 + 写放大抑制」这一对成本很低的过滤机制——它们补的空白在 FR-22 与 FR-2 之间：该不该记已有规定，记重了、记了等于没记尚无规定。

## 候选能力

| # | 候选能力 | 一句话能力 | 研究出处 | 现状 | 融入方式 | 依赖与风险 |
|---|---|---|---|---|---|---|
| 1 | 写入侧双层去重 | 精确 hash 命中并回旧条，近重复按旗标待裁 | `digests/cerebrocortex.md:69,76`；`digests/mem0.md:46,107`；`research.md:150` | 未规划 | 扩 FR-22 准入：精确层必做、近重复记 flag 不进断言；E4 增量 story | 近重复阈值误合并，须可撤销 |
| 2 | 写放大抑制 | 补丁与库内版本比 kind/content，无变化才写 | `digests/langmem.md:56,114` | 未规划 | E4 增量 story：不变则不落新版本、不记账本 | 与 FR-3「每次改写记链」要划清 |
| 3 | 读时衰减投影 | 幂律激活 + 对数 rehearsal，只算分不写回 | `digests/elo-memory.md:143-144,178-180`；`research.md:126-127,161` | 仅占位（AD-8:100 一句 Rule，无公式、无字段） | 补 AD-8 附录 + E5 增量 story：系数入 config，分数只进审计行 | 缺实测收益，须配开/关对照 |
| 4 | 热度晋升与归档 | 命中过阈值升级，长期不命中只归档不删 | `digests/memoryos.md:138-151,155-156`；`research.md:160` | 仅占位 | 落 E6 第⑥步：确定性晋升写 dream_log，归档=置 valid_to | 热度禁写回，只留读时投影 |
| 5 | 实体别名归并 | 同一实体的不同写法并成一条 | `digests/tencentdb.md:98-102`；`digests/mem0.md:77`；`review-adversary.md:97` | 部分采纳（有 entity 与 aliases[]，无归并规则） | E6 第⑦步增量：确定性合并 + 冲突挂 flag | 误并不可逆，靠撤销与 flag 兜底 |
| 6 | 召回阈值量纲校准 | 相关性下限要在重排分数分布上定 | `research.md:129-130`；`digests/reflex-ai.md:239-245,339` | 部分采纳（AD-45 有 relevanceFloor=0.5，无量纲依据） | E5 增量 story：合成语料定拐点，写成一条不变量 | 换重排模型须重校 |
| 7 | 每日只读简报 | 每日一份未决 flag 与在办摘要，落文件 | `digests/nmem.md:97,127`；`research.md:72` | 未规划 | 扩 FR-23 加 `/omw brief`，只出文件不进注入；推送留 Deferred | 边界贴「主动搭话」非目标 |

## 要点

1. 第 1、2 条要先做：研究里九家只有 LangMem 有「真变才写」这条硬机制（`digests/langmem.md:56`），而 mem0 的去重窗口只覆盖 top-10 旧条（`digests/mem0.md:107`）——去重窗口本身就是设计变量，不写清等于默认漏检。
2. 第 3、4 条不是重新引入被否方案。`rejected-approaches.md:11` 否的是 FSRS+ACT-R 双理论，同一行的「v1 的做法」恰恰写着「幂律 + 对数 rehearsal 只作排序因子」；`AD-8:100` 只给了这条定性句子，公式与字段都没有落点，等于原则存在、实现不存在。
3. 第 5 条是既有缺口的同类延伸：谓词已有显式 aliases 合并（`data-model.md:87`），实体只有 `aliases[]` 字段却没有归并路径，`上海`/`上海市` 会分裂成两条互不相关的链（`review-adversary.md:97`）。
4. 明确不该进：因果边 DAG（`digests/elo-memory.md:187-189` 自己写「别照抄这一层」，纯英文正则 + 整句 key 会迅速碎图）；时间邻域扩张（`digests/elo-memory.md:181-183` 承认 DSH 检索对象不是等间隔对话，±30 分钟窗口无意义）；governor 延迟奖励记账（`digests/elo-memory.md:190-192`，奖励依赖 episode_id 出现在后续检索，而 DSH 会摘要改写、id 不稳）。
5. 第 7 条必须限定成「只落文件」。一旦推送就成了主动搭话，那是非目标，也破「不主动打扰」这条人格约束——价值在可查，不在敲门。

## 建议归属

全部落现有 Epic 3–7 的增量（1/2→E4，3/6→E5，4/5→E6，7→FR-23 扩命令），不建议开 Epic 8：这些是既有 FR/AD 的缺口补齐，不是新能力面，单独立 epic 只会让编号膨胀。唯一可能值得独立的是容量与冷存归档（`digests/elo-memory.md:148,193-195`），但它已挂在骨架 Open Question 3，属等实测数据再兑现，现在不开。
