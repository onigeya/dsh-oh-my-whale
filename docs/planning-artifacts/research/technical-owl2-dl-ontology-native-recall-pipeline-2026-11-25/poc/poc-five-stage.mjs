// End-to-end POC of the five-stage recall pipeline (constraint C1).
//
// Stage 0  consistency gate. Not a truth value: on an inconsistent base
//          every entailment is worthless, so it is checked first.
// Stage 1  coarse recall: broad and unranked, far above the injection budget.
// Stage 2  concept query, three-valued: CERTAIN / REFUTED / POSSIBLE.
// Stage 3  abduction over a sorted signature with the three literature
//          filters: consistent, relevant, subset-minimal.
// Stage 4  partial proof: proved subtree kept, cut frontier named.
// Stage 5  merged recall set handed to the host.
//
// Two design claims the run is meant to support:
// - One forward-chaining engine runs both the OWL 2 RL rules and their
//   false-headed integrity constraints, so a refutation is an IC firing
//   and no second reasoner is needed.
// - A hypothesis may never be the goal itself (relevance). A goal nobody
//   recorded is reported as a gap, not disguised as a delta.

import { Engine } from "./datalog.mjs";
import { rlRules, RDF_TYPE, RDFS_SUBCLASSOF } from "./owl-rl.mjs";

const REL = "T";
const T = function (s, p, o) { return { rel: REL, args: [s, p, o] }; };

const TBOX = [
  T(":Researcher", RDFS_SUBCLASSOF, ":Person"),
  T(":Person", RDFS_SUBCLASSOF, ":Agent"),
  T(":Org", RDFS_SUBCLASSOF, ":Agent"),
  T(":Researcher", "owl:disjointWith", ":Org"),
  T(":Researcher", "owl:disjointWith", ":Place"),
  T(":affiliatedWith", "rdfs:domain", ":Researcher"),
  T(":affiliatedWith", "rdfs:range", ":Org"),
  T(":affiliatedWith", "rdf:type", "owl:FunctionalProperty"),
  T(":bornIn", "rdfs:domain", ":Person"),
  T(":bornIn", "rdfs:range", ":Place"),
  T(":colleagueOf", "rdf:type", "owl:SymmetricProperty"),
  T(":knows", "rdf:type", "owl:TransitiveProperty"),
  T(":studentOf", "owl:inverseOf", ":teacherOf")
];

const ABOX = [
  T(":alice", RDF_TYPE, ":Researcher"),
  T(":alice", ":affiliatedWith", ":lab_a"),
  T(":alice", ":knows", ":bob"),
  T(":bob", RDF_TYPE, ":Researcher"),
  T(":bob", ":knows", ":carol"),
  T(":carol", RDF_TYPE, ":Person"),
  T(":lab_a", RDF_TYPE, ":Org"),
  T(":bob", ":colleagueOf", ":carol"),
  T(":dave", ":bornIn", ":city_x"),
  T(":city_x", RDF_TYPE, ":Place")
];

// Build a belief base from arbitrary triples. The store test hands it triples
// read back from disk, so persistence is checked against exactly the same
// reasoning path the in-memory run uses.
function buildKbFrom(triples) {
  const e = new Engine(rlRules());
  triples.forEach(function (t) { e.addFact(t.rel || REL, t.args, null); });
  const t0 = process.hrtime.bigint();
  e.run();
  e.elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return e;
}

function buildKb(extra) {
  const all = TBOX.concat(ABOX);
  if (extra) extra.forEach(function (f) { all.push(f); });
  return buildKbFrom(all);
}

// ----------------------------------------------------------------
// Signature. Sorts come from the role each constant plays in the
// vocabulary itself, not from a hand-written table, and the OWL/RDFS
// meta vocabulary is never mistaken for a domain predicate.
// ----------------------------------------------------------------
const META_CLASSES = [
  "owl:FunctionalProperty", "owl:SymmetricProperty", "owl:TransitiveProperty",
  "owl:InverseFunctionalProperty", "owl:IrreflexiveProperty", "owl:AsymmetricProperty"
];

// The TBox/ABox boundary, made executable.
//
// A schema axiom is not evidence. If a proof needs T(affiliatedWith rdfs:domain
// Researcher) and the base does not have it, no amount of new observation closes
// that gap: the contract itself is incomplete. Adding it is a contract revision
// (manual review per C4), not an abduction delta. Keeping the two apart is what
// stops the search from inventing pseudo-evidence such as "assume affiliatedWith
// is the inverse of owl:inverseOf".
const TBOX_PREDICATES = [
  RDFS_SUBCLASSOF, "rdfs:domain", "rdfs:range",
  "owl:disjointWith", "owl:equivalentClass", "owl:inverseOf"
];

