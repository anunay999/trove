import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSkill, listSkills, llmsTxt, resetSkillsCache, skillsIndexMarkdown } from "../src/skills.js";

describe("skills: the repo's own skills directory", () => {
  before(() => {
    delete process.env.TROVE_SKILLS_DIR;
    resetSkillsCache();
  });

  it("ships trove-curate with frontmatter parsed off the body", () => {
    const skill = getSkill("trove-curate");
    assert.ok(skill, "trove-curate missing from skills/");
    assert.equal(skill.name, "trove-curate");
    assert.match(skill.description, /clean up/i);
    assert.ok(!skill.body.startsWith("---"), "body should not include frontmatter");
    assert.ok(skill.raw.startsWith("---"), "raw should keep frontmatter for npx skills add");
    assert.match(skill.body, /Reversible only/);
  });

  it("lists every skill and renders the index and llms.txt with absolute links", () => {
    const names = listSkills().map((skill) => skill.name);
    for (const expected of ["trove", "trove-recall", "trove-remember", "trove-ingest", "trove-lint", "trove-curate"]) {
      assert.ok(names.includes(expected), `${expected} missing from listSkills()`);
    }
    const index = skillsIndexMarkdown("https://mytrove.in/");
    assert.match(index, /\(https:\/\/mytrove\.in\/skills\/trove-curate\.md\)/);
    assert.match(index, /npx skills add anunay999\/trove -g/);
    const llms = llmsTxt("https://mytrove.in");
    assert.match(llms, /^# Trove/);
    assert.match(llms, /https:\/\/mytrove\.in\/mcp/);
  });

  it("rejects names that could walk the filesystem", () => {
    assert.equal(getSkill("../package"), null);
    assert.equal(getSkill("trove-curate/SKILL"), null);
    assert.equal(getSkill(""), null);
  });
});

describe("skills: an arbitrary directory", () => {
  let directory: string;

  before(() => {
    directory = mkdtempSync(join(tmpdir(), "trove-skills-"));
    mkdirSync(join(directory, "alpha"));
    writeFileSync(join(directory, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: First one.\n---\n\n# alpha\n\nBody.\n");
    mkdirSync(join(directory, "no-frontmatter"));
    writeFileSync(join(directory, "no-frontmatter", "SKILL.md"), "# bare\n\nJust a body.\n");
    mkdirSync(join(directory, "Not_Valid"));
    writeFileSync(join(directory, "Not_Valid", "SKILL.md"), "ignored\n");
    process.env.TROVE_SKILLS_DIR = directory;
    resetSkillsCache();
  });

  after(() => {
    delete process.env.TROVE_SKILLS_DIR;
    resetSkillsCache();
    rmSync(directory, { recursive: true, force: true });
  });

  it("parses frontmatter, tolerates its absence, and skips invalid names", () => {
    const names = listSkills().map((skill) => skill.name);
    assert.deepEqual(names, ["alpha", "no-frontmatter"]);
    assert.equal(getSkill("alpha")?.description, "First one.");
    assert.equal(getSkill("alpha")?.body, "# alpha\n\nBody.");
    assert.equal(getSkill("no-frontmatter")?.body.trim(), "# bare\n\nJust a body.");
    assert.equal(getSkill("Not_Valid"), null);
  });
});
