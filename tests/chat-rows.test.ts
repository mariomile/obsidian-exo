import { describe, it, expect } from "vitest";
import {
  buildChatList,
  relativeTime,
  modelLabel,
  type ChatListVM,
  type ChatRow,
  type ChatRowSource,
  type ChatSectionKey,
} from "../src/core/chat-rows";

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

const byDays = (sources: ChatRowSource[], query = "") =>
  buildChatList(sources, { query, now: NOON, mode: "days" });

/** The rows of one section, or `[]` when the model dropped it as empty — which
 *  is the same thing as far as the screen is concerned. */
const rows = (vm: ChatListVM, key: ChatSectionKey): ChatRow[] =>
  vm.sections.find((s) => s.key === key)?.items ?? [];

const ids = (vm: ChatListVM, key: ChatSectionKey): string[] => rows(vm, key).map((r) => r.id);

const shape = (vm: ChatListVM, key: ChatSectionKey): Array<[string, number]> =>
  rows(vm, key).map((r) => [r.id, r.depth]);

/** Every row on screen, in paint order, across every section including
 *  `related`. The only way to tell "moved" from "duplicated". */
const allIds = (vm: ChatListVM): string[] => vm.sections.flatMap((s) => s.items.map((r) => r.id));

const daySections = (vm: ChatListVM) => vm.sections.filter((s) => s.key.startsWith("day:"));
const dayIds = (vm: ChatListVM): string[] => daySections(vm).flatMap((s) => s.items.map((r) => r.id));
const dayLabels = (vm: ChatListVM): string[] => daySections(vm).map((s) => s.label);

describe("buildChatList — state sections", () => {
  it("puts a streaming conversation in Running", () => {
    const vm = build([src({ id: "a", streaming: true })]);
    expect(ids(vm, "running")).toEqual(["a"]);
    expect(vm.sections.map((s) => s.key)).toEqual(["running"]);
  });

  it("puts an open tab in Open even when nothing is running", () => {
    // An open tab is a chat you deliberately kept to hand, so it belongs with
    // the work, not the archive.
    const vm = build([src({ id: "a", open: true })]);
    expect(ids(vm, "open")).toEqual(["a"]);
    expect(ids(vm, "settled")).toEqual([]);
  });

  it("puts a closed idle conversation in Settled", () => {
    const vm = build([src({ id: "a" })]);
    expect(ids(vm, "settled")).toEqual(["a"]);
    expect(vm.sections.map((s) => s.key)).toEqual(["settled"]);
  });

  it("never lists the same conversation in two sections", () => {
    const vm = build([
      src({ id: "live", streaming: true }),
      src({ id: "open", open: true }),
      src({ id: "pin", pinned: true }),
      src({ id: "old" }),
    ]);
    expect([...allIds(vm)].sort()).toEqual(["live", "old", "open", "pin"]);
    expect(new Set(allIds(vm)).size).toBe(allIds(vm).length);
  });

  it("labels a permission-blocked conversation needs-input, NOT running, even though it is still streaming", () => {
    // A blocked turn has streaming:true because its finally has not run.
    // Reading streaming first would say "working" about something waiting on you.
    const vm = build([src({ id: "a", streaming: true, pendingPerm: true })]);
    expect(rows(vm, "needsYou")[0].lane).toBe("needs-input");
    expect(rows(vm, "needsYou")[0].reason).toBe("perm");
    expect(ids(vm, "running")).toEqual([]);
  });

  it("distinguishes an ask-blocked conversation from a permission-blocked one", () => {
    const vm = build([src({ id: "a", streaming: true, pendingAsk: true })]);
    expect(rows(vm, "needsYou")[0].lane).toBe("needs-input");
    expect(rows(vm, "needsYou")[0].reason).toBe("ask");
  });

  it("leaves lane undefined on a merely-open tab", () => {
    const vm = build([src({ id: "a", open: true })]);
    expect(rows(vm, "open")[0].lane).toBeUndefined();
  });

  /**
   * The precedence, stated once and whole. Every row here qualifies for
   * several sections at once — the first one it earns is the only one it gets.
   */
  it("lands every row in exactly one section, in state precedence order", () => {
    const vm = build([
      src({ id: "blocked", streaming: true, pendingPerm: true, open: true, pinned: true }),
      src({ id: "errored", poisoned: true, open: true, pinned: true }),
      src({ id: "busy", streaming: true, open: true, pinned: true }),
      src({ id: "tab", open: true, pinned: true }),
      src({ id: "pin", pinned: true }),
      src({ id: "rest" }),
    ]);
    expect(vm.sections.map((s) => [s.key, s.items.map((r) => r.id)])).toEqual([
      ["needsYou", ["blocked", "errored"]],
      ["running", ["busy"]],
      ["open", ["tab"]],
      ["pinned", ["pin"]],
      ["settled", ["rest"]],
    ]);
  });

  it("carries a stable key and a separate display label on every section", () => {
    // The renderer keys collapsed state off `key`, never off `label` — a label
    // is display text and may be reworded or localized.
    const vm = build([
      src({ id: "blocked", pendingAsk: true }),
      src({ id: "busy", streaming: true }),
      src({ id: "tab", open: true }),
      src({ id: "pin", pinned: true }),
      src({ id: "rest" }),
    ]);
    expect(vm.sections.map((s) => s.label)).toEqual([
      "Needs you",
      "Running",
      "Open",
      "Pinned",
      "Settled",
    ]);
  });

  /**
   * The decision, pinned: an errored row that is ALSO open goes to `needsYou`.
   * An error is an action item; being open is only where you left it. Filing
   * it under Open would put the one row that needs doing in the section for
   * rows that need nothing.
   */
  it("files an errored row that is also open under Needs you, not Open", () => {
    const vm = build([src({ id: "a", open: true, poisoned: true })]);
    expect(ids(vm, "needsYou")).toEqual(["a"]);
    expect(ids(vm, "open")).toEqual([]);
    expect(rows(vm, "needsYou")[0].badge).toBe("error");
  });

  it("files a stopped row under Needs you as well — a halted turn is yours to resume", () => {
    const vm = build([src({ id: "a", stopped: true })]);
    expect(ids(vm, "needsYou")).toEqual(["a"]);
    expect(ids(vm, "settled")).toEqual([]);
  });

  it("does not bucket Settled by day — that axis is the other mode", () => {
    const vm = build([
      src({ id: "today", updatedAt: NOON }),
      src({ id: "week", updatedAt: NOON - 3 * DAY }),
      src({ id: "ancient", updatedAt: NOON - 90 * DAY }),
    ]);
    expect(vm.sections.map((s) => s.key)).toEqual(["settled"]);
    expect(ids(vm, "settled")).toEqual(["today", "week", "ancient"]);
  });
});

