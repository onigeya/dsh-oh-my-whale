# 规则本体与改写审计（d1a）digest

范围：Stop Slop、Humanizer、Humanizer-zh、Caveman 四个仓库的"规则本体形态 / 是否真有检测打分 / 改写与事实保护 / 少 token 机制 / 许可与成熟度"。全部证据取自 2026-11-22 本次运行中通过 GitHub API 与 raw 文件实际取到的内容；未使用训练记忆，未读取本项目任何文件。

## 范围与结论（≤5 条）

1. 四个项目里只有 Caveman 一处是**可执行代码**（Go 代理 + Python 压缩/校验脚本 + 金样本测试）；Stop Slop 是纯提示词，Humanizer 与 Humanizer-zh 是"纯提示词 + 一个只校验包结构或受保护片段的脚本"，没有一个是"正则引擎在做风格检测"。
2. **没有任何项目提供可复现的风格打分**：Stop Slop 的 1–10×5 维、<35/50 重写是让模型自评；Humanizer 连自评分都没有，只有"前五条一见即改、弱信号需共现"的分诊规则；Humanizer-zh 明文禁止用自评分替代核对；Caveman 有真实评测脚本，但自己的 HONEST-NUMBERS 承认没有提交可复核的保真度快照。
3. 改写策略全是**重写而非最小编辑**（Humanizer 原话 "State each point directly instead of patching flagged phrases one at a time"），事实保护靠提示词白名单 + 同轮自检；只有 Humanizer-zh 把它落成了一个真会跑的结构 diff 脚本（对比 YAML/代码/标题/链接/表格/ID）。
4. 中文版的口语套话**不是硬规则也不是词表**："值得一提/综上所述/从某种意义上"在 31 条规则里出现 0 次，只由第 31 条"套话收尾"用改写前/改写后/保留三例示范，并明写"模式清单是检查线索，不是词语黑名单"。
5. Caveman 与"人性化"目标**方向相反**：它的规则是去仪式化、电报体、20 词上限（ASD-STE100 作下限），并专设"Never perform caveman"禁止"me think"式表演；它省 token 靠输出风格约束（输入 0%）+ 内容寻址的可逆压缩（CCR），对"更像人"没有正面证据。

## 证据表

