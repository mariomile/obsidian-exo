import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SETTLE_CONVO_KEY,
  SETTLE_TAG,
  canSettle,
  distillConversation,
  findSettledNote,
  renderSettleNote,
  settleFileName,
  settleFolder,
  settleNotePath,
  settleOutcome,
  uniqueSettlePath,
  type SettleSource,
} from "../src/core/settle-note";
import { buildRecap } from "../src/core/recap";
import { exoPaths } from "../src/core/paths";
import type { Message } from "../src/core/model";
import type { Recap } from "../src/core/recap";

/**
 * Phase 7 — Settle to Note. The gate, the frontmatter schema, the distillation
 * and the re-settle update path.
 */

const EMPTY_RECAP: Recap = { web: [], read: [], written: [], skills: [] };

const source = (over: Partial<SettleSource> = {}): SettleSource => ({
  id: "c7",
  title: "Rewrite the onboarding copy",
  provider: "Claude",
  model: "claude-opus-5",
  stopped: false,
  poisoned: false,
  messages: [],
  ...over,
});

describe("the settled-only gate", () => {
  const gate = { streaming: false, pendingPerm: false, pendingAsk: false, hasMessages: true };

  it("allows a settled chat", () => {
    expect(canSettle(gate)).toBe(true);
  });

  it("refuses a running chat", () => {
    expect(canSettle({ ...gate, streaming: true })).toBe(false);
  });

  it("refuses a chat blocked on a permission or a question", () => {
    expect(canSettle({ ...gate, pendingPerm: true })).toBe(false);
    expect(canSettle({ ...gate, pendingAsk: true })).toBe(false);
  });

  it("refuses an empty chat — there is nothing to distil", () => {
    expect(canSettle({ ...gate, hasMessages: false })).toBe(false);
  });

  it("records how the chat ended, with a stop outranking an error", () => {
    expect(settleOutcome({ stopped: false, poisoned: false })).toBe("settled");
    expect(settleOutcome({ stopped: false, poisoned: true })).toBe("error");
    expect(settleOutcome({ stopped: true, poisoned: true })).toBe("stopped");
  });
});

describe("the frontmatter schema", () => {
  it("carries agent, provider, outcome and files touched", () => {
    const messages: Message[] = [
      { role: "user", text: "rewrite it" },
      {
        role: "assistant",
        segments: [
          { t: "tool", name: "Write", input: { file_path: "Notes/copy.md" }, ok: true, output: "" },
          { t: "text", md: "Done." },
        ],
      },
    ];
    const note = distillConversation(
      source({ messages, agent: "editor" }),
      buildRecap(messages as Message[]),
    );
    expect(note.frontmatter.agent).toBe("editor");
    expect(note.frontmatter.provider).toBe("Claude");
    expect(note.frontmatter.outcome).toBe("settled");
    expect(note.frontmatter.files_touched).toEqual(["Notes/copy.md"]);
    expect(note.frontmatter.tags).toEqual([SETTLE_TAG]);
    expect(note.frontmatter[SETTLE_CONVO_KEY]).toBe("c7");
  });

  it("states an unbound agent explicitly rather than omitting the key", () => {
    const note = distillConversation(source(), EMPTY_RECAP);
    expect(Object.keys(note.frontmatter)).toContain("agent");
    expect(note.frontmatter.agent).toBeNull();
  });

  it("reports a stopped chat as stopped", () => {
    const note = distillConversation(source({ stopped: true }), EMPTY_RECAP);
    expect(note.frontmatter.outcome).toBe("stopped");
    expect(note.body).toMatch(/stopped before it finished/);
  });
});

describe("the distillation", () => {
  const messages: Message[] = [
    { role: "user", text: "Make the onboarding copy shorter" },
    {
      role: "assistant",
      segments: [
        {
          t: "tool",
          name: "Read",
          input: { file_path: "Notes/onboarding.md" },
          ok: true,
          output: "SECRET RAW TOOL OUTPUT that must never reach the note",
        },
        { t: "text", md: "Here is a draft." },
      ],
    },
    { role: "user", text: "Tighten the second paragraph" },
    {
      role: "assistant",
      segments: [
        {
          t: "tool",
          name: "Edit",
          input: { file_path: "Notes/onboarding.md" },
          ok: true,
          output: "diff noise nobody wants in a note",
        },
        { t: "text", md: "Tightened it: the second paragraph is now two sentences." },
      ],
    },
  ];
  const note = distillConversation(source({ messages }), buildRecap(messages));

  it("is a summary, not a transcript dump", () => {
    expect(note.body).not.toMatch(/SECRET RAW TOOL OUTPUT/);
    expect(note.body).not.toMatch(/diff noise/);
    // Intermediate answers do not reach the page either: only the last one does.
    expect(note.body).not.toMatch(/Here is a draft/);
    expect(note.body).toMatch(/Tightened it/);
  });

  it("keeps what was asked, in order", () => {
    const asked = note.body.slice(note.body.indexOf("## Asked"));
    expect(asked.indexOf("Make the onboarding copy shorter")).toBeLessThan(
      asked.indexOf("Tighten the second paragraph"),
    );
  });

  it("links the files it touched, so the note lands in the graph with backlinks", () => {
    expect(note.body).toMatch(/\[\[Notes\/onboarding\]\]/);
  });

  it("caps a long conversation instead of transcribing it", () => {
    const many: Message[] = [];
    for (let i = 0; i < 20; i++) many.push({ role: "user", text: `turn ${i}` });
    const capped = distillConversation(source({ messages: many }), EMPTY_RECAP);
    expect(capped.body).toMatch(/turn 0/);
    expect(capped.body).not.toMatch(/turn 19\b/);
    expect(capped.body).toMatch(/and 14 more turns/);
  });

  it("trims a runaway single turn rather than pasting it whole", () => {
    const long = "x".repeat(5000);
    const capped = distillConversation(
      source({ messages: [{ role: "user", text: long }] }),
      EMPTY_RECAP,
    );
    expect(capped.body.length).toBeLessThan(1200);
    expect(capped.body).toMatch(/…/);
  });
});