describe("buildChatList — ordering inside a section", () => {
  it("reads a blocked chat before one that already failed, inside Needs you", () => {
    const vm = build([
      src({ id: "errored", poisoned: true, updatedAt: NOON }),
      src({ id: "blocked", pendingPerm: true, updatedAt: NOON - 5 * HOUR }),
    ]);
    expect(ids(vm, "needsYou")).toEqual(["blocked", "errored"]);
  });

  it("reads an unseen reply before an idle tab, inside Open", () => {
    const vm = build([
      src({ id: "idle", open: true, updatedAt: NOON }),
      src({ id: "unseen", open: true, unseen: true, updatedAt: NOON - 5 * HOUR }),
    ]);
    expect(ids(vm, "open")).toEqual(["unseen", "idle"]);
  });

  it("breaks ties within a rank by recency", () => {
    const vm = build([
      src({ id: "old", open: true, updatedAt: NOON - 2 * HOUR }),
      src({ id: "new", open: true, updatedAt: NOON }),
    ]);
    expect(ids(vm, "open")).toEqual(["new", "old"]);
  });

  it("sorts Running and Settled by plain recency", () => {
    const vm = build([
      src({ id: "r-old", streaming: true, updatedAt: NOON - 2 * HOUR }),
      src({ id: "r-new", streaming: true, updatedAt: NOON }),
      src({ id: "s-old", updatedAt: NOON - 5 * HOUR }),
      src({ id: "s-new", updatedAt: NOON - HOUR }),
    ]);
    expect(ids(vm, "running")).toEqual(["r-new", "r-old"]);
    expect(ids(vm, "settled")).toEqual(["s-new", "s-old"]);
  });
});

