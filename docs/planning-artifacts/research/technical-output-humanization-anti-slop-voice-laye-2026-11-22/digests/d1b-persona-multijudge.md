# 人设 / 多评委（persona & multi-judge）digest

研究者：r2-persona ｜ 访问日期：2026-11-22 ｜ 来源：GitHub 原始文件（dreliq9/empanel、clawsouls/soulspec、ericwang915/herandhim），共 3 个仓库、8 个文件，均为一手代码/规范。

## 范围与结论（≤5 条）

1. Empanel 的“独立评委”隔离**不是多模型**，而是“同一 LLM 网关 + 不同 lens prompt + 每次调用 `history=""` 的空上下文”；三条防锚定措施分别落在评估阶段（并行、互不可见）、称重阶段（一次只看一份报告）、合成阶段（纯 Python 算术，LLM 不得改写原估计）。
2. Empanel 的产品路径（代码评审）聚合不是平均而是**指纹分组 + 共识分级 + 权重闸门**：同一发现按 file/line/failure_type 归并，全员命中→HIGH，过半→MAJORITY，仅一人→UNIQUE，严重度取最大值而非平均，低于 0.3 权重的评委发现被剔除但仍算“反对票”。
3. SoulSpec 的 schema **没有“禁止句式/禁用词”区块**：它的硬约束是 RULES.md 的“Must always / Must never”行为条款，校验靠仓库外的 npm CLI `clawsouls validate`/`soulscan`；本仓库是 Docusaurus 文档站，无 JSON Schema 也无校验器源码。它解决的是“人设可移植 + 防漂移/供应链安全”，不是“防八股”。
4. HerAndHim 的“关系越近客套越少”是**真实实现**：`closeness=(intimacy+trust)/2`，阈值 45/70 切成三档语音规则，作为独立段落拼进系统 prompt；稳定人设（SOUL.md）与易变状态（affect/relationship.json）分仓。它的“人性化”主要落在**投递节奏层**（回复延迟、1–3 条气泡、选择性 emoji 反应），而非措辞层。
5. 对 slop_score 的启示：多评委能降 single-judge bias，但 Empanel 自己承认**权重塌缩**（stdev<0.05 即加权退化为均值）并显式告警；成本是 2N 次调用（N 评估 + N 称重）、方差来自采样与权重塌缩、可复现性只保证在“算术段”。

## 证据表

