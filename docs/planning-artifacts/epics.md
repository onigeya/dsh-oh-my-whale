---
status: final
stepsCompleted: [step-01, step-02, step-03, step-04]
created: '2026-11-23'
updated: '2026-11-23'
inputDocuments:
  - docs/planning-artifacts/briefs/brief-DSH哦鲸鲸-2026-11-22/brief.md
  - docs/planning-artifacts/briefs/brief-DSH哦鲸鲸-2026-11-22/addendum.md
  - docs/planning-artifacts/prds/prd-DSH哦鲸鲸-2026-11-23/prd.md
  - docs/planning-artifacts/prds/prd-DSH哦鲸鲸-2026-11-23/addendum.md
  - docs/planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/ARCHITECTURE-SPINE.md
  - docs/planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/SOLUTION-DESIGN.md
  - docs/planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/C4-VIEWS.md
  - docs/planning-artifacts/research/RESUME.md
  - docs/specs/spec-DSH哦鲸鲸/SPEC.md
  - docs/specs/spec-DSH哦鲸鲸/requirements.md
  - docs/specs/spec-DSH哦鲸鲸/data-model.md
  - docs/specs/spec-DSH哦鲸鲸/acceptance.md
  - docs/specs/spec-DSH哦鲸鲸/glossary.md
  - docs/specs/spec-DSH哦鲸鲸/rejected-approaches.md
---

# DSH 哦鲸鲸（oh-my-whale）- Epic Breakdown

## Overview

本文把 PRD 的 **24 条功能需求（FR-1…FR-24）**、**10 条非功能需求（NFR-1…NFR-10）** 与架构侧的 **20 条附加要求（AR-1…AR-20）** 分解为按用户价值组织的 epic 与 story。每个 story 的验收标准必须能追到 FR-n；技术不变量以 AD-n 引用，不在此复述（AD 全文见 `ARCHITECTURE-SPINE.md`）。

**输入校验（2026-11-23 重跑 step-01）**：PRD 的 24 条 FR 与 10 条 NFR 已逐条对照正文提取；架构侧以 26 条 AD、Stack、Operations、Gates、Structural Seed、Deferred 为附加要求来源。本次修正了上一版清单中的三处事实错误——FR-12 误写「两级」（PRD 为三级：自动档 / 提案挂起档 / 人工解除档）、多条 AR 的 AD 出处错位、AR-2 误把已实测通过的闸门当作待办——并补齐了 §4.1 的读取边界（并入 FR-22）。

**无 UX 设计契约**：`bmad-ux` 未运行，`planning-artifacts/design/` 已于 2026-11-23 按用户裁定退役（见 `research/RESUME.md`）；v1 无图形界面（治理面是命令 + 导出，见 PRD §6.2），因此 UX Design Requirements 段为空，这是有意留空而非遗漏。治理界面（M5）的视图工作不在 v1 范围内。

**术语与编号纪律**：CAP-1…CAP-5、AD-1…AD-26、FR-1…FR-24、NFR-1…NFR-10 编号永不复用、永不重排；story 编号在 step-03 生成后同样冻结。

**契约层级（2026-11-23 补入 SPEC 后）**：`docs/specs/spec-DSH哦鲸鲸/SPEC.md` 及其 companions 是**权威契约层**，PRD / 架构 / 简报是它的 `sources:`；冲突时以 SPEC 与其 companions 为准，PRD 只在 SPEC 未覆盖处补充背景。本版的 FR-1…FR-24 / NFR / AD / SM / I 编号与 SPEC 完全一致（CAP-1…CAP-6 六个能力组）。

**SPEC 对齐记录（2026-11-23）**：逐条比对 SPEC + `requirements.md` / `data-model.md` / `acceptance.md` 后修入 13 处——I1–I15 不变量落点表；静态门补 AST（事务 op 字面量）与豁免文件头注释；`store/tbox.ts` 的谓词校验归入 Story 2.1（后改为开放谓词登记表，见 AD-27）；身份段 100 轮 sha256 稳定性（I9）；`eval/governance-20.md` 与关键词式 `omw explain` 归入 Story 3.1；SM-3 的 10 次操作验收；SM-1 的分层抽样与预注册种子；`dream_truncated` 标记；`settle_state ∈ {open, confirmed, refuted}` 枚举名；四类边界硬拦截（自伤 / 亲密 / 法律医疗 / 他人隐私）；迁移先 dry-run。

**3 处契约已裁决（2026-11-23）**：flag 生命周期按两态 `status ∈ {open, resolved}` + `flag_type` + `resolved_by`（Story 3.3）；谓词表改为**开放登记表**——模型可新建谓词，新建默认 `multi`、提升 `single` 只经用户写入（Story 2.1、AD-27）；召回候选池 `recall.candidatePool` 默认 12 进 config（Story 2.5、AD-26）。三处已同步到 `SPEC.md` 的 Open Questions、`data-model.md` §5/§7、`ARCHITECTURE-SPINE.md` 的 AD-3 / AD-9 / AD-26 / AD-27、`requirements.md` 的 FR-2 / FR-4 / FR-12 与不变量 I16。

## Requirements Inventory

### Functional Requirements

> 每条 FR 后的括号是受约束的 AD；「可测」段落是验收标准的直接来源，不得在 story 里放宽。

- **FR-1 一条记忆可以被写进来并追到来源**（AD-2、AD-4、AD-6、AD-21、AD-25；UJ-1）
  可测：写入后按业务键查回，并取回 `{session_id, seq 区间, 短引文}`；短引文 ≤200 字符，超长标截断；命中手机号 / 身份证 / 邮箱 / 银行卡正则时引文脱敏并标 `deidentified`；导出默认排除脱敏引文，需显式开关；宿主查询能力缺席时仍返回该条并标 `evidence-unresolvable`，绝不伪造原文。
- **FR-2 写入要么全成、要么全不成**（AD-4、AD-5；UJ-1）
  可测：补丁表任一 op 失败，整次写入不留任何节点、边或账本条目；被拒写入落一条 `rejected`（含原因与原始补丁），普通查询读不到；同一业务键不会同时存在两条未失效版本。
- **FR-3 改写留旧版本，而不是覆盖**（AD-3、AD-5、AD-15、AD-21；UJ-2）
  可测：改写后旧版本默认查询不返回、历史查询可取回；每次改写写一条 `decision`（操作者、`op_id`、受影响对象清单）；业务数据无物理删除路径，仅三个具名豁免（快照目录清理、审计与日志轮转、卸载前导出后删除）；故意在业务代码写一次 `delete(`，CI 必须失败。
- **FR-4 召回只读、有界**（AD-8、AD-25；UJ-1）
  可测：召回路径零写调用（含更新 payload 与刷盘）；默认 5 条、硬上限 8 条、不提供翻页 / offset 循环；默认只返回未失效版本；结果可解释（命中哪些、耗时、是否降级、降级原因取值封闭）；排序与剪枝由代码按分数 + 阈值 + top-k 决定，同批分数重跑结果相同。
- **FR-5 召回分三段，每段有退路**（AD-8、AD-19、AD-23；UJ-1）
  可测：① 候选 250ms、② 重排 600ms（System One `POST /systemone` score 任务 + `SemIf`）、③ 注入 20ms，合计硬上限 1000ms，到点交候选、不返回空；② 超时或报错只跳过排序、按①顺序注入并标 `rerank_unavailable`；③ 取不满就少给、不凑数；同一回合至多重排一次，命中缓存不重复付费；连续 3 次重排超时熔断 10 分钟；重排默认开启、可关闭，关闭后不报警也不计降级。
- **FR-6 注入只有一个出口，且带预算表**（AD-7、AD-11、AD-20；UJ-1）
  可测：身份段 ≤1200 字符且字节稳定（文本不变不重写）；状态尾巴 ≤30 token（四维与档位、至多一条已确认偏好、至多一条待处理标记）；场景永不常驻；超预算按 身份 > 状态 > 召回 裁剪并记一行审计；注入路径不查库，缺值整段省略、不填默认值。
- **FR-7 每次注入与召回都可核**（AD-8、AD-20、AD-26；UJ-3）
  可测：每次注入与每次召回各留一行审计（档位、条目、是否截断、耗时、是否降级、降级原因）；审计按天回溯 30 天、不落库、不参与召回；p95：注入组装 ≤30ms（`compose()` 同步段 ≤20ms）、召回 ≤900ms、写事务 ≤10ms；命令可按时间窗口输出 p50/p95 与降级计数。
- **FR-8 八步顺序固定，确定性步骤不碰模型**（AD-10、AD-14、AD-17；UJ-1）
  可测：①②⑥⑦ 的依赖对象不含模型客户端（测试断言，不靠评审）；③④⑤⑧ 产物带提示词版本与周期标识；③④⑤⑧ 每步留「提炼产物 + 核验结论」两段记录，核验不过该步不提交、后续按缺步处理；核验模型对一条刻意删掉证据指针的产物必须判「不通过」（G0-8 验收样例）；⑤ 默认关闭，开启时深度 ≤2、默认一条、单锚点一分叉，产物永不进断言层。
- **FR-9 每一步独立提交，能从断点续跑**（AD-10、AD-21；UJ-1）
  可测：进程在第 ④ 步被杀，重启从 ④ 续跑，不重跑 ①②③；`dream_log` 记阶段、种子、diff 摘要、token 消耗；确定性步骤（①②⑥⑦ 与 ② 抽样）可复现（种子由日期与阶段决定）；③④⑤⑧ 只要求记录提示词版本、种子、输入锚点集与输出摘要，不承诺逐字节一致；一天最多一个周期标记。
- **FR-10 预算三层取最小，超了停在段边界**（AD-10、AD-26；UJ-1）
  可测：阶段预算 / 日 token 上限 / provider 配额三者取最小；一次固化至少 6 次模型调用（③④⑧ 各一提炼 + 一核验），日调用上限必须覆盖该下限并留重试余量；命中即停在阶段边界、记截断记录、不半途写入；`--dry-run` 只跑 ①②、出 diff 不写库；错过不补历史多天、只补当天一次（连续 3 天 02:00–05:00 离线、第 4 天 09:00 启动，恰好 1 个 cycle）；空闲触发 = 最后交互后 30 分钟无事件且当天 `dream_cycle:<date>` 不存在，日志标 `idle_triggered`，同日连续空闲 10 次仍只 1 个 cycle；触发途中用户交互只在段边界让路；审计可见最近一次固化的日期与结果（「从未运行」是可见状态）。
- **FR-11 每条记忆都答得出「谁改的、依据什么、为什么」**（AD-21、AD-24；UJ-3）
  可测：三问分别由决策账本（操作者与时间）、证据指针（来源与 seq 区间）、决策账本（类型、理由、提示词版本、引用先例）回答；账本只增不改不删；一次查询即可返回版本链 + 账本 + 证据，不需要多步翻找。
- **FR-12 冲突分三级，只有自动档改数据且必须可撤销**（AD-9、AD-22；UJ-2）
  可测：自动档成立条件严格——同一谓词单个取值、同主体同谓词、有效区间重叠、归一化值不同；自动档结果 = 旧版本置失效 + 新断言 + 一条已解决 flag + 一条 `contradicts` 边，全在同一事务内；其余冲突只能「提案 + 挂起」，不得改动既有断言，人工解除是唯一解除路径；flag 生命周期完整（创建 → 挂起 / 已解决 / 已证伪 / 已撤销）且可按状态过滤；自动档每次裁决都能按操作单元整体撤销。
