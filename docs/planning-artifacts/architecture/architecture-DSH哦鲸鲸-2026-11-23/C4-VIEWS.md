---
name: 'DSH 哦鲸鲸 C4 视图'
type: c4-views
status: draft
created: '2026-11-23'
spine: ARCHITECTURE-SPINE.md
---

# C4 视图 — DSH 哦鲸鲸

三张图，逐层放大：系统在什么环境里（Context）→ 由哪些可独立部署/独立推演的单元组成（Container）→ 单元内部怎么分（Component）。只画当前存在的和 v1 要建的；Deferred 项不出现。

> **2026-11-25 补记**：本文写于 CAP-9（入口与路由）立项之前，因此 C2/C3 里没有 `src/main.ts`、`core/route/`、`seams/route/`、`presets/`。它们已作为「目标形态」补在文末的 **C5 · 入口与路由** 一节，不进 C2/C3 的既有图——C2/C3 描述的是单安装位形态，把两套形态画在同一张容器图里会让「谁持有库」这件事含糊。`src/govern/` 属 CAP-7（上下文治理），不属 CAP-8（看视频融合，候选、未立项）。

## C1 · 系统上下文

```mermaid
flowchart TB
  U["用户（本地单用户）"] -->|"对话、治理操作"| DSH
  subgraph HOST["DSH 宿主 0.2.2-rc.5（同进程）"]
    DSH["Agent Loop + Web GUI"]
    SP["System Prompt 组装器"]
    TR["工具注册表"]
    SCH["ctx.timer（后台任务）／ctx.schedule（仅主动搭话）"]
    LOG[("Session Log（仅追加）")]
  end
  OMW["哦鲸鲸插件 dsh-oh-my-whale"]
  SF["SiliconFlow bge-m3（外部）"]
  DSH --> OMW
  OMW -->|"身份段 section／状态尾巴 context"| SP
  OMW -->|"recall 等工具"| TR
  OMW -->|"dream 触发（timer，非 schedule）"| SCH
  OMW -->|"只读指针（session_id + seq）"| LOG
  OMW -->|"embedding 请求（唯一网络出口）"| SF
```

| 元素 | 类型 | 与本系统的关系 |
| --- | --- | --- |
| 用户 | 人 | 只通过 Web GUI 交互，不直连库 |
| DSH 宿主 | 外部系统（同进程） | 提供注入点、工具注册、调度、只读日志；不感知本系统的数据模型 |
| 哦鲸鲸插件 | 本系统 | 全部记忆能力的实现体 |
| SiliconFlow | 外部服务 | 唯一的向量化来源；失败可降级，不阻塞写入 |
| billion-context | 外部插件（不在本系统边界内） | 压缩会遮蔽 surface，但日志保留；本系统只依赖日志 seq，不依赖它 |
| dsh-mnemon | 被替换者 | 迁移后由本系统接管注入，留回滚开关 |

## C2 · 容器视图

```mermaid
flowchart TB
  subgraph PLUG["插件（单进程）"]
    SEAMS["seams/ 接缝适配"]
    CORE["core/ 领域规则（零 IO）"]
    STORE["store/ 唯一存储访问层"]
    DREAM["dream/ 8 步固化"]
    PERSONA["persona/ 身份与关系"]
    OPS["ops/ 运维入口（快照/迁移/破坏性操作）"]
    WRK["recall worker（worker_threads，同步 search 的唯一出口）"]
    GUIS["gui/ 客户端插件（浏览器侧）"]
  end
  TDB[("oh-my-whale.tdb 单文件")]
  SNAP[("snapshots/ 最近 7 份")]
  AUDIT[("audit.jsonl 注入与召回记账")]
  PMD[("assets/persona.md 字节稳定")]
  SEAMS --> CORE
  SEAMS --> PERSONA
  DREAM --> CORE
  DREAM --> STORE
  PERSONA --> CORE
  CORE --> STORE
  WRK --> STORE
  GUIS --> CORE
  OPS --> STORE
  STORE --> TDB
  OPS --> SNAP
  SEAMS --> AUDIT
  PERSONA --> PMD
```

