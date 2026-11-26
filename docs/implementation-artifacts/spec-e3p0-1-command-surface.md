---
title: 'P0-3 命令面：十条平铺斜杠命令，版本链对外名定为 history'
type: 'refactor'
created: '2026-11-26'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '1cefa2ac8cd2fcfb6da9f79e59aaeef5263ab332'
context:
  - 'docs/planning-artifacts/epics.md'
  - 'docs/planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 仓库只有一条 `/omw` 命令加子命令分派（`src/seams/commands.ts:334` 的 `registry.register({ name: 'omw', ... })`，分派在 `:346`–`:370`），但架构与 epic 文档把每个子命令都写成独立的 `ctx.commands.register` 条目；同时 `version-chain` 与已交付的 `history` 是同一件事，两处名字并存。

**Approach:** 用户裁定选 B：真按平铺命令注册。共 **10 条**，每条一次 `registry.register`，不留裸 `/omw`，不保留子命令分派。`version-chain` 并入 `history`，对外名定为 `omw-history`。未开工的 4 条也注册，handler 直接返回「该命令由哪个 Story 交付」的明确错误，使文档与代码当刻字面一致。

| 命令名 | 状态 |
|---|---|
| `omw-doctor` | 已实现（五项体检） |
| `omw-pred-promote` | 已实现 |
| `omw-evidence` | 已实现 |
| `omw-history` | 已实现（原 `version-chain`，改名） |
| `omw-ledger` | 已实现 |
| `omw-stats` | 未实现 → 由 spec-e3p0-5-stats 补 |
| `omw-explain` | 未实现 → Story 3.1 |
| `omw-flag-queue` | 未实现 → Story 3.3 |
| `omw-export` | 未实现 → Story 3.5 |
| `omw-brief` | 未实现 → Story 3.8 |

## Boundaries & Constraints

**Always:** 每个 handler 的 `rawInput` 是**命令名之后**的整段文本（宿主 `parseCommand` 的既有语义），所以参数解析要从 `tokens[0]` 开始，不再跳过子命令词；`omw-<x>` 的名字全部小写、用连字符；已实现的五条行为与输出文本逐字不变；每条命令自带 `description`，是把旧 `OMW_USAGE` 的内容拆到各自的说明里。

**Never:** 不改宿主 `@deepseek-ai/dsh-commands`；不留 `name: 'omw'` 的注册；不做子命令前缀匹配；不给未实现的四条编造半个实现；不动 `inspectInProcess`、`renderPointer`、`renderVersion`、`renderDecision` 的渲染逻辑。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 体检 | `/omw-doctor` | 五项体检报告，`N/5 通过` | 有失败项时 `kind: 'error'`，文本不变 |
| 提升谓词 | `/omw-pred-promote lives_in --single --reason 单值` | 更新谓词登记表 | 缺参/未知参数报错并附该命令的用法行 |
| 查证据 | `/omw-evidence assertion:Elliott:lives_in` | 指针列表 + JSON 行 | 缺键报「需要给出一个业务键：/omw-evidence <mem_key>」 |
| 查版本 | `/omw-history assertion:Elliott:lives_in` | 版本链列表 + JSON 行 | 同上，路径提示换成 `omw-history` |
| 查账本 | `/omw-ledger assertion:Elliott:lives_in` | 决策记录列表 + JSON 行 | 同上 |
| 未实现命令 | `/omw-explain foo` | `kind: 'error'`，文本含 `Story 3.1` 与「本版本未实现」 | 不抛异常 |
| 多余 token | `/omw-evidence a b` | 报「一次只查一个业务键」 | 不静默丢弃 |

</frozen-after-approval>

## Code Map

- `src/seams/commands.ts` -- 单次 register 与子命令分派在 `:327-373`；`OMW_USAGE` 在 `:254-259`；`parsePromote` 在 `:286`（首 token 检查 `pred`/`promote`）；`parseMemKeyArgument` 在 `:433`（取 `tokens[1]`）。
- `src/index.ts` -- `:103-121` 调 `registerOmwCommand`，`:140-151` `resolveCommandRegistry`。
- `test/load/commands.test.ts` -- `:25-46` `registry()` 辅助取 `definitions[0].handler`；`:78` 断言名字数组为 `['omw']`；`:108` 断言 `toHaveLength(1)`。

## Tasks & Acceptance

**Execution:**
- [x] `src/seams/commands.ts` -- 把 `registerOmwCommand` 改成注册 10 条平铺命令、返回一个组合 disposer；删掉子命令分派与「未知子命令」分支 -- 让代码与文档字面一致
- [x] `src/seams/commands.ts` -- `parsePromote` 与 `parseMemKeyArgument` 改为从 `tokens[0]` 取值，用法串改成对应命令名 -- `rawInput` 不再含子命令词
- [x] `src/seams/commands.ts` -- `OMW_USAGE` 拆成每命令一条 `description`，未实现命令集中一处常量说明各自所属 Story -- 一处维护
- [x] `test/load/commands.test.ts` -- `invoke` 改按命令名查 handler；名字数组断言改为 10 个；degraded 实例同样断言 10 条 -- 覆盖新契约

**Acceptance Criteria:**
- Given 全新加载的插件，when 读命令注册表，then 名字集合恰为上述 10 个且不含 `omw`
- Given `/omw-history <mem_key>`，when 与改前的 `/omw history <mem_key>` 比对，then 输出文本与 JSON 行逐字相同
- Given `/omw-explain x`，when 执行，then 返回 error 且文本指名 Story 3.1，进程不崩
- Given `pnpm test`，when 全量运行，then 通过且 `pnpm lint` 无新增告警

## Implementation Notes

实现完成（2026-11-26）。`pnpm test` 648 通过 / 2 跳过，`check-layers` 与 `eslint` 全绿。

- `src/seams/commands.ts`：`registerOmwCommand` → `registerOmwCommands`，注册十条平铺命令并返回一个组合 disposer；新增 `undelivered(name, description, owner)` 生成「尚未交付，由 X 负责」的占位 handler。
- `parsePromote` 与 `parseMemKeyArgument` 改为从 `tokens[0]` 起（`rawInput` 不含命令名），用法串随之换成 `/omw-pred-promote`、`/omw-evidence`、`/omw-history`、`/omw-ledger`。
- `OMW_USAGE` 重排为十条命令的清单，四条未交付的标注「尚未交付」。
- `src/index.ts` 调用点改名。
- 测试：`test/load/commands.test.ts` 重写为按名字 invoke 并断言十条名字集合；`version-command` / `evidence-port` / `memory-tools` / `remember-composed` / `runtime-write` 的 registry 辅助与断言全部改为按名字查表。

**一处与 spec 的偏离**：spec 说「`OMW_USAGE` 拆成每命令一条 description」，实现里两者都保留了——每条命令有自己的 `description`，`OMW_USAGE` 作为一眼看全十条的清单留在常量里，供文档引用与人工核对。

## Verification

**Commands:**
- `pnpm test` -- 期望：全部通过
- `pnpm lint` -- 期望：无错误
