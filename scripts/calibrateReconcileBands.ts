/**
 * Calibrate the reconcile distance gate (backlog #27).
 *
 * The bands in reconcile.ts must come from a measured distribution, not from
 * guesses. This script builds a labelled corpus in a scratch database —
 * supersede pairs (same fact, newer value), duplicate pairs (same fact
 * restated), related pairs (same subject, different fact) and distinct
 * background facts — embeds it with the real provider, then replays the exact
 * candidate-match reconciliation performs (lexical on title, semantic on
 * title+summary) for each "new write" probe and records every candidate's
 * distance with its true label.
 *
 * Output: per-class distance distributions and the separation numbers the
 * bands are chosen from. Corpus size is printed alongside — see the standing
 * rule at the end of docs/backlog.md.
 *
 * Usage: npx tsx scripts/calibrateReconcileBands.ts   (needs DATABASE_URL admin
 * access to drop/create the scratch DB, and OPENAI_API_KEY for embeddings)
 */
import pg from "pg";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../src/migrate.js";
import { PgGraphStore } from "../src/pgStore.js";
import { performReconcileNode, type ReconcileJudge } from "../src/reconcile.js";
import type { GraphOperationContext } from "../src/graphCore.js";

process.loadEnvFile(new URL("../.env", import.meta.url));

const BASE_URL = process.env.DATABASE_URL;
if (!BASE_URL) throw new Error("DATABASE_URL required (admin access to create the scratch DB)");
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY required — calibrating against a fake provider is meaningless");

const SCRATCH_DB = "trove_reconcile_cal";
const MODEL = process.env.TROVE_EMBEDDING_MODEL ?? "text-embedding-3-small";

async function createScratch(): Promise<string> {
  const admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${SCRATCH_DB} with (force)`);
    await admin.query(`create database ${SCRATCH_DB}`);
  } finally {
    await admin.end();
  }
  const url = new URL(BASE_URL as string);
  url.pathname = `/${SCRATCH_DB}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
    await applyMigrations(client, fileURLToPath(new URL("../db/migrations/", import.meta.url)));
  } finally {
    await client.end();
  }
  return url.toString();
}

type Label = "supersede" | "duplicate" | "contradicts" | "related";
type Atom = { key: string; title: string; fact: string };

