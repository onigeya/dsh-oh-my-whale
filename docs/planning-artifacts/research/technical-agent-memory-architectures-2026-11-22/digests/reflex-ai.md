# ReFlex.AI · 实现机制 digest

> 研究对象：https://github.com/steavehirramsan/ReFlex.AI （PyPI 包名 `reflex-memory`）
> 取证方式：全量 `git clone` 后逐文件读源码（commit `39f369a`，main 分支），GitHub API 取元数据，PyPI JSON 取发布状态。
> 证据等级标注：**【代码】**= 源码里确实这么写；**【README】**= 文档/注释声称；**【推断】**= 我基于代码路径的判断，未运行验证。

---

## 身份确认

**吻合，无 mismatch。** 仓库存在、非空、内容与"记忆项目"高度吻合，用户点名的 `reflex-memory` 就是它的 PyPI 发行名。

| 项 | 事实 | 证据 |
|---|---|---|
| 仓库 | `steavehirramsan/ReFlex.AI`，MIT，默认分支 `main`，103 KB | api.github.com/repos/...（`license.spdx_id=MIT`、`size=103`、`default_branch=main`） |
| 描述 | "persistent cognitive architectures for long-running AI agents and LLMs" | 同上 `description` |
| 创建/推送 | 2026-06-03T09:24:27Z / 2026-06-03T13:59:31Z | 同上 `created_at` / `pushed_at` |
| 提交数 | **6 个，全部集中在 2026-06-03 一天** | `git log`：`c5e422b` Initial commit → `74e9332` Implement ReFlex cognitive runtime → `39f369a` Publish on PyPI |
| 社区信号 | 2 star / 1 fork / **0 issue** / 0 watcher | 同上；`issues?state=all` 返回 `[]` |
| 版本 | 0.1.0，已上 PyPI | `src/reflex/version.py:3`；`CHANGELOG.md:7`；pypi.org/pypi/reflex-memory/json → `info.version=0.1.0` |
| 包名映射 | 发行名 `reflex-memory`，import 名与 CLI 为 `reflex` | `pyproject.toml:6`、`pyproject.toml:63-64` |

**这个身份事实决定了下文的读法**：它不是长期演进的系统，而是单作者在一天内产出的"完整可运行脚手架"。代码与文档之间存在系统性落差（见"点名深挖"），且**没有任何真实用户反馈可供引用**。

---

## 一句话定位

一个 **Python 库 + CLI**（不是服务、不是 MCP server、不是插件）——给单进程 LLM agent 套上一层"命名分层"的记忆：3 张 SQLite 表（events / facts / archive）+ 3 个进程内向量索引，每轮 turn 内同步跑完 `retrieve → assemble → generate → verify → persist → reflect → compact`。

真正实现的是**"三层持久记忆 + 召回融合 + 摘要归档"**；README 主打的 **promotion / demotion 状态机并不存在**（详见点名深挖 §1）。

- 目标用户（【README】，README:13、41-53）：要跑数小时到数月、受困于"上下文碎片化 / 记忆退化 / 身份漂移 / 编造历史"的长时 agent 开发者与研究者。
- 宿主形态（【代码】）：`pip install reflex-memory` 后 `import reflex`，或 `reflex run|chat|inspect|eval|config`（`pyproject.toml:63-64`、`src/reflex/cli.py`）。`pyproject.toml:47` 声明了 `serve = ["fastapi","uvicorn"]` extra，但 `src/` 内**没有任何 fastapi/uvicorn 代码**（grep 无命中）→ 无 HTTP 服务形态。
- 定位诚实度加分项：README 自己写明 "headline results are not yet published"（README:234）。

---

## 架构总览

单轮 turn 的六步流水线（【代码】`src/reflex/core/orchestrator.py:56-126`，文档同构于 `docs/architecture.md:10-23`）：

```text
handle(user_input)
 1. retrieve   MemoryManager.retrieve(input)                      orchestrator.py:62
 2. assemble   Policy.build_messages(persona+WM+retrieval+recent)  orchestrator.py:70-75
 3. generate   LLMClient.complete(messages)                        orchestrator.py:78
 4. verify     IntegrityGuard.check(draft, retrieval, memory)       orchestrator.py:79
     └─ 可选 revise：把 flags 拼成纠正指令再问一次模型             orchestrator.py:150-161
 5. persist    record_event(user) / record_event(assistant)         orchestrator.py:64-69, 85-91
 5b. reflect   ReflectionEngine.reflect(...) → 写 semantic facts    orchestrator.py:95-103
 6. compact    memory.maybe_compact()                               orchestrator.py:106
```