| 容器 | 职责 | 能做什么 | 明确不能做什么 |
| --- | --- | --- | --- |
| `seams/` | 把 DSH 的注入点、工具、事件、调度翻译成领域调用 | 调 `core`、调 `persona`、写审计行 | 不写 TQL，不读库 |
| `core/` | 补丁表、校验、裁决、预算、可结算性判定 | 纯函数 | 不做 IO，不 import 宿主类型 |
| `store/` | schema、查询模板、事务提交、索引、快照调用 | 调 TriviumDB | 不 import 其他层 |
| `dream/` | 8 步固化与周期标记 | 调 `core` 与 `store` | 不注册注入，不直接面对用户 |
| `persona/` | 读 `persona.md`、算四维、边界检查 | 纯计算 + 读文件 | 不依赖数据库可用性 |
| `ops/` | 快照、校验、迁移、破坏性操作 | 调 TriviumDB 管理与删除 API | 是唯一允许物理删除与 `tql` 裸查询的地方 |
| `gui/` | 治理视图（flag 队列、版本链、导出） | 通过宿主暴露的通道读数据 | 拿不到 `ctx`，不直连库 |

## C3 · 组件视图（core + store + seams）

```mermaid
flowchart LR
  subgraph SEAMS["seams/"]
    PC["prompt-composer<br/>预算表 + 三档切分"]
    TH["tool-handlers<br/>recall / remember / forget / explain"]
    EH["event-hook<br/>turn-stopping 同步返回 → timer 去抖抽取"]
    GATE["gate<br/>启动闸门（库/快照/维度）"]
  end
  subgraph CORE["core/"]
    PT["patch-table<br/>op 归一"]
    VAL["validator<br/>zod + TBox + 指针范围"]
    TBOX["tbox<br/>谓词基数表"]
    ARB["arbitration<br/>符号可判才自动"]
    SET["settle<br/>falsifier 判定"]
    BUD["budget<br/>裁剪与记账"]
  end
  subgraph STORE["store/"]
    SCH["schema"]
    TPL["templates/<br/>唯一 TQL 出处"]
    CMT["commits<br/>单事务写入"]
    IDX["index<br/>唯一复合索引"]
    SNAP["snapshot<br/>create/verify/restore"]
  end
  PC --> BUD
  TH --> TPL
  TH --> PT
  EH --> PT
  GATE --> SNAP
  PT --> VAL
  VAL --> TBOX
  VAL --> CMT
  ARB --> CMT
  SET --> CMT
  CMT --> IDX
  TPL --> SCH
```

| 组件 | 一句话职责 | 关键约束 |
| --- | --- | --- |
| `prompt-composer` | 唯一的注入出口，按预算表切三档 | AD-7：身份段字节稳定；超预算记账 |
| `tool-handlers` | 召回、显式记忆、遗忘、解释「你为什么记得这个」 | AD-8：只读召回；AD-12：边界前置拦截 |
| `event-hook` | 每轮结束触发一次抽取 | AD-18：失败不回滚、不阻塞回合 |
| `gate` | 启动时校验库、快照、维度 | AD-13：任一不过就全停 |
| `validator` | 拒绝不合规补丁并留下证据 | AD-4：拒收写 `rejected` 而非静默丢弃 |
| `arbitration` | 只有一个情形自动裁决 | AD-9：同键 ∧ 区间重叠 ∧ 值不同 |
| `settle` | 让推断被事实判定 | AD-17：无 `falsifier` 不得成为断言 |
| `templates/` | 唯一的 TQL 出处，参数化 | AD-8、AD-15：模板外零 TQL |
| `commits` | 唯一写入口，一个补丁表一个事务 | AD-4：写 API 只在这里出现 |
| `snapshot` | 快照 + 校验 + 恢复 | AD-14：每日 / 迁移前 / 留 7 份 |

