/**
 * The companion skills, served by the server.
 *
 * `skills/<name>/SKILL.md` is the single source for three surfaces: the
 * `npx skills add` install, the `/skills.md` and `/skills/<name>.md` routes,
 * and the MCP prompt of the same name. Editing the file updates all three on
 * the next deploy, so the copy a user pastes into a session and the copy their
 * agent installed cannot drift apart.
 *
 * Files are read once and cached; the directory is part of the image.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type Skill = {
  name: string;
  description: string;
  /** Markdown body with the frontmatter removed. */
  body: string;
  /** The file as shipped, frontmatter included. */
  raw: string;
};

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function parseFrontmatter(raw: string): { name: string | undefined; description: string | undefined; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { name: undefined, description: undefined, body: raw };
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { name: fields.name, description: fields.description, body: raw.slice(match[0].length).trim() };
}

function loadSkills(directory: string): Map<string, Skill> {
  const skills = new Map<string, Skill>();
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return skills;
  }
  for (const entry of entries.sort()) {
    if (!SKILL_NAME.test(entry)) continue;
    const path = join(directory, entry, "SKILL.md");
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    const raw = readFileSync(path, "utf8");
    const parsed = parseFrontmatter(raw);
    skills.set(entry, {
      name: parsed.name ?? entry,
      description: parsed.description ?? "",
      body: parsed.body,
      raw,
    });
  }
  return skills;
}

let cache: { directory: string; skills: Map<string, Skill> } | null = null;

function skillsDirectory(): string {
  return resolve(process.env.TROVE_SKILLS_DIR ?? "skills");
}

function skills(): Map<string, Skill> {
  const directory = skillsDirectory();
  if (!cache || cache.directory !== directory) cache = { directory, skills: loadSkills(directory) };
  return cache.skills;
}

/** Test seam: forget the cached directory listing. */
export function resetSkillsCache(): void {
  cache = null;
}

export function listSkills(): Skill[] {
  return [...skills().values()];
}

export function getSkill(name: string): Skill | null {
  if (!SKILL_NAME.test(name)) return null;
  return skills().get(name) ?? null;
}

/** `GET /skills.md`: one line per skill, plus how to install and where the raw files are. */
export function skillsIndexMarkdown(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const lines = [
    "# Trove skills",
    "",
    "Companion skills for agents that use the Trove memory graph over MCP. Each file is a",
    "complete procedure an agent can follow; paste one into a session, or read it by URL.",
    "",
    "Install all of them for Claude Code:",
    "",
    "```",
    "npx skills add anunay999/trove -g",
    "```",
    "",
    "Or point an agent at a single file:",
    "",
  ];
  for (const skill of listSkills()) {
    lines.push(`- [${skill.name}](${base}/skills/${skill.name}.md) — ${skill.description}`);
  }
  lines.push(
    "",
    `MCP endpoint: ${base}/mcp (Bearer token: a \`trove_*\` API key). The same procedures are exposed as MCP prompts of the same name.`,
    "",
  );
  return lines.join("\n");
}

// llms.txt links should be markdown, so these are raw files rather than GitHub's HTML pages.
const DOCS = "https://raw.githubusercontent.com/anunay999/trove/main/docs";

/** `GET /llms.txt`: the llms.txt convention, pointing at the MCP endpoint, docs and skills. */
export function llmsTxt(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const lines = [
    "# Trove",
    "",
    "> Trove is an open-source MCP memory server: one shared memory for Claude Code, Codex, Cursor and any other MCP client. Every fact shows its source, and stale facts get replaced. Hosted at https://mytrove.in, or self-host it (AGPL-3.0).",
    "",
    "Agents load what is known with `recall`, `grep` and `read`, and save or correct it with `remember`, `ingest`, `connect` and `forget`.",
    "",
    "## Connect",
    "",
    `- [MCP endpoint](${base}/mcp): Streamable HTTP. Send a trove_* API key as a Bearer token, or sign in with OAuth where the server has it enabled.`,
    "",
    "## Docs",
    "",
    `- [Quickstart](${DOCS}/quickstart.md): keys, connecting agents, local setup, importing notes.`,
    `- [Agent usage](${DOCS}/agent-usage.md): how agents should use Trove as working memory.`,
    `- [MCP tools](${DOCS}/mcp.md): full tool and resource reference.`,
    `- [OAuth connector](${DOCS}/oauth.md): connecting claude.ai and Claude Desktop.`,
    "",
    "## Skills",
    "",
  ];
  for (const skill of listSkills()) {
    lines.push(`- [${skill.name}](${base}/skills/${skill.name}.md): ${skill.description}`);
  }
  lines.push(
    "",
    `- [All skills](${base}/skills.md)`,
    "",
    "## Optional",
    "",
    "- [Source code](https://github.com/anunay999/trove): the GitHub repository.",
    `- [HTTP API](${DOCS}/agent-api.md): the HTTP API contract.`,
    `- [CLI](${DOCS}/cli.md): the reference CLI.`,
    `- [Deployment](${DOCS}/deployment.md): self-hosting with Docker, Railway and Postgres.`,
    `- [Architecture](${DOCS}/architecture.md): how the system fits together.`,
    "",
  );
  return lines.join("\n");
}
