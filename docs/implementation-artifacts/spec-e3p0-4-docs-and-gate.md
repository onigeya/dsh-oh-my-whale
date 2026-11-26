---
title: 'P0-2/P0-3/P0-4 文档措辞归位、§4.16 登记与 g0-4 闸门归档'
type: 'chore'
created: '2026-11-26'
status: 'draft'
route: 'dispatch'
review_loop_iteration: 0
context:
  - 'docs/planning-artifacts/epics.md'
  - 'docs/planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/ARCHITECTURE-SPINE.md'
  - 'docs/implementation-artifacts/sprint-status.yaml'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 四份文档对命令面、版本链名与召回通道的说法彼此不一致，且缺两笔记录：gates 目录没有 `g0-4.json`（`gates/` 只有 g0-5、g0-6、g0-8 六个文件），`sprint-status.yaml` 的 `epic-2-retro-item-2` 仍停在 open。

**Approach:** 把文档措辞统一到 S1/S2/S3 定下的口径（平铺命令名、`history` 取代 `version-chain`、召回段的触发条件与时机写进 AD-7），补 `§4.16` 变更登记行，然后在 P0-1 落地后写 `gates/g0-4.json` 并收口 `sprint-status.yaml`。

## Boundaries & Constraints

**Always:** 只改措辞与登记，不改任何 AC 的验收条件；`g0-4.json` 的格式照 `gates/g0-5.json` 与 `g0-6.json`（顶层 `gate`/`status`/`timestamp`/`baselineRevision`/`node`/`platform`/`checks[]`，每条 `{name, ok, detail}`）；闸门结论如实写：通过记 `status: passed` 并给三环证据，未通过记 `status: blocked` 并写明缺哪一环；`sprint-status.yaml` 的 `epic-2-retro-item-2` 要把结论写进 `action` 字段再置 `done`。

**Never:** 不改 `epics.md` 里任何 Story 的验收语义（只改命令名写法）；不重做已交付的两份回顾（`epic-1-retro-2026-11-23.md`、`epic-2-retro-2026-11-25.md`）；不重开评审；不动 Epic 1/2 的验收线；不给 Epic 3 排期；不改历史 spec 文件（`spec-2-4` / `spec-2-5` 只补「已由 P0-1 交付」的注记，不改原文断言）。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| 命令面措辞 | 五处含 `/omw xxx` 的位置 | 全部改成 `/omw-xxx` 平铺写法 | N/A |
| 版本链名 | 文档里的 `version-chain` | 一律改成 `history`；§4.16 登记旧名作废 | N/A |
| 闸门通过 | P0-1 三环证据齐全 | `g0-4.json` 记 `status: passed` + 三条 check | N/A |
| 闸门未过 | 缺一环 | 记 `status: blocked` 并写明缺哪环 | 不写成 passed |

</frozen-after-approval>

## Code Map

- `ARCHITECTURE-SPINE.md`（`docs/planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/`）-- `:225` 七条命令原文；`:227` 启用三步；`:266` 判据段；`:268` doctor 表；`:395` 卸载段；`:443` CAP-5 运维行；`:77-89` AD-7（补召回段触发条件与时机）；`:302` AD 编号登记表。
- `epics.md` -- `:104` 四条只读命令；`:692` 形态已定段；`:730-752` Story 3.2；`:776` Story 3.3 flag 七值；`:668-670` Story 2.6；`:1266-1272` Story 5.4；`:140` AR-16。
- `requirements.md` -- `:145` 四条只读命令。
- `prd.md` -- `:299` 四条只读命令；`:862-879` §4.16 登记表。
- `gates/g0-5.json`、`g0-6.json` -- 闸门格式参照。
- `sprint-status.yaml` -- `epic-2-retro-item-2`。
- `spec-2-4-injection-budget.md` -- `:15` `:133` `:147` `:201` 四处「Story 2.5 接入召回」。
- `spec-2-5-recall-read-only.md` -- `:46`「召回文本在 Epic 5 之前不进宿主通道」。

## Tasks & Acceptance

**Execution:**
- [ ] 五份文档 -- 把 `/omw xxx` 全部改成 `/omw-xxx` 平铺写法，`version-chain` 一律改 `history` -- 与 S1 的实现一致
- [ ] `ARCHITECTURE-SPINE.md` AD-7 -- 补一句召回段的进入方式、触发条件与时机（装配前按近期聊天历史生成查询、单独跑一次召回、失败只降级） -- 契约不再自相矛盾
- [ ] `prd.md` §4.16 -- 追加一行登记：`version-chain` 作废、对外名为 `history`；平铺命令名取代子命令写法 -- 变更可追溯
- [ ] `epics.md` Story 3.2 -- 命令名改 `history`，AC 指出现有 `VersionView` 字段名 -- AC 可实施
- [ ] `spec-2-4` 与 `spec-2-5` -- 补「召回通道已由 P0-1 交付」的注记，消解互相指向 -- 读者有唯一答案
- [ ] `docs/implementation-artifacts/gates/g0-4.json` -- P0-1 之后按实测结论写闸门文件 -- 补上缺失的闸门记录
- [ ] `sprint-status.yaml` -- `epic-2-retro-item-2` 写结论进 `action` 后置 `done` -- 收口动作项

**Acceptance Criteria:**
- Given 五份文档，when `grep -rn "version-chain"`，then 只在 §4.16 的作废登记行与历史 spec 的注记里出现
- Given 五份文档，when `grep -rn "/omw "`，then 不再有子命令写法的调用示例
- Given `gates/g0-4.json`，when 读它，then 顶层字段与 `checks[]` 形状与 `g0-5.json` 一致，`status` 与实测结论相符
- Given `sprint-status.yaml`，when 读 `epic-2-retro-item-2`，then `status: done` 且 `action` 里有本轮结论

## Implementation Notes

## Verification

**Commands:**
- `pnpm test && pnpm lint` -- 期望：全绿（防文档改动带上代码改动）

**Manual checks (if no CLI):**
- 逐份打开五份文档的命令面段落，确认没有残留旧写法