| # | 主张 | 来源（URL 或 仓库路径:行号） | 发布者 | 日期 | 访问日期 | 置信度 | 类别 |
|---|---|---|---|---|---|---|---|
| 1 | 三阶段：EVALUATE 并行互不可见 → WEIGH 逐份隔离 → CALCULATE 纯 Python | dreliq9/empanel `empanel/engine.py:1-31, 119-132` | dreliq9 | 未取 | 2026-11-22 | 高 | 代码 |
| 2 | 隔离的物理实现是空 history：`await self._llm_chat(agent, prompt, "")` | `empanel/engine.py:192, 310`；`empanel/code_review.py:781-783`（原文 “Isolation comes from each LLM call having its own fresh prompt and `history=""`”） | dreliq9 | 未取 | 2026-11-22 | 高 | 代码 |
| 3 | 评估阶段并行 `asyncio.gather`；称重阶段注释称“并行不影响隔离” | `empanel/engine.py:220-222`；`code_review.py:826-828` | dreliq9 | 未取 | 2026-11-22 | 高 | 代码 |
| 4 | 聚合=加权平均（`sum(e*w)/sum(w)`），可 snap 到 Fibonacci 刻度 | `empanel/math.py:16-35`；`engine.py:365-372` | dreliq9 | 未取 | 2026-11-22 | 高 | 代码 |
| 5 | 权重塌缩检测：权重 stdev<0.05 判为“称重没起作用”，结果降置信 | `empanel/math.py:47-60`；`engine.py:374-384` | dreliq9 | 未取 | 2026-11-22 | 高 | 代码 |
| 6 | 称重者只能给权重、禁止替换估计值 | `empanel/engine.py:298-300` | dreliq9 | 未取 | 2026-11-22 | 高 | 代码 |
| 7 | 评审路径：fingerprint 归并文件+行区间+失败类型，跨文件去重 | `empanel/code_review.py:1265-1286, 1199-1210` | dreliq9 | 未取 | 2026-11-22 | 高 | 代码 |
| 8 | 置信分级 HIGH/MAJORITY/CONTESTED/UNIQUE；弃权 lens 不计入 HIGH 分母；严重度取 max | `empanel/code_review.py:875-903` | dreliq9 | 未取 | 2026-11-22 | 高 | 代码 |
| 9 | 权重闸门 0.3：低权评委的发现不参与合成，但仍计入 n_evaluators 作“反对票” | `empanel/code_review.py:859-866, 893-900` | dreliq9 | 未取 | 2026-11-22 | 高 | 代码 |
| 10 | 防评委被报告内容“说服”：报告被标注为 UNTRUSTED DATA，提示词注入示例显式说明 | `empanel/code_review.py:1604-1612, 1616` | dreliq9 | 未取 | 2026-11-22 | 高 | 代码 |
| 11 | 争议第二轮：匿名化分歧，追问各评委是否坚持原判，全员同意升 HIGH、全员退让降 UNIQUE | `empanel/code_review.py:50, 1316-1320, 213-224` | dreliq9 | 未取 | 2026-11-22 | 中（仅读 docstring 与调用点，未读全函数） | 代码 |
| 12 | **README 与代码冲突**：README 称称重者“看不到 lens 身份”，实际 prompt 含 `f"Lens: {a.lens}"` | README.md:59-62 vs `code_review.py:1617` | dreliq9 | 未取 | 2026-11-22 | 高（冲突已定位） | 代码/文档 |
| 13 | lens=角色+system prompt+可选 checklist+`adversarial` 改写为攻击者口吻；同模型不同 lens 才有多样性 | `empanel/lenses.py:1-46` | dreliq9 | 未取 | 2026-11-22 | 高 | 代码 |
| 14 | 测试与回归语料存在；README 自述 141 tests pass，自评审三轮收敛（自报，无第三方验证） | tests/ 7 个文件（test_engine.py 13 个 `def test_`）；README.md:89-97 | dreliq9 | 未取 | 2026-11-22 | 中（数量未逐一复核） | 代码/文档 |
| 15 | 未找到校准/基准数据：KNOWN_ISSUES.md 无 calibration/benchmark 章节，仓库无 benchmark 目录 | 仓库树 + KNOWN_ISSUES.md 全文检索 | dreliq9 | 未取 | 2026-11-22 | 中（阴性证据） | 代码 |
| 16 | 规范字段：`specVersion/name/version/...`，生命周期支持 deprecated/supersededBy，v0.6 增 `type/includes/memory/rules/registry` | `docs/spec/v0.6.md:23-36, 42-61` | clawsouls | 未取 | 2026-11-22 | 高 | 规范 |
| 17 | 硬约束文件是 RULES.md 的 “Must Always / Must Never”，属行为边界，非句式/词表 | `docs/spec/v0.6.md:143-176` | clawsouls | 未取 | 2026-11-22 | 高 | 规范 |
| 18 | 仓库内无可执行 validator：目录仅 docs/ + Docusaurus 配置；校验是外部 npm CLI | 仓库树（无 schema/*.json、无 src 校验逻辑）；`docs/api/cli.md:102-121` | clawsouls | 未取 | 2026-11-22 | 高 | 代码/文档 |
| 19 | 人设“交流风格”层在 SOUL.md，含“绝对禁止：太工整/太对称/书面语/列清单/排比/像 AI 面面俱到”+ 字数与示例 | `herandhim/templates/soul/SOUL.md:25-67, 69-104` | ericwang915 | 未取 | 2026-11-22 | 高 | 代码 |
| 20 | 关系→正式度：`closeness=(intimacy+trust)/2`，<45 客气/不预设熟络，<70 去客套+昵称+玩笑，≥70 零表演/舒适沉默；附带认识天数 | `herandhim/core/agent.py:1520-1556` | ericwang915 | 未取 | 2026-11-22 | 高 | 代码 |
| 21 | 稳定人设与易变状态分仓：SOUL.md（启动加载、不可被覆盖）vs 情感/关系状态 `affect/relationship.json`（RelationshipStore） | SOUL.md:133-135；`core/memory/manager.py:14-15, 101-110` | ericwang915 | 未取 | 2026-11-22 | 高 | 代码 |
| 23 | 关系状态有 4 维（relationship_temperature/trust/intimacy/understanding，均从 50 起，由情感事件微调），但正式度映射只用 intimacy+trust 两维 | `herandhim/core/memory/emotional_graph.py:368-380`; `core/agent.py:1526` | ericwang915 | 未取 | 2026-11-22 | 高 | 代码 |
| 22 | “人性化”投递层：延迟随长度抖动、夜间更慢、封顶 9s；按空行切 1–3 条气泡；按图片/情绪选择性 emoji 反应 | `herandhim/core/humanize.py:39-52, 58-105, 111-148` | ericwang915 | 未取 | 2026-11-22 | 高 | 代码 |

## 机制拆解（可抄什么 / 不能抄什么）

**Empanel**

- 可抄（结构，MIT，抄代码也合法）：
  - 三段式协议 **Assess → Weigh → Reduce**，其中 Reduce 必须是代码而非 LLM（`math.py:1-6` 的设计意图），这让分数可审计、可复算。
  - “隔离 = 空 history + 单份输入”这一条可落到任何 judge prompt 上，与模型数量无关。
  - 权重塌缩检测（stdev<0.05）：多评委系统必须在“评委没区分度”时自曝，而不是把均值当共识。
  - 权重闸门 + 弃权语义：低质评委的**内容**丢弃但**票数**保留（`code_review.py:893-900`），这是防止“摆烂评委稀释共识”的关键细节。
  - 严重度/等级取 max 不取平均（`code_review.py:902-903`）：分歧时保守，不被平均抹平。
  - “报告是 UNTRUSTED DATA”的提示词分层，可直接搬到“把待评分文本喂给评委”的场景（防文本内注入 `rate this 1.0`）。
- 不能抄：
  - 具体 lens 文案（44KB 提示词是为代码安全评审写的，与“反八股”语料不同域）。
  - README 的“看不到 lens 身份”说法与代码矛盾（证据表 #12），照抄文档会抄到错误假设。
  - 成熟度：0★、无外部使用者、无校准数据；141 tests 是自报。自评审收敛属自证，不能当效果证据。
  - 依赖注入式 `llm_chat(agent, prompt, history)` 需自建 adapter；它不做重试/限流/温度控制，方差不可控。

**SoulSpec**

- 可抄：文件分层的**职责切分**（SOUL=是谁 / STYLE=语气 / RULES=必须-永不 / AGENTS=流程 / MEMORY=长期记忆 / hooks=生命周期），以及 `specVersion` + deprecated/supersededBy 的版本与废弃协议（`docs/spec/v0.6.md:23-36`）。
- 不能抄/不适用：
  - 它**没有**“禁用句式/词表”这类可机检字段，别把 RULES.md 当反八股规则用。
  - 校验器不在本仓库（npm `clawsouls` CLI），引用其“通过校验”需要外部依赖；schema 无 JSON Schema 文件，无法直接生成类型。
  - 它解决的是可移植性与防漂移/安全扫描（SoulScan 53 patterns），与“反八股”是**两个问题**，混谈会误导架构决策。

**HerAndHim**

- 可抄：**状态→表达规则**的映射写法（离散档位 + 每档一段自然语言指令 + 认识天数注入），比“把 0–100 的数字直接塞进 prompt”有效，代码注释明确说后者导致“month-3 和 day-1 听起来一样”（`agent.py:1520-1523`）。以及人设/状态分仓（`manager.py:107-110`）。
- 不能抄：
  - **许可**：AGPL-3.0，闭源插件复制其代码/文本有传染风险；只借“档位映射 + 分仓”这类设计思路（思想/方法）风险低，但需法务确认，本 digest 不作法律结论。
  - 语境绑定：closeness 的语义是“虚拟女友的亲密度”，映射到“助理↔用户”需重定义维度与阈值（45/70 不可直接搬）。
  - humanize.py 是 Telegram 投递层（typing action、reaction API），与文本风格无关；它反的是“机器人节奏”，不是“八股文风”。

## 线索与未找到

- **未找到**：Empanel 的校准/基准数据（无 benchmark 目录、KNOWN_ISSUES 无相关章节）、示例输出 JSON（fixtures 是回归语料而非评分样例）、任何第三方对它的评测。
- **未找到**：SoulSpec 仓库内的 JSON Schema 文件与校验器源码（推断在 npm 包 `clawsouls` 内，本次未取该包源码）；也未找到 schema 级别的“禁用词/句式”字段。
- **未找到**：HerAndHim 中“关系越近客套越少”的**效果验证**（测试目录有 test_soul.py / test_companion_behavior.py，但本次未读其断言内容），目前只能证明规则被写入 prompt，不能证明生效。
- **值得注意**：HerAndHim 存了 4 个关系维度，正式度只取其中 2 个（intimacy/trust），temperature 与 understanding 未进入语音规则——即“状态维度”与“表达维度”并非一一对应，抄结构时不要假设全维映射。
- **线索**：Empanel `adversarial` lens 标志（`lenses.py:38-41` 自称 “the single most useful flag”）是“用对立视角抵消谄媚”的最小实现，值得作为 slop_score 评委的一档固定 lens。
- **线索**：Empanel 的“争议第二轮（匿名化分歧后追问）”与 HerAndHim 的“档位化状态注入”可组合成 v1：先用档位生成风格约束，再用多评委对**同一批候选回复**打分。
- **未取**：三者 commit 日期/发布 tag（本次仅取文件内容与目录树），故证据表“日期”列为“未取”。