模块职责（`docs/architecture.md:27-38` 的映射表，与 `src/reflex/` 实际文件一一对应）：

| 概念 | 文件 | 实际职责 |
|---|---|---|
| 编排 + 策略 | `core/orchestrator.py`、`core/policy.py` | 流水线；重要度打分、反思节流、prompt 装配 |
| 短时缓冲 / 工作记忆 | `memory/short_term.py` | 进程内 `deque(40)`；2048 token 草稿本 |
| 情景记忆 | `memory/episodic.py` | append-only 事件日志 + 向量检索 |
| 语义记忆 | `memory/semantic.py` | 事实库，`valid` / `superseded_by` 软状态 |
| 冷归档 | `memory/archive.py` | 摘要记录 + 向量检索 |
| 跨层协调 | `memory/manager.py` | 双写、统一检索、compaction |
| 幻觉/一致性 | `integrity/guard.py` | 4 类确定性启发式检查，不调第二次 LLM |

---

## 数据模型与存储

三类记忆单元（【代码】`src/reflex/types.py`），全部是 pydantic 模型、可直接序列化：

| 模型 | 字段 | 位置 |
|---|---|---|
| `Event`（情景） | `id`(`evt_`前缀) / `session_id` / `ts`(epoch float) / `kind`(message\|action\|observation\|reflection\|correction) / `role` / `content` / `importance`(0-1) / `metadata` / `embedding` | types.py:102-117 |
| `Fact`（语义） | `id`(`fact_`) / `statement` / `subject` / `predicate` / `object` / `confidence`(0-1) / `source_event_ids[]` / `created_ts` / `updated_ts` / **`valid`** / **`superseded_by`** / `embedding` | types.py:120-139 |
| `ArchiveRecord`（冷） | `id`(`arc_`) / `summary` / `origin_tier` / `span_start` / `span_end` / `source_ids[]` / `token_estimate` / `embedding` | types.py:142-152 |

**层级不是字段，而是"存在哪张表"**：`MemoryTier` 枚举有 5 个值（`short_term/working/episodic/semantic/archive`，types.py:55-62），但记录上没有可迁移的 `tier` 字段；`MemoryHit.tier` 只是检索结果的出处标签（types.py:160-168）。**这是"没有晋升状态机"的结构性证据**——见点名深挖 §1。

**存储**（【代码】`src/reflex/memory/db.py:27-69`）：单文件 SQLite，schema 用 `CREATE TABLE IF NOT EXISTS` 幂等建立，版本靠 `PRAGMA user_version`（当前 `SCHEMA_VERSION = 1`，db.py:25, 92-97）。

```sql
events (id PK, session_id, ts, kind, role, content, importance, metadata, embedding)
  INDEX idx_events_session_ts(session_id, ts) / idx_events_ts(ts)
facts  (id PK, statement, subject, predicate, object, confidence,
        source_event_ids, created_ts, updated_ts, valid, superseded_by, embedding)
  INDEX idx_facts_valid(valid) / idx_facts_subject(subject)
archive(id PK, summary, origin_tier, span_start, span_end, source_ids, token_estimate, embedding)
```

- 连接：`check_same_thread=False` + `isolation_level=None`（autocommit）+ `WAL` + `synchronous=NORMAL`（db.py:81-89）。
- **embedding 以 JSON 文本存 SQLite**，float32 四舍五入到 7 位小数（db.py:132-142）→ 向量检索必须先在内存里重建。
- 向量索引是**进程内**的，启动时从库里全量重建：`episodic.py:30-39`、`semantic.py:30-41`（只加载 `valid=1`）、`archive.py:30-39`。这是唯一的"重启恢复"机制（【代码】；代价见"工程形态"）。
- 索引后端：默认 `numpy` 暴力精确检索，可选 `faiss`（vector_index.py:52-119 / 120-196，`build_vector_index` 在 198-204）。

---

## 写入路径

**触发条件：每轮必写，无闸门。**（【代码】）

1. **用户输入**：进 `retrieve` **之后**（避免检索到本次输入，orchestrator.py:61-63），写一条 `Event`，`importance = Policy.importance_for_input(text)`（orchestrator.py:64-69）。
   - 打分是纯正则启发式：基线 0.45，命中 `remember|never forget|my name is|deadline|prefer` 等 +0.3，词数 >30 +0.1，以 `?` 结尾 −0.05（policy.py:16-20, 31-40）。
