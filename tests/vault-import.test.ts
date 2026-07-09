import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isStubContent,
  pageSummary,
  parseFrontmatter,
  selectEvidenceUnits,
  isUsefulEvidenceUnit,
} from "../src/vaultImport.js";
import type { TextUnit } from "../src/contracts.js";

describe("vaultImport helpers", () => {
  it("detects historical import stubs", () => {
    assert.equal(
      isStubContent("Imported from infrastructure/vm-rocket.md. The source document remains the evidence layer."),
      true,
    );
    assert.equal(isStubContent(""), true);
    assert.equal(isStubContent(null), true);
    assert.equal(
      isStubContent("Annual plans are refundable within 14 days. Customer success owns churn emails."),
      false,
    );
  });

  it("parses frontmatter and prefers TL;DR for summary", () => {
    const md = `---
title: Example
type: infra
---

# Example

## TL;DR

This is the short version of the page that should win.

## Details

Long body that is not the summary.
`;
    const parsed = parseFrontmatter(md);
    assert.equal(parsed.frontmatter.title, "Example");
    assert.match(pageSummary(parsed.body, "Example"), /short version/);
  });

  it("skips frontmatter-only evidence units and keeps real prose", () => {
    const units: TextUnit[] = [
      unit("---", 0),
      unit("title: example", 1),
      unit("# Example", 2),
      unit("Annual plans are refundable within 14 days of purchase.", 3),
      unit("## After the window", 4),
      unit("Customer success owns churn emails; never promise a refund without checking the clock.", 5),
    ];
    assert.equal(isUsefulEvidenceUnit(units[0]!), false);
    assert.equal(isUsefulEvidenceUnit(units[3]!), true);
    const selected = selectEvidenceUnits(units, 4);
    assert.ok(selected.some((u) => u.text.includes("14 days")));
    assert.ok(selected.some((u) => u.text.startsWith("## After the window")));
    assert.ok(!selected.some((u) => u.text === "---"));
  });
});

function unit(text: string, ordinal: number): TextUnit {
  return {
    id: `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`,
    sourceId: "00000000-0000-4000-8000-000000000099",
    ordinal,
    sectionPath: [],
    charStart: 0,
    charEnd: text.length,
    text,
    contentSha256: `sha-${ordinal}`,
  };
}