- **FR-13 撤销是一个操作单元**（AD-5、AD-22；UJ-2）
  可测：每个操作带 `op_id` 与 `affected[]`（只含状态类对象与边，不含账本类对象）；撤销在单事务内反向执行并追加一条「撤销」账本条目；复合操作要么整体撤销、要么整体不动；判据写死为固定 20 条 fixture 查询、关闭重排（或固定缓存键），只比较 `{mem_key, active_version, flag_status, edge_label}` 的集合，不比顺序、耗时与审计字段。
- **FR-14 推断必须可结算**（AD-6、AD-17；UJ-3）
  可测：`origin=inference` 的断言必须带可执行判别式（操作符限于 `eq/ne/gt/lt/gte/lte/exists/count_gte`，字段限白名单）与结算状态（未定 / 已确认 / 已证伪）；缺判别式或字段不在白名单即拒收，该推断只能落成场景描述文本；证伪不删除，改为置失效 + 一条已证伪标记。
- **FR-15 身份段不依赖库**（AD-11、AD-13；UJ-4）
  可测：库打不开时身份段照常注入；身份段文本哈希不变则不重写，保持前缀缓存可用；身份段不承载任何逐轮变化的内容。
- **FR-16 状态可缺席，但不许编造**（AD-7、AD-12、AD-20；UJ-4）
  可测：状态字段缺失或库不可用时整段省略、不填默认值；四维初值 50、单次正向步长 ≤3×强度（负向 ≤2×强度）、三档阈值 45 / 70 可从配置读出并解释档位归属；越界（四维超出 0–100 或步长超限）在工具执行前返回拒绝，不靠提示词提醒。
- **FR-17 启用是可验证的三步，不是一步**（AD-1、AD-15、AD-26；UJ-4）
  可测：依赖声明、宿主补丁配置、重启验证三步缺一不可；改错文件（改生成物 `cordis.yml` 而非补丁文件 `cordis.patch.yml`）必须能被文档与体检识别；启用后有体检命令检查五项（库能开、快照校验过、维度匹配、凭据可用、注入段已注册）；五种错误配置各返回非零退出码与对应错误码。
- **FR-18 降级只有两档**（AD-13、AD-18、AD-19、AD-23；UJ-4）
  可测：库打不开 / 快照校验失败 / 配置维度与库不符 / 契约版本不符 → 整体 no-op（不注入记忆、不注册写工具、不排固化、不写任何节点，只记一行原因）；仅向量路径故障（凭据 401/402、embedding 维度不符）→ 只关向量路径，文本与图召回照常；不存在中间态；错误码封闭为八个（`OMW_DB_OPEN` / `OMW_SNAPSHOT_VERIFY` / `OMW_DIM_MISMATCH` / `OMW_EMBED_AUTH` / `OMW_EMBED_QUOTA` / `OMW_EMBED_TIMEOUT` / `OMW_EXTRACT_FAIL` / `OMW_DREAM_BUDGET`）；恢复需重载插件，不在进程内自愈重试。
- **FR-19 备份与恢复可预期**（AD-14；UJ-4）
  可测：每次启动检查「今天有没有已校验快照」，缺则补做，重复运行最多多一份、不视为错误；迁移前强制快照；保留最近 7 份；恢复必须先停库再恢复（Windows 句柄锁）；迁移先 dry-run。
- **FR-20 成本有上限且可看**（AD-23、AD-26；UJ-1）
  可测：四类日上限各自可配（抽取调用、向量调用、重排调用、固化 token）；命中后各自降级而非报错（抽取只记不抽、向量停止补写、重排降级为候选顺序、固化停在段边界）；审计报告可按时间窗口输出 p50/p95 与降级计数。
- **FR-21 迁移幂等且可回退**（AD-2、AD-3、AD-5、AD-16；UJ-1）
  可测：重复运行不产生重复节点（以迁移标识判定「这行迁过」）；迁移用业务身份、不用行哈希冒充身份；迁移完成后一次会话注入快照里 mnemon 段落出现次数 = 0、身份段唯一；迁移前必须先禁用或卸载 dsh-mnemon（否则报错退出、不半途迁）；产物是一份迁移报告（迁入 N / 跳过 M 逐条原因 / 去重合并 K / 失败 0，落 `migrations/<ts>-report.md`）；迁移前落 `snapshots/pre-migration-<ts>`，失败自动回滚，失败不改变任何东西；回滚后重跑与首次成功迁移逐条等价，报告追加而非覆盖；回滚开关只恢复本插件 legacy 注入，不自动重启 mnemon。
- **FR-22 什么值得记、什么禁止记（含读取边界）**（AD-4、AD-6、AD-17、AD-25；UJ-1）
  可测：抽取输入是会话片段 + 已有记忆的稳定身份，输出只有一张补丁表，禁止逐条流式写库；用户显式偏好 / 决定 / 纠正必须落断言，纯寒暄与纯执行性对话必须不落（两类各有 ≥20 条标注样本可判）；证据缺失时只能标 `evidence-unresolvable`；无合法判别式的推断只能落场景描述文本，不得进断言层；单次抽取失败不重试超过一次，失败留 `rejected` 与错误码、不写半截；越界读取 = 0（测试断言只碰「本轮新增 seq」与「库内已有证据指针」，每次回读记 `session_id` 与 seq 范围）；回读 lookback ≤30 天，超出标 `evidence-expired`；v1 偏 precision（不确定即不落），假阳性 / 假阴性分开统计且及格线按假阳性加权。
- **FR-23 治理查询命令是 v1 的交付物**（AD-21、AD-24；UJ-3）
  可测：四条只读命令 `omw explain <mem_key|关键词>`、`omw version-chain <mem_key>`、`omw flag-queue [--status open]`、`omw export [--include-quotes]`，字段名与 AD-24 治理投影 DTO 对齐；退出码固定（0 成功、2 未找到、其他非零为错误），不使用交互式分页；输出同时有结构化 JSON 与人类可读两种且字段名一致；任取一条记忆，从执行命令到看到三个答案 ≤30 秒；命令只读（零写入、不更新热度）。
- **FR-24 全量数据可导出（纯文本 + JSONL）**（AD-3、AD-5；UJ-2）
  可测：一条命令导出全部断言（含版本链关系）、偏好、场景摘要与账本；默认不含已脱敏引文与节点 id；格式为纯文本 + JSONL，可直接归档、不需本产品即可读懂；导出是卸载前置条件（未导出不允许卸载）。

### NonFunctional Requirements

- **NFR-1** 性能：注入组装 p95 ≤30ms（`compose()` 同步段 ≤20ms）。（PRD §4.7 / AD-20）
- **NFR-2** 性能：召回 p95 ≤900ms（含重排）；重排不可用比例 <5%；候选真空比例 <1%。（PRD §4.7 / AD-8）
- **NFR-3** 性能：写事务 p95 ≤10ms。（PRD §4.7 / AD-4）
- **NFR-4** 可靠性：任一降级路径不得产生幽灵状态（注入了却不写、工具半可用）。（PRD §4.7 / AD-18）
- **NFR-5** 隐私：不复制宿主消息全文；引文 ≤200 字符且可脱敏；导出默认不含敏感引文。（PRD §4.7 / AD-6）
- **NFR-6** 可退出：全量数据可导出为纯文本 + JSONL，且不含节点 id。（PRD §4.7 / AD-3）
- **NFR-7** 可审计：注入、召回、固化、写入各留审计行；按天切分、保留 30 天、只落文件。（PRD §4.7 / AD-20）
- **NFR-8** 形态：单进程插件——不监听端口、不起后台服务、不 spawn 子进程。（PRD §5 / AD-1）
- **NFR-9** 预算：常驻注入 ≤ 身份段 1200 字符 + 状态尾巴 30 token + 召回 ≤5 条。（PRD §4 / AD-7）
- **NFR-10** 平台：Windows 单文件库句柄锁语义——恢复必须先停库；快照目录创建撞名属预期分支。（PRD §4.7 / AD-14）

### Additional Requirements

> 来源：`ARCHITECTURE-SPINE.md`（AD、Stack、Operations、Gates、Structural Seed、Deferred）、`SOLUTION-DESIGN.md`、`C4-VIEWS.md`。

