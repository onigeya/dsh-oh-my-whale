# 进程内 Datalog 引擎选型研究：为 DSH 单进程 Node 内嵌推理层取证

研究日期 2026-11-25 ｜ 全部版本/许可/下载量/star 为当日现查 ｜ 所有性能数字为本机实测（Windows，Node 内嵌，脚本见文末附录）

**取证的三种口径，全文严格区分：**
- `class=规范`：官方文档 / W3C / 教科书原文，逐字引用。
- `class=论文`：论文原文，逐字引用。
- `class=工程实测`：我在本机跑出的数字或现查的 registry/GitHub API 数据。
- `class=推断`：我的推论，不是任何来源的说法。

---

## 0. 结论先行

**推荐方案：分层混用 + 只在查询切片上跑 Datalog。**

1. **事实不进 Datalog 引擎的长期内存。** 10 万条基事实留在 triviumdb（已有二级索引 + 图边）。Datalog 引擎只在其上跑每次召回相关的那几百条切片。
2. **引擎选 @suss/datalog 0.40.1**（Apache-2.0、纯 TS、零依赖、无 Node 内建、无 eval）。它是唯一同时具备 semi-naive + 分层否定 + 带 absence 叶子的 provenance + 分层强度代数 + 行数熔断，且能在 Node 进程内直接 import 的实现。
3. **必须绕开它三个实测缺陷**：(a) retract 后派生事实不重算，唯一正确姿势是 retract(base) → retractAll(每个派生 relation) → evaluate()；(b) 不开 witnesses 时 proofOf 会把派生事实谎报成 base fact；(c) clearRelations 会静默吞掉后续增量。三条都是静默错误，必须写进代码约定 + 测试（见 §5 方案 A 的三条约定）。
4. **聚合不要放进 Datalog 层。** 我在 @dxos 上实测到聚合穿层导致整层重算，8000 条事实一次加载 30845ms；这是 stratified-aggregate 语义的固有代价（Zaniolo et al. 论文原文承认 can be very inefficient or even non-terminating）。聚合在 triviumdb 侧或应用层用一次扫描做。
5. **明确排除**：Cozo（实测有静默返回 0 行的正确性缺陷）、Soufflé（无 Node 绑定）、Nemo（无 Node 绑定 + 无增量插入 API）、DDlog（已归档）、datafrog（无规则语言）、ascent/crepe（规则在编译期固定）、SQLite/DuckDB 递归 CTE（不支持相互递归、无 fixpoint 语义）。

**如果必须跑全量 10 万条物化**：suss 的一次完整闭包是 131.9ms（本机），确实能塞进 250ms，但只剩一半余量，且修正循环再吃 60.4ms。这条路可行但不该是默认路径。

---

## 1. 候选引擎清单与硬指标

### 1.1 总表（全部现查，accessed=2026-11-25）

| 引擎 | 语言/绑定 | 许可 | 最新版本 / 发布日 | 规模信号 | 分层否定 | 聚合 | 增量维护 | provenance | Node 进程内可行 |
|---|---|---|---|---|---|---|---|---|---|
| **Soufflé** | C++，可生成可嵌入 C++（-g） | UPL-1.0 | tag **2.5** / **2025-03-24** | stars **1197**，未归档，pushed 2026-10-31 | 是 | 是（min/max/sum/count） | 是（semi-naive，编译期生成） | 是（-t explain/explore，含 explainnegation） | 否（无 WASM/Node 绑定，仓库树 grep 命中 0） |
| **Nemo** | Rust + wasm + python 绑定 | Apache-2.0（GitHub）/ APACHE-2.0 OR MIT（Cargo.toml） | **v0.10.1** / **2026-08-01**；workspace **0.10.2-dev** | stars **317**，未归档，pushed 2026-11-19 | 是（~，全称读法） | 是，但一条规则最多一个 | 弱（仅 whole-program reason()） | 未见宣称 | 弱（nemo-wasm 自述 experimental，且无逐条插入 API） |
| **datafrog** | Rust 库 | Apache-2.0 / MIT | **2.0.1** / **2019-01-02** | stars **913**，下载 **5,305,046**（近 90 天 508,826） | 否 | 否 | 是（纯 delta join） | 否 | 弱（需自己写 napi/wasm 包装） |
| **ascent** | Rust proc-macro | MIT | **0.8.1** / **2026-08-29** | stars **601**，下载 879,430 | 是 | 弱（用 lattice 表达） | 是（semi-naive + lattice fixpoint） | 否 | 弱（有 wasm-tests/，但规则编译期固定） |
| **crepe** | Rust proc-macro | Apache-2.0 | **0.2.0** / **2025-12-14** | stars **537**，下载 864,629 | 是 | 否 | 是（semi-naive） | 否 | 否（规则编译期固定） |
| **DDlog** | Rust + Java 前端 | MIT | **已归档**，last commit **2022-11-29** | stars **1501** | 是 | 是 | 是（differential dataflow） | 否 | 否，且需 JVM 前端 |
| **LogicBlox** | 商业平台 | 商业 | **没查到**（官网在线，about/products 页 SSL 握手失败） | — | 是（LogiQL） | 是 | 是（incremental，自述） | 没查到 | 否（JVM/.NET 系，推断） |
| **Cozo / cozo-node** | Rust + napi-rs 原生 | MPL-2.0（cozo-node MIT） | cozo-node **0.7.6** / **2023-12-11** | stars **4152**（主仓），下载 2,419/月；实质停更（主仓 last commit 2024-12-04） | 是（硬拒非分层） | 是 | 否（撤回靠重算） | 否（::explain 是执行计划） | 是，本机实测加载成功，但有致命 bug（§1.4） |
| **@suss/datalog** | 纯 TS | **Apache-2.0** | **0.40.1** / **2026-11-22** | 下载 **4,401/月**，78 versions | 是（硬拒 unstratifiable） | **否** | 是（semi-naive 续跑） | **是（含 absence 叶子）** | **是，首选** |
| **@dxos/datalog** | 纯 TS | **FSL-1.1-Apache-2.0**（非 OSI） | **0.17.0** / **2026-11-20** | 下载 **2,259/月**，12 versions | 是（硬拒） | 是（count/min/max/sum） | 是（层内 semi-naive + 变更层重算） | 弱（只存一条推导，否定/聚合不给 premises） | 是，实测可跑 |
| **datascript** | ClojureScript/JS | registry 无 license 字段 | **1.8.1** / **2026-08-15** | 下载 **31,024/月**，119 versions | 有限 | 有限 | 否 | 否 | 弱（需 CLJS 编译链） |
| **minigraf** | Rust + WASI/napi | MIT OR Apache-2.0 | **2.0.12** / **2026-11-18** | stars **230**，956/月，单人维护 | 未宣称 | 未宣称 | 否 | 否（README grep provenance = 0 命中） | 弱（WASI WASM，自述 1M 事实点查 4.3-4.5s） |
| **SQLite WITH RECURSIVE** | Node 内建 node:sqlite | Public Domain | 随 Node | — | 仅非递归外部表 | **递归项禁止聚合/窗口** | 否 | 否 | 是 |
| **DuckDB 递归 CTE** | C++ 内嵌 | MIT | — | — | 否 | 受限 | 否 | 否 | 弱（需原生模块） |

### 1.2 逐条 claim（承重项）

