/**
 * The Epic 3 evaluation baseline: the 20 governance fixtures, the SM-2 record and
 * the blind-judgment rubric have to agree with each other and with the closed sets
 * the plugin already defines.
 *
 * These are not tests of `explain` — that command is Story 3.1 and is registered as
 * undelivered (`src/seams/commands.ts:400`). They are tests of the *sample set*: a
 * fixture whose ledger contradicts its own expected answers, or whose `mem_key`
 * shape drifted from `data-model`, would quietly produce a 20/20 that means nothing.
 * @module
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WRITE_PROMPT_VERSION } from '../../src/core/patch.ts'
import { SUPPORTED_CONTRACT_VERSION } from '../../src/store/meta.ts'
import { EDGE_LABELS } from '../../src/store/templates/evidence.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Read one baseline file as UTF-8 from the repository root. */
function baseline(...segments: readonly string[]): string {
  return readFileSync(join(repoRoot, ...segments), 'utf8')
}

interface Evidence {
  readonly session_id: string
  readonly seq_from: number
  readonly seq_to: number
  readonly quote: string
  readonly quote_truncated: boolean
  readonly deidentified: boolean
  readonly expired: boolean
  readonly recorded_at: string
}

interface Flag {
  readonly flag_type: string
  readonly status: string
  readonly resolved_by: string | null
  readonly detail: string
}

interface Edge {
  readonly label: string
  readonly from_key: string
  readonly to_key: string
}

interface EdgeEntry {
  readonly edge: Edge
}

interface FlagEntry {
  readonly flag: string
}

type AffectedEntry = string | EdgeEntry | FlagEntry

interface HistoryRow {
  readonly ts: string
  readonly actor: string
  readonly decision_kind: string
  readonly op_id: string
  readonly reason: string
  readonly precedent_id: string | null
  readonly from: unknown
  readonly to: unknown
  readonly affected: readonly AffectedEntry[]
}

interface Version {
  readonly version: number
  readonly obj: string
  readonly active: boolean
  readonly valid_from: string
  readonly valid_to: string | null
  readonly superseded_at: string | null
}

interface Node {
  readonly kind: string
  readonly subj?: string
  readonly pred?: string
  readonly obj?: string
  readonly origin?: string
  readonly cause?: string
  readonly prompt_version?: string
  readonly settle_state?: string | null
  readonly falsifier?: unknown
  readonly deactivated?: boolean
  readonly cardinality?: string
  readonly status?: string
  readonly decided_by?: string
}

interface Expected {
  readonly who: { readonly actor: string; readonly ts: string }
  readonly basis?: Evidence
  readonly basis_count: number
  readonly why: {
    readonly kind: string
    readonly reason: string
    readonly precedent_id: string | null
    readonly prompt_version: string | null
  }
  readonly decision_keys: readonly string[]
  readonly contract_version: number
  readonly flag: Flag | null
  readonly sample_answer: string
}

interface Fixture {
  readonly id: string
  readonly group: string
  readonly key_form: string
  readonly title: string
  readonly pins: string
  readonly mem_key: string
  readonly query: string
  readonly node: Node
  readonly versions: readonly Version[]
  readonly history: readonly HistoryRow[]
  readonly evidence: readonly Evidence[]
  readonly flags: readonly Flag[]
  readonly edges: readonly Edge[]
  readonly expected: Expected
}

/** The ledger actions `decision` nodes are allowed to carry (data-model §3). */
const DECISION_KINDS = ['insert', 'supersede', 'arbitrate', 'resolve_flag', 'migrate', 'revert']
/** Who may have caused a change; the code's set, not the older spine wording. */
const ACTORS = ['user', 'model', 'seed', 'system']
/** How a node came to be asserted (AD-17). */
const ORIGINS = ['observed', 'inference']
/** Why an extraction ran, which is separate from who ran it (data-model §3). */
const CAUSES = ['conversation', 'tool', 'dream', 'migration']
/** The eight-value flag ontology (data-model §7). */
const FLAG_TYPES = ['dangling_evidence', 'contradiction', 'refuted', 'rejected', 'dream_truncated', 'migration', 'predicate_new', 'predicate_rekey']
const FLAG_STATUSES = ['open', 'resolved']
const RESOLVED_BY = ['auto', 'human']
/** The eight keys every `decision` view carries. */
const REQUIRED_DECISION_KEYS = ['ts', 'actor', 'kind', 'op_id', 'affected', 'target_mem_key', 'reason', 'contract_version']
/** The three that depend on what the row did. */
const CONDITIONAL_DECISION_KEYS = ['from', 'to', 'precedent_id']
/** Ledger-class nodes are never inside an `affected[]` closure (data-model §6). */
const LEDGER_PREFIXES = ['decision:', 'rejected:', 'dream_log:', 'dream_cycle:']

