import { resolve } from "node:path";
import { TroveHttpClient } from "../src/httpClient.js";
import { writeObsidianVaultExport } from "../src/obsidianExport.js";
import type {
  CaptureInput,
  CreateViewInput,
  EnqueueJobInput,
  GraphJobKind,
  GraphJobStatus,
} from "../src/contracts.js";

type ParsedArgs = {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

const parsed = parseArgs(process.argv.slice(2));
const clientOptions = {
  baseUrl: process.env.TROVE_BASE_URL ?? "http://localhost:8787",
  interfaceId: process.env.TROVE_INTERFACE_ID ?? "cli",
  ...(process.env.TROVE_SERVICE_TOKEN ? { token: process.env.TROVE_SERVICE_TOKEN } : {}),
};
const client = new TroveHttpClient(clientOptions);

try {
  switch (parsed.command) {
    case "ready":
      printJson(await client.ready());
      break;
    case "query":
      await query(parsed);
      break;
    case "capture":
      await capture(parsed);
      break;
    case "lint":
      printJson(await client.lint());
      break;
    case "events":
      await events(parsed);
      break;
    case "jobs":
      await jobs(parsed);
      break;
    case "views":
      await views(parsed);
      break;
    case "create-view":
      await createView(parsed);
      break;
    case "read-view":
      await readView(parsed);
      break;
    case "delete-view":
      await deleteView(parsed);
      break;
    case "enqueue-job":
      await enqueueJob(parsed);
      break;
    case "run-job":
      await runJob(parsed);
      break;
    case "export-obsidian":
      await exportObsidian(parsed);
      break;
    case "help":
    case "":
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${parsed.command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

async function query(args: ParsedArgs): Promise<void> {
  const queryText = args.positionals.join(" ").trim() || stringFlag(args, "query");
  if (!queryText) throw new Error("query requires text.");

  printJson(await client.search({
    query: queryText,
    includeTextUnits: booleanFlag(args, "text-units", true),
    mode: stringFlag(args, "mode", "hybrid") as "lexical" | "semantic" | "hybrid",
    limit: numberFlag(args, "limit", 10),
  }));
}

async function capture(args: ParsedArgs): Promise<void> {
  const title = stringFlag(args, "title");
  const summary = stringFlag(args, "summary");
  if (!title) throw new Error("capture requires --title.");
  if (!summary) throw new Error("capture requires --summary.");

  const input: CaptureInput = {
    title,
    summary,
    type: stringFlag(args, "type", "claim") as CaptureInput["type"],
    content: stringFlag(args, "content") || undefined,
    evidence: [],
    links: [],
  };

  printJson(await client.capture(input));
}

async function exportObsidian(args: ParsedArgs): Promise<void> {
  const outputDir = resolve(args.positionals[0] ?? "exports/obsidian");
  const vaultExport = await client.exportObsidian();
  const result = await writeObsidianVaultExport(outputDir, vaultExport);
  printJson({
    ...result,
    fileCount: vaultExport.manifest.fileCount,
    contentSha256: vaultExport.manifest.contentSha256,
  });
}

async function jobs(args: ParsedArgs): Promise<void> {
  const result = await client.jobs({
    status: optionalStringFlag(args, "status") as GraphJobStatus | undefined,
    kind: optionalStringFlag(args, "kind") as GraphJobKind | undefined,
    limit: numberFlag(args, "limit", 25),
  });
  if (booleanFlag(args, "full", false)) {
    printJson(result);
    return;
  }

  printJson({
    jobs: result.jobs.map((job) => ({
      id: job.id,
      kind: job.kind,
      status: job.status,
      priority: job.priority,
      dedupeKey: job.dedupeKey,
      attempts: job.attempts,
      error: job.error,
      resultSummary: summarizeJobResult(job.result),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
    })),
  });
}

async function events(args: ParsedArgs): Promise<void> {
  printJson(await client.events({
    afterCursor: optionalStringFlag(args, "after-cursor"),
    limit: numberFlag(args, "limit", 25),
  }));
}

async function views(args: ParsedArgs): Promise<void> {
  printJson(await client.views({
    query: optionalStringFlag(args, "query"),
    limit: numberFlag(args, "limit", 25),
  }));
}

async function createView(args: ParsedArgs): Promise<void> {
  const title = stringFlag(args, "title") || args.positionals.join(" ").trim();
  if (!title) throw new Error("create-view requires --title or a positional title.");

  const input: CreateViewInput = {
    title,
    slug: optionalStringFlag(args, "slug"),
    rootNodeId: optionalStringFlag(args, "root-node-id"),
    rootSlug: optionalStringFlag(args, "root-slug"),
    query: optionalStringFlag(args, "query"),
    summary: optionalStringFlag(args, "summary"),
    depth: numberFlag(args, "depth", 1),
    predicates: optionalCsvFlag(args, "predicates"),
    layout: parseJsonObjectFlag(args, "layout-json", {}),
  };
  printJson(await client.createView(input));
}

async function readView(args: ParsedArgs): Promise<void> {
  const identifier = args.positionals[0] ?? optionalStringFlag(args, "slug") ?? optionalStringFlag(args, "view-id");
  if (!identifier) throw new Error("read-view requires a slug or view id.");
  const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identifier);
  printJson(await client.readView(byId ? { viewId: identifier } : { slug: identifier }));
}

async function deleteView(args: ParsedArgs): Promise<void> {
  const identifier = args.positionals[0] ?? optionalStringFlag(args, "slug") ?? optionalStringFlag(args, "view-id");
  if (!identifier) throw new Error("delete-view requires a slug or view id.");
  const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identifier);
  printJson(await client.deleteView(byId ? { viewId: identifier } : { slug: identifier }));
}

async function enqueueJob(args: ParsedArgs): Promise<void> {
  const kind = args.positionals[0] ?? stringFlag(args, "kind");
  if (!kind) throw new Error("enqueue-job requires a job kind.");

  const input: EnqueueJobInput = {
    kind: kind as EnqueueJobInput["kind"],
    payload: parseJsonObjectFlag(args, "payload-json", {}),
    priority: numberFlag(args, "priority", 50),
    dedupeKey: optionalStringFlag(args, "dedupe-key"),
  };
  printJson(await client.enqueueJob(input));
}

async function runJob(args: ParsedArgs): Promise<void> {
  printJson(await client.runJob({
    jobId: args.positionals[0] ?? optionalStringFlag(args, "job-id"),
  }));
}

function parseArgs(rawArgs: string[]): ParsedArgs {
  const [command = "", ...rest] = rawArgs;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg?.startsWith("--")) {
      if (arg) positionals.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  return { command, positionals, flags };
}

function stringFlag(args: ParsedArgs, name: string, fallback = ""): string {
  const value = args.flags[name];
  return typeof value === "string" ? value : fallback;
}

function optionalStringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = stringFlag(args, name);
  return value || undefined;
}

function numberFlag(args: ParsedArgs, name: string, fallback: number): number {
  const value = Number(args.flags[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number.`);
  return value;
}

function booleanFlag(args: ParsedArgs, name: string, fallback: boolean): boolean {
  const value = args.flags[name];
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  return !["false", "0", "no"].includes(value.toLowerCase());
}

function optionalCsvFlag(args: ParsedArgs, name: string): string[] | undefined {
  const value = optionalStringFlag(args, name);
  return value ? value.split(",").map((part) => part.trim()).filter(Boolean) : undefined;
}

function parseJsonObjectFlag(args: ParsedArgs, name: string, fallback: Record<string, unknown>): Record<string, unknown> {
  const raw = stringFlag(args, name);
  if (!raw) return fallback;
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`--${name} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function summarizeJobResult(result: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!result) return null;
  const manifest = asRecord(result.manifest);
  const lint = asRecord(result.lint);
  const missing = asRecord(result.missing);
  return {
    ...(typeof result.fileCount === "number" ? { fileCount: result.fileCount } : {}),
    ...(manifest ? {
      manifest: {
        fileCount: manifest.fileCount,
        contentSha256: manifest.contentSha256,
      },
    } : {}),
    ...(lint ? { lint } : {}),
    ...(missing ? { missing } : {}),
    ...(typeof result.status === "string" ? { status: result.status } : {}),
    ...(typeof result.provider === "string" ? { provider: result.provider } : {}),
    ...(typeof result.model === "string" ? { model: result.model } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function printHelp(): void {
  console.log([
    "Trove CLI",
    "",
    "Environment:",
    "  TROVE_BASE_URL       default http://localhost:8787",
    "  TROVE_SERVICE_TOKEN  Bearer token for hosted service calls",
    "  TROVE_INTERFACE_ID   default cli",
    "",
    "Commands:",
    "  ready",
    "  query <text> [--limit 10] [--text-units false] [--mode hybrid]",
    "  capture --title <title> --summary <summary> [--type claim] [--content <text>]",
    "  lint",
    "  events [--after-cursor cursor] [--limit 25]",
    "  views [--query text] [--limit 25]",
    "  create-view --title <title> [--root-slug slug | --query text] [--depth 1]",
    "  read-view <slug-or-id>",
    "  delete-view <slug-or-id>",
    "  jobs [--status pending] [--kind lint_graph] [--limit 25] [--full]",
    "  enqueue-job <kind> [--priority 50] [--dedupe-key key] [--payload-json '{}']",
    "  run-job [job-id]",
    "  export-obsidian [output-dir]",
  ].join("\n"));
}