| # | claim | source | publisher | pub_date | accessed | confidence | class |
|---|---|---|---|---|---|---|---|
| C1 | Soufflé 最新 release tag 是 2.5，2025-03-24 发布；仓库未归档，最后 push 2026-10-31；许可 UPL-1.0；stars 1197 | https://api.github.com/repos/souffle-lang/souffle 与 /releases | GitHub | 2025-03-24（2.5） | 2026-11-25 | high | 工程实测 |
| C2 | Soufflé 仓库树中无任何 wasm/emscripten/node-addon/napi 路径（grep 命中 0）；嵌入方式官方只给 souffle -g 生成 C++ 再链接 | https://souffle-lang.github.io/interface 与 GitHub trees API | Soufflé 官方文档 / GitHub | 站点页脚 Site last generated: Jul 12, 2026 | 2026-11-25 | high | 规范 |
| C3 | Soufflé 的 magic-set 只实现了正程序：Only the algorithm for positive datalog has been implemented ... Relations with negations in their body or the body of a dependency will not be transformed | https://souffle-lang.github.io/magicset | Soufflé 官方文档 | 同上 | 2026-11-25 | high | 规范 |
| C4 | Soufflé provenance 是最小高度证明树，且有 explainnegation（解释某元组为什么不存在） | https://souffle-lang.github.io/provenance | Soufflé 官方文档 | 同上 | 2026-11-25 | high | 规范 |
| C5 | Soufflé 有 subsumption（被更一般元组取代即删除）与 choice-domain（函数依赖约束）用于表达非单调选择 | https://souffle-lang.github.io/subsumption 与 /choice | Soufflé 官方文档 | 同上 | 2026-11-25 | high | 规范 |
| C6 | Soufflé I/O 支持 SQLite 作为外部数据库，但仅 I/O 流、非求值存储（ReadStreamSQLite.h / WriteStreamSQLite.h） | https://souffle-lang.github.io/directives 与 GitHub trees | Soufflé 官方文档 / GitHub | 同上 | 2026-11-25 | high | 规范 |
| C7 | Nemo 最新 release v0.10.1（2026-08-01），workspace version 0.10.2-dev，Cargo.toml 写 APACHE-2.0 OR MIT；nemo/src/lib.rs 首行 doc 注释为 A fast in-memory rule engine | https://api.github.com/repos/knowsys/nemo/releases 与 https://raw.githubusercontent.com/knowsys/nemo/main/Cargo.toml | GitHub | 2026-08-01 | 2026-11-25 | high | 工程实测 |
| C8 | Nemo 的 WASM 绑定存在但自称实验性：These bindings are currently in an experimental state and subject to change；API 只有 engine.reason() 全量物化 + 取结果，无逐条插入事实的接口 | https://raw.githubusercontent.com/knowsys/nemo/main/nemo-wasm/README.md | GitHub（Nemo 仓库） | main 分支，未标注 | 2026-11-25 | high | 规范 |
| C9 | Nemo 支持 ~ 否定但要求不分层即拒：requires that there are no recursive dependency cycles that involve negation (this is called stratification)；否定是全称读法（for every possible date the person did not die） | http://knowsys.github.io/nemo-doc/intro/tour/ | Nemo 官方文档 | 未标注 | 2026-11-25 | high | 规范 |
| C10 | Nemo 聚合一条规则最多一个，只出现在 head，且只对 distinct 值计算 | http://knowsys.github.io/nemo-doc/reference/aggregates/ | Nemo 官方文档 | 未标注 | 2026-11-25 | high | 规范 |
| C11 | Nemo 的 existential rules 会 increase the theoretical computational power of Datalog significantly ... can capture all recursively enumerable computations，即开启即失去终止性保证 | http://knowsys.github.io/nemo-doc/intro/tour/ | Nemo 官方文档 | 未标注 | 2026-11-25 | high | 规范 |
| C12 | DDlog 仓库 archived=true，最后 commit 2022-11-29T18:00:48Z（fix(readme): update link to differential-dataflow），stars 1501，MIT | https://api.github.com/repos/vmware-archive/differential-datalog | GitHub | 2022-11-29 | 2026-11-25 | high | 工程实测 |
| C13 | datafrog 最新版本 2.0.1 发布于 2019-01-02，之后 7 年无新版；2026-10-28 的最新 commit 只是 CI 权限维护（restrict-workflow-permissions），不是引擎功能 | https://crates.io/api/v1/crates/datafrog 与 GitHub commits API | crates.io / GitHub | 2019-01-02 / 2026-10-28 | 2026-11-25 | high | 工程实测 |
| C14 | datafrog README：Datafrog has no runtime, and relies on you to build and repeatedly apply the update rules。它是 delta join 库，没有规则语言、没有否定、没有聚合、没有 provenance | https://raw.githubusercontent.com/rust-lang/datafrog/master/README.md | GitHub | 未标注 | 2026-11-25 | high | 规范 |
| C15 | ascent 与 crepe 都是 proc-macro：规则在编译期展开为 Rust 代码，规则集不是运行时数据，不能用于运行时动态规则 | https://raw.githubusercontent.com/s-arash/ascent/master/README.MD 与 https://raw.githubusercontent.com/ekzhang/crepe/master/README.md | GitHub | ascent 2026-08-29 / crepe 2025-12-14 | 2026-11-25 | high | 规范 + 推断 |
| C16 | LogicBlox 是 commercial, declarative, incremental logic programming language and deductive database，LogiQL 扩展了 stratified negation、aggregation、模块系统 | https://en.wikipedia.org/wiki/LogicBlox（revision 2026-03-24T07:52:52Z） | Wikipedia | 2026-03-24（该版本） | 2026-11-25 | med（二手） | 工程实测 |
| C17 | LogicBlox 官网首页仍在线（营销文案）；https://logicblox.com/about 与 /products SSL 握手失败，未取到产品状态/版本/停运公告 | http://www.logicblox.com/ | LogicBlox | 未标注 | 2026-11-25 | high（关于取不到这件事） | 工程实测 |

### 1.3 Node/JS 侧的真实选项（这是本次选型的重心）

查过的名字与结果（逐个现查，不凭印象）：

| npm 包名 | 真实情况 |
|---|---|
| datalog | 是无关的日志库（mbunity 2.1.1，2021-03-02） |
| datalogjs | 1.0.4，2018-12-10，ISC，无 repo，description 为 Description will be added soon，死包 |
| @datalog/core, datalog-engine, datalog-lite, @logica/core, ddlog-wasm, nemo-js | 全部 404 |
| souffle, logica | 无关包 |
| **@suss/datalog** | **0.40.1 / 2026-11-22 / Apache-2.0 / 4,401 下载月 / 78 版本** |
| **@dxos/datalog** | **0.17.0 / 2026-11-20 / FSL-1.1-Apache-2.0 / 2,259 下载月 / 12 版本** |
| datascript | 1.8.1 / 2026-08-15 / registry 无 license 字段 / 31,024 下载月 / ClojureScript |
| datahike | 0.8.1947 / 2026-11-25 / EPL-1.0 / 6,033 下载月 / Clojure |
| minigraf | 2.0.12 / 2026-11-18 / MIT OR Apache-2.0 / 956 下载月 / 单人维护 |
| datalogia | 0.9.2 / 2024-10-31 / 176 下载月 |
| @thi.ng/oquery | 2.3.70 / 2026-08-25 / Apache-2.0 / 789 下载月 / 自述 Datalog-inspired，非完整 Datalog |
| datalog-ts | 0.6.6 / 2024-01-09 / MIT / 98 下载月 |

**读法**：npm 上真正在维护、能当引擎用的只有 @suss/datalog 和 @dxos/datalog 两个。这是整个选型的收窄点——问题不是哪个 Rust 引擎最好，而是这两个 TS 实现里哪个能被信任。

### 1.4 Cozo：唯一原生 Node 嵌入，但有静默正确性缺陷（决定性排除证据）

Cozo 通过 napi-rs 提供 cozo-node。我在本机成功装上并跑通（npm install script 被拦，改为直接下载 GitHub release 的 6-win32-x64.tar.gz 9568642 字节，手工放置 native/6/cozo_node_prebuilt.node 后 import 成功）。能力上它其实很强：分层否定可用、非分层硬拒 Query is unstratifiable、聚合穿递归硬拒、撤回语义正确。