const jsonl = baseline('test', 'fixtures', 'governance-20.jsonl')
const rows = jsonl.split('\n').filter(line => line.trim() !== '')
const fixtures = rows.map(row => JSON.parse(row) as Fixture)

/** Take the last element, failing loudly instead of returning undefined. */
function lastOf<T>(items: readonly T[], what: string): T {
  const value = items[items.length - 1]
  if (value === undefined) throw new Error(`${what} 为空`)
  return value
}

/** The business key an evidence node is written under (`src/core/evidence.ts:212`). */
function evidenceKey(evidence: Evidence): string {
  return `evidence:${evidence.session_id}#${evidence.seq_from}-${evidence.seq_to}`
}

/** Whether a `from`/`to` slot on a ledger row actually holds a value. */
function present(value: unknown): boolean {
  return value !== null && value !== undefined
}

describe('the fixture file is a set of twenty, not a pile', () => {
  it('holds exactly 20 numbered fixtures', () => {
    expect(fixtures).toHaveLength(20)
    expect(fixtures.map(fixture => fixture.id)).toEqual(
      Array.from({ length: 20 }, (_unused, index) => `G20-${String(index + 1).padStart(2, '0')}`),
    )
  })

  it('splits into the four documented groups without gaps', () => {
    const counts = { A: 0, B: 0, C: 0, D: 0 } as Record<string, number>
    for (const fixture of fixtures) {
      expect(Object.keys(counts)).toContain(fixture.group)
      counts[fixture.group] = (counts[fixture.group] ?? 0) + 1
    }
    expect(counts).toEqual({ A: 6, B: 5, C: 5, D: 4 })
  })

  it('answers every guiding question with something a judge could read', () => {
    for (const fixture of fixtures) {
      expect(fixture.title.length, fixture.id).toBeGreaterThan(4)
      expect(fixture.pins.length, fixture.id).toBeGreaterThan(10)
      expect(fixture.expected.sample_answer.split('\n'), fixture.id).toHaveLength(3)
    }
  })
})

describe('each fixture keys its target the way the data model does', () => {
  it('builds a three-segment assertion key for single-valued predicates', () => {
    for (const fixture of fixtures.filter(entry => entry.key_form === 'assertion:3')) {
      expect(fixture.node.kind, fixture.id).toBe('assertion')
      expect(fixture.mem_key, fixture.id).toBe(`assertion:${fixture.node.subj}:${fixture.node.pred}`)
    }
  })

  it('builds a four-segment assertion key for multi-valued predicates', () => {
    for (const fixture of fixtures.filter(entry => entry.key_form === 'assertion:4')) {
      expect(fixture.node.kind, fixture.id).toBe('assertion')
      expect(fixture.mem_key, fixture.id).toBe(
        `assertion:${fixture.node.subj}:${fixture.node.pred}:${fixture.node.obj}`,
      )
    }
  })

  it('names a predicate node exactly as `predicateMemKey` would', () => {
    const predicates = fixtures.filter(entry => entry.key_form === 'pred:1')
    expect(predicates.length).toBeGreaterThan(0)
    for (const fixture of predicates) {
      expect(fixture.node.kind, fixture.id).toBe('pred')
      expect(fixture.mem_key, fixture.id).toBe(`pred:${fixture.node.pred}`)
    }
  })

  it('queries the flat command name the code registers, not a subcommand', () => {
    for (const fixture of fixtures) {
      expect(fixture.query, fixture.id).toBe(`/omw-explain ${fixture.mem_key}`)
    }
  })
})

