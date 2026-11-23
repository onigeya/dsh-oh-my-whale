# R4 TinyTroupe / CharacterGPT
TinyTroupe @7ce8be3，charactergpt @2b817c1；访问 2026-11-22。

## 1 概览
LLM 多智能体人格仿真库。7701★、MIT、2198 文件；最近提交 2026-10-23，活跃。README:35 自述仅用于研究仿真。CharacterGPT 仅 1 个 144B README、无 LICENSE、7★。

## 2 架构与数据模型
模块：agent/、environment/、factory/、validation/。
`_persona` 默认仅 name/age/nationality/country_of_residence/occupation 五键（tiny_person.py:221-227），其余由 spec 注入 gender、education、long_term_goals、occupation{title,organization,description}、style、personality{traits,big_five 文字等级}、preferences{interests}、behaviors{routines}（README:340-377）。`_mental_state`：datetime/location/context/goals/attention/emotions/accessible_agents[{agent,relation}]（:233-243）。

## 3 拟人化
每轮 mustache 渲染 persona+mental_state+faculty 说明进 system prompt（:311-356），模板禁止发明新特征（mustache:203-210）。一致性：动作级三命题（persona_adherence/selfconsistency/fluency），不过则带 feedback 重生成（action_generator.py:512-595）；命题 6 条等权取轨迹均值，hard 版每瑕疵扣 20%（propositions.py:58-149）；人级 Validator 面试式打 0-1 分（tiny_person_validator.py:29-117）。记忆双层+压缩（memory.py:240,738）。在线=拼 prompt+校验；离线=工厂造人、压缩、抽取。

## 4 宜人化
未见主动关怀、节奏、亲密梯度、边界、出错降级。世界钟 current_datetime+timedelta 推进，可 run_minutes/days 快进（tiny_world.py:101-114,273），agent 同一步顺序/并行（:147,:168），单轮连动到 DONE：实验者驱动可重放，陪伴用户驱动、实时、有沉默。关系仅静态 relation。

## 5 可迁移
1) persona/state 分层 → KV 存全量、prompt 只放身份卡 → 省 token；风险：卡外漂移。
2) 命题评分 → `persona_review` 工具抽 N 轮打分入 KV → 一次调用；风险：自评偏差。
3) 情节压缩 → 定时任务写关系记忆 → 低成本；风险：失真。
前置拦截不可行，只能事后自检。

## 6 风险
MIT 可商用；依赖 chevron/pydantic/openai/pandas、Python 线程、绑 OpenAI 端点；纯仿真，无流式/打断。CharacterGPT 无实现。

## 7 证据
tiny_person.py:221-243,311-356；mustache:203-210；action_generator.py:512-595；propositions.py:58-149；tiny_person_validator.py:29-117；memory.py:240,738；tiny_world.py:101-114,273。

## 8 未找到证据
- minimalistic/short/specific 三档规格无对应枚举；实际为完整 JSON、define()、fragment、工厂四种。
- big_five 无量化，无法前后测；一致性仅 LLM 判官，无人际信度。
- CharacterGPT：arXiv 2405.19778v5，NAACL 2025 Industry Track；CPT 按章节摘要增量抽取特质，Big Five+创作评测；仓库空，不可复现。
