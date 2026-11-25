# 词汇表

> PRD §3 定过一条规矩：术语以其为准、全文不换同义词。下游 story、测试名、字段名都按这张表用词——换词就是换概念。
>
> 表分三段：①记忆插件（CAP-1…CAP-6）的词；②**上下文治理**（CAP-7，`CONTEXT-GOVERNANCE.md`）的词；③**入口与路由**（CAP-9，`entry-routing.md`）的词——主对话 / preset / preset 作用域 / worker 会话 / 话题 / 路由账本 / 派发 / 回流。
>
> 2026-11-25：补齐 CAP-7 与扩展组（FR-34…FR-77）引入的术语；把原先含糊的「降级两档」「注入档位」改写为不混用的三种说法。

| 术语 | 一句话定义 |
| --- | --- |
| 断言（assertion） | 一条可判真假的陈述，带证据与有效期；「记忆」的最小单位。 |
| 可结算 | 一条推断能被判定对错：带可执行的判别式与结算状态（未定 / 已确认 / 已证伪）。 |
| 证据指针（evidence） | 指回宿主会话日志的 `{session_id, seq 区间, 短引文}`，不是原文副本。 |
| 补丁表 | 一次业务写入的完整变更清单；要么整张成功，要么整张失败。 |
| 被拒（rejected） | 被拒收的写入留下的记录（含原因与原始补丁），不是静默丢弃。 |
| 场景（scene）/ 片段（episode） | 多轮对话归纳出的情境与它的片段，由固化生成，永不常驻注入。 |
| 偏好（pref） | 可治理的稳定偏好，与身份文件分离。 |
| 身份段 | 随插件发布、字节稳定的人格文本，不依赖库。 |
| 状态尾巴 | 每轮可能变化的一小段状态（关系四维与档位、一条已确认偏好、一条待处理标记），有硬预算。 |
| 关系四维 | `temperature / trust / intimacy / understanding`，各 0–100，用于描述关系状态。 |
| 越界 | 四维取值超出 0–100，或单次事件步长超出上限；由工具层拦截并返回拒绝。 |
| 按需召回 | 模型在需要时发起的检索，不是每轮固定动作。 |
| 决策账本（decision） | 只增不改不删的操作记录，回答「谁改的、依据什么、为什么」。 |
| 操作单元（op_id） | 一次业务操作的身份；撤销以它为单位，不以字段为单位。 |
| 标记（flag） | 待处理的矛盾、过期或无据断言；它是节点，不是边。两态 `status ∈ {open, resolved}` + `flag_type` + `resolved_by(auto / human)`。 |
| 固化（dream） | 夜间（或空闲触发的）八步离线处理，确定性步骤先行。 |
| L0–L3 | 记忆的四个层次：L0 宿主会话日志（只作指针）、L1 断言 + 证据、L2 片段 + 场景、L3 身份文件 + 偏好节点。 |
| 未失效 | 没有被 `superseded_at` 标记的版本；默认查询只看未失效。 |
| 降级（两处，别混） | **记忆安装位两档**：要么整体 no-op，要么只关向量路径，不存在半开（FR-18）。**上下文治理安装位五档**：`full` / `fold-only` / `ledger-only` / `readonly` / `recovering`（FR-50 / AD-36）。说「降级两档」时只指记忆位。 |
| 档位（三种，别混） | ①**注入档位**三档：身份段 / 状态尾巴 / 按需召回，各有预算与退路。②**降级档**：记忆两档 / 折叠五档。③**人格强度档位**：`persona.strengthMax` 默认 5。 |
| 三段召回 | ① 候选 250ms → ② 重排 600ms → ③ 注入 20ms，合计硬上限 1000ms，到点不返空。 |
| 重排（rerank） | System One 打分（`POST /systemone`，score 任务，模型 `SemIf`）；只产分数，不决定删谁。 |
| 核验（verify） | ③④⑤⑧ 的第二步：`deepseek-ai/DeepSeek-R1-0528-Qwen3-8B` 检查证据是否齐全、结论是否与证据矛盾；不过则不提交。 |
| mem_key | 业务身份字符串 `<kind>:<subj>:<pred>[:<obj_norm>]`；节点 id 只是存储局部量。 |
| active_slot | 活动版本写 1、失效时写 `superseded_at` 毫秒数；与 `mem_key` 组成唯一索引，把「同键至多一条未失效」交给数据库。 |
| 单写队列 | 全进程唯一的提交队列，按 对话写入 > 快照 > dream 串行提交。 |
| 迁移报告 | 迁移的产物：迁入 / 跳过（逐条原因）/ 去重合并 / 失败 四项计数。 |
| TBox | `store/tbox.ts` 里只剩 falsifier 字段白名单与谓词名规则；谓词基数已从代码常量改为库内 `pred` 节点。 |
| 谓词登记（pred） | 一类谓词的登记节点：基数（single / multi）、别名、状态与由谁定。模型新建的谓词默认 `multi` + `candidate`，只有用户能把它提升为 `single`。 |
| 主对话 | 挂了 `omw-main` preset 的那个会话；鲸鲸人格只在这里出现。其余会话都不是主对话，也不长成人格。 |
| preset | DSH 的 agent 预设：一组注入的 prompt section、工具与服务，挂在它自己的作用域上。挂某个 preset 的 agent 才看得见该 preset 里注册的东西。 |
| preset 作用域（scope） | preset 自带的一层可见性边界。人格段就注册在这一层，所以「看不见」由结构保证，不靠运行时判断或事后关闭。 |
| worker 会话 | 派发层创建、用来干活、不带人格的会话。它有四个记忆工具，没有派发工具，在侧栏可见并可被用户接手。 |
| 话题（topic） | 主对话里一件持续的事。派发以话题为单位记账：一个话题对一个 worker 会话（`omw-<topicId>`），一题一会话。 |
| 路由账本（routing ledger） | `routing.json`：话题、会话 id、工作区、preset、时间戳的绑定表。它是操作状态，与记忆库分离，损坏即停（`E_GATE_DOWN`）而不影响人格与记忆。 |
| 派发（dispatch） | 主对话把工作交给 worker 会话的动作，包含建会话、投递指令、记账三步。派发是主对话的独占工具面，worker 没有它，因此不会套娃。 |
| 回流（relay） | worker 收尾后回到主对话的一条 note：带摘要与会话指针，不夺前台、不复制 worker 的对话全文。 |
### 上下文治理（CAP-7，`CONTEXT-GOVERNANCE.md`）

