import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { assertLocalDatabase, LOCAL_DATABASE_URL, MODEL, OPENAI_API_KEY } from "./env.js";
import { createArm, type Arm } from "./arms.js";
import { runSession } from "./agent.js";
import { scenarios as ALL_SCENARIOS, scenarioById, type Session } from "./scenarios.js";
import { aggregate, scoreSession, type MetricTable, type SessionScore } from "./score.js";
import { clutterSeed, pickDistractors } from "./distractors.js";

const here = dirname(fileURLToPath(import.meta.url));

type Flags = { scenarios: number[]; arms: string[]; seeds: number; maxToolCalls: number; clutter: number };

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    scenarios: ALL_SCENARIOS.map((s) => s.id),
    arms: ["trove", "scratchpad", "nomem"],
    seeds: 3,
    maxToolCalls: 6,
    clutter: 0,
  };
  for (const arg of argv) {
    const m = /^--([\w-]+)=(.*)$/.exec(arg);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "scenarios") flags.scenarios = value!.split(",").map((v) => Number(v.trim())).filter((n) => Number.isFinite(n));
    else if (key === "arms") flags.arms = value!.split(",").map((v) => v.trim()).filter(Boolean);
    else if (key === "seeds") flags.seeds = Math.max(1, Number(value));
    else if (key === "maxToolCalls") flags.maxToolCalls = Math.max(1, Number(value));
    else if (key === "clutter") flags.clutter = Math.max(0, Number(value));
  }
  return flags;
}

/** Number of filler sessions dripped between the supersede event and the query. */
function fillerCount(clutter: number): number {
  return Math.min(Math.floor(clutter / 4), 8);
}

/**
 * Plant one distractor fact into an arm's memory through its OWN persistence
 * path — trove `remember`, scratchpad `write_notes`, nomem nothing. Direct tool
 * call (not via the LLM) so up-front clutter is deterministic and free. Both
 * arms plant byte-identical facts (see pickDistractors seeding).
 */
async function plantFact(arm: Arm, fact: string): Promise<void> {
  const tools = arm.tools();
  const remember = tools.find((t) => t.name === "remember");
  if (remember) {
    const title = fact.replace(/[.]$/, "").split(/\s+/).slice(0, 6).join(" ");
    await remember.run({ title, summary: fact });
    return;
  }
  const write = tools.find((t) => t.name === "write_notes");
  if (write) {
    await write.run({ text: fact });
    return;
  }
  // nomem — no persistence; clutter is a no-op, by design.
}

/**
 * Diagnostic: for an arm that keeps a readable notes buffer (scratchpad), report
 * how long the buffer is and how deeply the superseded (must_not) value is
 * buried in it. This is the evidence that clutter actually lands.
 */
async function clutterProbe(arm: Arm, freshBelief: Session): Promise<string | null> {
  const read = arm.tools().find((t) => t.name === "read_notes");
  if (!read) return null;
  const notes = await read.run({});
  if (notes.startsWith("(notes are empty)")) return null;
  const chars = notes.length;
  const lines = notes.split("\n").length;
  const mnRaw = freshBelief.score.must_not;
  const mn = (Array.isArray(mnRaw) ? mnRaw[0] : mnRaw) ?? "";
  let buried = "";
  if (mn) {
    const idx = notes.toLowerCase().indexOf(mn.toLowerCase());
    if (idx >= 0) {
      const linesBefore = notes.slice(0, idx).split("\n").length;
      const depthPct = ((idx / chars) * 100).toFixed(0);
      buried = ` | superseded value "${mn}" first appears at line ${linesBefore}/${lines} (${depthPct}% into the file)`;
    } else {
      buried = ` | superseded value "${mn}" not present`;
    }
  }
  return `notes buffer: ${lines} lines, ${chars} chars${buried}`;
}

function pct(v: number | null): string {
  return v === null ? "  n/a" : `${(v * 100).toFixed(0).padStart(3)}%`;
}

function fmtMetric(m: { value: number | null; n: number }): string {
  return `${pct(m.value)} (n=${m.n})`;
}

function printSessionLine(s: SessionScore): void {
  const tag =
    s.kind === "seed" || s.kind === "supersede"
      ? "·"
      : s.pass
        ? "PASS"
        : "MISS";
  const extras: string[] = [];
  if (s.staleBelief) extras.push("STALE");
  if (s.rederived) extras.push("rederived");
  const snippet = s.answer.replace(/\s+/g, " ").slice(0, 90);
  console.log(
    `    s${s.n} [${s.kind.padEnd(12)}] ${tag.padEnd(4)} ${extras.join(",").padEnd(16)} ` +
      `tools=[${s.toolNames.join(",")}] tok=${s.tokensIn} ${s.latencyMs}ms :: ${snippet}`,
  );
}