## 一次对话的两种视角

```mermaid
sequenceDiagram
  participant U as 用户
  participant DSH as DSH 宿主
  participant PC as prompt-composer
  participant TH as tool-handlers
  participant DB as store/
  participant RR as System One 重排
  U->>DSH: 说一句话
  DSH->>PC: 组装系统提示（身份段 + 状态尾巴）
  PC-->>DSH: 预算内文本 + 审计行
  DSH->>TH: 模型决定调用 recall
  TH->>DB: ①模板查询（只读，250ms 上限）
  DB-->>TH: 候选（≤12 条）
  TH->>RR: ②重排打分（600ms，失败退回①顺序）
  RR-->>TH: 有序候选（或 rerank_unavailable）
  TH->>TH: ③裁剪到 5 条注入（20ms）
  TH-->>DSH: 结果注入工具返回
  DSH-->>U: 回答
  DSH->>DSH: turn-stopping（异步）
  DSH-)TH: 抽取本轮 → 单事务写入
```

## C5 · 入口与路由（CAP-9，目标形态）

这一节单独画，因为它改变的不是组件内部划分，而是**安装形态**：从「一个插件一处安装」变成「两个安装位 + 一处路由」。不要和 C2 叠在一起看。

```mermaid
flowchart TB
  subgraph PROF["安装位① profile（全局层）"]
    IDX["src/index.ts<br/>四工具 + 唯一库租约"]
    MEM["omw.memory 服务<br/>（只此一处 provide）"]
    RT["seams/route/*<br/>账本·派发·回流·工具"]
  end
  subgraph PRESET["安装位② preset omw-main（主对话专用）"]
    MAIN["src/main.ts<br/>只注册 composer"]
    SEC["harness:identity section<br/>≤1200 字符，字节稳定"]
    TAIL["omw:persona-state context<br/>≤30 token"]
  end
  subgraph WK["worker 会话（任意 preset，非 omw-main）"]
    W1["持有记忆四工具"]
    W2["无 harness:identity"]
  end
  LEDGER[("routing.json<br/>话题 ↔ 会话/工作区")]
  RT --> LEDGER
  MEM -.->|"惰性 ctx.get()"| TAIL
  RT -->|"agents.create 自持 handle"| WK
  WK -->|"turn/end 摘要 + 指针"| RT
  RT -->|"mainAgent.followup"| MAIN
  IDX --> MEM
  MAIN --> SEC
  MAIN --> TAIL
```

| 单元 | 安装位 | 能做什么 | 明确不能做什么 |
| --- | --- | --- | --- |
| `src/index.ts`（记忆面） | profile 全局层 | 注册四工具、持有唯一库租约、provide `omw.memory` | **不注册任何 section**（AD-46）；不 import `presets/` |
| `src/main.ts`（人格面） | `omw-main` preset | 注册 `harness:identity` 与 `omw:persona-state`、注册两个派发工具 | **不开库**；`inject` 只许 `systemPrompt`（AD-54）；不得成为 `selectedDefault` |
| `core/route/decide.ts` | 同 profile | 纯函数判定 create/attach/correct | 不碰 ctx、文件、日志（`core-no-seams` 强制） |
| `seams/route/*` | 同 profile | 读写账本、创建/回收 worker、回流摘要 | 不自造 message source kind（AD-52）；不写 `meta.origin:'subagent'` |
| worker 会话 | 由路由创建 | 记忆读写、执行具体工作 | 无身份段、无派发工具；**可被用户接手**（FR-33） |

人格与记忆的可见性边界就是这两张子图之间的线：`harness:identity` 只出现在 `PRESET` 子图里，`omw.memory` 只在 `PROF` 子图里 provide。库坏时 `TAIL` 整段缺席、`SEC` 照常——这是 AD-11 与 I24 守的那条线。
