---
id: ENTRY-ROUTING-DSH哦鲸鲸
title: 入口与路由：人格只进主对话，工作按路由派发
companions:
  - SPEC.md
  - requirements.md
  - data-model.md
  - glossary.md
  - ../../planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/ARCHITECTURE-SPINE.md
sources:
  - https://github.com/YunongDai2005/dsh-theone @ 5c96ea442c80f80958da60ed6efddeee5aa6882c
  - DSH 实现检视点 C:/Users/ellio/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/（下述 file:line 均指此处）
---

> 本文是**入口设计**，不是实现。它回答一个问题：怎么让鲸鲸的人格只出现在主对话，同时让所有会话都能读写记忆，并把工作按路由派给合适的工作区与会话。设计以 DSH 现成机制为唯一依据，凡结论都给出可回查的源码位置；凡改动都给出文件与接口。
>
> 编号纪律：本文新增 AD-46…AD-55、FR-25…FR-33、NFR-11…NFR-12、CAP-9、I17…I26。既有 AD-1…27 / FR-1…24 / NFR-1…10 / I1…I16 **不动、不复用、不重排**。
>
> 第一版（AD-46…49 / FR-25…28 / I17…20）只依据 DSH 自身机制与 TheOne 的实现。AD-50…53 / FR-29…31 / I21…23 来自对官方原型 `dsh-superagent-prototype` 的对照，见 §十二；那一节的每一条都是**增量**，不推翻前十一节。
>
> 第三版增量（AD-54…55 / FR-32…33 / I24…I26）来自对四条实现路径的定向补证：服务跨安装位可见性、工具注册表的可见性边界、worker 创建路径与回收、单库租约。它们加固的是 §4、§5、§7 的**实现约束**，不改设计取向；其中唯一改变取向的是 AD-55 把创建路径从 `sessionController` 换成自持 handle（理由见 §5.3 的硬冲突）。

## 结论摘要

1. **人格的可见范围由 preset 作用域决定，而不是由运行时判断。** DSH 的 `systemPrompt.section()` 与 `tools.register()` 都取**调用点 ctx 的作用域**（cordis 追踪代理，`cordis/lib/index.js:134`）；preset 自带独立 scope（`dsh-agent-preset-registry/src/index.ts:118-137`），agent 的 scope 被挂在该 preset 的 scope 之下（同文件 `:280-289`）。所以在 preset 内注册的人格段，**只有挂这个 preset 的 agent 看得见**，写不进去的会话天生就没有——不是「注入了再关掉」。
2. **拆成两个安装位：记忆在 profile（全局），人格在 preset（局部）。** `dsh-oh-my-whale` 主入口只做记忆与路由能力，**不注册任何 section**；新增子入口 `dsh-oh-my-whale/main` 挂在新建 preset `omw-main` 上，只做人格注入。记忆库因此只有一个打开者（Windows 单文件租约），不会因为装两次而冲突。
3. **路由是主对话的独占工具面。** 派发工具与人格段同住 `omw-main` preset，所以 worker 会话在结构上**没有**派发能力（不靠提示词约束，也没有那个工具）；worker 只带全局的四个记忆工具。这也顺手封住了「worker 再派 worker」的无限套娃。

## 一、机制证据

### 1.1 作用域取自调用点（这是全部设计的地基）

`systemPrompt.section()` 的方法体写的是 `this.layers.effect(this.ctx, ...)`，看起来 `this.ctx` 是服务自己的 ctx。但 cordis 的 Service 是**可追踪代理**：

- `cordis/lib/index.js:1322-1366` `Service` 构造时登记 `const tracker = { associate: name, property: 'ctx' }` 并 `defineProperty(self, symbols.tracker, tracker)`。
- `cordis/lib/index.js:88-93` `getTraceable` 见到 tracker 就返回 `createTraceable(ctx, value, tracker)`。
- `cordis/lib/index.js:127-165` 代理的 get 里有决定性一行 **`:134 if (prop === tracker.property) return useSite`** —— 读 `service.ctx` 拿到的是**使用点**的 ctx。

因此 `childCtx.systemPrompt.section({...})` 注册进 childCtx 所在的 scope；在根 ctx 调用就进 global layer。

> **这就是本项目「人格注入所有对话」的根因**：`src/seams/prompt-composer.ts` 的 `PERSONA_SECTION_NAME = 'harness:identity'` 由 `src/seams/runtime.ts:202-210` 用**根 ctx** 注册，落进 global layer，所有 scope 都能看见。

### 1.2 preset 自带 scope，agent 挂在它下面

- `dsh-agent-preset-registry/src/index.ts:118-137` `activate()`：`const key = {}; const scope = createScope(this.owner, key)` —— **每个 preset 一个独立 scope**，插件行在该 scope 内 mount。
- `dsh-agent-preset-registry/src/index.ts:280-289` `join()`：`const binding = { parent: bindScopeParent(key, generation.key), generation }` —— agent 自己的 scope key 被绑到 preset 的 key 下。
- `dsh-scope/src/store.ts:192-199` `chainLayers(scope)` 按 `scopeChainOf(scope).reverse()` 取层，注释原文："farthest ancestor first and the exact scope last, so a caller layering them in order gives the nearest scope the final word"。

所以一个主对话 agent 的层链是 `[presetKey(omw-main), agentKey]`，一个 worker agent 的层链是 `[presetKey(ptc|standard), agentKey]`。**前者看得到人格层，后者根本不在那条链上。**

### 1.3 同名段会被遮蔽，而不是报错

`dsh-system-prompt/src/index.ts:702-790` 的 `assemble()` 先按 name 做层叠覆盖：`:711 for (const registration of registrations) sectionByName.set(name, registration.definition)`（注释 "Outer scopes are visited first; later registrations replace the effective definition."），**然后**才在 `:775-777` 校验 `complete` 段唯一性。

→ preset 内用同名 `harness:identity` 注册鲸鲸文本，**只遮蔽全局那条宿主开场句**（"You are an AI agent powered by DeepSeek Harness."，由 `SystemPrompt` 构造函数 `:509-519` 在根层注册），不会触发 `multiple complete prompt sections are active`。

### 1.4 人格必须在创建时就决定，不能事后撤

`dsh-system-prompt/src/admission.ts:127-140`：某段文本变化时写 `The following replaces the earlier instructions from <name>.`；某 name 全部注册被 dispose 后写 `The earlier instructions from <name> no longer apply.`（`:719-746`）。

→ 一旦人格段进过某会话的 system 消息，**事后撤注册只会追加一条「不再适用」的通告，永远不会让历史消失**。所以 worker 的正确做法是「创建时就不给」（`meta.agentPreset` 指向不带人格的 preset），而不是「先给再收」。

### 1.5 官方先例：人格就是 preset 里的一行

`dsh-persona/src/index.ts`（67 行）：`Config = z.object({ prefix, suffix, complete, includeRuntimeContext })`，apply 里 `ctx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, order: ..., text: config.prefix })`。文件头注释："Registers prefix and suffix as ordinary scoped system sections. Disposing the plugin reveals any inherited or earlier same-scope persona definitions."

内置 preset 声明位置：`dsh-web-app/presets/{standard,ptc,minimal,cordis}.patch.yml`，由 `dsh-web-app/package.json` 的 `dsh.bundle.patch` **数组**列出。本机还有一个纯 bundle 的活例：`C:/Users/ellio/Documents/deepseek-harness/default-workspace/adventure-preset/`（只有 `package.json` + `cordis.patch.yml`）。

## 二、目标形态

```
profile (全局 scope)
├── dsh-oh-my-whale            ← 记忆能力：四工具 + 唯一库打开者 + omw.memory 服务
│                                ★ 不注册任何 prompt section（AD-46）
└── preset: ptc / standard     ← worker 的默认 preset：只有全局记忆工具，无人格、无派发
       └── worker agent scope

preset: omw-main               ← 主对话（AD-46/AD-47）
├── dsh-persona                ← 或本插件 /main 入口，二选一（见 §4.3）
├── dsh-oh-my-whale/main       ← 人格段 + 状态尾巴（注册在 preset scope）
└── 与 ptc 同等的工具面（bash/fs/pwsh/jobs/web/office/skill/compaction/subagent…）
       └── main agent scope   ← 看得到人格；也看得到全局记忆工具
```

## 三、可见性矩阵（这份表就是这个设计的验收面）

| 会话 | preset | 鲸鲸人格段 | 状态尾巴 | 记忆四工具 | 派发工具 |
| --- | --- | --- | --- | --- | --- |
| 主对话（入口会话） | `omw-main` | **有** | **有** | 有 | **有** |
| 工作区 A 的 worker | `ptc`/`standard` | 无 | 无 | 有 | 无 |
| 工作区 B 的 worker | 同上 | 无 | 无 | 有 | 无 |
| 用户手工新开的普通会话 | 任选非 `omw-main` | 无 | 无 | 有 | 无 |
| 老会话（设计前就已存在） | 记录在 header 里的旧 preset | 无 | 无 | 有 | 无 |

这张表的每一格都不是「配置对了」，而是**机制上不可能看见**。三条支撑：

1. **记忆四工具对任何 scope 无条件可见**。`dsh-tools/src/index.ts:202` `const inherited = new Map(this.layers.global.tools.entries())`——global 层永远作基底，不参与可见性裁剪；裁剪只发生在 `:214` `if (layers.every(layer => layer.admits(name)))`，而 `admits` 只受 agent 级 `restrict()` 影响。DSH 全仓只有三处 `restrict()`（`dsh-timeline/src/delegation.ts:71`、`dsh-timeline/src/guidance.ts:170`、`dsh-subagent/src/child-agent.ts:223`），全是 deny 名单，没有一处遮蔽本插件的工具。
2. **`isolate` 挡不住工具**，这也是最容易误判的一点。`isolate` 只改 service 实现的解析 symbol（`cordis-plugin-loader/src/config/isolate.ts:98-101` 的 `newMap` 只对 `entry.options.isolate` 列出的名字生成新 symbol；消费侧 `cordis/src/reflect.ts:148-157` 查 `ctx[symbols.isolate][name]`），完全**不碰** `tools` 与 `systemPrompt` 的注册表。所以给 `omw-main` 写 `isolate` 既不能、也不该被用来「挡住 worker 的记忆工具」。
3. **派发工具与人格同住 preset scope**，worker 的 scope 链（`[presetKey(ptc|standard), agentKey]`，§1.2）不含 `omw-main` 的 key，所以那两个工具不在它的可见集合里——不是被 restrict 排除，而是没进过它的层。

最后一行值得单独说：`dsh-session/src/types.ts:133-139` 的 `SessionHeader.agentPreset` 注释原文 "Durable because the preset decides the session's tools and prompt"。所以**老会话不会因为升级而突然长出人格**——除非刻意把它切到 `omw-main`，而 `select()` 在会话开过第一轮后直接抛 `agent-preset/locked`（`dsh-agent-preset-registry/src/index.ts:364-368`），切不过去。这是好事：人格的获得需要「新开一个主对话」。

## 四、组件