- **AR-1 无 starter template**：仓库当前只有文档与脚本，Epic 1 的 Story 1 必须包含工程脚手架——Node 24.21.0、TypeScript 7.0.2、pnpm 12.18.0、vitest 5.1.1、eslint 10.15.0、zod 4.6.7、triviumdb 0.9.3、DSH 0.2.2-rc.5 对齐。（来源：Stack）
- **AR-2 M0 八道闸门必须先于 M1**：G0-1 / G0-2 / G0-3 已实测通过、保留为回归项；G0-8（提炼 / 核验两个模型与核验行为）2026-11-23 实测通过——原定 `Qwen3.5-4B` 无响应，换同族 `Qwen/Qwen3.5-9B`，同 `deepseek-ai/DeepSeek-R1-0528-Qwen3-8B` 一起验证；G0-4（最小写入→注入→召回闭环）、G0-5（插件真正启用并注入一次）、G0-6（TS7 + eslint 10 拦下跨层 import）、G0-7（`POST /systemone` 打分通道与断网降级）待完成。（来源：Gates）
- **AR-3 分层与依赖方向**：`store/` 不 import 任何其他层；`core/` 不 import `seams/`；`gui/` 不 import `store/`；由 eslint + CI grep 强制，不是口头约定。（来源：AD-15、Design Paradigm）
- **AR-4 存储访问纪律**：业务代码只经 `store/` 具名函数访问 TriviumDB，不引入通用 repository / port 抽象；唯一性由数据库复合唯一索引 `(mem_key, active_slot)` 强制；节点 id 不得进入导出、配置、运行日志或 flag 负载。（来源：AD-2、AD-3）
- **AR-5 单写队列**：全进程只有一个写队列 `store/commits/queue.ts`，所有 `commitTransaction` 由其串行提交，优先级 对话写入 > 快照 > dream；任何模块不得自行加锁或绕过队列。（来源：AD-4）
- **AR-6 词汇表锁定**：14 个节点 kind（`assertion` `evidence` `entity` `episode` `scene` `pref` `persona_state` `flag` `whatif` `decision` `dream_cycle` `dream_log` `rejected` `pred`）与 11 个 edge label（`supersedes` `contradicts` `supports` `refutes` `enriches` `about` `part_of` `derived_from` `anchor` `in_episode` `covers`）；`flag` 与 `decision` 是节点不是边，`supported_by` 已废弃。（来源：Structural Seed、prd addendum §5）
- **AR-7 配置单一出处**：`src/seams/config.ts` 的 zod schema 是唯一真相，含全部键、默认值与互斥规则；环境变量只承载 `SILICONFLOW_API_KEY`；预算四键（抽取 / 向量 / 重排调用、固化 token）在此封顶。（来源：AD-26）
- **AR-8 八个固定错误码**：`OMW_DB_OPEN` / `OMW_SNAPSHOT_VERIFY` / `OMW_DIM_MISMATCH` / `OMW_EMBED_AUTH` / `OMW_EMBED_QUOTA` / `OMW_EMBED_TIMEOUT` / `OMW_EXTRACT_FAIL` / `OMW_DREAM_BUDGET`；新增或改名都算破坏兼容。（来源：Operations、FR-18）
- **AR-9 注入与工具独立降级**：两者各自独立 try/catch、独立降级，共用同一库句柄但不得互相回滚。（来源：AD-18）
- **AR-10 启用三步**：① `package.json` 声明依赖并写 `dsh.profile.bundles`；② 改宿主 `cordis.patch.yml`（不是生成物 `cordis.yml`）添加 `{id, name, config}`；③ 重启后验证（注入段可见、`omw doctor` 全绿）。（来源：Operations、AD-26）
- **AR-11 外部调用只有三条通道**：`src/store/embedding.ts`（`POST /embeddings`）、`src/seams/llm.ts`（chat completions）、`src/seams/systemone.ts`（`POST /systemone`）；各一文件、各自独立熔断与独立预算，除此之外不得发起网络请求；密钥只从环境变量读。（来源：AD-23）
- **AR-12 召回候选线程化**：`search()` 是同步原生调用且无 timeout 参数，必须放 `worker_threads` 并用 `RequestContext(id, timeoutMs)` 让原生查期限；subprocess 与端口监听仍全线禁止。（来源：AD-1、AD-8、AD-19）
- **AR-13 审计与日志落盘**：注入 / 召回审计写 `audit-YYYYMMDD.jsonl`（按天切分、保留 30 天、只落文件、轮转只经 `ops/retention.ts`）；运行日志 `omw.log` 一行一事件 `{ts, level, code, detail}`。（来源：AD-20、Operations）
- **AR-14 固化配套**：每阶段写 `dream_log`；② 抽样种子 `hash(date, stage)`；周期标记 `dream_cycle:<date>` 用本地时区并写 `tz` / `utc_offset`；夜间窗口本地 02:00–05:00，唯一索引保证一天一次。（来源：AD-10）
- **AR-15 迁移实现口径**：`USER.md` 按 `§` 分段、`MEMORY.md` 逐条转 `pref` / `assertion`；`mem_key` 用业务身份，`uuid5(namespace, file:linehash)` 只写进 payload 的 `migration_id`；不删除、不修改 mnemon 源文件；`config.legacyMnemonInject` 改动需重启插件才生效。（来源：AD-16）
- **AR-16 v1 评测交付物**：`eval/golden-l1.jsonl`（50 条标注样本）、`eval/governance-20.md`（治理三问记录）、`eval/rubric.md`（盲判口径）、`scripts/eval.ts`（运行脚本）、`scripts/audit-report.mjs --since 24h`（p50/p95 与降级计数）；M0 探针 `scripts/probe-m0.ts`（`--seq` / `--dim`）与 `scripts/probe-g0-8.ts`（`--discover` / `--ping` / `--all`，G0-8 判据 + 证据 JSON，已落地）。（来源：PRD §6.1、§7、Operations）
- **AR-17 治理投影是唯一只读出口**：只读数据只能由 `core/projections/*.ts` 的纯函数产出 DTO（`flagQueue` / `versionChain` / `exportJsonl` / `explain`），DTO 自带 `contractVersion`，经 `seams/projection-bridge.ts` 暴露；`gui/` 只允许 import DTO 类型。（来源：AD-24）
- **AR-18 停用与卸载**：停用 = 从 profile 补丁移除条目并重启，数据原地保留；卸载只走 `scripts/dispose.ts --export-then-delete`（先导出 JSONL 再删插件目录），`audit.jsonl` 默认不随卸载删除。（来源：Operations、AD-5）
- **AR-19 升级与契约版本**：读 `meta.contract_version`，高于代码支持版本即按 AD-13 整体 no-op；低于则跑迁移，迁移前强制快照。（来源：Operations、AD-13）
- **AR-20 Deferred 项不得提前实现**：表达层（Voice）、主动搭话、技能自演进、whatif 生成、治理 GUI、多用户 / 跨设备 / 鉴权均不进 v1；只允许保留契约与表结构占位（`whatif` 节点仅建表与结算字段）。（来源：Deferred、PRD §6.2）

### UX Design Requirements

（无——见 Overview：UX 契约不存在，v1 无图形界面，治理面是命令 + 导出。此段有意留空。）

### FR Coverage Map

| FR | Epic | 落在哪个用户结果上 |
| --- | --- | --- |
| FR-1 | Epic 2 | 写下的一句话能按业务键查回，并追到会话、seq 与 ≤200 字引文 |
| FR-2 | Epic 2 | 一次写入要么全成、要么全不成，被拒写入有 rejected 记录 |
| FR-3 | Epic 2 | 改写留旧版本，业务数据没有物理删除路径 |
| FR-4 | Epic 2 | 召回只读、默认 5 条 / 上限 8 条、只返回未失效版本 |
| FR-5 | Epic 5 | 三段召回各有退路，1000ms 到点交候选、不返空 |
| FR-6 | Epic 2 | 注入只有一个出口，身份段 1200 字符、状态尾巴 30 token、场景不常驻 |
| FR-7 | Epic 2 | 每次注入与召回都留审计行，三个 p95 可复算 |
| FR-8 | Epic 6 | 八步顺序固定，①②⑥⑦ 的依赖对象里没有模型客户端 |
| FR-9 | Epic 6 | 每一步独立提交，进程被杀后从断点续跑 |
| FR-10 | Epic 6 | 预算三层取最小、超了停在段边界、错过只补当天一次 |
| FR-11 | Epic 3 | 每条记忆答得出谁改的、依据什么、为什么 |
| FR-12 | Epic 3 | 冲突分三级，只有自动档改数据且可整体撤销 |
| FR-13 | Epic 3 | 撤销是一个操作单元，撤销后逐条等于操作前 |
| FR-14 | Epic 6 | 推断没有判别式就不许进断言层，证伪不删除 |
| FR-15 | Epic 1 | 库打不开时身份段照常注入，字节稳定 |
| FR-16 | Epic 7 | 状态可缺席但不填默认值，越界在工具执行前被拒 |
| FR-17 | Epic 1 | 启用三步可验证，体检五项各有非零退出码 |
| FR-18 | Epic 1 | 降级只有整体 no-op 与只关向量两档，八个错误码封闭 |
| FR-19 | Epic 1 | 每天一份已校验快照，保留 7 份，恢复前先停库 |
| FR-20 | Epic 5 | 四类日上限命中后各自降级，审计可输出 p50/p95 |
| FR-21 | Epic 7 | mnemon 迁移幂等、失败回滚、可重跑不重复 |
| FR-22 | Epic 4 | 自动抽取只记该记的，读取边界可审计 |
| FR-23 | Epic 3 | 四条只读治理命令是 v1 交付物，30 秒答清三问 |
| FR-24 | Epic 3 | 全量数据可导出为纯文本 + JSONL，不含节点 id |

**NFR 落点**：NFR-1 / NFR-9 → Epic 2（注入预算与 p95），Epic 5 复测；NFR-2 → Epic 5（召回 p95 与降级比例）；NFR-3 → Epic 2（写事务 p95），Epic 3 撤销路径复用；NFR-4 → Epic 1、Epic 5（降级不产生幽灵状态）；NFR-5 / NFR-6 → Epic 2（引文与脱敏）、Epic 3（导出）；NFR-7 → Epic 2（注入/召回审计）、Epic 6（固化审计）；NFR-8 → Epic 1（形态约束）；NFR-10 → Epic 1（快照/句柄锁）、Epic 7（迁移前快照）。

**无孤儿 story 规则**：每个 story 的 AC 至少引用一条 FR 或 NFR；没有 FR 归属的纯技术 story 必须挂在某个 epic 下并说明它支撑哪条 FR。

**可执行不变量落点（I1–I15）**：`requirements.md` 末尾的 15 条不变量是 acceptance 里程碑（M0–M5 的 I 编号）直接引用的判据，每条都必须落在一个 story 的 AC 上，不允许只写在文档里。

| # | 断言 | 落点 |
| --- | --- | --- |
| I1 | 默认查询永不返回 `superseded_at` 非空的节点 | 2.1 / 2.5 |
| I2 | 全仓零物理删除（三个具名豁免除外） | 2.3 |
| I3 | 每轮注入不超预算，审计行可复算 | 2.4 / 2.6 |
| I4 | 召回在 1000ms 硬上限内返回候选，② 失败不返空 | 5.1 / 5.2 |
| I5 | dream 同日二次运行无 diff | 6.4 |
| I6 | 库不可用时零注册 | 1.3 |
| I7 | 无 `falsifier` 的推断不入库 | 6.5 |
| I8 | 快照可用（`complete=true` + crc） | 1.5 |
| I9 | 身份段字节稳定（连续 100 轮 sha256 不变） | 2.4 |
| I10 | 证据指针可回读 | 2.2 |
| I11 | dream 中断可从最后完成的阶段续跑 | 6.3 |
| I12 | 治理能答「谁改的、为什么」 | 3.1 |
| I13 | 撤销单元整体回滚 | 3.4 |
| I14 | 插件能被真正启用并注入一次（G0-5） | 1.1 |
| I15 | 三项 p95 达标 | 2.1 / 2.6 / 5.4 |

## Epic List

本文按 **7 个 epic** 组织，顺序即交付顺序。每个 epic 交付一个完整的用户结果，只依赖前面的 epic，不需要后面的 epic 才能工作。

1. **Epic 1: 装得上、坏得起** — 插件底座与可验证的启用（FR-15, 17, 18, 19；依赖：无）
2. **Epic 2: 记得进、查得到** — 显式记忆与可追源的最小闭环（FR-1, 2, 3, 4, 6, 7；依赖：E1）
3. **Epic 3: 能查账、能反悔** — 治理面（FR-11, 12, 13, 23, 24；依赖：E1, E2）
4. **Epic 4: 自己记，只记该记的** — 自动抽取与判定（FR-22；依赖：E1, E2）
5. **Epic 5: 快而稳** — 三段召回与成本封顶（FR-5, 20；依赖：E1, E2）
6. **Epic 6: 夜里整理** — 八步固化与可结算推断（FR-8, 9, 10, 14；依赖：E1, E2, E4）
7. **Epic 7: 它还认得我** — 状态尾巴、关系四维与 mnemon 迁移（FR-16, 21；依赖：E1, E2, E3）

**交付顺序的理由：** 治理（Epic 3）排在自动抽取（Epic 4）之前，是因为 PRD §7 要求 v1 先兑现「可治理性」与「可回滚」——这两条是差异化，也最快能被外部检验；用显式 `remember` 产生的记忆同样能跑治理三问与撤销，不必等自动抽取。固化（Epic 6）必须等 Epic 4，因为它的锚点来自抽取产物。

### Epic 拆分与文件重叠的取舍（step-04 校验记录）

> step-04 要求：多个 epic 反复改同一批核心文件时，必须说明拆分的收益，或记录「曾考虑合并并否决」的理由。下表是本清单的实际重叠与裁决。

| 核心文件 | 涉及的 Epic | 为什么仍分在多个 epic 里 |
| --- | --- | --- |
| `store/templates/*` + 召回编排 + `seams/tools` | Epic 2、Epic 5 | 反馈回路：Epic 2 先把「查得到且只给未失效版本」做对并演示，Epic 5 才在**真实召回**上做 250/600/20ms 预算与熔断。若合并，正确性回归与延迟回归会互相污染，且预算 schema 的不足只会在压力下暴露——那正是 Epic 5 要发现的。 |
| `seams/prompt-composer.ts` | Epic 2、Epic 7 | Epic 2 建「唯一出口 + 两段预算」，Epic 7 往里填四维档位。Epic 2 时空尾巴整段省略并记 `tokens: 0`，避免用占位文本假装通过。 |
| `store/commits/*` | Epic 2、Epic 3、Epic 4 | 同一条写队列上三种来源：显式 remember、治理回退、自动抽取。三者共享「整表落或不落」的语义，但验收不同（正确性 / 可回滚 / 判定口径）。 |
| `seams/tools.ts` | Epic 2、Epic 3、Epic 7 | 工具面是公开契约，四个工具在 Epic 2 定型，Epic 3 加只读命令的边界语义，Epic 7 加 `E_BOUNDARY` 拒绝。属于同一份契约的逐层加固。 |

