# 设计稿 × 架构骨架 对齐核查（reconcile-design）

> **时点说明（2026-11-23 收口）**：本文件是当时的一次快照核查，正文里的行号与 AD 编号范围（如「254 行 / AD-1…AD-18」「268 行 / AD-1…AD-20」）均指当时版本。收口后的骨架为 **397 行 / AD-1…AD-26**。**2026-11-25 再记**：经研究线融合与编号审计，骨架现为 **471 行 / AD-1…AD-55 / CAP-1…CAP-9 / FR-1…FR-77 / NFR-1…NFR-16**（新增 CAP-7 上下文治理、CAP-9 入口与路由）。凡与当前骨架冲突，以骨架为准，本文件只作「当时为什么这么判」的证据，**其 AD 编号均指 2026-11-23 口径，勿直接引用**。

- **被核查对象（唯一权威）**：../ARCHITECTURE-SPINE.md（**核查时为 254 行 / AD-1…AD-18，收口时为 397 行 / AD-1…AD-26**；同一文件给出两个数字是因为核查跨了那次修订，不是互相矛盾）
- **对照来源（本报告负责范围）**：
  - design/fusion-design-v1.md（118 行）
  - design/plugin-design-triviumdb-v2.md（263 行，取代前者的"自建存储"假设）
- **退役说明（2026-11-23，用户裁定）**：上面两份设计稿已从 `docs/planning-artifacts/` 删除——它们不是任何 BMad skill 的输出路径，也不是 BMad 认可格式（唯一的 design 类是 `bmad-ux` 的 DESIGN.md + EXPERIENCE.md，而那对文档是 UX 规格，不是 solution design）。删除前指纹：`fusion-design-v1.md` 10582B / sha256 `166ee783a75a0b4aad60a32405191a7f5e022cb0d03a3f199bc001af5d257e95`；`plugin-design-triviumdb-v2.md` 19557B / sha256 `8264324e07d70aca2263f326434e38e12bdb09044c8b26def14d90a3e9101fc3`。本文件是这两份稿子唯一的追溯记录，下文行号引用指删除前原文。
- **方法**：只读骨架，逐条把设计稿里承重的决定（节点 kind 与 edge label 清单、8 步 dream、关系四维数值与阈值、注入档位、预算数值、mnemon 迁移、embedding、7 条不可妥协、里程碑与 M0 闸门）映射到骨架的 AD 或小节，判定其状态为"保留 / 明确替代 / 遗漏 / 矛盾"。只记录会改变实现或验收结果的差异，不记录措辞、排版与"可以更详细"。
- **verdict：有实质分歧**（13 条：5 high / 7 medium / 1 low）。其中 D1–D4 会让设计稿承诺的效果无法落地，D5 让"M0 不通过就不往下走"的前置闸门在骨架里失效。

---

## 一、分歧清单

### D1 · high · AD-5 / AD-14 / AD-15（SPINE:67-71、121-125、127-131）
- **源**：plugin-design:107（"硬规则：没有任何路径会物理删除断言。删除一律 = superseded_at + tombstone；回收站与撤销是 DAO 的内置能力，不是补丁"）；fusion-design:87（S1 验收"10/10 次删除可完整撤销"）
- **冲突**：设计稿把"绝不物理删除 + 逐条可撤销"定为硬规则，骨架把它降级为"物理删除允许，只要发生在 src/ops/ 且先做快照"（AD-5:71），并用 CI grep 把这条路径制度化（AD-15:131）。而 AD-14 给的撤销手段是 createSnapshot/restoreSnapshot + 保留 7 份——快照回滚是**全库**粒度，撤回一次删除会连带丢掉快照之后的所有写入，S1 的"10/10 次删除可完整撤销"在架构上不可达。AD-16 尾巴的"迁移节点保留待人工清理"也隐含物理删除。
- **建议**：AD-5 改为"任何路径不得物理删除断言，删除 = superseded_at + tombstone，逐条撤销由 ops 暴露的 undo 事务实现"，ops 只保留快照/校验/迁移，AD-15 的 grep 从"delete 只在 ops"改成"delete 全仓禁止"。