2. **助手回复**：写第二条 `Event`，`importance = 0.5 + 0.2*(1 - integrity_score)`，metadata 记录 `integrity_score` / `revised`（orchestrator.py:85-91）。**越不被完整性层信任的回复，importance 越高**——这是刻意的"值得注意"语义，而非"值得信任"。
3. **反思事件**：`kind="reflection"` 的一条摘要事件（engine.py:112-119），注入 prompt 时被跳过（policy.py:73-75）。

**谁决定写 / 抽取方式**（语义事实）：

- `ReflectionEngine.reflect()` 每 `every_n_turns`（默认 1）轮跑一次（policy.py:42-44；orchestrator.py:95-103）。
- **抽取是两层**（engine.py:8-16）：确定性正则（`remember that…` / `my X is Y` / `A is B` / `_is_salient` 要求含数字或专有名词，engine.py:32-58, 131-144）＋ 可选 LLM 补充（要求模型输出 `FACT:` 行，engine.py:61-67, 146-157）。默认 `mock` LLM 下走纯正则。
- 只从 **user_input** 抽（engine.py:90），助手侧仅靠 LLM augmentation。
- 落库置信度：`user` 开头 0.85，其余 0.7；与 `min_importance_to_store=0.55` 比较后决定是否写（engine.py:100-109）。**注意命名错位**：配置项叫 `min_importance_to_store`，实际比较的是 `confidence`（【代码】；语义不一致属【推断】）。

**去重：没有。**（【代码】+【推断】）

- `add_fact` 每次都构造新 `Fact`，`id` 由 `new_id("fact")` 现生成（manager.py:116-124；types.py:128）。
- `SemanticStore.upsert` 以 **id** 为主键 `INSERT OR REPLACE`（semantic.py:45-75），而 `facts` 表**没有 `UNIQUE(statement)` 或任何指纹列**（db.py:42-57）。
- 结论（推断）：同一句"我的部署区域是 eu-west-2"在第 1、10、100 轮各说一次，会得到 **3 条同时 `valid=1` 的事实**，检索时互相竞争 top-k。这与 types.py:123 的注释 "Facts are distilled, **deduplicated** assertions" 直接矛盾。

**失效 / 替代（supersession）——有 API，没触发者。**（【代码】）

- `SemanticStore.invalidate(fact_id, superseded_by=...)` 会把 `valid=0`、写 `superseded_by`、并从索引移除（semantic.py:77-83）。
- 但全仓库 `src/` 内**没有任何调用点**（grep `invalidat` 仅命中 types.py:124 注释、semantic.py:3 注释、semantic.py:77 定义）。
- `IntegrityGuard` 检测到 `factual_drift` 时只**抛 flag**（guard.py:135-164），不改事实状态；写回只发生在注释层面（README:106 的 `REF -.->|write corrections| EPI`）。
- 因此：**语义层的"事实可被推翻"目前只在测试里被演练**（tests/test_memory_stores.py:85-107），运行时永不发生。

---

## 点名深挖：晋升降级状态机 + 冷热分层 + 离线 compaction

### §1 显式 promote / demote 状态机：**不存在**

这是本次调研最重要的结论，且是**文档与代码的系统性冲突**：

| 维度 | README 声称 | 代码事实 |
|---|---|---|
| 状态集合 | 5 层，状态"在层间迁移"（README:49、116-124） | `MemoryTier` 只是枚举标签（types.py:55-62），记录上无 `tier` 字段 |
| 转移函数 | "promotion (frequently used → durable), demotion, compaction"（README:116） | 全仓库 grep `promot|demot` **只命中 3 处注释/文档字符串**：types.py:105、short_term.py:5、engine.py:43。**没有任何函数** |
| 阈值 | 配置项 `promotion_importance: 0.6`（config.py:94；configs/default.yaml:33） | 该键**在 `src/` 内无读取方**——只出现在定义处与 YAML 里（grep 结果仅此两处）。**死配置** |
| 触发条件 | "frequently used" / importance 门槛 | 无。`importance` 只被写进库（episodic.py:56）与统计，从不参与任何淘汰或晋升判定 |

**实际存在的两条"跨层"行为，都不是状态机：**

