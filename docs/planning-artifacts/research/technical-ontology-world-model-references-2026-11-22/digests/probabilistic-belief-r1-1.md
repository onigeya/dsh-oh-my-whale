# Digest — probabilistic belief & sleep consolidation (assistant prob-memory, round 1)

Topic: Nous (nous-state), Anda Hippocampus (anda-brain), probabilistic memory practice
Decision served: whether to adopt distributional beliefs + consolidation loop in a private knowledge base
Accessed: 2026-11-22. All claims below are from sources read this run.

## Findings

1. **"Nous" exists, but the table's GitHub link is wrong.** PyPI `nous-state` 0.2.0 is real (MIT, author Pranav Singh, homepage → arXiv:2606.22030); the repo is `github.com/Pranavsingh431/nous-state`, not `pranav-singh/nous` (404). README pipeline: `LLMExtractor → (entity, attribute, value) → BayesianUpdater → surprise → posterior`, stored as `Dimension` (probability distribution) + `Delta` (immutable history) + SQLite DeltaLog. API: `observe/predict/query_at/history/explain/surprise/get_coupling/apply_decay`. Maturity is very low: 2★, single author, preprint, README says "first public report — not a final or fully audited result".
2. **anda-brain sleep is real, and the triggers are event counts, not a clock.** README: `daydream` every 21 formed conversations or on demand; `quick` every 42; `full` every 168 and at most once per Space per 24h. Each round runs a **deterministic settlement** in the host (correction registration, dependency traversal for revised assertions, due Commitments, retention expiry, assessment) before the Maintenance agent does cognitive work (event clustering into derived claims with lineage, identity merge, stale marking, repeated success/failure → *unproven* Skill candidates, retention/vocabulary review, self-test recall). Code: `anda_brain/src/memory_interface/{intake,forget,recall,sources,mod}.rs`, `assets/CognitiveMemoryProfile-2.0.md` (53KB).
3. **Raw episodes kept, auditable, and "forgetting ≠ changing truth".** README: "Forgetting is about accessibility, never truth… an Assertion's confidence never decays"; "Reading never reinforces"; "Maintenance never purges memory". Strength is computed at read time from disuse; `asserted_at` records observation time, not write time. Activity records every formation/consolidation/revision; AndaDB versioned graph + experiment snapshots allow replay.
4. **"Dual ontology (neural + symbolic)" is rhetoric.** README means "burn electricity → neural network ontology; burn tokens → symbolic network ontology". Only the symbolic side exists: Concept / Proposition / Assertion / Evidence / Activity plus LLM extraction and query planning. No neural ontology representation, no joint inference.
5. **Neither project uses Beta/Dirichlet.** nous-state is a categorical distribution updated by multiplying floats and renormalising (`O(k) writes`), with entropy decay for forgetting — no conjugate prior, no evidence counts. anda-brain uses subjective confidence (an actor's stance on a proposition) that explicitly does not decay — opposite direction. Comparable practice: MemoryBank uses an Ebbinghaus curve over elapsed time and importance (arXiv:2305.10250, 2023-05-17); Generative Agents score by importance/recency/relevance and synthesise reflections (arXiv:2304.03442, 2023-04-07).

## Claims

| claim | source | date | conf |
|---|---|---|---|
| nous-state 0.2.0 on PyPI; repo Pranavsingh431/nous-state (2★) | https://pypi.org/pypi/nous-state/json | 2026-10-04 | high |
| nous uses categorical + renormalise, not Beta/Dirichlet; has delta log and query_at | https://pypi.org/project/nous-state | 2026 | medium |
| anda-brain sleep tiers: 21/42/168 conversations + 24h floor | https://github.com/ldclabs/anda-brain README | 2026-11-19 | high |
| settlement is deterministic host work; model does cognitive work only | same | 2026-11-19 | high |
| assertion confidence never decays; strength computed at read; reads do not reinforce | same | 2026-11-19 | high |
| anda-brain v0.13.7 (2026-11-19), Rust, Apache-2.0, 87★, created 2026-03-11 | CHANGELOG.md / GitHub API | 2026-11-19 | high |
| MemoryBank uses Ebbinghaus forgetting curve | https://arxiv.org/abs/2305.10250 | 2023-05-17 | high |
| Generative Agents have a reflection layer | https://arxiv.org/abs/2304.03442 | 2023-04-07 | high |

## Hype vs implementation

1. "dual ontology / neural + symbolic" → symbolic graph + LLM extraction only.
2. "surprise-driven updates" (nous) → surprise appears in `explain` and delta metadata; README does not show it gating writes or consolidation depth.
3. "bio-inspired sleep" → triggers are business event counts (21/42/168), not circadian rhythm or token budget; "dream" has no random recombination or counterfactual generation, only clustering and review.
4. "probabilistic entity attributes" → categorical point probabilities, not uncertainty intervals; nous itself concedes "garbage extraction → garbage beliefs".

## Open questions / not found

- Location of the 21/42/168 constants in anda-brain source not confirmed by the assistant (GitHub API timeouts); lead to grep the clone.
- No LLM memory project found using Beta/Dirichlet conjugate priors; GitHub search for "probabilistic world model memory" returned 3 irrelevant results.
- AGM belief revision / subjective logic / truth-discovery papers were not read this round — no conclusion drawn.
- nous-state wheel source not unpacked; Bayesian update formula has README-level evidence only.

## One-line decision input

Worth copying: **Assertion/Evidence separation + read-time projection of belief** (explainable, auditable, no probability needed) and **tiered consolidation budget with deterministic settlement separated from model work**. Not recommended: a point-probability categorical layer — false precision, debugging cost exceeds benefit.