| # | 组件 | 位置 | 职责 |
| --- | --- | --- | --- |
| C1 | 记忆面（改造现有） | `src/index.ts`、`src/seams/runtime.ts` | 四工具 + 唯一库租约 + `omw.memory` 服务；**删掉根 ctx 的 section 注册** |
| C2 | 人格面（新增子入口） | `src/main.ts` + `src/seams/prompt-composer.ts`（复用） | 在 preset scope 注册 `harness:identity`（≤1200 字符，字节稳定）与 `omw:persona-state`（≤30 token） |
| C3 | 路由账本（新增） | `src/seams/route/bindings.ts` → `routing.json` | 话题 ↔ 会话/工作区绑定；原子替换写；损坏即关闭路由 |
| C4 | 判定（新增） | `src/core/route/decide.ts` | 纯函数：`create` / `attach` / `correct`；含脱敏与不追问规则 |
| C5 | 派发（新增） | `src/seams/route/dispatch.ts` | `agents.create/resume`、`followup` 投递、live worker 上限与回收 |
| C6 | 回流（新增） | `src/seams/route/relay.ts` | worker 收尾 → `mainAgent.followup(note)`，只带摘要 + 指针 |
| C7 | preset 声明（新增） | `presets/omw-main.patch.yml` | `@deepseek-ai/dsh-agent-preset` 一行，`plugins` 里含 C2 与 C5 的工具行 |
| C8 | doctor 扩展 | `src/seams/commands.ts` | 聊天内 `/omw doctor` 第五项从「根层段已注册」改为「主对话 preset 内段可见」 |

**路由为什么拆成 `core/route/` 与 `seams/route/` 两处**（2026-11-25 编号审计时定）：`scripts/check-layers.mjs:25` 的 `LAYERS = ['core','store','dream','persona','seams','gui','ops']` 是封闭枚举，`layerOfSpecifier` 在首段不在其中时返回 `{ kind: 'outside' }`（`:124`），而 `checkFile` 只对 `kind === 'layer'` 判违规（`:141`）——所以**新开一个 `src/route/` 层会让你落进静态门的盲区**：它不报错，只是从此再没有层规则管它。两条路：给 `LAYERS` 加一项，或者挂到已有层下。选后者，因为 AD-15 的规则本身（`core/` 零 IO、`seams/` 是宿主接缝）已经能表达这个切分，不需要新层：

- **`core/route/decide.ts`**：纯函数，不碰 ctx、不碰文件、不打日志，只吃 `{ text, topics, currentTopicId?, explicitSessionId? }` 出 `RouteDecision`。放 `core/` 是被 `core-no-seams` 规则**强制**的——它绝不能 `import` `seams/` 里的任何东西，这正好保证五条判定规则可以表驱动单测。
- **`seams/route/*`**：`bindings.ts`（读写 `routing.json`）、`dispatch.ts`（`ctx.agents.create`、持有 `AgentHandle`）、`relay.ts`（`mainAgent.followup`）、`tools.ts`（工具注册）——这四个都要 ctx 或文件 IO，归 `seams/` 名副其实。

这样不需要动 `check-layers.mjs`，也不需要给 AD-15 加说明；`test/` 下同构（`test/core/route/decide.test.ts`、`test/seams/route/*.test.ts`）。

**命令面只有聊天内斜杠命令**（2026-11-25 用户裁定「不要任何 CLI，只保留 command」）：本设计不新增任何进程外入口——C8 的 doctor 扩展与路由相关的运维查询都是 `ctx.commands.register` 注册的聊天内命令，结果用消息文本报告、没有退出码语义；`package.json` 不写 `bin`，`scripts/` 只放开发期工具。派发给 worker 是用工具/命令触发宿主内的 `ctx.agents.create`，不是 fork 进程，故与 AD-1（单进程纯插件）一致。

### 4.1 C1 与 C2 为什么必须分成两个包入口

同一份代码装两次是允许的，但**同一个 triviumdb 文件不能被两个实例同时打开**——注意这不只是跨进程限制：triviumdb 0.9.3 实测，**同一进程内**第二次 `new TriviumDB(同一路径)` 也直接抛 `TDB_DATABASE_LOCKED`（`message` 为「数据库已有不兼容的访问租约」），因为 `accessMode` 默认 `readWrite` 是独占写租约（`triviumdb.d.ts:564` `accessMode?: 'readWrite' | 'readOnly' | 'immutable'`、`:394` `TDB_DATABASE_LOCKED`）。`readOnly` 可以多开，但**不能与 `readWrite` 共存**（先开 `readOnly` 再开 `readWrite` 同样 `TDB_DATABASE_LOCKED`）。所以「worker 各自开只读」这条路走不通：主对话要写记忆。（Windows 句柄锁见 NFR-10 与 AD-2。）而记忆工具必须对所有会话可用（C2 要求「其余会话只有记忆读写能力」），人格只能对主对话可用。两条交叉的可见范围只有一种分解方式：

- **一条 scope 链管不到的层 = 全局** → 记忆（profile 安装位）；
- **一条 scope 链管得到的层 = preset** → 人格（`omw-main` 安装位）。

**「装两次」有且只有三条代价，落地时都要当真**：① entry id 必须不同，否则 loader 直接报 `entry ${id} already exists in the target tree`（`cordis-plugin-loader/src/config/tree.ts:194`）；② `apply()` 会执行**两次**（`cordis/src/registry.ts:330` 每次 `plugin()` 新建一个 fiber），两个 fiber 各有自己的 ctx 与 disposer，谁也不能替对方收尾；③ 模块级（ESM 顶层）状态是**共享**的，因为 loader 走 Node 模块缓存、同一 specifier 只求值一次（`tree.ts:245`）。第③条决定了：唯一库实例、路由账本这类状态**绝不能放模块顶层裸变量**，否则两个安装位看到的是同一个变量，而它只被其中一个 ctx 的生命周期管理。正确归属见 §六：库归 C1 的 `omw.memory` 服务（preset 侧 `ctx.get()` 复用），账本归 C5 的派发组件。

于是 C2 不打开库，只经 C1 发布的 `omw.memory` 服务读状态尾巴；库打不开时 C2 照常注入身份段（AD-11：身份不依赖库），尾巴整段省略。

**这个「跨安装位读取」是成立的，机制如下**：preset scope 的 ctx 只是 `fiber.ctx.extend({ [kScope]: key })`（`dsh-scope/src/index.ts:137-140`），不换 realm、不动 isolate 映射（`cordis/src/fiber.ts:270`），所以 `ctx.get('omw.memory')` 会沿 isolate 原型链上溯到根 realm 的 symbol，命中 profile 提供的唯一实现（`cordis/src/reflect.ts:262-279`，注释原文 "Read a service from the store without the inject requirement"；根 symbol 由 `:322-323` 的 `??= Symbol(name)` 建立）。

最有力的旁证是 DSH 自己：`mount.ts` 用 `fiber.ctx.get(name)` 判断某行「在等 Host 服务」（`dsh-agent-preset-registry/src/mount.ts:118-123`），注释说 Host provider 稍后激活即可补全——若 preset 读不到 profile 的服务，所有 inject `tools` / `systemPrompt` 的 preset 行都会永远 pending，任何 preset 都挂不上。

### 4.2 子入口的声明

`package.json` 需要补齐三处，否则 loader 解析不到：

```json
"exports": {
  ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
  "./main": { "types": "./lib/main.d.ts", "default": "./lib/main.js" },
  "./cordis.patch.yml": "./cordis.patch.yml",
  "./package.json": "./package.json"
},
"files": ["lib", "assets", "presets", "cordis.patch.yml", "README.md"],
"dsh": { "bundle": { "patch": ["./cordis.patch.yml", "./presets/omw-main.patch.yml"] } }
```

依据：`cordis-plugin-loader/lib/index.js:564-604` 把 `name` 当任意 ES 模块说明符解析（`name.startsWith('.')` 走 `new URL(name, ctx.baseUrl)`，其余走 `createResolve(baseUrl)`），所以 `dsh-oh-my-whale/main` 只要 `exports` 里有该子路径就能加载。

`dsh.bundle.patch` 的类型在 **DSH 自己的 manifest 定义**里是 `string | string[]`——`dsh-package-manifest/lib/types/types.d.ts:71-72` 原文注释「One patch file path, or an ordered list applied in sequence, each relative to the declaring package root」，签名 `patch: string | string[]`。所以现在 `package.json` 里的单值写法和上面数组写法**都合法**，改它不是新增能力，只是把第二个安装位加进来；顺序有意义，按数组顺序叠。

### 4.3 人格段的实现选择

两个方案，推荐 A：

- **A（推荐）复用 `PromptComposer`**，在 `src/main.ts` 里 调 `composer.register(ctx.systemPrompt)`。理由：AD-7 要求两个注入出口只在 `seams/prompt-composer.ts`，且要求身份段字节稳定、有 hash 不变则不重注册的逻辑——这些已经写好并有测试。
- **B 用 `@deepseek-ai/dsh-persona`** 一行 `config.prefix`。更省事，但要放弃 `omw:persona-state` 尾巴（`dsh-persona` 只能注静态 prefix/suffix）与 AD-7 的单出口约束。

选 A 时 `src/main.ts` 的结构与 `src/index.ts` 同构：`export const inject = ['systemPrompt']`、`apply(ctx, config?)`、`ctx.effect` 里挂 dispose、stderr 打一行 `[omw] persona section=harness:identity scope=preset data=<dir>`。

> 落地时必须弄清一件事：`inject` 只影响**这一行插件的激活时机**，**不影响 section 注册到哪个 scope**——scope 由调用点 ctx 决定（§1.1）。所以 `src/main.ts` 里 `composer.register(ctx.systemPrompt)` 之所以落在 preset scope，是因为 `ctx` 是 preset 给的；它跟 `inject` 里写了什么无关。

**`inject` 里只许 `systemPrompt`，绝不许写 `omw.memory`。** 这是本设计最容易踩坏的一处：Cordis 的 `inject` 是「等这些服务都就绪再激活本行」。库打不开时 `omw.memory` 永不 provide，该行就永久 pending，`mountPreset` 的 `auditRows` 会把整个 `omw-main` 判为不可用（`dsh-agent-preset-registry/src/index.ts` 的 `diagnostic()` 报 `agent-preset/invalid`），结果是**人格整段丢失**——正好违反 AD-11「身份不依赖库」。正确写法是不声明 inject，在 `section` 的 `text` 回调里惰性 `ctx.get('omw.memory')`：读服务没有 inject 要求（`reflect.ts:262-279`），缺失就返回 `undefined`，尾巴自然省略。

## 五、路由层

### 5.1 判定只有三种动作，且**从不追问「这该放哪」**

TheOne 的教训（`D:/tmp/theone/src/routing-policy.ts` 的 `settleUnclear`）原文："TheOne does not ask the user where a message belongs. An unclear decision settles on the topic the classifier leaned to (the current one when it is among the candidates), with the other candidates along as reference."——只有路由模型缺失或纠错不明时才追问。本设计沿用这条，因为入口会话的价值是「不停顿」，停下来问归属就是把路由成本推回用户。

