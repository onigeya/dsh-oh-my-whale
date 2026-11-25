# d7 — 单进程内嵌推理器的真实代价（研究子代理 embedded-cost 报告）

source: crates.io/npm registry API + GitHub 源码 + 论文原文 + napi.rs 官方文档
publisher: crates.io / npm / Springer / arXiv / napi.rs
pub_date: 2007–2026
accessed: 2026-11-25
confidence: high（版本/许可/下载量经 API 核验；部分性能数据为外推，已标注）
class: 工程落地约束

## 1. 候选推理器逐个评估

| 候选 | 语言/绑定 | 许可 | 单进程内嵌 Node | 成熟度 |
|---|---|---|---|---|
| ELK 0.6.0 | Java | Apache-2.0 | **否**（需 JVM） | 高（学术标杆，jar 187KB，2024-05-24） |
| HermiT 1.4.5.456 | Java | 无 license 字段 | **否** | 中（Maven 最新 2020-02-19，6 年未发版） |
| Openllet 2.6.5 | Java（Pellet 分支） | NOASSERTION | **否** | 低-中（2019-09-27 停） |
| JFact 5.0.3 | Java | LGPL | **否** | 低（2018-09-23） |
| **whelk-el 0.1.1** | Rust，MIT OR Apache-2.0 | 干净 | **是** | 低-中（2026-10 首发，179 下载，但已在 Obsidian 插件 WASM 生产运行） |
| whelk-rs | Rust，MIT，未发 crates.io | MIT | 是 | 低（★24，实验性） |
| **reasonable 0.5.0-a2** | Rust + pyo3，BSD-3-Clause | BSD-3 | **是** | 中（5 年，147,661 下载，支持增量物化） |
| **rustdl 0.4.44** | Rust，Apache-2.0 OR MIT（静态链接 LGPL 的 horned-owl） | 有法务注意 | **是** | **低**（2026-09-03 首发，313 下载） |
| horned-owl 6.0.0 | Rust，LGPL-3.0 | LGPL | 是（解析器非推理器） | 高（★113，比 OWL API 快 20–40×） |
| rdf-reasoner-konclude 0.9.7 | JS+WASM（Konclude C++ 编译） | LGPL-3.0-or-later | **是**（零构建） | 中（2026-05 起 32 版，7.7MB） |
| hylar 10.0.4 | JS | — | 是 | **死**（2021-03-15 最后发布） |
| ontologies（Python） | — | — | — | **PyPI 404，查不到** |

### JVM 四者的真实代价（不是 jar 体积——jar 都 <2MB）

1. **无法真同进程**：唯一路径 node-java JNI（npm `java` v0.19.0，★1890，**210 open issues**，README 还是 node-gyp + python2 时代），把整个 JVM 拖进 Node，崩溃/内存双双不可隔离。
2. JRE 分发 40–80MB 或要求用户装 JDK【推断】。
3. JVM 启动 + 类加载不在任何 benchmark 里。
4. Maven 最新版分别停在 2020/2019/2018 —— **事实停更**。

Konclude 官方 benchmark 原文：HermiT 在 GALEN 上比 Konclude **慢约 20×**，Roberts family 直接 `OutOfMemoryError: Java heap space` 超时。
来源 https://github.com/ThHanke/rdf-reasoner-konclude/blob/main/docs/benchmark.md 、https://link.springer.com/article/10.1007/s10817-017-9406-8

### JS 侧最重要的发现：原生 OWL 推理器不存在

- `owlreasoner` / `owl2-reasoner` npm **404**
- `jowl` 是 JSON CLI 撞名
- `hylar` 已停 4 年（2021-03-15）
- `eyereasoner` 是 N3 规则引擎，非 OWL DL
- `sparql-engine` 停滞

**唯一可用的是 `rdf-reasoner-konclude`**：把 Konclude 编译成 WASM，API 覆盖 classify / materialize / checkConsistency / isEntailed / whatIf / **explain / explainInconsistency / repair / assessEdit / weaken** / validate —— 几乎是一个完整的证明 + 修复工具箱，与召回第 ②③④ 步高度重合。