function isTboxAtom(args) {
  const p = args[1];
  if (TBOX_PREDICATES.indexOf(p) >= 0) return true;
  if (p === RDF_TYPE && META_CLASSES.indexOf(args[2]) >= 0) return true;
  return false;
}

function buildSignature(kb) {
  const classes = [];
  const props = [];
  const indiv = [];
  const seenC = new Set();
  const seenP = new Set();
  const seenI = new Set();
  const add = function (arr, seen, x) { if (typeof x === "string" && !seen.has(x)) { seen.add(x); arr.push(x); } };

  kb.factsOf(REL).forEach(function (f) {
    const a = f.args[0];
    const p = f.args[1];
    const b = f.args[2];
    if (p === RDF_TYPE) {
      if (META_CLASSES.indexOf(b) >= 0) { add(props, seenP, a); return; }
      add(indiv, seenI, a);
      add(classes, seenC, b);
      return;
    }
    if (p === RDFS_SUBCLASSOF || p === "owl:disjointWith" || p === "owl:equivalentClass") {
      add(classes, seenC, a); add(classes, seenC, b); return;
    }
    if (p === "rdfs:domain" || p === "rdfs:range") { add(props, seenP, a); add(classes, seenC, b); return; }
    if (p === "owl:inverseOf") { add(props, seenP, a); add(props, seenP, b); return; }
    if (p === "owl:sameAs" || p === "owl:differentFrom") {
      add(indiv, seenI, a); add(indiv, seenI, b); return;
    }
    add(indiv, seenI, a); add(indiv, seenI, b); add(props, seenP, p);
  });

  // a name used as both class and individual is a modelling error we do not
  // silently repair; the class reading wins because the TBox is authoritative
  return {
    classes: classes,
    props: props,
    indiv: indiv.filter(function (x) { return !seenC.has(x); })
  };
}

function domainFor(sort, sig) {
  if (sort === "class") return sig.classes;
  if (sort === "property") return sig.props;
  if (sort === "individual") return sig.indiv;
  if (sort === "meta") return META_CLASSES.slice();
  if (sort === "meta-or-class") return META_CLASSES.concat(sig.classes);
  return sig.indiv.concat(sig.props).concat(sig.classes);
}

// What sort of constant does this position of this atom expect?
// A variable in predicate position is itself a property; the two object
// positions of such an atom stay unconstrained and are grounded from the
// union of the declared sorts.
function sortOfPosition(atom, idx) {
  const p = atom.args[1];
  if (isVarToken(p)) return idx === 1 ? "property" : "any";
  if (p === RDFS_SUBCLASSOF || p === "owl:disjointWith" || p === "owl:equivalentClass") return "class";
  if (p === "rdfs:domain" || p === "rdfs:range") return idx === 0 ? "property" : "class";
  if (p === "owl:inverseOf") return idx === 1 ? "meta" : "property";
  if (p === "owl:sameAs" || p === "owl:differentFrom") return "individual";
  if (p === RDF_TYPE) return idx === 1 ? "meta" : (idx === 2 ? "meta-or-class" : "individual");
  return "individual";
}

// A hypothesis is only well sorted if every constant it mentions sits in
// the position its predicate declares. This is what stops a delta like
// T(rdf:type, rdf:type, owl:SymmetricProperty), which would declare the
// builtin rdf:type to be a symmetric domain property.
function atomWellSorted(atom, sig) {
  const p = atom.args[1];
  if (isVarToken(p)) return true;
  const allowed = function (v, s) {
    if (s === "any") return true;
    const dom = domainFor(s, sig);
    return dom.indexOf(v) >= 0 || (s === "meta" && META_CLASSES.indexOf(v) >= 0);
  };
  if (p === RDF_TYPE) {
    const o = atom.args[2];
    const metaObject = META_CLASSES.indexOf(o) >= 0;
    if (metaObject) {
      return allowed(atom.args[0], "property");
    }
    return allowed(atom.args[0], "individual") && allowed(o, "class");
  }
  for (let i = 0; i < atom.args.length; i++) {
    if (i === 1) continue;
    const a = atom.args[i];
    if (isVarToken(a)) continue;
    if (!allowed(a, sortOfPosition(atom, i))) return false;
  }
  return true;
}