```ts
export type RouteAction = 'create' | 'attach' | 'correct'

export interface RouteDecision {
  readonly action: RouteAction
  /** 绑定的既有话题；create 时为新生成 id。 */
  readonly topicId: string
  /** create 时的标题：脱敏后取前 80 字符。 */
  readonly title?: string
  /** attach/correct 的备选，最多 3 个，仅作参考不阻塞。 */
  readonly alternateIds?: readonly string[]
  readonly reason: string
}
```

判定顺序（全部确定性，无模型调用也能跑完）：

1. 显式指定了 `session_id` → `attach`（用户/模型点名了目标，不再猜）。
2. 当前对话已 `attach` 过同一话题且句子是短续指（≤16 字符、整句匹配 继续/接着/然后呢/好的/可以/嗯/ok/go on/more 之类）→ `attach` 原话题，`reason: 'short-continuation'`。
3. 话题词相似度最高者超过阈值且同工作区 → `attach`，`reason: 'topic-similarity'`。相似度用 `shared / sqrt(|a|·|b|)`，阈值 0.6，与 TheOne `mergeSimilarity` 同式（便于将来对照）。
4. 其余 → `create`，`reason: 'new-topic'`。
5. 若判定认为「上一条分错了」，走 `correct`：把该条从未绑定状态改挂到目标话题，`reason: 'correction'`。

**脱敏先行**：标题与审计里的用户文本一律先过 `redactRoutingText()`（抹 `sk-`/`oc_sk_` 前缀密钥、`Bearer` 令牌、`api_key|token|password|secret|密码|密钥 =` 值、邮箱、IPv4）。理由：标题会落进 `routing.json` 与审计行，那是要长期留存的。

### 5.2 账本是操作状态，与记忆库分离（AD-48）

`routing.json` 放在插件数据目录（与 `omw.log`、`snapshots/` 同级），结构：

```jsonc
{
  "version": 1,
  "topics": [
    { "id": "t-<ulid>", "title": "…", "cwd": "D:\\src\\x", "workspaceId": "ws-…",
      "sessionId": "session-…", "preset": "ptc", "createdAt": 1764…, "lastUsedAt": 1764… }
  ]
}
```

为什么不开在 triviumdb 里：

- `data-model.md` §3 的节点 kind 表（`:40`，16 个）由记忆语义定义，路由不承载记忆语义，塞进去要么改 kind 表要么污染召回；**注意：该表并未声明自己是封闭集**（`data-model.md:102` 明说谓词表「不是封闭集合」），所以这条理由是「语义不匹配」而非「类型不允许」；
- AD-2/AD-4 管的是**记忆写入**（一次业务写入一张补丁表一次事务），路由是操作状态，与 `omw.log`、`snapshots/` 同类；
- 单进程（AD-1）意味着不需要跨进程锁，一次 `write tmp → rename` 的原子替换足够，且不需要 schema 迁移。

损坏处理：解析失败即视为「无绑定」，路由工具返回 `E_GATE_DOWN`，人格与记忆不受影响（见 §7）。

### 5.3 派发

创建走 **裸 `ctx.agents.create`，并由派发层自己持有 `AgentHandle`**——**不走 `sessionController.create`**。

这条选择与上一版相反，原因是硬冲突：`sessionController` 把 handle 就地丢弃、只返回 `.agent`（`dsh-api-session-controller/src/agent.ts:443-451` 与 `:314-318` 都是 `return (await this.ctx.agents.resume/create({...})).agent`，全包无 `AgentHandle` 命中），而回收 worker 唯一的手段是 `handle.dispose()`（`dsh-agent/src/index.ts:157-174`：「The disposer is a CAPABILITY: among consumers, only the holder can tear this agent down」）。**「经 sessionController 创建」与「按 `maxLiveWorkers` 回收」不可兼得**，只能二选一；本设计取回收，因此自己建。

这不是自创路径，官方 ACP 插件就是这么写的：`dsh-acp/src/session.ts:123-131` 用 `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions, setup })` 拿 handle，再在构造函数里 `this.disposeAgent = () => handle.dispose()`（`:101-111`）；`resume` 同样（`:141-149`）。

```ts
const presets = ctx.get('agentPresets')
const resolvedId = (await presets.resolve(route.workerPreset)).id   // ★ 白名单在此拦截，见下
await mkdir(cwd, { recursive: true })                              // ① 目录
const fs = ctx.get('fs')
const handle = await ctx.agents.create({
  sessionId: mintSessionId(),                                      // 每次新 id，绝不复用
  meta: { cwd: fs === undefined ? cwd : fs.processPath(await fs.resolve(cwd)),  // ② canonical 化
          agentPreset: resolvedId },                               // ③ 与 mount 成对
  setup: async agentCtx => {
    installModelSelection(agentCtx)                                // 与 sessionController 一致，缺了会没有模型选择
    await presets.mount(agentCtx, resolvedId)
  },
})
await (await ctx.workspaceRegistry.resolveByPath(cwd))?.attachSession(handle.agent.id)  // ④ 归工作区
handle.agent.followup(intent)                                      // 投递，见下
```

**这四步必须自己补**：`sessionController` 替你做的就是这四件（`mkdir` 与 canonical 化 `agent.ts:439`、`:447`、`presets.resolve` + `presets.mount` `agent.ts:262-275`、`agentPreset` 写进 header `agent.ts:448`、`workspace.attachSession` `commands.ts:147-157`）。自己建之后一件都不能省，缺任何一件 worker 都会静默坏掉（后果见下方三条硬约束）。`installModelSelection` 由 `@deepseek-ai/dsh-agent` 导出（用作 `dsh-acp/src/session.ts:15` 的 import）。

`presets.mount(ctx, id?)` 的签名见 `dsh-agent-preset-registry/src/index.ts:296`；`resolve(id?)` 在 `:219-226`，只查存在性——**不做任何白名单判断**，所以 `route.workerPreset` 必须先过 §六 的 `assertWorkerPreset()` 再交给 `resolve`，不得把模型给的值直接透传。

**三条硬约束**（每一条的违反后果都有源码依据）：

- **不要**给 worker 写 `meta.origin: 'subagent'`。`dsh-client-ui-workspace/src/client/tree.ts:241` 会整行过滤掉这种会话（用户看不见），`dsh-api-session-controller/src/agent.ts:99-101`、`:306-308` 会在 resume / prompt 上直接抛 `ApiSessionSubagentOwnership` 并报 `session/agent-busy`——用户想接手也接不了。continuable subagent 的队列编辑是唯一例外分支，resume 没有例外。
- **不要**只写 `meta.agentPreset` 或只 `presets.mount`，两者必须成对。只写 meta：UI 显示为某 preset，实际按宿主编排跑。只 mount：冷开 resume 时 `presetForObservation` 只读投影（`agent.ts:483-487`，无 header 回落），投影为 null → 回落默认 preset（`agent.ts:267`）。DSH 内置的三条创建路径（会话创建、subagent 子代理、fork）都是成对做的。
- **不要**复用 sessionId。`create` 的 `reusable` 语义是「复用未开始的空白会话」，传显式 `sessionId` 会被 `claim()` 串行化并可能复用（`commands.ts:136-142`）——每次派发都传新 id 或不传，否则第二次派发可能落到同一个空会话上。

其余要点与依据：

- `CreateAgentOptions.meta` 是**封闭字段集**（`dsh-agent/src/index.ts:80-87`：`cwd / parentSession / isSeeded / origin / delegationDepth / agentPreset`），所以路由元数据**不能**搭会话 header 便车，必须存自己的账本（§5.2）。这条约束是设计里最容易踩的坑，写在这里。
- 工作区归属由 `header.cwd` 决定（`dsh-workspace` 按 `cwd` 归会话），所以「路由到工作区」在实现上就是「选对 `cwd`」。找不到就 `ctx.workspaceRegistry.resolveByPath(cwd)` 并 `create(path, title)`。
- 投递用 `agent.followup(message)`（`dsh-agent/lib/types/runtime-types.d.ts:220`，注释 "The item becomes the sole ordinary message of its own turn."），消息用 `createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'agent-message', form: 'relay', senderSessionId: mainAgent.id } })`——与 `dsh-tool-session-control` 的跨会话投递同形，那是 DSH 里已被验证的形态。
- 已有会话用 `ctx.agents.resume({ resumeSessionId, ... })`；`meta.agentPreset` 会被 persisted header 覆盖（`dsh-session/src/validation.ts:568`），所以 resumed worker **不会**被提升成主对话。
- live worker 上限（`route.maxLiveWorkers`，默认 3）：超限时回收最久未用的 worker。**结论对（会话不丢、能 resume），但不能只写 `handle.dispose()`**，完整序列是：

```ts
agent.cancel({ kind: 'parent' })            // 先让它停下，别在跑的时候拆
await agent.whenIdle()                     // 等真正静默
await ctx.sessions.flush(agent.session)    // 必须在 dispose 之前：dispose 会关掉写句柄，之后 flush 不了
await handle.dispose()                     // 只 detach，不删盘
ledger.drop(topicId); releaseSlot()        // 再改自己的账本
```

  依据：teardown 实际步骤见 `dsh-agent-loop/src/index.ts:505-545`（`cancel({kind:'disposed'})` → `whenIdle()` → `scope.dispose()` → `stored.handle.close()` → `detachAgent()/detachSession()`），`dispose` 定义在 `:549-556`；两处 `detachEntered` 都只删**内存 Map**（`dsh-agent/src/index.ts:521-535`、`dsh-session/src/index.ts:1013-1022`），而 `dsh-session-persistence` 全目录 grep `deleteSession|removeSession|purgeSession|unlink(` **零命中**，磁盘记录删不掉；`resume`（`dsh-agent/src/index.ts:433-446`）正是 dispose 之后回来的入口。官方回收范式见 `dsh-subagent/src/manager.ts:1077-1082`、`:1094`、`:1160-1170`（`flushFinalState` 里 `flush` 失败只 warn，注释「may be unavailable or stale on resume」——所以本设计要把 flush 放在 dispose 前，不能靠它的兜底）。
- **不要用 `archiveSession` 当回收**。它只把会话从所有分组界面隐藏并清 pin（`dsh-workspace/src/index.ts:363-371` 注释「sessions hidden from every grouping surface … Archiving never touches workspace accounting」，实现 `:373-417`），既不 dispose 也不删 session；且归档过的 id 不能复用（`dsh-api-session-controller/src/commands.ts:140`）。回收后 worker 应**留在 UI 里**（用户可看可接手，FR-33），归档会让人以为它没了。
- 官方 `maxActiveSubagents` 默认 8（`dsh-subagent/src/index.ts:199`），但它只有 `pool.reserve/releaseSlot` 计数（`manager.ts:719`、`:803-811`），**没有 LRU evict 先例**——本设计的「最久未用」需要自建 `lastUsedAt` 记账，属于全新代码，不是照抄。

### 5.4 回流：结果回主对话，但**不夺取主对话的前台**

