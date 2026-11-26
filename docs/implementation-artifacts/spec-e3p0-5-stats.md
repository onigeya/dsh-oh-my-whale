---
title: 'P0-8 /omw-stats：按时间窗聚合三路 p50/p95 与降级计数'
type: 'feature'
created: '2026-11-26'
status: 'draft'
route: 'dispatch'
review_loop_iteration: 0
context:
  - 'docs/planning-artifacts/epics.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless the human renegotiates">

## Intent

**Problem:** `src/` 里 `stats` 与 `--since` 零命中，但三处要求这条命令：`epics.md:668-670`（Story 2.6 AC）、`:1266-1272`（Story 5.4）、`:140`（AR-16），`ARCHITECTURE-SPINE.md:266` 的判据段也指定用它看数。Epic 2 已标 done，这条 AC 实际没交付。

**Approach:** 补最小实现：读审计 JSONL（或 `Audit.rows`）按 `--since` 窗口聚合三路——召回、写事务、注入——各给 p50/p95，并按各自判据给降级计数。命令名 `omw-stats`（见 S1）。同时把 Epic 2 的 done 改述为「该 AC 由 Epic 3 补交」。

## Boundaries & Constraints

**Always:** 三路**各用各的判据**：召回按 `degraded_reason` 六值分组（`src/core/degrade.ts:36-43`）；写事务按 `outcome ∈ {downgraded, rejected}` 分组并用 `code` 细分；注入按 `truncated = true` 计。`--since` 窗口按行自带的 `ts` 过滤；样本为空时明确说「窗口内没有样本」而不是给个 0；输出同时有人类可读文本与一行结构化 JSON（与既有读命令一致）。

**Never:** 不写回审计文件；不引入统计依赖；不因为缺 `elapsed_ms` 就伪造注入耗时（依赖 S2 先落地）；不改 `WRITE_OUTCOMES` / `DEGRADED_REASONS` / `INJECTION_TIERS` 三个封闭集；不把 `/omw stats` 做成进程外脚本；不读除审计以外的数据源。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 正常窗口 | `/omw-stats --since 24h`，三路都有行 | 三组 p50/p95 + 各自降级计数 | N/A |
| 空窗口 | 窗口内无行 | 三路都报「窗口内没有样本」，不报错 | 不返回 0 |
| 只有一路有行 | 仅有召回行 | 另两路报无样本 | 不报错 |
| 非法窗口 | `--since abc` | error，给出支持的写法（如 `24h`、`7d`） | 不静默当 0 |
| 缺审计目录 | 首次启动 | 报「审计文件尚不存在」 | 不抛栈 |

</frozen-after-approval>

## Code Map

- `src/ops/audit.ts` -- `InjectionAuditRow` `:46-59`；`RecallAuditRow` `:69-83`（含 `elapsed_ms`/`degraded_reason`）；`WriteAuditRow` `:100-107`（含 `elapsed_ms`/`outcome`/`code`）；`INJECTION_TIERS` `:29`；`WRITE_OUTCOMES` `:86`；`Audit` 接口 `:222-236`（`rows`/`path`）；`AUDIT_ROWS_RETAINED = 1000` `:246`；`createAudit` `:261`。
- `src/core/degrade.ts` -- `DEGRADED_REASONS` 六值 `:36-43`。
- `src/seams/commands.ts` -- 命令注册与各命令 handler 的模式；`renderDecision` `:574` 是输出样式参照。
- `src/seams/runtime.ts` -- `:315` `createAudit`；`finish()` `:705-737` 已暴露 `audit`。
- `src/index.ts` -- `:103-121` 传 thunk 给命令注册。

## Tasks & Acceptance

**Execution:**
- [ ] 新增 `src/ops/stats.ts` -- 按 `--since` 窗口聚三路 p50/p95 与降级计数，纯函数、可单测 -- 与命令面解耦
- [ ] `src/seams/commands.ts` -- `omw-stats` 从「未交付」占位换成真 handler，读 `runtime.audit` -- 命令接线
- [ ] `src/index.ts` -- 把 `audit` 的 thunk 传给命令注册 -- 供 stats 读
- [ ] `test/` -- 补窗口过滤、空窗口、单路有行、非法窗口四类用例 -- 锁住边界
- [ ] `docs/planning-artifacts/epics.md` -- Epic 2 的 done 改述为「`/omw-stats` 那条 AC 由 Epic 3 补交」 -- 记录真实状态

**Acceptance Criteria:**
- Given 窗口内有注入/召回/写事务三类审计行，when 运行 `/omw-stats --since 24h`，then 输出三组 p50/p95，且降级计数按各自判据分组
- Given 空窗口，when 运行，then 文本明确说窗口内没有样本，命令返回 success
- Given `--since abc`，when 运行，then 返回 error 并给可用写法
- Given `grep -rn "stats" src/`，then 命中新模块与命令注册
- Given `pnpm test && pnpm lint`，then 全绿

## Implementation Notes

## Verification

**Commands:**
- `pnpm test` -- 期望：全部通过
- `pnpm lint` -- 期望：无错误