// ----------------------------------------------------------------
// Stage 0. Consistency gate.
// ----------------------------------------------------------------
function consistencyGate(kb) {
  if (kb.violations.length === 0) return { status: "CONSISTENT" };
  return {
    status: "VIOLATED",
    conflicts: kb.violations.map(function (v) {
      return { rule: v.ruleId, support: v.support.map(function (f) { return f.args.join(" "); }) };
    })
  };
}

// ----------------------------------------------------------------
// Stage 2. Three-valued concept query on a consistent base.
// ----------------------------------------------------------------
function conceptQuery(kb, s, p, o) {
  const gate = consistencyGate(kb);
  if (gate.status !== "CONSISTENT") return { status: "UNRELIABLE", gate: gate };
  if (kb.has(REL, [s, p, o])) return { status: "CERTAIN" };
  const trial = kb.withExtra([{ rel: REL, args: [s, p, o] }]);
  const fresh = trial.violations.slice(kb.violations.length);
  if (fresh.length > 0) {
    return {
      status: "REFUTED",
      via: fresh.map(function (v) { return v.ruleId; }),
      support: fresh[0].support.map(function (f) { return f.args.join(" "); })
    };
  }
  return { status: "POSSIBLE" };
}

function isVarToken(x) { return typeof x === "string" && x.charAt(0) === "?" && x.length > 1; }

function unify(headArgs, goalArgs) {
  const bind = {};
  for (let j = 0; j < headArgs.length; j++) {
    const ha = headArgs[j];
    const ga = goalArgs[j];
    if (isVarToken(ha)) {
      if (Object.prototype.hasOwnProperty.call(bind, ha) && bind[ha] !== ga) return null;
      bind[ha] = ga;
    } else if (ha !== ga) return null;
  }
  return bind;
}

// Ground the body-local variables of every rule that could produce the goal.
function ruleInstances(kb, goalArgs, maxInstances, sig) {
  const cap = maxInstances || 400;
  const out = [];

  for (let r = 0; r < kb.rules.length; r++) {
    const rl = kb.rules[r];
    if (!rl.head || rl.head.rel !== REL) continue;
    if (rl.head.args.length !== goalArgs.length) continue;
    const bind = unify(rl.head.args, goalArgs);
    if (!bind) continue;

    const byVar = {};
    let conflict = false;
    rl.body.forEach(function (at) {
      at.args.forEach(function (a, i) {
        if (!isVarToken(a) || Object.prototype.hasOwnProperty.call(bind, a)) return;
        const s = sortOfPosition(at, i);
        if (byVar[a] === undefined) byVar[a] = s;
        else if (byVar[a] !== s) conflict = true;
      });
    });
    if (conflict) continue;
    const vars = Object.keys(byVar);

    let combos = [Object.assign({}, bind)];
    for (let vi = 0; vi < vars.length; vi++) {
      const v = vars[vi];
      const dom = domainFor(byVar[v], sig);
      const next = [];
      for (let c = 0; c < combos.length && next.length < cap; c++) {
        for (let d = 0; d < dom.length && next.length < cap; d++) {
          const e = Object.assign({}, combos[c]);
          e[v] = dom[d];
          next.push(e);
        }
      }
      combos = next;
      if (combos.length === 0) break;
    }

    combos.forEach(function (full) {
      const body = rl.body.map(function (at) {
        return { rel: at.rel, args: at.args.map(function (a) { return full[a] !== undefined ? full[a] : a; }) };
      });
      // A grounded instance is only a candidate if every atom it would need is
      // itself well sorted. Without this, the goal predicate leaks into schema
      // positions during unification and the search invents axioms such as
      // T(affiliatedWith owl:inverseOf rdf:type).
      if (!body.every(function (at) { return atomWellSorted(at, sig); })) return;
      out.push({ rule: rl.id, ruleName: rl.name, body: body });
    });
    if (out.length >= cap) break;
  }
  return out;
}

