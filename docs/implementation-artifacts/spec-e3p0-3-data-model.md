---
title: 'P0-5/P0-6/P0-7 数据模型口径：flag 八值、边五条封闭集、删两个可变字段'
type: 'refactor'
created: '2026-11-26'
status: 'in-progress'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '1cefa2ac8cd2fcfb6da9f79e59aaeef5263ab332'
context:
  - 'docs/specs/spec-DSH哦鲸鲸/data-model.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 三处「同一个名字指两个东西」。(1) `flag_type` 文档写七值（`data-model.md:142`、`epics.md:776`），代码 `src/core/patch.ts:370` 多一个 `predicate_rekey`；`src/store/meta.ts:29` 的 `contract_version` 也不是 flag。(2) 边标签文档列 11 个、affected[] 只点名 3 个，`src/` 只实现 `supports` 一条。(3) `pred.evidence_count` 与 `scene.confidence` 是库里的可变计数器/浮点置信度，与 §2.1「库里不存在任何可变计数器字段」冲突；`evidence_count` 实测全仓无自增、恒为 0。

**Approach:** 用户裁定：flag 封闭集补成**八值**（加 `predicate_rekey`），`contract_version` 单列为 meta 不算 flag；边封闭集收敛为**五条** `supports / refutes / supersedes / contradicts / part_of` 并标出哪条已实现；**删掉** `pred.evidence_count` 与 `scene.confidence`，值改为读时推导。

## Boundaries & Constraints

**Always:** 五条边里只有 `supports` 已实现（`src/store/templates/evidence.ts:23` 定义、`src/seams/write-port.ts:632` 写入），其余四条标「声明未实现」并指名首建 Story；`contradicts` 是**有向两条边**，affected[] 计数按边数算；边去重键 `(src, label, dst)` 同批次内唯一；删字段后读侧需要这些数时一律现算，绝不写回。

**Never:** 不动 `pref.confidence`（是有来源的写入值，不是被推导的计数）；不改 §2.1 的 evidence 源去重规则；不给 `refutes` / `supersedes` / `contradicts` / `part_of` 写实现（归 Story 3.3 / 3.4）；不引入新的 flag 值或边标签；不改 `omw doctor` 五项。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| flag 八值 | 落一条 `predicate_rekey` flag | 通过校验并带上 `flag_type: 'predicate_rekey'` | N/A |
| meta 版本戳 | 写 `contract_version` 行 | 走 meta 路径，不当 flag | 冒充 flag 则拒收 |
| 边批内重复 | 同批两次 push 同 `(src,label,dst)` | 只落一条 | 静默去重，不报错 |
| 边集外标签 | 计划一条 `enriches` 边 | 拒收 | 报错指名五条封闭集 |
| 旧快照多键 | 读带 `confidence` / `evidence_count` 的旧行 | 忽略该键，值读时现算 | 不抛错 |

</frozen-after-approval>

## Code Map

- `docs/specs/spec-DSH哦鲸鲸/data-model.md` -- `:142` flag 七值；`:137` affected[] 闭包；`:85-96` 边表；`:48` scene 含 `confidence`；`:52` pred 含 `evidence_count`；`:30-38` §2.1；`:36` 解释句。
- `src/core/patch.ts` -- `:370` flagType 两值；`evidenceCount` 声明 `:309`、读写 `:331` `:635` `:654` `:666` `:709` `:721` `:748` `:773` `:860` `:873`；`confidence: 0.5` 在 `:476`。
- `src/store/tbox.ts:109` `:135`、`src/store/schema.ts:189` -- `evidence_count` 声明、落库与种子。
- `src/store/meta.ts:29` -- `contract_version`（`:45` 校验、`:85` 落库）。
- `src/store/templates/evidence.ts:23` `SUPPORTS_LABEL`、`:56` 读法；`src/seams/write-port.ts:632` 唯一 push 边处；`src/store/commits/engine.ts` `:215-220` `PlannedLink`、`:255-256` 写入点（无去重）。
- 测试也要改：`test/core/patch.test.ts`、`test/store/{tbox,schema,templates,commits}.test.ts`、`test/helpers/fake-registry.ts` 都引用了 `evidenceCount`。

## Tasks & Acceptance

**Execution:**
- [ ] `docs/specs/spec-DSH哦鲸鲸/data-model.md` -- `:142` 七值改八值并补 `predicate_rekey` 一句；加一行说明 `contract_version` 是 meta 不是 flag -- 封闭集与代码相等
- [ ] `docs/specs/spec-DSH哦鲸鲸/data-model.md` -- §4 边表收敛为五条，逐条标「已实现 / 未实现（首建方 Story X）」；写清 `contradicts` 有向两条边与去重键；`:137` 闭包落到这五标签 -- 口径唯一
- [ ] `docs/specs/spec-DSH哦鲸鲸/data-model.md` -- `:48` 删 `confidence`；`:52` 删 `evidence_count`；`:36` 改写为「不再存库，读时聚合」 -- 与 §2.1 一致
- [ ] `src/core/patch.ts` -- 删 `:476` 的 `confidence: 0.5` 与全部 `evidenceCount` 读写（`:331` `:635` `:654` `:666` `:709` `:721` `:722` `:748` `:860` `:873`） -- 库里不留可变字段
- [ ] `src/store/tbox.ts` `src/store/schema.ts` -- 删 `evidence_count` 落库与种子 -- 同上
- [ ] `src/store/commits/engine.ts` 或 `src/seams/write-port.ts` -- 批内按 `(src,label,dst)` 去重 -- 落实唯一键
- [ ] `test/` -- 补用例：八值、meta 不算 flag、边批内去重、边集外拒收、旧快照多键被忽略 -- 锁住口径

**Acceptance Criteria:**
- Given `grep -rn "flagType" src/` 的值集合，when 与 data-model 比对，then 完全相等（八值），`contract_version` 不在其中
- Given `grep -rn "evidence_count\|evidenceCount\|confidence" src/`，when 与字段表比对，then scene 与 pred 行都不再有这两个键
- Given 同批计划两次相同 `(src,label,dst)`，when 提交，then 落库只有一条边
- Given 旧快照带 `confidence` / `evidence_count`，when 读取，then 不抛错且值被忽略
- Given `pnpm test && pnpm lint`，then 全绿

## Implementation Notes

## Verification

**Commands:**
- `pnpm test` -- 期望：全部通过
- `pnpm lint` -- 期望：无错误