| 术语 | 一句话定义 |
| --- | --- |
| 折叠阶梯 | 上下文治理的四级处理强度：**第 0 级** 观测折叠（0-LLM）/ **第 1 级** 模型摘要（唯一有损）/ **第 2 级** v2 / **第 3 级** 应急截断（AD-35）。**一律写「第 n 级」，不用 L 记号**——`L0–L3` 专指记忆分层。 |
| 折叠块（`fold`） | 一次折叠产生的上下文块，带 `{session_id, seq_from, seq_to}` 坐标。**它是上下文状态，不是记忆**：不进召回、不进注入、不进导出、不参与 dream（AD-37）。 |
| `req_ledger`（要求账本） | 会话级的要求清单，由确定性提取器从真实用户消息抽取，条目分 goal / constraint / prohibition / authorization / scope。模型不得改写它，只能通过用户消息改变它。**不是记忆节点。** |
| 密度 | 与当前任务步相关的估算 token / 注入总估算 token（AD-42）。排序一切策略的铁律是 **密度 > 体积 > 手续费**。PRD 里它有纯结构量替身 `focus_ratio`；凡说「按密度删」「密度下限」「密度不降」，一律以 `focus_ratio` 复算。 |
| `focus_ratio` | `(身份段 + 状态尾巴 + 未折叠的近期原文) 的估算 token / 注入总估算 token`，每轮记一条（FR-53）。折叠后**不得下降**（NFR-14）；低于 `govern.focusFloor`（默认 0.6）时触发清理而不是折叠。 |
| 注意力池 | 常驻 + 折叠块 + 近期原文 + 召回的总占用 ≤ `govern.attentionPoolRatio`（默认 0.6）× 窗（AD-45）。五档降级不是五个独立预算，是同一池的五种占用。 |
| `breakeven_turns` | 一次折叠省下的 token 需要多少轮才能抵回折它本身花掉的成本；超 `govern.breakevenMaxTurns`（默认 20）记 `low_yield`（FR-51）。 |
| `prompt_version` | 折叠与 nudge 所用提示词模板的版本号，写进每个 `fold` 节点。改动必须在 PR 里标 `MODEL-FACING` 并补「模型可见字符串逐字等于预期」的回执测试（FR-76 / AD-41）。 |

### 扩展组（FR-34…FR-77）的其他词

| 术语 | 一句话定义 |
| --- | --- |
| 证明四列 | `derivation` / `rule_id` / `justification_id` / `depth`；写入即定、不可改写，缺列拒收（FR-40）。首列叫 `derivation` 而非 `origin`——后者已被 `observed\|inference` 占用。 |
| `justification_id` | `sha256(sorted(前提业务键集合))`；**按业务键算、不含节点 id**，因此重建库后同一证明得到同一 id。 |
| `UNRELIABLE` | **响应级**结论态：这次整批不回答（本查询邻域不一致时，FR-41）。它与逐条三态不在同一层，四者构成封闭集合，不得新增第五种。 |
| 三态结论 | 逐条 `CERTAIN` / `REFUTED` / `POSSIBLE`（FR-42）；必须可复算（NFR-16）。 |
| `source_independence` | 两条证据算同一来源 ⟺ 指向同一宿主 `session_id`，**或**规范化后引文前缀（前 80 字符）完全相同。同源多条只算 1（FR-45）。 |
| `stageHistory` | 关系阶段的变更记录 `{ts, from, to, cause}`；五级 `stranger → acquaintance → familiar → close → intimate`，不得跳级、不得回退（FR-66）。 |
| `copy_confirm` | 自有产物文案的确认入参：结构检查 + 片段 diff，违规可 block（FR-77）。v1 只有两类自有文本——`/omw` 命令输出与 `reports/brief-<date>.md`。 |
| `noise_removed` | 低密度清理的审计标记：从注入与检查点**选区**移除，库内一律打 `valid_to`，不物理删除（FR-54 / AD-5）。 |
| `low_yield` | 折叠经济性不达标标记，见 `breakeven_turns`（FR-51）。 |
| Mini-IPIP | 20 题自评量表（FR-71 的「20 题自评量表」即此），算出 OCEAN 五维与 `trait_gaps`；离线一次调用、只报告不设通过线（Epic 9，不属 v1）。 |
