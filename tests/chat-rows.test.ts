import { describe, it, expect } from "vitest";
import { buildChatList, relativeTime, modelLabel, type ChatRowSource } from "../src/core/chat-rows";

describe("modelLabel", () => {
  it("drops a provider prefix the id repeats", () => {
    expect(modelLabel("Claude", "claude-opus-5")).toBe("Opus 5");
  });

  it("joins a split version with a dot, not a space", () => {
    // 4-8 is one version number, not two tokens.
    expect(modelLabel("Claude", "claude-opus-4-8")).toBe("Opus 4.8");
    expect(modelLabel("Claude", "claude-sonnet-4-6")).toBe("Sonnet 4.6");
  });

  it("handles the whole real Claude family", () => {
    expect(modelLabel("Claude", "claude-sonnet-5")).toBe("Sonnet 5");
    expect(modelLabel("Claude", "claude-fable-5")).toBe("Fable 5");
  });

  it("uppercases known acronyms and keeps word tokens as words", () => {
    expect(modelLabel("Codex", "gpt-5.6-luna")).toBe("GPT 5.6 Luna");
  });

  it("leaves an id alone when it does not repeat the provider", () => {
    expect(modelLabel("Codex", "opus-5")).toBe("Opus 5");
  });

  it("matches the provider prefix case-insensitively", () => {
    expect(modelLabel("CLAUDE", "claude-opus-5")).toBe("Opus 5");
  });

  it("returns empty for an empty model rather than a stray separator", () => {
    expect(modelLabel("Claude", "")).toBe("");
    expect(modelLabel("Claude", "   ")).toBe("");
  });
});