TheOne 的做法（`D:/tmp/theone/src/index.ts:3321-3351` `relay()`）注释原文："Show autonomous work in main chat without taking the foreground topic." / "The same notice the topic got, as an ordinary chat shows it."，实现是 `gateway.followup(note)`。

本设计照办，但**触发点不能是 `agent/turn-stopping`**（它在 blocked、第 0 步空转、error/aborted 三条路径上都被跳过：`dsh-agent-loop/src/agent.ts:344-346`、`:352-355`、`:398-414` 均直接 `return`/`throw` 不经过它；turn-stopping 只覆盖「正常跑完且无排队 step」一条路，`:391-395`）。

**唯一每条路径都必写的信号是 session 事件 `turn/end`**（`dsh-agent-loop/src/agent.ts:415-421` 在 `finally` 里 `this.session.append('turn/end', { turn, reason: turnEnds! })`），reason 是封闭集 `TurnEndReasonMap` 七个 kind（`dsh-session/src/types.ts:216-248`）。所以回流序列是：

```ts
ctx.on('session/event', ev => { if (ev.type === 'turn/end') settle(ev) })  // 子 ctx 上监听
// settle: await agent.whenIdle() 确认没有续跑 → 读最后一条 assistant → 清账本
```

`whenIdle()` 是必需的第二步，不是保险：它反复等到 `activityDone`（`dsh-agent-loop/src/agent.ts:256-261`），能挡掉紧接着又开一轮的情况；官方 `watchLocalSettlement` 就是 `whenIdle` → 结算 → `runMaintenance` 三步（`dsh-subagent/src/manager.ts:986-1036`），且发现 `inbox.nextTurn/nextStep` 有排队时返回 `'wait'` 而非结算（`:1043-1053`）。**不存在 `agent/turn-end` 事件**（`dsh-agent/src/runtime-types.ts:291-430` 事件全表停在 `'agent/error'`），别去订阅它。

reason 必须映射后再写 note，不能一律当成功：`completed` 才是交付；`aborted` / `blocked` / `error` 要在 note 里标「未完成」；`max-tokens` 标「被截断」；官方映射见 `dsh-subagent/src/lifecycle.ts:81-107` `epochStopReason`。

**「worker 在等人」要单独分支**：`dsh-user-questions/src/projection.ts:317-332` 的 `userQuestions` 投影里 `active[]` 非空（`state:'open'` 表示工具调用还在等，`'continued'` 表示前台已超时、问题仍可回答，`:248-289`）时，note 写「worker 在等你回答 <callId>」而不是「已完成」。注意两个前提：worker 会话**不是** `origin:'subagent'`（否则问询直接被拒，`dsh-user-questions/src/index.ts:144-148` 抛 `DELEGATED_CALLER`）；「在等批准」**没有任何结构化信号**（`dsh-user-approval/src/index.ts:84-110` 的 `approvalState` 只有 `{ policy, turnOpen }`），只能靠超时兜底。

拿到结果后，读它的最后一条 assistant 消息，构造

```
【子任务 <topic.title>】<摘要，截断 2000 字符>
来源：session <workerSessionId> 第 <N> 步
```

再 `mainAgent.followup(note)`。摘要 + 指针而不是整段复制，是为了守住 NFR-5（不复制宿主消息全文）与注入预算；要看细节，主对话再用 `recall` 或读该会话即可。

### 5.5 工具面（AD-47）

只在 `omw-main` preset 内注册两个工具（与人格同住，所以 worker 天生没有）：

| 工具 | 入参 | 返回 |
| --- | --- | --- |
| `omw_dispatch` | `{ intent: string, title?: string, workspace?: string, session_id?: string }` | `{ ok, action, topicId, sessionId, workspaceId, degraded?, reason? }` |
| `omw_topics` | `{ limit?: number }` | `{ ok, items: [{ topicId, title, cwd, sessionId, lastUsedAt }] }` |

错误码封闭为 `{ E_BUDGET, E_TIMEOUT, E_DEGRADED, E_BOUNDARY, E_GATE_DOWN }`——复用 AD-25 的封闭集，不新造。`E_BOUNDARY` 用于「worker 上限已满且无可回收」之外的越界请求（例如要求派发到非本机路径）；`E_GATE_DOWN` 用于账本损坏。

> AD-25 的原文说「工具面是本插件的公开契约」，并列出四个记忆工具。新增两个工具属于**面扩张**，按 AD-25 自己的规定「新增或改签名必须先改本条 AD」，本文以 AD-47 显式扩展：记忆四工具仍是全局面，派发两工具是 preset 局部面。落地时 AD-25 末尾要补一句指向 AD-47，**四个记忆工具的名字与入参一个都不改**。

### 5.6 入口即默认

**这里有一条必须写死的禁令：`default` 与 `selectedDefault` 都不许指向 `omw-main`。**

推导是三步、每步一行源码：

1. `dsh-agent-preset-registry/src/index.ts:81` —— `get defaultId(): string { return this.config.selectedDefault.get() ?? this.config.default }`。两个字段是**同一个出口**，谁被设置谁就是默认。
2. 同文件 `:219-220` —— `async resolve(id?: string)` 里 `const wanted = id ?? this.defaultId`。没点名 preset 就取默认。
3. `dsh-api-session-controller/src/agent.ts:262-274` —— `composeAgent(presetId)` 调 `await presets.resolve(presetId)`，然后把 `resolvedId` 写进 `composition.agentPreset`，`setup` 里 `presets.mount(agentCtx, resolvedId)`。`createSession`（同文件 `:230-234`）与 `resumeObserved`（`:343`、`:364`）都走它，`request.agentPreset` 常常是 `undefined`。

→ 一旦默认指向 `omw-main`，**任何新开的会话（包括用户在 Web UI 里随手点出来的空白会话）都会挂上鲸鲸人格**，这正是 C1 要禁止的事。所以本设计的取向与「入口即默认」相反：

- profile 里保持 `config: { default: standard }`，**不写 `selectedDefault`**（写了就等于给所有人格）；
- 让主对话靠**显式选择**获得：`omw-main` 的 `order` 给 0，在 preset 选择器里排第一，用户开新会话时第一眼就能选到；
- 本插件若提供「开一个主对话」的入口（命令或工具），创建时**显式**传 `agentPreset: 'omw-main'`，不依赖默认值。

这也顺带解释了为什么 §12.6 不采纳原型的 `agent-preset/selected` 抢回守卫：原型需要它，是因为它的 router / worker 两个 preset **都不是**默认 preset，UI 会把空白会话套成默认的那一个；本设计把「默认 ≠ `omw-main`」当成第一道保险之后，同一个泄漏方向上泄漏出去的是 `standard`，不是人格。

## 六、接口契约（实现时照这张表写）

| 层 | 签名 | 归属 |
| --- | --- | --- |
| 插件入口（记忆） | `apply(ctx, config?)` — 不再注册 section | `src/index.ts` |
| 插件入口（人格） | `apply(ctx, config?)` — `inject: ['systemPrompt']` | `src/main.ts` |
| 服务（记忆面发布） | `omw.memory.personaState(): PersonaState \| undefined`、`omw.memory.recall(query, topK)` | `src/seams/runtime.ts` |
| 账本 | `loadBindings(path): Bindings \| undefined`、`saveBindings(path, b): void` | `src/seams/route/bindings.ts` |
| 判定 | `decide(input: DecideInput): RouteDecision`（纯函数，可单测无 ctx） | `src/core/route/decide.ts` |
| 派发 | `dispatch(ctx, deps, decision, intent): Promise<DispatchResult>`（内部用 `ctx.agents.create` 并持有 `AgentHandle`，见 §5.3） | `src/seams/route/dispatch.ts` |
| 白名单 | `assertWorkerPreset(id): string`（非成员回落 `ptc` + 记 `OMW_ROUTE_DISPATCH`） | `src/seams/route/dispatch.ts` |
| 回收 | `recycle(topicId): Promise<void>`（`cancel` → `whenIdle` → `flush` → `dispose` → 清账本，见 §5.3） | `src/seams/route/dispatch.ts` |
| 回流 | `relayToMain(mainAgent, workerId, summary, seq): void` | `src/seams/route/relay.ts` |

`decide.ts` 必须是**纯函数**——它不碰 ctx、不碰文件、不打日志，只吃 `{ text, topics, currentTopicId?, explicitSessionId? }` 出 `RouteDecision`。这样 §5.1 的五条规则全部可表驱动单测，符合 AD-10「固化确定性先行」。

## 七、降级矩阵

人格与记忆解耦降级，依据 AD-18（注入与工具解耦降级）。三格互相独立：

| 故障 | 人格段 | 状态尾巴 | 记忆四工具 | 派发工具 | 日志 |
| --- | --- | --- | --- | --- | --- |
| 库打不开 | **照常**（身份不依赖库，AD-11；前提见下方注） | 整段省略，不填默认值 | 不注册 | 照常 | `OMW_DB_OPEN` |
| `routing.json` 损坏 | 照常 | 照常 | 照常 | 不注册，`E_GATE_DOWN` | `OMW_ROUTE_LOAD` |
| `omw-main` preset mount 失败 | 该 preset 不可用（DSH 报 mount audit 失败） | — | 照常 | — | DSH 自身报告 |

新增**三个**原因码：`OMW_ROUTE_LOAD`（账本读不出）、`OMW_ROUTE_DISPATCH`（派发事务失败）、`OMW_ROUTE_MISMATCH`（§12.5 的 id 与账本不一致），与既有八个并列、仍封闭。

**这是一条显式修订，不是「顺带同步」**：AD-13 的封闭集由 **8 扩到 11**。**契约层四处已于 2026-11-25 改完**，实施时只需对齐而不必再裁决——`requirements.md` 的 FR-18（「十一个」并列出全部码名）、`SPEC.md` 的 CAP-5 success 与 Constraints 两条、`epics.md` 的 FR-18 可测项与 AR-8、`ARCHITECTURE-SPINE.md` 的 AD-13 正文与「坏的时候看哪里」码表。**剩余待实施对齐的三处**：`src/core/degrade.ts` 的常量表、`/omw doctor` 的码表、`README` 的错误码段——这三处属于 CAP-9 落地时同批改，缺一处即视为该故事未完成。

> **已交付快照不改数**：`implementation-artifacts/epic-1-context.md`、`spec-epic-1-plugin-foundation.md`、`prd.md` §10 的「八个」保留原样（它们是 Epic 1 时点的记录），各加一条指向本条修订的注记。历史交付记录不该被追溯改写。

> **两组码别混**：:307 列出的 `{ E_BUDGET, E_TIMEOUT, E_DEGRADED, E_BOUNDARY, E_GATE_DOWN }` 是**工具返回值**（给人看的 `E_*` 面），`OMW_*` 是**日志与 doctor 的原因码**（给排查用的）。`E_GATE_DOWN` 与 `OMW_ROUTE_LOAD` 是同一故障的两面：前者是 `omw_dispatch` 的返回，后者是日志里那一行的码。