describe('each fixture only uses values the plugin closes over', () => {
  it('keeps every ledger action inside the six-value set', () => {
    for (const fixture of fixtures) {
      for (const row of fixture.history) expect(DECISION_KINDS, fixture.id).toContain(row.decision_kind)
    }
  })

  it('keeps every actor, origin and cause inside their closed sets', () => {
    for (const fixture of fixtures) {
      for (const row of fixture.history) expect(ACTORS, fixture.id).toContain(row.actor)
      if (fixture.node.kind !== 'assertion') continue
      expect(ORIGINS, fixture.id).toContain(fixture.node.origin)
      expect(CAUSES, fixture.id).toContain(fixture.node.cause)
      expect(fixture.node.prompt_version, fixture.id).toBe(WRITE_PROMPT_VERSION)
    }
  })

  it('keeps every flag inside the eight-value ontology', () => {
    for (const fixture of fixtures) {
      for (const flag of fixture.flags) {
        expect(FLAG_TYPES, fixture.id).toContain(flag.flag_type)
        expect(FLAG_STATUSES, fixture.id).toContain(flag.status)
        if (flag.resolved_by === null) {
          expect(flag.status, fixture.id).toBe('open')
        } else {
          expect(RESOLVED_BY, fixture.id).toContain(flag.resolved_by)
          expect(flag.status, fixture.id).toBe('resolved')
        }
      }
    }
  })

  it('keeps every edge inside the five-label closed set', () => {
    for (const fixture of fixtures) {
      for (const edge of fixture.edges) expect(EDGE_LABELS, fixture.id).toContain(edge.label)
    }
  })

  it('stamps the one contract version the build supports', () => {
    for (const fixture of fixtures) {
      expect(fixture.expected.contract_version, fixture.id).toBe(SUPPORTED_CONTRACT_VERSION)
    }
  })

  it('gives an inference a falsifier and a settlement state (AD-17)', () => {
    const inferences = fixtures.filter(fixture => fixture.node.origin === 'inference')
    expect(inferences.length).toBeGreaterThan(0)
    for (const fixture of inferences) {
      expect(fixture.node.falsifier, fixture.id).toBeTypeOf('object')
      expect(['unsettled', 'confirmed', 'refuted'], fixture.id).toContain(fixture.node.settle_state)
    }
  })
})

