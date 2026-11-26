---
title: 'P0-1/P0-8 召回通道接进注入，注入行补耗时'
type: 'feature'
created: '2026-11-26'
status: 'in-review'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '1cefa2ac8cd2fcfb6da9f79e59aaeef5263ab332'
context:
  - 'docs/planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless the human renegotiates">

## Intent

**Problem:** `PromptComposer` 已能规划召回档，但 `src/seams/runtime.ts` 构造 composer 时只传 `readState`（`:354`），`RuntimeDeps` 没有 `readRecall`；reader 在 `:669-683` 才创建且没人调用。真装配下召回恒为空，而 `test/seams/runtime-write.test.ts:158` 把缺陷写成了正确。注入审计行（`src/ops/audit.ts:46-59`）也没有耗时字段，`omw-stats` 算不出注入 p50/p95。

**Approach:** 召回接进注入：查询串由**近期聊天历史**生成，在**装配时**单独跑一次召回（与装配相邻但不是一个动作），召回文本走第三条 `context()` 通道。`InjectionRecord` 与 `InjectionAuditRow` 增加 `elapsed_ms`。

## Boundaries & Constraints

**Always:** 召回失败只降级、不能吃掉身份段（沿用 `#readOrNothing` 与 `onReaderFailure`）；召回仍需过 `topK` 与 `recallCap`；注入行计入召回后 `tier`/`items`/`chars`/`tokens`/`truncated` 必须同步反映召回；照旧零写入、不更新热度。

**Never:** 不把召回拼进身份段（字节稳定是前缀缓存前提，AD-7/FR-15）；不在 `compose()` 里读会话（它拿不到 session）；不把 `@deepseek-ai/dsh-*` 加进依赖（AD-1，只能结构化窄化）；不改召回打分内核、不加向量与重排（Epic 5）；不做 `omw-stats` 聚合命令（归 spec-e3p0-5）；不让 `onInject` 的 plan 与真正送出的文本不一致（AD-20）。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 有召回 | 会话有历史、库里有命中 | 装配文本含召回原文；`recall.kept` 非空；注入行 `elapsed_ms` 为数字 | N/A |
| 无召回 | 查无命中 | `kept` 为空，装配文本只有身份段 | 不报错 |
| 召回超 topK | 命中 8 条、`topK=3` | `kept` 3 条，`overCount` 记 5，`truncated` 不含 `recall` | 不报错 |
| 召回超预算 | 单条超 `recallCap` | 该条不入 `kept`，`truncatedItems` 含 `'recall'` | 不报错 |
| reader 抛错 | `db` 已关 | 身份段照常，`onReaderFailure('recall', e)` 被调，`kept` 为空 | 不抛到装配链路 |
| 无 session | 宿主不给 session | 跳过召回 | 不报错 |

</frozen-after-approval>

## Code Map

- `src/seams/prompt-composer.ts` -- `readRecall` `:247`；`RecallItem` `:107-112`（`{memKey, text}`）；`compose()` `:507`、裁剪 `:530-554`；section provider `:660-689`；`PromptAssemblyContext` `:62-65`；常量区 `:41-53`。
- `src/seams/recall-reader.ts` -- `RecallItem` `:26-33`（`{mem_key, kind, value}`，**与 composer 不同形**）；`recall()` `:142`；`createRecallReader` `:159`；`DISPLAY_FIELDS` `:371`。
- `src/seams/runtime.ts` -- `RuntimeDeps` `:229-244`；composer 构造 `:345-384`；`recall` 创建 `:669-683`（**晚于 composer**）。
- `src/ops/injection-audit.ts` -- `InjectionRecord` `:51-56`；`record()` `:121`；行构造 `:131-148`（`:136-139` 的「recall has no channel yet」注释要删）；`itemsOf` `:249`。
- `src/ops/audit.ts` -- `InjectionAuditRow` `:46-59`；`INJECTION_TIERS` `:29`（需加第三值）；`assertClosedTier` `:215`。
- `test/support/recording-ctx.ts` -- `assemble(sessionId)` `:206-217` 只传 `{ session: { id } }`，需能带会话事件。
- `test/seams/runtime-write.test.ts` -- `:147-166`；`:157` 注释要删。

## Tasks & Acceptance

