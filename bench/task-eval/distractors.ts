/**
 * Accumulated clutter for the v2 eval.
 *
 * A pool of ~50 realistic, unrelated one-line project facts (ops, billing, api,
 * people, infra). At clutter>0 these are planted into BOTH arms identically
 * before a scenario runs, and dripped in via filler sessions between the
 * supersede event and the fresh-belief query — so the superseded value is
 * buried in a long notes file and the agent must search/rank, not read-all.
 *
 * CRITICAL SAFETY INVARIANT: no distractor may contain ANY scenario's
 * expect/must_not scoring token (case-insensitive substring). If one did, a
 * scratchpad arm that reads its whole notes buffer could echo a distractor line
 * and score a spurious PASS/MISS — clutter would poison scoring. We extract the
 * full token set from `scenarios` at module load and throw if any distractor
 * collides. Clutter can never touch the scoreboard.
 */

import { scenarios } from "./scenarios.js";

export const DISTRACTORS: string[] = [
  // --- ops ---
  "The staging cluster runs in the eu-west-1 region.",
  "Nightly backups complete by 2am UTC.",
  "The CI pipeline uses a shared runner pool named 'atlas'.",
  "Log retention for the ingestion service is 45 days.",
  "The load balancer health path is /healthz.",
  "Blue-green rollouts are gated behind the 'release-train' label.",
  "The search index is rebuilt every Sunday morning.",
  "Feature flags are stored in the 'lark' config service.",
  "The metrics dashboard is hosted at grafana.internal.",
  "Rate limiting is handled by an nginx sidecar.",
  // --- billing ---
  "Receipts are emailed from billing@example.com.",
  "The finance team closes the books on the last Friday of the quarter.",
  "Enterprise contracts are billed annually in advance.",
  "Failed charges are retried up to three times.",
  "The pricing page lists four tiers: free, starter, team, and business.",
  "Refund requests route to the finance shared inbox.",
  "Sales tax is computed by the Avalara integration.",
  "Dunning emails go out after a failed card charge.",
  // --- api ---
  "The GraphQL gateway sits behind an Apollo router.",
  "Pagination uses opaque cursor tokens, not offsets.",
  "The webhooks service signs payloads with HMAC-SHA256.",
  "Idempotency keys are required on all write endpoints.",
  "The public API is documented with an OpenAPI spec.",
  "Deprecated routes return a Sunset response header.",
  "The default rate limit is 100 requests per minute per key.",
  "Auth tokens are JWTs signed with RS256.",
  // --- people ---
  "The head of engineering is based in Berlin.",
  "Design reviews happen every Tuesday afternoon.",
  "The on-call rotation is one week per engineer.",
  "New hires finish onboarding within their first sprint.",
  "The support team follows the sun across three offices.",
  "Marketing owns the public blog and release notes.",
  "The data team sits under the analytics org.",
  "Recruiting uses Greenhouse for the hiring funnel.",
  // --- infra ---
  "Secrets are managed in HashiCorp Vault.",
  "The Kubernetes clusters run on managed nodes.",
  "Terraform state is stored in an encrypted bucket.",
  "The CDN is fronted by Cloudflare.",
  "Container images are pushed to an internal registry.",
  "The primary datastore is a Postgres replica set.",
  "Redis caches session state with a short TTL.",
  "Observability is powered by OpenTelemetry traces.",
  "The message bus is Kafka with three brokers.",
  "Disaster recovery targets a one-hour RPO.",
  "VPN access is required for admin consoles.",
  // --- misc ---
  "The mobile app ships on a weekly release cadence.",
  "Customer data is stored in the US and EU regions.",
  "The analytics warehouse is Snowflake.",
  "Internal tools are built on Retool.",
  "The company wiki lives in Notion.",
  "Standups are async in the team channel.",
];

/** Every expect/must_not token across all scenarios, lowercased, deduped. */
function scoringTokens(): string[] {
  const tokens = new Set<string>();
  for (const sc of scenarios) {
    for (const s of sc.sessions) {
      for (const field of [s.score.expect, s.score.must_not]) {
        if (!field) continue;
        for (const t of Array.isArray(field) ? field : [field]) {
          const tok = t.trim().toLowerCase();
          if (tok) tokens.add(tok);
        }
      }
    }
  }
  return [...tokens];
}

/**
 * Fail loudly at load if any distractor contains any scoring token as a
 * substring. This is the guarantee that clutter cannot poison scoring.
 */
export function assertNoScoringCollision(): void {
  const tokens = scoringTokens();
  const collisions: string[] = [];
  for (const fact of DISTRACTORS) {
    const hay = fact.toLowerCase();
    for (const tok of tokens) {
      if (hay.includes(tok)) collisions.push(`distractor "${fact}" contains scoring token "${tok}"`);
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      `distractors.ts: ${collisions.length} distractor(s) collide with scenario scoring tokens — clutter would poison scoring:\n  ` +
        collisions.join("\n  "),
    );
  }
}

// Enforce the invariant at import time — no eval run can proceed with dirty clutter.
assertNoScoringCollision();

// ---------------------------------------------------------------------------
// Deterministic, seed-controlled selection so BOTH arms get identical clutter
// and identical filler ordering for a given (scenario, seed).
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically pick `count` distractor facts for a run. The same
 * `rngSeed` yields the same ordered list — so trove and scratchpad at the same
 * (scenario, seed) plant byte-identical clutter. If `count` exceeds the pool it
 * cycles through the shuffled pool (repeats allowed) rather than truncating.
 */
export function pickDistractors(rngSeed: number, count: number): string[] {
  if (count <= 0) return [];
  const rng = mulberry32(rngSeed);
  const shuffled = [...DISTRACTORS];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(shuffled[i % shuffled.length]!);
  return out;
}

/** Stable RNG seed for a (scenarioId, seed) pair — identical across arms. */
export function clutterSeed(scenarioId: number, seed: number): number {
  return scenarioId * 100003 + seed * 31 + 17;
}