| # | 主张 | 来源（URL 或 仓库路径:行号） | 发布者 | 日期 | 访问日期 | 置信度 | 类别 |
|---|---|---|---|---|---|---|---|
| 1 | Stop Slop 本体是 1 个 SKILL.md（2629 B）+ 3 个 references（phrases/structures/examples），全仓库 7 个文件、无任何 .py/.js/.sh | https://github.com/hardikpandya/stop-slop ；`git/trees/HEAD?recursive=1` 全量 7 blob；SKILL.md §Core Rules 1–8 | hardikpandya | pushed 2026-03-17 | 2026-11-22 | 高 | 一手代码 |
| 2 | Stop Slop 的规则是 8 条核心规则 + 12 条 Quick Checks + phrases.md（8 类词表：开场废话/强调拐杖/商业黑话/副词/元评论/表演式强调/告知而非展示/空洞断言）+ structures.md（11 类结构：二元对比/否定式列举/戏剧化碎片/修辞铺垫/公式化句式/虚假施事/远距叙述/被动/Wh- 开头/节奏/词汇） | `references/phrases.md`、`references/structures.md` 各级标题 | hardikpandya | 同上 | 2026-11-22 | 高 | 一手代码 |
| 3 | Stop Slop 有"打分"但不可复现：5 维（Directness/Rhythm/Trust/Authenticity/Density）各 1–10，<35/50 重写；无公式、无测试、无样例打分 | SKILL.md §Scoring；README.md §Scoring（同文重复） | hardikpandya | 同上 | 2026-11-22 | 高 | 自评宣称 |
| 4 | Humanizer 实际是 **26 条模式 / 6 个分组（A–F）**，不是"5 大类"：A 铺垫代替陈述(1–5)、B 公式化节奏(6–11)、C 拔高与借权威(12–18)、D 公式化排版(19–21)、E 聊天与草稿残留(22–25)、F 写给错的读者(26)；"5"是 README 的"五个最强信号" | README.md:19（five strongest tells）、:29（26 patterns）、:121–181（A–F 分组表）；SKILL.md:57/171/247/353/402/470 六个 H2 | blader | pushed 2026-11-19 | 2026-11-22 | 高 | 一手代码 |
| 5 | Humanizer 的分诊规则是"前五条一见即改，标 weak alone 的需与其它信号共现"，属规则层阈值而非数值分 | README.md:123；SKILL.md:492 | blader | 同上 | 2026-11-22 | 高 | 一手代码 |
| 6 | Humanizer 的"测试"只校验包结构：编号 1..N 连续、README 表名与 SKILL.md 一致、README 标题必须是 "The N patterns"、§引用不越界、SKILL.md ≤5500 词、四个清单版本号一致；不检查任何文本风格 | `scripts/validate-package.py`（numbered_patterns / skill_words > 5500 / "Title the README pattern section"）；`.github/workflows/validate.yml` 三步（validate-package.py、skills add --list、claude plugin validate） | blader | 同上 | 2026-11-22 | 高 | 一手代码 |
| 7 | Humanizer 是重写：四步为标记→重写→查草稿→写终稿，明写"不要逐条打补丁"，且指示"文本空泛时补一个你知道为真的具体细节，没有就问用户" | SKILL.md:36–39（第 39 行原话）、:37 | blader | 同上 | 2026-11-22 | 高 | 一手代码 |
| 8 | Humanizer 的事实保护是提示词级白名单：文件模式保留代码块/行内代码/命令/路径/YAML/数据/链接目标，只改散文，并报告审了多少节、哪些节没覆盖；第 3 步列出最易丢事实的 §6/§9/§19 并要求把丢失主张当错误 | SKILL.md:53、:38 | blader | 同上 | 2026-11-22 | 高 | 一手代码 |
| 9 | Humanizer README 的"盲测 16/16 偏好"是自链 issue #229 的宣称，不是可复核 benchmark | README.md:15 → github.com/blader/humanizer/issues/229 | blader | 同上 | 2026-11-22 | 低（仅宣称） | 文档宣称 |
| 10 | Humanizer-zh 是 **31 条 / 6 组**：A–E 沿用上游 25 条，F 组 26–31 为中文特有（层叠"的"、"进行+动词"、被字句堆叠、四字词排比、"随着……的发展"、套话收尾） | SKILL.md:60–383 各级 H2/H3（60/112/174/246/278/320 六个 H2；26–31 在 320–383） | op7418 | pushed 2026-09-23 | 2026-11-22 | 高 | 一手代码 |
| 11 | 中文版有真会跑的守门脚本：`tests/check_structure.py` 用正则在改写前后各抽 8 类受保护片段（frontmatter、围栏代码、行内代码、标题、链接目标、表格行、有序步骤、显式 id），全等才 exit 0 | `tests/check_structure.py`（protected_parts / "passed": all(checks.values())） | op7418 | 同上 | 2026-11-22 | 高 | 一手代码 |
| 12 | 中文版的"测试"是 18 条人工核对用例 + 1 个结构脚本，自述"单次运行不代表稳定通过率，没有固定采样参数，也没有跨模型测试"，且明确不检测文章是否 AI 所写 | `tests/README.md`（"本次验证范围"段）、`tests/fixtures/cases.json` 18 条 id | op7418 | 同上 | 2026-11-22 | 高 | 一手代码 |
| 13 | 中文版把"保留信息与确定程度"列为第 1 优先级，明写"不增加原文或用户未提供的事实、数字、名字…不把相关改成因果、可能改成确定、计划改成已经完成"，且"不能用虚构的数据使句子显得具体" | SKILL.md:21–23、:28 | op7418 | 同上 | 2026-11-22 | 高 | 一手代码 |
| 14 | 三个套话词在中文版规则里出现 0 次；处理方式是第 31 条"套话收尾"的改写前/改写后/保留三例，并声明"模式清单是检查线索，不是词语黑名单""单个词…不是修改理由" | SKILL.md:374–382、:56；全文 grep `值得一提\|综上所述\|从某种意义上` 命中 0 | op7418 | 同上 | 2026-11-22 | 高 | 一手代码 |
| 15 | Caveman 规则本体是 1 个 SKILL.md（89 行）+ 9 条规则 + "何时破例"7 项 + 发送前 4 问；另有 ultracave/megacave 两个变体技能 | `plugins/caveman/skills/caveman/SKILL.md` §Rules 1–9、§When to break the rules、§Pre-send check | JuliusBrussee | pushed 2026-11-22 | 2026-11-22 | 高 | 一手代码 |
| 16 | Caveman 的规则是输出风格约束而非输入压缩："Skill itself does not compress input, context, files, or model thinking tokens"，输入削减 0% | `docs/HONEST-NUMBERS.md` §What the response skill does、表中 "Input reduction from the skill = 0%" | JuliusBrussee | 同上 | 2026-11-22 | 高 | 一手代码 |
| 17 | "every original recoverable" 由 CCR 实现：原始字节存本地 SQLite，句柄 `ccr_` + SHA-256 前 16 字节 hex（内容寻址），取回命令 `caveman tools retrieve ccr_…`，MCP 侧有对应工具；默认库 `~/.caveman/ccr.db`，默认容量 512 MiB | `docs/technical/context-recovery.md` §Handles/§Stored record/§Storage backends/§Capacity behavior | JuliusBrussee | 同上 | 2026-11-22 | 高 | 一手代码 |
| 18 | 回收是有损边界的：blob 句柄永不过期，但 typed object（`ccr_obj_`）按 14/30 天保留策略清理，过期 id 在 180 天内答 "expired" 而非 "unknown"；写失败则保留原文不压缩 | 同上 §Capacity behavior | JuliusBrussee | 同上 | 2026-11-22 | 高 | 一手代码 |
| 19 | Caveman 自报的量化结果很小且样本极小：相对 "Answer concisely." 基线，caveman 3%、ultracave 35%、megacave 9% 中位输出削减（n=10、单次、仅输出长度、tiktoken 近似）；并承认"未发布 vs 默认啰嗦回复的削减"，以及 #145/#506/#550 的净亏案例 | `docs/HONEST-NUMBERS.md` §The measured numbers / §When caveman loses | JuliusBrussee | 同上 | 2026-11-22 | 高（自报口径） | 一手文档 |
| 20 | Caveman 明确反对"表演式原始人"并给出人味边界：§9 "Never perform caveman"（不许 me think / Caveman: 前缀）、§When to break the rules 要求安全警告、不可逆操作、会被持久化的产物（代码/注释/commit/docs/memory）改用完整句子 | `plugins/caveman/skills/caveman/SKILL.md` §9、§When to break the rules 1–7 | JuliusBrussee | 同上 | 2026-11-22 | 高 | 一手代码 |
| 21 | Caveman 的压缩路径（/caveman-compress）才有代码级 guard：先本地检测文件类型、拒收疑似密钥文件、调用模型压缩、本地 validate、失败只做定点修复、最多重试 2 次、失败则不动原文件；备份 `.original.md` 落在 out-of-tree 数据目录 | `plugins/caveman/skills/caveman-compress/SKILL.md` §Purpose/§Process/§Trigger | JuliusBrussee | 同上 | 2026-11-22 | 高 | 一手代码 |
| 22 | 许可与体量：stop-slop MIT 19,118★ 59 open issues；humanizer MIT 72,179★ 4 issues；humanizer-zh MIT 23,545★ 35 issues；caveman Apache-2.0 122,096★ 110 issues | `gh api repos/<owner>/<repo>`（stargazers_count/license.spdx_id/pushed_at/open_issues_count） | GitHub API | 2026-11-22 快照 | 2026-11-22 | 高 | 一手元数据 |