// ----------------------------------------------------------------
// Stage 3. Abduction under three filters.
// ----------------------------------------------------------------
function abduce(kb, goalArgs, maxDelta, sig) {
  const cap = maxDelta || 2;
  const goalKey = goalArgs.join(",");
  const accepted = [];
  const rejected = { irrelevant: 0, inconsistent: 0, tooLarge: 0, noEffect: 0, illSorted: 0, tboxGapOnly: 0 };
  const contractGaps = new Map();

  ruleInstances(kb, goalArgs, 400, sig).forEach(function (inst) {
    const missingAll = inst.body.filter(function (at) { return !kb.has(at.rel, at.args); });
    if (missingAll.length === 0) return;

    // Only ABox atoms can be hypothesised. A missing schema axiom is a gap in
    // the contract layer, reported separately and never turned into a delta.
    const schemaMissing = missingAll.filter(function (at) { return isTboxAtom(at.args); });
    if (schemaMissing.length > 0) {
      schemaMissing.forEach(function (at) {
        const k = at.args.join(" ");
        contractGaps.set(k, { axiom: k, neededBy: inst.ruleName, kind: "contractGap" });
      });
      rejected.tboxGapOnly++;
      return;
    }
    const missing = missingAll;
    if (missing.length > cap) { rejected.tooLarge++; return; }

    // relevance: hypothesis may not restate the goal itself
    if (missing.some(function (m) { return m.args.join(",") === goalKey; })) { rejected.irrelevant++; return; }

    // signature discipline: every hypothetical atom must be well sorted
    if (!missing.every(function (m) { return atomWellSorted(m, sig); })) { rejected.illSorted++; return; }

    const trial = kb.withExtra(missing);
    if (!trial.has(REL, goalArgs)) { rejected.noEffect++; return; }
    if (trial.violations.length > kb.violations.length) { rejected.inconsistent++; return; }

    accepted.push({
      rule: inst.rule,
      ruleName: inst.ruleName,
      delta: missing,
      deltaSize: missing.length,
      addsVocabulary: missing.some(function (m) {
        return m.args.some(function (a) { return !kb.hasConstant(a); });
      })
    });
  });

  // subset-minimality over the accepted set
  const kept = [];
  accepted.sort(function (a, b) { return a.deltaSize - b.deltaSize; });
  accepted.forEach(function (c) {
    const ck = c.delta.map(function (m) { return m.args.join(","); });
    const dominated = kept.some(function (k) {
      if (k.deltaSize > c.deltaSize) return false;
      const kk = k.delta.map(function (m) { return m.args.join(","); });
      return kk.every(function (x) { return ck.indexOf(x) >= 0; });
    });
    if (!dominated) kept.push(c);
  });
  kept.sort(function (a, b) {
    if (a.addsVocabulary !== b.addsVocabulary) return a.addsVocabulary ? 1 : -1;
    return a.deltaSize - b.deltaSize;
  });
  // Which contract gaps are worth reporting? Only the ones whose supply would
  // actually close this goal. A missing axiom that would not change the answer
  // is incidental: naming it would bury the one gap that matters, which is how
  // a gap report turns into noise nobody reads.
  const gapList = Array.from(contractGaps.values());
  const closable = [];
  gapList.forEach(function (g) {
    const parts = g.axiom.split(" ");
    const probe = kb.withExtra([{ rel: REL, args: parts }]);
    const closes = probe.has(REL, goalArgs);
    if (closes) closable.push({ axiom: g.axiom, neededBy: g.neededBy, kind: "contractGap", closesGoal: true });
  });

  return {
    deltas: kept,
    rejected: rejected,
    // Gaps in the contract layer, distinct in kind from missing observations.
    // They are reported upward, never silently repaired by a hypothetical fact.
    contractGaps: closable,
    contractGapCandidates: gapList.length,
    best: kept.length > 0 ? kept[0] : null
  };
}