> **「库打不开 → 人格照常」那一格的前提**（AD-54、AD-11）：人格段不依赖库服务。这要求 `src/main.ts` 的 `inject` 数组**只有** `systemPrompt`，`omw.memory` 必须在 section 的 `text` 回调里惰性 `ctx.get()`。若把 `omw.memory` 写进 `inject`，库坏时该行永久 pending → `auditRows` 判 `omw-main` 不可用 → 人格整段丢失，这一格就变成「人格也没了」。I24 专门守这条。

## 八、实施步骤

| # | 动作 | 文件 |
| --- | --- | --- |
| S1 | 把根 ctx 的 section 注册删掉，记忆面只留工具与服务 | `src/seams/runtime.ts:202-210`、`:321-322` |
| S2 | 新增人格入口：只做 composer 注册 + stderr 一行 | `src/main.ts`（新） |
| S3 | `omw.memory` 服务化（状态尾巴的唯一读取口） | `src/seams/runtime.ts`、`src/seams/prompt-composer.ts` |
| S4 | 路由账本（原子写 + 损坏即关） | `src/seams/route/bindings.ts`（新） |
| S5 | 判定纯函数 + 表驱动测试 | `src/core/route/decide.ts`（新）、`test/core/route/decide.test.ts` |
| S6 | 派发与回流 | `src/seams/route/dispatch.ts`、`src/seams/route/relay.ts`（新） |
| S7 | 两个派发工具的注册（preset 局部） | `src/main.ts` 或 `src/seams/route/tools.ts` |
| S8 | preset 声明与 package 三处补齐 | `presets/omw-main.patch.yml`（新）、`package.json` |
| S9 | doctor 第五项改判 + 码表扩充 | `src/seams/commands.ts` |
| S10 | 启用：profile 里加一行 insert（**不写 `selectedDefault`**，见 §5.6 禁令） | `C:/Users/ellio/.dsh/profiles/web/cordis.patch.yml` |
| S11 | 白名单闸门 `assertWorkerPreset(id)` + 单测 | `src/seams/route/dispatch.ts`、`test/seams/route/dispatch.test.ts` |

**S8 的 preset 行形如**（照 `dsh-web-app/presets/ptc.patch.yml` 抄，删掉它不需要的，加上本插件两行）：

```yaml
- insert:
    - id: preset-omw-main
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: omw-main
        name: 鲸鲸
        description: 入口会话：鲸鲸在这里，工作派给别的会话
        order: 0
        plugins:
          - id: omw-persona
            name: dsh-oh-my-whale/main
            config: {}
          # …以下与 ptc 同构：tool-pwsh / tool-fs / tool-fs-search / tool-jobs / tool-web …
```

> 注意 `mountPreset` 的硬约束（`dsh-agent-preset-registry/src/mount.ts:204-216`）：把服务**发布**到根 realm 的 preset 行必须包在 `isolate` 组里，否则报 `Preset services require isolate realms: …`。三点要分清：
>
> 1. **只有 provide 触发**。判据是「该实现的 store symbol 是否等于根 realm 里该名的 symbol」（`mount.ts:69-83`，核心行 `if (rootIsolate[impl.name] === key) leaked.push(impl.name)`）。注册工具（`ScopedLayers`）与注册 prompt section 都**不产生服务**，永不触发。本插件的两个入口都不 provide，因此不触发。
> 2. **`isolate` 写在哪**。写在提供服务的那个行上；若 provider 与其消费者都要在私有 realm 内，写在包住二者的 `cordis:group` 行上（官方 `dsh-web-app/presets/ptc.patch.yml:51-56` 就是这么写 `planMode` 的）。
> 3. **合法值只有 `true` 与字符串**。`true` = 该行私有 `LocalRealm`；字符串 = 同名 label 共享 `GlobalRealm`。写成 `false` 或对象是配置校验错误（`cordis-plugin-loader/src/config/utils.ts:146-152`）。

## 九、验证（新增 I17…I20 与 I24…I26，增量见 §12.7 的 I21…I23）

| # | 断言 | 检查方式 |
| --- | --- | --- |
| I17 | 人格段只出现在主对话的 system 消息里 | 建一个 `ptc` worker 与一个 `omw-main` 会话，各读一次 `ctx.sessionQuery.listEvents`，断言 worker 的 system 文本里不含 `assets/persona.md` 的任何 20 字符片段，主对话含 |
| I18 | 根 ctx 零注入 | 静态门禁：`harness:identity` 与 `omw:persona-state` 两个字面量只允许出现在 `src/main.ts` 与 `src/seams/prompt-composer.ts`；`src/index.ts` 不得 import `./seams/prompt-composer.ts` |
| I19 | worker 无派发能力 | worker 会话的工具面（`assemble` 结果）不含 `omw_dispatch` / `omw_topics`；且工作区 B 的会话同样不含 |
| I20 | 路由账本损坏不影响人格与记忆 | 手写一个非法 `routing.json` 后重启：身份段仍注入、四个记忆工具仍可用、`omw_dispatch` 返回 `E_GATE_DOWN` |
| I24 | 后台库不可用不影响人格 | 把库文件改为只读或移走使其打不开，重启：`omw-main` 会话仍能建立、system 消息仍含身份段全文、状态尾巴整段缺席；同时 `src/main.ts` 的 `inject` 数组静态断言不含 `omw.memory` |
| I25 | worker 的 preset 受白名单约束且可被接手 | 让主对话以 `agentPreset: 'omw-main'` 调 `omw_dispatch`（或任何非白名单值）：实际建出的 worker 会话 header 里 `agentPreset` 为 `ptc`，日志有一条 `OMW_ROUTE_DISPATCH`；该会话出现在侧栏（可 `listSessions` 查到且 `origin !== 'subagent'`），可 resume 并对它 `prompt` 不报 `session/agent-busy` |
| I26 | 回收不丢会话、不改可见性 | 对 worker 本职跑完一轮后触发回收：`ctx.agents.list()` 不含该 worker，`workspaceRegistry.archivedSessionIds` 不含它，侧栏仍能查到该会话，且 `ctx.agents.resume({ resumeSessionId })` 成功并读到本轮结果 |

I17 与 I19 都是「结构性断言」——它们没有通过路径，只有失败路径。这正是本设计的目标：**不是靠运行时判断把人格藏起来，而是让它不在那条链上**。

## 十、对既有文档的增量（落地时逐条写入）

> AD-50…AD-53 属于官方原型对照的增量，正文在同属十节的 §十二；此处只列 AD-46…AD-49 与 AD-54…AD-55。

### AD-46 人格的可见范围由 preset 作用域决定，不由运行时判断

人格段（`harness:identity`）与状态尾巴（`omw:persona-state`）只允许从 `omw-main` preset 内的插件实例注册；profile 安装位**不得注册任何 section**。禁止任何代码路径在根 ctx 注册这两个名字。理由：根 ctx 落 global layer，所有 scope 可见（§1.1）；preset scope 只对该 preset 的 agent 链可见（§1.2）。

### AD-47 派发是入口会话的独占工具面

`omw_dispatch` 与 `omw_topics` 只在 `omw-main` preset 内注册，因此 worker 与会话在结构上不具备派发能力。记忆四工具（AD-25）仍是全局面，签名与返回封包不变。本条是对 AD-25「新增或改签名必须先改本条 AD」的显式扩展。

### AD-48 路由账本是操作状态，与记忆库分离

话题绑定存 `routing.json`（插件数据目录，原子替换写），不进 triviumdb，不参与召回，不属 `data-model.md` 的节点 kind 体系。损坏即关闭路由（`E_GATE_DOWN`），不试图修复、不迁移。

### AD-49 worker 的人格在创建时决定，永不事后撤销

worker 一律以 `meta.agentPreset = <非 omw-main>` 创建；任何代码路径不得尝试「先注人格再撤」。理由：段退役只追加 `The earlier instructions from <name> no longer apply.` 通告（§1.4），历史不可回收。

### AD-54 `omw.memory` 全仓只允许一处 provide，且禁止对它写 isolate

profile 安装位是唯一 provider；preset 侧只读（`ctx.get()`），不声明 `inject`。理由三重：同名双 provide 不隔离则抛 `service "X" has been registered at <fiber>`（`cordis/src/reflect.ts:325-327`），整个 preset 挂不上；写了 `isolate` 则静默并存、两个实例各开一个库，而 `leakedServices` 只比对根 symbol 因此不报警（`dsh-agent-preset-registry/src/mount.ts:69-83`）；写进 `inject` 则库坏时整行永久 pending，`auditRows` 判 `omw-main` 不可用，人格整段丢失（§4.3）。

### AD-55 worker 由派发层用 `ctx.agents.create` 自建并持有 `AgentHandle`，preset 过白名单

**不走 `sessionController.create`**：它把 `AgentHandle` 就地丢弃、只返回 `.agent`（`dsh-api-session-controller/src/agent.ts:443-451`、`:314-318`），而回收唯一手段是 `handle.dispose()`，两者不可兼得（§5.3）。先例是官方 ACP 插件（`dsh-acp/src/session.ts:123-131`、`:101-111`）。代价是自己补齐 sessionController 原本代劳的四步——`mkdir` + canonical cwd + `presets.resolve`/`mount` + header 写 `agentPreset` + `workspace.attachSession`——四步缺一即静默坏掉。

`agentPreset` 必须过 `assertWorkerPreset()` 白名单，非成员回落 `ptc` 并记 `OMW_ROUTE_DISPATCH`：通用创建路径没有任何 provider 能力闸门，`presets.resolve` 也只查存在性（`dsh-agent-preset-registry/src/index.ts:219-226`），这层校验只能由本插件提供。同时禁止给 worker 写 `meta.origin: 'subagent'`（会让会话从 UI 消失且无法被用户接手），禁止复用 sessionId。

**回收不是 `archiveSession`，也不能只写 `dispose()`**：完整序列是 `cancel({kind:'parent'})` → `whenIdle()` → `sessions.flush()` → `handle.dispose()` → 清账本释放槽位，flush 必须在 dispose 前（§5.3）。

### FR-25…FR-33（新增，CAP-9）

- **CAP-9 入口与路由**：用户在一个会话里跟鲸鲸说话，工作被派给别的会话去做；其余会话记得住但不像鲸鲸。
- **FR-25 人格只进主对话**（AD-46、AD-49）：非 `omw-main` 会话的 system 消息里零人格文本；老会话升级后不长出人格；手工切换到 `omw-main` 在开过第一轮后报 `agent-preset/locked`。
- **FR-26 其余会话有记忆读写、无人格**（AD-47）：任一 worker 会话可调用四个记忆工具、不可调用派发工具；库只有 profile 安装位一个打开者。
- **FR-27 派发不停顿**（AD-48）：判定从不追问「这条消息属于哪个话题」；不明确时落定到最接近的话题并带最多 3 个备选；标题与审计里的用户文本先脱敏。
- **FR-28 结果回主对话但不夺前台**（AD-48）：worker 收尾后主对话收到一条带摘要与 `<sessionId> 第 N 步` 指针的 note，正文不超过 2000 字符，不复制 worker 的消息全文。
- **FR-29…FR-31** 定义在 §12.7（原型对照增量），此处只留索引不重复正文：派发可重试且不重复投递（AD-51）／派发失败可见（AD-50）／从会话反查话题（AD-53）。
- **FR-32 worker 的 preset 受白名单约束**（AD-55，编号接 §12.7 的 FR-31 之后）：派发目标 preset 不在白名单内时回落 `ptc` 并记一条 `OMW_ROUTE_DISPATCH`，绝不透传模型给出的任意 preset id；worker 从不以 `omw-main` 创建。
- **FR-33 worker 可被用户接手**（AD-55）：worker 会话在侧栏可见、可 resume、可接管；不写 `meta.origin: 'subagent'`，创建后挂到对应工作区（无匹配工作区时留在 Ungrouped 组，不隐藏）。

