/**
 * Memory-stack simulator — maps the layers in Anthropic's "The components of
 * agent memory" (transcripts → notes → representations → injected context,
 * with offline "dreaming" across them) onto Trove, and measures what each layer
 * buys when stacked.
 *
 * The STORE is real: every write, recall, read and grep goes through Trove's
 * InMemoryGraphStore + agentOps.remember, so ranking, revision-on-exact-title,
 * SUPERSEDED marking and evidence behaviour are Trove's own. The AGENT is a
 * seeded stochastic policy (no LLM): its failure rates are the knobs the article
 * identifies — wrong-from-the-start notes, title drift (duplicates instead of
 * revisions), skipped saves, over-saving, not reading memory, ignoring markers.
 *
 * This is a design instrument, not a benchmark: it says which layer addresses
 * which failure mode and at what cost, under stated assumptions. It does NOT say
 * how often a real model makes each mistake — that needs an LLM-backed run.
 */
import { InMemoryGraphStore } from "../../src/store.js";
import { remember } from "../../src/agentOps.js";
import type { GraphOperationContext } from "../../src/graphCore.js";

// ---------------------------------------------------------------------------
// knobs
// ---------------------------------------------------------------------------
export type AgentProfile = {
  name: string;
  pSave: number; // saves an observed fact at all
  pWrong: number; // writes a wrong value (wrong-from-the-start)
  pCanon: number; // reuses the canonical title (→ revision) vs a variant (→ duplicate)
  pSupersede: number; // when writing a variant over a known old note, links `supersedes`
  pRead: number; // reads memory before answering (no injected index)
  pReadInjected: number; // reads memory when an injected index says memory exists
  pRespectMarker: number; // skips atoms marked SUPERSEDED
};

export const PROFILES: Record<string, AgentProfile> = {
  // Shapes taken from the article's progression: older models generate
  // untested notes and often never read memory; frontier models read ~9/10,
  // mark verified facts, write corrections.
  weak: { name: "weak", pSave: 0.6, pWrong: 0.2, pCanon: 0.4, pSupersede: 0.1, pRead: 0.4, pReadInjected: 0.75, pRespectMarker: 0.6 },
  mid: { name: "mid", pSave: 0.8, pWrong: 0.1, pCanon: 0.65, pSupersede: 0.4, pRead: 0.7, pReadInjected: 0.9, pRespectMarker: 0.85 },
  strong: { name: "strong", pSave: 0.95, pWrong: 0.04, pCanon: 0.85, pSupersede: 0.8, pRead: 0.9, pReadInjected: 0.97, pRespectMarker: 0.98 },
};

export type Layers = {
  notes: boolean; // L2: in-session atoms via remember
  transcripts: boolean; // L1: ingest each session's raw events; notes cite quotes
  dream: boolean; // offline consolidation over notes ⇄ transcripts
  index: boolean; // L4: small injected index at session start
  pages: "off" | "only" | "plus-search"; // L3: entity pages built by dreaming
  /** Proposed fix: revising a note re-asserts it, so active `supersedes` edges
   *  pointing AT it are expired. Off = Trove today (the stale marker survives). */
  reviveOnRevise?: boolean;
};

export type DreamPolicy = {
  every: number; // sessions between dreams
  budget: number; // notes verified per dream (≈ judge calls); Infinity = all
  priority: "random" | "activation" | "volatility" | "recent-reads";
  gapFill: boolean; // create notes for transcript facts with no note
  mergeDuplicates: boolean; // link supersedes across title variants of one fact
  retireNoise: boolean; // tombstone never-read noise notes older than a window
  verifierError: number; // chance the verifier is wrong on one check
};

export type WorldConfig = {
  entities: number;
  sessions: number;
  observationsPerSession: number;
  drift: number; // per observed fact, chance its value changed since last time
  noiseNotesPerSession: number; // over-saving: redundant notes written each session
  queriesPerSession: number;
  agents: number; // concurrent writers (multi-agent case)
  sharedPage: boolean; // agents keep ONE page per entity (vs one atom per fact)
};

export type RunConfig = {
  seed: number;
  world: WorldConfig;
  agent: AgentProfile;
  layers: Layers;
  dream: DreamPolicy;
};