其实测代价：
- init 一次性 **840–1324ms**
- WASM 相对原生 C++ **1.8–3.9×** 慢，但比 HermiT(JVM) 快约 4×（GALEN：Konclude 322ms / WASM 1126ms / HermiT 4750ms）
- 内容不变时指纹缓存让后续调用毫秒级（59ms），**内容一变全量重跑，无增量**
- 坑：必须 `terminate()` 否则线程泄漏；同一实例并发被串行化；**不一致本体默认静默返回空**（危险默认值）

## 2. napi-rs 嵌 Rust 的做法与坑（本项目已可行——triviumdb 就是 Rust + napi）

**崩溃隔离是红线**，官方原文：
> "An uncaught panic in a synchronous generated callback **can terminate the process**"
> "panic = 'abort' cannot be caught"
→ `catch_unwind` 也救不了 abort、救不了 detach 线程上的 panic。段错误/OOM 会带走整个 DSH 进程。只能靠代码纪律：保持 unwind、入口加 catch_unwind、FFI 边界零 unwrap、输入先做结构校验（公理数/嵌套深度/datatype 白名单上限）。

**超时无法从外部打断**，官方原文：
> "If AsyncTask has already started, Node-API **cannot cancel its compute callback**"
→ AbortSignal 只能取消未启动任务。**deadline 必须由推理器内部检查**（正是 rustdl `--pair-timeout-ms` / `--global-timeout-ms` 存在的理由）。绝不能用同步 `#[napi] fn`（阻塞事件循环），要用 `#[napi] async fn` 或 `AsyncTask`。

**内存/GC**：class 走 `napi_wrap`，「Cleanup is tied to the Rust wrapper's Drop, not to JavaScript GC」；owned Buffer 的 `Send+Sync` 不同步字节访问（JS 与 Rust 同碰 = UB）→ 公理缓冲区必须 Rust 侧持有 `Vec<u8>`，JS 只拿 handle。

**关键设计模式**：`External::new(value)` 造不透明 handle 交给 JS 再传回 —— 正是「预分类好的 TBox reasoning state 挂 JS 侧、每次只传新增 ABox」的标准做法。

版本：napi 3.16.3 / napi-derive 3.7.2，MSRV 1.88.0，`crate-type=["cdylib"]`，**不需要 node-gyp**。

## 3. 性能数据

**分类**（whelk 论文 TGDK 2.2.7，M2 Max/16GB heap）：

| 本体 | 规模 | ELK 0.4.3 | ELK 0.6.0 | whelk |
|---|---|---|---|---|
| nci-thesaurus | 188,034 类 / 258,241 公理 | **2.37s** | 23.20s | 24.16s |
| uberon-go-cl-ro | 70,057 类 / 108,610 公理 | **2.33s** | 99.73s | 46.81s |
| UNIV-BENCH-OWL2EL | 131 类 / 398 公理 | 0.01s | 0.03s | 0.10s |

**两个反直觉事实**：
1. **ELK 0.6.0 比 0.4.3 慢 10–40×**（作者称待查）——版本升级不等于更快。
2. **whelk 分类慢 10–20× 但 DL 查询快约 1000×**（nci：whelk 2306 q/s 顺序、13679 q/s 8 线程；ELK 51/47 q/s）。Ubergraph 实战（>500 万公理）：Whelk 分类 40 分钟 vs ELK 99 秒，但 relation-graph 的 9000 万次查询 ELK 要 400 多天、Whelk 8 小时。

**→ 选型判据不是「谁快」，是「你的负载是分类密集还是查询密集」。** 召回热路径是查询密集 → 倾向 whelk 类。

**reasonable RL 物化吞吐**：约 **1500 triples/s**（18k triples ≈ 12s；Brick 14.8k triples 18.66s）。比 Allegro 快 7×、比 OWLRL 快 38×，但绝对量级**不能进 250ms 热路径**。

**生态数字**（Abicht 2023，whelk 论文 §6 引用）：「only **25 of 73** tested OWL reasoner implementations are usable and actively maintained」。

## 4. 「每次写 ABox 都重分类」这个前提本身要纠正

