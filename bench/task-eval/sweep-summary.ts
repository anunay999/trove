/**
 * Degradation summary for a clutter sweep.
 *
 * Reads every results-clutter-*.json in this directory (written by run.ts) and
 * prints, per arm, how context_pickup and stale_belief move as clutter grows.
 * The thesis prediction: scratchpad degrades (superseded value buried in a long
 * notes file it must read whole), while trove stays flat (tokenBudget-bounded
 * recall surfaces the current value and marks the old one SUPERSEDED).
 *
 * Usage: node --import tsx bench/task-eval/sweep-summary.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

type MetricCell = { value: number | null; n: number };
type Table = {
  arm: string;
  context_pickup: MetricCell;
  stale_belief: MetricCell;
  meanTokensIn: number;
};
type Results = {
  meta: { clutter: number; fillersPerRun: number };
  metricTable: Table[];
};

function pct(v: number | null): string {
  return v === null ? "n/a" : `${(v * 100).toFixed(0)}%`;
}

function main(): void {
  const files = readdirSync(here)
    .filter((f) => /^results-clutter-\d+\.json$/.test(f))
    .map((f) => resolve(here, f));
  if (files.length === 0) {
    console.error("No results-clutter-*.json found. Run the sweep first.");
    process.exit(1);
  }

  const loaded: Results[] = files
    .map((f) => JSON.parse(readFileSync(f, "utf8")) as Results)
    .sort((a, b) => a.meta.clutter - b.meta.clutter);

  const arms = [...new Set(loaded.flatMap((r) => r.metricTable.map((t) => t.arm)))];

  console.log("=== CLUTTER DEGRADATION SWEEP ===");
  console.log("context_pickup↑ / stale_belief↓ / mean_tokens_in  per arm, by clutter level\n");

  const head = "clutter".padEnd(9) + arms.map((a) => a.padEnd(34)).join("");
  console.log(head);
  console.log(
    "".padEnd(9) +
      arms.map(() => `${"pickup".padEnd(9)}${"stale".padEnd(9)}${"tokens".padEnd(16)}`).join(""),
  );

  for (const r of loaded) {
    let row = String(r.meta.clutter).padEnd(9);
    for (const arm of arms) {
      const t = r.metricTable.find((x) => x.arm === arm);
      if (!t) {
        row += "".padEnd(34);
        continue;
      }
      row +=
        pct(t.context_pickup.value).padEnd(9) +
        pct(t.stale_belief.value).padEnd(9) +
        t.meanTokensIn.toFixed(0).padEnd(16);
    }
    console.log(row);
  }
}

main();
