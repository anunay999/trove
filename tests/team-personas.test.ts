import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import pg from "pg";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { UserStore } from "../src/users.js";
import { createGraphStore } from "../src/createStore.js";
import type { GraphStore } from "../src/graphCore.js";
import { closeStore, isolateDatabase } from "./helpers.js";

/**
 * Teams end to end: a real server, real API keys, one persona per row of the
 * access table. Joining a team is done the way a dashboard session does it
 * (UserStore.joinOrg); everything after that goes over HTTP or MCP.
 */
process.env.TROVE_EMBEDDING_PROVIDER = "fake";
await isolateDatabase("team_personas");
const databaseUrl = process.env.DATABASE_URL;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

describe("team personas over HTTP and MCP", { skip: databaseUrl ? false : "requires a Postgres DATABASE_URL" }, () => {
  const stamp = Date.now();
  const MARK = `PERSONA${stamp}`;
  let server: ChildProcess;
  let baseUrl = "";
  let users: UserStore;
  let pool: pg.Pool;
  let store: GraphStore;
  const keys: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const acme = { clerkOrgId: `org_acme_${stamp}`, name: "acme" };
  const globex = { clerkOrgId: `org_globex_${stamp}`, name: "globex" };

  async function call(persona: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${keys[persona]}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  }
  const recallIds = async (persona: string, query: string) =>
    ((await call(persona, "/v1/recall", { query, tokenBudget: 4000 })).json.atoms as Array<{ node: { id: string } }>).map((a) => a.node.id);

  before(async () => {
    users = new UserStore({ connectionString: databaseUrl! });
    pool = new pg.Pool({ connectionString: databaseUrl! });
    store = createGraphStore().store;

    // sam: solo, no team. alice (admin) + bob: Acme. carol: Globex. dave: Acme, then removed.
    // eve: in both teams, Globex active.
    for (const persona of ["sam", "alice", "bob", "carol", "dave", "eve"]) {
      const user = await users.ensureUser({ clerkUserId: `persona-${persona}-${stamp}` });
      await users.setUserStatus(user.clerkUserId, "active", user.id);
      ids[persona] = user.id;
      keys[persona] = (await users.createApiKey(user.id, { name: persona, scopes: ["graph:read", "graph:write"] })).secret;
    }
    await users.joinOrg(ids.alice!, { ...acme, role: "admin" });
    await users.joinOrg(ids.bob!, { ...acme, role: "member" });
    await users.joinOrg(ids.dave!, { ...acme, role: "member" });
    await users.joinOrg(ids.carol!, { ...globex, role: "member" });
    await users.joinOrg(ids.eve!, { ...acme, role: "member" });
    await users.joinOrg(ids.eve!, { ...globex, role: "member" });

    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: databaseUrl,
        TROVE_SERVICE_TOKENS: `svc-${stamp}|svc|graph:read`,
        TROVE_AUTORUN_JOBS: "0",
        TROVE_EMBEDDING_PROVIDER: "fake",
        CLERK_SECRET_KEY: "",
        CLERK_PUBLISHABLE_KEY: "",
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server did not start")), 30_000);
      server.stdout!.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("Trove listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      server.once("exit", (code) => reject(new Error(`server exited ${code}`)));
    });
  });

  after(async () => {
    server?.kill("SIGTERM");
    if (pool) await pool.end();
    if (users) await users.close();
    if (store) await closeStore(store);
  });

  let teamNoteId = "";
  let teamSpaceId = "";

  it("alice's default write goes to Acme's team space", async () => {
    const result = await call("alice", "/v1/remember", { title: `Webhook retries ${MARK}`, summary: `Stripe retries reuse the event id ${MARK}.` });
    assert.equal(result.status, 201, JSON.stringify(result.json));
    teamNoteId = result.json.node.id;
    const owner = await pool.query("select n.owner_id, s.kind from node n join space s on s.id = n.owner_id where n.id = $1", [teamNoteId]);
    assert.equal(owner.rows[0].kind, "shared");
    teamSpaceId = String(owner.rows[0].owner_id);
  });

  it("bob (same team) recalls, reads and greps it; outsiders get nothing", async () => {
    assert.ok((await recallIds("bob", `stripe retries event id ${MARK}`)).includes(teamNoteId), "bob missed the team note");
    assert.equal((await call("bob", "/v1/read", { nodeId: teamNoteId })).status, 200);
    for (const outsider of ["sam", "carol", "eve"]) {
      assert.ok(!(await recallIds(outsider, `stripe retries event id ${MARK}`)).includes(teamNoteId), `${outsider} recalled Acme's note`);
      assert.equal((await call(outsider, "/v1/read", { nodeId: teamNoteId })).status, 404, `${outsider} read Acme's note by id`);
      const grep = await call(outsider, "/v1/grep", { pattern: MARK, scope: "all", limit: 50 });
      assert.equal(grep.json.matches.length, 0, `${outsider} grepped Acme's note`);
    }
  });

  it("semantic search finds the team note for a teammate and never for another team", async () => {
    for (let i = 0; i < 50 && (await store.runJob({})); i++);
    const vectors = await pool.query("select count(*)::int as n from embedding where tenant_id = $1", [teamSpaceId]);
    assert.ok(vectors.rows[0].n > 0, "the team note was never embedded under the team space");
    // Same text as the summary, so the fake embedder puts it at distance 0: a leak would rank first.
    const exact = `Stripe retries reuse the event id ${MARK}.`;
    assert.ok((await recallIds("bob", exact)).includes(teamNoteId));
    assert.ok(!(await recallIds("carol", exact)).includes(teamNoteId), "carol got Acme's note through the vector index");
  });

  it("bob revising the same title updates the one team note", async () => {
    const result = await call("bob", "/v1/remember", { title: `Webhook retries ${MARK}`, summary: `Retries reuse the event id; dedupe on it ${MARK}.` });
    assert.equal(result.json.node.id, teamNoteId);
    const read = await call("alice", "/v1/read", { nodeId: teamNoteId });
    assert.match(read.json.node.summary, /dedupe on it/);
  });

  it("a private note stays with its writer", async () => {
    const result = await call("alice", "/v1/remember", { title: `My shell aliases ${MARK}`, summary: "gs is git status.", space: "mine" });
    assert.equal(result.status, 201);
    assert.ok((await recallIds("alice", `shell aliases ${MARK}`)).includes(result.json.node.id));
    assert.ok(!(await recallIds("bob", `shell aliases ${MARK}`)).includes(result.json.node.id), "bob saw alice's private note");
  });

  it("an ingest goes to the team and its source text is searchable by teammates only", async () => {
    const result = await call("alice", "/v1/ingest", { kind: "paste", title: `Incident notes ${MARK}`, contentText: `The queue stalled at 09:14; root cause was a lock held across an HTTP call ${MARK}.` });
    assert.equal(result.status, 201, JSON.stringify(result.json));
    const bob = await call("bob", "/v1/grep", { pattern: `lock held across an HTTP call ${MARK}`, scope: "sources", limit: 10 });
    assert.ok(bob.json.matches.length > 0, "bob could not find the team source");
    const carol = await call("carol", "/v1/grep", { pattern: `lock held across an HTTP call ${MARK}`, scope: "sources", limit: 10 });
    assert.equal(carol.json.matches.length, 0);
  });

  it("a solo user writes privately by default and is told why a team write fails", async () => {
    const mine = await call("sam", "/v1/remember", { title: `Solo note ${MARK}`, summary: "Personal tenant only." });
    assert.equal(mine.status, 201);
    const owner = await pool.query("select owner_id from node where id = $1", [mine.json.node.id]);
    assert.equal(String(owner.rows[0].owner_id), ids.sam, "a solo user's note left their personal space");
    const team = await call("sam", "/v1/remember", { title: `Team note ${MARK}`, summary: "x", space: "team" });
    assert.equal(team.status, 400);
    assert.equal(team.json.error, "no_team");
  });

  it("a credential is refused for the team and nothing is stored", async () => {
    const result = await call("bob", "/v1/remember", { title: `Prod DB ${MARK}`, summary: "postgresql://ro.user:Zx81QWERtyuiop12AsdfGhjk@db.example.com:6432/app" });
    assert.equal(result.status, 400);
    assert.equal(result.json.error, "credential_in_team_write");
    const stored = await pool.query("select count(*)::int as n from node where title = $1", [`Prod DB ${MARK}`]);
    assert.equal(stored.rows[0].n, 0);
  });

  it("a removed member loses the team and their writes go back to personal", async () => {
    assert.ok((await recallIds("dave", `stripe retries event id ${MARK}`)).includes(teamNoteId), "dave should see it while a member");
    await users.removeMembership(ids.dave!, acme.clerkOrgId);
    assert.ok(!(await recallIds("dave", `stripe retries event id ${MARK}`)).includes(teamNoteId), "a removed member still sees the team");
    const write = await call("dave", "/v1/remember", { title: `After leaving ${MARK}`, summary: "Written after removal." });
    const owner = await pool.query("select owner_id from node where id = $1", [write.json.node.id]);
    assert.equal(String(owner.rows[0].owner_id), ids.dave);
  });

  it("a member of two teams sees the one their dashboard has active", async () => {
    assert.ok(!(await recallIds("eve", `stripe retries event id ${MARK}`)).includes(teamNoteId));
    await users.joinOrg(ids.eve!, { ...acme, role: "member" });
    assert.ok((await recallIds("eve", `stripe retries event id ${MARK}`)).includes(teamNoteId), "switching eve to Acme did not show Acme's notes");
  });

  it("the MCP connector path behaves the same as HTTP", async () => {
    const client = new Client({ name: "persona-mcp", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${keys.bob}` } },
    });
    await client.connect(transport);
    try {
      const result = await client.request({ method: "tools/call", params: { name: "remember", arguments: { title: `Via MCP ${MARK}`, summary: `Written through the connector ${MARK}.` } } });
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      const nodeId = JSON.parse(text).node.id as string;
      const owner = await pool.query("select owner_id from node where id = $1", [nodeId]);
      assert.equal(String(owner.rows[0].owner_id), teamSpaceId, "an MCP write did not land in the team");
      const carol = await call("carol", "/v1/read", { nodeId });
      assert.equal(carol.status, 404);
    } finally {
      await transport.close();
    }
  });

  let sharedSlug = "";

  it("a member shares an old private note, and only then do teammates see it, vectors included", async () => {
    const note = await call("bob", "/v1/remember", { title: `Release checklist ${MARK}`, summary: `Tag, wait for CI, then promote ${MARK}.`, space: "mine" });
    sharedSlug = note.json.node.slug;
    for (let i = 0; i < 50 && (await store.runJob({})); i++);
    assert.ok(!(await recallIds("alice", `release checklist ${MARK}`)).includes(note.json.node.id), "alice saw it before it was shared");
    const listed = await call("bob", "/v1/shareable", { limit: 200 });
    assert.ok(listed.json.notes.some((n: { slug: string }) => n.slug === sharedSlug), "shareable did not list bob's private note");
    const shared = await call("bob", "/v1/share", { slugs: [sharedSlug] });
    assert.equal(shared.status, 200, JSON.stringify(shared.json));
    assert.deepEqual(shared.json.moved.map((m: { slug: string }) => m.slug), [sharedSlug]);
    assert.ok((await recallIds("alice", `Tag, wait for CI, then promote ${MARK}.`)).includes(note.json.node.id), "alice cannot recall the shared note");
    assert.ok(!(await recallIds("carol", `Tag, wait for CI, then promote ${MARK}.`)).includes(note.json.node.id), "another team saw the shared note");
    const vectors = await pool.query(
      `select count(*)::int n, count(*) filter (where tenant_id = $2)::int team from embedding
       where (owner_table = 'node' and owner_id = $1) or (owner_table = 'node_revision' and owner_id in (select id from node_revision where node_id = $1))`,
      [note.json.node.id, teamSpaceId],
    );
    assert.ok(vectors.rows[0].n > 0 && vectors.rows[0].n === vectors.rows[0].team, "the note's vectors did not move to the team");
  });

  it("a note that looks like a credential is not shared", async () => {
    const note = await call("bob", "/v1/remember", { title: `Staging DB ${MARK}`, summary: "postgresql://ro.user:Zx81QWERtyuiop12AsdfGhjk@db.example.com:6432/app", space: "mine" });
    const listed = await call("bob", "/v1/shareable", { limit: 200 });
    assert.equal(listed.json.notes.find((n: { slug: string }) => n.slug === note.json.node.slug)?.looksLikeCredential, true);
    const shared = await call("bob", "/v1/share", { slugs: [note.json.node.slug] });
    assert.equal(shared.json.moved.length, 0);
    assert.match(shared.json.skipped[0].reason, /credential/);
    const owner = await pool.query("select owner_id from node where id = $1", [note.json.node.id]);
    assert.equal(String(owner.rows[0].owner_id), (await users.spacesFor(ids.bob!)).ownerId);
  });

  it("only the sharer or an admin takes a note back; written-to-team notes have nowhere to go", async () => {
    const byEve = await call("eve", "/v1/unshare", { slugs: [sharedSlug] });
    assert.equal(byEve.json.moved.length, 0);
    assert.match(byEve.json.skipped[0].reason, /only the person who shared it/);
    const teamNative = await call("alice", "/v1/unshare", { nodeIds: [teamNoteId] });
    assert.match(teamNative.json.skipped[0].reason, /written straight to the team/);
    const byBob = await call("bob", "/v1/unshare", { slugs: [sharedSlug] });
    assert.equal(byBob.json.moved.length, 1, JSON.stringify(byBob.json));
    assert.ok(!(await recallIds("alice", `Tag, wait for CI, then promote ${MARK}.`)).includes(byBob.json.moved[0].id), "alice still sees the unshared note");
    const owner = await pool.query("select owner_id, metadata from node where id = $1", [byBob.json.moved[0].id]);
    assert.equal(String(owner.rows[0].owner_id), (await users.spacesFor(ids.bob!)).ownerId);
    assert.equal(owner.rows[0].metadata.sharedFrom, undefined);
  });

  it("sharing without a team says why", async () => {
    const result = await call("sam", "/v1/share", { slugs: ["anything"] });
    assert.equal(result.status, 400);
    assert.equal(result.json.error, "no_team");
  });

  it("an MCP client gets the share tools", async () => {
    const client = new Client({ name: "persona-mcp-share", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${keys.bob}` } },
    });
    await client.connect(transport);
    try {
      const tools = (await client.request({ method: "tools/list", params: {} })).tools as Array<{ name: string }>;
      for (const name of ["shareable", "share", "unshare"]) assert.ok(tools.some((tool) => tool.name === name), `missing ${name}`);
      const result = await client.request({ method: "tools/call", params: { name: "shareable", arguments: { limit: 5 } } });
      assert.ok(JSON.parse((result.content as Array<{ text: string }>)[0]!.text).total > 0);
    } finally {
      await transport.close();
    }
  });
});
