/**
 * Runs the stack-sim experiments and prints markdown tables.
 *   node --import tsx bench/stack-sim/run.ts [experiment...] [--seeds=N]
 * Experiments: ladder, profiles, dream-priority, cadence, clutter, multiagent, pages
 */
import { PROFILES, runOnce, type DreamPolicy, type Layers, type RunConfig, type RunResult, type WorldConfig } from "./sim.js";

const args = process.argv.slice(2);
const SEEDS = Number(args.find((a) => a.startsWith("--seeds="))?.split("=")[1] ?? 5);
const wanted = args.filter((a) => !a.startsWith("--"));

const WORLD: WorldConfig = {
  entities: 20, // 60 facts
  sessions: 40,
  observationsPerSession: 8,
  drift: 0.06,
  noiseNotesPerSession: 2,
  queriesPerSession: 6,
  agents: 1,
  sharedPage: false,
};
const DREAM: DreamPolicy = {
  every: 5,
  budget: 20,
  priority: "volatility",
  gapFill: true,
  mergeDuplicates: true,
  retireNoise: true,
  verifierError: 0.05,
};
// --fixed: run every arm with the proposed revive-on-revise fix (see S1c).
const FIXED = args.includes("--fixed");
const L = (over: Partial<Layers>): Layers => ({ notes: true, transcripts: false, dream: false, index: false, pages: "off", reviveOnRevise: FIXED, ...over });

type Row = { label: string; cfg: Omit<RunConfig, "seed"> };

async function evaluate(rows: Row[], title: string) {
  console.log(`\n### ${title}\n`);
  console.log("| arm | correct | stale | wrong | unknown (unread) | tok/query | dream checks/run | lost facts | live notes |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const row of rows) {
    const runs: RunResult[] = [];
    for (let seed = 1; seed <= SEEDS; seed += 1) runs.push(await runOnce({ ...row.cfg, seed }));
    const sum = (k: keyof RunResult) => runs.reduce((a, r) => a + r[k], 0);
    const q = sum("queries");
    const pct = (k: keyof RunResult) => `${((100 * sum(k)) / q).toFixed(1)}%`;
    const accs = runs.map((r) => r.correct / r.queries);
    const mean = accs.reduce((a, b) => a + b, 0) / accs.length;
    const sd = Math.sqrt(accs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, accs.length - 1));
    console.log(
      `| ${row.label} | **${(100 * mean).toFixed(1)}%** ±${(100 * sd).toFixed(1)} | ${pct("stale")} | ${pct("wrong")} | ${pct("unknown")} (${pct("unread")}) | ${Math.round(sum("tokens") / q)} | ${Math.round(sum("dreamChecks") / SEEDS)} | ${(sum("lostFacts") / SEEDS).toFixed(1)} | ${Math.round(sum("liveNodes") / SEEDS)} |`,
    );
  }
}

const base = (over: Partial<Omit<RunConfig, "seed">> = {}): Omit<RunConfig, "seed"> => ({
  world: WORLD,
  agent: PROFILES.mid!,
  layers: L({}),
  dream: DREAM,
  ...over,
});

