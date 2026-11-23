# R3 Digest：Distilly × MemoryOS（用户侧画像的两个样本）

> 访问日期 2026-11-22；Distilly @ 0afc45c（dot-skill），MemoryOS @ 587ed77（main）。数字均来自本次 gh api 查询。

## 1. 概览
- **Distilly**（titanwings/distilly，MIT）：把聊天/文档/访谈蒸馏成可复用 Person Skill 的元技能；26770★，默认分支 dot-skill，创建 2026-03-30，最近提交 2026-10-13（#204–210 仍在活跃重构），约 133 个 blob 文件；topics 含 `deepseek-harness`、`dsh-plugin`。
- **MemoryOS**（BAI-LAB/MemoryOS，Apache-2.0）：分层记忆+用户画像的研究系统（EMNLP 2025 Oral，README:77）；1626★，创建 2025-05-30，最近提交 2026-07-07，约 73 个 blob；无 pytest/CI，属研究原型，维护中低活跃。

## 2. 架构与关键机制
- **Distilly**：SKILL.md 只是 42 行路由（SKILL.md:20-31），按意图分流到 `prompts/flows/{owner,create,evolve,manage}.md`。create 流程顺序（create.md:9-13,40-94）：intake（收集手工标签）→ sources（导源）→ 双轨分析（work_analyzer + persona_analyzer）→ 双 builder 生成 → 用户预览确认 → skill_writer.py 落盘 `SKILL.md/work.md/persona.md/work_skill.md/persona_skill.md/manifest.json/meta.json`（create.md:117-137）。产物核心是 persona.md 五层：Layer0 核心人格（最高优先、永不可违背，persona_builder.md:18-25）→ Layer1 身份 → Layer2 表达 → Layer3 决策 → Layer4 人际 → Layer5 边界（persona_builder.md:29-130）。**validation/audit/synthesis/framework/template 只存在于 `prompts/celebrity/budget_unfriendly/`**，仅 celebrity+research_profile=budget-unfriendly 变体使用，默认 budget-friendly（create.md:33-38）——质量闸门不是所有产出路径都有。
- **MemoryOS**：短/中/长期+updater+retriever 五模块（README:218-240）。链路（memoryos.py:226-250）：QA 对进短期 deque（容量 10，short_term.py:10-14）→ 满则 pop_oldest 交给 updater：LLM 判断连续性、生成分段 summary+keywords（updater.py:130,169-185）→ 中期按 embedding 余弦+Jaccard 关键词并入 session 或新建（mid_term.py:208-227）→ 热度最高 session 过阈值时并行做画像+知识抽取（memoryos.py:137-176）→ 画像整体替换长期存储（merge=False）。**画像数据结构是纯文本 blob**：`user_profiles={user_id:{data:"profile_string",last_updated}}`（long_term.py:16,37-40），无字段级结构。

## 3. 拟人化
- 人格定义：Distilly 把用户给的人格/文化标签翻译成"情境X→行为Y"可执行规则（persona_analyzer.md:87-125 的映射表），再落进 Layer0；防漂移靠三层：Layer0 永不可违背 + "别出戏成通用 AI"（persona_builder.md:138-146）；Correction Log——用户一句"他不会那样"即触发 correction_handler，生成 `[scene] 不应 wrong、应 correct` 条目追加进 persona（correction_handler.md:12-21,28-36；skill_writer.py:353-373）；evolve 流程持续追加素材。
- 证据链/冲突：分析器要求"来源支撑"的结论引原文（persona_analyzer.md:132-133）；手工标签与文件分析冲突时手工优先并标注（:11）；素材不足标 `(insufficient source material)`（:131）。Celebrity 审计还要求 contradictions 清单分 temporal/contextual/inherent（audit.md:58-64）。但 persona.md 正文不带引用标注，知识源清单只存 meta.json（create.md:108-116）。
- 情绪/关系状态演进：两项目都**未见**（Distilly 产出是静态人设+补丁；MemoryOS 仅 relationship_with_user="friend" 参数进 prompt，prompts.py:7,24）。