**曾考虑的合并：Epic 2 + Epic 5 → 单个「记忆读写」epic。** 否决理由：Epic 2 的验收是正确性与可追源（一条断言写得进、查得回、追得到来源），Epic 5 的验收是 p95 与降级行为（1000ms 硬截止、重排熔断、日上限降级）。合并后一次改动同时威胁两类判据，回归失败时无法判断是「记错了」还是「慢了」。补偿措施：Epic 2 的 Story 2.5 必须跑一次**不含重排**的召回 p95 基线，把「慢」与「重排不可用」提前分开。

**反向约束：** 任何 epic 不得为自己的验收去预埋后续 epic 的实现（例如 Epic 2 不得先把状态尾巴的占位文本写进 `prompt-composer.ts`，Epic 4 不得先建固化需要的锚点表）。

## Epic 1: 装得上、坏得起 — 插件底座与可验证的启用

Elliott 能在 DSH 里真正启用哦鲸鲸，并用一条体检命令确认五项全绿；当单文件库打不开、快照校验失败、维度不符或契约版本不符时，插件整体 no-op——不注入记忆、不注册写工具、不排固化——但身份段照常出现，鲸鲸还是鲸鲸，只是这一轮不记得细节；每天有一份已校验快照，保留 7 份。这一层先立起来，是因为后面每一个 epic 都要求「库坏了不装死」而不是「先跑起来，回头补」。

**FRs covered:** FR-15, FR-17, FR-18, FR-19

**支撑 NFR / AR：** NFR-8、NFR-10、NFR-4（形态与降级）；AR-1 脚手架、AR-2 M0 闸门、AR-3 分层、AR-7 配置单一出处、AR-8 错误码、AR-10 启用三步、AR-13 日志、AR-18 停用/卸载、AR-19 契约版本

**依赖：** 无。

**风险边界：** M0 八道闸门——G0-4 / G0-5 / G0-6 未过就不往下走（G0-1/2/3 已实测，作为回归项）。

### Story 1.1: 插件能被 DSH 加载（脚手架 + 启用三步的前两步）

As a Elliott，
I want 在 profile 里启用 oh-my-whale 后重启 DSH 就能看到它加载，
So that 我在一分钟内就能判断「到底装上了没有」，而不是靠日志推测。

**Acceptance Criteria:**

**Given** 仓库当前只有 `docs/` 与 `scripts/`（无 starter template）
**When** 执行本 story 的脚手架脚本
**Then** 生成 `src/{core,store,dream,persona,seams,gui,ops}`、`assets/`、`eval/`、`test/` 目录，`package.json` 锁定 Node 24.21.0 / TypeScript 7.0.2 / pnpm 12.18.0 / vitest 5.1.1 / eslint 10.15.0 / zod 4.6.7 / triviumdb 0.9.3 / DSH 0.2.2-rc.5
**And** `tsconfig.json` 与 `eslint.config.js` 就位，`pnpm test` 在空测试集上通过（AR-1、Structural Seed）

**Given** `package.json` 已写 `dsh.profile.bundles`
**When** 在宿主 `cordis.patch.yml` 添加 `{id, name, config}` 条目并重启 DSH
**Then** 启动输出出现 `[omw] loaded`，系统提示里出现 `omw:persona` 段
**And** 改的是生成物 `cordis.yml` 时不生效，且 `omw doctor` 明确指认「补丁文件改错位置」（AR-10、FR-17；G0-5）

**Given** 插件已加载
**When** 在 `docs/` 之外执行 `pnpm build`
**Then** 产物可被 DSH 从 profile 目录加载，无需监听端口、无需 spawn 子进程（NFR-8）

### Story 1.2: 一条命令看清五项体检

As a Elliott，
I want 运行 `omw doctor` 就逐项看到库、快照、维度、凭据、注入段是否就绪，
So that 出问题我知道该改哪一项，而不是把所有配置都翻一遍。

**Acceptance Criteria:**

**Given** 已按三步启用且配置齐备
**When** 运行 `omw doctor`
**Then** 依次输出五项结果（库能开 / 快照校验通过 / 维度匹配 / 凭据可用 / 注入段已注册）且全部 pass，退出码 0（FR-17）

**Given** 配置 `db.dim = 1024` 而库实际维度不同
**When** 运行 `omw doctor`
**Then** 维度项 fail，退出码非零，输出点名 `db.dim` 与 `OMW_DIM_MISMATCH`（FR-17、FR-18、AR-8）

**Given** 五种错误配置（依赖未声明 / 补丁文件改错 / schema 校验失败 / 注入段未注册 / 库不可开）各一种
**When** 分别运行 `omw doctor`
**Then** 五种情况各自返回非零退出码，并打印出错的那一项与配置键名，不打印密钥（FR-17、AR-7）

**Given** 环境没有 `SILICONFLOW_API_KEY`
**When** 运行 `omw doctor`
**Then** 凭据项 fail 且全程零网络请求（AD-23、FR-17）

**Given** `omw doctor` 任意一次运行结束
**When** 检查库与审计目录
**Then** 零业务写入（不建节点、不写账本），只有 `omw.log` 追加一行（FR-17、NFR-7）

### Story 1.3: 库坏了整体 no-op，但鲸鲸还是鲸鲸

As a Elliott，
I want 单文件库打不开或契约版本不符时插件整体停用、但身份段照常注入，
So that 坏掉的是记忆，不是人设——不会出现「半个插件」这种说不清的状态。

**Acceptance Criteria:**

**Given** 库文件损坏或被其他进程独占（`OMW_DB_OPEN`）
**When** 一个对话回合开始
**Then** 不注入记忆段、不注册 `remember` / `recall` / `forget` / `explain` 工具、不排固化，但 `omw:persona` 身份段照常注入（FR-15、FR-18、AD-13）

**Given** 已进入整体 no-op
**When** 检查 `omw.log` 与审计文件
**Then** 恰有一行 `{ts, level: error, code: OMW_DB_OPEN, detail}`，且审计里不存在任何「已注入记忆」的记录（AR-13、NFR-4）

**Given** `meta.contract_version` 高于代码支持版本
**When** 插件启动
**Then** 同样整体 no-op，日志点名 `contractVersion` 的两侧取值（AR-19、FR-18）

**Given** 已处于 no-op
**When** 不重载插件地继续对话若干轮
**Then** 状态不变（不自愈、不重试），库写入调用次数为 0；重载插件后才恢复（FR-18、AD-13）

**Given** 测试用脏库 fixture
**When** 跑 `test/degrade/no-op.test.ts`
**Then** 断言成立：注入的身份段字节与健康库时完全一致（FR-15）

### Story 1.4: 向量路径坏了只关向量

As a Elliott，
I want 向量服务 401 / 402 / 超时时只关闭向量路径、其余记忆照常工作，
So that 一个第三方服务抽风不会让我整个记忆系统停摆。

**Acceptance Criteria:**

**Given** `SILICONFLOW_API_KEY` 无效导致 401
**When** 插件启动或首次向量调用
**Then** 记 `OMW_EMBED_AUTH`，向量路径关闭，文本与图召回照常、四个工具全部可用（FR-18、AD-19）

**Given** provider 返回 402 配额耗尽
**When** 发生向量调用
**Then** 记 `OMW_EMBED_QUOTA` 并按同一档降级，不重试、不阻塞写入（AD-19、FR-18）

**Given** 单次向量调用超过 2s
**When** 该调用超时
**Then** 记 `OMW_EMBED_TIMEOUT`，该条 `vec_state` 回落 `pending` 由后续补写处理，写事务本身成功（AD-19、NFR-3）

**Given** 向量路径已关闭
**When** 执行一次召回
**Then** 结果非空且审计 `degraded_reason: vec_unavailable`，取值在封闭枚举内（AD-20、FR-4）

**Given** 任意一次启动
**When** 读取内部降级状态
**Then** 只能是 `ok` / `no-op` / `vector-off` 三值之一，测试枚举断言不存在第四种中间态（FR-18）

### Story 1.5: 每天一份已校验快照，留 7 份

As a Elliott，
I want 插件每天自动留一份校验过的快照、只保留 7 份，恢复时先停库，
So that 真出事时我有一个确定能用的回退点，而不是「大概有备份」。

**Acceptance Criteria:**

**Given** 当天还没有已校验快照
**When** 插件启动
**Then** 补做一份并校验通过；同一天再次启动最多多一份且不报错（FR-19、AD-14）

**Given** 已有 7 份快照
**When** 生成第 8 份
**Then** 最旧一份被清理，且清理只经 `ops/snapshots.ts` 的具名豁免路径（FR-19、AD-5、AD-14）
**And** 排序按快照日期最旧优先，同日多份取 mtime 最旧；即使 7 份全来自同一天，也只清理当天最早那份、不动次日

**Given** 需要从快照恢复
**When** 执行恢复命令
**Then** 先 `close()` 再替换文件；Windows 句柄未释放时返回可读错误并提示先停止进程（NFR-10、FR-19）

**Given** 快照目录已存在同名目录
**When** 同日二次生成
**Then** 按预期分支处理（多一份或跳过），不抛未捕获异常（NFR-10、FR-19）

**Given** 即将执行迁移
**When** 迁移开始前
**Then** 必有一份 `snapshots/pre-migration-<ts>`，缺失则迁移拒绝开始（FR-19、FR-21）

## Epic 2: 记得进、查得到 — 显式记忆与可追源的最小闭环

我可以用 `remember` 工具或显式命令让它记住一句话，之后按业务键或关键词召回它，并看到来源（会话、seq 区间、≤200 字引文）；改写留下旧版本而不是覆盖；一次写入要么全成、要么全不成，被拒的写入有 `rejected` 记录；每轮注入只有一个出口，身份段 1200 字符、状态尾巴 30 token、场景不常驻；召回只读、默认 5 条、硬上限 8 条，每次注入与召回都留审计行。

**FRs covered:** FR-1, FR-2, FR-3, FR-4, FR-6, FR-7

**支撑 NFR / AR：** NFR-1、NFR-3、NFR-5、NFR-9；AR-4 存储纪律、AR-5 单写队列、AR-6 词汇表、AR-12 召回线程化、AR-17 投影（为 Epic 3 预留）

**依赖：** Epic 1（插件能启用、配置与错误码已定）。

**风险边界：** 唯一索引 `(mem_key, active_slot)` 的语义必须在本 epic 用一个语义测试钉死，否则后面所有「同键至多一条未失效」的推论都不成立。

### Story 2.1: 用 remember 写下一条断言，立刻能按业务键读回

As a Elliott，
I want 让鲸鲸记住一句话，并立刻按业务键查回它，
So that「记住了」这件事从第一分钟开始就是可验证的，而不是要靠追问才知道。

**Acceptance Criteria:**

**Given** 空库与已注册的 `remember` 工具
**When** 提交一条 `pref`（`Elliott` / `reply_style` = `concise`）
**Then** 事务提交成功，`mem_key` 形如 `pref:Elliott:reply_style:concise`，节点带 `valid_from` 与 `active_slot = 1`（AD-3、FR-1）