describe("buildChatList — pinned", () => {
  it("gives a pinned closed conversation its own section, out of Settled", () => {
    const vm = build([src({ id: "a", pinned: true })]);
    expect(ids(vm, "pinned")).toEqual(["a"]);
    expect(ids(vm, "settled")).toEqual([]);
  });

  it("keeps a pinned OPEN conversation in Open, not in both", () => {
    const vm = build([src({ id: "a", pinned: true, open: true })]);
    expect(ids(vm, "open")).toEqual(["a"]);
    expect(ids(vm, "pinned")).toEqual([]);
  });

  it("keeps a pinned RUNNING conversation in Running", () => {
    const vm = build([src({ id: "a", pinned: true, streaming: true })]);
    expect(ids(vm, "running")).toEqual(["a"]);
    expect(ids(vm, "pinned")).toEqual([]);
  });

  it("carries the pinned flag onto the row wherever it lands", () => {
    const vm = build([src({ id: "a", pinned: true, open: true })]);
    expect(rows(vm, "open")[0].pinned).toBe(true);
  });

  it("sorts the pinned section by recency", () => {
    const vm = build([
      src({ id: "old", pinned: true, updatedAt: NOON - 2 * HOUR }),
      src({ id: "new", pinned: true, updatedAt: NOON }),
    ]);
    expect(ids(vm, "pinned")).toEqual(["new", "old"]);
  });
});

/**
 * `days` is the alternative reading, kept whole and unchanged: pure chronology
 * by last message, no promotion, no state sections. Everything in here is a
 * REGRESSION pin — it must keep answering "what did I do on Tuesday" exactly as
 * it did before the default view moved to a state axis.
 */
describe("buildChatList — days mode", () => {
  it("promotes nothing: running, open and pinned all land in the day sections", () => {
    const vm = byDays([
      src({ id: "live", streaming: true }),
      src({ id: "open", open: true }),
      src({ id: "pin", pinned: true }),
      src({ id: "plain" }),
    ]);
    expect(vm.sections.every((s) => s.key.startsWith("day:"))).toBe(true);
    expect([...dayIds(vm)].sort()).toEqual(["live", "open", "pin", "plain"]);
  });

  it("emits no state section at all, not even an empty one", () => {
    const vm = byDays([src({ id: "blocked", pendingPerm: true }), src({ id: "err", poisoned: true })]);
    expect(vm.sections.map((s) => s.key)).toEqual(["day:Today"]);
  });

  it("orders strictly by last message, so an open tab does not outrank a newer chat", () => {
    // This is what the activity view cannot say: there, state wins over recency
    // and the day column would be out of order.
    const vm = byDays([
      src({ id: "openOld", open: true, updatedAt: NOON - 5 * HOUR }),
      src({ id: "closedNew", updatedAt: NOON }),
    ]);
    expect(dayIds(vm)).toEqual(["closedNew", "openOld"]);
  });

  it("keeps every marker on the row — only the grouping changes", () => {
    const vm = byDays([src({ id: "a", streaming: true, pendingPerm: true, pinned: true, unseen: true })]);
    const row = daySections(vm)[0].items[0];
    expect(row.lane).toBe("needs-input");
    expect(row.reason).toBe("perm");
    expect(row.pinned).toBe(true);
    expect(row.unseen).toBe(true);
  });

  it("buckets by calendar day, not by rolling 24 hours", () => {
    // 23:00 yesterday is "Yesterday" read at noon today, even though it is only
    // 13 hours ago.
    const lastNight = new Date(2026, 7, 6, 23, 0, 0).getTime();
    const vm = byDays([src({ id: "a", updatedAt: lastNight })]);
    expect(dayLabels(vm)).toEqual(["Yesterday"]);
  });

  it("puts a conversation with no updatedAt in Older", () => {
    const vm = byDays([src({ id: "a", updatedAt: undefined })]);
    expect(dayLabels(vm)).toEqual(["Older"]);
  });

  it("orders the buckets Today, Yesterday, This week", () => {
    const vm = byDays([
      src({ id: "week", updatedAt: NOON - 3 * DAY }),
      src({ id: "today", updatedAt: NOON }),
      src({ id: "yday", updatedAt: NOON - DAY }),
    ]);
    expect(dayLabels(vm)).toEqual(["Today", "Yesterday", "This week"]);
    expect(vm.sections.map((s) => s.key)).toEqual(["day:Today", "day:Yesterday", "day:This week"]);
  });

  it("orders rows by recency inside a bucket", () => {
    const vm = byDays([
      src({ id: "older", updatedAt: NOON - 5 * HOUR }),
      src({ id: "newer", updatedAt: NOON - HOUR }),
    ]);
    expect(dayIds(vm)).toEqual(["newer", "older"]);
  });

  it("still filters by query", () => {
    const vm = byDays([src({ id: "a", title: "keep", open: true }), src({ id: "b", title: "drop" })], "keep");
    expect(dayIds(vm)).toEqual(["a"]);
  });

  it("defaults to activity mode when no mode is given", () => {
    const vm = buildChatList([src({ id: "a", open: true })], { query: "", now: NOON });
    expect(ids(vm, "open")).toEqual(["a"]);
  });

  /**
   * Anchoring is an ACTIVITY-mode rule: it protects the state sections, and
   * this mode has none. Here the axis IS the date, so a live child sitting in
   * its parent's day bucket is the mode working as designed.
   */
  it("still nests a blocked child under a parent in an older bucket", () => {
    const vm = byDays([
      src({ id: "p", updatedAt: NOON - 3 * DAY }),
      src({ id: "c", updatedAt: NOON, parentConvoId: "p", pendingPerm: true }),
    ]);
    expect(dayLabels(vm)).toEqual(["This week"]);
    expect(daySections(vm)[0].items.map((r) => [r.id, r.depth])).toEqual([
      ["p", 0],
      ["c", 1],
    ]);
  });
});

