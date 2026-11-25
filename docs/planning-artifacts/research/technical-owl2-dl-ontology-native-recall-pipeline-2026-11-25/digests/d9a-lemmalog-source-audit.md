# d9a — Lemmalog 源码级核实：双引擎内核的现成候选

来源：https://github.com/JordyZomer/lemmalog ，本地克隆在 imports/lemmalog（55 文件；核心源码 semantics.rs 5,001B / magic.rs 9,941B / eval.rs 88,216B / agent.rs 52,115B / ast.rs 13,178B）。
版本 v0.2.0，license MIT。accessed 2026-11-25。

## 1. 依赖图（决定能否内嵌进 Node）

Cargo.toml 逐行核实：

```toml
[package]
name = "lemmalog"
version = "0.2.0"
edition = "2021"
license = "MIT"

[dependencies]
serde_json = { version = "1", optional = true }
ureq = { version = "2", optional = true }

[features]
llm = ["dep:ureq", "dep:serde_json"]   # OpenAI 兼容 chat + embeddings
mcp = ["dep:serde_json"]                # MCP server over stdio
```

**核心引擎零必需依赖**：serde_json 与 ureq 都是 optional，只有开启 llm / mcp feature 才需要。这意味着**纯引擎部分是一个无外部依赖的 Rust crate**，可以作为一个独立的 .node addon 编译进来，不会与 triviumdb 的依赖树冲突，也不会引入 tokio / async runtime。

## 2. 已实现的、G5 需要的能力（逐条对应）

| G5 / G3 需求 | lemmalog 的对应实现 | 位置 |
|---|---|---|
| 基事实断言为 Datalog 事实 | declare(pred, args, ann) 带 annotation | eval.rs:618 |
| 递归查询 | reports_to(X,Z) :- reports_to(X,Y), reports_to(Y,Z) 已在 doc 注释示例 | lib.rs:19-26 |
| 聚合 | validate_aggregates：Agg 只在 head、要求 range restriction | lib.rs:89-173 |
| 增量更新 | run() seminaive over per-epoch deltas；program_dirty 触发回填 | lib.rs:558-561, 80-82 |
| 分层否定 | strata() 用 SCC 缩并分层，负环直接报 StratError | eval.rs:758-832 |
| **核收缩（G3）** | scoped_recompute（DRed-lite）+ retract + epoch 变更日志 | eval.rs:1047, 699, 722 |
| **证明树** | why(pred, args) 递归渲染到源 episode | eval.rs:2091-2146 |
| **provenance** | Ann { confidence, provenance }，join 时 confidence 相乘、provenance 取并集 | eval.rs:13-60 |
| 双时间轴 | edge(E,R,O,VF,VT,_) + now(T) 时间投影规则 | lib.rs:23 |
| magic sets | ask_deep（magic.rs 9,941 字节）| eval.rs:1946 |
| 假设推理 | hypothetical() | eval.rs:640 |

## 3. 决定性发现：negate 是 trait 钩子，NAF 不是硬编码

eval.rs:143-155 原文（注：原文含英文所有格，此处已改为不含撇号的转述，逐字引用见下方代码块）：

> The factor a negated literal contributes. `found` is the annotation of the matching fact, or `None` when the relation has no match.
> The default is negation-as-absence, the current semantics exactly: a match yields `zero()` and prunes the body, an absence yields `one()` and multiplies away. **This is the only hook that can change which facts exist**, which is why it is a trait method and not a post-pass.

```rust
fn negate(found: Option<&Self>) -> Self {
    match found {
        Some(_) => Self::zero(),
        None => Self::one(),
    }
}
```

**这是本任务的关键接口**。Annotation 是一个可自定义的 semiring trait（one / zero / times / plus / is_zero / derive / negate / render / interpret），因此：

- 在 **Datalog 运行时层**（G5 的日常推理）用默认 negate：NAF，符合分层 Datalog 标准语义，保证可终止、可验证。
- 在 **OWL 契约层**（需要 OWA）覆写 negate，让 None 返回非 one() 的「未知」标注，从而**同一条规则在两种认识论下都不需要改求值器**。

这一条把「Datalog 的 NAF」与「OWL 的 OWA」从「互斥认识论、必须选一个作基底」（d3a digest 的判定）修正为：互斥的只是**默认语义**，而 semiring 钩子给出了工程上的调和点 —— **同一个引擎的两个 Annotation 实例**。

## 4. 其它源码级细节

- `derive(self, _clause: ClauseId, _body: &[Key])` 的注释（eval.rs:111-141）警告：body 以 **FIRING ORDER** 到达且求值器不排序，同一条逻辑推导会**按 body 的排列各来一次**。若按 distinct derivations 计数，必须自己 sort(body) 再指纹；否则「对推导求平均」会变成「按排列加权平均」。实现去重推导时必须知道的坑。
- semantics.rs 是**向量检索与符号扩散的桥**：HashEmbedder 用 FNV-1a 把 token 投到 dim 桶、L2 归一化（确定性、无模型、无网络，测试用）；seed_mentions 把 cosine 相似度作为 Ann::base(sim, ["semantic"]) 断言成 mentions 事实；RELEVANCE_RULES 是
  ```
  near(S,E,1) :- mentions(S,E).
  diffuse: near(S,E2,D) :- near(S,E1,Dm), Dm < 3, D = Dm + 1, current(E1,"links",E2).
  ```
  做 3 跳有界扩散，**衰减由 confidence 乘积自然给出，不需要额外衰减因子**。
- 这正好是第 1 步「粗召几百条」的现成形态：**向量粗召 → 断言成带相似度的 mentions 事实 → 规则在图上扩散**，全部在同一次不动点里完成，输出可以远超 topK 而不违反 AD-8（内部工作集不进注入）。
- eval.rs 用 `Relation` 全内存哈希索引（index_row / unindex_row / lookup），`lookup(bound: &[Option<Value>])` 是索引化的部分绑定查找 —— 这正是「原子类查询 PTIME」要的形态。

## 5. 诚实标注

- **我没有跑通它的 benchmark 或复现任何数字**。上述能力来自源码阅读与 doc 注释，不是实测。d3a digest 里的评测数字（seed 42, 1000 turns, knowledge updates 30/30）来自 README 自述，未独立复现。
- **没有验证它在 Windows + napi-rs 下能否编译成 .node。这是未做的关键实验**，若采此路线必须先做。
- magic.rs 我只看了文件名与字节数，未读实现细节。
- lemmalog **没有持久化**：changes_from / changes_since 说明它把自己定位成「可重放的派生视图」，持久化靠外部存储（我们的 triviumdb）。这与 d3a 里「派生关系永不持久化（event sourcing）」的观察一致。