**Execution:**
- [x] `src/seams/prompt-composer.ts` -- 加 `RECALL_CONTEXT_NAME='omw:recall'`（order 131），**由身份段 provider 先算召回并缓存**，该 provider 只重放缓存 -- 宿主按 order 升序渲染，审计行在身份段里写，先算才不漏
- [x] `src/seams/prompt-composer.ts` -- `PromptAssemblyContext` 放宽到能读会话事件；加查询串生成（本会话最近若干 `user/message`，累计约 200 字符）与 `RecallItem` 映射 -- 查询来源落地
- [x] `src/seams/prompt-composer.ts` -- 在 provider 内计时并让 `onInject` 多收 `elapsedMs` -- 注入行要有耗时
- [x] `src/seams/runtime.ts` -- `RuntimeDeps` 加 `readRecall`，用 thunk 延迟取 reader 解决 `:669` 晚于 `:345` -- 接上线
- [x] `src/ops/audit.ts` `src/ops/injection-audit.ts` -- `InjectionAuditRow` 加 `elapsed_ms`；`record()` 收耗时；`tier`/`items`/`chars`/`tokens`/`truncated` 计入召回 -- 注入行反映真装配
- [x] `test/support/recording-ctx.ts` -- `assemble` 允许注入会话事件 -- 让测试能驱动召回
- [x] `test/seams/runtime-write.test.ts` -- 断言改正向，并覆盖矩阵六行 -- 缺陷变契约

**Acceptance Criteria:**
- Given 库里有命中且会话有历史，when 装配一次提示词，then `recall.kept` 非空且装配文本含召回原文片段
- Given 同一场景，when 读注入审计行，then `elapsed_ms` 是有限数字，`chars`/`tokens` 含召回部分
- Given `db` 已关闭，when 装配，then 身份段仍在、`kept` 为空、不抛异常
- Given `grep -n readRecall src/seams/runtime.ts`，then 命中
- Given `pnpm test && pnpm lint`，then 全绿

## Implementation Notes

实现完成（2026-11-26）。`pnpm test` 645 通过 / 2 跳过，`check-layers` 与 `eslint` 全绿。

- **通道**：`src/seams/prompt-composer.ts` 新增 `RECALL_CONTEXT_NAME='omw:recall'`、`RECALL_CONTEXT_ORDER=131`、`RECALL_QUERY_MAX_CHARS=200`、`recallQueryFrom()`、`messageTextOf()`。召回走第三条 `context()` 通道，不碰身份段。
- **渲染顺序**：宿主编排按 order 升序，身份段 `-1000` 先于召回 `131`。召回因此在**身份段 provider 内**计算并存入 `#recallText`，召回 provider 只重放——否则审计行会漏掉本轮召回（AD-20）。
- **查询串**：`PromptSessionLike.ownEvents()` 同步读会话事件，倒序取 `user/message` 文本直到 200 字符。无会话、无事件、读抛错都只让本档为空，不动身份段。
- **耗时**：`onInject` 多收 `elapsedMs`，由 provider 内 `performance.now()` 两端测得；`InjectionRecord.elapsedMs` 必填（可选会让 0 混进 p50/p95）。
- **审计行**：`InjectionAuditRow` 加 `elapsed_ms`；`chars`/`tokens`/`truncated`/`items` 计入召回；`INJECTION_TIERS` 从两值扩到四值（tail × recall 的组合）。
- **接线**：`RuntimeDeps.readRecall` 是 thunk，解决 reader（`:669`）晚于 composer（`:353`）的创建顺序；reader 拒绝时返回 `undefined` 而非空数组，避免把拒收当作「没有可召回」。

**与 spec 的两处偏离，都是实现时发现的真实约束：**
1. spec 说「召回段 provider 里现场跑召回」，但那样审计行写不到召回。改为身份段 provider 先算、召回段重放。
2. `PromptEventLike.type` 起先是 `string` 与多行联合，`check-layers` 的 `hard-delete-unreadable` 规则要求能读出的单行字面量，最终收窄为 `'user/message'`。

**未做（spec 明确排除）**：向量召回、重排、`omw-stats` 聚合命令本身。


## Verification

**Commands:**
- `pnpm test` -- 期望：全部通过
- `pnpm lint` -- 期望：无错误