**whelk 论文 §3.1 原文**：reasoner state「can be extended with additional asserted axioms... **Any references to the earlier reasoning state are still valid**」，且扩展只支持 class(TBox) 与 individual(ABox) 公理；**只有 Rbox 变更（新增属性公理）与 SWRL 规则变更强制全量重分类**——原文「Adding new property (Rbox) axioms or SWRL rules after the initial classification is complete requires a complete reclassification (a limitation shared with ELK)」。

**ELK 增量论文 Table 2 实测**（i5-2520M/4GB heap）：
- SNOMED CT（296,529 公理）全量 **10,133ms**，单条变更 **232ms（44× 加速）**，100+100 **1,376ms**
- GALEN（36,547 公理）全量 648ms，1+1 **39ms（16.6×）**

分阶段（SNOMED 100+100）：Deletion 564,004 推理 / 3,577 broken 分区 / 662ms → Repair 138,633 / 56ms → Addition 414,255 / 545ms。
https://link.springer.com/chapter/10.1007/978-3-642-41335-3_15

**ABox 增速**（whelk 论文）：ELK 0.4.3 **121 abox/s** 顺序；whelk 84/s 顺序、286/s（4 线程）、**498/s（8 线程）**，单 ABox 平均 43 条公理 → 约 12ms/个。

**→ 换算到本项目**：TBox 是 398 公理量级 → **全量分类 10–100ms**，甚至可以直接重算；单条 ABox 断言是毫秒级。真正要预算的是**每次召回发多少个 DL 查询**（whelk 1400–2300 q/s 单线程，250ms 能跑完）。

**增量分类谁能用**：ELK（有，高成熟，但 JVM 排除）；reasonable（有，规则级增量，有删除则全量重物化，中成熟）；whelk/whelk-rs/whelk-el（ABox 增量，Rbox 不行，低-中）；Konclude/rustdl/HermiT（**无增量**）。

**没有一个 Rust 实现同时具备「DL 分类 + 完整增量」→ 所以 schema 铁律比任何增量算法都重要。**

## 5. 降级路径（注意 triviumdb 没有 SPARQL，「直查」要落到 TQL）

| 层 | 做法 | 推理成本 |
|---|---|---|
| **L0** | 预计算闭包 | 0 推理，**250ms 成立的唯一方式** |
| **L1** | 索引直查（单步 rdf:type + 闭包命中） | O(1) bitmap/composite |
| **L2** | 有界局部 EL 饱和（deadline 100–120ms、pair timeout 5ms） | 触界标 `incomplete`，走 sound under-approximation，**绝不假报** |
| **L3** | 局部子图 RL 物化 | 按 1500 triples/s，200ms 覆盖约 300 三元组；全库物化必须离线 |
| **L4** | 只做子类闭包 + 直查 | 未命中一律标 `unknown` 而非 `false` |

**L4 的 unknown 集合就是步骤 ③④ 的信息缺口，不是错误。** 全量重分类永远不是热路径降级项。

## 6. 体积与首加载

**实测锚点**：`require('triviumdb')`（win32 .node **14.9MB**）冷加载 **5.3ms**、RSS 增量 **0.9MB**（mmap 惰性）→ **napi 模块加载本身可忽略**。

一个推理器 `.node` 估 **3–8MB/平台**（依据：whelk-el 源码 37KB、reasonable 49KB、horned-owl 457KB + triviumdb 15MB 锚点），5 平台 +15–40MB，相对 triviumdb 的 80MB **可忽略**。真正要预算的是**启动期 TBox 分类 10–100ms**。

对照：WASM-Konclude 7.7MB + init **840–1324ms**。

## 7. 推荐结论（给 schema 设计的硬约束）