### D2 · high · AD-10（SPINE:97-101）
- **源**：plugin-design:129（"八步，前两步不用模型"）、plugin-design:134-141（① 确定性结算 ② 候选选取 ③ 模式提取（LLM） ④ 场景抽象（LLM） ⑤ What-If（LLM） ⑥ 剪枝归档 ⑦ 跨主题重组 ⑧ 策略提炼）；fusion-design:59-70（同序，③④⑤ 明确标 LLM）
- **冲突**：四处对不上。(a) 骨架全篇没有 8 步清单（Structural Seed 与 AD-10 都只写"8 步"），"顺序固定"没有可校验内容。(b) 骨架的步名"合并、收敛、失效结算"不对应设计稿任何一步——设计稿第 ① 步"确定性结算"是一个步骤内含过期/依赖失效传播/承诺到期/归档/whatif 结算。(c) 按设计稿步序读，"前 3 步不得调用 LLM"会把第 ③ 步"模式提取"划成无模型步，而它是 LLM 步 → 梦境的模式与场景产出没有来源。(d) 设计稿是"前**两**步不用模型"，骨架多算了一步。这条 Rule 直接决定 dream 能不能产出 scene，属于"Rule 无法实现源文稿承诺的效果"。
- **建议**：AD-10 内嵌设计稿的 8 步名与模型边界（①② 确定性；③④⑤⑧ 为模型步；⑥⑦ 设计稿未标模型，⑥ 只读 ⑤ 的预测并只改 superseded_at），删掉"合并/收敛/失效结算"这套与设计稿不对应的命名。

### D3 · high · AD-7（SPINE:79-83）
- **源**：plugin-design:122（常驻档：每轮注入 ≤120 token 的"状态尾巴"，含当前场景、活跃任务、最近 3 条被确认的偏好）、plugin-design:153（persona_state 尾巴 ≤30 token）、plugin-design:203（USER.md → pref 节点 **+ 常驻注入的压缩摘要**）；fusion-design:53
- **冲突**：设计稿自己给了两个数（常驻档 ≤120 token 一段 / persona_state ≤30 token 一行），骨架只取小的那个，并把"场景常驻"压到 **0**（AD-7:83）。于是"当前场景 / 活跃任务 / 最近 3 条被确认偏好"这一整块没有任何注入通道；AD-7 的裁剪顺序里又出现"召回"，说明骨架预期存在常驻召回，却没给它配额。后果：mnemon 替换只兑现了按需 recall 工具，设计稿承诺的"USER.md 每轮注入的压缩摘要"落空——这正是"替代 mnemon"与"不丢工作能力"（plugin-design:197-206、§8）的交点。
- **建议**：预算表改成三行——身份段 ≤1200 字符 / 状态尾巴 ≤30 token / 常驻记忆档 ≤90 token（场景标题 + 活跃任务 + ≤3 条确认偏好），总常驻 ≤120 token，删掉"场景常驻为 0"。

### D4 · high · AD-9（SPINE:95）+ AD-3（SPINE:59）
- **源**：plugin-design:103（自动档判据："同一 (subj,pred) 两条断言 valid 区间重叠且值不同"，"按 valid_from 后者胜"）
- **冲突**：AD-9 的自动档条件是"同 mem_key ∧ 区间重叠 ∧ 值不同"，而 AD-3 把 mem_key 定义成含可选 obj_norm 的 <kind>:<subj>:<pred>[:<obj_norm>]。值不同 ⇒ obj_norm 不同 ⇒ mem_key 不同，所以带 obj 的断言上"同 mem_key ∧ 值不同"恒假；自动档只在不写 obj_norm 的谓词上才可能命中，而偏好、决定、数值这类正是带 obj 的。结果是三档裁决退化为两档（自动档形同虚设、全部落到人工），设计稿"符号可判的自动处理"落不了地。附带一点：AD-9 也没写"后胜"以哪个时间为准（valid_from 还是 recorded_at）。
- **建议**：自动档判据改为"同 (kind,subj,pred) ∧ 有效区间重叠 ∧ 值不同 → valid_from 较晚者胜"，并写明 mem_key 不承担区分取值的职责。