function printMetricTable(tables: MetricTable[]): void {
  console.log("\n=== METRIC TABLE (pooled over scenarios × seeds) ===");
  console.log(
    "arm".padEnd(12) +
      "context_pickup↑".padEnd(18) +
      "rederivation↓".padEnd(18) +
      "stale_belief↓".padEnd(18) +
      "citation↑".padEnd(18) +
      "control↑".padEnd(18),
  );
  for (const t of tables) {
    console.log(
      t.arm.padEnd(12) +
        fmtMetric(t.context_pickup).padEnd(18) +
        fmtMetric(t.rederivation).padEnd(18) +
        fmtMetric(t.stale_belief).padEnd(18) +
        fmtMetric(t.citation).padEnd(18) +
        fmtMetric(t.control_pass).padEnd(18),
    );
  }
  console.log("\n=== COST TRIPLE (mean per scored session) ===");
  console.log("arm".padEnd(12) + "mean_tokens_in".padEnd(18) + "mean_latency_ms".padEnd(18) + "sessions".padEnd(10));
  for (const t of tables) {
    console.log(
      t.arm.padEnd(12) +
        t.meanTokensIn.toFixed(0).padEnd(18) +
        t.meanLatencyMs.toFixed(0).padEnd(18) +
        String(t.sessions).padEnd(10),
    );
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  assertLocalDatabase();
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing from .env");

  const nFillers = fillerCount(flags.clutter);
  console.log(`task-eval | model=${MODEL} | db=${LOCAL_DATABASE_URL}`);
  console.log(
    `scenarios=${flags.scenarios.join(",")} arms=${flags.arms.join(",")} seeds=${flags.seeds} ` +
      `maxToolCalls=${flags.maxToolCalls} clutter=${flags.clutter} (fillers=${nFillers}/run)\n`,
  );

  const allScores: SessionScore[] = [];

  for (const armName of flags.arms) {
    const arm = createArm(armName);
    console.log(`\n########## ARM: ${armName} ##########`);
    try {
      for (const scenarioId of flags.scenarios) {
        const scenario = scenarioById(scenarioId);
        const freshBelief = scenario.sessions.find((s) => s.score.kind === "fresh-belief");
        for (let seed = 1; seed <= flags.seeds; seed += 1) {
          const runId = `s${scenarioId}-${armName}-seed${seed}`;
          await arm.reset(runId);
          console.log(`\n  Scenario ${scenario.id} "${scenario.title}" — seed ${seed}`);

          // Seed-controlled clutter: BOTH arms get byte-identical facts and
          // filler ordering for a given (scenario, seed). Up-front block + a
          // reserved slice of fresh facts for the fillers.
          const pool = pickDistractors(clutterSeed(scenarioId, seed), flags.clutter + nFillers);
          const upfront = pool.slice(0, flags.clutter);
          const fillerFacts = pool.slice(flags.clutter, flags.clutter + nFillers);
          for (const fact of upfront) await plantFact(arm, fact);
          if (flags.clutter > 0) {
            console.log(`    · planted ${upfront.length} distractor facts up front (unscored clutter)`);
          }

          for (const session of scenario.sessions) {
            // Show the clutter landing right before the supersession test.
            if (flags.clutter > 0 && freshBelief && session.n === freshBelief.n) {
              const probe = await clutterProbe(arm, freshBelief);
              if (probe) console.log(`    · [clutter probe] ${probe}`);
            }

            const result = await runSession(session.task, arm.tools(), flags.maxToolCalls);
            const score = scoreSession(session, result, { scenarioId, arm: armName, seed });
            allScores.push(score);
            printSessionLine(score);

            // Drip filler sessions between the supersede event and the query:
            // each is a real (unscored) session that adds one more fact, so
            // both distance and volume grow before the fresh-belief question.
            if (session.score.kind === "supersede" && fillerFacts.length > 0) {
              for (let f = 0; f < fillerFacts.length; f += 1) {
                const fact = fillerFacts[f]!;
                const fres = await runSession(
                  `Record this internal fact so future sessions can use it: ${fact}`,
                  arm.tools(),
                  flags.maxToolCalls,
                );
                console.log(
                  `    f${f + 1} [filler      ] ·    (unscored)         ` +
                    `tools=[${fres.toolNames.join(",")}] tok=${fres.tokensIn} ${fres.latencyMs}ms :: ${fact.slice(0, 60)}`,
                );
              }
            }
          }
        }
      }
    } finally {
      await arm.close();
    }
  }

  const tables = flags.arms.map((armName) => aggregate(armName, allScores.filter((s) => s.arm === armName)));
  console.log(`\n=== INVOCATION SUMMARY | clutter=${flags.clutter} (fillers=${nFillers}/run) ===`);
  printMetricTable(tables);

  // Per-session miss list.
  const misses = allScores.filter(
    (s) => (s.pass === false && s.kind !== "seed" && s.kind !== "supersede") || s.staleBelief === true,
  );
  console.log("\n=== MISS LIST ===");
  if (misses.length === 0) {
    console.log("  (no misses)");
  } else {
    for (const m of misses) {
      const why = m.staleBelief ? "STALE-BELIEF" : `failed ${m.kind}`;
      console.log(`  arm=${m.arm} scenario=${m.scenarioId} seed=${m.seed} s${m.n} ${why} :: ${m.answer.replace(/\s+/g, " ").slice(0, 100)}`);
    }
  }

  const out = {
    meta: {
      model: MODEL,
      database: LOCAL_DATABASE_URL,
      scenarios: flags.scenarios,
      arms: flags.arms,
      seeds: flags.seeds,
      maxToolCalls: flags.maxToolCalls,
      clutter: flags.clutter,
      fillersPerRun: nFillers,
      generatedAt: new Date().toISOString(),
    },
    metricTable: tables,
    misses,
    sessions: allScores,
  };
  // Clutter-suffixed filename so a degradation sweep produces one file per level
  // (results-clutter-0.json, -20.json, -40.json) for sweep-summary.ts to read.
  const outPath = resolve(here, `results-clutter-${flags.clutter}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
