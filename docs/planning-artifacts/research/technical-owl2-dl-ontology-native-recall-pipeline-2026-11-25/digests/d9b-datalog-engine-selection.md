# d9b. 进程内 Datalog 引擎选型：现成引擎可用，但有三个静默错误

来源：子代理 datalog-engine 报告 `docs/planning-artifacts/research/technical-datalog-engine-selection-2026-11-25.md`（493 行）。本 digest 提炼对设计有决定作用的部分，数字均来自该报告的实测或一手核对。

## 9b.1 判决：用 @suss/datalog 跑查询切片，事实留在 triviumdb

`@suss/datalog` 0.40.1：纯 TypeScript、Apache-2.0、零依赖、单文件 2440 行。**不自研引擎**——自研的成本不是写不出一版能跑的，是写不出能信任的（终止性、聚合非单调、索引、DRed、provenance 不可能性，每一项都能静默出错）。

架构是「事实在 triviumdb、规则在 suss、每次只把查询切片喂进去」。10 万条 + 每次只碰几百条时，加载切片不是妥协而是正确做法（见 9b.5）。

## 9b.2 候选收窄（版本/许可/发布日实测）

| 候选 | 状态 | 排除理由 |
| --- | --- | --- |
| @suss/datalog 0.40.1 | 维护中，Apache-2.0 | **选中** |
| @dxos/datalog | 维护中，FSL 非 OSI 许可 | 备选；慢 15–20×；聚合写路径不可用 |
| Cozo | 唯一能 napi 原生嵌入，**主仓 2024-12 停更** | **静默正确性缺陷**（见 9b.3） |
| Soufflé | 无 WASM/Node 绑定（仓库树 grep 命中 0） | 无进程内路径 |
| Nemo | wasm 绑定自述 experimental，且**无逐条插入 API** | 无法增量 |
| DDlog | archived 2022-11-29 | 停更 |
| datafrog 2.0.1 | 停在 2019 | 停更 |
| ascent / crepe | proc-macro | **规则编译期固定，不能运行时动态规则** |
| datalog / datalogjs / @datalog/core / ddlog-wasm / nemo-js | npm 404 或无关包 | 不存在 |
| LogicBlox | 产品状态查不到（about/products 页 TLS 握手失败） | 未核实 |

## 9b.3 Cozo 的静默错误（排除它的决定性证据）

**索引早于数据创建 + 查询在索引列之外还绑定其它列 → 静默返回 0 行**，100 条规模即可复现，re-put 数据不能修复。已在本机用 napi 原生跑通后复现。

这个形态比崩溃危险得多：它返回的是「没有匹配」，与「真的没有匹配」在调用方看来完全相同。对信念系统来说，这会变成一次静默的错误否定。

## 9b.4 suss 的三个静默错误（实现前必须知道，全部实测 13 个变体）

**① retract 不收回派生事实。** 线性链 a→b→c 撤回 edge(a,b)：正确答案 `["a"]`。
- `retract + evaluate` → `["a","b","c"]`（陈旧）
- `retract + evaluate ×2` → 仍陈旧
- `retract + clearRelations` → `[]`（过度删除）
- **唯一正确**：`retract(base) → retractAll(每个派生 relation) → evaluate()` → `["a"]` ✔

分 base/derived 两个 relation 也一样错——不是用法违规，是引擎行为。**与官方 DESIGN.md 原文冲突**（原文称「With retract, the next run would start again from the base facts」，0.40.1 实测不成立）。未提 issue，未确认是否已知 → 最需要上游确认的一条；对策是用测试钉住行为，升级时重跑矩阵。

**② 不开 witnesses 时 `proofOf` 把派生事实谎报成 base fact**（返回 `{kind:"fact"}` 而非 `{kind:"derived"}`）→ provenance 必须全程开 tag algebra。

**③ `clearRelations` 静默吞掉后续增量**（4 轮 rows 恒 700；不清除则 700→1400→2100→2800）。