**Given** 一次干净安装（`omw doctor` 全绿但库为空）
**When** 本 story 首次建 schema
**Then** 只建断言所需的集合与两个索引（复合唯一 `(mem_key, active_slot)`、普通 `(mem_key, valid_from)`），其余 kind 的集合等到第一次真正需要它的 story 再建——不在 Epic 1/2 一次性铺开全部 schema（AD-15、step-04 校验）

**Given** 同一业务键已存在一条未失效版本
**When** 再写入同键同值
**Then** 不产生第二条未失效节点，返回既有版本；复合唯一索引 `(mem_key, active_slot)` 生效（AD-3、FR-2）

**Given** 二值谓词（无 `obj_norm`）
**When** 写入一条 `persona_state`
**Then** `mem_key` 为 `kind:subj:pred` 三段形态，与四段形态不冲突，且同样受唯一索引约束（AD-3）

**Given** 同键不同值，绕过 supersede 直接插入第二条活版本
**When** 提交
**Then** 数据库抛唯一约束错误，工具层翻译成可读错误码而不是裸异常（FR-2）

**Given** 一张补丁表含 3 个 op，第 3 个 op 非法
**When** 提交
**Then** 前两个 op 也不落库：节点、边、账本条目全为 0，另落一条 `rejected`（含原因与原始补丁），普通查询读不到它（FR-2）

**Given** 谓词登记表（`pred` 节点，`mem_key = pred:<规范名>`）与随安装写入的 10 个种子谓词
**When** 提交一条 `pred` 已在表内的补丁
**Then** 按其 `cardinality` 决定 `mem_key` 是三段（`single`）还是四段带 `obj_norm`（`multi`），并据此判定冲突（FR-2、AD-3、AD-9、AD-27）

**Given** 模型提交一个表里没有的 `pred`
**When** 同一事务提交
**Then** 先建 `pred` 节点（`cardinality=multi`、`status=candidate`、`decided_by=model`）再写断言，并挂一条 `flag_type=predicate_new`；该断言不触发自动裁决，旧版本不被 supersede（FR-2、AD-27、I16）

**Given** 用户要把一个候选谓词提升为 `single`
**When** 提交一条 `kind=pred` 的补丁（actor=user）
**Then** 同一事务内旧 `pred` 置失效 + 新节点生效 + 一条 `decision`，可按 `op_id` 撤销；此后该谓词上的同键冲突才走自动档（AD-22、AD-27）

**Given** 谓词名为空、超过 40 字符、不匹配 `^[a-z][a-z0-9_]*$` 或占用 `omw_` 前缀
**When** 提交
**Then** 整张补丁表拒收并落 `rejected`（FR-2）

**Given** 当天已新建 20 个谓词（`tbox.maxNewPredsPerDay`）
**When** 再提交一个新谓词
**Then** 不再建 `pred` 节点，该断言降级为 `scene` 文本并记一行审计（AD-27）

**Given** 一次正常写入
**When** 计时（≥200 次）
**Then** 写事务 p95 ≤10ms（NFR-3）

### Story 2.2: 每条记忆追得到来源，且引文不夹带隐私

As a Elliott，
I want 每条记忆都能追到它出自哪个会话、哪几个 seq、哪句 ≤200 字的话，
So that 我能判断它是「我说过的」还是「它编的」，而不用担心原文被整段搬进库里。

**Acceptance Criteria:**

**Given** 从会话抽取的一条断言
**When** 读取它的 `evidence`
**Then** 返回 `{session_id, seq_from, seq_to, quote}`，`quote` ≤200 字符，超长标 `truncated`（FR-1、AD-6）
**And** 恰好 200 字符不截断、201 字符截断并标 `truncated`（两条 fixture）；脱敏在截断之前完成，脱敏膨胀后仍须 ≤200

**Given** 引文命中手机号 / 身份证 / 邮箱 / 银行卡正则
**When** 写入
**Then** 该引文脱敏并标 `deidentified`，原文不入库（FR-1、NFR-5）

**Given** 默认导出档
**When** 执行导出
**Then** 含 `deidentified` 的引文不出现（FR-1、FR-24）

**Given** 宿主不提供消息回读能力
**When** 读取该条证据
**Then** 仍返回该条记忆并标 `evidence-unresolvable`，绝不伪造原文（FR-1）

**Given** 任意一条证据
**When** 检查 payload
**Then** 里面只有指针，不存在整段消息文本（AD-6、NFR-5）

### Story 2.3: 改写留旧版本，每次写留一条决策

As a Elliott，
I want 改一条记忆时旧版本被保留、并且留下一条「谁在什么时候为什么改」的记录，
So that 以后有人问「它为什么这么记」，我翻得到证据而不是猜。

**Acceptance Criteria:**

**Given** 已有 active 版本 v1
**When** 通过 `remember` 改值
**Then** v1 的 `superseded_at` 置为毫秒时间戳、`active_slot` 让位，新版本 active；默认查询只返回新版本（FR-3、AD-5）

**Given** 被替换的旧版本
**When** 显式查询历史
**Then** 可取回完整旧值与 `valid_from` / `valid_to`（FR-3）

**Given** 任意一次成功写入
**When** 检查账本
**Then** 恰有一条 `decision`：`{ts, actor, kind, op_id, affected[], target_mem_key, from?, to?, reason, contract_version}`（FR-3、AD-21）

**Given** 业务代码里出现 `delete(` / `deleteManyAtomic(` / `unlink(` / `unlinkLabel(`，或事务 op 字面量 `type: 'delete' | 'unlink' | 'unlinkLabel'`
**When** CI 跑静态门
**Then** 构建失败。门禁是两道：grep 查函数名，AST 查事务 op 字面量（正则认不出字符串拼接与 `as const`）；唯一豁免为 `ops/snapshots.ts`、`ops/retention.ts`、`ops/dispose.ts`，且这三个文件头必须写 `// AD-15 豁免：<用途>`（FR-3、AD-5、AD-15、I2）

**Given** 三个豁免文件之外的任意 `.ts`
**When** 跑该静态检查
**Then** 无一命中，且它是 CI 必过项而不是本地提醒（FR-3）

### Story 2.4: 注入只有一个出口，两段各有预算

As a Elliott，
I want 每轮注入都从同一个出口出来、身份段字节稳定、状态尾巴有硬预算，
So that 提示词前缀缓存一直有效，记忆不会把上下文挤爆。

**Acceptance Criteria:**

**Given** 一个回合开始组装提示词
**When** 注入身份段与状态尾巴
**Then** 身份段走 `ctx.systemPrompt.section({name:'omw:persona'})`、尾巴走 `ctx.systemPrompt.context({name:'omw:persona-state'})`，两处调用只出现在 `seams/prompt-composer.ts`（AD-7、FR-6）

**Given** 身份段文本 ≤1200 字符
**When** 连续两轮文本未变
**Then** 第二次不重写，前缀字节一致，审计 `prefix_unchanged: true`（FR-6、FR-15）

**Given** 连续 100 轮对话（含库不可用的轮次）
**When** 逐轮计算 `omw:persona` section 文本的 sha256
**Then** 100 个哈希全同（I9、FR-15）；判据是哈希，不是「看起来一样」

**Given** 身份段 + 尾巴 + 召回合计超预算
**When** 组装
**Then** 按 身份 > 状态 > 召回 裁剪，审计记 `truncated` 与被裁剪项（FR-6、NFR-9）

**Given** 库里存在场景记忆
**When** 组装提示词
**Then** 场景常驻条数为 0（FR-6）

**Given** 状态尾巴
**When** 计数
**Then** ≤30 token、≤1 条已确认偏好、≤1 条待处理 flag；缺值整段省略、不填默认（FR-6、NFR-9）
**And** 状态尾巴为空时（Epic 7 交付前均如此）整段不出现，审计记 `tokens: 0`，不得用占位文本凑数
**And** 本 AC 在 Epic 7 交付尾巴真实内容后复测；复测之前不得据此判「尾巴已合格」

**Given** `compose()` 同步段
**When** 压测 1000 次
**Then** p95 ≤20ms（NFR-1）

### Story 2.5: 召回只读、有界、只给未失效版本

As a Elliott，
I want 召回永远不写库、永远不翻页、永远只给当前有效的版本，
So that 一次召回不可能悄悄改坏数据，也不会把旧结论当成新结论端上来。

**Acceptance Criteria:**

**Given** 已注册 `recall(query, topK?)`
**When** 调用
**Then** 只返回未失效版本，默认 5 条（FR-4、AD-8）

**Given** `topK = 8` / `topK = 9`
**When** 分别调用
**Then** 前者通过；后者返回 `E_BOUNDARY` 且不执行查询（FR-4、AD-25）
**And** `topK` 为 0、负数或非整数同样返回 `E_BOUNDARY` 且不查库（三条边界 fixture）

**Given** `recall.candidatePool`（默认 12）
**When** ① 段检索返回 30 条
**Then** 进入 ② 的候选被截到 12 条；`topK`（默认 5、上限 8）只决定最终注入条数，两者不互相替代（FR-4、AD-26）

**Given** 一次召回
**When** 监视库调用
**Then** 写调用次数为 0（含 payload 更新与刷盘）（FR-4）

**Given** 全仓 TQL
**When** 静态检查
**Then** 只出现在 `store/templates/`，`prepareTql` 第一实参为字面量，其他文件无 `executePreparedTql`（AD-8）

**Given** 相同输入与相同数据
**When** 连续两次召回
**Then** `{mem_key}` 集合一致；结果带耗时、是否降级与封闭枚举的降级原因（FR-4、AD-20）

**Given** 本 epic 尚无重排（由 Epic 5 提供）
**When** 统计召回 p95
**Then** 只作为「不含重排」的基线记录；NFR-2 的 900ms 以 Epic 5 交付后的复测为最终判据

**Given** 工具 schema
**When** 检查
**Then** 不存在 offset / page / cursor 字段（FR-4）

### Story 2.6: 每次注入与召回都留一行审计

As a Elliott，
I want 每次注入和每次召回都落一行可复算的审计，
So that「为什么这一轮它没记得」这种问题能用数据回答，而不是靠回忆。

**Acceptance Criteria:**

**Given** 一次注入结束
**When** 检查审计
**Then** `audit-YYYYMMDD.jsonl` 追加一行：`{ts, session_id, tier, chars, tokens, items[], truncated, prefix_unchanged, host_cache_read, host_cache_write, host_cache_uncached}`（FR-7、AD-20）

**Given** 一次召回结束
**When** 检查审计
**Then** 追加一行，含命中 `{mem_key}` 集合、耗时与 `degraded_reason`（`recall_timeout` / `rerank_unavailable` / `rerank_circuit_open` / `vec_unavailable` / `embed_circuit_open` / `budget_truncated` 六值封闭）（FR-7、AD-20）

**Given** 审计文件
**When** 检查
**Then** 只落文件不落库、按天切分、保留 30 天，轮转只经 `ops/retention.ts`（FR-7、NFR-7、AR-13）

**Given** 存在 30 天前的审计文件
**When** 运行轮转
**Then** 被清理，且清理路径在具名豁免清单内（FR-7、AD-5）

**Given** 一段窗口的审计
**When** 运行 `scripts/audit-report.mjs --since 24h`
**Then** 输出注入 / 召回 / 写事务三个 p50/p95 与降级计数（FR-7）

**Given** 任意审计行
**When** 检查字段
**Then** 不含节点 id（AD-3、NFR-6）

## Epic 3: 能查账、能反悔 — 治理面

任取一条记忆，一条命令就能答清「谁改的 / 依据什么 / 为什么」（版本链 + 决策账本 + 证据指针，一次调用）；冲突分三级，只有符号可判的自动档会改数据，且每次自动裁决都能按操作单元整体撤销；十次覆盖各类操作的撤销都能逐条回到操作前；全量数据可导出为纯文本 + JSONL。

