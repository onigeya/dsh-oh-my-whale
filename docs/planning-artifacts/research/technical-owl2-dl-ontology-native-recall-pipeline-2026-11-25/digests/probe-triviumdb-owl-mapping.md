# probe-1 — triviumdb 承载 OWL2 TBox/ABox 的可行性实测

class: implementation-probe (自有测量，非文献)
accessed: 2026-11-25
环境: triviumdb@0.9.3, Node v24.21.0, Windows, dim=8, dtype=f32, syncMode=off

## 探针 A：边驱动（用 rdf:type / rdfs:subClassOf 边做纯图遍历）

- 规模：10 类 + 2 属性 + 20,000 个别名，每条个体 2 条出边（rdf:type, ex:worksAt）
- 写入：20,012 节点 / 40,013 边，**383 ms**
- `reachableDetailed(ex:Agent, {direction:incoming, maxDepth:4, labels:[rdfs:subClassOf, rdf:type], maxResults:200000})`
  - 结果 **9,999** 条，visitedNodes 10,000，traversedEdges 40,015，**truncated=true**，90 ms
  - 即：即便显式传 maxResults=200000 仍被截断（存在内部上限）
- `getEdges(individualId)`：1 ms，2 条边
- 超级节点问题：ex:Agent 的入度 = **20,002**；degree histogram 里 `max_in_degree: 20002`
  - 结构上这是本体固有的：类节点是所有个体的入边汇聚点
- graphStats 的 `label_stats` 给出每个 label 的 distinct_source_count / distinct_target_count，可用于检测这种扇入

## 探针 B：物化闭包（把类型闭包写进 payload 再建索引）

- 同一规模 20,000 个体，**不建任何 rdf:type 边**（图里只有 7 条 subClassOf 边）
- payload 里存：`kind:"Individual"`, `direct_type:"Researcher"|"Lab"`, `type_closure:"Researcher|Person|Agent"`, `type_list:[...]`
- 写入 **305 ms**；建 3 个索引（bitmap×2 + ngram×1）**259 ms**
- 查询 ex:Agent 全部实例（ngram 匹配闭包串）：返回 300 条（LIMIT 300），**4 ms**
- 查询 direct_type="Researcher"（bitmap）：返回 300 条，**2 ms**
- `reachableDetailed(ex:Agent, ...)` 在无 rdf:type 边时：7 条结果，0 ms

## 关键结论（工程事实，非文献）

1. **把 ABox 的 rdf:type 全部建模成边会造出超级节点，且遍历会静默截断。** 探针 A 在 2 万个体时即触发 9,999 上限。几百条召回规模虽不至于此，但截断是**无提示**的语义风险——证明树会缺支。
2. **把类型闭包物化进 payload + ngram/bitmap 索引，查询比遍历快约 20 倍（4ms vs 90ms），且无截断。** 代价是写放大与 TBox 变更时的重物化成本。
3. **TQL MATCH 不接受前缀形式的 label 字面量**：`MATCH (a)-[:rdf:type]->(b)` 报 `Expected RBracket, got Colon`；`WHERE b.iri == "..."` 用 `==` 不是 `=`。→ 边 label 不能直接叫 `rdf:type`，必须改写（如 `rdf_type` 或 `t`）。这是一条会直接影响 schema 命名的硬约束。
4. TQL 的 `FIND` 支持 `$contains` 与 bitmap 命中，配合 `LIMIT` 在毫秒级；是「实体查询」步骤（第 2 步）的主力入口，而不是 `MATCH`。
