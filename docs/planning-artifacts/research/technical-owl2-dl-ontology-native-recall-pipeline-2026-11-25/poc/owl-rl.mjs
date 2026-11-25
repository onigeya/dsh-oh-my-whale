// A focused, executable subset of the OWL 2 RL/RDF rule tables.
// Only the rules needed to demonstrate the contract layer are included,
// but each one is transcribed from the W3C rule tables (Table 4-9).
// Rule ids and names match the specification so that proof trees can cite them.

import { triple, rule } from "./datalog.mjs";

const T = function (s, p, o) { return triple(s, p, o); };

export const RDFS_SUBCLASSOF = "rdfs:subClassOf";
export const RDF_TYPE = "rdf:type";
export const RDFS_DOMAIN = "rdfs:domain";
export const RDFS_RANGE = "rdfs:range";
export const OWL_DISJOINT_WITH = "owl:disjointWith";
export const OWL_INVERSE_OF = "owl:inverseOf";
export const OWL_SAME_AS = "owl:sameAs";
export const OWL_DIFFERENT_FROM = "owl:differentFrom";
export const OWL_TRANSITIVE = "owl:TransitiveProperty";
export const OWL_SYMMETRIC = "owl:SymmetricProperty";
export const OWL_FUNCTIONAL = "owl:FunctionalProperty";

export function rlRules() {
  const R = [];

  // scm-sco: T(?c1, rdfs:subClassOf, ?c2) T(?c2, rdfs:subClassOf, ?c3) -> T(?c1, rdfs:subClassOf, ?c3)
  R.push(rule("scm-sco", "scm-sco", T("?c1", RDFS_SUBCLASSOF, "?c3"), [
    T("?c1", RDFS_SUBCLASSOF, "?c2"),
    T("?c2", RDFS_SUBCLASSOF, "?c3")
  ]));

  // cax-sco: T(?c1, rdfs:subClassOf, ?c2) T(?x, rdf:type, ?c1) -> T(?x, rdf:type, ?c2)
  R.push(rule("cax-sco", "cax-sco", T("?x", RDF_TYPE, "?c2"), [
    T("?c1", RDFS_SUBCLASSOF, "?c2"),
    T("?x", RDF_TYPE, "?c1")
  ]));

  // prp-dom: T(?p, rdfs:domain, ?c) T(?x, ?p, ?y) -> T(?x, rdf:type, ?c)
  R.push(rule("prp-dom", "prp-dom", T("?x", RDF_TYPE, "?c"), [
    T("?p", RDFS_DOMAIN, "?c"),
    T("?x", "?p", "?y")
  ]));

  // prp-rng: T(?p, rdfs:range, ?c) T(?x, ?p, ?y) -> T(?y, rdf:type, ?c)
  R.push(rule("prp-rng", "prp-rng", T("?y", RDF_TYPE, "?c"), [
    T("?p", RDFS_RANGE, "?c"),
    T("?x", "?p", "?y")
  ]));

  // prp-inv1: T(?p, owl:inverseOf, ?q) T(?x, ?p, ?y) -> T(?y, ?q, ?x)
  R.push(rule("prp-inv1", "prp-inv1", T("?y", "?q", "?x"), [
    T("?p", OWL_INVERSE_OF, "?q"),
    T("?x", "?p", "?y")
  ]));

  // prp-inv2: T(?p, owl:inverseOf, ?q) T(?x, ?q, ?y) -> T(?y, ?p, ?x)
  R.push(rule("prp-inv2", "prp-inv2", T("?y", "?p", "?x"), [
    T("?p", OWL_INVERSE_OF, "?q"),
    T("?x", "?q", "?y")
  ]));

  // prp-symp: T(?p, rdf:type, owl:SymmetricProperty) T(?x, ?p, ?y) -> T(?y, ?p, ?x)
  R.push(rule("prp-symp", "prp-symp", T("?y", "?p", "?x"), [
    T("?p", RDF_TYPE, OWL_SYMMETRIC),
    T("?x", "?p", "?y")
  ]));

  // prp-trp: T(?p, rdf:type, owl:TransitiveProperty) T(?x, ?p, ?y) T(?y, ?p, ?z) -> T(?x, ?p, ?z)
  R.push(rule("prp-trp", "prp-trp", T("?x", "?p", "?z"), [
    T("?p", RDF_TYPE, OWL_TRANSITIVE),
    T("?x", "?p", "?y"),
    T("?y", "?p", "?z")
  ]));

  // prp-fp: T(?p, rdf:type, owl:FunctionalProperty) T(?x, ?p, ?y1) T(?x, ?p, ?y2) -> T(?y1, owl:sameAs, ?y2)
  R.push(rule("prp-fp", "prp-fp", T("?y1", OWL_SAME_AS, "?y2"), [
    T("?p", RDF_TYPE, OWL_FUNCTIONAL),
    T("?x", "?p", "?y1"),
    T("?x", "?p", "?y2")
  ]));

  // eq-sym: T(?x, owl:sameAs, ?y) -> T(?y, owl:sameAs, ?x)
  R.push(rule("eq-sym", "eq-sym", T("?y", OWL_SAME_AS, "?x"), [
    T("?x", OWL_SAME_AS, "?y")
  ]));

  // eq-trans: T(?x, owl:sameAs, ?y) T(?y, owl:sameAs, ?z) -> T(?x, owl:sameAs, ?z)
  R.push(rule("eq-trans", "eq-trans", T("?x", OWL_SAME_AS, "?z"), [
    T("?x", OWL_SAME_AS, "?y"),
    T("?y", OWL_SAME_AS, "?z")
  ]));

  // eq-diff1: T(?x, owl:sameAs, ?y) T(?x, owl:differentFrom, ?y) -> false
  R.push(rule("eq-diff1", "eq-diff1", null, [
    T("?x", OWL_SAME_AS, "?y"),
    T("?x", OWL_DIFFERENT_FROM, "?y")
  ]));

  // cax-dw: T(?c1, owl:disjointWith, ?c2) T(?x, rdf:type, ?c1) T(?x, rdf:type, ?c2) -> false
  R.push(rule("cax-dw", "cax-dw", null, [
    T("?c1", OWL_DISJOINT_WITH, "?c2"),
    T("?x", RDF_TYPE, "?c1"),
    T("?x", RDF_TYPE, "?c2")
  ]));

  // prp-irp: T(?p, rdf:type, owl:IrreflexiveProperty) T(?x, ?p, ?x) -> false
  R.push(rule("prp-irp", "prp-irp", null, [
    T("?p", RDF_TYPE, "owl:IrreflexiveProperty"),
    T("?x", "?p", "?x")
  ]));

  // prp-asyp: T(?p, rdf:type, owl:AsymmetricProperty) T(?x, ?p, ?y) T(?y, ?p, ?x) -> false
  R.push(rule("prp-asyp", "prp-asyp", null, [
    T("?p", RDF_TYPE, "owl:AsymmetricProperty"),
    T("?x", "?p", "?y"),
    T("?y", "?p", "?x")
  ]));

  return R;
}

export const FALSE_HEAD_RULES = [
  "eq-diff1", "cax-dw", "prp-irp", "prp-asyp"
];