**FRs covered:** FR-11, FR-12, FR-13, FR-23, FR-24

**支撑 NFR / AR：** NFR-3、NFR-6；AR-17 治理投影 DTO、AR-8 错误码、AR-16 治理 20 问记录

**依赖：** Epic 1、Epic 2（版本链与账本来自写路径）。

**风险边界：** 撤销判据（20 条 fixture、关闭重排）必须在实现前写死；否则「逐条等于操作前」会被实现者解释成「差不多」。

### Story 3.1: 一条命令答清三个问题

As a Elliott，
I want 对任意一条记忆执行一次 `omw explain`，就同时看到谁改的、依据什么、为什么，
So that 我不用在三个地方翻四样东西，也能在 30 秒内对一个结论放心或起疑。

**Acceptance Criteria:**

**Given** 任意 `mem_key`
**When** 执行 `omw explain <mem_key>`
**Then** 一次调用同时返回三问答案：谁改的（账本 actor + ts）、依据什么（evidence 的 `session_id` / seq 区间 / 引文）、为什么（decision 的 kind / reason / `precedent_id`）（FR-11、FR-23）

**Given** 同一次 explain
**When** 分别取 `--json` 与人类可读输出
**Then** 两版字段名完全一致，且都来自治理投影 DTO、自带 `contractVersion`（FR-23、AR-17）

**Given** 不存在的 `mem_key`
**When** 执行
**Then** 退出码 2、空结果、不打印调用栈（FR-23）

**Given** 1000 条记忆的库
**When** 执行一次 explain
**Then** 从命令到三个答案 ≤30 秒（FR-23）

**Given** SM-2 的 20 条 fixture
**When** 逐条执行 `omw explain`
**Then** 20/20 都在 30 秒内答清三问且字段齐全，记录写 `eval/governance-20.md`（SM-2、AR-16）

**Given** 用关键词而非 `mem_key` 调用 `omw explain <关键词>`
**When** 命中多条
**Then** 列出候选 `mem_key` 与一行摘要，不静默选第一条；命中 0 条时退出码 2（FR-23）

**Given** 任意一次 explain
**When** 检查库
**Then** 零写入、不更新热度、不动 `recorded_at`（FR-23、FR-4）

### Story 3.2: 版本链与账本一次读全

As a Elliott，
I want 一条记忆的所有版本与它们对应的账本条目按时间列在一起，
So that「它什么时候变成这样的」是一个可读的事实，而不是需要推理的猜测。

**Acceptance Criteria:**

**Given** 一条被改写过的记忆
**When** 执行 `omw version-chain <mem_key>`
**Then** 按时间返回 v1…vn，每版标 `active` 与否，含 `valid_from` / `valid_to` / `superseded_at`（FR-11、FR-3）

**Given** 同一 `op_id` 影响了多个对象
**When** 查看 `affected[]`
**Then** 它们能归到同一个 `op_id` 下，且 `affected[]` 只含状态类对象与边（FR-11、AD-22）

**Given** 决策账本
**When** 检查 API 面
**Then** 只有 append，没有任何 update / delete 路径（测试断言）（FR-11、AD-21）

**Given** 一条从未被改过的记忆
**When** 执行 version-chain
**Then** 返回单版本而不是空结果（FR-11、NFR-4）

### Story 3.3: 冲突分三级，只有自动档动数据

As a Elliott，
I want 系统只在符号可判的时候自己裁决冲突，其余一律挂起等我，
So that 它不会在「我改主意了」和「它记错了」之间替我投票。

**Acceptance Criteria:**

**Given** 同一谓词单值、同主体同谓词、有效区间重叠、`obj_norm` 不同
**When** 判定冲突
**Then** 自动档在同一事务内完成：旧版本失效 + 新断言 + 一条已解决 flag + 一条 `contradicts` 边（FR-12、AD-9）

**Given** 谓词多值或冲突类别不同
**When** 判定冲突
**Then** 只产生「提案 + 挂起 flag」，既有断言一个字段都不改（FR-12）

**Given** 一条挂起 flag
**When** 未经人工解除而试图自动关闭
**Then** 拒绝执行；`omw flag-queue --status open` 能列出它（FR-12、FR-23）

**Given** flag 的字段
**When** 枚举
**Then** `status ∈ {open, resolved}`、`flag_type ∈ {dangling_evidence, contradiction, refuted, rejected, dream_truncated, migration, predicate_new}`、`resolved_by ∈ {auto, human}`；PRD 的四/五态按此映射——创建与挂起是 `open`、已解决是 `resolved`、已证伪是 `flag_type=refuted`、已撤销由 revert 账本表达（FR-12、data-model §7）
**And** `omw flag-queue --status open` 只按 `status` 过滤；传入 `revoked` 这类不存在的取值返回退出码 2（FR-23）

**Given** 一次自动档裁决
**When** 读它留下的 `decision`
**Then** `op_id` 唯一，`affected[]` 完整列出被改动的状态节点与边（旧断言、新断言、flag、`contradicts` 边），足以让撤销按 `op_id` 整体重放（FR-13、AD-21、AD-22）
**And** 撤销的重放逻辑不在本 story 内——本 story 只保证账本记全了（AD-22）

### Story 3.4: 撤销是一个操作单元，不是一条字段

As a Elliott，
I want 一次撤销把「那次操作带来的所有变化」整体退回去，
So that 反悔是干净的：不会留下半条旧版本、半条 flag、半条边。

**Acceptance Criteria:**

**Given** 任意一次写操作
**When** 检查
**Then** 带 `op_id` 与 `affected[]`，`affected[]` 只含状态类对象与边、不含账本类对象（FR-13、AD-22）

**Given** 一次复合操作（如自动档裁决）
**When** 撤销
**Then** 单事务内反向执行并追加一条「撤销」账本条目，不删除任何历史（FR-13）

**Given** 20 条固定 fixture 操作，构成为 5 类 × 4 条（插入 / 改写 / 自动裁决 / flag 解除 / 推断证伪）
**When** 逐条执行后再逐条撤销
**Then** 每次撤销后比较 `{mem_key, active_version, flag_status, edge_label}` 集合与操作前一致；比较时关闭重排或固定缓存键，不比顺序、耗时与审计字段（FR-13）
**And** 其中 ≥8 条必须是抽取形态的补丁表（一次多个 op、带 evidence 指针、含 `origin=inference`），不得全部由显式 `remember` 造；否则 Epic 4 上线后本验收须重做

**Given** SM-3 的 10 次操作（手动删除 / 固化归档 / 冲突替换 / 过期失效 / 整场景废弃 各 2 次）
**When** 每次操作后完整撤销
**Then** 10/10 零残留：内容、版本链、标记状态、检索结果逐条复原（SM-3、FR-13）

**Given** 撤销过程中任一 op 失败
**When** 提交
**Then** 整体不动（要么整体撤销、要么整体不撤销）（FR-13、FR-2）

**Given** 撤销完成
**When** 执行 `omw explain`
**Then** 看得到那条撤销账本与它的 `op_id`（FR-13、FR-11）

### Story 3.5: 全量导出为纯文本 + JSONL

As a Elliott，
I want 一条命令把全部记忆、偏好、场景与账本导成人类和机器都能读的两个文件，
So that 我可以带走它们，也意味着这个系统随时可以被我自己换掉。

**Acceptance Criteria:**

**Given** 任意非空库
**When** 执行 `omw export`
**Then** 产出两个文件：人类可读纯文本 + 机器可读 JSONL，含断言（带版本链关系）、偏好、场景摘要与账本（FR-24）

**Given** 默认档
**When** 检查输出
**Then** 不含已脱敏引文、不含任何节点 id（FR-24、NFR-6、AD-3）

**Given** `--include-quotes`
**When** 导出
**Then** 含已脱敏引文（仍不含原文）（FR-24、NFR-5）

**Given** 导出产物
**When** 用纯文本编辑器与 `jq` 分别读取
**Then** 都不需要本产品即可读懂（FR-24）

**Given** 尚未导出
**When** 执行卸载
**Then** 拒绝继续；导出完成后卸载流程才放行（FR-24、AR-18）

## Epic 4: 自己记，只记该记的 — 自动抽取与判定

说完一句话，回合结束后自动抽取成断言（3s 去抖、10s 上限、单次调用产出一张补丁表），不需要我点名 `remember`；寒暄与纯执行对话不落库；证据拿不到时标 `evidence-unresolvable` 而不是编造；读取边界可审计（只碰本轮新增 seq 与库内证据指针，lookback ≤30 天，超出标 `evidence-expired`）；50 条标注样本、判定口径与评测脚本落盘。

**FRs covered:** FR-22

**支撑 NFR / AR：** NFR-5；AR-16 评测三件套、AR-6 词汇表（含 `pred` 节点）、AR-11 LLM 通道

**依赖：** Epic 1、Epic 2（写路径与拒收），与 Epic 3 共用账本字段。

**风险边界：** precision 优先——宁可漏记，错记只能靠治理清账；`agent/turn-stopping` 是 serial 事件，监听器同步返回是硬约束。

### Story 4.1: 回合结束后自动抽取，且不拖住对话

As a Elliott，
I want 聊完就自动记，不用我每次说「记住这个」，同时不觉得它在卡我，
So that 记忆是对话的副产品，而不是额外的一道工序。

**Acceptance Criteria:**

**Given** 一个回合产生新消息
**When** `agent/turn-stopping` 触发
**Then** 监听器同步返回，抽取排进 `ctx.timer`（去抖默认 3s、max-wait 10s），回合结束不被阻塞（AD-4、FR-22）

**Given** 一次抽取完成
**When** 检查游标
**Then** `extraction_cursor:<session_id>` 推进到本轮最后 seq（FR-22）

**Given** 同一 turn 被重复触发
**When** 再次排程
**Then** 按 turn 号去重，不重复调用模型（FR-22）

**Given** 消息每 2s 一条、持续 15s（时刻 0/2/4/6/8/10/12/14s），去抖 3s、max-wait 10s
**When** 时间线推进
**Then** 在第 10s 触发一次抽取并重新计时，此后每满一个 max-wait 窗口触发一次；不得因持续有消息而无限推迟

**Given** 抽取首次失败
**When** 重试
**Then** 至多重试一次；再失败落 `rejected` 并记 `OMW_EXTRACT_FAIL`，不写半截（FR-22、FR-18）

**Given** 一次抽取的产物
**When** 落库
**Then** 是一张补丁表并一次提交，禁止逐条流式写库（FR-22、AD-4）

### Story 4.2: 只记该记的（判定口径）

As a Elliott，
I want 它记住我的偏好、决定和纠正，但不把寒暄和「帮我跑个命令」记成关于我的事，
So that 记忆库越用越准，而不是越用越脏。

**Acceptance Criteria:**

**Given** 20 条标注样本（显式偏好 / 决定 / 纠正）
**When** 抽取
**Then** 每条都落成断言：偏好落 `pref`，决定与纠正落 `assertion`（FR-22）

**Given** 20 条标注样本（纯寒暄 / 纯执行性对话）
**When** 抽取
**Then** 落库条数为 0（FR-22）

**Given** 边界样本（不确定是否构成偏好）
**When** 抽取
**Then** 按 precision 优先不落，并在 `rejected` 里留原因（FR-22）

**Given** 任意抽取产物
**When** 检查每条断言
**Then** 都带证据指针或显式 `evidence-unresolvable`；无证据不得落成断言（FR-22、FR-1）