## 9b.5 suss 的决定性优势：provenance 有 absence 叶子

实测 `ok(X,Y) :- edge(X,Y), safe(X), not banned(Y)` 的证明树第三条 premise 是 `{kind:"absence", relation:"banned", tuple:["b"]}` —— 「因为 banned(b) 不存在」。

**这直接对上第 ④ 步的缺口表达**：缺口不只是「缺一条断言」，还包括「某个否定前提的缺席本身是证明的一部分」。@dxos 明确「Aggregates and negation contribute no premises」，拿不到这个。

## 9b.6 表达力边界（一手来源）

- **分层否定判定** = Alice 书 **Prop 15.2.7**：precedence graph 中不存在含负边的环。Soufflé / Cozo / suss / @dxos 四个独立实现的诊断码都是同一判定。
- **非分层程序的标准处理** = 语法拒绝 **或** WFS（Van Gelder et al., DOI `10.1145/116825.116838`）。Alice 原文：WFS 是 fixpoint queries，stratified **严格更弱**。
- **聚合** = `arXiv:1707.05681`：破坏的是 T_P 的单调性。解法一 stratification-over-aggregates，论文自认「can be very inefficient or even non-terminating」——**实测量级**：@dxos 8000 条聚合规则加载 30845ms。解法二 mcount/msum 单调聚合（工程落地是 ascent 的 lattice）。
- **provenance 的不可能性（对本设计最关键）** = `arXiv:1105.2255` 证明：有否定或差集的程序上，「给每条结论完整依据」数学上做不到。**设计必须接受近似**，不能承诺全路径 provenance。
- **DRed 开销来源** = `arXiv:1711.03987` 原文：瓶颈是 backward rule evaluation，「even on very small updates」。

## 9b.7 性能实测（suss，本机）

| 操作 | 耗时 |
| --- | --- |
| 插入 10 万条 | 61.3ms |
| 点查 | 0.005ms |
| 全表扫 | 0.3ms |
| 全闭包 | 131.9ms |

**结论：慢的从来不是读写事实，是物化派生闭包。** 这条与 §3.9 的物化判据互相印证：闭包物化的价值在于避免重算，而不是为了让读取变快。

## 9b.8 明确不该交给 Datalog 的部分

聚合、计数、排序、向量相似度。它们要么破坏单调性，要么本就该由存储层的索引与向量检索承担。

## 9b.9 未验证项（诚实标注）

1. **triviumdb 切片提取那一步的延迟没测** —— 这是方案 A 唯一未验证环节。
2. **DSH 是否存在「必须看全库」的查询形态未确认** —— 若有，suss 的 131.9ms 全闭包会吃掉 250ms 预算的一半以上。
3. 若要全路径 provenance（suss 只存 first witness；实测结论有 80 条支持事实时，删掉 1 条仍成立），则只能自研或 fork suss（Apache-2.0 允许）。
4. LogicBlox 产品状态、DRed 复杂度精确阶、Motik AAAI 2015 的 DOI、递归+聚合+否定三全的可判定性图谱——均未取到。

## 9b.10 对设计的直接影响

1. **§0 的一句话结论要补一个实现层判断**：契约层不需要第二推理器，也不必自研 Datalog；用 suss 跑 RL 规则（78 条全是正向 horn + false 头，不需要分层否定，见 d1/d8）。
2. **retract 的用法必须写成硬规则**：撤回一条基事实时，必须同时撤回所有派生 relation 再求值。这条不是优化建议，是唯一正确用法。
3. **provenance 的承诺要降级**：从「每一次结论给出完整依据」降为「给出 first witness + 缺口标注」。这不是实现不足，是 9b.6 的不可能性结果。
4. **切片式查询成为默认**：先把候选按索引缩到几百条，喂给 suss 求值，不加载全库。这与 C3（几百条只是内部工作集）天然一致。