1. **双写（write-through），不是晋升**：`record_event` 同时 `short_term.add(event)` 和 `episodic.add(event)`（manager.py:101-102）。
   `ShortTermBuffer.add` 会返回被容量挤出的元素（short_term.py:30-36），但**调用方直接丢弃了返回值**（manager.py:101 之后并无处理）。所以 short_term.py:5-6 那句 "When the buffer overflows, the memory manager is responsible for promoting evicted items into the durable episodic store first" 是**空承诺**——因为写入时已经落库，无需晋升。
2. **降级 = DELETE，单向不可逆**：compaction 时 `self.episodic.delete([...])`（manager.py:188），`EpisodicStore.delete` 执行 `DELETE FROM events` 并从索引移除（episodic.py:69-74）。
   **没有反向路径**：archive 记录不会被还原成 events，也没有 `archive → episodic` 的代码。
   检索层确实对冷热一视同仁（manager.py:139-143 三个 store 一起搜），所以"还能被召回"——但那是**检索**，不是**晋升**。

**是否可逆：否。**（【代码】）一旦 compaction 越过阈值，原始事件文本永久消失，只剩一条 ≤800 字符的摘要（见 §3）。

**结论**：这是一个"分层存储 + 单向归档"，不是"带状态机的记忆晋升"。若按 README 的描述去评估它，会严重高估其能力。

---

### §2 冷热分层存储策略

| 层 | 存哪 | 介质 / 结构 | 证据 |
|---|---|---|---|
| 热（short-term） | 进程内 | `deque(maxlen=40)`，容量满即挤掉最老 | short_term.py:21-36；config.py:92 |
| 热（working） | 进程内 | `deque[(text, token_cost)]` + goals，2048 token 预算，超预算从最老丢 | short_term.py:49-103；config.py:93 |
| 温（episodic/semantic） | SQLite **同一文件** | WAL 模式，`events` / `facts` 两表 + 进程内 numpy 索引 | db.py:27-57, 81-89 |
| 冷（archive） | **同一个 SQLite 文件的 `archive` 表** | 摘要 + 向量；不是对象存储、不是另一个 DB、不是压缩格式 | db.py:59-68；archive.py:41-64 |

**要点：所谓"冷"不是介质分离，只是"摘要化 + 从 events 表删除"。** 没有 S3/Parquet/独立冷库，也没有冷层专属的压缩策略；`token_estimate` 只是一个记账字段（manager.py:185）。

**迁移触发：只有一个条件，且只对一层生效。**

```python
# manager.py:163-171
if not self.config.compaction.enabled: return 0
if self.episodic.count() > cc.episodic_threshold:   # 默认 200
    archived += self._compact_episodic()
return archived
```

- `episodic_threshold = 200`（config.py:84）→ 唯一实际生效的迁移阈值。
- **`semantic_threshold = 500` 是死配置**（config.py:85；grep 显示全仓库无读取方）→ **语义层永不被归档**。一个长跑 agent 的 facts 表只增不减，而 `IntegrityGuard._check_contradiction` 每次都 `all_valid(limit=500)` 全量重嵌入（guard.py:138-144）→ 检查成本随事实数线性上升（【推断】，代码路径明确）。
- 迁移粒度：一次取最老 `batch_size=50` 条，`exclude_recent=50` 保护最近 50 条（manager.py:175；config.py:86-87；`EpisodicStore.oldest` 见 episodic.py:92-99）。
- 每次 `maybe_compact()` **只处理 episodic 一次**，不循环、不处理语义层（manager.py:163-171）。

---

### §3 离线 compaction 归档

**何时跑：不是离线、也不是后台——在每个 turn 的请求热路径上同步执行。**

【代码】`orchestrator.py:106` 在生成+反思之后直接 `self.memory.maybe_compact()`。没有定时器、没有 worker、没有"离线批处理"入口（CLI 的 `reflex eval` 只跑基准，不触发 compaction）。

**怎么合并：**

```python
# manager.py:173-190（节选）
batch   = self.episodic.oldest(cc.batch_size, exclude_recent=cc.keep_recent)
summary = self._summarize([e.content for e in batch])
record  = ArchiveRecord(summary=summary,
                        origin_tier=MemoryTier.EPISODIC,
                        span_start=min(e.ts for e in batch),
                        span_end=max(e.ts for e in batch),
                        source_ids=[e.id for e in batch],
                        token_estimate=estimate_tokens(summary))
self.archive.add(record)
self.episodic.delete([e.id for e in batch])
```