### D5 · high · Stack（SPINE:173）+ Open Questions（SPINE:249-254）+ 全篇缺失的一节
- **源**：plugin-design:263（"M0 不通过就不往下走——beta 底座的坑要在 200 行里踩完，而不是在 5000 行里"）、plugin-design:256（M0 = 建库/写/查/快照 + embedding 三档验证 + 查询延迟）、plugin-design:175（dim 须 M0 实测）；fusion-design:93（"顺序不能倒"）
- **冲突**：骨架引用 M0/M5（SPINE:173、207、247、251），却从未定义里程碑或闸门，也没有任何 AD 表达"未验证前提 → 不许进入实现"。而四条 OQ 全是 M0 的输入，且都被 AD 依赖：OQ1 的 dim 建库即定（错了只能重建库）、OQ2 的 compaction 后 seq 可读性决定 AD-6 的"证据指针可达"承诺、OQ3 的 storage root 决定 AD-14 的快照路径、OQ4 决定 AD-16 的迁移工作量。更直接的矛盾：Stack 表把 dense 1024 写成"**M0 实测确认**"，OQ1 又写"须实测确认（预期 1024）"——同一事实两种状态，等于把未测前提记成已测。
- **建议**：新增一节 Gates（M0 四条判据 + "任一不过则不进入 M1"），Stack 表的 1024 改回"待 M0 实测"，OQ1–OQ4 标注为阻塞项而非备忘。

### D6 · medium · 节点与边的形状（SPINE:210-224）+ AD-9（SPINE:95）+ Consistency（SPINE:155）
- **源**：plugin-design:65（edge 清单：supersedes / contradicts / supports·refutes（evidence→assertion）/ enriches / about（assertion→entity）/ part_of / derived_from / anchor（whatif→assertion）/ in_episode）、plugin-design:51-61（九种 kind）、plugin-design:133（周期标记 kind:"cycle"）、plugin-design:144（dream_log 节点）
- **冲突**：(a) 骨架画的是 assertion→evidence 的 supported_by，设计稿是 evidence→assertion 的 supports/refutes——方向相反，且 refutes 整个丢失，"这条断言有没有反证"这类查询写不出来；(b) contradicts、enriches、anchor 三个 label 在骨架里不存在；(c) AD-9 把 flag 写成"一条 flag(contradiction, resolved_auto) 边"，而设计稿 flag 是**节点**（flag_type/severity/status/proposal，并在 status、flag_type 上建索引）→ 治理页按 kind:"flag" + status:"open" 的查询无法工作，M5 的 flag 列表失去数据基础；(d) 设计稿的 about 只定义 assertion→entity，骨架泛化到 persona_state / pref / flag；(e) 周期标记设计稿写 kind:"cycle"，骨架改名 dream_cycle，dream_log 无对应物；(f) Consistency 只说"用 snake_case"，没有权威清单，最终 kind/edge 集合不可判定。
- **建议**：在 Consistency Conventions 落一张权威表（kind、edge label、方向、基数、payload 必填字段），按设计稿恢复 flag 为节点、矛盾边用 contradicts，evidence 方向统一为 evidence→assertion（supports/refutes）。