export type RunResult = {
  queries: number;
  correct: number;
  stale: number; // answered a value that WAS true earlier
  wrong: number; // answered a value that was never true for that fact
  unknown: number; // no answer found / did not read
  unread: number; // of which: never consulted memory
  tokens: number; // context tokens spent on reads + injected index
  dreamChecks: number;
  dreamFixes: number;
  liveNodes: number;
  lostFacts: number; // facts whose latest observed value is in no live note
};

// ---------------------------------------------------------------------------
// deterministic RNG
// ---------------------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// world
// ---------------------------------------------------------------------------
const NAMES = [
  "Falcon", "Heron", "Osprey", "Kestrel", "Merlin", "Condor", "Plover", "Avocet", "Bittern", "Curlew",
  "Dunlin", "Egret", "Fulmar", "Gannet", "Hobby", "Ibis", "Jacana", "Kittiwake", "Lapwing", "Mallard",
  "Nightjar", "Oriole", "Petrel", "Quail", "Redstart", "Shrike", "Tern", "Upupa", "Vireo", "Wryneck",
  "Xenops", "Yellowhammer", "Zitting", "Auklet", "Brambling", "Chough", "Dipper", "Eider", "Firecrest", "Godwit",
];
const ATTRS = ["port", "owner", "region"] as const;

type Fact = { entity: string; attr: string; history: string[] }; // history[last] = current truth
const key = (f: { entity: string; attr: string }) => `${f.entity}|${f.attr}`;
const sentence = (entity: string, attr: string, value: string) => `${entity} ${attr} is ${value}`;

function titleFor(entity: string, attr: string, rng: () => number, pCanon: number): string {
  if (rng() < pCanon) return `${entity} ${attr}`;
  const variants = [`${attr} for ${entity}`, `${entity} service ${attr}`, `current ${entity} ${attr}`, `${entity} ${attr} note`];
  return variants[Math.floor(rng() * variants.length)]!;
}