describe('a fixture cannot contradict its own expected answers', () => {
  it('attributes the change to the actor and instant the ledger last recorded', () => {
    for (const fixture of fixtures) {
      const last = lastOf(fixture.history, `${fixture.id} history`)
      expect(fixture.expected.who.actor, fixture.id).toBe(last.actor)
      expect(fixture.expected.who.ts, fixture.id).toBe(last.ts)
    }
  })

  it('explains the change with the kind and reason of that same row', () => {
    for (const fixture of fixtures) {
      const last = lastOf(fixture.history, `${fixture.id} history`)
      expect(fixture.expected.why.kind, fixture.id).toBe(last.decision_kind)
      expect(fixture.expected.why.reason, fixture.id).toBe(last.reason)
      expect(fixture.expected.why.precedent_id, fixture.id).toBe(last.precedent_id)
    }
  })

  it('shows the newest evidence and counts every independent source', () => {
    for (const fixture of fixtures) {
      expect(fixture.expected.basis_count, fixture.id).toBe(fixture.evidence.length)
      if (fixture.evidence.length === 0) {
        expect(fixture.expected.basis, fixture.id).toBeUndefined()
        continue
      }
      expect(fixture.expected.basis, fixture.id).toEqual(lastOf(fixture.evidence, `${fixture.id} evidence`))
    }
  })

  it('declares exactly the decision keys the last row produces', () => {
    for (const fixture of fixtures) {
      const last = lastOf(fixture.history, `${fixture.id} history`)
      const wanted = new Set(fixture.expected.decision_keys)
      expect([...wanted], fixture.id).toEqual(expect.arrayContaining(REQUIRED_DECISION_KEYS))
      expect(present(last.from), `${fixture.id} from`).toBe(wanted.has('from'))
      expect(present(last.to), `${fixture.id} to`).toBe(wanted.has('to'))
      expect(present(last.precedent_id), `${fixture.id} precedent_id`).toBe(wanted.has('precedent_id'))
      const allowed = new Set([...REQUIRED_DECISION_KEYS, ...CONDITIONAL_DECISION_KEYS])
      for (const key of wanted) expect(allowed.has(key), `${fixture.id} ${key}`).toBe(true)
    }
  })

  it('keeps one active version and a chain whose seams meet', () => {
    for (const fixture of fixtures) {
      const live = fixture.versions.filter(version => version.active)
      expect(live, `${fixture.id} active`).toHaveLength(fixture.node.deactivated === true ? 0 : 1)
      expect(fixture.versions.map(version => version.version), fixture.id).toEqual(
        Array.from({ length: fixture.versions.length }, (_unused, index) => index + 1),
      )
      for (let index = 0; index < fixture.versions.length - 1; index += 1) {
        const earlier = fixture.versions[index]
        const later = fixture.versions[index + 1]
        if (earlier === undefined || later === undefined) throw new Error(`${fixture.id} 版本链断裂`)
        expect(earlier.valid_to, `${fixture.id} v${earlier.version} valid_to`).toBe(later.valid_from)
      }
      for (const version of fixture.versions) {
        expect(version.superseded_at === null, `${fixture.id} v${version.version}`).toBe(version.active)
      }
    }
  })

  it('closes affected[] over state nodes and edges only (AD-22)', () => {
    const evidenceKeys = (fixture: Fixture): readonly string[] => fixture.evidence.map(evidenceKey)
    for (const fixture of fixtures) {
      for (const entry of lastOf(fixture.history, `${fixture.id} history`).affected) {
        if (typeof entry === 'string') {
          for (const prefix of LEDGER_PREFIXES) expect(entry, fixture.id).not.toContain(prefix)
          const head = entry.split(':')[0]
          expect(['assertion', 'evidence', 'pred'], fixture.id).toContain(head)
          // An op may write a patch table covering several assertions, so its closure
          // can name evidence that belongs to another assertion (G20-06 is exactly
          // that case). Insist on the documented key shape instead of membership.
          if (entry.startsWith('evidence:')) {
            if (evidenceKeys(fixture).includes(entry)) continue
            expect(entry, `${fixture.id} ${entry}`).toMatch(/^evidence:[^#]+#\d+-\d+$/)
          }
          if (entry.startsWith('pred:') && fixture.node.kind === 'pred') expect(entry, fixture.id).toBe(fixture.mem_key)
          continue
        }
        const keys = Object.keys(entry)
        expect(keys, fixture.id).toHaveLength(1)
        expect(['edge', 'flag'], fixture.id).toContain(keys[0])
        if ('edge' in entry) {
          expect(EDGE_LABELS, fixture.id).toContain(entry.edge.label)
          expect(entry.edge.from_key.length, fixture.id).toBeGreaterThan(0)
          expect(entry.edge.to_key.length, fixture.id).toBeGreaterThan(0)
        }
      }
    }
  })

  it('never lists an edge twice, because a batch de-duplicates on the triple', () => {
    for (const fixture of fixtures) {
      const triples = fixture.edges.map(edge => `${edge.from_key}|${edge.label}|${edge.to_key}`)
      expect(new Set(triples).size, fixture.id).toBe(triples.length)
    }
  })
})

describe('the SM-2 record restates the fixture set instead of drifting from it', () => {
  const record = baseline('eval', 'governance-20.md')
  const listed = record
    .split('\n')
    .filter(line => line.startsWith('| G20-'))
    .map(line => (line.split('|')[1] ?? '').trim())

  it('lists every fixture id, once, in file order', () => {
    expect(listed).toEqual(fixtures.map(fixture => fixture.id))
  })

  it('names the business key of every fixture it lists', () => {
    for (const fixture of fixtures) expect(record, fixture.id).toContain(fixture.mem_key)
  })

  it('leaves the run table empty until a run actually happened', () => {
    expect(record).toContain('_（未运行）_')
    expect(record).not.toMatch(/\| 20\/20 \|/)
  })
})

describe('the rubric states pass lines as numbers', () => {
  const rubric = baseline('eval', 'rubric.md')

  it('counts false positives and false negatives apart, and weights the positive ones', () => {
    expect(rubric).toContain('假阳性')
    expect(rubric).toContain('假阴性')
    expect(rubric).toContain('按假阳性加权')
  })

  it('gives the accuracy pass line as a number, not as a feeling', () => {
    expect(rubric).toContain('≥ 0.80')
    expect(rubric).toContain('Wilson')
    expect(rubric).toContain('±11')
  })

  it('carries the single-judge substitute clause the AC asks for', () => {
    expect(rubric).toContain('≥7 天')
    expect(rubric).toContain('≥90%')
    expect(rubric).toContain('非独立盲判')
  })

  it('settles the mechanical side of SM-2 at twenty of twenty within 30 seconds', () => {
    expect(rubric).toContain('20/20')
    expect(rubric).toContain('≤30 秒')
  })

  it('judges readability without letting the judge see the expected answers', () => {
    expect(rubric).toContain('读得懂')
    expect(rubric).toContain('`sample_answer`')
    for (const question of ['R1', 'R2', 'R3', 'R4']) expect(rubric).toContain(question)
  })
})

describe('the directory convention exists where P1-5 asked for it', () => {
  const conventions = baseline('eval', 'README.md')

  it('fixes both directories and the files they hold', () => {
    expect(conventions).toContain('`eval/`')
    expect(conventions).toContain('`test/fixtures/`')
    expect(conventions).toContain('test/fixtures/governance-20.jsonl')
    expect(conventions).toContain('eval/governance-20.md')
    expect(conventions).toContain('eval/rubric.md')
  })

  it('writes down the modeling choices the spec left open', () => {
    expect(conventions).toContain('建模口径')
    expect(conventions).toContain('supersede')
    expect(conventions).toContain('占位')
  })
})