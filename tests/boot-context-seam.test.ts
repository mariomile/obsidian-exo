import { describe, it, expect } from "vitest";
import { readBootContext } from "../src/obsidian/memory";
import { IDENTITY_ARBITRATION_LINE } from "../src/core/agent-self";
import { exoPaths } from "../src/core/paths";
import { formatLoop, type LoopEntry } from "../src/core/open-loops";

// The fake vault is keyed on `_system/…`, so drive the boot fn with the legacy root.
const P = exoPaths("_system");

/**
 * Boot seam (design §9): with `identity` OFF, `readBootContext` output
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
};

describe("readBootContext — flag OFF byte-identity", () => {
  it("OFF (no opts) equals OFF (explicit false)", async () => {
    const app = makeApp(BASE_FILES);
    const a = await readBootContext(app, P);
    const b = await readBootContext(app, P, { identity: false });
    expect(a).toBe(b);
  });

  it("a populated agent folder is IGNORED when the flag is OFF", async () => {
    const withFolder = makeApp({
      ...BASE_FILES,
      "_system/agent/SOUL.md": { content: "Be terse." },
      "_system/agent/USER.md": { content: "Mario, PM." },
      "_system/agent/NOW.md": { content: "Shipping the identity layer." },
    });
    const withoutFolder = makeApp(BASE_FILES);
    const off = await readBootContext(withFolder, P, { identity: false });
    const bare = await readBootContext(withoutFolder, P, { identity: false });
    // The folder must not leak into the OFF output.
    expect(off).toBe(bare);
    expect(off).not.toContain("Be terse.");
    expect(off).not.toContain(IDENTITY_ARBITRATION_LINE);
  });
});

describe("readBootContext — flag ON with no folder", () => {
  it("is byte-identical to OFF when the agent folder is absent", async () => {
    const app = makeApp(BASE_FILES);
    const off = await readBootContext(app, P, { identity: false });
    const onNoFolder = await readBootContext(app, P, { identity: true });
    expect(onNoFolder).toBe(off);
  });
});

describe("readBootContext — flag ON with a populated folder", () => {
  it("prepends the identity section BEFORE the existing sections", async () => {
    const app = makeApp({
      ...BASE_FILES,
      "_system/agent/SOUL.md": { content: "Be terse and direct." },
      "_system/agent/USER.md": { content: "Mario — 0-to-1 PM." },
      "_system/agent/NOW.md": { content: "Shipping the identity layer." },
    });
    const out = await readBootContext(app, P, { identity: true });
    expect(out).toContain(IDENTITY_ARBITRATION_LINE);
    expect(out).toContain("Be terse and direct.");
    // Identity must come before the Vault-context section.
    expect(out.indexOf(IDENTITY_ARBITRATION_LINE)).toBeLessThan(out.indexOf("### Vault context"));
  });

  it("never reads a session log (removed with the union store)", async () => {
    const app = makeApp({ ...BASE_FILES, "_system/memory/session-log.md": { content: "## old session" } });
    const out = await readBootContext(app, P, { identity: true });
    expect(out).not.toContain("old session");
    expect(out).not.toContain("Recent sessions");
  });
});

describe("readBootContext — open loops past a raw-char cutoff", () => {
  it("a loop placed after 20k chars of ledger content still reaches the boot section", async () => {
    const lateLoop: LoopEntry = {
      id: "loop-1720000000000",
      title: "Late loop past the old raw cap",
      note: "opened way past where the old MAX_LOOPS_RAW cap used to cut the raw read off",
      openedAt: 1720000000000,
      status: "open",
    };
    // Padding as junk lines between blocks (tolerated by parseLoopsFile) so the
    // loop block itself starts well past the old 20000-char raw cutoff.
    const padding = "junk line, not a loop block\n".repeat(1000); // ~29000 chars
    expect(padding.length).toBeGreaterThan(20000);
    const app = makeApp({
      ...BASE_FILES,
      "_system/memory/open-loops.md": { content: padding + formatLoop(lateLoop) },
    });
    const out = await readBootContext(app, P);
    expect(out).toContain("Late loop past the old raw cap");
  });
});

describe("readBootContext — rules section prefers the index", () => {
  it("uses _index.md content when it exists, instead of the bare file-name list", async () => {
    const app = makeApp({
      ...BASE_FILES,
      "_system/memory/rules/_index.md": { content: "| Task | Rule |\n|---|---|\n| Research | rule-research-protocol |" },
    });
    const out = await readBootContext(app, P);
    expect(out).toContain("### Active rules");
    expect(out).toContain("rule-research-protocol |");
    // The bare file-name entry from BASE_FILES must not appear as a `- name` list item.
    expect(out).not.toContain("- rule-verify-mario-bio");
  });

  it("falls back to the file-name list when no _index.md exists", async () => {
    const app = makeApp(BASE_FILES); // no _index.md in BASE_FILES
    const out = await readBootContext(app, P);
    expect(out).toContain("### Active rules");
    expect(out).toContain("- rule-verify-mario-bio");
  });
});
