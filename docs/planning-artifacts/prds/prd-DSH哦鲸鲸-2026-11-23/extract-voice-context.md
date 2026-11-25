# 来源抽取：表达层（Voice）与上下文治理线

简称：CG＝`research/technical-context-governance-2026-11-23/research.md`；VO＝`research/technical-output-humanization-anti-slop-voice-laye-2026-11-22/research.md`；另参 `architecture/architecture-DSH哦鲸鲸-2026-11-23/CONTEXT-GOVERNANCE.md`（AD-28…AD-45）。

## 一句话结论

给 CAP-7 补「授权来源可证、保护区写死、恢复有预算」。

## 候选能力

| # | 候选能力 | 一句话能力 | 出处 | 现状 | 融入方式 | 依赖与风险 |
|---|---|---|---|---|---|---|
| 1 | 通道隔离+授权重放 | 非用户通道包 untrusted；授权须重放回真实用户记录 | `CG:48-49` | 未规划 | AD-46；AD-31 加来源=user | 需宿主通道字段 |
| 2 | 保护区白名单 | 首/末条用户消息、近期区、压缩工具自身永不可折 | `CG:75` | 未规划 | AD-47 定 selector 常量 | 与 AD-43 优先级 |
| 3 | 召回与展开预算 | expand 与召回受单次 5%、累计 10% 硬顶 | `CG:65` | 部分采纳 | AD-30/45 加预算 | 与注意力池同口径 |
| 4 | 散文浓缩双闸 | 散文≥50% 窗且上下文≥0.8×窗才调 LLM | `CG:63` | 未规划 | AD-48 作 L1 第六前提 | 纯工具会话常闭 |
| 5 | 自有卡片文案门禁 | 自产卡片/通知结构检查+片段 diff，可 block | `VO:33,68` | 未规划 | 切出 Voice，Epic 3 增量 | 片段表需自建 |
| 6 | 中文 probe 验收集 | 30–50 条中文 prompt 三档标注，验 FR-15 | `VO:238` | 未规划 | 只作 eval 资产 | 一致性未测 |
| 7 | Voice 记账与评委族 | RewardSink、dream voice_review、对抗评委 | `VO:239-244` | 仅占位 | 保持 Deferred | judge 经济未测 |

## 要点

1. 1、2 必进：AD-31 只核账本覆盖，账本从工具输出抽到伪授权则全链皆错（`CG:48`）。
2. 3、4 必进：AD-42 立「注意力是目标」，但恢复与浓缩无预算无闸门。
3. 5 先改 PRD：`SPEC:83` 只封「助手消息」，自有卡片生成前可拦。
4. 6 只进 eval（FR-15 属 E1）；7 与 Caveman CCR 句柄不进。
5. mnemon 合并快照（`VO:289`）已消解：FR-21 迁移前禁用 mnemon。

## 建议归属

1–4 归 CAP-7，但须新开 Epic 补 FR 编号；5 作 Epic 3 增量；7 保持 Deferred。