> **CAP 编号说明**：CAP-9 在初稿里是 CAP-7。2026-11-25 的跨文档编号审计发现 `CONTEXT-GOVERNANCE.md` 把「上下文治理」也编成 CAP-6（与 `SPEC.md:49` 的「CAP-6 迁移」撞号），故把 CAP-6 之后的空位按文档出现时间重排：**CAP-7 上下文治理**（`CONTEXT-GOVERNANCE.md`，24 处引用一并改号）、**CAP-8 看视频融合（候选）**（`research/technical-video-watch-fusion-2026-11-23/FUSION-DESIGN.md`）、**CAP-9 入口与路由**（本条）。不复用、不跳号。

### NFR-11

路由判定 p95 ≤50ms（纯函数，无网络）；`omw_dispatch` 从调用到 worker 收到消息 p95 ≤800ms（不含 worker 自身执行）。

## 十一、未决与风险

1. **老会话的迁移**。本设计不为已存在的老会话补人格（做不到，也不该做）。若用户希望某个老会话变成主对话，唯一路径是新开一个 `omw-main` 会话并把上下文重新说一遍。是否提供「复制最近 N 条到新主对话」的便利，属下一轮决定。
2. **worker 的 preset 白名单**（已核对结案：闸门不存在，因此必须自建）。`assertProvider` 与 `assertCapabilities` 都是 **subagent 提供方协议**的策略（`dsh-tool-subagent/src/preset-selection.ts:53-57` 每次构造工具时查、`dsh-subagent/src/index.ts:596-602` 每次子代理请求时查），通用创建路径完全不经过它们——`dsh-agent/src/index.ts:421-431` 只是 `Reflect.apply(createAgent, ...)`，`dsh-agent-loop/src/index.ts:725-753` 的 `createAgent` 全文不含 `agentPresets`；`presets.resolve` 只查存在性，会抛的只有 `agent-preset/not-found` 与 `agent-preset/invalid`（`dsh-agent-preset-registry/src/index.ts:219-226`）。反证是 DSH 自己：会话 fork 直接调 `ctx.agents.create` 并传 `composition.agentPreset`，没有任何 provider 能力检查（`commands.ts:277-294`）。
   → 结论：插件可指定任意已注册 preset。**代价是这层校验得我们自己补**：`route.workerPreset` 必须对白名单取交集，不得把模型给出的 preset id 直接透传（否则模型一句「用 omw-main」就能把人格塞进 worker，C1 当场破）。这条写成 FR：派发前 `assertWorkerPreset(id)` 只接受白名单成员，非成员回落 `ptc` 并记 `OMW_ROUTE_DISPATCH`。
3. **`omw.memory` 服务的可见性**（已核对结案）。`mountPreset` 只拦「preset 子树向根 realm **发布**服务」，不拦读取；读取没有 `inject` 要求，也不受隔离影响（`cordis/src/reflect.ts:262-279`）。**但要写死一条禁令（AD-54）**：任何 profile 行与 preset 行都不得对同一服务名各 provide 一次——不隔离时会直接抛 `service "X" has been registered at <fiber>`（`reflect.ts:325-327`），整个 preset 挂不上；写了 `isolate` 则**静默并存**，两个实例各开一个库，且 `leakedServices` 不报警（它只比对根 symbol，`mount.ts:69-83`）。`omw.memory` 全仓只允许一处 `provide`，即 profile 安装位。
   推论：`omw-main` 的 patch 里**不得**给 `omw.memory` 写 `isolate`；`src/main.ts` 的 `inject` 数组里**不得**出现 `omw.memory`（见 §4.3 的降级陷阱）。
4. **主对话的唯一性**。本设计不强制「全局只有一个 `omw-main` 会话」——用户完全可以开两个，两个都有人格、都能派发，绑定表各记各的话题，互不干扰。若将来要提示「你已经有一个主对话」，判据要按可用性分档，不能靠 `filterSessions`：那个 filter 只有 `id | cwd | created-at | parent | availability` 五种 kind，**没有 preset 谓词**（`dsh-session-query/lib/types/types.d.ts:185-199`）。
   - 轻量（同步、零 IO、仅覆盖 live 会话）：`ctx.agents.list().filter(a => a.session.header.agentPreset === 'omw-main')`（`dsh-agent/src/index.ts:599`、`dsh-session/src/index.ts:323`）。
   - 覆盖冷会话：`await ctx.sessionQuery.listSessions()` 后在内存里按 `record.header.agentPreset` 过滤（`dsh-session-query/lib/types/types.d.ts:27-36`）。
   - 权威判据（blank 期可能改过 preset，header 只是创建时的值）：`ctx.agentPresets.presetForSession(session)`（`dsh-agent-preset-registry/src/index.ts:88-90`，投影 `src/session.ts:40` 的 `init: header => header.agentPreset ?? null`）。
5. **回收语义是全新代码**（本轮新增风险）。`maxLiveWorkers` 需要的「最久未用」在 DSH 里没有先例：官方 `maxActiveSubagents` 默认 8（`dsh-subagent/src/index.ts:199`）但只有 `pool.reserve/releaseSlot` 计数（`manager.ts:719`、`:803-811`），不做 evict。所以 `lastUsedAt` 记账、槽位释放、账本一致性都要自己写并单测。另有一条已知缺口：`resume` 依赖 `sessions.flush` 成功，而官方 `flushFinalState` 失败时只 warn（`dsh-subagent/src/manager.ts:1160-1170`，注释「may be unavailable or stale on resume」）——本设计把 flush 放在 `dispose` 之前（§5.3）并把失败当硬错误，但那次 warn 兜底仍在，回收后的 worker 状态**可能** stale，回流 note 要带「已回收，细节可能滞后」。
6. **完成判定的三个边角**（本轮新增风险）。其一，`agent.status` 与 `whenIdle()` 都不携带结果，只能靠 `turn/end.reason` 折算（§5.4）；其二，worker 卡在**批准**上没有任何结构化信号（`dsh-user-approval/src/index.ts:84-110` 的 `approvalState` 只有 `{ policy, turnOpen }`），只能靠 `E_TIMEOUT` 兜底；其三，若 worker 会话被写成 `origin:'subagent'`，`questions` 投影会直接拒绝问询（`dsh-user-questions/src/index.ts:144-148`），与 AD-55 的禁令同源。

## 十二、原型对照：派发机制的增量（AD-50…AD-53）

资料：`https://github.com/deepseek-ai/dsh-superagent-prototype`（README 自称研究原型，非官方产品），检出 `D:/tmp/superagent`，commit `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`。下文 `superagent:file:line` 均指该 commit。它的体量远大于本项目（Source/Thread/Eval/Mandate/Ticket/Assignment 六层领域模型），所以这里只对照**派发**这一条链路，逐条判采纳或不采纳。

### 12.1 一条结构性观察：它也把「人格/策略」做成按会话注入

`superagent:src/app/sessions.ts:244-249` 在 **`agent.ctx`** 上注册策略段：

```ts
agent.ctx.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false,
  text: context => { … },
  ...(master ? { complete: true } : {}) })
```

这正是本文 §1.1 的机制结论在另一个实现里的复现：注册在谁的 ctx 上，就只进谁的会话。它和本文的区别只在粒度——它按 **agent** 注入（临时算），本文按 **preset** 注入（结构性，创建时就定了，且不需要在 callback 里判断角色）。两者不冲突；本文继续用 preset，是因为 C1 要求的是「结构上不可能有」，而不是「回调里算出来没有」。

`superagent:src/app/sessions.ts:263` 与 `:289-297` 还给出一条本文缺的工具收窄手段：`agent.ctx.tools.restrict({ allow })`。本文的派发工具按 preset 分区（AD-47）已经达到同样的效果，故不需要再叠一层 restrict。但它的两条实现经验必须记下：

- **`tools.restrict({ allow })` 不能列局部工具**（如 `subagent`）。注释原文（`superagent:src/app/sessions.ts:283-292`）："Read inherited tools through the parent scope, which includes the preset's tools. The global view misses preset tools; the agent's own view also includes local tools such as subagent, which restrict refuses to name." 判断某工具是否可用须 `tools.get(name, scopeParentOf(agent))`。将来若真要收窄工具面，这条会直接决定写法。
- 主会话的工具面被它收成 `['skill','bash','read','read_image','job_output','job_list','job_kill']`（`superagent:src/app/sessions.ts:263`）——**主会话几乎不干活，只编排**。这是 C3 的一种更极端的表达：本文不照抄（用户明确要求主对话仍是鲸鲸本人，要能读、能答），但这印证了「派发工具只给入口」的方向。

### 12.2 AD-50 派发用「先存后做」的持久副作用队列

**采纳。** `superagent:src/app/effects.ts` 的实现与理由都成立，且与本项目 AD-1「单进程纯插件」不冲突：

- 每个决定之后的动作（派发、回流、投递）**先落盘再执行**；失败按 `retry[0] * 2 ** min(attempts,16)` 退避，默认 `retry = [2000, 60_000]`；
- `Later extends Error`（同文件）用来表达「现在不能跑，稍后重排且**不计失败次数**」——把「时机不对」与「真失败」分开，避免抖动吃掉重试额度；
- 同一 `kind` 内有序，失败行阻塞后续同 kind 行；连续失败 `FAILURES_BEFORE_ERROR = 3` 次才上报；
- 删行时校验 `kind/key/seq/generation` 四元组，防止慢任务回来覆盖新载荷；
- 注释原文："Leave running rows untouched on shutdown so they retry on the next start."

本项目的落地方式不同：原型用 SQLite 单开一张 `effect` 表；本项目已有 `routing.json`（AD-48），扩展成

```jsonc
{ "version": 1, "topics": [ … ], "effects": [
    { "kind": "dispatch", "key": "t-<ulid>", "seq": 3, "due": 1764…, "attempts": 0, "value": { … } } ] }
```

仍是「一次 `write tmp → rename` 的原子替换」。不引入 `node:sqlite` 的第二个数据库，因为 AD-48 已定「路由是操作状态、不进 triviumdb」，再开一个库等于多一份损坏面。队列规模是「同时在飞的派发」，个位数，全量重写的成本可以忽略。