**但**（这是本次研究最需要被上游看到的发现）：

| 场景（10 万条 obs，Q1 = ?[id,val] := *obs{id, ent: "e0", slot, val}） | 结果 |
|---|---|
| 从未建索引 | **50 行** ✔ |
| 先灌数据、再 ::index create obs:by_ent {ent} | **50 行** ✔ |
| **先建索引、再灌数据** | **0 行** ✘ 静默、无报错 |

- 100 条规模即可复现：entPlusMore=0（无索引时是 2）；re-put 数据也修不好（afterRePut=0）。
- 触发条件 = 索引早于数据 + 查询在索引列之外还绑定其它列。
- 绕道可用（*obs:by_ent{ent:"e0", id}, *obs{id, val} → 50 行 ✔），但这要求调用方知道这个 bug 才能写对查询。

**这是静默返回错误答案，不是崩溃**，而且正中 DSH 高频写入 + 二级索引的用法。Cozo 主仓 2024-12 后停更、cozo-lib-nodejs 2023-12 后停更，无人会修。**归因纪律：我没有去 cozo 仓库确认这是否为已登记 issue，只能写实测复现，未确认为已知 issue。**

其他 Cozo 实测（作为参照）：递归 10 万链传递闭包 4171.5ms（比 suss 慢约两个数量级）；无索引点查 10 万条 98.7ms；::explain 返回的是执行算子树（unify / load_stored / stored_prefix_join），与这条结论依据哪些事实无关，不是 provenance。

---

## 2. 表达力边界（最重要的一节）

### 2.1 分层否定：准确定义与判定条件

一手来源：Abiteboul, Hull, Vianu《Foundations of Databases》Chapter 15 Negation in Datalog（PDF 取自 http://webdam.inria.fr/Alice/pdfs/Chapter-15.pdf，本机已下载 373362 字节并抽取正文）。

**定义（原文）**：The precedence graph G_P of P is the labeled graph whose nodes are the idb relations of P. Its edges are the following: If B1,...,Bn is a rule in P (head <- body), then A->Bi is an edge in G_P with label + (called a positive edge); If not B1,...,Bn is a rule, then A->Bi is an edge with label - (called a negative edge).

**判定条件（Proposition 15.2.7，原文）**：A datalog program P is stratifiable **iff** its precedence graph G_P has **no cycle containing a negative edge**.

**为什么充分（Lemma 15.2.6，原文）**：Let P be a program with stratification σ. If there is a path from B to A in G_P, then σ(B) >= σ(A); and if there is a path from B to A containing some negative edge, then σ(B) > σ(A). 含负边的环要求 σ(A) > σ(A)，矛盾；无负环时 SCC 缩点后拓扑排序即得分层。

**分层选择不影响答案（Theorem 15.2.10，原文）**：Let P be a stratifiable datalog program. All stratifications of P are **equivalent**. 工程含义：分层算法怎么写都行，语义唯一。

**工程上这条判定的落地形式**（四个真实实现，我逐个核实）：

| 实现 | 表达 | 原文/实测 |
|---|---|---|
| Soufflé | 文档措辞 | Such circular definitions are forbidden. Technically, rules involving negation must be stratifiable.（souffle-lang.github.io/rules） |
| Cozo | 运行时错误 | 实测 a[x] := *node{x}, not b[x]. b[x] := *node{x}, not a[x]. → **Query is unstratifiable** |
| @suss/datalog | 静态检查码 unstratifiable | 实测负环 → Error: rules are not stratifiable: negation cycle through "cc" |
| @dxos/datalog | 静态检查码 unstratifiable | 实测负环 → unstratifiable: negation or aggregation through recursion among: a, c |

→ **四个独立实现用的是同一个判定**（否定穿递归即拒）。这不是巧合，是上面那个定理的直接后果。

**顺带一条工程约束（Soufflé 原文）**：Negated literals do not bind variables. For example, A(x,y) :- R(x), !S(y). is not valid as the set of values that y can take is not clear. → 与 suss 的 unsafe 诊断码、Cozo 的 negation cannot introduce new bindings 是同一条 safe rule。**写规则时所有否定下的变量都必须被正文字绑定。**

### 2.2 非分层程序（有负环）的标准处理

Alice 书给出两条路，**原文**：The first, called stratified, involves a syntactic restriction on programs but provides a semantics that is natural and relatively easy to understand. The second, called well founded, requires no syntactic restriction on programs, but the meaning associated with some programs is expressed using a 3-valued logic. (In this logic, facts are true, false, or unknown.)

**表达力定位（原文）**：With respect to expressive power, well-founded semantics is equivalent to the fixpoint queries, whereas the stratified semantics is strictly weaker.

**两条路的一致性（原文）**：Furthermore, well-founded and stratified semantics agree on stratified datalog programs.

WFS 规范出处：**DOI 10.1145/116825.116838** ｜ The well-founded semantics for general logic programs ｜ Van Gelder, Ross, Schlipf ｜ Journal of the ACM vol 38 ｜ 1991-07 ｜ pp 619-649（doi.org content negotiation 现查）。

**Alice 书里的 WFS 实例（我抽出的正文）**：非分层程序 win 表示存在一个可达状态使对手失败，在 3 值模型下给出 true: win(a), win(b) / false: win(c), win(d) / unknown: win(e), win(f), win(g)。→ **WFS 不拒绝程序，它把无解的部分标成 unknown。**

**四种处理的对比**（除「出处」列外，代价列是我的推断）：

| 处理 | 出处/实现 | 代价 |
|---|---|---|
| 语法拒绝（stratified semantics） | Soufflé / Cozo / suss / @dxos 全选这条 | 表达力严格弱于 fixpoint queries；但语义唯一、实现简单、可静态检查 |
| WFS（3 值） | Van Gelder et al. 1991；Alice ch15 | 表达力最强（= fixpoint queries）；但要传 3 值、要额外求值算法、答案对调用方更复杂 |
| 稳定模型 / ASP | — | 可能多解甚至无解，不适合必须给出唯一答案的召回管路（推断） |
| 不检查、当没看见 | — | 用户写错规则时静默错，最差 |

**对 DSH 的判断**：选语法拒绝。信念被修正不需要负环来表达——它需要的是事实被撤回 + 重算，那是 §2.5 的维护问题，不是语义问题。把负环留着当硬错误，等于免费得到一个规则静态检查器。

### 2.3 聚合：为什么破坏单调性，标准解法与代价

一手来源：**arXiv:1707.05681** Fixpoint Semantics and Optimization of Recursive Datalog Programs with Aggregates（Zaniolo, Yang, Interlandi, Das, Shkapsky, Condie；ICLP 2017 / TPLP；本机已下载 PDF 342679 字节并抽取）。

**破坏的到底是什么（原文）**：For positive Datalog programs, i.e., those without negation or aggregates, T_P(I) is a monotonic continuous mapping in the lattice of set-containment ... a unique minimal solution always exists and it is known as the least-fixpoint lfp(T_P). → 加聚合后 T_P 不再是单调映射，最小不动点不再唯一存在。

**机制（原文）**：Expressing is_min via negation reveals the non-monotonic nature of extrema constraints, whereby their usage in the definition of recursive predicates can compromise the declarative fixpoint semantics of the program.

**标准解法一：stratification over aggregates（原文）**：Stratification, where each predicate in the programs must belong to strata that are above those of their negated goals, can be used to avoid the semantic problems caused by using aggregates in recursion ... our program is assured to have a perfect-model semantics (Przymusinski 1988). The perfect model of a stratified program is a minimal model which is computed using an iterated fixpoint computation, starting at the bottom stratum and moving up to higher strata.