**保留什么：只有 summary 文本 + 溯源信息**（`span_start/span_end/source_ids`）。原始 `content`、`role`、`importance`、`metadata` 全部丢失。

**最关键的实现缺陷（【代码】）：默认摘要器是截断拼接，且生产路径也用它。**

```python
# manager.py:49-52
def _default_summarizer(texts):
    joined = " | ".join(t.strip().replace("\n", " ") for t in texts if t.strip())
    return f"Summary of {len(texts)} records: {joined[:800]}"    # ← 硬上限 800 字符
```

- `MemoryManager.__init__` 用 `summarizer or _default_summarizer`（manager.py:69）。
- **`Agent` 构造时并不注入 summarizer**：`MemoryManager(config.memory, self.embedder)`（agent.py:49），只有位置参数，没有 `summarizer=`。
- 而 manager 文档声称 "the agent wires an LLM-backed summariser in production"（manager.py:13-15）。
- → **无论离线还是接真模型，50 条事件永远被压成 ≤800 字符的拼接串**。这是"记忆退化"的直接来源，也正是 README:62 声称要解决的问题。

**其他缺口（【代码】+【推断】）：**

- **无二次压缩**：没有任何分支把 archive 再压缩（manager.py:163-190 只处理 episodic）→ 冷层无界增长，只是比事件层慢（推断：50 条 → 1 条，800 字符上限）。
- **非原子**：`archive.add()` 与 `episodic.delete()` 是两条独立 autocommit 语句（db.py:84 `isolation_level=None`，`execute()` 各自 `with self._lock`）。中途崩溃会留下"已归档未删"（重复归档，同源 ids 出现两次）或"删除未归档"（数据丢失）——**没有事务、没有幂等键**（推断，代码路径明确）。
- **没有 tombstone**：明明 SemanticStore 已有 `valid`/`superseded_by` 软删除范式（semantic.py:45-83），events 却用硬删除。

---

## 读取路径

**检索（【代码】`manager.py:128-159`）：**

```text
qvec = embed_one(query)
raw  = episodic.search(qvec, 6) + semantic.search(qvec, 6) + archive.search(qvec, 3)   # 共 15 候选
for hit in raw:
    if hit.score < min_score or hit.record_id in seen: continue      # 先硬过滤，再去重
    recency = exp(-max(0, now - hit.ts) / 86400)                     # 半衰期 1 天
    fused   = 0.85 * hit.score + 0.15 * recency
sort desc; take total_k = 10
```

- **设计上值得抄的一点**：`min_score` 过滤发生在融合**之前**，注释写明意图是 "a recency boost can never resurrect an irrelevant memory"（manager.py:131-134；docs/architecture.md:62-63）。默认 `min_score=0.0`（config.py:77）意味着实际上不过滤——但机制是对的。
- 去重键是 `record_id`（跨层 id 前缀不同，实际不会撞）。
- 冷层记录用 `span_end` 当时间戳（archive.py:82），语义层用 `updated_ts`（semantic.py:107）——**recency 语义在三层之间不一致**（推断）。

**注入形态与预算（【代码】）：**

- 形态：一条 `Role.SYSTEM` 消息，逐行 `[tier:id score=0.87] content`，前缀 "Ground your answer in these; do not invent facts beyond them"（policy.py:61-70；格式化见 types.py:182）。
- 预算：`RetrievalBundle.render(max_chars=4000)` 默认 4000 **字符**，`policy.py:67` 调用时不传参 → 硬编码、不可配置、且是字符而非 token（types.py:177-187）。
- 上下文另有两块：最近 `_PROMPT_RECENT_TURNS = 8` 轮（orchestrator.py:33, 63，同样硬编码），工作记忆的 goals/notes（policy.py:58-59）。`reflection` 类事件注入时被剔除（policy.py:73-75）。

**完整性校验（【代码】`integrity/guard.py:60-81`）：** 4 类确定性检查，**不调用第二次 LLM**——
`fabricated_memory`（引用了"你说过…"但检索上下文最佳相似度 < 0.18，guard.py:110-123）、`low_support`（<0.18 且非记忆引用，124-132）、`factual_drift`（与某条 valid fact 相似度 >0.55 但极性相反，149-163）、`inconsistent_output`（句间相似度 >0.6 且极性相反，172-182）。得分 `1 - max(severity)`（guard.py:80），超 `block_threshold=0.8` 则按 `revise` 重问一次（orchestrator.py:128-162）。

