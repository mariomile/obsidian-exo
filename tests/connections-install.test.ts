import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { connectMcp, disconnectMcp, importSkill, removeSkill } from "../src/core/connections-install";
import { parseMcpJson } from "../src/core/mcp-config";

describe("connectMcp", () => {
  it("adds a server to an empty config, enabled", () => {
    const out = connectMcp('{"mcpServers":{}}', "posthog", { command: "npx", args: ["-y", "@posthog/mcp"] });
    const { servers } = parseMcpJson(out);
    expect(servers).toEqual([{ name: "posthog", config: { command: "npx", args: ["-y", "@posthog/mcp"] }, enabled: true }]);
  });
  it("throws on unparseable current text rather than clobbering", () => {
    expect(() => connectMcp("{not json", "x", {})).toThrow();
  });
});

describe("disconnectMcp", () => {
  it("removes a named server", () => {
    const start = connectMcp('{"mcpServers":{}}', "posthog", { command: "npx" });
    const out = disconnectMcp(start, "posthog");
    expect(parseMcpJson(out).servers).toEqual([]);
  });
});

let base: string;
beforeEach(async () => { base = await mkdtemp(join(tmpdir(), "conn-")); });
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

describe("importSkill", () => {
  it("copies a skill folder without touching the source", async () => {
    const src = join(base, "src-skill");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), "# hi");
    const dest = join(base, "vault", "skills", "src-skill");
    const res = await importSkill(src, dest);
    expect(res).toBe("copied");
    expect(await readFile(join(dest, "SKILL.md"), "utf8")).toBe("# hi");
    expect((await readdir(src)).length).toBe(1); // source untouched
  });
  it("refuses to overwrite an existing dest unless told to", async () => {
    const src = join(base, "s"); await mkdir(src, { recursive: true }); await writeFile(join(src, "SKILL.md"), "new");
    const dest = join(base, "d"); await mkdir(dest, { recursive: true }); await writeFile(join(dest, "SKILL.md"), "old");
    expect(await importSkill(src, dest)).toBe("exists");
    expect(await readFile(join(dest, "SKILL.md"), "utf8")).toBe("old"); // unchanged
    expect(await importSkill(src, dest, { overwrite: true })).toBe("copied");
    expect(await readFile(join(dest, "SKILL.md"), "utf8")).toBe("new");
  });
});

describe("removeSkill", () => {
  it("removes only the dest copy", async () => {
    const dest = join(base, "d"); await mkdir(dest, { recursive: true }); await writeFile(join(dest, "x"), "1");
    await removeSkill(dest);
    await expect(readdir(dest)).rejects.toBeTruthy();
  });
});