// ----------------------------------------------------------------
// Stage 4. Partial proof by near-miss expansion.
// The rule instance that comes closest to firing is expanded; premises
// already entailed become PROVED leaves, premises supplied by the Stage 3
// delta become ASSUMED leaves, and whatever remains is the cut frontier.
// The proved part is never thrown away, and Stage 4 never searches again for
// what Stage 3 already found.
// ----------------------------------------------------------------
function partialProof(kb, goalArgs, depth, sig, assume) {
  const d = depth === undefined ? 4 : depth;
  const assumedSet = new Set((assume || []).map(function (m) { return m.args.join(" "); }));

  const proveAttached = function (args, level, path) {
    const key = args.join(" ");
    if (path.indexOf(key) >= 0) return { key: key, status: "PROVED", note: "cycle-closed" };
    if (!kb.has(REL, args)) {
      if (assumedSet.has(key)) return { key: key, status: "ASSUMED", source: "abduced-delta" };
      return null;
    }
    const tree = kb.proofTree(REL, args, 32);
    if (!tree || tree.leaf || tree.cut) return { key: key, status: "PROVED", leaf: true };
    const kids = (tree.children || []).map(function (c) {
      const sub = proveAttached(c.args, level + 1, path.concat([key]));
      return sub || { key: c.args.join(" "), status: "PROVED", leaf: true };
    });
    return { key: key, rule: tree.ruleName, status: "PROVED", children: kids };
  };

  const walk = function (args, level, path) {
    const attached = proveAttached(args, level, path);
    if (attached) return attached;

    const key = args.join(" ");

    // A missing schema axiom is a different kind of hole from a missing
    // observation: no future observation closes it. Recursing into it would
    // expand owl:inverseOf forever and dress the result up as evidence.
    if (isTboxAtom(args)) {
      return { key: key, status: "GAP", reason: "contract-gap", gapKind: "missingContractAxiom" };
    }
    if (level >= d) return { key: key, status: "GAP", reason: "depth-cap" };

    const insts = ruleInstances(kb, args, 200, sig);
    let best = null;
    insts.forEach(function (inst) {
      const missing = inst.body.filter(function (at) { return !kb.has(at.rel, at.args); });
      if (missing.length === 0) return;
      // Prefer the instance the abduction already priced: its missing premises
      // are exactly the delta, so the proof displays the delta as the one thing
      // standing between the base and the conclusion.
      const fullyAssumed = missing.every(function (m) { return assumedSet.has(m.args.join(" ")); });
      const score = (fullyAssumed ? 0 : 1000) + missing.length;
      if (!best || score < best.score) best = { inst: inst, missing: missing, score: score };
    });
    if (!best) return { key: key, status: "GAP", reason: "no-applicable-rule" };

    const kids = best.inst.body.map(function (at) {
      const sub = walk(at.args, level + 1, path.concat([key]));
      return sub;
    });
    return { key: key, rule: best.inst.ruleName, status: "CONDITIONAL", children: kids };
  };

  const tree = walk(goalArgs, 0, []);
  const cutFrontier = [];
  const collect = function (n) {
    if (!n) return;
    if (n.status === "GAP") { cutFrontier.push({ goal: n.key, reason: n.reason }); return; }
    if (n.children) n.children.forEach(collect);
  };
  collect(tree);

  const proved = [];
  const assumed = [];
  const collectProved = function (n) {
    if (!n) return;
    if (n.status === "PROVED") { proved.push(n.key); return; }
    if (n.status === "ASSUMED") { assumed.push(n.key); return; }
    if (n.children) n.children.forEach(collectProved);
  };
  collectProved(tree);

  // The three outcomes a caller can act on: the claim holds on what is stored,
  // it holds only if the delta is granted, or it does not close at all.
  let status = "PROVED";
  if (cutFrontier.length > 0) status = "GAP";
  else if (assumed.length > 0) status = "CONDITIONAL";

  return {
    tree: tree,
    status: status,
    cutFrontier: cutFrontier,
    provedLeaves: proved,
    assumedLeaves: assumed,
    contractGaps: cutFrontier.filter(function (g) { return g.reason === "contract-gap"; })
  };
}

// ----------------------------------------------------------------
// Stage 1. Coarse recall: coverage, not focus.
// ----------------------------------------------------------------
function coarseRecall(kb, seeds, hopLimit) {
  const hop = hopLimit || 3;
  const seen = new Set();
  const seenFact = new Set();
  const out = [];
  const queue = seeds.map(function (s) { return { node: s, d: 0 }; });
  while (queue.length) {
    const cur = queue.shift();
    if (seen.has(cur.node)) continue;
    seen.add(cur.node);
    if (cur.d >= hop) continue;
    kb.factsOf(REL).forEach(function (f) {
      if (f.args[0] !== cur.node && f.args[2] !== cur.node) return;
      if (!seenFact.has(f.key)) { seenFact.add(f.key); out.push(f); }
      const other = f.args[0] === cur.node ? f.args[2] : f.args[0];
      if (typeof other === "string" && other.charAt(0) === ":" && !seen.has(other)) {
        queue.push({ node: other, d: cur.d + 1 });
      }
    });
  }
  return out;
}

