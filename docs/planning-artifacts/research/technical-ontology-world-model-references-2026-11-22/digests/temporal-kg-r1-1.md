# Digest — temporal world model (assistant temporal-kg, round 1)

Topic: Graphiti (getzep/graphiti), Utopia (deeplethe/utopia), AriGraph (AIRI-Institute/AriGraph)
Accessed: 2026-11-22.

## Findings

1. **Graphiti's bi-temporality is three axes, not two.** `EntityEdge` carries `expired_at` (transaction time: when Graphiti marked it invalid), `valid_at`/`invalid_at` (world time: when the fact became/stopped being true) and `reference_time` (episode reference time); nodes carry `created_at` (write time). Source says "soft deadlines are not invalid_at". `_apply_temporal_invalidation` only writes `invalid_at`/`expired_at`, never deletes the edge — soft invalidation, not rewrite.
2. **Contradiction resolution sorts by world time, not ingestion order.** If the new edge contradicts a candidate whose `valid_at` is later, the *new* edge gets invalidated (`resolved_edge.invalid_at = candidate.valid_at`), then `resolve_edge_contradictions` runs. "The later fact wins", so back-filled old evidence never overwrites a newer fact. This is the minimal mechanism for "facts expire as evidence arrives", but it depends entirely on the LLM extracting dates correctly; a wrong date is a silent misjudgment.
3. **Default search does not filter to currently-valid edges.** With `search_filter=None` `search()` passes an empty `SearchFilters()`; `IS NULL` appears zero times in `search_utils.py`/`search.py`/`search_config.py`. Getting "true now" requires passing `invalid_at`/`expired_at` comparisons yourself. README's "Query what's true now" is a capability, not a default — the easiest trap to step in.
4. **Ontology constraints sit in the write path, not in the prompt.** `enforce_edge_type_signatures` validates extracted edges against `edge_type_map` (endpoint-type signature → edge type): on mismatch, strict mode drops the edge, otherwise it renames it to `DEFAULT_EDGE_NAME`; attributes are validated by Pydantic models. Four layers: Episodic (raw content + source + valid_at, the provenance anchor), Entity (name/group_id/created_at/summary), EntityEdge (fact + four timestamps + attributes), Community (cluster summary). MCP/REST are reference implementations; README concedes they do not defend against prompt injection.
5. **Utopia does not put its bitemporal graph in a graph database.** One Rust binary + one Postgres: Tantivy full-text, pgvector, RRF fusion, job queue as a plain table; edges are reified — a correction closes the old version and links the new one instead of overwriting. Conflict detection offers three choices (close old / coexist / reject new; for axiom conflicts: retract / relax / coexist), plus an append-only decision ledger (who, when, snapshot of the objects as they were). MCP is one `POST /api/v1/kbs/{kb_id}/mcp` per KB, JSON-RPC 2.0, stateless HTTP, protocol `2025-06-18`; tools include `search_chunks` (supports `as_of`) and `remember` (needs write scope and **human approval** before entering the graph).
6. **"SHACL ontology constraints" for Utopia has no documentary evidence.** SHACL appears zero times in README and mcp.md; the ontology is ontology packs (schema.org, W3C Org, PROV-O, FOAF, IOF Core) + axioms (transitive/symmetric/inverse/hierarchy) + cardinality constraints. Self-described v0.1, forward-only migrations; roadmap item "Agent memory over MCP" (episode write, retrieve) still unchecked. AriGraph: 177★, last commit 2024-09-10, code is agents/envs/graphs(TripletGraph)/prompts/logs — the "world model" is the memory graph itself, no forward simulation; gains concentrate in TextWorld (1.0/0.79/1.0 vs RAG 0.33/0.35/0.36), QA only "comparable" (GPT-4 MuSiQue 37.0 EM vs HOLMES 48.0).

## Claims

| claim | source | date | conf |
|---|---|---|---|
| expired_at=transaction time, valid_at/invalid_at=world time, reference_time=episode time | graphiti_core/edges.py L236-256 | 2026-11-20 | high |
| invalidation is soft (writes invalid_at/expired_at only, never deletes) | utils/maintenance/edge_operations.py L762-796 | 2026-11-20 | high |
| candidate with later valid_at back-fills invalidation onto the new edge | same L778-790 | 2026-11-20 | high |
| default search has no implicit validity filter (IS NULL count 0) | search/{search_utils,search,search_config}.py; graphiti.py L2242 | 2026-11-20 | high |
| edge type signatures enforced on the write path (drop or rename) | edge_operations.py L718-745 | 2026-11-20 | high |
| Graphiti 32,995★, v0.31.2, pushed 2026-11-20 | api.github.com/repos/getzep/graphiti | 2026-11-20 | high |
| Utopia: single binary + Postgres/pgvector/Tantivy, reified edges | README Features | 2026-11-22 | high |
| Utopia conflict three-way choice + append-only ledger | README Features | 2026-11-22 | high |
| Utopia MCP per KB, JSON-RPC 2.0, remember needs human approval | web/src/docs/mcp.md | 2026-11-22 | high |
| Utopia v0.1, forward-only migrations | README Status | 2026-11-22 | high |
| SHACL absent from Utopia docs | README + mcp.md, 0 hits | 2026-11-22 | medium |
| AriGraph 177★, last commit 2024-09-10 | api commits | 2024-09-10 | high |
| AriGraph has no simulation module, TextWorld pipeline only | README repo structure | 2024-09 | medium |

## Hype vs implementation

- Graphiti "query what's true now": capability exists, but default queries are unfiltered; invalidated facts can leak into results.
- Graphiti "bi-temporal": actually three axes; docs underplay `expired_at`.
- Utopia "SHACL constraints": zero mention in README/MCP docs; ontology is packs + axioms + cardinality. Not confirmed.
- Utopia "world model / decision simulation": README marks it in development, roadmap unchecked; today it is a bitemporal KB + audit trail, not a predictive model.
- AriGraph "world model": just the memory graph, no forward simulation; project is dormant.

## Open questions

- Whether Utopia implements a SHACL subset in Rust: GitHub API rate-limited for the assistant; lead has the clone and will settle it.
- Utopia issues' known pitfalls: not read (rate limit).
- Graphiti community-rebuild trigger frequency and cost: scheduler source not read.
- AriGraph paper limitations: only abstract + README read, not the PDF body.