**Given** 一次评测
**When** 统计
**Then** 假阳性与假阴性分开计数，及格线按假阳性加权，口径写死在 `eval/rubric.md`（FR-22、AR-16）

### Story 4.3: 读取边界可审计

As a Elliott，
I want 它抽取时只能读本轮新增的对话和它自己标注过的证据，
So that「它为什么会记错」有边界可查，而不是一句「模型读了不该读的」。

**Acceptance Criteria:**

**Given** 一次抽取
**When** 结束
**Then** 回读记录只含「本轮新增 seq」与「库内已有证据指针」，测试断言越界读取次数 = 0（FR-22）

**Given** 需要回读更早的对话
**When** 计算窗口
**Then** lookback ≤30 天；超出部分标 `evidence-expired` 且不作为证据使用（FR-22）

**Given** 每次回读
**When** 记审计
**Then** 记录 `session_id` 与 seq 范围（FR-22、NFR-7）

**Given** 抽取输入
**When** 组装
**Then** 是会话片段 + 已有记忆的稳定身份（`mem_key`），不含任何节点 id（FR-22、AD-3）

### Story 4.4: 评测集与运行脚本

As a Elliott，
I want 一组标注样本和一条命令，随时能测出「这次的抽取比上次好还是坏」，
So that 调提示词不是凭感觉，也不会悄悄变差。

**Acceptance Criteria:**

**Given** 仓库
**When** 检查
**Then** 存在 `eval/golden-l1.jsonl`（50 条标注）、`eval/rubric.md`（盲判口径）、`scripts/eval.ts`（AR-16）

**Given** `eval/golden-l1.jsonl`
**When** 检查抽样口径
**Then** 50 条按时间分层（近 7 天 20 / 7–30 天 20 / 30 天以上 10），种子预注册并写进文件头，样本集冻结后不得替换（SM-1）

**Given** 判定规则
**When** 检查 `eval/rubric.md`
**Then** 写明假阳性与假阴性分开统计、及格线按假阳性加权，以及单人情境下的「隔 ≥7 天重判 + 两次一致性 ≥90%」替代盲判条款（SM-1、FR-22）

**Given** 运行 `pnpm eval`
**When** 完成
**Then** 输出 precision / recall、FP / FN 分列与按 FP 加权的总分，可与上一次结果直接比较（FR-22）

**Given** 标注样本
**When** 检查格式
**Then** 每条含期望判定（落 / 不落）与期望 kind，可机器判（AR-16）

**Given** 及格线
**When** 查阅
**Then** 写在 `eval/rubric.md` 里，是数字不是「看起来还行」（FR-22）
## Epic 5: 快而稳 — 三段召回与成本封顶

召回在 ①250ms 候选 / ②600ms 重排 / ③20ms 注入的三段预算内完成，合计硬上限 1000ms，到点交候选、不返回空；重排挂了只降级不返空，每回合至多一次并命中缓存；四类日上限命中后各自降级而不是报错；审计可按时间窗口输出 p50/p95 与降级计数。

**FRs covered:** FR-5, FR-20

**支撑 NFR / AR：** NFR-2、NFR-1 复测；AR-11 外部三通道、AR-12 worker 线程、AR-13 审计落盘、AR-7 预算四键

**依赖：** Epic 2（召回基础）、Epic 1（配置与预算 schema）。

**风险边界：** `POST /systemone` 是 Alpha 端点（G0-7）；不可用时整段退化为 ①③，不得把 ② 写成必需。

### Story 5.1: 三段预算与硬截止

As a Elliott，
I want 每一段召回都有自己的时间上限，到点就把手上的交出来，
So that 记忆永远是「这次少给点」，而不是「这次卡住不动」。

**Acceptance Criteria:**

**Given** 一次召回
**When** 执行
**Then** 三段各自计时：① 候选 250ms、② 重排 600ms、③ 注入 20ms，合计硬上限 `recall.deadlineMs = 1000`（FR-5、AR-7）
**And** 三段之和 870ms 之外留 130ms 归 ③ 收尾；① 不得侵占 ②、② 不得侵占 ③，发生侵占即记 `budget_truncated`

**Given** ① 已用满 250ms
**When** 到点
**Then** 用已有候选继续 ③，不返回空（FR-5）

**Given** 总时长到 1000ms 仍未完成
**When** 截止
**Then** 立即交付当前候选，审计记 `recall_timeout`（FR-5、AD-20）

**Given** ③ 只拿到 3 条
**When** 注入
**Then** 就注入 3 条，不凑数、不填占位（FR-5、FR-4）

**Given** ≥200 次召回压测
**When** 统计
**Then** p95 ≤900ms（NFR-2）

### Story 5.2: 重排挂了只降级，不返空

As a Elliott，
I want 重排服务超时或熔断时按候选顺序给我结果，
So that 一个 Alpha 端点抽风不会让「它记得我」变成「它什么都不记得」。

**Acceptance Criteria:**

**Given** `rerank.enabled = true`
**When** 一次召回
**Then** 调 `POST /systemone` score 任务 + `SemIf`，同一回合至多一次（FR-5、AD-23）

**Given** 重排超时或报错
**When** 发生
**Then** 跳过排序、按 ① 顺序注入，记 `rerank_unavailable`，结果非空（FR-5、AD-20）

**Given** 连续 3 次重排超时
**When** 第 3 次结束
**Then** 熔断 10 分钟，期间记 `rerank_circuit_open` 且不发请求（FR-5）

**Given** 同一 query 在 `rerank.cacheTtlMs = 600000` 窗口内
**When** 再次召回
**Then** 命中缓存，不重复付费（FR-5、AR-7）

**Given** `rerank.enabled = false`
**When** 召回
**Then** 不报警、不计降级（FR-5、NFR-4）

**Given** 一周真实运行
**When** 统计
**Then** 重排不可用比例 <5%，候选真空比例 <1%（NFR-2）

### Story 5.3: 四类日上限命中后各自降级

As a Elliott，
I want 每一类调用烧到日上限时只是变笨一点，而不是报错停机，
So that 账单可控，同时对话不会因为我没充值就崩掉。

**Acceptance Criteria:**

**Given** `budget.extractionCallsPerDay` 已用尽
**When** 再次触发抽取
**Then** 只记不抽（落 `rejected` 并注明原因），不报错（FR-20）

**Given** `budget.embeddingCallsPerDay` 已用尽
**When** 新写入需要向量
**Then** 停止补写、`vec_state` 停留 `pending`，写事务本身仍成功（FR-20、AD-19）

**Given** `budget.rerankCallsPerDay` 已用尽
**When** 召回
**Then** 重排降级为候选顺序，记 `budget_truncated`（FR-20、FR-5）

**Given** `dream.dailyTokenCap` 已用尽
**When** 固化进行中
**Then** 停在段边界并记截断，不半途写入（FR-20、FR-10）

**Given** 任一上限命中
**When** 检查审计与内部状态
**Then** 有对应降级计数，且不产生幽灵状态（注入了却没写、工具半可用）（FR-20、NFR-4）

**Given** 全部预算键
**When** 检查配置
**Then** 四键都在 `seams/config.ts` 的 zod schema 内、有默认值、可被覆盖（AR-7）

### Story 5.4: 成本与延迟可看

As a Elliott，
I want 一条命令就看到过去 24 小时的 p50/p95 与降级分布，
So that「它最近变慢了吗」「钱花在哪了」是一分钟能回答的问题。

**Acceptance Criteria:**

**Given** 一段窗口
**When** 运行 `scripts/audit-report.mjs --since 24h`
**Then** 输出注入 / 召回 / 写事务的 p50/p95 与降级计数（FR-20、FR-7）

**Given** 审计里存在降级
**When** 出报告
**Then** 按 `degraded_reason` 六值分组统计（FR-20、AD-20）

**Given** 报告命令
**When** 执行
**Then** 只读文件、不查库、不需要插件在运行（FR-20、NFR-8）

**Given** 一天结束
**When** 检查审计目录
**Then** 按天切分，≥30 天前的文件被轮转清理（NFR-7、AR-13）

## Epic 6: 夜里整理 — 八步固化与可结算推断

夜间窗口或空闲触发跑一次八步固化，确定性步骤不碰模型；每个模型步骤先提炼后核验，核验不过就停在段边界；进程被杀后从最后完成的阶段续跑，不重跑整夜；预算三层取最小、超了停在段边界并记截断；推断必须带可执行判别式，否则只能落成场景文本；「从未运行」在审计里是可见状态。

**FRs covered:** FR-8, FR-9, FR-10, FR-14

**支撑 NFR / AR：** NFR-7（固化审计）；AR-9 注入/工具解耦（dream 不得拖住对话）、AR-14 周期标记与种子、AR-11 LLM 通道

**依赖：** Epic 1（调度与配置）、Epic 2（store 与断言）、Epic 4（锚点来自抽取产物）。

**风险边界：** G0-8 已于 2026-11-23 通过（提炼 `Qwen/Qwen3.5-9B`、核验 `deepseek-ai/DeepSeek-R1-0528-Qwen3-8B`，证据 `docs/implementation-artifacts/gates/g0-8-2026-11-23.json`）；提炼调用必须关思考、核验重试一次，见 AD-10；⑤ 仍默认关闭。

**DoR（Definition of Ready）：** ① G0-8 已过（2026-11-23 实测）且 `omw doctor --models` 显示两个模型 id 可用；② 锚点密度门槛已实测通过——在本 epic 开工前，先用 Epic 4 的 50 条样本量一次：每 20 轮 ≥3 个锚点。两项任一不满足，本 epic 不排期。

### Story 6.1: 八步骨架，确定性步骤不碰模型

As a Elliott，
I want 整理这件事有固定顺序、能复现的部分真的能复现，
So that 每个早晨的结果差异只来自模型那几步，而不是来路不明的随机。

**Acceptance Criteria:**

**Given** 一次固化
**When** 启动
**Then** 按 ①确定性结算 ②重放抽样 ③模式提取 ④场景抽象 ⑤What-If ⑥剪枝归档 ⑦跨主题重组 ⑧策略提炼 的顺序跑，阶段名固定为这 8 个（FR-8、AD-10）

**Given** ①②⑥⑦
**When** 检查它们的依赖对象
**Then** 不含 `llm`，由 `test/dream/no-llm.test.ts` 断言而不是靠评审（FR-8）

**Given** 同一 date 与同一 stage
**When** 跑两次确定性步骤
**Then** 输出逐字节一致（种子 `hash(date, stage)`）（FR-9、AR-14）

**Given** 一次周期开始
**When** 写标记
**Then** 写 `dream_cycle:<date>`（含 `tz` / `utc_offset`），唯一索引保证一天一次（FR-9、AR-14）

**Given** ⑤ 处于默认配置
**When** 固化运行
**Then** 跳过；开启时深度 ≤2、默认一条、单锚点一分叉，产物永不进断言层（FR-8、AR-20）

**Given** Epic 4 已交付，用其 50 条标注样本跑一遍真实抽取
**When** 统计锚点密度
**Then** 每 20 轮对话至少产生 3 个可提炼锚点；低于此数先回 Epic 4 调判定，不开跑本 epic（否则 ③④⑧ 会「无料可提炼」而 story 全过）

### Story 6.2: 每个模型步骤先提炼后核验

As a Elliott，
I want 模型写出来的东西先被另一个模型核对一遍，核不过就整步不算，
So that 夜里自动生成的结论不会悄悄变成「事实」。

**Acceptance Criteria:**