const NOON = new Date(2026, 7, 7, 12, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A quiet, idle, non-archived, closed conversation with one message. Every
 *  test overrides only the fields it is actually about. */
const src = (over: Partial<ChatRowSource> = {}): ChatRowSource => ({
  id: "c1",
  title: "Untitled",
  preview: "",
  provider: "claude",
  model: "opus",
  updatedAt: NOON,
  archived: false,
  open: false,
  pinned: false,
  unseen: false,
  messageCount: 3,
  streaming: false,
  pendingPerm: false,
  pendingAsk: false,
  poisoned: false,
  stopped: false,
  hasMessages: true,
  ...over,
});

const build = (sources: ChatRowSource[], query = "") =>
  buildChatList(sources, { query, now: NOON });

const historyIds = (vm: ReturnType<typeof build>) =>
  vm.groups.flatMap((g) => g.items.map((r) => r.id));

describe("buildChatList — tiering", () => {
  it("puts a streaming conversation in the working set", () => {
    const vm = build([src({ id: "a", streaming: true })]);
    expect(vm.active.map((r) => r.id)).toEqual(["a"]);
    expect(vm.groups).toEqual([]);
  });

  it("puts an open tab in the working set even when nothing is running", () => {
    // The whole point of the section Mario asked for: an open tab is a chat you
    // deliberately kept to hand, so it belongs with the work, not the archive.
    const vm = build([src({ id: "a", open: true })]);
    expect(vm.active.map((r) => r.id)).toEqual(["a"]);
    expect(historyIds(vm)).toEqual([]);
  });

  it("puts a closed idle conversation in the history tier", () => {
    const vm = build([src({ id: "a" })]);
    expect(vm.active).toEqual([]);
    expect(historyIds(vm)).toEqual(["a"]);
  });

  it("never lists the same conversation in two tiers", () => {
    const vm = build([
      src({ id: "live", streaming: true }),
      src({ id: "open", open: true }),
      src({ id: "pin", pinned: true }),
      src({ id: "old" }),
    ]);
    const all = [...vm.active.map((r) => r.id), ...vm.pinned.map((r) => r.id), ...historyIds(vm)];
    expect(all.sort()).toEqual(["live", "old", "open", "pin"]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("labels a permission-blocked conversation needs-input, NOT running, even though it is still streaming", () => {
    // A blocked turn has streaming:true because its finally has not run.
    // Reading streaming first would say "working" about something waiting on you.
    const vm = build([src({ id: "a", streaming: true, pendingPerm: true })]);
    expect(vm.active[0].lane).toBe("needs-input");
    expect(vm.active[0].reason).toBe("perm");
  });

  it("distinguishes an ask-blocked conversation from a permission-blocked one", () => {
    const vm = build([src({ id: "a", streaming: true, pendingAsk: true })]);
    expect(vm.active[0].lane).toBe("needs-input");
    expect(vm.active[0].reason).toBe("ask");
  });

  it("leaves lane undefined on a merely-open tab", () => {
    const vm = build([src({ id: "a", open: true })]);
    expect(vm.active[0].lane).toBeUndefined();
  });
});

describe("buildChatList — working-set ordering", () => {
  it("ranks needs-input, then running, then unseen, then a plain open tab", () => {
    const vm = build([
      src({ id: "idle-open", open: true }),
      src({ id: "running", streaming: true }),
      src({ id: "unseen", open: true, unseen: true }),
      src({ id: "blocked", streaming: true, pendingAsk: true }),
    ]);
    expect(vm.active.map((r) => r.id)).toEqual(["blocked", "running", "unseen", "idle-open"]);
  });

  it("breaks ties within a rank by recency", () => {
    const vm = build([
      src({ id: "old", open: true, updatedAt: NOON - 2 * HOUR }),
      src({ id: "new", open: true, updatedAt: NOON }),
    ]);
    expect(vm.active.map((r) => r.id)).toEqual(["new", "old"]);
  });
});

describe("buildChatList — pinned", () => {
  it("gives a pinned closed conversation its own tier, out of history", () => {
    const vm = build([src({ id: "a", pinned: true })]);
    expect(vm.pinned.map((r) => r.id)).toEqual(["a"]);
    expect(historyIds(vm)).toEqual([]);
  });

  it("keeps a pinned OPEN conversation in the working set, not in both", () => {
    const vm = build([src({ id: "a", pinned: true, open: true })]);
    expect(vm.active.map((r) => r.id)).toEqual(["a"]);
    expect(vm.pinned).toEqual([]);
  });

  it("keeps a pinned RUNNING conversation in the working set", () => {
    const vm = build([src({ id: "a", pinned: true, streaming: true })]);
    expect(vm.active.map((r) => r.id)).toEqual(["a"]);
    expect(vm.pinned).toEqual([]);
  });

  it("carries the pinned flag onto the row wherever it lands", () => {
    const vm = build([src({ id: "a", pinned: true, open: true })]);
    expect(vm.active[0].pinned).toBe(true);
  });

  it("sorts the pinned tier by recency", () => {
    const vm = build([
      src({ id: "old", pinned: true, updatedAt: NOON - 2 * HOUR }),
      src({ id: "new", pinned: true, updatedAt: NOON }),
    ]);
    expect(vm.pinned.map((r) => r.id)).toEqual(["new", "old"]);
  });
});

describe("buildChatList — exclusions", () => {
  it("drops archived conversations from every tier", () => {
    const vm = build([src({ id: "a", archived: true, open: true, pinned: true })]);
    expect(vm.active).toEqual([]);
    expect(vm.pinned).toEqual([]);
    expect(vm.groups).toEqual([]);
    expect(vm.total).toBe(0);
  });

  it("drops an archived conversation even while it is streaming", () => {
    const vm = build([src({ id: "a", archived: true, streaming: true })]);
    expect(vm.active).toEqual([]);
  });

  it("drops empty New chat husks", () => {
    const vm = build([src({ id: "a", hasMessages: false })]);
    expect(vm.active).toEqual([]);
    expect(vm.groups).toEqual([]);
  });
});

describe("buildChatList — badges", () => {
  it("carries a stopped badge on an idle conversation", () => {
    const vm = build([src({ id: "a", stopped: true })]);
    expect(vm.groups[0].items[0].badge).toBe("stopped");
  });

  it("carries an error badge on a poisoned conversation", () => {
    const vm = build([src({ id: "a", poisoned: true })]);
    expect(vm.groups[0].items[0].badge).toBe("error");
  });

  it("prefers stopped over error when both are true", () => {
    const vm = build([src({ id: "a", stopped: true, poisoned: true })]);
    expect(vm.groups[0].items[0].badge).toBe("stopped");
  });

  it("keeps the badge on a row that sits in the working set", () => {
    // The badge is independent of the lane: an open tab whose last turn errored
    // must still say so, or the only place the failure was visible disappears
    // the moment you keep the tab open.
    const vm = build([src({ id: "a", open: true, poisoned: true })]);
    expect(vm.active[0].badge).toBe("error");
  });
});

describe("buildChatList — unseen", () => {
  it("carries the unseen flag onto the row", () => {
    const vm = build([src({ id: "a", open: true, unseen: true })]);
    expect(vm.active[0].unseen).toBe(true);
  });

  it("does not by itself promote a closed conversation out of history", () => {
    // Unseen is a marker, not a tier: promoting on it would quietly rebuild the
    // working set out of chats the user already filed away.
    const vm = build([src({ id: "a", unseen: true })]);
    expect(vm.active).toEqual([]);
    expect(historyIds(vm)).toEqual(["a"]);
    expect(vm.groups[0].items[0].unseen).toBe(true);
  });
});

describe("buildChatList — search", () => {
  it("matches on title, case-insensitively", () => {
    const vm = build([src({ id: "a", title: "Drag and Drop" }), src({ id: "b", title: "Other" })], "DRAG");
    expect(historyIds(vm)).toEqual(["a"]);
  });

  it("matches on preview as well as title", () => {
    const vm = build([src({ id: "a", title: "Untitled", preview: "fix the gutter" })], "gutter");
    expect(vm.matched).toBe(1);
  });

  it("treats a whitespace-only query as no query", () => {
    const vm = build([src({ id: "a" }), src({ id: "b" })], "   ");
    expect(vm.matched).toBe(2);
  });

  it("matches tokens in any order, across words the user did not remember", () => {
    // The failure this replaced: `includes(query)` needs the words contiguous,
    // so typing what you remember never found the chat.
    const vm = build([src({ id: "a", title: "GBrain di Garry Tan — cosa rubare" })], "gbrain garry");
    expect(vm.matched).toBe(1);
  });

  it("requires every token, not just one", () => {
    const vm = build([src({ id: "a", title: "GBrain di Garry Tan" })], "gbrain notion");
    expect(vm.matched).toBe(0);
  });

  it("spans title and preview together", () => {
    const vm = build([src({ id: "a", title: "Vault Blueprint", preview: "phase four rollout" })], "blueprint rollout");
    expect(vm.matched).toBe(1);
  });

  it("ignores diacritics, in both directions", () => {
    // Nobody types the accent into a filter box.
    expect(build([src({ id: "a", title: "Però funziona" })], "pero").matched).toBe(1);
    expect(build([src({ id: "a", title: "Pero funziona" })], "però").matched).toBe(1);
  });

  it("filters every tier, not only history", () => {
    const vm = build(
      [
        src({ id: "keep", title: "keep", open: true }),
        src({ id: "drop", title: "drop", open: true }),
        src({ id: "pin-drop", title: "drop", pinned: true }),
      ],
      "keep",
    );
    expect(vm.active.map((r) => r.id)).toEqual(["keep"]);
    expect(vm.pinned).toEqual([]);
  });

  it("reports total and matched separately so the view can tell 'no chats' from 'no matches'", () => {
    const vm = build([src({ id: "a", title: "alpha" }), src({ id: "b", title: "beta" })], "zzz");
    expect(vm.total).toBe(2);
    expect(vm.matched).toBe(0);
    expect(vm.active).toEqual([]);
    expect(vm.pinned).toEqual([]);
    expect(vm.groups).toEqual([]);
  });
});

describe("buildChatList — grouping", () => {
  it("buckets by calendar day, not by rolling 24 hours", () => {
    // 23:00 yesterday is "Yesterday" read at noon today, even though it is only
    // 13 hours ago.
    const lastNight = new Date(2026, 7, 6, 23, 0, 0).getTime();
    const vm = build([src({ id: "a", updatedAt: lastNight })]);
    expect(vm.groups[0].label).toBe("Yesterday");
  });

  it("puts a conversation with no updatedAt in Older", () => {
    const vm = build([src({ id: "a", updatedAt: undefined })]);
    expect(vm.groups[0].label).toBe("Older");
  });

  it("orders groups Today before Yesterday before This week", () => {
    const vm = build([
      src({ id: "week", updatedAt: NOON - 3 * DAY }),
      src({ id: "today", updatedAt: NOON }),
      src({ id: "yday", updatedAt: NOON - DAY }),
    ]);
    expect(vm.groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "This week"]);
  });

  it("orders rows by recency inside a group", () => {
    const vm = build([
      src({ id: "older", updatedAt: NOON - 5 * HOUR }),
      src({ id: "newer", updatedAt: NOON - HOUR }),
    ]);
    expect(vm.groups[0].items.map((r) => r.id)).toEqual(["newer", "older"]);
  });
});

describe("relativeTime", () => {
  it("renders sub-hour ages in minutes", () => {
    expect(relativeTime(NOON - 30 * 60_000, NOON)).toBe("30m");
  });

  it("renders sub-day ages in hours", () => {
    expect(relativeTime(NOON - 19 * HOUR, NOON)).toBe("19h");
  });

  it("renders older ages in days", () => {
    expect(relativeTime(NOON - 4 * DAY, NOON)).toBe("4d");
  });

  it("renders anything under a minute as now", () => {
    expect(relativeTime(NOON - 5_000, NOON)).toBe("now");
  });

  it("never renders a negative age from a clock skew", () => {
    expect(relativeTime(NOON + 60_000, NOON)).toBe("now");
  });
});