---

## 生命周期规则与参数

全部默认值（`src/reflex/config.py`，`configs/default.yaml` 与文档 `docs/configuration.md` 三处一致）：

| 参数 | 默认 | 含义 | 是否真的被用 |
|---|---|---|---|
| `memory.short_term_capacity` | 40 | 热缓冲条数 | ✅ short_term.py:28 |
| `memory.working_token_budget` | 2048 | 工作记忆 token | ✅ short_term.py:74-77（但 `note()` 无调用方） |
| `memory.promotion_importance` | **0.6** | 声称的晋升阈值 | ❌ **死配置**，无读取方 |
| `retrieval.episodic_k / semantic_k / archive_k` | 6 / 6 / 3 | 各层召回深度 | ✅ manager.py:139-143 |
| `retrieval.total_k` | 10 | 最终注入条数 | ✅ manager.py:157 |
| `retrieval.min_score` | **0.0** | 融合前过滤阈值 | ✅ 但等于不过滤 |
| `retrieval.recency_half_life_s` | 86400（1 天） | recency 指数衰减 | ✅ manager.py:151 |
| `retrieval.recency_weight` | 0.15 | recency 权重 | ✅ manager.py:152 |
| `compaction.enabled` | true | 归档开关 | ✅ manager.py:165 |
| `compaction.episodic_threshold` | 200 | 事件数触发线 | ✅ manager.py:169 |
| `compaction.semantic_threshold` | **500** | 声称的事实数触发线 | ❌ **死配置**，无读取方 |
| `compaction.batch_size / keep_recent` | 50 / 50 | 一次归档量 / 保护最近 | ✅ manager.py:175 |
| `reflection.every_n_turns` | 1 | 反思节流 | ✅ policy.py:44 |
| `reflection.min_importance_to_store` | 0.55 | 事实入库门槛 | ⚠️ 实际比较的是 `confidence`（engine.py:103） |
| `integrity.support_threshold` | 0.18 | 支撑度下限 | ✅ guard.py:110,124 |
| `integrity.block_threshold` | 0.8 | 阻断严重度 | ✅ orchestrator.py:137 |
| `integrity.on_violation` | `revise` | flag / revise / raise | ✅ orchestrator.py:140-161 |
| `integrity.max_revisions` | 1 | 重写次数 | ✅ orchestrator.py:150 |

**时间常量（硬编码，非配置）**：`_PROMPT_RECENT_TURNS = 8`（orchestrator.py:33）；`render(max_chars=4000)`（types.py:177）；`_default_summarizer` 的 800 字符（manager.py:52）；drift 判定阈值 0.5/0.55/0.6（engine.py:94、guard.py:149、guard.py:172）。

**半衰期含义（【推断】）**：`exp(-age/86400)`，即每天衰减到 0.368；因 `recency_weight=0.15`，recency 对融合分最多贡献 0.15，模拟"相关性主导、新近度破平"。

---

## 后台调度

**没有后台任务系统。**（【代码】）

- 无 scheduler、无任务队列、无线程池、无 `asyncio.create_task`。grep `asyncio` 仅命中 CLI 的 `asyncio.run(...)`（cli.py:81, 124, 142, 154）与 OpenAI 客户端的重试 `sleep`（openai_compatible.py:86）。
- 反思与 compaction 都**挂在 turn 上同步执行**（orchestrator.py:95-106），因此它们直接计入用户可见延迟（`AgentTurn.latency_s`，orchestrator.py:116）。README 提到的 "periodically"（README:126）在实现上等于"每轮检查一次"。
- 并发：`Database` 用 `threading.RLock` + `check_same_thread=False`（db.py:77-89），但这只是防止跨线程误用；调用方是单事件循环内的同步调用，**没有真正的并发记忆写入设计**。
- 幂等：无。compaction 无事务、无去重键（见 §3）。
- 失败恢复：**只有"重启时全量重建索引"**（episodic.py:30-39 / semantic.py:30-41 / archive.py:30-39）——O(n) 启动开销，且每次都从 SQLite 读全部 embedding 文本反序列化（db.py:139-142）。

---

## 工程形态与代价

