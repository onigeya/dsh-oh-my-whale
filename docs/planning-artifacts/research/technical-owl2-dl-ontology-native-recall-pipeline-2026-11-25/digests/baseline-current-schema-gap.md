# baseline-1 — 现有 schema 的本体化缺口（重设计的起点）

source: 项目自有架构文档（非外部文献，故不进来源表，只作内部基线）
accessed: 2026-11-25
path: docs/planning-artifacts/architecture/architecture-DSH哦鲸鲸-2026-11-23/SOLUTION-DESIGN.md:26-99；ARCHITECTURE-SPINE.md:414-416

## 现状：已经有「半个」本体

现有 schema 的形状（SOLUTION-DESIGN.md:32）：

```
kind=assertion  payload = { subj, pred, obj, obj_norm?, valid_from, valid_to?, recorded_at,
                            superseded_at?, active_slot, origin(observed|inference), falsifier?,
                            settle_state?, vec_state, actor, cause, prompt_version, cycle_id? }
```

- **已经有二元关系**：`(subj, pred, obj)` 就是一条三元组。`obj_norm` 是规范化后的对象。
- **已经有一张小 TBox**：谓词基数表（SOLUTION-DESIGN.md:80-93），10 个种子谓词 + `pred` 节点登记表；`cardinality` ∈ {single, multi}，决定 mem_key 是三段还是四段。
- **已经有部分 OWL 味道的东西**：
  - 唯一性靠 `createUniqueCompositeIndex(["mem_key","active_slot"])`，活动版本 `active_slot=1`，被取代时改成毫秒数 → 这是**时间化的函数性约束**（functional property），但只对 `cardinality=single` 生效。
  - `supersedes` 边 = 版本取代；`contradicts` 边 = 互斥 → `contradicts` 其实接近 `owl:disjointWith`，但只连断言、不连类。
  - `origin(observed|inference)` = 一个原始的三值雏形：观察到 vs 推断出。
  - `falsifier` 字段已经存在（断言自带「什么能推翻我」）→ 这是溯因/证实证伪步骤的天然挂点。
- **权威 kind 13 种**（SPINE:414）：assertion/evidence/entity/episode/scene/pref/persona_state/flag/whatif/decision/dream_cycle/dream_log/rejected。
- **权威 edge label 11 种**（SPINE:414）：supersedes/contradicts/supports/refutes/enriches/about/part_of/derived_from/anchor/in_episode/covers。**全部无冒号**——与 probe-2 测出的 TQL 限制天然兼容。

## 缺口：要补的正是 OWL 2 那几层

| OWL 2 构件 | 现状 | 缺什么 |
|---|---|---|
| 类层级（subClassOf） | 无 | `entity.type` 是扁平枚举 `person\|place\|thing\|org\|topic`，无父子关系、无传递闭包 |
| 类不相交（disjointWith） | `contradicts` 是断言级 | 类级不相交从未声明，所以「证实即证伪」不可判 |
| 属性 domain/range | 无 | 谓词表只有 `cardinality`，没有 domain/range，无法从 `works_at(Alice,X)` 推出 `X ∈ Org` |
| 属性特征（transitive/symmetric/inverse/functional） | 仅 single≈functional | 无 transitive/symmetric/inverse，`part_of` 的传递闭包得手算 |
| 个体等同（sameAs/differentFrom） | 无 | 只有 `obj_norm` 字符串规范，不是本体级的 sameAs 推理 |
| 存在/全称限制 | 无 | 无法表达「每个 Project 必有 owner」这类公理 |
| 一致性检查 | 无 | 从不知道库里的断言集是否矛盾（`contradicts` 边靠人工/模型发现） |
| 证明/溯源 | `supports`/`refutes` 边 | 有极性但**无推导步**，无法回答「这条结论经由哪几步得出」 |

## 这对 5 步管路的直接后果（缺口如何致命）

1. **第 2 步（概念查询）无法做**：没有类层级，就无法把「用户问研究相关的事」编译成「Researcher ⊔ Lab ⊔ Project ⊑ 相关」。现在只能靠向量相似度，即纯几何召回，没有符号层。
2. **第 2 步的「证伪」不可能**：OWA 下要证伪 `C(a)` 需要 `∃D. D disjointWith C ∧ a ∈ D`。现在既无 disjointWith 也无类归属推理，所以只能「未找到」——而「未找到」在 OWA 下不是证伪。这是设计里最硬的一个语义坑。
3. **第 3 步（溯因最小 delta）没有形式化目标**：溯因要的是「最小公理集 Δ 使得 T ∪ A ∪ Δ ⊨ q」。现在没有 T，Δ 只能靠 LLM 猜。
4. **第 4 步（部分证明树）无从表达**：没有推导步，就没有「已证实的子树」。

## 结论（承重）

重设计不是给现有 schema 加字段，而是**把 `pred` 登记表升级成真正的 TBox，把 `assertion` 升级成带推导步的 ABox**。最省的做法是复用已有的 13 kind / 11 label 命名习惯（无冒号、扁平），新增类节点、属性节点、公理节点三类，并让 `entity` 从扁平 type 枚举改为挂到类节点上。
