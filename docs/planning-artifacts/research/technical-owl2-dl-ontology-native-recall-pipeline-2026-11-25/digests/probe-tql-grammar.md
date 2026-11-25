# probe-2 — TQL 的实际语法边界（决定实体查询层怎么写）

source: 自有实测（triviumdb@0.9.3, Node v24.21.0）。这是对 `triviumdb.d.ts` 声明之外行为的补充——d.ts 没写这些细节，只能跑出来。
accessed: 2026-11-25

## 已确认可用的形式

| 语句 | 结果 |
|---|---|
| `FIND {kind:"Individual"} RETURN *` | 返回 `[{_: {id:"1", numEdges:0, payload:{...}}}]`，id 是**字符串** |
| `FIND {kind:"Individual"} RETURN _` | 同上 |
| `FIND {kind:"Individual", direct_type:"Researcher"} RETURN _` | 正确过滤，命中 bitmap 索引 |
| `FIND {kind:"Individual", score: {$gt: 40}} RETURN _ LIMIT 3` | 正确，Mongo 风格算子可用 |
| `FIND {kind:"Individual"} WHERE direct_type == "Researcher" RETURN _` | 正确，WHERE 用**平铺字段名**、比较符是 `==` |
| `FIND {kind:"Individual"} WHERE score > 40 RETURN _ LIMIT 3` | 正确 |

## 明确不可用的形式（会抛 Query parse error）

| 语句 | 错误 |
|---|---|
| `... RETURN id` / `... RETURN id, payload` | 语法通过但**返回全 null**（陷阱：静默错误） |
| `... RETURN _.payload` | 返回全 null |
| `... RETURN _.payload.iri` | `Unexpected trailing TQL input: Dot` |
| `... WHERE _.payload.direct_type == "Researcher"` | `Expected a predicate comparison` |
| `... ORDER BY score DESC RETURN _ LIMIT 3` | `Expected Return, got Order` —— FIND 里 ORDER BY 必须在 RETURN 之后 |
| `FIND {...}`（无 RETURN） | `Expected Return, got Eof` |
| `MATCH (a)-[:rdf:type]->(b)` | `Expected RBracket, got Colon` —— **边 label 不能带冒号** |

## 性能（5,000 节点，2 个 bitmap 索引）

- 批量插入 5,000 节点：**59 ms**
- `FIND {... direct_type:"Researcher"} RETURN _`（全量 4,000 行，无 LIMIT）：**26 ms**
- 同上加 `LIMIT 300`：**1 ms**
→ 实体查询阶段**必须带 LIMIT**，否则结果集本身成为延迟来源。

## 对本项目的直接含义

1. **边 label 命名空间要扁平化**：不能用 `rdf:type`、`owl:disjointWith` 这类带冒号的形式。需定义 `rdf_type`、`sub_class_of`、`disjoint_with` 等，或统一用短码。
2. **TQL 只能取整节点视图，不能投影字段**。所以「概念查询」的流程是：TQL 用索引缩小候选集 + LIMIT → 取回 payload → 在 JS 里做细粒度判断。索引负责选择性，JS 负责语义。
3. **`RETURN id` 静默返回 null 是真实陷阱**，任何封装层都要用 `RETURN *` 并断言 `_.id != null`。
4. 5k 规模下全量匹配 26ms，说明「几百条粗召 → 编译成多个概念查询」的方案在延迟上是可行的，前提是每个查询都带 LIMIT。
