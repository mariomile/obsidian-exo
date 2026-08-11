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
import {
  settleConversationToNote,
  type SettleVaultAdapter,
} from "../src/obsidian/settle-note";
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
    expect(note.frontmatter[SETTLE_CONVO_KEY]).toMatch(/^c7-/);
  });

  it("stamps identity with something the id counter cannot hand out twice", () => {
    // `c7` is a recycled counter value, not an identity: delete the
    // highest-numbered chat and the next new one mints as `c7` again. The
    // stamp therefore carries the opening turn as well, so a fresh chat
    // wearing a dead chat's number cannot claim its note.
    const opening: Message[] = [{ role: "user", text: "Make the onboarding copy shorter", at: 111 }];
    const mine = distillConversation(source({ messages: opening }), EMPTY_RECAP);
    const recycled = distillConversation(
      source({ messages: [{ role: "user", text: "Draft the launch email", at: 222 }] }),
      EMPTY_RECAP,
    );
    expect(recycled.frontmatter[SETTLE_CONVO_KEY]).not.toBe(mine.frontmatter[SETTLE_CONVO_KEY]);

    // And it is STABLE as the same conversation grows, or the second settle
    // would write a second note instead of updating the first.
    const grown = distillConversation(
      source({
        messages: [...opening, { role: "assistant", segments: [{ t: "text", md: "Done." }] }],
        title: "Renamed since",
      }),
      EMPTY_RECAP,
    );
    expect(grown.frontmatter[SETTLE_CONVO_KEY]).toBe(mine.frontmatter[SETTLE_CONVO_KEY]);
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

  it("caps the name so a long manual rename still produces a writable file", () => {
    // A filename over the 255-byte limit is rejected by `vault.create`, and the
    // suffix uniqueSettlePath may add has to fit too.
    const name = settleFileName("Ship the onboarding rewrite ".repeat(40));
    expect(Buffer.byteLength(`${name} 12.md`, "utf8")).toBeLessThanOrEqual(255);
    expect(name.startsWith("Ship the onboarding rewrite")).toBe(true);
  });

  it("caps by bytes and never mid-character", () => {
    const name = settleFileName("🚀".repeat(200));
    expect(Buffer.byteLength(`${name}.md`, "utf8")).toBeLessThanOrEqual(255);
    expect([...name].every((c) => c === "🚀")).toBe(true);
  });

  it("does not produce a dotfile Obsidian refuses to index", () => {
    // Obsidian does not index dot-prefixed files, so `getAbstractFileByPath`
    // never returns a TFile for one: the writer would take the `create` branch
    // every time and the second settle would fail with "File already exists".
    expect(settleFileName(".env config")).toBe("env config");
    expect(settleFileName("...")).toBe("Chat");
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
    // Both shapes a filed note actually takes: a scalar, and the indented
    // block sequence — the one the key patcher consumes when it owns the key.
    const filed =
      `---\n${SETTLE_CONVO_KEY}: "c7"\nproject: "[[Onboarding]]"\n` +
      `related:\n  - "[[Q3 launch]]"\n  - "[[Copy review]]"\n---\nold body\n`;
    const out = renderSettleNote(filed, {
      frontmatter: { [SETTLE_CONVO_KEY]: "c7", outcome: "settled" },
      body: "new body\n",
    });
    expect(out).toMatch(/project: "\[\[Onboarding\]\]"/);
    expect(out).toMatch(/- "\[\[Q3 launch\]\]"/);
    expect(out).toMatch(/- "\[\[Copy review\]\]"/);
    expect(out).toMatch(/new body/);
    expect(out).not.toMatch(/old body/);
  });

  it("adds its tag to the user's tags instead of replacing them", () => {
    // The promise is that a filed note survives a re-settle. Keeping the KEY
    // and dropping the values in it is not keeping the note filed: a chat
    // sorted into `project/onboarding` came back tagged only `exo/chat`.
    const filed =
      `---\n${SETTLE_CONVO_KEY}: "c7"\ntags:\n  - project/onboarding\n  - important\n---\nold body\n`;
    const out = renderSettleNote(filed, {
      frontmatter: { [SETTLE_CONVO_KEY]: "c7", tags: [SETTLE_TAG] },
      body: "new body\n",
    });
    expect(out).toMatch(/project\/onboarding/);
    expect(out).toMatch(/important/);
    expect(out).toMatch(/exo\/chat/);
  });

  it("reads the user's tags in whichever shape they wrote them", () => {
    const inline = renderSettleNote(
      `---\ntags: [project/onboarding, important]\n---\nold\n`,
      { frontmatter: { tags: [SETTLE_TAG] }, body: "new\n" },
    );
    expect(inline).toMatch(/project\/onboarding/);
    expect(inline).toMatch(/important/);

    const scalar = renderSettleNote(`---\ntags: important\n---\nold\n`, {
      frontmatter: { tags: [SETTLE_TAG] },
      body: "new\n",
    });
    expect(scalar).toMatch(/important/);
    expect(scalar).toMatch(/exo\/chat/);
  });

  it("does not stack a second copy of its own tag on every settle", () => {
    const once = renderSettleNote(`---\ntags: ["${SETTLE_TAG}", mine]\n---\nold\n`, {
      frontmatter: { tags: [SETTLE_TAG] },
      body: "new\n",
    });
    expect(once.match(new RegExp(SETTLE_TAG, "g"))?.length).toBe(1);
    expect(once).toMatch(/mine/);
  });
});

