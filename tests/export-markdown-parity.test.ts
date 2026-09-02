import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { suiteStore, closeStore } from "./helpers.js";

// exportMarkdown used to call project() once per node. The Postgres driver now
// assembles the whole vault from three bulk reads instead, because the N+1 made
// refresh_obsidian_projection slow enough that deploys kept killing it
// mid-flight. That rewrite is only safe if it still renders exactly what
// project() renders, so assert the two against each other rather than trusting
// the reimplementation -- and run it on whichever driver the suite is bound to.

describe("exportMarkdown matches per-node projection", () => {
  const { store, context, stamp } = suiteStore("export-markdown-parity");

  after(async () => {
    await closeStore(store);
  });

  it("renders every node identically to project()", async () => {
    const hub = await store.capture({
      title: `Export parity hub ${stamp}`,
      type: "project",
      summary: "Hub node linking out to several neighbours.",
      content: "The hub should list every neighbour under Related.",
      evidence: [],
      links: [],
    }, context);

    const spokes = [];
    for (const index of [1, 2, 3]) {
      spokes.push(await store.capture({
        title: `Export parity spoke ${index} ${stamp}`,
        type: "claim",
        summary: `Spoke ${index} hangs off the hub.`,
        content: `Spoke ${index} content.`,
        evidence: [],
        links: [],
      }, context));
    }
    for (const spoke of spokes) {
      const edge = await store.link({
        fromNodeId: hub.id,
        toNodeId: spoke.id,
        predicate: "supports",
        weight: 1,
      }, context);
      assert.ok(edge, "expected the parity edge to be created");
    }
    // An isolated node exercises the no-neighbour path (empty Related list).
    const orphan = await store.capture({
      title: `Export parity orphan ${stamp}`,
      type: "entity",
      summary: "No edges at all.",
      content: "This node has no neighbours.",
      evidence: [],
      links: [],
    }, context);

    const files = await store.exportMarkdown(context);
    assert.ok(Object.keys(files).length > 0, "expected the export to produce files");

    for (const node of [hub, ...spokes, orphan]) {
      const projected = await store.project({ nodeId: node.id, format: "markdown", depth: 1 }, context);
      assert.ok(projected && projected.format === "markdown", `expected a markdown projection for ${node.slug}`);
      assert.equal(
        files[`${node.slug}.md`],
        projected.content,
        `bulk export diverged from project() for ${node.slug}`,
      );
    }
  });
});
