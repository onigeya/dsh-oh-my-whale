// Minimal Datalog engine with provenance and integrity constraints.
// POC for the OWL 2 RL contract layer. Facts are { rel, args: string[] }.
// Terms starting with "?" are variables; everything else is a constant.

function isVar(t) {
  return typeof t === "string" && t.length > 0 && t.charCodeAt(0) === 63;
}

function factKey(rel, args) {
  return rel + "(" + args.join(",") + ")";
}

export { isVar, factKey };

export class Engine {
  constructor(rules) {
    this.rules = rules || [];
    this.facts = new Map();
    this.byRel = new Map();
    this.byArg1 = new Map();
    this.violationKeys = new Set();
    this.violations = [];
    this.rounds = 0;
    this.maxEnvs = 40000;
  }

  addFact(rel, args, deriv) {
    const k = factKey(rel, args);
    if (this.facts.has(k)) return null;
    const f = {
      key: k,
      rel: rel,
      args: args.slice(),
      deriv: deriv || null,
      depth: deriv ? deriv.depth : 0
    };
    this.facts.set(k, f);
    this.constants = undefined;
    let list = this.byRel.get(rel);
    if (!list) { list = []; this.byRel.set(rel, list); }
    list.push(f);
    if (args.length > 0 && !isVar(args[0])) {
      let m = this.byArg1.get(rel);
      if (!m) { m = new Map(); this.byArg1.set(rel, m); }
      let al = m.get(args[0]);
      if (!al) { al = []; m.set(args[0], al); }
      al.push(f);
    }
    return f;
  }

  factsOf(rel) {
    return this.byRel.get(rel) || [];
  }

  has(rel, args) {
    return this.facts.has(factKey(rel, args));
  }

  // Does this constant appear anywhere in the current belief base?
  // Used by abduction to penalise deltas that would introduce new
  // vocabulary, since new vocabulary is a weaker hypothesis.
  hasConstant(c) {
    if (typeof c !== "string") return false;
    if (this.constants === undefined) {
      const s = new Set();
      this.facts.forEach(function (f) {
        f.args.forEach(function (a) { if (typeof a === "string") s.add(a); });
      });
      this.constants = s;
    }
    return this.constants.has(c);
  }

  candidates(atom, env) {
    const a0 = atom.args[0];
    if (a0 !== undefined && a0 !== null) {
      let val = null;
      if (isVar(a0)) {
        if (Object.prototype.hasOwnProperty.call(env, a0)) val = env[a0];
      } else {
        val = a0;
      }
      if (val !== null) {
        const m = this.byArg1.get(atom.rel);
        if (!m) return [];
        return m.get(val) || [];
      }
    }
    return this.factsOf(atom.rel);
  }

  match(atom, env) {
    const out = [];
    const list = this.candidates(atom, env);
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      let ok = true;
      const binds = [];
      for (let j = 0; j < atom.args.length; j++) {
        const a = atom.args[j];
        if (isVar(a)) {
          if (Object.prototype.hasOwnProperty.call(env, a)) {
            if (env[a] !== f.args[j]) { ok = false; break; }
          } else {
            binds.push(a, f.args[j]);
          }
        } else if (a !== f.args[j]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (binds.length === 0) {
        out.push({ env: env, fact: f });
      } else {
        const e = Object.assign({}, env);
        for (let b = 0; b < binds.length; b += 2) e[binds[b]] = binds[b + 1];
        out.push({ env: e, fact: f });
      }
    }
    return out;
  }

  solve(body) {
    let acc = [{ env: {}, facts: [] }];
    for (let i = 0; i < body.length; i++) {
      const atom = body[i];
      const next = [];
      for (let c = 0; c < acc.length; c++) {
        const cur = acc[c];
        const ms = this.match(atom, cur.env);
        for (let m = 0; m < ms.length; m++) {
          next.push({ env: ms[m].env, facts: cur.facts.concat([ms[m].fact]) });
        }
        if (next.length > this.maxEnvs) break;
      }
      acc = next;
      if (acc.length === 0) break;
      if (acc.length > this.maxEnvs) acc = acc.slice(0, this.maxEnvs);
    }
    return acc;
  }

  run(maxRounds) {
    const cap = maxRounds || 500;
    let changed = true;
    this.rounds = 0;
    while (changed && this.rounds < cap) {
      changed = false;
      this.rounds++;
      for (let r = 0; r < this.rules.length; r++) {
        const rule = this.rules[r];
        const sols = this.solve(rule.body);
        for (let s = 0; s < sols.length; s++) {
          const sol = sols[s];
          if (rule.head === null) {
            const keys = sol.facts.map(function (x) { return x.key; }).sort();
            const vk = rule.id + "|" + keys.join("&");
            if (!this.violationKeys.has(vk)) {
              this.violationKeys.add(vk);
              this.violations.push({
                ruleId: rule.id,
                name: rule.name,
                support: sol.facts,
                binding: sol.env
              });
              changed = true;
            }
            continue;
          }
          const args = rule.head.args.map(function (a) { return isVar(a) ? sol.env[a] : a; });
          if (args.some(function (a) { return a === undefined; })) continue;
          let dmax = 0;
          for (let k = 0; k < sol.facts.length; k++) {
            if (sol.facts[k].depth > dmax) dmax = sol.facts[k].depth;
          }
          const added = this.addFact(rule.head.rel, args, {
            ruleId: rule.id,
            name: rule.name,
            body: sol.facts,
            depth: dmax + 1
          });
          if (added) changed = true;
        }
      }
    }
    return this;
  }

  clone() {
    const e = new Engine(this.rules);
    const self = this;
    this.facts.forEach(function (f, k) {
      const copy = { key: f.key, rel: f.rel, args: f.args.slice(), deriv: f.deriv, depth: f.depth };
      e.facts.set(k, copy);
      let list = e.byRel.get(f.rel);
      if (!list) { list = []; e.byRel.set(f.rel, list); }
      list.push(copy);
      if (f.args.length > 0 && !isVar(f.args[0])) {
        let m = e.byArg1.get(f.rel);
        if (!m) { m = new Map(); e.byArg1.set(f.rel, m); }
        let al = m.get(f.args[0]);
        if (!al) { al = []; m.set(f.args[0], al); }
        al.push(copy);
      }
    });
    this.violationKeys.forEach(function (k) { e.violationKeys.add(k); });
    e.violations = this.violations.slice();
    return e;
  }

  withExtra(extra) {
    const e = this.clone();
    for (let i = 0; i < extra.length; i++) {
      e.addFact(extra[i].rel, extra[i].args, null);
    }
    e.run();
    return e;
  }

  proofTree(rel, args, maxDepth) {
    const self = this;
    const cap = maxDepth || 24;
    function walk(f, depth, seen) {
      if (!f) return null;
      if (depth > cap) return { key: "?", cut: true, reason: "depth-cap" };
      if (seen.has(f.key)) return { key: f.key, cut: true, reason: "cycle" };
      const node = { key: f.key, rel: f.rel, args: f.args, depth: f.depth };
      if (!f.deriv) {
        node.leaf = true;
        return node;
      }
      node.rule = f.deriv.ruleId;
      node.ruleName = f.deriv.name;
      const next = new Set(seen);
      next.add(f.key);
      node.children = f.deriv.body.map(function (b) { return walk(b, depth + 1, next); });
      return node;
    }
    return walk(this.facts.get(factKey(rel, args)), 0, new Set());
  }
}

export function triple(s, p, o) {
  return { rel: "T", args: [s, p, o] };
}

export function rule(id, name, head, body) {
  return { id: id, name: name, head: head, body: body };
}