**形态（【代码】）**：纯 Python ≥3.11（pyproject.toml:11），Hatchling 打包，`src/reflex` 布局，严格 mypy（`strict = true`，pyproject.toml:99-106），ruff 规则集齐全（83-91）。
运行依赖仅 6 个：`pydantic>=2.6`、`numpy`、`PyYAML`、`typer`、`rich`、`httpx`（pyproject.toml:33-40）——**无 torch、无 vLLM**（grep 无命中）。所以 README 的 "ROCm-first / AMD Instinct"（README:15, 162-177, 311-329）是**部署建议**而非代码事实；真正跑 ROCm 只需把 `llm.provider` 指向本地 vLLM 的 OpenAI 兼容端点（`llm/openai_compatible.py`）。

**可选 extras（pyproject.toml:42-56）与实际代码的对应**：

| extra | 依赖 | 是否有对应实现 |
|---|---|---|
| `faiss` | faiss-cpu | ✅ `FaissVectorIndex`（vector_index.py:120-196） |
| `embeddings` | sentence-transformers | ✅ `embeddings/sentence_transformers.py` |
| `postgres` | psycopg | ❌ 只有声明；`Database` 仅 SQLite（db.py:72-124，注释自认 "Postgres is intentionally out of scope"，db.py:9-11） |
| `serve` | fastapi + uvicorn | ❌ 无任何 server 代码（grep 无命中） |

**测试**：实测 **105 个 `def test_`**（`Select-String` 计数），与 docs/architecture.md:78 声称的 "105-test suite" 一致。覆盖点包括 compaction 行为（tests/test_memory_manager.py:54-97：阈值触发、禁用为 no-op、归档内容可召回）与 supersession（tests/test_memory_stores.py:85-107）。
⚠️ **未实跑**：本机 Python 3.14 环境缺 `pydantic`/`numpy`，为避免污染环境未安装依赖，故"105 个测试"只有**数目**被证实，**通过状态未验证**。

**性能数字：一个都没有。**（【代码】+【README】）
README:234 自认 "headline results are not yet published … we will not report metrics until each benchmark is stable"。唯一可跑的 `reflex eval` 是 retention 结构（eval/harness.py:99-141：植入 8 条事实 → 100 轮干扰 → 用 probe 查 recall@10），但**默认后端是 mock LLM + hashing embedder**（config.py:48, 61），它测的是"hashing 向量能不能检索到自己的原文"，不是模型记忆能力（【推断】）。→ 任何吞吐/召回率/延迟数字均**未证实**。

**可量化的代价（【代码】+【推断】）**：

| 代价 | 量级 | 证据 |
|---|---|---|
| 检索 | 每查询 3 层各一次全矩阵内积 + argpartition，O(N·d)，N=该层记录数 | vector_index.py:93-111；注释自认适合 "tens of thousands"（:3-4） |
| 启动 | 全量反序列化 embedding 重建索引，O(N) | episodic.py:30-39 等 |
| 存储 | embedding 存 JSON 文本、7 位小数；256 维约 2.5-3 KB/条（推断） | db.py:132-142 |
| 每轮开销 | 1 次 embed + 4 次 SQL + 正则/可选 LLM 抽取 + 同步 compaction | orchestrator.py:56-126 |
| 事实表 | 无归档 + 无去重 → 无限增长；guard 每轮 `all_valid(limit=500)` 全量重嵌入 | config.py:85（死）；guard.py:138-144 |

---

## 可迁移到「本地优先的 DSH 插件」的部件

按"值不值得抄"排序：

1. **融合前硬过滤的打分顺序**（manager.py:148-152）。`min_score` 过滤在 recency 融合之前，一句注释点破了动机："a recency boost can never resurrect an irrelevant memory"。DSH 插件做本地检索时最容易犯的错就是"最近 = 相关"，这个顺序是零成本的解药。**唯一需要改的**：默认 `min_score=0.0` 等于没过滤，应给一个真实的相似度下限。
2. **单文件 SQLite + 启动重建索引**（db.py:27-69, 81-89；episodic.py:30-39）。零服务、零外部依赖、直接落盘到 workspace，天然符合"本地优先"。用"三张表"而不是"三个库/三个后端"，让跨层检索变成三次 `IN` 查询 + 一次内存合并，实现成本极低。**代价**是 O(N) 启动与 O(N) 检索，需在 N 上设硬上限或换 FAISS。
3. **ArchiveRecord 的溯源字段**（types.py:142-152）：`span_start / span_end / source_ids / token_estimate`。摘要记录保留"覆盖了哪些原始 id、哪段时间、估算多少 token"，使 compaction **可审计、可回溯**——这比"只存一段 summary"强得多，是压缩类设计里最小充分的信息集。
4. **（反向借鉴）`valid` / `superseded_by` 软删除**（semantic.py:45-83）。这个范式仓库里已经写好，却只用在了 facts 上、且没有触发者。DSH 插件应把它用到 **events 的降级**上，替换掉 `DELETE FROM events`——保留可逆性，也顺带解决 compaction 非原子的问题（先标 tombstone，再异步清理）。