### D7 · medium · AD-16（SPINE:133-137）+ AD-3（SPINE:59）
- **源**：plugin-design:213（"以 uuid5(file, linehash) 为 **id**，重跑不重复"）、plugin-design:203（USER.md→pref、MEMORY.md→assertion(scope=workspace)）、plugin-design:211（strength=high）
- **冲突**：AD-3 规定 mem_key 是 <kind>:<subj>:<pred>[:<obj_norm>] 且由唯一复合索引保证唯一；AD-16 却让 mem_key 由 uuid5 派生。uuid5 十六进制串不符合该格式，且与运行期抽取生成的 mem_key 不在同一空间——迁移进来的 pref 与之后从对话抽取的同一条偏好会各存一份（去重失效、规则重复注入）。设计稿里 uuid5 是**导入幂等键/id**，不是业务身份；AD-3 恰好禁止 id 承担身份，两者被混成一层。另有映射丢失：设计稿的 USER.md→pref(strength=high) / MEMORY.md→assertion(scope=workspace) 被压成一句"转为 pref / assertion 节点"。
- **建议**：uuid5 只作 import_key（迁移幂等专用字段），节点身份仍走归一化 mem_key，并写明 USER.md→pref(strength=high)、MEMORY.md→assertion(scope=workspace)。

### D8 · medium · AD-4（SPINE:65）+ AD-13（SPINE:119）+ AD-18（SPINE:149）
- **源**：plugin-design:179-182（一条记忆一次 embedding + sha256 缓存；批量 ≤32、失败退避 3 次后进 pending_embedding；"写入不等 embedding"：先 insert 标 vec_state=pending，后台 SET VECTOR 补齐；补不齐退化为 TEXT + 图扩散）、plugin-design:247（风险行）
- **冲突**：骨架没有"向量可后补、缺失时降级检索"的任何规则。按 AD-4"一次业务写入一次事务"字面实现，向量就得在事务内算完——写入被唯一网络出口阻塞，违反设计稿"写入不等 embedding / 不占对话延迟"；而向量缺失时 AD-8 的检索无降级说明，AD-13 又可能把它读成"维度校验失败 → 全停"。设计稿专门为断网写了降级链，骨架把它整条丢了。
- **建议**：AD-4 增一条"向量是异步派生物：insert 先落 vec_state=pending，SET VECTOR 用单独事务补齐；补齐失败只降级为 TEXT + 图召回，不触发 AD-13"。

### D9 · medium · AD-10（SPINE:97-101）+ Deferred（SPINE:243-244）+ scope（SPINE:7）
- **源**：fusion-design:82-93（"范围不砍，但有先后"，S0–S5 全在 v1；S3 = whatif 表 + W1 + W3 + 结算，S5 = 策略文本 + BIS 闸门）、plugin-design:138-141（dream ⑤⑥⑧）、plugin-design:259（M3 完成标志"夜里跑完能解释为什么剪了这条"）
- **冲突**：骨架一边把 ⑤ What-If、⑥ 剪枝、⑧ 策略提炼写进"8 步顺序固定"，一边在 Deferred 里把 whatif 生成与技能自演进移出 v1，且没说 v1 里这几步是空转；同时 scope 行直接写"不含技能演进"，与设计稿"范围不砍"相抵。后果：AD-10 的 8 步在 v1 里只有约 5 步有内容（⑤ 关掉后 ⑥ 也没有依据），而 M3/S3/S5 的验收对象消失，骨架没有任何一处交代这些验收项怎么办。
- **建议**：AD-10 标注 v1 生效步（①–④、⑦）与显式空转步（⑤⑥⑧，各写空转理由），Deferred 里点名被降级的切片 S3/S5，而不是只写能力名。

### D10 · medium · AD-8（SPINE:85-89）
- **源**：plugin-design:125（fatigue：enable_refractory_fatigue 让同一条记忆短期内不被反复召回；"只属于有状态 API，只读实例不能开"）、plugin-design:249（要求在代码里断言）
- **冲突**：fatigue 的实现前提就是召回时修改引擎的有状态结构（不应期/侧抑制），而 AD-8 写的是"召回路径禁止任何写调用（含 updatePayload 与 flush）"。按字面执行，设计稿防"复读机"的那条防线不存在；骨架也没保留"只读实例不得开 fatigue"的断言要求，而这在单写者假设变化时会静默失效。
- **建议**：AD-8 明确区分"业务写"（禁止）与"引擎内部召回状态"（允许，须有界、不落 payload），并保留"只读实例不得开 fatigue"的代码断言。