describe("buildChatList — exclusions", () => {
  it("drops archived conversations from every section", () => {
    const vm = build([src({ id: "a", archived: true, open: true, pinned: true })]);
    expect(vm.sections).toEqual([]);
    expect(vm.total).toBe(0);
  });

  it("drops an archived conversation even while it is streaming", () => {
    const vm = build([src({ id: "a", archived: true, streaming: true })]);
    expect(vm.sections).toEqual([]);
  });

  it("drops empty New chat husks", () => {
    const vm = build([src({ id: "a", hasMessages: false })]);
    expect(vm.sections).toEqual([]);
  });
});

describe("buildChatList — badges", () => {
  it("carries a stopped badge on an idle conversation", () => {
    const vm = build([src({ id: "a", stopped: true })]);
    expect(rows(vm, "needsYou")[0].badge).toBe("stopped");
  });

  it("carries an error badge on a poisoned conversation", () => {
    const vm = build([src({ id: "a", poisoned: true })]);
    expect(rows(vm, "needsYou")[0].badge).toBe("error");
  });

  it("prefers stopped over error when both are true", () => {
    const vm = build([src({ id: "a", stopped: true, poisoned: true })]);
    expect(rows(vm, "needsYou")[0].badge).toBe("stopped");
  });

  it("keeps the badge on the row in days mode too", () => {
    // The badge is independent of the section: a chat whose last turn errored
    // must still say so wherever it is filed.
    const vm = byDays([src({ id: "a", open: true, poisoned: true })]);
    expect(daySections(vm)[0].items[0].badge).toBe("error");
  });
});

describe("buildChatList — unseen", () => {
  it("carries the unseen flag onto the row", () => {
    const vm = build([src({ id: "a", open: true, unseen: true })]);
    expect(rows(vm, "open")[0].unseen).toBe(true);
  });

  it("does not by itself promote a closed conversation out of Settled", () => {
    // Unseen is a marker, not a state: promoting on it would quietly rebuild
    // the working set out of chats the user already filed away.
    const vm = build([src({ id: "a", unseen: true })]);
    expect(ids(vm, "settled")).toEqual(["a"]);
    expect(rows(vm, "settled")[0].unseen).toBe(true);
  });
});