// Atom-shaped: short title, one-sentence fact as summary AND content — the
// shape the distiller and most agents actually write.
const ATOMS: Atom[] = [
  // --- supersede bases + their updated values ------------------------------
  { key: "freeze-fri", title: "Deploy freeze day", fact: "Deploys are frozen on Fridays; nothing ships into the weekend without an incident commander signing off." },
  { key: "freeze-thu", title: "Deploy freeze day", fact: "The deploy freeze moved off Friday — it now falls on Thursday, to give support a clear day before the weekend." },
  { key: "standup-9", title: "Standup time", fact: "Standup is at 9:00am sharp; camera on for the first five minutes, then optional." },
  { key: "standup-930", title: "Standup time", fact: "Standup shifted to 9:30am starting next week — the earlier slot clashed with the Helsinki office's commute." },
  { key: "permit-old", title: "Office parking permit", fact: "The parking permit for the office car park is P-8814, valid from April." },
  { key: "permit-new", title: "Office parking permit", fact: "The new parking permit is P-9032 after the plate change; the old one is cancelled." },
  { key: "ins-old", title: "Home insurance policy", fact: "Home insurance renewed with Hartley & Co — policy HC-2201, £412 for the year." },
  { key: "ins-new", title: "Home insurance policy", fact: "Home insurance switched to Meridian Mutual — policy MM-8810, £356 for the year." },
  { key: "hotel-150", title: "London hotel cap", fact: "Company travel policy caps London hotels at £150 a night; anything above needs VP sign-off." },
  { key: "hotel-190", title: "London hotel cap", fact: "The London hotel cap moved to £190 a night — the old figure predates the rate increases." },
  { key: "biscuit-5", title: "Biscuit's anti-inflammatory dose", fact: "Biscuit is on 5mg of the anti-inflammatory once a day, per the vet's first prescription." },
  { key: "biscuit-25", title: "Biscuit's anti-inflammatory dose", fact: "The vet dropped Biscuit to 2.5mg a day after the bloodwork — her kidney numbers want the lower dose." },
  { key: "release-weekly", title: "Release train rhythm", fact: "The release train ships weekly, every Tuesday." },
  { key: "release-fortnight", title: "Release train rhythm", fact: "The release train now runs fortnightly — every second Tuesday." },
  { key: "volley-42", title: "Volleyball record", fact: "The recreational league volleyball record is 4 wins, 2 losses." },
  { key: "volley-52", title: "Volleyball record", fact: "The recreational league volleyball record is now 5 wins, 2 losses." },
  // --- duplicate probes (same fact restated against the bases above) -------
  { key: "dup-standup", title: "Daily standup", fact: "Daily standup happens at 9:00am each morning." },
  { key: "dup-hotel", title: "Hotel price cap", fact: "Company policy caps London hotels at £150 per night." },
  { key: "dup-biscuit", title: "Biscuit's medication", fact: "Biscuit's daily anti-inflammatory dose is 5mg." },
  { key: "dup-permit", title: "Car park permit number", fact: "The office car park permit number is P-8814." },
  { key: "dup-release", title: "Release cadence", fact: "Releases go out every Tuesday, weekly." },
  { key: "dup-verbatim", title: "Friday deploy freeze", fact: "Deploys are frozen on Fridays; nothing ships into the weekend without an incident commander signing off." },
  // --- related probes (same subject, different fact) -----------------------
  { key: "rel-standup-lead", title: "Standup facilitator", fact: "The design lead runs standup for the rest of the quarter while the EM is on sabbatical." },
  { key: "rel-freeze-scope", title: "Deploy freeze scope", fact: "The deploy freeze applies to the payments repo and the ledger service; everything else follows the normal release train." },
  { key: "rel-ins-bikes", title: "Shed bike cover", fact: "The home insurance covers the bikes in the shed, as long as each one is under £1500." },
  { key: "rel-offsite", title: "June offsite booking", fact: "The June offsite is booked under the company travel policy — finance confirmed it applies even though it is technically team building." },
  { key: "rel-biscuit-blood", title: "Biscuit's bloodwork", fact: "Biscuit's bloodwork is reviewed every six months as part of the long-term plan for her hip." },
  { key: "rel-permit-enforce", title: "Car park enforcement", fact: "The office car park requires the permit displayed on the dashboard — enforcement started last month and they do clamp." },
  // --- contradicts probes (same attribute, conflicting value, no clear newer) ---
  { key: "con-wifi-a", title: "Office wifi password", fact: "The office wifi password is Bluefinch-42, on the noticeboard." },
  { key: "con-wifi-b", title: "Office wifi password", fact: "The office wifi password is Heron-99 — it changed with the new router." },
  { key: "con-retro-a", title: "Team retro slot", fact: "Team retro is on Monday afternoons at 4pm." },
  { key: "con-retro-b", title: "Team retro slot", fact: "Team retro is on Friday afternoons at 2pm." },
  { key: "con-desk-a", title: "Tuesday standing desk", fact: "The standing desk is booked to Alex on Tuesdays." },
  { key: "con-desk-b", title: "Tuesday standing desk", fact: "The Tuesday standing desk is booked to Priya now." },
  { key: "con-budget-a", title: "Quarterly team budget", fact: "The quarterly team budget cap is £8,000 this year." },
  { key: "con-budget-b", title: "Quarterly team budget", fact: "The quarterly team budget cap is £12,000 this year." },
  // --- distinct background facts -------------------------------------------
  { key: "bg-garden", title: "Garden watering", fact: "The tomatoes need watering every other day once the heatwave starts." },
  { key: "bg-mortgage", title: "Mortgage rate", fact: "The mortgage fixes at 4.1% for five years starting in September." },
  { key: "bg-marathon", title: "Marathon training", fact: "Sunday long runs are up to 28km now; the race is in eleven weeks." },
  { key: "bg-piano", title: "Piano lessons", fact: "Piano lessons moved to Wednesday evenings at the community centre." },
  { key: "bg-sourdough", title: "Sourdough starter", fact: "The sourdough starter lives in the fridge now and gets fed once a week." },
  { key: "bg-dentist", title: "Dentist appointment", fact: "The dentist check-up is booked for the 14th at 8:40 in the morning." },
  { key: "bg-car", title: "Car service", fact: "The car goes in for its annual service and MOT next month." },
  { key: "bg-bookclub", title: "Book club pick", fact: "Book club is reading the Mantel trilogy next; discussion on the first Tuesday." },
  { key: "bg-visa", title: "Visa renewal", fact: "The visa renewal paperwork has to be lodged ninety days before expiry." },
  { key: "bg-gym", title: "Gym membership", fact: "The gym membership renews annually in March and the price went up this year." },
  { key: "bg-wifi", title: "Wifi router", fact: "The wifi router needs a reboot every couple of weeks or the upstairs signal drops." },
  { key: "bg-landlord", title: "Landlord repair", fact: "The landlord still owes us a fix for the kitchen extractor fan." },
  { key: "bg-talk", title: "Conference talk", fact: "The conference talk draft needs to be with the programme committee by Friday week." },
  { key: "bg-puppy", title: "Puppy vaccination", fact: "The puppy's second vaccination is due three weeks after the first." },
  { key: "bg-tax", title: "Tax filing", fact: "Self-assessment has to be filed by the end of January to avoid the fine." },
  // --- distinct probes (new writes with no near neighbour) ------------------
  { key: "probe-cello", title: "Cello hire", fact: "The cello hire for the autumn term is paid up through December." },
  { key: "probe-boiler", title: "Boiler service", fact: "The boiler engineer flagged the pressure valve for replacement next visit." },
  { key: "probe-spanish", title: "Spanish class", fact: "The evening Spanish class moved from Monday to Thursday this term." },
  { key: "probe-au pair", title: "School pickup rota", fact: "Thursday school pickup swaps to the other family from next month." },
  { key: "probe-ferry", title: "Ferry booking", fact: "The ferry to Calais is booked for 6am on the first Saturday of the holidays." },
];