const experiments: Record<string, () => Promise<void>> = {
  // S1 — stack the article's layers one at a time on Trove
  ladder: () =>
    evaluate(
      [
        { label: "0 no memory", cfg: base({ layers: L({ notes: false }) }) },
        { label: "1 notes (Trove today)", cfg: base() },
        { label: "2 + transcripts (cited)", cfg: base({ layers: L({ transcripts: true }) }) },
        { label: "3 + dreaming", cfg: base({ layers: L({ transcripts: true, dream: true }) }) },
        { label: "4 + injected index", cfg: base({ layers: L({ transcripts: true, dream: true, index: true }) }) },
        { label: "5 + entity pages (+search)", cfg: base({ layers: L({ transcripts: true, dream: true, index: true, pages: "plus-search" }) }) },
        { label: "· index only (no dream)", cfg: base({ layers: L({ index: true }) }) },
      ],
      "S1 · Layer ladder (mid agent, 60 facts, 40 sessions)",
    ),

  // S1b — which part of dreaming does the work?
  "dream-parts": () => {
    const off = { gapFill: false, mergeDuplicates: false, retireNoise: false };
    const T = L({ transcripts: true, dream: true });
    return evaluate(
      [
        { label: "notes, no dream", cfg: base() },
        { label: "verify vs transcripts", cfg: base({ layers: T, dream: { ...DREAM, ...off } }) },
        { label: "+ merge duplicates", cfg: base({ layers: T, dream: { ...DREAM, ...off, mergeDuplicates: true } }) },
        { label: "+ gap fill", cfg: base({ layers: T, dream: { ...DREAM, ...off, mergeDuplicates: true, gapFill: true } }) },
        { label: "+ retire noise (all)", cfg: base({ layers: T }) },
        { label: "verify + gap fill (no merge)", cfg: base({ layers: T, dream: { ...DREAM, ...off, gapFill: true } }) },
      ],
      "S1b · Dream components (mid agent)",
    );
  },

  // S1c — the stale-SUPERSEDED-marker bug, and what fixing it is worth
  "revive-fix": async () => {
    const rows: Row[] = [];
    for (const p of ["weak", "mid", "strong"]) {
      for (const fix of [false, true]) {
        const tag = fix ? "fixed" : "today";
        rows.push({ label: `${p} · notes · ${tag}`, cfg: base({ agent: PROFILES[p]!, layers: L({ reviveOnRevise: fix }) }) });
        rows.push({ label: `${p} · full stack · ${tag}`, cfg: base({ agent: PROFILES[p]!, layers: L({ transcripts: true, dream: true, index: true, reviveOnRevise: fix }) }) });
      }
    }
    await evaluate(rows, "S1c · Revising a superseded note: marker survives (today) vs expires (fixed)");
  },

  // S2 — does the stack help weak or strong models more?
  profiles: async () => {
    for (const p of ["weak", "mid", "strong"]) {
      await evaluate(
        [
          { label: `${p} · notes`, cfg: base({ agent: PROFILES[p]! }) },
          { label: `${p} · + index`, cfg: base({ agent: PROFILES[p]!, layers: L({ index: true }) }) },
          { label: `${p} · + transcripts + dream`, cfg: base({ agent: PROFILES[p]!, layers: L({ transcripts: true, dream: true }) }) },
          { label: `${p} · full stack`, cfg: base({ agent: PROFILES[p]!, layers: L({ transcripts: true, dream: true, index: true }) }) },
        ],
        `S2 · ${p} agent`,
      );
    }
  },

  // S3 — what should dreaming look at first, with a fixed budget?
  "dream-priority": async () => {
    const full = L({ transcripts: true, dream: true });
    for (const budget of [5, 20, Infinity]) {
      await evaluate(
        (["random", "activation", "volatility", "recent-reads"] as const).map((priority) => ({
          label: `${priority} · budget ${budget}`,
          cfg: base({ layers: full, dream: { ...DREAM, priority, budget, gapFill: false, mergeDuplicates: false } }),
        })),
        `S3 · Dream priority at budget ${budget} (verify only — no merge / gap-fill)`,
      );
    }
  },

  // S4 — how often to dream
  cadence: () =>
    evaluate(
      [1, 3, 5, 10, 20].map((every) => ({
        label: `dream every ${every}`,
        cfg: base({ layers: L({ transcripts: true, dream: true }), dream: { ...DREAM, every } }),
      })),
      "S4 · Dream cadence (budget 20/dream)",
    ),

  // S5 — over-saving: does clutter hurt, and does retirement help?
  clutter: async () => {
    for (const noise of [0, 5, 20]) {
      const w = { ...WORLD, noiseNotesPerSession: noise };
      await evaluate(
        [
          { label: `noise ${noise} · notes`, cfg: base({ world: w }) },
          { label: `noise ${noise} · dream, keep noise`, cfg: base({ world: w, layers: L({ transcripts: true, dream: true }), dream: { ...DREAM, retireNoise: false } }) },
          { label: `noise ${noise} · dream, retire noise`, cfg: base({ world: w, layers: L({ transcripts: true, dream: true }) }) },
        ],
        `S5 · Over-saving (${noise} redundant notes/session)`,
      );
    }
  },

  // S6 — concurrent writers: one page per entity vs one atom per fact
  multiagent: async () => {
    const rows: Row[] = [];
    for (const agents of [1, 2, 4]) {
      rows.push({ label: `${agents} agents · shared entity page`, cfg: base({ world: { ...WORLD, agents, sharedPage: true, noiseNotesPerSession: 0 } }) });
      rows.push({ label: `${agents} agents · atoms`, cfg: base({ world: { ...WORLD, agents, noiseNotesPerSession: 0 } }) });
    }
    await evaluate(rows, "S6 · Concurrent writers (perfect reader isolates the write path)");
  },

  // S7 — representations: page-only vs page+search, and staleness between dreams
  pages: async () => {
    for (const every of [5, 15]) {
      await evaluate(
        [
          { label: `search only · dream/${every}`, cfg: base({ layers: L({ transcripts: true, dream: true }), dream: { ...DREAM, every } }) },
          { label: `pages only · dream/${every}`, cfg: base({ layers: L({ transcripts: true, dream: true, pages: "only" }), dream: { ...DREAM, every } }) },
          { label: `pages + search · dream/${every}`, cfg: base({ layers: L({ transcripts: true, dream: true, pages: "plus-search" }), dream: { ...DREAM, every } }) },
        ],
        `S7 · Entity pages vs search (dream every ${every})`,
      );
    }
  },
};

const order = wanted.length ? wanted : Object.keys(experiments);
console.log(`stack-sim · seeds=${SEEDS}${FIXED ? " · FIXED (revive-on-revise)" : ""} · world=${JSON.stringify(WORLD)}`);
for (const name of order) {
  const t = Date.now();
  await experiments[name]!();
  console.error(`[${name}] ${((Date.now() - t) / 1000).toFixed(1)}s`);
}