describe("where the note goes", () => {
  it("resolves the folder through the memory-root path helpers, never a literal", () => {
    expect(settleFolder(exoPaths("_exo"))).toBe("_exo/chats");
    expect(settleFolder(exoPaths("_system"))).toBe("_system/chats");
    // The choice moves with the root: no second setting, no hard-coded path.
    expect(settleFolder(exoPaths("Vault/Exo"))).toBe("Vault/Exo/chats");
  });

  it("keeps the title as the filename, minus what a filename cannot hold", () => {
    expect(settleFileName('A/B: "c" [d]?')).toBe("AB c d");
    expect(settleFileName("///")).toBe("Chat");
    expect(settleNotePath("_exo/chats", "Ship it")).toBe("_exo/chats/Ship it.md");
  });

  it("does not let two chats with the same title overwrite each other", () => {
    const taken = ["_exo/chats/New chat.md"];
    expect(uniqueSettlePath("_exo/chats", "New chat", taken)).toBe("_exo/chats/New chat 2.md");
    expect(uniqueSettlePath("_exo/chats", "New chat", [...taken, "_exo/chats/New chat 2.md"])).toBe(
      "_exo/chats/New chat 3.md",
    );
  });
});

describe("re-settling the same conversation", () => {
  const files = [
    { path: "_exo/chats/Other.md", raw: `---\n${SETTLE_CONVO_KEY}: "c1"\n---\nbody\n` },
    { path: "_exo/chats/Renamed by hand.md", raw: `---\n${SETTLE_CONVO_KEY}: "c7"\n---\nbody\n` },
  ];

  it("finds the existing note by its stamp, not by its filename", () => {
    expect(findSettledNote(files, "c7")).toBe("_exo/chats/Renamed by hand.md");
    expect(findSettledNote(files, "c9")).toBeNull();
  });

  it("ignores a note with no frontmatter at all", () => {
    expect(findSettledNote([{ path: "n.md", raw: "just prose\n" }], "c7")).toBeNull();
  });

  it("updates the existing note instead of appending a second copy", () => {
    const first = renderSettleNote(null, {
      frontmatter: { [SETTLE_CONVO_KEY]: "c7", outcome: "settled" },
      body: "# Title\n\nfirst pass\n",
    });
    expect(first).toMatch(/^---\n/);
    expect(first).toMatch(/first pass/);

    const second = renderSettleNote(first, {
      frontmatter: { [SETTLE_CONVO_KEY]: "c7", outcome: "stopped" },
      body: "# Title\n\nsecond pass\n",
    });
    expect(second).toMatch(/second pass/);
    expect(second).not.toMatch(/first pass/);
    expect(second.match(/^---$/gm)?.length).toBe(2);
    expect(second).toMatch(/outcome: "stopped"/);
  });

  it("keeps frontmatter the user added by hand", () => {
    const filed = `---\n${SETTLE_CONVO_KEY}: "c7"\nproject: "[[Onboarding]]"\n---\nold body\n`;
    const out = renderSettleNote(filed, {
      frontmatter: { [SETTLE_CONVO_KEY]: "c7", outcome: "settled" },
      body: "new body\n",
    });
    expect(out).toMatch(/project: "\[\[Onboarding\]\]"/);
    expect(out).toMatch(/new body/);
    expect(out).not.toMatch(/old body/);
  });
});

/* ---------------------------------------------------------------------------
 * The wiring: the action is manual, it is offered only where it is allowed,
 * and it writes a real vault file.
 * ------------------------------------------------------------------------ */

const read = (rel: string): string => readFileSync(join(__dirname, "..", rel), "utf8");

describe("the Settle to note action", () => {
  const list = read("src/ui/chat-list-view.ts");
  const writer = read("src/obsidian/settle-note.ts");
  const bridge = read("src/ui/convo-bridge.ts");

  it("is offered from the row menu, gated on the row being settled", () => {
    expect(list).toMatch(/Settle to note/);
    expect(list).toMatch(/canSettleRow\(/);
  });

  it("is manual: nothing settles a chat on turn end", () => {
    // The only callers are the row menu and the palette command — a grep for
    // the writer anywhere in the turn engine would mean it became automatic.
    expect(read("src/view.ts")).not.toMatch(/settleToNote|settleConversation/);
  });

  it("writes through the Vault API so the note is indexed, linked and searchable", () => {
    // `vault.create`/`vault.modify`, not `adapter.write`: the adapter bypasses
    // Obsidian's cache, and a file the cache never saw has no backlinks and no
    // graph node until a restart.
    expect(writer).toMatch(/vault\.create\(/);
    expect(writer).toMatch(/vault\.modify\(/);
  });

  it("reaches the writer through the plugin wrappers, never through the view", () => {
    expect(bridge).toMatch(/settleToNote/);
    const code = list.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/from "\.\.\/view"/);
    expect(code).not.toMatch(/\bChatView\b/);
  });
});