### D11 · medium · AD-1（SPINE:47）+ AD-4（SPINE:65）
- **源**：plugin-design:193（"写入必须异步：抽取在会话结束后的后台任务里跑，不占对话延迟"）、plugin-design:194（单写者 + 多实例共享 ResourceRuntime 配额，"避免把宿主的页缓存挤掉"）、plugin-design:227（"答得比原生 DSH 慢，就是失败"）
- **冲突**：设计稿 7 条不可妥协里，"写入异步"与"配额"是直接支撑唯一验收标准（不能比原生 DSH 慢）的两条；骨架的 AD-1 只规定调度机制（ctx.schedule / ctx.timer），AD-4 只说"一次业务写入一次事务"，全篇没有 ResourceRuntime 配额与维护预算。实现在 turn-stopping 里同步抽取并提交事务，或省掉配额，都不违反骨架的任何一条 AD，却正好踩中设计稿判定的失败条件。
- **建议**：AD-4 补"写入只在会话结束/空闲的后台任务中执行，不在对话路径上同步提交"，并在 Stack 或 AD-1 补 ResourceRuntime 配额与维护预算的取值纪律。

### D12 · medium · AD-10（SPINE:101）
- **源**：fusion-design:62-69、plugin-design:135-144（护栏：② importance^0.7×(surprise+0.1)^0.3 且"一锚点一分叉"；⑤ 深度≤2；⑦ 产物必须能解析到真实 id，否则整条丢弃；⑥ 只改 superseded_at、可回滚；每阶段写 dream_log、可断点续跑；dry-run 只跑 ①②）
- **冲突**：AD-10 只保留了"顺序/幂等/每步 diff 统一提交/按段计预算/错过不补"。(a) 没有 whatif 深度上限，研究结论是 H≥2 变差；(b) 没有"产物必须解析到真实 id 否则丢弃"这条防幻觉硬闸，而 dream 产出的是 scene 正文，最容易编；(c) "每步产出 diff 后统一提交"与设计稿"每阶段写 dream_log、可断点续跑"语义相反——统一提交意味着崩溃后没有检查点，只能整轮重跑（幂等但烧 token）；(d) dry-run 从"只跑 ①②"变成"只出 diff 不写库"，等于把全部 LLM 步都跑一遍，成本差一个数量级。
- **建议**：AD-10 补三条硬约束（whatif 深度≤2、⑦ 产物不可解析即整条丢弃、dry-run 只跑 ①②），并把"统一提交"改为"每阶段提交 + dream_log 检查点"。

### D13 · low · AD-5（SPINE:71）+ AD-8（SPINE:89）
- **源**：plugin-design:78-80（DAO 模板用 superseded_at:{$exists:false}）、plugin-design:82（默认查询必须带 superseded_at IS NULL，注明是 Graphiti 用真实 bug 换来的教训）
- **冲突**：同一件事在骨架里出现三种写法——AD-5"每条断言同时具备 superseded_at"（要求字段存在）+ 默认附加"IS NULL"，AD-8"payloadFilter 排除 superseded_at != null"，设计稿"$exists:false"。若写入时显式写 null（AD-5 的"同时具备"正是这个意思），$exists:false 恒不匹配，默认过滤会把所有断言滤掉、召回恒空；若靠省略字段，AD-5 的"同时具备"又不成立。
- **建议**：统一为"未失效时不写该字段 + 查询用 $exists:false"，并把 AD-5 的"同时具备"改成"有效区间与记录时间必填，superseded_at 仅在失效时写入"。

---

## 二、已核对一致的部分（不构成分歧，列出以免读者以为漏查）