const PAIRS: Array<{ label: Label; existing: string; probe: string }> = [
  { label: "supersede", existing: "freeze-fri", probe: "freeze-thu" },
  { label: "supersede", existing: "standup-9", probe: "standup-930" },
  { label: "supersede", existing: "permit-old", probe: "permit-new" },
  { label: "supersede", existing: "ins-old", probe: "ins-new" },
  { label: "supersede", existing: "hotel-150", probe: "hotel-190" },
  { label: "supersede", existing: "biscuit-5", probe: "biscuit-25" },
  { label: "supersede", existing: "release-weekly", probe: "release-fortnight" },
  { label: "supersede", existing: "volley-42", probe: "volley-52" },
  { label: "duplicate", existing: "standup-9", probe: "dup-standup" },
  { label: "duplicate", existing: "hotel-150", probe: "dup-hotel" },
  { label: "duplicate", existing: "biscuit-5", probe: "dup-biscuit" },
  { label: "duplicate", existing: "permit-old", probe: "dup-permit" },
  { label: "duplicate", existing: "release-weekly", probe: "dup-release" },
  { label: "duplicate", existing: "freeze-fri", probe: "dup-verbatim" },
  { label: "related", existing: "standup-9", probe: "rel-standup-lead" },
  { label: "related", existing: "freeze-fri", probe: "rel-freeze-scope" },
  { label: "related", existing: "ins-old", probe: "rel-ins-bikes" },
  { label: "related", existing: "hotel-150", probe: "rel-offsite" },
  { label: "related", existing: "biscuit-5", probe: "rel-biscuit-blood" },
  { label: "related", existing: "permit-old", probe: "rel-permit-enforce" },
  { label: "contradicts", existing: "con-wifi-a", probe: "con-wifi-b" },
  { label: "contradicts", existing: "con-retro-a", probe: "con-retro-b" },
  { label: "contradicts", existing: "con-desk-a", probe: "con-desk-b" },
  { label: "contradicts", existing: "con-budget-a", probe: "con-budget-b" },
];

const MAX_CANDIDATES = 5; // must match reconcile.ts

function stats(values: number[]): string {
  if (values.length === 0) return "n=0";
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]?.toFixed(3);
  return `n=${sorted.length}  min=${sorted[0]?.toFixed(3)}  p25=${q(0.25)}  med=${q(0.5)}  p75=${q(0.75)}  max=${sorted[sorted.length - 1]?.toFixed(3)}`;
}

