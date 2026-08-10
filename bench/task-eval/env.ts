import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Task-eval config. Two hard rules encoded here:
 *  1. OpenAI MUST go to the real API. The ambient shell exports a proxy
 *     (OPENAI_BASE_URL=http://anunay:8317/v1) + a different key that 404s.
 *     We ignore the ambient env entirely: base URL is pinned to api.openai.com
 *     and the key is read straight out of .env.
 *  2. Trove MUST use the LOCAL docker Postgres, never the hosted prod MCP.
 *     DATABASE_URL is pinned to the local docker DSN.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

function parseDotenv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const dotenv = parseDotenv(resolve(repoRoot, ".env"));

export const OPENAI_API_KEY = dotenv.OPENAI_API_KEY ?? "";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const MODEL = "gpt-4o-mini";

/**
 * Local docker Postgres. Prefer the .env DSN when it clearly points at
 * localhost (per the project memory the local .env is the docker DSN), else
 * fall back to the known-good local string. Never a remote host.
 */
function resolveLocalDatabaseUrl(): string {
  const fallback = "postgres://trove:trove@localhost:5433/trove";
  const fromEnv = dotenv.DATABASE_URL ?? "";
  if (fromEnv && /(localhost|127\.0\.0\.1)/.test(fromEnv)) return fromEnv;
  return fallback;
}

export const LOCAL_DATABASE_URL = resolveLocalDatabaseUrl();

export function assertLocalDatabase(): void {
  if (!/(localhost|127\.0\.0\.1)/.test(LOCAL_DATABASE_URL)) {
    throw new Error(`Refusing to run: DATABASE_URL is not local (${LOCAL_DATABASE_URL}).`);
  }
}