// ---------------------------------------------------------------------------
// one run
// ---------------------------------------------------------------------------
export async function runOnce(cfg: RunConfig): Promise<RunResult> {
  // Separate streams so every arm sees the SAME world and the same queries
  // (common random numbers): only the memory stack differs between arms.
  const wrng = mulberry32(cfg.seed * 7919 + 17); // world: observations, drift, queries
  const rng = mulberry32(cfg.seed * 104729 + 3); // agent behaviour
  const drng = mulberry32(cfg.seed * 15485863 + 5); // dreaming
  const { world, agent, layers, dream } = cfg;
  const store = new InMemoryGraphStore();
  const owner = `00000000-0000-4000-8000-${String(cfg.seed).padStart(12, "0")}`;
  const ctx: GraphOperationContext = { ownerId: owner, actorId: "sim", interfaceId: "stack-sim" };

  let vcounter = 1000;
  const freshValue = () => `v${vcounter++}`;
  const facts = new Map<string, Fact>();
  for (const e of NAMES.slice(0, world.entities)) {
    for (const a of ATTRS) facts.set(`${e}|${a}`, { entity: e, attr: a, history: [freshValue()] });
  }
  const factList = [...facts.values()];
  const observed = new Set<string>(); // facts the agents have ever been shown
  const reads = new Map<string, number>(); // nodeId → read count (for activation / noise retirement)
  const recentlyRead = new Set<string>();
  const noiseIds: Array<{ id: string; session: number }> = [];
  const sourceSession = new Map<string, number>();
  const live = new Set<string>(); // node ids written by the sim and not retired
  // shared-page mode: each agent's (possibly stale) local view of each entity page
  const agentViews: Array<Map<string, Record<string, string>>> = Array.from({ length: world.agents }, () => new Map());

  const res: RunResult = { unread: 0, queries: 0, correct: 0, stale: 0, wrong: 0, unknown: 0, tokens: 0, dreamChecks: 0, dreamFixes: 0, liveNodes: 0, lostFacts: 0 };
  const tok = (s: string) => Math.ceil(s.length / 4);

  const write = async (title: string, summary: string, quote?: string) => {
    try {
      const r = await remember(store, { title, summary, type: "claim", ...(quote ? { evidence: [{ quote }] } : {}) } as never, ctx);
      live.add(r.node.id);
      if (layers.reviveOnRevise && r.action === "updated") {
        const nb = store.neighborhood({ nodeId: r.node.id, depth: 1, predicates: ["supersedes"], includeExpired: false, maxNodes: 50 } as never);
        for (const e of nb.edges) if (e.toNodeId === r.node.id && e.expiredAt === null) store.invalidateEdge({ edgeId: e.id } as never, ctx);
      }
      return r.node;
    } catch {
      return null;
    }
  };

  // ---------------- dreaming --------------------------------------------------
  const dreamOnce = async (session: number) => {
    // Truth as recorded in transcripts: the latest transcript sentence per fact.
    // (The verifier reads transcripts, never the simulator's ground truth.)
    const transcriptValue = new Map<string, string>();
    for (const f of factList) {
      if (!observed.has(key(f))) continue;
      const g = store.grep({ pattern: `${f.entity} ${f.attr} is `, scope: "sources", caseSensitive: false, limit: 100 }, ctx);
      // latest mention wins: order by the session each source was ingested in
      let last: string | null = null;
      let lastSession = -1;
      for (const m of g.matches) {
        const sess = sourceSession.get(m.sourceId ?? "") ?? -1;
        const v = m.excerpt.match(new RegExp(`${f.entity} ${f.attr} is (v\\d+)`))?.[1];
        if (v && sess >= lastSession) {
          last = v;
          lastSession = sess;
        }
      }
      if (last) transcriptValue.set(key(f), last);
    }

    // Candidate notes: every live claim node about a fact.
    type Cand = { id: string; slug: string; title: string; summary: string; k: string; updatedAt: string };
    const cands: Cand[] = [];
    for (const f of factList) {
      const g = store.grep({ pattern: `${f.entity} ${f.attr} is `, scope: "nodes", caseSensitive: false, limit: 100 }, ctx);
      for (const m of g.matches) {
        const id = m.nodeId;
        if (!id) continue;
        const r = store.read({ nodeId: id }, ctx, { trackAccess: false });
        if (!r || r.type !== "claim") continue;
        cands.push({ id, slug: r.slug, title: r.title, summary: r.summary ?? "", k: key(f), updatedAt: r.updatedAt });
      }
    }
    const uniq = [...new Map(cands.map((c) => [c.id, c])).values()];

    // Priority order → spend the budget.
    const volatility = (k: string) => facts.get(k)!.history.length;
    const scored = uniq.map((c) => {
      let p = drng();
      if (dream.priority === "activation") p = (reads.get(c.id) ?? 0) + drng() * 0.5;
      if (dream.priority === "volatility") p = volatility(c.k) + drng() * 0.5;
      if (dream.priority === "recent-reads") p = (recentlyRead.has(c.id) ? 10 : 0) + volatility(c.k) * 0.1 + drng() * 0.5;
      return { c, p };
    });
    scored.sort((a, b) => b.p - a.p);
    const budget = Number.isFinite(dream.budget) ? dream.budget : scored.length;

    for (const { c } of scored.slice(0, budget)) {
      res.dreamChecks += 1;
      const truth = transcriptValue.get(c.k);
      if (!truth) continue;
      const [entity, attr] = c.k.split("|") as [string, string];
      const noted = c.summary.match(/is (v\d+)/)?.[1];
      const verifierWrong = drng() < dream.verifierError;
      if (noted !== truth && !verifierWrong) {
        await write(c.title, sentence(entity, attr, truth), layers.transcripts ? sentence(entity, attr, truth) : undefined);
        res.dreamFixes += 1;
      }
    }

    if (dream.mergeDuplicates) {
      // One fact, several title variants → newest supersedes the rest.
      const byFact = new Map<string, Cand[]>();
      for (const c of uniq) byFact.set(c.k, [...(byFact.get(c.k) ?? []), c]);
      for (const group of byFact.values()) {
        if (group.length < 2) continue;
        const live = group.map((c) => store.read({ nodeId: c.id }, ctx, { trackAccess: false })!).filter(Boolean);
        live.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const head = live[0]!;
        for (const old of live.slice(1)) {
          store.link({ fromSlug: head.slug, toSlug: old.slug, predicate: "supersedes", weight: 1 } as never, ctx);
          res.dreamChecks += 1;
        }
      }
    }

    if (dream.gapFill) {
      for (const [k, v] of transcriptValue) {
        if (uniq.some((c) => c.k === k)) continue;
        const [entity, attr] = k.split("|") as [string, string];
        await write(`${entity} ${attr}`, sentence(entity, attr, v), layers.transcripts ? sentence(entity, attr, v) : undefined);
        res.dreamFixes += 1;
      }
    }

    if (dream.retireNoise) {
      const stale = noiseIds.filter((n) => session - n.session >= 5 && !(reads.get(n.id) ?? 0));
      if (stale.length) store.tombstoneNodes(stale.map((n) => n.id), ctx);
      for (const n of stale) live.delete(n.id);
      for (const n of stale) noiseIds.splice(noiseIds.indexOf(n), 1);
    }

    if (layers.pages !== "off") {
      // One page per entity, verbatim current values from transcripts (the
      // article's "one page per entity, quote critical facts verbatim").
      for (const e of NAMES.slice(0, world.entities)) {
        const lines = ATTRS.map((a) => transcriptValue.get(`${e}|${a}`)).map((v, i) => (v ? `- ${sentence(e, ATTRS[i]!, v)}` : null)).filter(Boolean);
        if (!lines.length) continue;
        try {
          await remember(store, { title: `${e} (entity page)`, summary: `Entity page for ${e}`, content: lines.join("\n"), type: "entity" } as never, ctx);
        } catch {
          /* ignore */
        }
      }
    }
    recentlyRead.clear();
  };

  // ---------------- answer extraction ----------------------------------------
  const valueFromPack = (pack: string, f: Fact, dates: Map<string, string>, skipPages = false): { v: string; at: string } | null => {
    const blocks = pack.split(/\n(?=## )/).filter((b) => !(skipPages && /entity-page\)/.test(b.split("\n")[0] ?? "")));
    const re = new RegExp(`${f.entity} ${f.attr} is (v\\d+)`);
    for (const b of blocks) {
      const header = b.split("\n")[0] ?? "";
      if (/SUPERSEDED/.test(header) && rng() < agent.pRespectMarker) continue;
      // read claim bodies, not quoted evidence lines
      const body = b.split("\n").filter((l) => !l.startsWith(">")).join("\n");
      const m = body.match(re);
      if (m) return { v: m[1]!, at: dates.get(header.match(/\(([^)]+)\) —/)?.[1] ?? "") ?? "" };
    }
    return null;
  };

  // ---------------- sessions --------------------------------------------------
  for (let s = 1; s <= world.sessions; s += 1) {
    // 1) observe: some facts are shown this session; some have drifted
    const shown: Fact[] = [];
    for (let i = 0; i < world.observationsPerSession; i += 1) shown.push(factList[Math.floor(wrng() * factList.length)]!);
    for (const f of shown) {
      if (observed.has(key(f)) && wrng() < world.drift * 5) f.history.push(freshValue()); // drift between observations
      observed.add(key(f));
    }
    const transcript = shown.map((f) => `Event: ${sentence(f.entity, f.attr, f.history.at(-1)!)}.`).join("\n\n");
    if (layers.transcripts) {
      const ing = store.ingest({ kind: "transcript", title: `session ${s} transcript`, contentText: transcript, metadata: {} } as never, ctx);
      sourceSession.set(ing.source.id, s);
    }

    // 2) write notes (split across agents)
    if (layers.notes) {
      for (const [i, f] of shown.entries()) {
        const agentIx = i % world.agents;
        if (rng() >= agent.pSave) continue;
        const truth = f.history.at(-1)!;
        const v = rng() < agent.pWrong ? (f.history.length > 1 && rng() < 0.5 ? f.history.at(-2)! : `v${9000 + Math.floor(rng() * 999)}`) : truth;
        if (world.sharedPage) {
          // Each agent rewrites the WHOLE entity page from its own local view —
          // concurrent writers clobber each other's attributes (article case G).
          const view = agentViews[agentIx]!.get(f.entity) ?? {};
          view[f.attr] = v;
          agentViews[agentIx]!.set(f.entity, view);
          const body = Object.entries(view).map(([a, val]) => `- ${sentence(f.entity, a, val)}`).join("\n");
          await remember(store, { title: `${f.entity} page`, summary: body.split("\n")[0]!.slice(2), content: body, type: "claim" } as never, ctx).catch(() => null);
          continue;
        }
        const title = titleFor(f.entity, f.attr, rng, agent.pCanon);
        const node = await write(title, sentence(f.entity, f.attr, v), layers.transcripts ? sentence(f.entity, f.attr, truth) : undefined);
        if (node && f.history.length > 1 && title !== `${f.entity} ${f.attr}` && rng() < agent.pSupersede) {
          // agent knowingly supersedes the canonical older note
          store.link({ fromSlug: node.slug, toSlug: `${f.entity} ${f.attr}`.toLowerCase().replace(/\s+/g, "-"), predicate: "supersedes", weight: 1 } as never, ctx);
        }
      }
      for (let n = 0; n < world.noiseNotesPerSession; n += 1) {
        const e = NAMES[Math.floor(rng() * world.entities)]!;
        const node = await write(`${e} observation ${s}-${n}`, `Saw ${e} dashboard at step ${s}; ${e} port panel was green; nothing changed.`);
        if (node) noiseIds.push({ id: node.id, session: s });
      }
    }

    // 3) answer queries about previously observed facts
    const indexText = layers.index ? renderIndex(store, ctx, world) : "";
    const pRead = layers.index ? agent.pReadInjected : agent.pRead;
    const pool = factList.filter((f) => observed.has(key(f)));
    res.tokens += tok(indexText); // injected once per session
    for (let q = 0; q < world.queriesPerSession && pool.length; q += 1) {
      const f = pool[Math.floor(wrng() * pool.length)]!;
      res.queries += 1;
      const willRead = rng() < pRead;
      let answer: string | null = null;
      if (!willRead || !layers.notes) res.unread += 1;
      if (layers.notes && willRead) {
        let pageVal: string | null = null;
        let pageDate = "";
        if (layers.pages !== "off") {
          const page = store.read({ slug: `${f.entity.toLowerCase()}-entity-page` }, ctx);
          if (page) {
            res.tokens += tok(page.content ?? "");
            pageVal = (page.content ?? "").match(new RegExp(`${f.entity} ${f.attr} is (v\\d+)`))?.[1] ?? null;
            pageDate = page.updatedAt;
          }
        }
        if (layers.pages === "only" && pageVal) {
          answer = pageVal;
        } else {
          const pack = await store.recall({ query: `What is the ${attrQuestion(f.attr)} ${f.entity}?`, tokenBudget: 1200 } as never); // in-memory recall is unscoped; one store per run
          res.tokens += pack.spentTokens;
          for (const id of pack.atoms.map((a) => a.node.id)) {
            reads.set(id, (reads.get(id) ?? 0) + 1);
            recentlyRead.add(id);
          }
          const dates = new Map(pack.atoms.map((a) => [a.node.slug, a.node.updatedAt]));
          const recalled = valueFromPack(pack.context, f, dates, layers.pages === "plus-search");
          // pages + search: on disagreement take the newer source — the page is
          // as-of the last dream, search is live (the article's wiki+search).
          if (recalled && pageVal && recalled.v !== pageVal) answer = recalled.at > pageDate ? recalled.v : pageVal;
          else answer = recalled?.v ?? pageVal;
        }
      }
      if (!answer) res.unknown += 1;
      else if (answer === f.history.at(-1)) res.correct += 1;
      else if (f.history.includes(answer)) res.stale += 1;
      else res.wrong += 1;
    }

    if (layers.dream && s % dream.every === 0) await dreamOnce(s);
  }

  // end-state: facts whose latest value no live node states
  for (const f of factList) {
    if (!observed.has(key(f))) continue;
    const g = store.grep({ pattern: sentence(f.entity, f.attr, f.history.at(-1)!), scope: "nodes", caseSensitive: false, limit: 5 }, ctx);
    if (!g.matches.some((m) => !m.slug?.endsWith("entity-page"))) res.lostFacts += 1;
  }
  res.liveNodes = live.size;
  return res;
}

function attrQuestion(attr: string) {
  return attr === "port" ? "port of" : attr === "owner" ? "owner of" : "region of";
}

/** Deterministic injected index (no LLM): one line per entity, capped like MEMORY.md's 200 lines. */
function renderIndex(store: InMemoryGraphStore, ctx: GraphOperationContext, world: WorldConfig): string {
  const lines = ["# Memory index (injected)", "Memory exists for these entities — read before answering:"];
  for (const e of NAMES.slice(0, world.entities)) lines.push(`- ${e}: ports, owners, regions → recall "${e}"`);
  return lines.slice(0, 200).join("\n");
}