### 12.3 AD-51 派发消息的幂等：固定 message id + 先查历史

**采纳，且这是本文第一版最实的一处缺口。** 第一版 §5.3 只说 `agent.followup(message)`，没有回答「重试会不会把同一个任务投两遍」。原型的答案是（`superagent:src/app/delivery.ts`）：

```ts
export const messageId = (requestId: string) => MessageId(`dsh-superagent:${requestId}`)
```

配合 `history(agent)`：`await ctx.sessionPersistence.flush()` 后 `open(agent.id, 'read')`，循环 `handle.read(offset, 512)` 重建「已投递过的 id 集合」，投递前先查；投递后 `send()` 里还要 `if (this.ctx.agents.get(agent.id) !== agent) throw new Error('Delivery target was disposed')`。

本项目的对应设计：

- `requestId = `dis:${topicId}:${seq}``（`seq` 来自账本里的投递序号），消息 id 固定为 `omw:${requestId}`；
- 投递前用 `ctx.sessionQuery.listEvents(sessionId)` 扫一遍 user 消息 id 集合（本文 §六 已列该接口），命中即跳过，并把账本里该 effect 标记 done；
- 这样 §12.2 的队列可以放心重试，重复投递是**结构上不会发生**，不是「通常不会」。

注意：`dsh-llm/src/message.ts:246-253` 的 `createMessage` 自己 mint `randomUUID()`，`createUserMessage` 的入参签名是 `input: T & { readonly id?: never }`（`:271-273`），**传不进 id**。要固定 id 只能用 `freezeMessage({ ...createUserMessage({...}), id })` 这种「造好再覆写」的写法（`freezeMessage` 在 `:237-239`，保留既有 id）。这一点必须写进实现说明，否则实现者会以为能直接传。

### 12.4 AD-52 区分「人来了」与「系统投递」，靠 source.kind 不靠文本

**采纳。** 原型执行器的判据（`superagent:src/executor/dsh.ts:477-512`）：

- `agent/inbox/claimed` 事件里 `message.source.kind === 'user'` 才算「人真的来过」；
- `session/event` 里 `event.type === 'user/message' && event.data.source.kind === 'dsh-superagent'` 才算「本轮投递已被读」。

本项目照此：派发消息的 source 用 `{ kind: 'agent-message', form: 'relay', senderSessionId: mainAgent.id }`（与 `dsh-tool-session-control/src/index.ts:124` 同形，已验证是本机存在的 kind），回流 note 用 `form: 'notice'` + `boundContextSummary()`（`dsh-llm/src/message.ts:154-158`，上限 `CONTEXT_SUMMARY_MAX_CHARS = 120`）。于是：

- `kind === 'user'` → 用户本人；
- `kind === 'agent-message'` → 主对话派来的；
- 任何未知 kind → 按 `dsh-llm` 的约定 fall through（`message.ts:129-134` 注释原文 "user messages carry any producer's kind, and consumers fall through unknown kinds"）。

**这个形状是被强制校验的，不只是约定**（本次复核新增证据）：会话迁移/落盘的校验器持有一份**封闭白名单** `SOURCE_KINDS`，共 16 个 kind（`dsh-session-format-v2-to-v3/src/payload.ts:10`），`assertSource` 在 `:112` 对 `user/message`、`assistant/message`、`tool/result` 逐条检查；其中 `agent-message` 有**专门分支**要求恰好 `['kind','form','senderSessionId']` 三个字段、`form === 'relay'`、`senderSessionId` 非空（`:115-118`）。所以：

- 选 `agent-message` 是唯一既表达「另一个 agent 说的」又**已经通过封闭校验**的 kind；
- **严禁自造 kind**（例如 `omw-dispatch`）。类型上可以靠 `declare module '@deepseek-ai/dsh-llm'` 合并 `MessageSourceMap` 加上去（`dsh-subagent/src/continuation-messages.ts:37-41`、`dsh-agent-team/lib/types/types.d.ts:106-110` 两个先例），但**运行期**会被 `:112` 拒绝，报 `cannot safely transform unclassified message source`。AD-52 据此加一条禁令：只许用白名单内已有的 kind。

这条替代了第一版隐含的「靠文本前缀判断是谁说的」，也满足 NFR-7「不复制宿主消息全文」。

### 12.5 AD-53 worker 会话 id 里编码话题，不从 header 取路由元数据

**采纳。** 原型（`superagent:src/executor/dsh.ts:24-26`）：

```ts
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
export const ticketOfSession = (sessionId: string): string | undefined =>
  sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined
```

这正是本文 §5.2 那条约束（`meta` 是封闭字段集，路由元数据进不了 header）的另一种绕法：**把元数据编进 id**。它带来的实际好处是「从任意一个会话对象反查它是谁的工」，不需要读账本，也就不怕账本损坏。

本项目采用 `omw-<topicId>` 形式（比 `worker-` 更明确归属），并在 `dispatch.ts` 里导出对称的两个函数 `workerSessionId(topicId)` / `topicOfSession(sessionId)`。账本仍是权威（AD-48），id 里的编码只是**冗余索引**：账本说 A、id 说 B 时以账本为准并记一条 `OMW_ROUTE_MISMATCH`。

### 12.6 明确不采纳的四条

| 原型的做法 | 位置 | 为什么不采纳 |
| --- | --- | --- |
| `agent-preset/selected` 监听器抢回自家属 preset（`presets.select(agent, ours)`） | `superagent:src/app/sessions.ts:122-131` | 它需要这个守卫，是因为它的 router/worker 两个 preset 都**不是**默认 preset，UI 会把空白会话套成默认。本文把「默认 ≠ `omw-main`」当第一道保险（§5.6），泄漏出去的是 `standard` 而不是人格；再加一层抢回，等于给「人格可以被装上」留了一条运行时路径，与 AD-49「创建时决定、永不事后撤」相悖。若将来确实需要（例如用户要求「开新会话即是主对话」），必须先改 AD-49。 |
| 六个概念以上的领域模型（Source/Thread/Eval/Mandate/Ticket/Assignment） | `superagent:docs/001-domain.md` | 原型要解决的是「多个外部来源自动产生工作」，本项目只有一个入口会话（C3 的语义是「入口派活」，不是「多源接入」）。照抄会把 AD-1 的插件体量撑破。它的 `Rejected concepts` 表（同文件）反而是高价值读物：拒绝 Correlation 参与路由、拒绝 Subscription 做准入、拒绝从报告自由文本推断「在等人」——这三条与本文 §5.1「不追问」、§5.4「摘要+指针」同向。 |
| `Mandate` / 授权与上下文分离 | `superagent:docs/002-authorization.md` | 它解决「自动发现的工作要不要做」的授权问题。本项目的派发由用户在入口会话里**当场发起**，授权来源就是那条消息本身，没有第二重主体要校验。保留它的那句原则即可："This delivery bypasses the gate and grants no new authority"——回流 note 不得携带新的派发授权。 |
| worker 30 分钟硬上限 + 工位（worker slot）账 | `superagent:docs/003-execution.md` | 本项目第一版用「live worker ≤3，超出回收最久未用者」（§5.3），比工位账简单一个数量级。硬上限的价值在无人值守的多源场景；本项目的 worker 由人当场发起，人在等。若将来加了「后台自发工作」，再引入工位与上限。 |

### 12.7 新增编号

- **AD-50** 派发动作先落盘再执行；失败退避重试，`Later` 语义的失败不计次数；同 kind 有序；删除校验四元组。（§12.2）
- **AD-51** 每次派发有稳定的 `requestId`，消息 id 由它派生；投递前扫历史去重。（§12.3）
- **AD-52** 「人 / 主对话 / 系统」由 `message.source.kind` 区分，不由文本判断；回流 note 带 `boundContextSummary` 摘要。**kind 只许取自 DSH 的封闭白名单，严禁自造**（校验器 `payload.ts:10,112` 会拒绝未分类 source）。（§12.4）
- **AD-53** worker 会话 id 编码话题（`omw-<topicId>`），作为账本之外的冗余索引；冲突以账本为准。（§12.5）
- **FR-29** 派发可重试且不重复投递（AD-51）：同一 `requestId` 重试任意次，worker 侧只出现一条对应消息。
- **FR-30** 派发失败可见（AD-50）：连续失败 3 次写一条 `OMW_ROUTE_DISPATCH` 日志并在 `omw_topics` 里标出该话题 `pending`。
- **FR-31** 从会话反查话题（AD-53）：给定任一会话 id，`topicOfSession` 无需读账本即可给出话题 id 或 `undefined`。
- **NFR-12** 派发队列在重启后不丢：`routing.json` 里未完成的 effect 在下次 `apply` 时继续，且不重复投递（依赖 AD-51）。
- **I21** 幂等：对同一 topic 连续调 `omw_dispatch` 两次（同一 intent），worker 会话里 user 消息计数 +0（第二次命中历史去重）。
- **I22** 重启续跑：写入一条 due 在未来 60s 的 dispatch effect 后立刻重启插件，effect 仍在 `routing.json` 中且 attempts 不重置。
- **I23** 反查：`topicOfSession(workerSessionId('t-x')) === 't-x'`；对任意非 `omw-` 前缀会话返回 `undefined`，且不读账本（可用 spy 断言）。

### 12.8 实施步骤增补（接 §八 的 S11 之后，从 S12 起编号）

| # | 动作 | 文件 |
| --- | --- | --- |
| S12 | `routing.json` 扩展 `effects` 队列：入队、退避、四元组校验、重启续跑 | `src/seams/route/bindings.ts` |
| S13 | 稳定 `requestId` 与消息 id 派生；投递前扫 `sessionQuery.listEvents` 去重；`freezeMessage` 覆写 id | `src/seams/route/dispatch.ts` |
| S14 | 派发/回流消息的 `source` 与摘要长度按 AD-52 固定 | `src/seams/route/dispatch.ts`、`src/seams/route/relay.ts` |
| S15 | `workerSessionId` / `topicOfSession` 与冲突时的 `OMW_ROUTE_MISMATCH` | `src/seams/route/dispatch.ts` |
| S16 | 上述三条的测试：幂等、重启续跑、反查 | `test/seams/route/dispatch.test.ts` |
| S17 | 派发层自持 `AgentHandle` + 回收序列（`cancel`→`whenIdle`→`flush`→`dispose`→清账本）+ `lastUsedAt` 记账；测试走 I26 | `src/seams/route/dispatch.ts`、`test/seams/route/dispatch.test.ts` |
| S18 | 完成判定改订阅 `session/event` 的 `turn/end`，按 reason 折算 note；`userQuestions.active` 非空时走「在等你回答」分支 | `src/seams/route/relay.ts`、`test/seams/route/relay.test.ts` |

### 12.9 这份增量对 C1/C2 的影响：零

前十一节的可见性结论一条都没变：人格仍只从 `omw-main` preset 注册，worker 仍以非 `omw-main` 创建。十二条增量全部落在**派发可靠性**上（幂等、重启、反查、来源区分），没有引入任何「把人格装上再摘掉」的路径。§12.6 第一条否决的正是那样一条路径。