## 机制拆解（可抄什么 / 不能抄什么）

### 可抄的三件事

1. **分层：规则（生成前）与守门（生成后）分开写，且守门只做机器能判的事。** Humanizer-zh 是唯一把这条做对的样本：31 条模式给人/模型读，`check_structure.py` 只判"受保护片段是否逐字未变"。它不假装能判"像不像人"。对哦鲸鲸：风格规则进生成侧提示词，事实/结构保全进生成后的确定性 diff，二者不要混成一个"评审员"。
2. **分诊而非一刀切。** Humanizer 的"前五条一见即改 / weak alone 需共现"和 Caveman 的"单条 tell 不足以判定、两条不相关才重写"是可复用的降误伤设计：给规则分级 + 共现门槛，避免"看见 -ly 就杀"。
3. **改写要报告覆盖范围。** Humanizer 文件模式要求"报告审了多少节、哪些节没覆盖"；中文版要求"只改确实存在的表达问题，通顺处原样保留"。这是可验证的交付契约，比"已人性化"有用。

### 不能抄的四件事

1. **不要抄 Stop Slop 的 35/50 自评分。** 五个维度全是模型自答，无 rubric 锚点、无测试、无样例分；同仓库 8 个月未更新（pushed 2026-03-17，59 open issues）。它作为"词表 + 结构清单"可用，作为"质量门"不可用。
2. **不要抄"补一个你知道为真的具体细节"。** Humanizer SKILL.md:37 原话如此（"add a specific detail you know to be true"），对记忆型助理是**编造事实的入口**；中文版在 :28 明确反着写（"不能用虚构的数据使句子显得具体"）。取中文版。
3. **不要把"越多规则越好"当默认。** Humanizer 自己给 SKILL.md 设了 5500 词上限并在 CI 里卡；26 条已是 33 KB。规则本体每轮都进上下文，是固定输入成本。
4. **不要把 Caveman 当人性化层。** 它是"少 token 的工程语域"：20 词上限、去冠词、去仪式；对"更像人"是反方向。它能借的只有两点：payload 逐字保留的纪律，和"不许表演风格"的自我约束（§9）。

