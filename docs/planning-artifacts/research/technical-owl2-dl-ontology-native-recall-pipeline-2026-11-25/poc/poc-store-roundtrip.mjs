// Store round-trip test: does triviumdb hold an OWL 2 TBox/ABox natively?
//
// The in-memory run proves the semantics. This proves the storage claim of
// constraint C2: the same axioms written to disk, read back through the
// public graph API alone, and re-reasoned must reach the same answers. Any
// divergence means the schema does not carry the ontology.

import fs from "node:fs";
import path from "node:path";
import { TripleStore } from "./store-triviumdb.mjs";
import {
  buildKb, buildKbFrom, buildSignature, consistencyGate, conceptQuery,
  TBOX, ABOX, REL
} from "./poc-five-stage.mjs";

// triviumdb takes a file path, not a directory: the database is one file plus
// a companion .idx sidecar, so both must be measured and removed together.
const DIR = path.resolve(".tdb-store-test.tdb");
const OUT = {};

// One database is a whole family of companion files (idx, wal, pld.N, vec,
// lock, flush_ok), so cleanup and measurement both match by prefix.
function artifacts() {
  const dir = path.dirname(DIR);
  const stem = path.basename(DIR);
  return fs.readdirSync(dir)
    .filter(function (n) { return n === stem || n.indexOf(stem + ".") === 0 || n.indexOf(stem + "-") === 0; })
    .map(function (n) { return path.join(dir, n); });
}

function clean() {
  artifacts().forEach(function (p) {
    try { fs.rmSync(p, { force: true, recursive: true }); } catch (e) { /* locked */ }
  });
}

function diskBytes() {
  return artifacts().reduce(function (n, p) {
    const s = fs.statSync(p);
    return n + (s.isFile() ? s.size : 0);
  }, 0);
}

function digest(kb) {
  const sig = buildSignature(kb);
  const queries = [
    [":alice", "rdf:type", ":Agent"],
    [":alice", "rdf:type", ":Place"],
    [":lab_a", "rdf:type", ":Researcher"],
    [":carol", "rdf:type", ":Agent"],
    [":dave", "rdf:type", ":Person"],
    [":dave", "rdf:type", ":Researcher"],
    [":bob", ":teacherOf", ":carol"],
    [":alice", ":knows", ":carol"]
  ];
  return {
    facts: kb.facts.size,
    rounds: kb.rounds,
    ms: Number(kb.elapsedMs.toFixed(3)),
    violations: kb.violations.length,
    gate: consistencyGate(kb).status,
    signature: { classes: sig.classes.length, props: sig.props.length, individuals: sig.indiv.length },
    answers: queries.map(function (q) {
      return { q: q.join(" "), status: conceptQuery(kb, q[0], q[1], q[2]).status };
    })
  };
}

// ---- 1. write the ontology through the store ----------------------
clean();
const t0 = process.hrtime.bigint();
const store = new TripleStore(DIR, 1);
store.db.createIndex("kind");
TBOX.concat(ABOX).forEach(function (t) { store.assert(t.args[0], t.args[1], t.args[2]); });
const writeMs = Number(process.hrtime.bigint() - t0) / 1e6;
const diskAfterWrite = diskBytes();
OUT.write = {
  axioms: TBOX.length + ABOX.length,
  storeWrites: store.writes,
  ms: Number(writeMs.toFixed(3)),
  bytesOnDisk: diskAfterWrite
};
store.close();

// ---- 2. reopen and read back --------------------------------------
const t1 = process.hrtime.bigint();
const reopened = new TripleStore(DIR, 1);
const nodeCount = reopened.reload();
const triples = reopened.allTriples();
const readMs = Number(process.hrtime.bigint() - t1) / 1e6;
OUT.readBack = {
  nodes: nodeCount,
  triples: triples.length,
  expected: TBOX.length + ABOX.length,
  ms: Number(readMs.toFixed(3))
};

// ---- 3. reason over the reloaded triples ---------------------------
const kbDisk = buildKbFrom(triples.map(function (t) { return { rel: REL, args: t }; }));
const kbMem = buildKb();
OUT.memory = digest(kbMem);
OUT.fromDisk = digest(kbDisk);

// ---- 4. compare ----------------------------------------------------
const diffs = [];
OUT.memory.answers.forEach(function (a, i) {
  const b = OUT.fromDisk.answers[i];
  if (a.status !== b.status) diffs.push({ goal: a.q, memory: a.status, fromDisk: b.status });
});
if (OUT.memory.gate !== OUT.fromDisk.gate) diffs.push({ gate: OUT.memory.gate, fromDisk: OUT.fromDisk.gate });
if (OUT.memory.violations !== OUT.fromDisk.violations) diffs.push({ violations: OUT.memory.violations, fromDisk: OUT.fromDisk.violations });
OUT.divergence = { count: diffs.length, diffs: diffs };

// ---- 5. role lookup through the persistent index -------------------
OUT.roles = {
  classes: reopened.query("class").length,
  properties: reopened.query("property").length,
  individuals: reopened.query("individual").length,
  metaclasses: reopened.query("metaclass").length
};

reopened.close();
clean();

console.log(JSON.stringify(OUT, null, 2));