**明确不该照抄的**：`promotion_importance` 这类"有配置无实现"的旋钮，以及用截断拼接当摘要器（manager.py:49-52）却对外宣称 "autonomous compression"。前者制造虚假可调性，后者直接造成记忆退化。

---

## 未证实·缺口

- **无任何性能/召回数字**：README:234 自认未发布；`reflex eval` 的默认后端（mock LLM + hashing embedder）不足以衡量真实记忆能力【推断】。
- **测试通过状态未验证**：105 个测试函数数目已核实，但因缺 `pydantic`/`numpy` 未实跑。【未证实】
- **无真实用户抱怨**：0 issue 可查（`issues?state=all` 返回 `[]`，`open_issues_count=0`）。"它踩过的坑"只能由我读代码得出（死配置、无去重、破坏性降级、摘要器未接线、语义层不归档），**没有任何外部声音印证**。
- **单一提交者、单日 6 commit**：不存在版本演进史，无法判断哪些设计是"踩坑后改的"。
- **未取 discussions / wiki / PR**：预算内未查（issues 已确认 0）。
- **行为性推断未运行验证**：事实重复入库会累积重复行、compaction 两条语句非原子、recency 语义三层不一致——均为代码路径推断。
- **Postgres / HTTP serve**：只有 `pyproject.toml:46-47` 的 extra 声明，无实现；README 的 "Retrieval: FAISS / pgvector (configurable)"（README:172）中 pgvector 部分**未被代码支持**。

---

## 来源清单

**仓库（clone 后本地取证，commit `39f369a`，main）**
- https://github.com/steavehirramsan/ReFlex.AI
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/README.md （:13, 41-53, 49, 62, 106, 116-126, 162-177, 172, 234, 311-329）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/docs/architecture.md （:10-23, 27-38, 40-51, 53-63, 78）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/src/reflex/types.py （:55-62, 102-152, 160-187）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/src/reflex/config.py （:72-97, 100-111）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/src/reflex/memory/manager.py （:13-15, 49-52, 82-124, 128-190）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/src/reflex/memory/semantic.py （:30-41, 45-83, 91-113）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/src/reflex/memory/episodic.py （:30-39, 43-74, 92-99, 101-123）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/src/reflex/memory/archive.py （:30-39, 41-88）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/src/reflex/memory/db.py （:9-11, 25-69, 72-142）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/src/reflex/memory/short_term.py （:1-7, 21-47, 49-103）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/src/reflex/memory/vector_index.py （:3-5, 93-111, 120-196）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/src/reflex/core/orchestrator.py （:33, 56-126, 128-162）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/src/reflex/core/policy.py （:16-44, 48-80）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/src/reflex/reflection/engine.py （:32-58, 90-127, 131-157）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/src/reflex/integrity/guard.py （:60-81, 99-164, 166-183）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/src/reflex/runtime/agent.py （:49, 88-94）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/src/reflex/eval/harness.py （:99-141）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/src/reflex/llm/mock.py （:27-45）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/pyproject.toml （:6, 11, 33-40, 42-56, 63-64, 99-106）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/configs/default.yaml （:29-62）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/CHANGELOG.md （:7-31）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/tests/test_memory_manager.py （:54-97）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/tests/test_memory_stores.py （:85-107）
- https://github.com/steavehirramsan/ReFlex.AI/blob/main/tests/test_eval.py （:25-38）

**GitHub API**
- https://api.github.com/repos/steavehirramsan/ReFlex.AI （元数据、许可证、星标、issue 计数）
- https://api.github.com/repos/steavehirramsan/ReFlex.AI/issues?state=all （返回空数组，即 0 issue）

**PyPI**
- https://pypi.org/pypi/reflex-memory/json （`info.version = 0.1.0`，仅 0.1.0 一个版本）

**取证环境说明**：源码通过 `git clone` 落在 `D:\tmp\recon-reflex-ai`（临时目录，非委托方项目）；`git fetch --unshallow` 后 `git rev-list --count HEAD = 6`。行号以 commit `39f369a` 为准。