// ----------------------------------------------------------------
// Driver
// ----------------------------------------------------------------
const R = {};
const kb = buildKb();
const sig = buildSignature(kb);
R.signature = { classes: sig.classes, props: sig.props, individuals: sig.indiv };
R.kb = { facts: kb.facts.size, violations: kb.violations.length, rounds: kb.rounds, ms: Number(kb.elapsedMs.toFixed(3)) };
R.stage0 = consistencyGate(kb);

R.stage2 = [
  [":alice", RDF_TYPE, ":Agent"],
  [":alice", RDF_TYPE, ":Place"],
  [":lab_a", RDF_TYPE, ":Researcher"],
  [":carol", RDF_TYPE, ":Agent"],
  [":dave", RDF_TYPE, ":Person"],
  [":dave", RDF_TYPE, ":Researcher"],
  [":bob", ":teacherOf", ":carol"],
  [":alice", ":knows", ":carol"]
].map(function (q) {
  const r = conceptQuery(kb, q[0], q[1], q[2]);
  return { query: q.join(" "), status: r.status, via: r.via || null };
});

const shrink = function (a) {
  return {
    rejected: a.rejected,
    count: a.deltas.length,
    deltas: a.deltas.slice(0, 5).map(function (x) {
      return { rule: x.rule, delta: x.delta.map(function (m) { return m.args.join(" "); }), size: x.deltaSize };
    }),
    contractGaps: a.contractGaps
  };
};

R.stage3_daveResearcher = shrink(abduce(kb, [":dave", RDF_TYPE, ":Researcher"], 2, sig));
R.stage3_bobTeacherOfCarol = shrink(abduce(kb, [":bob", ":teacherOf", ":carol"], 2, sig));

// Stage 4 consumes Stage 3 result: the abduced delta is granted as an
// assumption, so the proof shows exactly which premise it replaces.
const g1 = [":dave", RDF_TYPE, ":Researcher"];
const ab1 = abduce(kb, g1, 2, sig);
const pp = partialProof(kb, g1, 3, sig, ab1.best ? ab1.best.delta : []);
R.stage4 = {
  goal: g1.join(" "),
  status: pp.status,
  proved: pp.provedLeaves,
  assumed: pp.assumedLeaves,
  cutFrontier: pp.cutFrontier,
  contractGaps: pp.contractGaps
};

R.stage4_proved = [
  [":dave", RDF_TYPE, ":Person"],
  [":alice", RDF_TYPE, ":Agent"],
  [":alice", ":knows", ":carol"]
].map(function (g) {
  const t = partialProof(kb, g, 3, sig, []);
  return { goal: g.join(" "), status: t.status, frontier: t.cutFrontier.length };
});

// A goal no observation can close: the class hierarchy says nothing about
// dave and no property would ever put him in Place.
const hard = partialProof(kb, [":dave", RDF_TYPE, ":Place"], 3, sig, []);
R.stage4_unclosable = {
  goal: ":dave rdf:type :Place",
  status: hard.status,
  frontier: hard.cutFrontier
};

const cr = coarseRecall(kb, [":alice", ":dave"], 2);
R.stage5 = {
  coarseCount: cr.length,
  injectionBudget: 5,
  hardCap: 8,
  sampleFirst: cr.slice(0, 4).map(function (f) { return f.args.join(" "); })
};

const incon = buildKb([T(":alice", RDF_TYPE, ":Org")]);
R.inconsistentBase = {
  gate: consistencyGate(incon),
  queryOnInconsistent: conceptQuery(incon, ":alice", RDF_TYPE, ":Agent").status
};

const fp = buildKb([T(":alice", ":affiliatedWith", ":lab_b")]);
R.functional = {
  violations: fp.violations.length,
  sameAs: fp.has(REL, [":lab_a", "owl:sameAs", ":lab_b"]),
  labAIsResearcher: conceptQuery(fp, ":lab_a", RDF_TYPE, ":Researcher").status
};

// Only print when run directly: importing this module must not emit output.
const invokedDirectly = process.argv[1] && import.meta.url === "file:///" + process.argv[1].replace(/\\/g, "/");
if (invokedDirectly) console.log(JSON.stringify(R, null, 2));

export {
  buildKb, buildKbFrom, buildSignature, consistencyGate, conceptQuery,
  abduce, shrink, partialProof, coarseRecall,
  TBOX, ABOX, T, REL, isTboxAtom, TBOX_PREDICATES, META_CLASSES
};