describe("buildChatList — search", () => {
  it("matches on title, case-insensitively", () => {
    const vm = build([src({ id: "a", title: "Drag and Drop" }), src({ id: "b", title: "Other" })], "DRAG");
    expect(ids(vm, "settled")).toEqual(["a"]);
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

  it("filters every section, not only Settled", () => {
    const vm = build(
      [
        src({ id: "keep", title: "keep", open: true }),
        src({ id: "drop", title: "drop", open: true }),
        src({ id: "pin-drop", title: "drop", pinned: true }),
      ],
      "keep",
    );
    expect(ids(vm, "open")).toEqual(["keep"]);
    expect(ids(vm, "pinned")).toEqual([]);
  });

  it("reports total and matched separately so the view can tell 'no chats' from 'no matches'", () => {
    const vm = build([src({ id: "a", title: "alpha" }), src({ id: "b", title: "beta" })], "zzz");
    expect(vm.total).toBe(2);
    expect(vm.matched).toBe(0);
    expect(vm.sections).toEqual([]);
  });
});

describe("buildChatList — semantic related section", () => {
  const sem = (sources: ChatRowSource[], query: string, semanticIds: string[]) =>
    buildChatList(sources, { query, now: NOON, semanticIds });

  it("adds a semantic hit the literal filter missed", () => {
    const vm = sem([src({ id: "a", title: "Vault Blueprint" }), src({ id: "b", title: "Tag namespace" })], "zzz", ["b"]);
    expect(ids(vm, "related")).toEqual(["b"]);
  });

  it("puts Related last, after every state section", () => {
    const vm = sem([src({ id: "a", title: "alpha match", open: true }), src({ id: "b", title: "beta" })], "match", ["b"]);
    expect(vm.sections.map((s) => s.key)).toEqual(["open", "related"]);
  });

  it("never duplicates a row that already matched literally", () => {
    const vm = sem([src({ id: "a", title: "Vault Blueprint" })], "vault", ["a"]);
    expect(ids(vm, "related")).toEqual([]);
    expect(ids(vm, "settled")).toEqual(["a"]);
  });

  it("preserves the semantic ranking order", () => {
    const vm = sem([src({ id: "a" }), src({ id: "b" }), src({ id: "c" })], "zzz", ["c", "a", "b"]);
    expect(ids(vm, "related")).toEqual(["c", "a", "b"]);
  });

  it("ignores semantic ids for conversations that are archived or gone", () => {
    const vm = sem([src({ id: "a", archived: true })], "zzz", ["a", "ghost"]);
    expect(ids(vm, "related")).toEqual([]);
  });

  it("does nothing at all when no query is being typed", () => {
    // Otherwise an idle sidebar would sprout a Related section out of nowhere.
    const vm = buildChatList([src({ id: "a" })], { query: "", now: NOON, semanticIds: ["a"] });
    expect(ids(vm, "related")).toEqual([]);
  });

  it("counts related rows as matches, so a semantic-only hit is not an empty state", () => {
    const vm = sem([src({ id: "a", title: "alpha" })], "zzz", ["a"]);
    expect(vm.matched).toBe(1);
    expect(vm.total).toBe(1);
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

/**
 * Fan-out children in the sidebar. Everything here goes through the REAL
 * `buildChatList` pipeline — sectioning, sorting, day bucketing — because the
 * whole risk of this feature is that grouping and ordering disagree once they
 * are composed, which testing `groupByParent` in isolation cannot catch.
 */
describe("buildChatList — child indentation", () => {
  const HALF_HOUR = HOUR / 2;

  it("places a child directly under its parent, indented, inside its section", () => {
    // Recency alone would order c, p (the child is newer) with both at depth 0.
    const vm = build([
      src({ id: "p", title: "Parent", open: true, updatedAt: NOON - HOUR }),
      src({ id: "c", title: "Child", open: true, updatedAt: NOON, parentConvoId: "p" }),
    ]);
    expect(shape(vm, "open")).toEqual([
      ["p", 0],
      ["c", 1],
    ]);
  });

  it("keeps every child of one parent together, in the section's own order", () => {
    const vm = build([
      src({ id: "p", open: true, updatedAt: NOON - 3 * HOUR }),
      src({ id: "c1", open: true, updatedAt: NOON - HOUR, parentConvoId: "p" }),
      src({ id: "c2", open: true, updatedAt: NOON, parentConvoId: "p" }),
      src({ id: "other", open: true, updatedAt: NOON - 2 * HOUR }),
    ]);
    // `other` is more recent than the parent, so it sorts above it; the parent
    // still carries its children with it rather than being split across it.
    expect(ids(vm, "open")).toEqual(["other", "p", "c2", "c1"]);
    expect(rows(vm, "open").map((r) => r.depth)).toEqual([0, 0, 1, 1]);
  });

  /** The invariant the whole feature hangs on: a child is never dropped and
   *  never hidden, whatever happened to its parent. */
  it("renders an orphan at top level when the parent was archived", () => {
    const vm = build([
      src({ id: "p", open: true, archived: true }),
      src({ id: "c", title: "Child", open: true, parentConvoId: "p" }),
    ]);
    expect(shape(vm, "open")).toEqual([["c", 0]]);
  });

  it("renders an orphan at top level when the parent does not exist at all", () => {
    const vm = build([src({ id: "c", open: true, parentConvoId: "gone" })]);
    expect(shape(vm, "open")).toEqual([["c", 0]]);
  });

  /**
   * Parent and child can naturally land in different sections — a parent kept
   * open sits in `open` while its finished child would otherwise fall into
   * `settled`. The child is pulled OUT of `settled` and rendered nested under
   * the parent instead, so a conversation you are working in shows its whole
   * fan-out in one place. The section it would have occupied must not even
   * appear, since relocation left it with nothing in it.
   */
  it("indents across sections: a child that would land in Settled follows its parent into Open", () => {
    const vm = build([
      src({ id: "p", title: "Parent", open: true }),
      src({ id: "c", title: "Child", open: false, parentConvoId: "p" }),
    ]);
    expect(shape(vm, "open")).toEqual([
      ["p", 0],
      ["c", 1],
    ]);
    expect(vm.sections.map((s) => s.key)).toEqual(["open"]);
  });

  it("indents inside a day bucket when parent and child share one", () => {
    const vm = byDays([
      src({ id: "p", updatedAt: NOON - HOUR }),
      src({ id: "c", updatedAt: NOON, parentConvoId: "p" }),
    ]);
    expect(dayLabels(vm)).toEqual(["Today"]);
    expect(daySections(vm)[0].items.map((r) => [r.id, r.depth])).toEqual([
      ["p", 0],
      ["c", 1],
    ]);
  });

  /**
   * A parent in one day bucket and a child in another still nest together —
   * the child is relocated into the PARENT's bucket, and a "Today" section
   * that would otherwise contain only that child must not render at all: an
   * empty header over nothing is worse than no header.
   */
  it("indents across day buckets: the child follows its parent into the parent's day", () => {
    const vm = byDays([
      src({ id: "p", updatedAt: NOON - 2 * DAY }),
      src({ id: "c", updatedAt: NOON, parentConvoId: "p" }),
    ]);
    expect(dayLabels(vm)).not.toContain("Today");
    expect(dayIds(vm)).toEqual(["p", "c"]);
    expect(daySections(vm).flatMap((s) => s.items).map((r) => r.depth)).toEqual([0, 1]);
  });

  it("caps the indent at one level: a grandchild sits beside its parent, not further right", () => {
    const vm = build([
      src({ id: "p", open: true, updatedAt: NOON - 2 * HOUR }),
      src({ id: "c", open: true, updatedAt: NOON - HOUR, parentConvoId: "p" }),
      src({ id: "g", open: true, updatedAt: NOON, parentConvoId: "c" }),
    ]);
    expect(shape(vm, "open")).toEqual([
      ["p", 0],
      ["c", 1],
      ["g", 1],
    ]);
  });

  it("leaves depth 0 on everything when nothing has a parent", () => {
    const vm = build([src({ id: "a", open: true }), src({ id: "b", open: true })]);
    expect(rows(vm, "open").every((r) => r.depth === 0)).toBe(true);
  });

  it("keeps the row count intact: grouping reorders, it never adds or drops rows", () => {
    const vm = build([
      src({ id: "p", open: true, updatedAt: NOON - HALF_HOUR }),
      src({ id: "c1", open: true, parentConvoId: "p" }),
      src({ id: "c2", open: true, parentConvoId: "p" }),
      src({ id: "loop-a", open: true, parentConvoId: "loop-b" }),
      src({ id: "loop-b", open: true, parentConvoId: "loop-a" }),
    ]);
    expect(rows(vm, "open")).toHaveLength(5);
    expect(new Set(ids(vm, "open")).size).toBe(5);
    expect(vm.matched).toBe(5);
    // A hand-edited ledger can produce a cycle: both members still render.
    expect(rows(vm, "open").filter((r) => r.id.startsWith("loop")).map((r) => r.depth)).toEqual([0, 0]);
  });

  it("indents pinned rows too, so the section is not the odd one out", () => {
    const vm = build([
      src({ id: "p", pinned: true, updatedAt: NOON - HOUR }),
      src({ id: "c", pinned: true, updatedAt: NOON, parentConvoId: "p" }),
    ]);
    expect(shape(vm, "pinned")).toEqual([
      ["p", 0],
      ["c", 1],
    ]);
  });

  it("carries parentConvoId onto the row, so the renderer and the model agree", () => {
    const vm = build([src({ id: "c", open: true, parentConvoId: "gone" })]);
    expect(rows(vm, "open")[0].parentConvoId).toBe("gone");
  });

  /**
   * The cardinal rule restated for search: a parent that the QUERY filtered
   * out is exactly as absent as one that was archived — the child it left
   * behind must still render, standalone, not vanish with it.
   */
  it("still shows a child when the search matches only the child, not the parent", () => {
    const vm = build(
      [
        src({ id: "p", title: "Parent unrelated", open: true }),
        src({ id: "c", title: "Child match", open: true, parentConvoId: "p" }),
      ],
      "match",
    );
    expect(shape(vm, "open")).toEqual([["c", 0]]);
  });

  /**
   * A grandchild's immediate parent (the child) is itself relocated into the
   * grandparent's section; the grandchild must follow it there too, not sit
   * back in whatever section it originally belonged to.
   */
  it("relocates a grandchild across sections alongside its relocated parent", () => {
    const vm = build([
      src({ id: "gp", open: true, updatedAt: NOON - 2 * HOUR }),
      src({ id: "p", open: false, updatedAt: NOON - HOUR, parentConvoId: "gp" }),
      src({ id: "g", open: false, updatedAt: NOON, parentConvoId: "p" }),
    ]);
    expect(shape(vm, "open")).toEqual([
      ["gp", 0],
      ["p", 1],
      ["g", 1],
    ]);
    expect(vm.sections.map((s) => s.key)).toEqual(["open"]);
  });

  /**
   * Mutation target: a naive implementation could push a relocated child into
   * its new home WITHOUT removing it from its natural one, or vice versa.
   * Checking every section AT ONCE is what would catch that — checking them
   * one at a time cannot tell "missing everywhere" from "present twice".
   */
  it("never duplicates a row across Open, Pinned and Settled at once", () => {
    const vm = build([
      src({ id: "p1", open: true, updatedAt: NOON - 3 * HOUR }),
      src({ id: "c1", open: false, updatedAt: NOON - 2 * HOUR, parentConvoId: "p1" }),
      src({ id: "p2", pinned: true, updatedAt: NOON - HOUR }),
      src({ id: "c2", pinned: false, updatedAt: NOON, parentConvoId: "p2" }),
      src({ id: "solo", updatedAt: NOON - 5 * HOUR }),
    ]);
    expect([...allIds(vm)].sort()).toEqual(["c1", "c2", "p1", "p2", "solo"]);
    expect(new Set(allIds(vm)).size).toBe(allIds(vm).length);
  });
});

/**
 * Liveness outranks nesting. Found in the live vault: a fan-out child blocked
 * on a permission prompt, whose parent was an old closed chat, was relocated
 * into a history bucket — a conversation waiting on the user, filed under the
 * archive. Nesting is a convenience; "this is blocked on you" is not.
 */
describe("buildChatList — liveness outranks nesting", () => {
  it("keeps a needs-input child at top level instead of filing it under a settled parent", () => {
    const vm = build([
      src({ id: "p", title: "Old parent", updatedAt: NOON - 3 * DAY }),
      src({ id: "c", title: "Blocked child", parentConvoId: "p", streaming: true, pendingPerm: true }),
    ]);
    expect(shape(vm, "needsYou")).toEqual([["c", 0]]);
    expect(rows(vm, "needsYou")[0].lane).toBe("needs-input");
    expect(ids(vm, "settled")).toEqual(["p"]);
  });

  it("keeps a running child at top level too", () => {
    const vm = build([
      src({ id: "p", title: "Old parent", updatedAt: NOON - 3 * DAY }),
      src({ id: "c", title: "Working child", parentConvoId: "p", streaming: true }),
    ]);
    expect(shape(vm, "running")).toEqual([["c", 0]]);
    expect(ids(vm, "settled")).toEqual(["p"]);
  });

  it("anchors an errored child too, so Needs you never lies about what it holds", () => {
    const vm = build([
      src({ id: "p", title: "Old parent", updatedAt: NOON - 3 * DAY }),
      src({ id: "c", title: "Failed child", parentConvoId: "p", poisoned: true }),
    ]);
    expect(shape(vm, "needsYou")).toEqual([["c", 0]]);
    expect(ids(vm, "settled")).toEqual(["p"]);
  });

  it("does not disable normal nesting: an idle child still follows its parent", () => {
    // The mutation this catches: anchoring everything, or anchoring on
    // `parentConvoId` rather than on the section, would silently flatten the tree.
    const vm = build([
      src({ id: "p", title: "Open parent", open: true }),
      src({ id: "c", title: "Idle child", parentConvoId: "p" }),
    ]);
    expect(shape(vm, "open")).toEqual([
      ["p", 0],
      ["c", 1],
    ]);
  });

  it("anchors the row's own position only — an anchored parent still carries its children", () => {
    const vm = build([
      src({ id: "p", title: "Running parent", parentConvoId: "gp", streaming: true }),
      src({ id: "gp", title: "Grandparent", updatedAt: NOON - 3 * DAY }),
      src({ id: "c", title: "Idle child", parentConvoId: "p" }),
    ]);
    expect(shape(vm, "running")).toEqual([
      ["p", 0],
      ["c", 1],
    ]);
    expect(ids(vm, "settled")).toEqual(["gp"]);
  });
});

/**
 * `related` is the semantic tier, presented as rows that do NOT contain what
 * was typed. Cross-collection relocation must not cross that line in either
 * direction: a literal match dragged into "Related" is a lie about why it is
 * on screen, and a semantic-only hit laundered into a literal section is the
 * same lie backwards.
 */
describe("buildChatList — related is not a nesting home", () => {
  const sem = (sources: ChatRowSource[], query: string, semanticIds: string[]) =>
    buildChatList(sources, { query, now: NOON, semanticIds });

  it("never relocates a literal match into Related", () => {
    const vm = sem(
      [
        src({ id: "p", title: "Alpha parent" }),
        src({ id: "c", title: "Child match", parentConvoId: "p" }),
      ],
      "match",
      ["p"],
    );
    expect(ids(vm, "related")).toEqual(["p"]);
    expect(shape(vm, "settled")).toEqual([["c", 0]]);
  });

  it("never pulls a Related row out into a literal section", () => {
    const vm = sem(
      [
        src({ id: "p", title: "Parent match" }),
        src({ id: "c", title: "Zeta", parentConvoId: "p" }),
      ],
      "match",
      ["c"],
    );
    expect(ids(vm, "settled")).toEqual(["p"]);
    expect(shape(vm, "related")).toEqual([["c", 0]]);
  });

  it("still nests inside Related when parent and child are both semantic-only", () => {
    const vm = sem(
      [
        src({ id: "p", title: "Alpha", updatedAt: NOON - HOUR }),
        src({ id: "c", title: "Beta", parentConvoId: "p", updatedAt: NOON }),
      ],
      "zzz",
      ["p", "c"],
    );
    expect(shape(vm, "related")).toEqual([
      ["p", 0],
      ["c", 1],
    ]);
  });

  it("never duplicates a row across the literal sections and Related", () => {
    const vm = sem(
      [
        src({ id: "p", title: "Parent match", open: true }),
        src({ id: "c", title: "Zeta", parentConvoId: "p" }),
        src({ id: "s", title: "Eta" }),
      ],
      "match",
      ["c", "s"],
    );
    expect([...allIds(vm)].sort()).toEqual(["c", "p", "s"]);
    expect(new Set(allIds(vm)).size).toBe(allIds(vm).length);
  });
});