| 决定 | 设计稿 | 骨架 | 结论 |
|---|---|---|---|
| 关系四维数值与阈值 | plugin:156（0–100 默认 50；+3/−2×intensity；权重 1.0/0.7/0.8/0.6；closeness=(intimacy+trust)/2；<45 / 45–69 / ≥70） | AD-12:113 | 全对 |
| 双时态三轴 | plugin:69-82、fusion:40-41 | AD-5:71 | 保留（过滤写法见 D13） |
| 补丁表 + 一次事务 + rejected 记录 + 证据边 | plugin:90-97 | AD-4:65、AD-6:77 | 保留 |
| 三档裁决的符号判据 | plugin:103 | AD-9:95 | 方向保留，判据键有缺陷（D4） |
| dream 幂等（一天一次）、错过不补、按 token 计预算、失败停在段边界 | plugin:133、144 | AD-10:101 | 保留（步序与范围见 D2/D9/D12） |
| 底座故障整体 no-op | plugin:189、§11 | AD-13:119 | 保留 |
| 边界在工具 execute 前硬拦截，不进提示词 | plugin:160、fusion:79 | AD-12:113 | 保留 |
| 人格分仓（persona.md 进 section 字节稳定、状态尾巴进 context、记忆正文不进人格段） | plugin:148-162、fusion:76-78 | AD-7:83、AD-11:107 | 保留（常驻档配额见 D3） |
| mnemon 不删源文件、一次性、config.legacyMnemonInject 回滚 | plugin:208-215 | AD-16:137 | 保留（身份与 kind 映射见 D7） |
| embedding 选型与接口事实（bge-m3、dense 1024、单条 8192、Bearer 环境变量、sha256 缓存） | plugin:164-183 | Stack:173 | 一致（降级链见 D8） |
| 单文件 .tdb + snapshots + 唯一网络出口 | plugin:§2、§11 | Structural Seed、Stack:173 | 一致 |
| 召回预算（默认 5 条 / 800ms 超时返回空） | plugin:118、191 | AD-8:89 | 保留（新增硬上限 8 属收紧，不冲突） |

## 三、显式替代，不计为分歧（骨架已给出替代方案与理由）

1. **自建 SQLite/FTS5 索引层 → TriviumDB**：plugin-design 开篇即声明取代 fusion 的"自建存储"假设，骨架 AD-2 采纳。属方向明确的替代。
2. **设计稿的 uuid5 稳定 node id → mem_key 业务身份（AD-3）**：对 design §4.3 的有意修正，方向正确（128 位压进 53 位必撞）；仅 AD-16 的落地方式构成 D7。
3. **表达层（L4/Voice）、跨设备同步、参数化学习**：Deferred 均给了 DSH 能力限制层面的理由，与 fusion §3、§8 的边界不矛盾。
4. **主动搭话 / 门控链**：设计稿把它放在 M4 人格闭环与验收（plugin:158、260；fusion:80），骨架 Deferred 明确移出并给出"DSH 缺投递语义、定时唤醒与会话生命周期冲突"的技术理由——**属明确取舍**（`reconcile-research.md` F1 曾就「延后归因是否成立」判 high，已于 2026-11-25 复核收敛为已知取舍：结论同为 Deferred，但归因须改用真实理由）。**但**该行的"重启条件"没有交代设计稿那条验收（"连续未回复会降频"）作废还是改判，建议在该行补一句，以免 M4 验收悬空。
5. **治理界面细节 → M5**：与 plugin:239"M5 才做"一致。

---

## 四、给骨架作者的最小修改集（按性价比排序）

1. AD-5：物理删除全禁 + 逐条撤销（D1）。
2. AD-10：内嵌 8 步名与模型边界；补 whatif 深度≤2、⑦ 可解析性、dry-run 只跑 ①②；标注 v1 空转步（D2/D9/D12）。
3. AD-7：补 ≤120 token 常驻档三段配额（D3）。
4. AD-9：判据改为 (kind,subj,pred) + valid 重叠 + valid_from 后者胜（D4）。
5. 新增 Gates 一节，把 OQ1–OQ4 设为 M0 阻塞项；Stack 的"1024（M0 实测确认）"改回待测（D5）。
6. Consistency 落权威 kind/edge 表（D6）；AD-16 的 uuid5 降级为 import_key（D7）。
7. AD-4 补"向量后补 + 写入异步"（D8/D11）；AD-8 补 fatigue 边界与过滤语义（D10/D13）。