## 十三、来源清单

| 结论 | 来源 |
| --- | --- |
| 注册作用域=调用点 ctx | `cordis/lib/index.js:88-93`、`:127-165`（:134）、`:1322-1366` |
| preset 独立 scope、agent 挂其下 | `dsh-agent-preset-registry/src/index.ts:118-137`、`:280-289`、`dsh-scope/src/store.ts:192-199` |
| 同名段遮蔽、complete 校验在后 | `dsh-system-prompt/src/index.ts:702-790`（:711、:775-777） |
| 宿主开场句在根层注册 | `dsh-system-prompt/src/index.ts:509-519` |
| 段退役只追加通告 | `dsh-system-prompt/src/admission.ts:127-140`、`:719-746` |
| persona 是 preset 里的一行 | `dsh-persona/src/index.ts` 全文 |
| preset 声明文件与数组式 patch | `dsh-web-app/package.json`、`dsh-web-app/presets/ptc.patch.yml` |
| preset 定义形态与校验 | `dsh-agent-preset-registry/src/definition.ts:4-39` |
| mount 的 isolate 约束 | `dsh-agent-preset-registry/src/mount.ts:204-216` |
| preset 在首轮后锁死 | `dsh-agent-preset-registry/src/index.ts:364-368` |
| `meta` 是封闭字段集 | `dsh-agent/src/index.ts:66-132`（:80-87） |
| `followup` 语义 | `dsh-agent/lib/types/runtime-types.d.ts:220` |
| resumed 会话保留 header preset | `dsh-session/src/validation.ts:568`、`dsh-session/src/types.ts:133-139` |
| 跨会话投递的既有形态 | `dsh-tool-session-control/src/index.ts` 全文 |
| 不追问归属、脱敏、相似度 | `dsh-theone@5c96ea4` `src/routing-policy.ts`（`settleUnclear`、`redactRoutingText`、`mergeSimilarity`） |
| 结果回流用 followup 不夺前台 | `dsh-theone@5c96ea4` `src/index.ts:3321-3351` |
| 会话 id 生成与元数据 | `dsh-session/src/index.ts:884`、`dsh-session/src/types.ts:146-154` |
| `node:sqlite` 在本机可用（备选存储方案） | `node -v` = v24.21.0；`require('node:sqlite')` 的 `DatabaseSync` 为 function |
| 默认 preset 由 `selectedDefault ?? default` 决定 | `dsh-agent-preset-registry/src/index.ts:81`、`:219-220`；`dsh-api-session-controller/src/agent.ts:262-274`、`:230-234` |
| preset 在首轮前可换、之后 `agent-preset/locked` | `dsh-api-session-controller/src/agent.ts:384-402`、`:417-421`、`:424-427` |
| `createUserMessage` 不接受外部 id，需 `freezeMessage` 覆写 | `dsh-llm/src/message.ts:237-239`、`:246-253`、`:271-273` |
| `agent-message` 是既有的跨会话消息来源 | `dsh-tool-session-control/src/index.ts:124`；`dsh-llm/src/message.ts:128-140` |
| `boundContextSummary` 的 120 字符上限 | `dsh-llm/src/message.ts:147-158` |
| 按 agent 注入策略段（另一实现的复现） | `D:/tmp/superagent@8c32a9d` `src/app/sessions.ts:244-249` |
| `tools.restrict` 不能列局部工具 | `D:/tmp/superagent@8c32a9d` `src/app/sessions.ts:283-297` |
| 先存后做的副作用队列与 `Later` 语义 | `D:/tmp/superagent@8c32a9d` `src/app/effects.ts` 全文 |
| 幂等投递：固定 message id + 先扫历史 | `D:/tmp/superagent@8c32a9d` `src/app/delivery.ts` 全文 |
| 用 `source.kind` 区分人与系统 | `D:/tmp/superagent@8c32a9d` `src/executor/dsh.ts:477-512` |
| 会话 id 编码话题 | `D:/tmp/superagent@8c32a9d` `src/executor/dsh.ts:24-26` |
| 拒绝的领域概念（路由不参与 Correlation 等） | `D:/tmp/superagent@8c32a9d` `docs/001-domain.md` 的 Rejected concepts 表 |
| 授权与上下文分离的一条原则 | `D:/tmp/superagent@8c32a9d` `docs/002-authorization.md` |

第三轮补证新增的来源（服务可见性 / 工具可见性 / 创建路径 / 单库租约）：

| 结论 | 来源 |
| --- | --- |
| preset scope 读服务不带 inject 要求 | `cordis/src/reflect.ts:262-279`（含 `:322-323` 的 `??= Symbol(name)`）、`dsh-scope/src/index.ts:137-140`、`cordis/src/fiber.ts:270` |
| preset 行「在等 Host 服务」的判定方式 | `dsh-agent-preset-registry/src/mount.ts:118-123` |
| `Preset services require isolate realms` 的判据 | `dsh-agent-preset-registry/src/mount.ts:69-83`、`:204-216` |
| `isolate` 只生成新 service symbol | `cordis-plugin-loader/src/config/isolate.ts:98-101`、`cordis/src/reflect.ts:148-157` |
| `isolate` 的合法值只有 `true` 或字符串 | `cordis-plugin-loader/src/config/utils.ts:146-152` |
| 同名服务双 provide 的两种结局 | `cordis/src/reflect.ts:325-327`（抛错）；隔离时静默并存 |
| global 层工具对所有 scope 无条件可见 | `dsh-tools/src/index.ts:202`、`:214`；`dsh-scope/src/index.ts:98`、`dsh-scope/src/store.ts:169` |
| 全仓只有三处 `tools.restrict`，全是 deny | `dsh-timeline/src/delegation.ts:71`、`dsh-timeline/src/guidance.ts:170`、`dsh-subagent/src/child-agent.ts:223` |
| preset 内工具对该 preset 的 agent 可见、同名静默遮蔽 | `dsh-tools/src/index.ts:68-70`、`:199-226` |
| `sessionController.create` 与裸 `agents.create` 的合流点 | `dsh-api-session-controller/src/commands.ts:136`、`dsh-api-session-controller/src/agent.ts:443` |
| 只有 `sessionController` 做 mkdir + canonical + mount + header + attach | `dsh-api-session-controller/src/agent.ts:439`、`:447`、`:262-275`、`:448`、`dsh-api-session-controller/src/commands.ts:147-157` |
| 插件建会话的既有先例 | `dsh-schedule/src/runtime.ts:472-491` |
| `origin: 'subagent'` 会被侧栏过滤且拒绝 resume/prompt | `dsh-client-ui-workspace/src/client/tree.ts:241`、`dsh-api-session-controller/src/agent.ts:99-101`、`:306-308` |
| 未挂工作区的会话进入 Ungrouped 组但不隐藏 | `dsh-client-ui-workspace/src/client/tree.ts:358-371` |
| 只 mount 不写 header → 冷开回落默认 preset | `dsh-api-session-controller/src/agent.ts:483-487`、`:267`、`:309` |
| DSH 自己的 fork 无 provider 能力检查 | `dsh-api-session-controller/src/commands.ts:277-294`、`:304` |
| subagent 栈的两道 preset 闸门 | `dsh-tool-subagent/src/preset-selection.ts:53-57`、`dsh-subagent/src/index.ts:596-602` |
| 通用创建路径不含 `agentPresets` | `dsh-agent/src/index.ts:421-431`、`dsh-agent-loop/src/index.ts:725-753` |
| `presets.resolve` 只查存在性 | `dsh-agent-preset-registry/src/index.ts:219-226` |
| 装两次：apply 跑两次、模块状态共享、entry id 必须不同 | `cordis/src/registry.ts:330`、`cordis-plugin-loader/src/config/tree.ts:245`、`:194` |
| `filterSessions` 没有 preset 谓词 | `dsh-session-query/lib/types/types.d.ts:185-199`；`SessionRecord.header` 见 `:27-36` |
| 判 live 会话的 preset | `dsh-agent/src/index.ts:599`、`dsh-session/src/index.ts:323` |
| 权威 preset 判据（header 只是创建时值） | `dsh-agent-preset-registry/src/index.ts:88-90`、`src/session.ts:40` |
| triviumdb 独占写租约（同进程二次打开亦失败） | 本机实测 triviumdb 0.9.3：`TDB_DATABASE_LOCKED`；类型面 `triviumdb.d.ts:394`、`:564` |
| `sessionController` 丢弃 `AgentHandle`（只返回 `.agent`） | `dsh-api-session-controller/src/agent.ts:443-451`、`:314-318` |
| 自持 handle 的官方先例（ACP） | `dsh-acp/src/session.ts:123-131`、`:101-111`、`:141-149` |
| `presets.mount(ctx, id)` 签名 | `dsh-agent-preset-registry/src/index.ts:296` |
| dispose 只 detach 不删盘（两处 store 均为内存 Map） | `dsh-agent/src/index.ts:157-174`、`:521-535`；`dsh-session/src/index.ts:1013-1022`；`dsh-session-persistence/src/handle.ts:111-116`（该目录无 delete API） |
| teardown 实际步骤与 `dispose` 定义 | `dsh-agent-loop/src/index.ts:505-545`、`:549-556` |
| `resume` 是 dispose 之后的回来入口 | `dsh-agent/src/index.ts:206-216`、`:433-446` |
| 官方回收范式（cancel→whenIdle→flushFinalState→dispose） | `dsh-subagent/src/manager.ts:1077-1082`、`:1094`、`:1160-1170` |
| `turn/end` 是唯一每条路径必写的结束信号 | `dsh-agent-loop/src/agent.ts:415-421`、`:344-346`、`:352-355`、`:398-414`、`:391-395` |
| `TurnEndReasonMap` 七个 reason | `dsh-session/src/types.ts:216-248` |
| 不存在 `agent/turn-end` 事件 | `dsh-agent/src/runtime-types.ts:291-430` |
| `whenIdle` / `runMaintenance` 语义 | `dsh-agent-loop/src/agent.ts:154-156`、`:256-261`、`:201-222` |
| 官方结算三步 + 有排队时 `'wait'` | `dsh-subagent/src/manager.ts:986-1036`、`:1043-1053` |
| stopReason 映射 | `dsh-agent/src/consumed-work.ts:69-108`；`dsh-subagent/src/lifecycle.ts:81-107` |
| 「worker 在等人」的唯一结构化信号 | `dsh-user-questions/src/projection.ts:105-108`、`:248-289`、`:317-332` |
| `origin:'subagent'` 会话被拒问询 | `dsh-user-questions/src/index.ts:144-148` |
| 「等批准」无结构化信号 | `dsh-user-approval/src/index.ts:84-110` |
| `archiveSession` 只隐藏不删、不清账 | `dsh-workspace/src/index.ts:363-371`、`:373-417`；`dsh-agent/src/archive-admission.ts:26-37` |
| 官方无 LRU evict 先例（只有 reserve/release） | `dsh-subagent/src/index.ts:199`；`manager.ts:719`、`:803-811` |