/* ---------------------------------------------------------------------------
 * The writer, driven end to end against a fake vault. The pieces above are
 * each correct on their own; what is tested here is the decision the writer
 * makes with them — whose note this is, and whether a second settle writes a
 * second file. That is the criterion, and it lives nowhere else.
 * ------------------------------------------------------------------------ */

const fakeVault = () => {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const adapter: SettleVaultAdapter = {
    // Same listing the real adapter produces: one folder deep, `.md` only
    // (`adapter.list(dir).files.filter(endsWith(".md"))`). A recursive or
    // unfiltered fake would test the writer against input it can never get.
    listFiles: async (dir) =>
      [...files.keys()].filter(
        (p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/") && p.endsWith(".md"),
      ),
    read: async (path) => {
      const raw = files.get(path);
      if (raw === undefined) throw new Error(`no such file: ${path}`);
      return raw;
    },
    write: async (path, content) => void files.set(path, content),
    ensureFolder: async (dir) => void folders.add(dir),
  };
  return { adapter, files, folders };
};

describe("settling a conversation to its note", () => {
  const paths = exoPaths("_exo");
  const folder = settleFolder(paths);
  const talk = (ask: string, answer: string): Message[] => [
    { role: "user", text: ask },
    { role: "assistant", segments: [{ t: "text", md: answer }] },
  ];

  it("creates the folder and writes one note", async () => {
    const vault = fakeVault();
    const path = await settleConversationToNote(vault.adapter, paths, source({ messages: talk("do X", "did X") }));
    expect(path).toBe(`${folder}/Rewrite the onboarding copy.md`);
    expect(vault.folders.has(folder)).toBe(true);
    expect([...vault.files.keys()]).toEqual([path]);
    expect(vault.files.get(path)).toMatch(/did X/);
  });

  it("re-settles into the same file, updated, instead of a second copy", async () => {
    const vault = fakeVault();
    const first = await settleConversationToNote(vault.adapter, paths, source({ messages: talk("do X", "did X") }));
    const again = await settleConversationToNote(
      vault.adapter,
      paths,
      source({ messages: [...talk("do X", "did X"), ...talk("now do Y", "did Y")] }),
    );
    expect(again).toBe(first);
    expect(vault.files.size).toBe(1);
    expect(vault.files.get(first)).toMatch(/did Y/);
    expect(vault.files.get(first)).not.toMatch(/did X/); // the body is replaced, not appended to
  });

  it("follows its own note after the user renames it", async () => {
    const vault = fakeVault();
    const src = source({ messages: talk("do X", "did X") });
    const first = await settleConversationToNote(vault.adapter, paths, src);
    const renamed = `${folder}/Onboarding copy — final.md`;
    vault.files.set(renamed, vault.files.get(first)!);
    vault.files.delete(first);
    expect(await settleConversationToNote(vault.adapter, paths, src)).toBe(renamed);
    expect(vault.files.size).toBe(1);
  });

  it("never overwrites another chat's note that happens to share a title", async () => {
    const vault = fakeVault();
    const mine = await settleConversationToNote(vault.adapter, paths, source({ messages: talk("a", "b") }));
    const theirs = await settleConversationToNote(
      vault.adapter,
      paths,
      source({ id: "c8", messages: talk("c", "d") }),
    );
    expect(theirs).toBe(`${folder}/Rewrite the onboarding copy 2.md`);
    expect(vault.files.size).toBe(2);
    expect(vault.files.get(mine)).toMatch(/c7/);
    expect(vault.files.get(theirs)).toMatch(/c8/);
  });

  it("does not let a chat that inherited a dead chat's id destroy its note", async () => {
    // The premise of the feature is that the note outlives the chat. Settle
    // c7, delete chat c7, reload — the seed drops back and the next new chat
    // mints as c7. It must not walk into the old note and replace the body.
    const vault = fakeVault();
    const mine = await settleConversationToNote(
      vault.adapter,
      paths,
      source({ messages: talk("rewrite the onboarding copy", "did X") }),
    );
    const recycled = await settleConversationToNote(
      vault.adapter,
      paths,
      source({ id: "c7", title: "Draft the launch email", messages: talk("draft the email", "did Y") }),
    );
    expect(recycled).not.toBe(mine);
    expect(vault.files.get(mine)).toMatch(/did X/);
    expect(vault.files.get(mine)).not.toMatch(/did Y/);
    expect(vault.files.size).toBe(2);
  });

  it("does not let two settles fired at once collapse into one note", async () => {
    // Read-then-write with N awaits in between and no lock: two chats both
    // called "New chat", settled a keystroke apart from the sidebar, both saw
    // an empty folder and both claimed the same path. One created it, the
    // other modified it, and one conversation ended up with no note while the
    // surviving file carried the other chat's stamp.
    const vault = fakeVault();
    const both = await Promise.all([
      settleConversationToNote(vault.adapter, paths, source({ title: "New chat", messages: talk("a", "did A") })),
      settleConversationToNote(
        vault.adapter,
        paths,
        source({ id: "c8", title: "New chat", messages: talk("b", "did B") }),
      ),
    ]);
    expect(new Set(both).size).toBe(2);
    expect(vault.files.size).toBe(2);
    expect(vault.files.get(both[0])).toMatch(/did A/);
    expect(vault.files.get(both[1])).toMatch(/did B/);
  });

  it("never overwrites a neighbour it could not read", async () => {
    // The file the source title wants is already there and CANNOT BE READ — a
    // note deleted between the list and the read under Sync, a permission
    // error, undecodable bytes. Unreadable means "not this conversation's
    // note", never "free to take": the collision set is the listing, not the
    // files that happened to read back.
    const vault = fakeVault();
    const ghost = `${folder}/Rewrite the onboarding copy.md`;
    vault.files.set(ghost, "someone else's note, in bytes we cannot decode\n");
    vault.adapter.read = async () => {
      throw new Error("EACCES");
    };
    const path = await settleConversationToNote(vault.adapter, paths, source({ messages: talk("a", "b") }));
    expect(path).toBe(`${folder}/Rewrite the onboarding copy 2.md`);
    expect(vault.files.get(ghost)).toBe("someone else's note, in bytes we cannot decode\n");
    expect(vault.files.size).toBe(2);
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
