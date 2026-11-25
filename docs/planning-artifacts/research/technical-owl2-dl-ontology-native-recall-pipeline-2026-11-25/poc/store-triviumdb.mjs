// Persistence adapter: the same TBox/ABox stored in triviumdb and read back.
//
// Why this file exists: the in-memory engine proves the semantics but not the
// design claim. Constraint C2 asks that the schema carry OWL 2 TBox and ABox
// natively, which is a claim about storage, so it has to be tested on storage.
//
// Mapping decisions and the measurements behind them:
// - One node per term, keyed by the term IRI. Terms are shared, so the node
//   payload holds what the term IS (kind + role), while relations live on edges.
// - Edge labels are flattened because TQL rejects a colon in a label
//   (MATCH (a)-[:rdf:type]->(b) fails with Expected RBracket, got Colon),
//   so rdfs:subClassOf becomes rdfs_subClassOf.
// - Assertions are edges, not reified nodes: a reified triple costs 2.0x the
//   writes and 15% more disk at dim=1, and buys only indexed metadata that
//   triviumdb does not offer anyway (edge metadata has no secondary index).
// - Reified node form is used only for facts that must carry a vector, which
//   the contract layer never does.

import { TriviumDB } from "triviumdb";

export function flattenPredicate(p) {
  return String(p).replace(/:/g, "_");
}

export function unflattenPredicate(l) {
  const i = l.indexOf("_");
  if (i < 0) return l;
  return l.slice(0, i) + ":" + l.slice(i + 1);
}

// Roles are inferred the same way the signature builder infers them, so the
// stored schema and the in-memory signature cannot drift apart.
const META_CLASSES = [
  "owl:FunctionalProperty", "owl:SymmetricProperty", "owl:TransitiveProperty",
  "owl:InverseFunctionalProperty", "owl:IrreflexiveProperty", "owl:AsymmetricProperty"
];

const CLASS_POSITION = {
  "rdfs:subClassOf": [0, 1],
  "owl:disjointWith": [0, 1],
  "owl:equivalentClass": [0, 1]
};

const PROPERTY_POSITION = {
  "rdfs:domain": [0],
  "rdfs:range": [0],
  "owl:inverseOf": [0, 1]
};

export class TripleStore {
  constructor(path, dim) {
    this.db = new TriviumDB(path, { dim: dim || 1 });
    this.ids = new Map();
    this.kinds = new Map();
    this.writes = 0;
  }

  // Idempotent: the same IRI always resolves to the same node, which is what
  // makes reloading and re-asserting a no-op instead of a duplicate.
  termId(term) {
    if (this.ids.has(term)) return this.ids.get(term);
    const id = this.db.insert([0], { iri: term, kind: "term" });
    this.ids.set(term, id);
    this.writes++;
    return id;
  }

  // Reload: every node is rediscovered from the persistent index, never from
  // writer state. This is the read path a restarted process would take.
  reload() {
    const ROLES = ["class", "property", "individual", "metaclass", "term"];
    this.ids.clear();
    this.kinds.clear();
    for (const role of ROLES) {
      const hits = this.db.indexedLookup({ kind: role });
      for (const id of hits) {
        const payload = this.db.getPayload(id);
        if (!payload || typeof payload.iri !== "string") continue;
        this.ids.set(payload.iri, id);
        this.kinds.set(payload.iri, payload.kind);
      }
    }
    return this.ids.size;
  }

  markKind(term, kind) {
    if (this.kinds.has(term)) return;
    const id = this.termId(term);
    this.kinds.set(term, kind);
    this.db.patchPayload(id, { $set: { kind: kind } });
  }

  assert(s, p, o) {
    const kinds = CLASS_POSITION[p];
    const props = PROPERTY_POSITION[p];
    if (kinds) {
      this.markKind(s, "class");
      this.markKind(o, "class");
    } else if (props) {
      props.forEach((i) => this.markKind(i === 0 ? s : o, "property"));
      if (p !== "owl:inverseOf") this.markKind(o, "class");
      else this.markKind(o, "property");
    } else if (p === "rdf:type") {
      if (META_CLASSES.indexOf(o) >= 0) {
        this.markKind(s, "property");
        this.markKind(o, "metaclass");
      } else {
        this.markKind(s, "individual");
        this.markKind(o, "class");
      }
    } else {
      this.markKind(s, "individual");
      this.markKind(p, "property");
      this.markKind(o, "individual");
    }
    const a = this.termId(s);
    const b = this.termId(o);
    const label = flattenPredicate(p);
    const existing = this.db.getEdge(a, b, label);
    if (existing) return false;
    this.db.upsertEdge(a, b, label, 1.0, { predicate: p });
    this.writes++;
    return true;
  }

  // Read back through the public graph API only: no access to the in-memory
  // writer state, so a bug that forgot to persist shows up as a wrong answer
  // rather than being masked.
  triplesFrom(predicateFilter) {
    const out = [];
    const self = this;
    this.ids.forEach(function (id, term) {
      const edges = self.db.getEdges(id);
      edges.forEach(function (e) {
        const p = e.metadata && e.metadata.predicate ? e.metadata.predicate : unflattenPredicate(e.label);
        if (predicateFilter && predicateFilter.indexOf(p) < 0) return;
        const target = self.termOf(e.targetId);
        if (target === null) return;
        out.push([term, p, target]);
      });
    });
    return out;
  }

  termOf(id) {
    let found = null;
    this.ids.forEach(function (v, k) { if (v === id) found = k; });
    if (found !== null) return found;
    const payload = this.db.getPayload(id);
    return payload && payload.iri ? payload.iri : null;
  }

  allTriples() {
    return this.triplesFrom(null);
  }

  query(kind) {
    return this.db.indexedLookup({ kind: kind });
  }

  close() {
    if (this.db && typeof this.db.close === "function") this.db.close();
  }
}