**而这个解法的代价，论文自己写得很直白（原文）**：This approach, used by current Datalog compilers, can be very inefficient or even non-terminating when the original graph of Example 1 contains cycles.

→ **这不是理论洁癖，我实测到了它的真实量级。** 在 @dxos/datalog 上跑聚合规则 deg(E,N) :- obs(I,E,_,_), N = count : { obs(I,E,_,_) }：**8000 条事实时一次加载 30845ms**（3856µs/条）；16k/32k 直接卡死到超时被杀。同规模下无聚合规则是秒级以内。原因正是 @dxos 的增量语义原文所述：a stratum is recomputed and diffed only when a relation it reads under negation or aggregation changed——每写一条事实就触发整层重算。

**标准解法二：单调聚合（monotone aggregates，原文）**：the cumulative version of standard count is monotonic in the lattice of set containment. Thus (Mazuran et al. 2013b) introduce mcount as the aggregate function that returns all natural numbers up to the cardinality of the set. 同族是 msum；把 mcount/msum 与 **max** 组合可消除低效并退化为标准 count/sum，同时保持单调。

**这条路线有真实的工程实现**：Rust 的 ascent 就把 lattice 做进语言里，README 原文：Ascent supports computing fixed points of user-defined lattices. ... when a new lattice fact (v1,...,vn) is discovered, and a fact (v1,...,v'n) is already present, vn and v'n are joined together to produce a single fact. **This feature enables writing programs not expressible in Datalog.** → 这正是 mcount/msum + max 那条论文路线的落地形态。

**Soufflé 与 Nemo 站哪边？** 两者都站 stratified / 不进递归一侧，并且实现了硬边界：
- Soufflé aggregates 文档：允许 min/max/sum/count（EBNF 里还有 mean），**聚合体可以带否定**（sum y : { A(y), !B(y) }），**空聚合体 → 结果 unbound → 整条规则不满足**，**禁止嵌套聚合**，且**不能把聚合体内绑定的变量导出到外层**（Witness Problem）。
- Nemo：一条规则最多一个聚合，只对 distinct 值。
- Cozo 与 @dxos：**聚合穿递归直接判 unstratifiable**（实测）。

→ **所有我实测/核实的实现，对聚合穿递归的处理都是拒绝或整层重算；没有一个采用 mcount 路线。** 对 DSH 的直接含义：**不要把聚合放进运行时推理层。**

### 2.4 三者同时存在：哪些组合不可判定或语义有争议

我无法给出递归 + 聚合 + 否定三全的完整可判定性图谱（**没查到一份系统覆盖这个组合分类的一手文献**，如实写没查到，不编）。能确证的是四条边界：

| 组合 | 状态 | 依据 |
|---|---|---|
| 递归 + 否定（负环） | 未分层；stratified 语义下被拒；WFS 下有定义 | Alice ch15 Prop 15.2.7；DOI 10.1145/116825.116838 |
| 递归 + 聚合 | 语义有争议；stratified-over-aggregates 给出 perfect model，但可能低效甚至不终止 | arXiv:1707.05681 原文 |
| 递归 + 聚合 + 否定 | 需同时满足否定分层与聚合分层；我查到的四个实现全部直接拒绝（诊断码均为 unstratifiable） | 实测 + 各自文档 |
| 递归 + 否定/聚合下的 provenance | **有不可能性结果**：对含差集（difference）的查询，任何按标准公理构造的 provenance 都必然失败 | arXiv:1105.2255（Amsterdamer, Deutch, Tannen 2011）原文：every such attempt is bound to fail in satisfying these axioms, for some semirings |

→ **最后一条是整个 §2 里对 DSH 最重要的结论**：我要给每条结论一个 provenance 这个需求，在有否定、有聚合的程序上，学术上是有**不可能性**的。这不是工程没做好，是数学上没有。**所以设计上必须接受 provenance 在否定/聚合处是近似的。**

（实现层的近似各有不同——Soufflé 用 explainnegation，@suss 用 absence 叶子；@dxos 干脆 Aggregates and negation contribute no premises，即不给依据。后者的选择其实是诚实的，前者是近似。**没有一个是完整的。**）

### 2.5 信念修正：DRed 及其已报告的代价

**DRed 原始出处（现查核实）**：

| 字段 | 值 |
|---|---|
| DOI | **10.1145/170035.170066** |
| 标题 | Maintaining views incrementally |
| 作者 | Gupta, Mumick, Subrahmanian |
| 会议 | SIGMOD 1993 |
| 日期 | 1993-06 |
| 页码 | 157-166 |

**DRed 的实际代价（一手论文，原文）**——arXiv:1711.03987v2 Optimised Maintenance of Datalog Materialisations（Pan Hu, Boris Motik, Ian Horrocks；2017-11-10，v2 2017-11-20）：

The Delete/Rederive (DRed) and the Backward/Forward (B/F) algorithms solve this problem for general datalog, but both contain steps that evaluate rules backwards by matching their heads to a fact and evaluating the partially instantiated rule bodies as queries. **We show that this can be a considerable source of overhead even on very small updates.** In contrast, the Counting algorithm does not evaluate the rules backwards, but it can handle only nonrecursive rules.

→ **这就是 DRed 在删除时可能重算过多的论文级依据**，且它比传闻更具体：**瓶颈不是重算本身，是 backward rule evaluation（把规则头反向匹配到事实、把部分实例化的规则体当查询求值）——即使更新极小也很贵。** 论文的解法是 DRed/B/F 与 Counting 的混合，报告 usually significantly faster than existing approaches, sometimes by orders of magnitude。

**这条对 DSH 直接命中**：事实会被 supersede、被证伪、被收缩 = 高频删除。如果去掉哪条事实这条结论就不成立 = 反事实 = 反复从头重算。两者都落在 DRed 的痛点上。**所以不要自研 DRed。** 工程上更便宜的替代是局部全清 + 重算（见 §5）。

**哪些实现真的有增量删除（逐条核实）**：

| 实现 | 删除语义 | 依据 |
|---|---|---|
| @dxos/datalog | a stratum is recomputed and diffed only when a relation it reads under negation or aggregation changed, or a relation it reads lost tuples → 已实现层内局部重算 | README 原文；我实测线性链撤回 edge(a,b) 后 reaches 正确为 ["a"] |
| @suss/datalog | **不是**自动的：retract 后派生事实不收回（实测陈旧） | 见 §5 方案 A 的完整矩阵 |
| Cozo | 撤回后重算正确（实测小图），靠全量重算 | 实测 |
| Soufflé | 编译期生成，无运行时增量删除接口 | 文档 |
| datafrog | relies on you to build and repeatedly apply the update rules，DRed 需自己写 | README 原文 |

### 2.6 本节 claim 汇总（交付格式：claim | source | publisher | pub_date | accessed | confidence | class）

| # | claim | source | publisher | pub_date | accessed | confidence | class |
|---|---|---|---|---|---|---|---|
| E1 | 分层否定的判定条件：**precedence graph G_P 无含负边的环**即 stratifiable（Proposition 15.2.7） | Abiteboul/Hull/Vianu *Foundations of Databases* ch15；http://webdam.inria.fr/Alice/pdfs/Chapter-15.pdf | Addison-Wesley（作者公开 PDF：INRIA Webdam） | 1995（书）；PDF 未标注 | 2026-11-25 | high | 规范 |
| E2 | 同一分层约束的证明：路径含负边则 σ(B) > σ(A)，故负环要求 σ(A) > σ(A)（Lemma 15.2.6） | 同上 | 同上 | 同上 | 2026-11-25 | high | 规范 |
| E3 | **所有分层等价**（All stratifications of P are equivalent, Thm 15.2.10）→ 分层算法可任选，答案唯一 | 同上 | 同上 | 同上 | 2026-11-25 | high | 规范 |
| E4 | 非分层程序的两条标准出路：语法拒绝（stratified）或用 3 值逻辑（well-founded），后者不需要任何语法限制 | 同上（ch15 章首） | 同上 | 同上 | 2026-11-25 | high | 规范 |
| E5 | 表达力：**well-founded semantics = fixpoint queries；stratified semantics 严格更弱** | 同上 | 同上 | 同上 | 2026-11-25 | high | 规范 |
| E6 | WFS 与 stratified 在可分层程序上**结果一致** | 同上 | 同上 | 同上 | 2026-11-25 | high | 规范 |
| E7 | WFS 原始规范 | DOI **10.1145/116825.116838** The well-founded semantics for general logic programs | Journal of the ACM 38(3) | 1991-07（pp 619-649） | 2026-11-25 | high | 论文 |
| E8 | **聚合破坏单调性**：正 Datalog 的 T_P 是集合包含格上的单调连续映射并保证 lfp；加聚合后这一前提失效 | arXiv:**1707.05681** | ICLP 2017 / TPLP（arXiv） | 2017-07-18 | 2026-11-25 | high | 论文 |
| E9 | **标准解法一：stratification over aggregates**，得到 perfect-model 语义（迭代 fixpoint 自下而上） | 同上 | 同上 | 同上 | 2026-11-25 | high | 论文 |
| E10 | **但该解法「can be very inefficient or even non-terminating」当图含环**；我实测 @dxos 8000 条聚合规则加载 30845ms，正是此代价 | 同上（原文）+ 本机实测 | 同上 | 同上 | 2026-11-25 | high | 论文 + 工程实测 |
| E11 | **标准解法二：monotone aggregates**（mcount 返回「到基数为止的所有自然数」，在集合包含格上单调；msum 同族；与 max 组合可退化为标准 count/sum） | 同上（引 Mazuran et al. 2013b） | 同上 | 同上 | 2026-11-25 | high | 论文 |
| E12 | **provenance 在含差集查询上有不可能性结果**：every such attempt is bound to fail in satisfying these axioms, for some semirings | arXiv:**1105.2255** On the Limitations of Provenance for Queries With Difference | PODS 2011（arXiv） | 2011-05-11 | 2026-11-25 | high | 论文 |
| E13 | **DRed 原始出处**：Maintaining views incrementally | DOI **10.1145/170035.170066** | SIGMOD 1993 | 1993-06（pp 157-166） | 2026-11-25 | high | 论文 |
| E14 | **DRed 的开销来源**：DRed 与 B/F 都含 backward rule evaluation（把规则头反匹配事实、把部分实例化规则体当查询），**this can be a considerable source of overhead even on very small updates** | arXiv:**1711.03987**v2 Optimised Maintenance of Datalog Materialisations | arXiv（Hu/Motik/Horrocks） | 2017-11-10（v2 2017-11-20） | 2026-11-25 | high | 论文 |
| E15 | Counting 算法不做 backward evaluation 但**只能处理非递归规则**；论文解法是 DRed/B-F 与 Counting 混合，**sometimes by orders of magnitude** 更快 | 同上 | 同上 | 同上 | 2026-11-25 | high | 论文 |
| E16 | **semi-naive 的定义**（To infer a new fact at stage i+1, one must use at least one fact newly derived at stage i） | Alice 书 ch13 §13.1 Seminaive Evaluation | 同 E1 | 同 E1 | 2026-11-25 | high | 规范 |
| E17 | **SQLite 递归 CTE 不允许聚合/窗口**：Recursive SELECT statements may not use aggregate functions or window functions；且递归项只能引用 CTE **exactly one** 次 | https://www.sqlite.org/lang_with.html | SQLite 官方文档 | 页面 last updated 2025-05-12 | 2026-11-25 | high | 规范 |
| E18 | SQLite 递归语义是 **queue/worklist 迭代**（UNION 去重、UNION ALL 不去重），终止靠 WHERE 或 LIMIT，不是 fixpoint 保证 | 同上 | 同上 | 同上 | 2026-11-25 | high | 规范 |
| E19 | **DuckDB 不支持相互递归 CTE**；DuckDB does not support mutually recursive CTEs | https://raw.githubusercontent.com/duckdb/duckdb-web/main/docs/2.0/sql/query_syntax/with.md | DuckDB 官方文档 | 未标注 | 2026-11-25 | high | 规范 |
| E20 | DuckDB 递归 CTE **不保证终止**：the query must be formulated in a way that ensures termination, otherwise, it may run into an infinite loop；文档中无 negation/stratified/fixpoint 概念（grep 全 0） | 同上 | 同上 | 同上 | 2026-11-25 | high | 规范 |
| E21 | **Soufflé 的 aggregation 边界**：允许 min/max/sum/count/mean；聚合体可带否定；空聚合体 → unbound → 整条规则不满足；禁止嵌套；不能把聚合体内变量导出（Witness Problem） | https://souffle-lang.github.io/aggregates | Soufflé 官方文档 | 站点页脚 Site last generated: Jul 12, 2026 | 2026-11-25 | high | 规范 |
| E22 | **Nemo 的 aggregation 边界**：一条规则最多一个聚合，只出现在 head，只对 distinct 值计算 | http://knowsys.github.io/nemo-doc/reference/aggregates/ | Nemo 官方文档 | 未标注 | 2026-11-25 | high | 规范 |
| E23 | **Cozo 与 @dxos 对聚合穿递归直接判 unstratifiable**（硬拒） | 本机实测（cozo-test/c*.mjs；.tmp-datalog-bench/dxos*.mjs） | 我 | 2026-11-25 | 2026-11-25 | high | 工程实测 |
| E24 | **Soufflé 有 explainnegation**（解释某元组为何不存在），且证明树为 minimal height | https://souffle-lang.github.io/provenance | Soufflé 官方文档 | 同上 | 2026-11-25 | high | 规范 |
| E25 | **@suss 的 provenance 含 absence 叶子**（negated literal 依赖「该元组不存在」），实测证明树第三条 premise 为 {kind:absence, relation:banned, tuple:[b]} | 本机实测 real7.mjs；suss dist/index.d.ts 原文 | 我 / nimbuscloud-ai | 2026-11-25 | 2026-11-25 | high | 工程实测 |
| E26 | **@dxos 的 provenance 不给否定/聚合依据**：Aggregates and negation contribute no premises；且每个派生元组只存一条推导 | https://raw.githubusercontent.com/dxos/dxos/main/packages/common/datalog/README.md | DXOS | 未标注 | 2026-11-25 | high | 规范 |
| E27 | **@suss 的 retract 不收回派生事实**：线性链撤回 edge(a,b) 后 reaches 仍为 [a,b,c]（正确答案 [a]）；retract+retractAll(derived)+evaluate 才得 [a] | 本机实测 suss6.mjs / suss7.mjs（13 个变体） | 我 | 2026-11-25 | 2026-11-25 | high | 工程实测 |

---

## 3. 自己实现一个最小 Datalog 引擎的现实性

### 3.1 先看真实代码量（一手取证，不是估算）

我下载各 crate 源码 tarball 并统计了 src/：

| 实现 | src 行数 | 含什么 |
|---|---|---|
| **datafrog 2.0.1** | **1439 行**（5 文件：lib.rs 524 / treefrog.rs 603 / join.rs 147 / test.rs 155 / map.rs 10） | 只有 delta join，无规则解析、无分层 |
| **ascent 0.8.1** | **1958 行**（16 文件，最大 c_rel_index.rs 276） | 仅运行时支撑（关系容器 + 索引 + lattice join）；真正做 codegen 的是另一个 proc-macro crate |
| **crepe 0.2.0** | **1587 行**（3 文件：lib.rs 1338 / parse.rs 207 / strata.rs 42） | 解析 + 分层 + codegen 入口 |
| **@suss/datalog 0.40.1** | **2440 行**（dist/index.js 打包后；dist/index.d.ts 767 行） | semi-naive + 分层否定 + witness/absence provenance + confidence 代数 + magic sets + rowBudget，全在一个文件里 |

→ **semi-naive + 分层否定 + 索引 join + provenance 这一档最小实用引擎，公开实现的量级一致落在 1.5k–2.5k 行。** 这是自己写多大的最硬经验锚点。

### 3.2 那么自己写合理吗？

**我的判断（推断，依据是上面的代码量 + 下面的坑）**：

- **写一个能跑的核心**：合理。semi-naive 的算法本身在教科书里就是明确的一节。Alice 书 Chapter 13 §13.1 原文给的定义：The central idea of the seminaive algorithm is to focus, to the extent possible, on the new facts generated at each level and thereby avoid recomputing the same facts ... **To infer a new fact at stage i+1, one must use at least one fact newly derived at stage i.** 配合 §2.1 的分层判定（precedence graph 无负环），这两页纸就是核心。
- **写一个能信任的**：不合理，除非愿意付把每个坑都用测试钉住的成本。

**自己写会踩的坑（每条都给了实测或文献依据）**：

| 坑 | 具体表现 | 依据 |
|---|---|---|
| **终止性** | 无函数符号 + set 语义才保证终止。Cozo 因为允许 a = b + 1 这类 unification，文档原文承认 queries that produce infinite relations may be accepted by the compiler，即不保证终止 | Cozo 文档；Nemo 靠 each fact is derived only once 保证终止 |
| **聚合的非单调性** | 一旦把聚合放进递归，naive fixpoint 的单调性就没了；要么分层（可能不终止），要么 mcount/msum（要自己做 lattice join） | arXiv:1707.05681 原文 |
| **索引选择** | 这是性能的全部。@suss 自述 Joins are nested-loop with hash indexing on bound positions, which suits the thousands of tuples，目标规模是数千条；10 万条时它靠的是不要一次物化 10 万，而不是索引更强 | suss DESIGN.md |
| **删除/重算** | DRed 的 backward evaluation 是难点，论文说 even on very small updates 都贵 | arXiv:1711.03987 原文 |
| **provenance 的语义** | 有否定/聚合时学术上是不可能做完整的 | arXiv:1105.2255 原文 |
| **撤回后的陈旧** | **连成熟实现都会在这里静默出错**——@suss 0.40.1 实测就是这个（§5） | 我的实测 |

### 3.3 可参考的最小实现

- **教科书**：Alice 书 Chapter 12（递归查询 / 传递闭包 / naive 与 seminaive 求值）、Chapter 13 §13.1（Seminaive Evaluation）、Chapter 15（Negation in Datalog：分层判定 Prop 15.2.7 + WFS）。章节 PDF 公开可取：http://webdam.inria.fr/Alice/pdfs/Chapter-15.pdf（http，非 https）。
- **可读的完整代码**：@suss/datalog 的 dist/index.js 是 **2440 行单文件**，含全部功能且是纯 TS 无依赖——**这是最现实的参照物，比任何 Rust 引擎都贴近 DSH 的技术栈**。
- **轻量 delta 库**：datafrog 1439 行，如果只要 join/delta 不要规则语言，可以直接借它的结构。

---

## 4. 与存储的接口：Datalog 引擎怎么和 triviumdb 结合

### 4.1 现实中的三种做法（都有实据）

| 做法 | 真实案例 | 依据 |
|---|---|---|
| **全内存物化**（每次把相关子集加载进内存） | Nemo（lib.rs 首行 A fast in-memory rule engine，无磁盘驻留求值模块）；@suss（无任何 I/O 模块） | 源码/文档 |
| **把外部 DB 当 I/O 流**（查完导出、算完回写） | Soufflé：.input/.output 支持 file 与 SQLite as a database；但这是读写通道，不是求值存储 | souffle-lang.github.io/directives + ReadStreamSQLite.h |
| **引擎自己带持久化** | Cozo（RocksDB/SQLite 后端 + 二级索引）、minigraf（单文件 bi-temporal） | 各自文档 |

**没有一个主流 Datalog 引擎做磁盘驻留的递归求值**——递归求值需要反复扫关系，磁盘随机访问会毁掉它。Soufflé 的 SQLite 通道也是整表读进来算而非边算边查盘。这是我对上述证据的归纳（推断，但三个独立来源一致）。

### 4.2 10 万条事实、每次查询只碰几百条该怎么做

**答案：加载相关切片，不加载全库。** 这个场景的关键不是引擎能不能吃 10 万条，而是为什么要让引擎看 10 万条。

实证支持：

- triviumdb 已有二级索引 → 用索引把这次召回相关的那几百条边/节点取出来，成本是索引点查量级。
- @suss 自述的舒适区正好是 the thousands of tuples。
- 我实测：@suss 插入 10 万条 61.3ms（0.0006ms/条），**点查询 0.005ms**、**全表扫描 10 万行 0.3ms** —— 纯事实层极快。慢的从来不是读写事实，是**物化派生闭包**（10 万条链闭包 evaluate 131.9ms）。

**所以正确的边界是：事实规模由 triviumdb 承担（10 万→百万都行），Datalog 引擎只承担本次召回切片上的派生闭包。** 切片几百到几千条时，一次完整 evaluate 落在亚毫秒到个位毫秒，250ms 预算几乎没被碰。

---

## 5. 结论：三个可行方案与推荐

### 方案 A（推荐）：triviumdb 存事实 + @suss/datalog 跑查询切片

**结构**

     triviumdb  (10 万基事实, 二级索引)
         |  ① 索引取切片：本次查询相关的几百条事实
         v
     @suss/datalog  (每次召用一个 slice-db)
         |  ② add 事实 -> evaluate(规则, witnesses) -> 派生结论
         |  ③ proofOf() 出证明树（含 absence 叶子）
         v
     召回结果 + 依据

**为什么是 suss**（四条，全部实测）：

1. **能在 Node 进程内直接跑**：纯 TS、零依赖、无 Node 内建、无 eval、无 native 编译、无 WASM 边界。这在所有候选里是**唯一的零摩擦路径**（Cozo 要 26MB 原生二进制且安装脚本被打断；Nemo/Soufflé 没有 Node 绑定）。
   - 供应链证据（registry.npmjs.org/@suss/datalog/0.40.1 现查）：**包内无 `dependencies` 字段**（只有 devDependencies: tsup/vitest/fast-check/typescript）；`type: module`，`main: ./dist/index.cjs`，`exports` 同时给 import/require；`unpackedSize` 225,463；发布者带 **SLSA provenance attestation**（`attestations.provenance.predicateType = https://slsa.dev/provenance/v1`，`_npmUser.name = GitHub Actions`，trustedPublisher = github）→ **由 CI 发布，非本地手推**。
2. **provenance 带 absence 叶子**——这是**决定性优势**。实测 ok(X,Y) :- edge(X,Y), safe(X), not banned(Y) 的证明树第三条 premise 是 {kind: "absence", relation: "banned", tuple: ["b"]}，即因为 banned(b) 不存在。**直接对上信念被证伪**。@dxos 明确做不到（Aggregates and negation contribute no premises），Soufflé 要 explainnegation 但没 Node 绑定。
3. **静态检查器免费送**：诊断码 arity | builtin-head | undefined | unsafe | unstratifiable —— 规则写错/有负环/变量未绑定，在加载时就硬拒，不是运行时错答案。
4. **有行数熔断**：rowBudget(limit) 超限抛 BudgetExhausted，且数据库回滚到求值前状态。这是 250ms 预算的天然护栏。

**必须遵守的三条代码约定（每条对应一个实测的静默错误）**：

| 约定 | 为什么 | 实测 |
|---|---|---|
| **① 修正 = retract(base...) -> retractAll(每个派生 relation) -> evaluate()** | retract 只动 base 事实，派生事实完全不被打动（陈旧）；单独 evaluate 不修；单独 clearRelations 会过度删除 | 线性链 s->a->b->c 撤回 edge(a,b)，正确答案 ["a"]：<br>retract + evaluate → ["a","b","c"] ✘<br>retract + evaluate x2 → 仍陈旧 ✘<br>retract + clearRelations + evaluate → [] ✘（丢了仍可达的 a）<br>retract + retractAll + evaluate → **["a"] ✔**<br>分 base/derived 两个 relation 也一样 ✘（所以不是我用法违规，是引擎行为） |
| **② 要 provenance 就必须全程开 witnesses（tag algebra）** | 不开时 proofOf 把派生事实谎报成 base fact | 同一 10 万条库：带 witnesses → {kind:"derived", premises:[...]} ✔；不带 → {kind:"fact", relation:"shared", tuple:[...]} ✘ |
| **③ 不要用 clearRelations** | 它会静默吞掉后续增量 | 4 轮对照：用 clearRelations → ms=[56.8,0.1,0,0]，rows 恒 700（第 2 轮起不再动）✘；不用 → ms=[47.3,3.7,3.1,3.9]，rows 700→1400→2100→2800 ✔ |

**必须先说清的风险**：suss 官方 DESIGN.md 原文写 **With retract, the next run would start again from the base facts**, because a fact leaving the database can remove a conclusion drawn anywhere.——**但 0.40.1 实测不成立**（上面矩阵）。文档与实现不一致，且我**没有**去提 issue（未确认是否已知）。**这意味着：不能信任文档说它会重算，只能用测试钉住行为，并在升级版本时重跑矩阵。**

**代价与量级（本机实测）**

| 场景 | 成本 |
|---|---|
| 切片：几百条事实 + 规则 evaluate | 亚毫秒～个位数 ms |
| 10 万条纯事实插入 + 点查 | 61.3ms / 0.005ms |
| 10 万条链全闭包 evaluate | **131.9ms**（RSS 284MB） |
| 10 万条一次修正循环（retract+retractAll+evaluate） | **60.4ms** |
| 增量续跑（100 条插入） | 0.1–0.3ms |

**限制（诚实列出）**：

- **无聚合**。聚合必须在应用层/triviumdb 侧另做。
- **无比较运算符内置**（A != B 要应用层过滤，或用预填 relation）。写规则时容易忘。
- deriveOnDemand（magic sets，10 万条下把候选生成从 ~165ms 压到 ~45ms）**与分层否定互斥**：官方原文 **Negation is rejected**: a demand-restricted relation is smaller than the one a negated literal was written against, and a smaller relation makes not p(x) true where it was false. → 在这个方案里优先级是切片，不是 magic sets，所以可接受。
- 自述目标规模是 the thousands of tuples，10 万条靠切片而非引擎能力。

### 方案 B：@dxos/datalog

**优点**：

- **删除语义内建且正确**：实测线性链撤回 → ["a"] ✔；菱形图撤回一条边 → 未过度撤回 ✔。这是 suss 没有的。
- **有聚合**（count/min/max/sum），有完整 Soufflé-like 解析器、Checker（unstratifiable 硬拒）、pluggable built-ins。
- 无第三依赖、纯 TS、浏览器/workerd/Node 同构。

**代价**：

- **许可非 OSI**：FSL-1.1-Apache-2.0。fsl.software 原文：The **Functional Source License (FSL)** is a Fair Source license that **converts to Apache 2.0 or MIT after two years**.（不构成法律意见，仅标注事实）
- **性能差一到两个数量级**：同规模（10 万条 + 一条普通规则）**691ms + 528MB** vs suss **~45ms + 254MB**（约 15–20 倍）；内存也接近翻倍。
- **聚合在写路径上不可用**：8000 条事实的 count 规则加载 30845ms。
- **provenance 比 suss 弱**：Aggregates and negation contribute no premises，且每个派生元组**只存一条**推导。
- **二次型规则会爆内存**：candidate(A,B) :- obs(I,A,S,V), obs(J,B,S,V), A != B. 在 10 万条基事实下 **JavaScript heap OOM 崩溃**（~4GB，~28s）。缩小规模看增长率：500 实体 → 79ms/35,216 行；1000 → 359ms/141,858 行；2000 → **1682ms/569,430 行**。→ **候选行数按 O(n^2) 增长，这才是 250ms 的真正杀手，不是引擎速度。**

**什么时候选 B**：如果删除正确性内建的价值高于性能 + 许可 + provenance 强度——例如修正频率远高于召回频率。对 DSH（读远多于写）不成立。

### 方案 C：自己写（1.5k–2.5k 行）

**合理的前提**：只有当你需要 DSH 特有的语义时——例如 provenance 必须覆盖全部推导路径（不只一条），或多值/时序事实的一等支持。这些 suss 和 @dxos 都不给：

- suss **keeps its first witness**，一个事实九种推导只留第一种；
- @dxos 只存一条推导；
- 我实测证实了后果：目标结论有 **80 条支持事实**，删 1 条结论仍成立（多路径），删全部 80 条才消失。→ **去掉哪条事实结论不成立在多重推导下必须算全部支持集，靠单条 witness 算不准。**

**代价**：代码量不是瓶颈（2k 行），**坑才是**：终止性、聚合非单调、索引选择、DRed 的 backward evaluation 开销、provenance 在否定下的不可能性。参考 Alice ch12/13/15 + 读 suss 的 2440 行是最短路径。

**我的建议**：先上方案 A，用一个 provenance 单测把多路径结论的支持集这个缺口显式化。**如果后续证明 DSH 真的需要全路径 provenance，再走 C，并直接把 suss 的源码当起点（Apache-2.0，可合法 fork）。**

### 明确不推荐（以及不该用 Datalog 的部分）

| 排除对象 | 理由 |
|---|---|
| **Cozo / cozo-node** | 静默正确性缺陷（索引早于数据 → 查询返回 0 行，100 条规模可复现，re-put 不修）；主仓 2024-12 停更；递归闭包 4171.5ms |
| **Soufflé** | 无 WASM/Node 绑定（仓库 grep = 0）；嵌入方式只有生成 C++ 再链接；magic-set 不支持否定 |
| **Nemo** | 无 Node 绑定；nemo-wasm 自述 experimental 且无逐条插入；in-memory only |
| **DDlog** | archived（2022-11-29），且需 JVM 前端 |
| **datafrog** | 无规则语言、无否定、无聚合、无 provenance；2.0.1 停在 2019 |
| **ascent / crepe** | 规则编译期固定，不能用于运行时动态规则 |
| **LogicBlox** | 商业闭源 + JVM/.NET 系（推断），与不能依赖 JVM 冲突；产品状态没查到 |
| **SQLite 递归 CTE** | 相互递归直接报错 circular reference: even；递归项只能引用自己一次；递归项禁止聚合/窗口函数（官方文档原文）；语义是 worklist 迭代不是 fixpoint，终止靠 WHERE/LIMIT 手写 |
| **DuckDB 递归 CTE** | 官方文档原文 DuckDB does not support mutually recursive CTEs；the query must be formulated in a way that ensures termination, otherwise, it may run into an infinite loop；无分层否定语义（否定是手写 path 列表检查） |
| **不该用 Datalog 的部分** | **聚合 / 计数 / 排序 / 向量相似度**——前三个见 §2.3（会破坏单调性，实测代价 30s 量级），向量检索 triviumdb 本来就有。**Datalog 只该负责递归可达 / 分层否定 / 可解释推导这三件事。** |

---

## 6. 诚实标注：查不到的、不确定的、外推的

### 6.1 明确没查到

| 问题 | 状态 |
|---|---|
| **LogicBlox 的产品状态**（是否停运/被收购/最新版本/许可条款） | **没查到**。https://logicblox.com/about 与 /products **SSL 握手失败**；官网首页仍在线只能证明站还在。任何「LogicBlox 已停运」的说法我都**没有**证据，不写。 |
| **DRed 的复杂度上界（精确阶）** | **没查到**原始论文的复杂度定理。DOI 10.1145/170035.170066 的元数据我核到了（SIGMOD 1993, pp 157-166），但付费墙内正文没取到。我引用的是 arXiv:1711.03987 对 DRed 开销的定性描述（even on very small updates），**没有**给阶。 |
| **Motik B/F 原论文（AAAI 2015）的 DOI** | **没查到**。arXiv 查不到（返回 0 条），AAAI OJS 被 CAPTCHA/520 拦住。交付里用同作者的 arXiv:1711.03987（2017 优化版）作可核实替身，**不编 DOI**。 |
| **递归 + 聚合 + 否定三全组合的完整可判定性图谱** | **没查到**系统覆盖的一手文献。只能逐条给出可确证的三个两两组合边界（§2.4 表）。 |
| **minigraf 的分层否定/聚合/增量/provenance 能力** | 部分**没查到**：README 全文 grep provenance = 0 命中、incremental = 0、semi-naive = 0。有 retract。**不能断言它没有，只能说 README 未宣称。** |
| **Cozo 的索引 bug 是否为已登记 issue** | **没查**（主仓停更，无人修）。只能写「实测复现」。 |
| **semi-naive 的原始论文 DOI** | **猜错并已纠正**：我试的 10.1007/978-1-4612-4980-1_9 实为 Brodie & Mylopoulos 的 Knowledge Bases vs Databases（Springer, 1986, pp 83-86），**不是** Bancilhon 的 semi-naive 论文。→ 交付里 semi-naive 的定义**只用 Alice 书 ch13 §13.1 原文**，不引用那个 DOI。 |

### 6.2 不确定 / 需复核的

| 项 | 说明 |
|---|---|
| **@suss/datalog 的 retract 行为是否算 bug** | 实测与官方 DESIGN.md 声明不一致（§5 约定①）。**我没有提 issue、没有确认维护者立场。** 可能是文档超前于实现，也可能是实现回归。**这是本次研究里最需要上游确认的一条。** 在确认前，代码必须靠测试钉住行为。 |
| **@suss 的「数千条」定位与 DSH 的 10 万条** | 它的自述是 suits the thousands of tuples。方案 A 绕开了这一点（切片），但**如果** DSH 某些查询必须看全库，suss 的 131.9ms 全闭包就只剩一半余量。**这个前提必须由 DSH 的实际查询形态来确认，不是我能替它决定的。** |
| **Nemo 的 nemo-python API 是否等价于 wasm** | 两个 README 都说 experimental；我只读了 README，**没有**跑通任何一个绑定。 |
| **Soufflé 是否真的完全没有 WASM 路线** | 我只 grep 了仓库树（0 命中）。**没有**去搜社区 fork。所以准确表述是「官方仓库无 WASM/Node 绑定」，不是「世界上不存在 Soufflé 的 WASM 构建」。 |
| **ascent/crepe 不能做运行时规则** | README 全文无 runtime rule API，ascent!/crepe! 是 proc-macro，**架构上直接推出**。属「规范 + 推断」混合，未用运行时实验证伪。 |
| **LogicBlox 是 JVM 系** | **推断**，未核实。它是商业平台这一点是 Wikipedia 明写的。 |

### 6.3 外推（明确标记为我的推论）

1. **「没有一个主流 Datalog 引擎做磁盘驻留递归求值」**——我从 Nemo（in-memory only）、Soufflé（SQLite 仅 I/O）、@suss（无 I/O 模块）三例归纳。**不是**穷举后的结论。
2. **「所有实现都拒绝聚合穿递归」**——我只测/核了 Soufflé、Nemo、Cozo、@suss、@dxos、ascent。ascent 的 lattice 是**唯一**走 mcount 路线的，但它编译期固定且不支持标准 count 语法，不能算「支持」。
3. **「切片方案够用」**——依据是 suss 在几百条规模亚毫秒（我实测）与 triviumdb 已有二级索引（项目背景）。**但我没有用 triviumdb 跑过真实的切片提取**，这一步的延迟未实测。
4. **「10 万条 ≈ minigraf 0.43s」**——minigraf 自述 1M 事实点查 4.3–4.5s，我按线性外推到 10 万。**引擎不会线性缩放**，这个数字只能当数量级参考。
5. **方案 C 的工期估算**——**我删掉了**，没有依据。能给的只有代码量锚点（1.5k–2.5k 行）。

### 6.4 预算使用

**独立来源约 11 个**（crates.io API / npm registry API / GitHub REST API / souffle-lang.github.io / knowsys.github.io/nemo-doc / docs.cozodb.org / webdam.inria.fr/Alice / arXiv 三篇 / doi.org content negotiation 四个 DOI / sqlite.org / duckdb-web）+ **本机实测**（不计入外部来源）。

**被限流或不可用的通道**：

| 通道 | 症状 | 替代 |
|---|---|---|
| web_search | 60s ToolCallError 超时，全程不可用 | Invoke-WebRequest 直连 |
| api.crossref.org | 反复 429 | doi.org content negotiation |
| Semantic Scholar / OpenAlex | 429 | 同上 |
| DBLP /search/publ/api | 返回空 hits（非报错） | 不用 |
| AAAI OJS | 520 / CAPTCHA | 用 arXiv 优化版替身 |
| https://knowsys.github.io | TLS 握手失败 | 必须用 http:// |
| https://logicblox.com/about | TLS 握手失败 | 无替代，如实标注没查到 |
| https://duckdb.org/docs/stable/... | JS 空壳 79 字节 | GitHub raw 的 docs/2.0/...md |

---

## 附录：实验脚本清单（**不可复核，仅有记录**）

**诚实标注（2026-11-25 补记）**：这些脚本当时跑在工作目录下的临时目录 `.tmp-datalog-bench\`，**该目录未入库，现已不存在**（`Test-Path .tmp-datalog-bench` = False，仓库内也无 `experiments/`）。所以下面这份清单是**当时做过哪些实验的记录，不是可复跑的证据**；本报告正文里的实测结论（retract 语义矩阵、10 万条规模、Cozo 静默 0 行等）都只能按「一次性观测」引用，复核需要重写脚本。要恢复可核性，应把关键脚本移进 `poc/` 并给出运行方式——属后续补做项，不在本轮范围。

原临时目录 `.tmp-datalog-bench\` 下的文件：

- suss6.mjs / suss7.mjs：retract 语义完整矩阵（13 个变体，含 SEP 分离 relation 对照）
- suss8.mjs：10 万条规模修正循环（node suss8.mjs 100000）
- real5.mjs / real6.mjs / real7.mjs / real10.mjs：proofOf / absence 叶子 / clearRelations 增量吞掉 / witnesses 缺失时误报 fact
- cozo-test/c9.mjs、c10.mjs、c11.mjs：Cozo 索引静默 0 行三场景对照
- sqlite1.mjs / sqlite2.mjs：SQLite 递归 CTE 的相互递归/多次引用/否定边界报错
- pdfgrep.mjs：Alice 书 PDF 正文抽取（注意 PDF 把 fi ligature 存成 Þ，需 .replace(/Þ/g,'fi')）