async function main(): Promise<void> {
  const url = await createScratch();
  // node.owner_id references app_user — create the calibration tenant first.
  const ownerId = await (async (): Promise<string> => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const row = await client.query(
        "insert into app_user (clerk_user_id, email, status) values ('calibration', 'cal@example.com', 'active') returning id",
      );
      return String(row.rows[0]?.id);
    } finally {
      await client.end();
    }
  })();
  const store = new PgGraphStore({ connectionString: url, reconcileJudge: null });
  const context: GraphOperationContext = {
    actorId: "calibration",
    interfaceId: "calibration",
    requestId: `cal-${Date.now()}`,
    ownerId,
  };

  try {
    const ids = new Map<string, string>();
    for (const atom of ATOMS) {
      const node = await store.capture(
        { title: atom.title, type: "claim", summary: atom.fact, content: atom.fact, evidence: [], links: [] },
        context,
      );
      ids.set(atom.key, node.id);
    }
    // Drain every queued job (embeddings, reconcile heuristics, lint, ...).
    for (;;) {
      const job = await store.runJob({}, context);
      if (!job || job.status === "pending" || job.status === "running") break;
    }

    const partnerOf = new Map<string, { label: Label; key: string }>();
    for (const pair of PAIRS) {
      partnerOf.set(pair.probe, { label: pair.label, key: pair.existing });
    }
    const keyOf = new Map([...ids.entries()].map(([key, id]) => [id, key]));

    const distances: Record<Label, number[]> = { supersede: [], duplicate: [], contradicts: [], related: [] };
    const distinctDistances: number[] = [];
    // Per-probe finalist lists, kept for the gate simulation below.
    const probes: Array<{ key: string; partner: { label: Label; key: string } | undefined; finalists: Array<{ key: string; distance: number | undefined }> }> = [];
    let oldPolicyJudgeCalls = 0;
    const notes: string[] = [];

    for (const atom of ATOMS) {
      const nodeId = ids.get(atom.key) as string;
      // The exact candidate-match reconciliation performs (reconcile.ts).
      const [lexical, semantic] = await Promise.all([
        store.search({ query: atom.title, mode: "lexical", limit: MAX_CANDIDATES + 1, includeTextUnits: false }, context),
        store.search({ query: `${atom.title}\n${atom.fact}`, mode: "semantic", limit: MAX_CANDIDATES + 1, includeTextUnits: false }, context),
      ]);
      const merged = new Map<string, { key: string; distance: number | undefined }>();
      for (const hit of [...lexical.nodes, ...semantic.nodes]) {
        if (hit.id === nodeId) continue;
        const key = keyOf.get(hit.id) ?? "?";
        const existing = merged.get(hit.id);
        merged.set(hit.id, { key, distance: existing?.distance ?? hit.distance });
      }
      const finalists = [...merged.values()].slice(0, MAX_CANDIDATES);
      oldPolicyJudgeCalls += finalists.length;

      const partner = partnerOf.get(atom.key);
      const partnerHit = partner ? merged.get(ids.get(partner.key) as string) : undefined;
      if (partner) {
        if (!partnerHit) {
          notes.push(`MISS  ${atom.key}: partner ${partner.key} (${partner.label}) not in candidate set at all`);
        } else {
          distances[partner.label].push(partnerHit.distance as number);
          if (partnerHit.distance === undefined) {
            notes.push(`LEXICAL-ONLY  ${atom.key}: partner ${partner.key} (${partner.label}) has no distance`);
          }
        }
      }
      for (const hit of finalists) {
        if (partner && hit.key === partner.key) continue; // already recorded above
        if (hit.distance !== undefined) distinctDistances.push(hit.distance);
      }
      probes.push({ key: atom.key, partner, finalists });
    }

    const noPartnerProbes = probes.filter((probe) => !probe.partner);

    console.log(`\n=== reconcile-gate calibration ===`);
    console.log(`corpus: ${ATOMS.length} atoms, 1 owner, pg driver, model ${MODEL}`);
    console.log(`probes: ${probes.length} writes (${PAIRS.filter((p) => p.label === "supersede").length} supersede, ${PAIRS.filter((p) => p.label === "duplicate").length} duplicate, ${PAIRS.filter((p) => p.label === "contradicts").length} contradicts, ${PAIRS.filter((p) => p.label === "related").length} related, ${noPartnerProbes.length} no-partner)`);
    console.log(`\npartner distances (the classes that must NOT be gated away):`);
    console.log(`  supersede  : ${stats(distances.supersede)}`);
    console.log(`  duplicate  : ${stats(distances.duplicate)}`);
    console.log(`  contradicts: ${stats(distances.contradicts)}`);
    console.log(`  related    : ${stats(distances.related)}  (no actionable verdict — gating these costs nothing)`);
    console.log(`\ncandidate distances for non-partner (distinct-by-construction) hits:`);
    console.log(`  distinct  : ${stats(distinctDistances)}`);
    console.log(`\nraw values:`);
    for (const label of ["supersede", "duplicate", "contradicts", "related"] as const) {
      console.log(`  ${label.padEnd(11)}: ${distances[label].map((d) => d.toFixed(3)).sort().join(" ")}`);
    }
    console.log(`  distinct   : ${distinctDistances.map((d) => d.toFixed(3)).sort().join(" ")}`);
    console.log(`\nseparation summary:`);
    const max = (xs: number[]) => Math.max(...xs);
    const min = (xs: number[]) => Math.min(...xs);
    const actionable = [...distances.supersede, ...distances.duplicate, ...distances.contradicts];
    console.log(`  max(duplicate) = ${max(distances.duplicate).toFixed(3)}  vs  min(supersede) = ${min(distances.supersede).toFixed(3)}  (duplicate no-call band needs a gap here)`);
    console.log(`  max(actionable: supersede ∪ duplicate ∪ contradicts) = ${max(actionable).toFixed(3)}  — the skip band must sit above this with margin`);
    console.log(`\nold policy cost: ${oldPolicyJudgeCalls} judge calls for ${probes.length} writes (every finalist judged, one call each)`);

    // Gate simulation: at candidate thresholds, how many calls does the gated
    // + batched policy make, and — the trap guard — does it skip any PARTNER?
    console.log(`\ngate simulation (skip finalists with distance > T, batch the rest into one call):`);
    for (const threshold of [0.4, 0.45, 0.5]) {
      let calls = 0;
      let pairsJudged = 0;
      let zeroCallWrites = 0;
      const skippedActionable: string[] = [];
      const skippedRelated: string[] = [];
      for (const probe of probes) {
        const survivors = probe.finalists.filter((hit) => hit.distance === undefined || hit.distance <= threshold);
        if (survivors.length === 0) {
          zeroCallWrites += 1;
        } else {
          calls += 1;
          pairsJudged += survivors.length;
        }
        if (probe.partner && !survivors.some((hit) => hit.key === probe.partner?.key)) {
          const entry = `${probe.key}->${probe.partner.key} (${probe.partner.label})`;
          if (probe.partner.label === "related") skippedRelated.push(entry);
          else skippedActionable.push(entry);
        }
      }
      console.log(
        `  T=${threshold.toFixed(2)}: ${calls} calls for ${probes.length} writes (${zeroCallWrites} writes make 0 calls, ${pairsJudged} pairs judged)` +
          (skippedActionable.length > 0 ? `  *** SKIPS ACTIONABLE PARTNER: ${skippedActionable.join(", ")}` : "  (no actionable partner skipped)") +
          (skippedRelated.length > 0 ? `  [related partners skipped: ${skippedRelated.length} — no action lost]` : ""),
      );
    }
    if (notes.length > 0) console.log(`\nnotes:\n  ${notes.join("\n  ")}`);

    // Implementation check: run the SHIPPED performReconcileNode for every
    // write with a counting judge, and verify the simulation's numbers against
    // the real code path. The trap guard: every labelled partner must reach
    // the judge (via="judge"), never the gate.
    let realCalls = 0;
    const guardFailures: string[] = [];
    const gatedRelated: string[] = [];
    const countingJudge: ReconcileJudge = async ({ candidates }) =>
      candidates.map(() => ({ verdict: "related", confidence: 0.9, reason: "calibration run" }));
    for (const atom of ATOMS) {
      const result = await performReconcileNode(store, { nodeId: ids.get(atom.key) as string, ownerId }, countingJudge);
      realCalls += result.judgeCalls;
      const partner = partnerOf.get(atom.key);
      if (partner) {
        const entry = result.candidates.find((candidate) => candidate.nodeId === ids.get(partner.key));
        if (entry && entry.via === "distance_gate") {
          if (partner.label === "related") {
            gatedRelated.push(`${atom.key}->${partner.key} (d=${entry.distance?.toFixed(3)})`);
          } else {
            guardFailures.push(`${atom.key}->${partner.key} (${partner.label}) gated at d=${entry.distance}`);
          }
        }
      }
    }
    console.log(`\nimplementation check (shipped performReconcileNode, judgeCalls summed from job results):`);
    console.log(`  ${realCalls} judge calls for ${ATOMS.length} writes on this corpus (old policy: ${oldPolicyJudgeCalls})`);
    console.log(guardFailures.length === 0
      ? `  trap guard: every actionable partner (supersede/duplicate/contradicts) reached the judge — none gated`
      : `  *** TRAP GUARD FAILURES: ${guardFailures.join(", ")}`);
    if (gatedRelated.length > 0) {
      console.log(`  related partners gated (no actionable verdict — expected): ${gatedRelated.join(", ")}`);
    }
  } finally {
    await store.close();
  }
}

await main();
