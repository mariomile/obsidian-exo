import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { gatherOtherProjectSkills } from "../src/ui/capabilities";

/**
 * Regression: ~/.claude/skills is mostly symlinks (→ ~/.agents/skills). A
 * Dirent for a symlink returns isDirectory()===false, so the old scanNames
 * dropped every symlinked skill — undercounting the "already have" set and
 * surfacing hundreds of false "importable" rows in the Connections pane.
 * scanNames must stat() symlinks and treat symlink-to-dir as a skill folder.
 */
describe("gatherOtherProjectSkills follows symlinked skill dirs", () => {
  let base: string;
  beforeEach(async () => { base = await mkdtemp(join(tmpdir(), "symscan-")); });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  it("counts both a real skill dir and a symlink-to-dir", async () => {
    // a real skill folder to be the symlink target, outside the project
    const target = join(base, "target", "linked-skill");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "# linked");

    // the project's .claude/skills with one real skill + one symlinked skill
    const skillsDir = join(base, "proj", ".claude", "skills");
    await mkdir(join(skillsDir, "real-skill"), { recursive: true });
    await writeFile(join(skillsDir, "real-skill", "SKILL.md"), "# real");
    await symlink(target, join(skillsDir, "linked-skill"));

    const dirs = await gatherOtherProjectSkills([base]);
    const proj = dirs.find((d) => d.origin === "proj")!;
    const names = proj.skills.map((s) => s.name).sort();
    expect(names).toEqual(["linked-skill", "real-skill"]);
  });
});