1. **双层 Rust 栈 + napi**：TBox 分类器 = **whelk-el**（MIT/Apache、37KB、no_std 友好、已在 Obsidian 插件 WASM 生产运行；选它不选 ELK 是因为召回热路径是**查询密集**，它查询快 2 个数量级且不可变 state 天然支持「预分类一次、并发跑多 ABox」）；RL 物化器 = **reasonable**（BSD-3、5 年、147k 下载、有增量）；证明树 = **rustdl 作参考实现与对拍基准，不作唯一依赖**（唯一现成的 `prove` 逐步骤证明树 + `justify --laconic` + `repair` + sound 有界运行；**注意它静态链接 LGPL 的 horned-owl**）。
2. **schema 铁律：TBox 与 Rbox 收敛，运行时只增 ABox。** 不要为每个动词新造 ObjectProperty——每加一个属性公理就全量重分类。固定一小撮谓词（partOf/causes/prefers/about/assertedBy），其余用概念表达式或 payload 编码。TBox 控制在千级公理内（对应 10–100ms 全量分类）。
3. **证明能力必须落到字段**：每条三元组/边带 `origin ∈ {asserted,derived,external}`、`rule_id`、`justification_id`、`depth`。**没有这四列，推论与原始断言混在一起，步骤 ⑤ 的证明链就断，③④ 的部分子树也无从组装。这是最容易被忽略、代价最高的设计债。**
4. **超时在 Rust 侧自研**（napi 无法取消已启动的 compute），触界返回「不完整」标记而非错误。
5. **Abduction（步骤 ③）没有现成实现**：所有引擎给的是 justification/repair（解释并删除已有不一致），不是「补最小 delta 让推论成立」。必须自研；rustdl `justify --laconic`、Konclude WASM `explain` / `whatIf` / `assessEdit` 可作子程序语义参考。

## 8. 诚实标注：查不到的

- 「ontologies（Python）」PyPI **404 不存在**；`mowl` 也 404。crates.io 同名 crate 是 2020 年 RDF 工具，非推理器。
- **whelk-el 无任何公开 benchmark**（179 下载、2026-10 首发）；「10–100ms」是从 whelk/ELK 在 398 公理本体上的 0.01–0.10s **外推**，落地前必须自量。
- **JVM 启动时间**未实测（本机无 java）。
- whelk-el / rustdl 常驻 RSS 无实测无公开数据；报告 §6.3 的 20–80MB/万类 是估算。
- rustdl 的 GitHub star/issue 数未取到（GitHub API 403 rate limit）。
- **URL 修正**：`https://crates.io/crates/rustdl` 与 `/crates/whelk-el` 裸页均 **404**，应引用 `https://crates.io/api/v1/crates/rustdl`、`.../whelk-el`；`www.npmjs.com` 页面 403 反爬，用 registry.npmjs.org；`doi.org` 解析报错，用 link.springer.com 直链。

## 与本项目新方向的关系（用户 G5 分层决定后）

这份报告原本回答「OWL 2 能不能塞进单进程 Node」。用户随后把 OWL 2 降级为**跨边界语义契约层**，只覆盖少数核心概念，由此产生的直接影响：

1. **重型 OWL 推理器基本不必上**：契约层的规模是「少数核心概念」，不是整层情景记忆。可能只需 RL 物化（reasonable ~1500 triples/s，小规模可接受）+ SHACL 校验，甚至只要一致性检查。
2. **whelk-el vs reasonable 的取舍反而变简单**：既然 OWL 不承担日常推理，就不需要「查询快 1000×」的分类器，也就没有理由引入 whelk-el（2026-10 首发、179 下载、无 benchmark）。**reasonable 的成熟度优势压倒性能优势。**
3. **`rdf-reasoner-konclude` 的价值上升**：它的 explain / whatIf / assessEdit / weaken 正好是边界契约层的治理动作；840–1324ms 的 init 代价在「不是每次召回都跑」的前提下可以接受（一次性或按需）。但它 LGPL-3.0-or-later 的许可需要法务确认。
4. **Rbox 铁律仍然成立且更重要**：既然 OWL 只做契约，那更要严格控制属性数量——每加一个 ObjectProperty 就全量重分类的代价，在「契约层本该稳定」的语境下是可接受但必须显式管理的。
5. **proof 四列（origin/rule_id/justification_id/depth）是跨两层的连接件**：Datalog 内核与 OWL 契约层要能拼出同一条证明链，靠的就是这四列共用一套取值。**这是双引擎能拼起来的技术前提。**