## 4. 宜人化
- MemoryOS 有"角色扮演亲近关系"参数与风格提示（memoryos.py:252；prompts.py:6-12，语气一致性靠注入人格 traits）；主动性/节奏/亲密边界/出错体验：**两项目均未见**。Distilly 唯一的"出错防护"是审计的自动 FAIL（黑名单源、引用缝合、长引文版权检查，audit.md:46-50；validation.md:44-51）。

## 5. 可迁移机制（→ DSH 插件）
1. Layer0-5 分层人格+Correction Log → prompt section（只注入 Layer0+表达层，其余离线用）→ 成本：常驻注入吃 token/破前缀缓存，需最小化；风险：修正日志是人工补丁，无自动过期。
2. 标签→行为规则映射表 → 离线建规则后存 domain KV，运行时按需注入 → 成本低；风险：需重写陪伴场景映射。
3. 证据溯源（结论+原文引用，知识源存 meta） → session 日志只读：每日定时任务读日志→提炼"事实+原文片段"→写 domain KV，运行时只注入结论 → 成本：定时任务+KV；风险：日志只读无法写事件，只能轮询式全量读。
4. MemoryOS heat 晋升闸门（见 §7 公式） → 每次会话后把 N_visit/L_interaction 计数写 domain KV，定时任务算 H，过阈触发 LLM 画像更新 → 成本：低频 LLM 调用；风险：抽取=整段重写，会覆盖式漂移（MemoryOS 正是因此补了质量校验，commit 9c3489d）。
5. MemoryOS 检索注入+角色参数 → GUI 节点展示画像摘要，prompt 按需注入；成本低；风险：需防画像与人格帧冲突。
6. 数值化验收闸门（PASS/FAIL、原始源占比>50%、mental model≥3、known-answer 两问，audit.md:34-88） → 离线校验任务+报告存 KV → 成本：每轮蒸馏多 2-3 次 LLM；风险：仅 celebrity 深度模式有，需自建普通路径闸门。

## 6. 不可迁移 / 风险
MIT/Apache-2.0 均可商用；但 MemoryOS 默认 gpt-4o-mini+faiss+chromadb（依赖 OpenAI 闭源、无生产级 CI/测试，pypi 版无 test 文件）；变体间阈值不一致（profile 更新阈值 pypi=5.0 README:301 vs chromadb=13.0 README:398）；画像为文本 blob，无字段演进；prompt 强制英文输出（prompts.py:26）。Distilly 面向中文职场同事文化标签，需整体重写而非搬运。

## 7. 证据清单
Distilly：SKILL.md:26-31,41；prompts/flows/create.md:9-13,33-38,108-137,143,149-157；prompts/colleague/persona_analyzer.md:11,17-45,78-83,87-125,131-133；prompts/colleague/persona_builder.md:18-25,119-146；prompts/celebrity/budget_unfriendly/validation.md:17-77；…/audit.md:34-50,58-88；…/synthesis.md:19-47；prompts/flows/sources.md:5-15,67-71；prompts/shared/correction_handler.md:12-36；tools/skill_writer.py:353-373；tools/hosts.json（deepseek-harness→.dsh/skills）。
MemoryOS：memoryos-pypi/mid_term.py:20-36,39,46,71-101,190-227；memoryos-pypi/utils.py:228-235,266,359；memoryos-pypi/memoryos.py:26,137-140,154-214,226-250,252,282-293；memoryos-pypi/prompts.py:6-12,79-110;memoryos-pypi/long_term.py:16,26-42,50-75；README.md:42,77,218-240,301,398；commits 587ed77/9c3489d/1599873。

## 8. 未找到证据 / 开放问题
- Distilly 是否自动切分/抽样大数据（万条消息）：仅见采集器 --msg-limit 1000/--doc-limit 20 上限（sources.md:67-71），无显式分块抽样管线，需查演化流程。
- MemoryOS "paper 自述局限"未在 README 找到（TODO 仅两项，README:458-459）；heat 阈值 5/13 无理论依据；情绪/关系状态演进两项目均未实现——对哦鲸鲸是空白机会。