### 四个项目的定位（生成前 / 生成后）

| 项目 | 主要位置 | 失败模式 |
|---|---|---|
| Stop Slop | 生成前约束（drafting 时注入）+ 生成后自评 | 词表式过度删除（副词、引语内、正当强调）；自评分不可复现；仓库停滞 |
| Humanizer | 生成后审计/重写（edit existing text），"Embedded mode"可被上游任务当生成前约束调用 | 重写幅度大易丢事实（自列 §6/§9/§19 为高发）；补细节的指令有编造风险；同轮自检无独立裁判 |
| Humanizer-zh | 生成后重写 + 确定性结构 diff | 语义层仍靠人工；31 条里大量是示例不是判据；无跨模型/无稳定通过率 |
| Caveman | 生成前输出约束（skill）+ 生成后可逆压缩（CCR/compress） | 电报体与"人性化"冲突；输入成本可能净亏（自报 #145/#506/#550）；风格规则会压掉必要礼语 |

## 线索与未找到

- **未验证**：Humanizer SKILL.md:504 引用的 arXiv:2606.04177（El Attar 等，30 LLM 语言特征分析）与 Wikipedia "Signs of AI writing" 只作为其规则来源被引用，本次预算内未打开原文核对。
- **未找到**：四个仓库中**没有任何一处**给出"人性化得分"的可复现定义（公式/阈值/标注集/benchmark）。Stop Slop 的 35/50 是唯一数值门，但为模型自评；Humanizer 的 16/16 是 issue 自证；Caveman 的 evals 有脚本但 HONEST-NUMBERS 明说没有提交可复核保真快照。
- **未找到**：Stop Slop 无 tests/、无 CI、无脚本；其 CHANGELOG 只有 3 个日期条目（2025-01-12 初版，2026-01-12 拆分，2026-01-13 增补），之后无更新记录。
- **未展开**：Caveman 的 `engine/pixel`（图像/像素化通道）、`proxy/internal/gateway` 的具体压缩策略、`evals/score_fidelity.py` 的判分实现，均在本维度预算外，留给机制维度。
- **口径提示**：star 数在 2026-11-22 本次 API 快照为 19,118 / 72,179 / 23,545 / 122,096，与任务书给的 19,119 / 72,169 / 23,543 / 122,087 有 ±10 级漂移，属正常波动。
- **方法说明**：目录树经 `gh api .../git/trees/HEAD?recursive=1` 取得；正文取用 `gh api .../contents/PATH`（api.github.com 本轮间歇 SSL/EOF 失败时，改用同仓库 `raw.githubusercontent.com/<repo>/main/PATH`，内容等价）。
