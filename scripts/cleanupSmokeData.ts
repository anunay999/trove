// Removes smoke-test debris written by the npm test suites when they run against
// a real database: stamped "<name> smoke <ms>" nodes, their revisions, edges,
// annotations, embeddings, smoke sources with their text units, and smoke views.
// Dry-run by default; pass --apply to delete. The graph_event audit log is kept.
import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}
const apply = process.argv.includes("--apply");

const NODE_PATTERN = String.raw` 17\d{11}$`;
const NODE_WORDS = "(smoke|bitemporal|recall|expansion|sources)";

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query("begin");

  const nodes = await client.query(
    `select id, title from node
     where title ~ $1 and title ~* $2`,
    [NODE_PATTERN, NODE_WORDS],
  );
  const nodeIds = nodes.rows.map((row) => String(row.id));

  const sources = await client.query(
    `select id, title from source
     where title ~ $1
        or title ~ ' 17\\d{11} · '
        or metadata->>'relPath' ~ '^(log|index)-17\\d{11}'
        or title = 'Hosted graph smoke evidence'`,
    [NODE_PATTERN],
  );
  const sourceIds = sources.rows.map((row) => String(row.id));

  const views = await client.query(
    `select id, slug from graph_view where slug like 'view-smoke-%'`,
  );
  const viewIds = views.rows.map((row) => String(row.id));

  const units = await client.query(
    `select id from text_unit where source_id = any($1::uuid[])`,
    [sourceIds],
  );
  const unitIds = units.rows.map((row) => String(row.id));

  const revisions = await client.query(
    `select id from node_revision where node_id = any($1::uuid[])`,
    [nodeIds],
  );
  const revisionIds = revisions.rows.map((row) => String(row.id));

  const plan = {
    nodes: nodeIds.length,
    sources: sourceIds.length,
    textUnits: unitIds.length,
    revisions: revisionIds.length,
    views: viewIds.length,
  };

  if (!apply) {
    await client.query("rollback");
    console.log(JSON.stringify({ dryRun: true, plan, nodeTitles: nodes.rows.map((r) => r.title) }, null, 2));
    process.exit(0);
  }

  await client.query(
    `delete from annotation
     where node_id = any($1::uuid[])
        or source_id = any($2::uuid[])
        or text_unit_id = any($3::uuid[])`,
    [nodeIds, sourceIds, unitIds],
  );
  await client.query(
    `delete from edge where from_node_id = any($1::uuid[]) or to_node_id = any($1::uuid[])`,
    [nodeIds],
  );
  await client.query(
    `delete from embedding where owner_id = any($1::uuid[])`,
    [[...nodeIds, ...sourceIds, ...unitIds, ...revisionIds]],
  );
  await client.query(`delete from graph_view where id = any($1::uuid[])`, [viewIds]);
  await client.query(`update node set current_revision_id = null where id = any($1::uuid[])`, [nodeIds]);
  await client.query(`delete from node_revision where id = any($1::uuid[])`, [revisionIds]);
  await client.query(`delete from node where id = any($1::uuid[])`, [nodeIds]);
  await client.query(`delete from text_unit where source_id = any($1::uuid[])`, [sourceIds]);
  await client.query(`delete from source where id = any($1::uuid[])`, [sourceIds]);
  await client.query(
    `insert into graph_event (action, entity_table, entity_id, interface_id, after)
     values ('cleanup_smoke_data', 'node', gen_random_uuid(), 'cleanup-script', $1::jsonb)`,
    [JSON.stringify(plan)],
  );

  await client.query("commit");
  console.log(JSON.stringify({ applied: true, plan }, null, 2));
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  await client.end();
}