**Given** ③④⑤⑧ 中任一步
**When** 执行
**Then** 先提炼（`Qwen/Qwen3.5-9B`）后核验（`deepseek-ai/DeepSeek-R1-0528-Qwen3-8B`），两段记录都留（FR-8、AR-11）

**Given** 核验结论为不通过
**When** 该步结束
**Then** 该步不提交，后续按缺步处理，停在段边界（FR-8）

**Given** 一条被刻意删掉证据指针的产物
**When** 核验
**Then** 必须判「不通过」（G0-8 验收样例）（FR-8、AR-2）

**Given** 任意模型步骤产物
**When** 检查
**Then** 带提示词版本与周期标识（FR-8）

**Given** 两个模型 id
**When** 检查配置
**Then** 都在 `seams/config.ts` 里；未实测可用前 ③④⑧ 不得开跑（AR-2、AR-7）

### Story 6.3: 断点续跑与 dream_log

As a Elliott，
I want 夜里那一次整理被中断后能接着做完，而不是整夜白发，
So that「它昨晚到底做了什么」永远有账可查。

**Acceptance Criteria:**

**Given** 固化跑到 ④ 时进程被杀
**When** 重启并再次触发
**Then** 从 ④ 续跑，不重跑 ①②③（FR-9）

**Given** 每一步完成
**When** 结束
**Then** 独立提交一条 `dream_log`：阶段、种子、diff 摘要、token 消耗（FR-9、AR-14）

**Given** 当天已有 `dream_cycle:<date>`
**When** 再次触发
**Then** 直接退出，不重复跑（FR-9）

**Given** 模型步骤被重跑
**When** 比较两次
**Then** 只保证记录提示词版本、种子、输入锚点集与输出摘要，不承诺逐字节一致（FR-9）

**Given** 一次固化从未运行过
**When** 查看审计
**Then** 显示「从未运行」，是可见状态而不是空白（FR-10）

### Story 6.4: 触发条件与预算三层

As a Elliott，
I want 它只在夜里或我离开后干活，并且花到我设的上限就停，
So that 它不跟我抢时间，也不会一夜之间烧掉一个月额度。

**Acceptance Criteria:**

**Given** 本地时间进入 02:00–05:00 且当天无 cycle 标记
**When** 调度检查
**Then** 启动一次固化（AR-14、FR-10）

**Given** 最后交互后 30 分钟无事件且当天无标记
**When** 空闲判定
**Then** 触发一次并标 `idle_triggered`；同日连续空闲 10 次仍只 1 个 cycle（FR-10）

**Given** 固化进行中用户发来消息
**When** 交互到达
**Then** 只在段边界让路，不打断当前步、不丢已提交的阶段（FR-10）

**Given** 阶段预算 / 日 token 上限 / provider 配额
**When** 取最小
**Then** 得到实际预算；命中即停在段边界，置 `dream_cycle.truncated = true` 并挂一条 `flag_type: dream_truncated`，不半途写入（FR-10）

**Given** `--dry-run`
**When** 运行
**Then** 只跑 ①② 并输出 diff，不写库（FR-10）

**Given** 连续 3 天 02:00–05:00 离线、第 4 天 09:00 启动
**When** 触发
**Then** 恰好 1 个 cycle（只补当天一次）（FR-10）
**And** 该 cycle 由空闲触发产生（09:00 启动 → 30 分钟无交互 → 09:30 触发一次），不走夜间窗口；时间线为 09:00 启动 / 09:30 触发 / 之后 10 次空闲不再触发

**Given** 一次完整固化
**When** 统计模型调用
**Then** ≥6 次（③④⑧ 各一提炼 + 一核验），日调用上限覆盖该下限并留重试余量（FR-10）

### Story 6.5: 推断必须可结算

As a Elliott，
I want 它对「我大概喜欢什么」这类推断都带一个能被证伪的条件，
So that 猜测永远是猜测，被现实推翻时会被记下来而不是被删掉。

**Acceptance Criteria:**

**Given** `origin = inference` 的断言
**When** 提交
**Then** 必须带判别式（`op ∈ eq/ne/gt/lt/gte/lte/exists/count_gte` + 白名单字段）与 `settle_state ∈ {open, confirmed, refuted}`（FR-14、AD-17）

**Given** 推断缺判别式或字段不在白名单
**When** 提交
**Then** 拒收，该推断只能落成 scene 描述文本，不落断言层（FR-14、FR-22）

**Given** 一条推断的判别式被命中
**When** 结算
**Then** `settle_state` 变为 `confirmed` 或 `refuted`，并记一条 `supports` 或 `refutes` 边（FR-14、AD-17）

**Given** 推断被证伪
**When** 结算
**Then** 不删除：置失效（写 `superseded_at`）并挂一条 `flag_type: refuted`（FR-14、AD-17）

**Given** 一条推断
**When** 执行 `omw explain`
**Then** 看得到判别式、结算状态与它依据的证据（FR-14、FR-11）

## Epic 7: 它还认得我 — 状态尾巴、关系四维与 mnemon 迁移

状态尾巴里只有四维与档位、至多一条已确认偏好、至多一条待处理标记；缺失就整段省略，不填默认值；越界在工具执行前被拒绝，而不是靠提示词提醒；一次性把 mnemon 的 `USER.md` / `MEMORY.md` 迁进来，迁完注入快照里 mnemon 段落出现 0 次，失败自动回滚到迁移前快照，重跑不重复。

**FRs covered:** FR-16, FR-21

**支撑 NFR / AR：** NFR-9（尾巴预算）；AR-15 迁移实现口径、AR-6 词汇表（pref / persona_state）、AR-19 契约版本

**依赖：** Epic 1、Epic 2；迁移报告与回滚复用 Epic 3 的导出与账本。

**风险边界：** 本机无 mnemon 历史数据，迁移验证走 fixture；「失败不改变任何东西」必须用一次故意失败的迁移证明。

**配置增量：** `persona.strengthMax`（默认 5）是本项目第一个超出 AD-26 现有键表的配置键，落地时须同步补进 `ARCHITECTURE-SPINE.md` 的 AD-26 默认值表，否则「配置只有一个出处」会被悄悄破坏。

### Story 7.1: 状态尾巴只有四维与档位

As a Elliott，
I want 每轮看到的是「我们现在算什么位置」的几个档位，而不是一大段人物小传，
So that 它认得我的方式是稳定的，且不占掉我真正要用的上下文。

**Acceptance Criteria:**

**Given** 关系四维存在
**When** 组装状态尾巴
**Then** 只出现四维数值与档位（≈12 token）+ 至多一条已确认偏好 + 至多一条待处理 flag，合计 ≤30 token（FR-16、FR-6）

**Given** 四维首次写入
**When** 建状态
**Then** 初值均为 50（FR-16）

**Given** 单次正向事件 / 负向事件
**When** 更新
**Then** 正向步长 ≤3×强度、负向 ≤2×强度，且值域被夹在 0–100（FR-16）
**And** 强度取值范围 0–5，上限写在 config（`persona.strengthMax`，默认 5）；据此步长上界为 +15 / −10

**Given** 三档阈值 45 / 70
**When** 计算档位
**Then** 可从配置读出，并能解释某条记忆为何落在该档（`closeness = (intimacy + trust) / 2`）（FR-16、AD-12）

**Given** 状态缺失或库不可用
**When** 组装
**Then** 整段省略、不填默认值、不留占位（FR-16、NFR-4）

### Story 7.2: 越界在工具执行前被拒

As a Elliott，
I want 明显越界的更新在执行之前就被拒绝，
So that 我不会得到一条「看起来更新了其实没写」的假状态。

**Acceptance Criteria:**

**Given** 四维写入 101，或步长 4× 强度
**When** 调用 `remember` 工具
**Then** 在 `execute` 之前返回 `E_BOUNDARY`，不产生任何写入（FR-16、AD-12、AD-25）

**Given** 非法 payload（维度名拼错、类型不符）
**When** 调用
**Then** 被 zod schema 拒绝并给出字段路径（AR-7）

**Given** 任一被拒绝的调用
**When** 检查库
**Then** 零写入、零账本条目（FR-16、NFR-3）

**Given** 合法更新
**When** 成功
**Then** 落一条 `decision`（actor / kind / 受影响对象），可从 explain 看到（FR-16、AD-21）

**Given** 四类边界场景（自伤与危机 / 越界亲密 / 法律医疗的确定性建议 / 索取他人隐私）
**When** 工具被调用
**Then** 在 `execute` 之前返回结构化拒绝（`E_BOUNDARY` + 边界类别），零写入、零账本条目（FR-16、AD-12、方案设计 §7）

### Story 7.3: 把 mnemon 迁进来，且可以重来

As a Elliott，
I want 一次把 mnemon 的 `USER.md` 和 `MEMORY.md` 搬进新系统，搬失败就什么都不改，
So that 换系统这件事不会让我丢掉半年攒下的自我描述。

**Acceptance Criteria:**

**Given** 首次迁移
**When** 尚未跑 `--dry-run`
**Then** 拒绝真实写入；dry-run 输出「将迁入 / 将跳过」计数与逐条原因、不写库（FR-19、FR-21）
**Given** `USER.md`（按 `§` 分段）与 `MEMORY.md`（逐条）
**When** 运行迁移
**Then** 分别转成 `persona_state` / `pref` / `assertion`，`mem_key` 用业务身份而不是行哈希（FR-21、AR-15）

**Given** 某一行已迁移过
**When** 再次运行
**Then** 按 `migration_id = uuid5(namespace, file:linehash)` 判定跳过，不产生重复节点（FR-21）

**Given** 迁移完成
**When** 检查一次会话的注入快照
**Then** mnemon 段落出现次数 = 0，身份段唯一（FR-21）

**Given** `dsh-mnemon` 仍然启用
**When** 运行迁移
**Then** 报错退出，不半途迁（FR-21）

**Given** 迁移开始前
**When** 检查快照
**Then** 已有 `snapshots/pre-migration-<ts>`；用一次故意失败的 fixture 证明库回到原样（FR-21、FR-19）

**Given** 迁移结束
**When** 检查产物
**Then** 生成 `migrations/<ts>-report.md`：迁入 N / 跳过 M 逐条原因 / 去重合并 K / 失败 0（FR-21）

**Given** 一份合成的 200 条 `MEMORY.md`
**When** 运行迁移
**Then** 报告数字与库内计数逐项一致（迁入 + 跳过 = 200），二次运行迁入 0 条

**Given** 真实 mnemon 历史数据
**When** v1 交付
**Then** 首次真实迁移是交付后的手工步骤（本机无历史数据），不进本 story 的自动验收

### Story 7.4: 回滚开关只恢复 legacy 注入

As a Elliott，
I want 迁移出问题时能一键回到「用旧的注入」，但不会被偷偷重启 mnemon，
So that 兜底是可控的，而不是两个系统同时往提示词里写东西。

**Acceptance Criteria:**

**Given** 迁移已成功但发现问题
**When** 打开 `config.legacyMnemonInject` 并重启插件
**Then** 只恢复本插件的 legacy 注入，不自动启动或重启 mnemon（FR-21、AR-15）

**Given** 关闭该开关并重启
**When** 检查注入
**Then** 回到迁移后的状态，不残留 legacy 段（FR-21）

**Given** 回滚后重跑迁移
**When** 结束
**Then** 与首次成功迁移逐条等价，报告追加而非覆盖（FR-21）

**Given** 任一迁移或回滚
**When** 检查源文件
**Then** `USER.md` / `MEMORY.md` 未被删除或修改（FR-21、AD-16）
