import { describe, it, expect } from "vitest";
import { readBootContext } from "../src/obsidian/memory";
import { IDENTITY_ARBITRATION_LINE } from "../src/core/agent-self";

/**
 * Boot seam (design §9): with `agentFolderEnabled` OFF, `readBootContext` output
 * is byte-identical to before the identity layer existed. With it ON but no
 * `_system/agent/` folder, the output is identical too (all blocks missing ⇒
 * empty identity section). Only a populated folder changes the preamble.
 *
 * These exercise the impure boot fn against a hand-rolled fake vault that
 * implements exactly the surface `readBootContext` touches — no Obsidian runtime.
 */

class FakeTFile {
  constructor(
    public path: string,
    public basename: string,
    public content: string,
    public stat: { mtime: number }
  ) {}
}

// The real code type-checks with `instanceof TFile` against the mocked obsidian
// module; align our fake's prototype so the check passes under the vitest alias.
import { TFile } from "obsidian";
Object.setPrototypeOf(FakeTFile.prototype, TFile.prototype);

interface FileSpec {
  content: string;
  mtime?: number;
}

function makeApp(files: Record<string, FileSpec>) {
  const tfiles = new Map<string, FakeTFile>();
  for (const [path, spec] of Object.entries(files)) {
    const basename = (path.split("/").pop() ?? path).replace(/\.md$/, "");
    tfiles.set(path, new FakeTFile(path, basename, spec.content, { mtime: spec.mtime ?? 0 }));
  }
  return {
    vault: {
      getAbstractFileByPath: (p: string) => tfiles.get(p) ?? null,
      cachedRead: async (f: FakeTFile) => f.content,
      getMarkdownFiles: () => [...tfiles.values()],
    },
  } as never; // structurally matches the App surface readBootContext uses
}

const BASE_FILES: Record<string, FileSpec> = {
  "_system/vault-context.md": { content: "Vault is marioverse. Mario is a PM." },
  "_system/memory/preferences/preferences.md": { content: "Prefers Italian for strategy." },
  "_system/memory/rules/rule-verify-mario-bio.md": { content: "verify bio" },
  "_system/memory/session-log.md": { content: "## session one\n## session two" },
};

describe("readBootContext — flag OFF byte-identity", () => {
  it("OFF (no opts) equals OFF (explicit false)", async () => {
    const app = makeApp(BASE_FILES);
    const a = await readBootContext(app);
    const b = await readBootContext(app, { agentFolderEnabled: false });
    expect(a).toBe(b);
  });

  it("a populated agent folder is IGNORED when the flag is OFF", async () => {
    const withFolder = makeApp({
      ...BASE_FILES,
      "_system/agent/persona.md": { content: "Be terse." },
      "_system/agent/human.md": { content: "Mario, PM." },
      "_system/agent/now.md": { content: "Shipping the identity layer." },
    });
    const withoutFolder = makeApp(BASE_FILES);
    const off = await readBootContext(withFolder, { agentFolderEnabled: false });
    const bare = await readBootContext(withoutFolder, { agentFolderEnabled: false });
    // The folder must not leak into the OFF output.
    expect(off).toBe(bare);
    expect(off).not.toContain("Be terse.");
    expect(off).not.toContain(IDENTITY_ARBITRATION_LINE);
  });
});

describe("readBootContext — flag ON with no folder", () => {
  it("is byte-identical to OFF when the agent folder is absent", async () => {
    const app = makeApp(BASE_FILES);
    const off = await readBootContext(app, { agentFolderEnabled: false });
    const onNoFolder = await readBootContext(app, { agentFolderEnabled: true });
    expect(onNoFolder).toBe(off);
  });
});

describe("readBootContext — flag ON with a populated folder", () => {
  it("prepends the identity section BEFORE the existing sections", async () => {
    const app = makeApp({
      ...BASE_FILES,
      "_system/agent/persona.md": { content: "Be terse and direct." },
      "_system/agent/human.md": { content: "Mario — 0-to-1 PM." },
      "_system/agent/now.md": { content: "Shipping the identity layer." },
    });
    const out = await readBootContext(app, { agentFolderEnabled: true });
    expect(out).toContain(IDENTITY_ARBITRATION_LINE);
    expect(out).toContain("Be terse and direct.");
    // Identity must come before the Vault-context section.
    expect(out.indexOf(IDENTITY_ARBITRATION_LINE)).toBeLessThan(out.indexOf("### Vault context"));
  });

  it("halves the session-log slice when now.md carries signal", async () => {
    const longLog = "L".repeat(1000);
    const withNow = makeApp({
      ...BASE_FILES,
      "_system/memory/session-log.md": { content: longLog },
      "_system/agent/now.md": { content: "hot project" },
    });
    const noNow = makeApp({
      ...BASE_FILES,
      "_system/memory/session-log.md": { content: longLog },
    });
    const on = await readBootContext(withNow, { agentFolderEnabled: true });
    const off = await readBootContext(noNow, { agentFolderEnabled: true });
    // With now.md present, the log is capped at 600 (truncated marker appears);
    // without it, at 1200 (the whole 1000-char log fits, no marker).
    const onLogRun = on.match(/L+/)?.[0].length ?? 0;
    const offLogRun = off.match(/L+/)?.[0].length ?? 0;
    expect(onLogRun).toBeLessThanOrEqual(600);
    expect(offLogRun).toBe(1000);
  });

  it("an empty now.md does NOT halve the session-log slice", async () => {
    const longLog = "L".repeat(1000);
    const app = makeApp({
      ...BASE_FILES,
      "_system/memory/session-log.md": { content: longLog },
      "_system/agent/now.md": { content: "   " }, // blank → no signal
    });
    const out = await readBootContext(app, { agentFolderEnabled: true });
    expect(out.match(/L+/)?.[0].length ?? 0).toBe(1000);
  });
});
