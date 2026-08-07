import { describe, it, expect } from "vitest";
import { buildChatList, relativeTime, type ChatRowSource } from "../src/core/chat-rows";

const NOON = new Date(2026, 7, 7, 12, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A quiet, idle, non-archived conversation with one message. Every test
 *  overrides only the fields it is actually about. */
const src = (over: Partial<ChatRowSource> = {}): ChatRowSource => ({
  id: "c1",
  title: "Untitled",
  preview: "",
  provider: "claude",
  model: "opus",
  updatedAt: NOON,
  archived: false,
  open: false,
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

describe("buildChatList — tiering", () => {
  it("puts a streaming conversation in the live tier, not the history tier", () => {
    const vm = build([src({ id: "a", streaming: true })]);
    expect(vm.live.map((r) => r.id)).toEqual(["a"]);
    expect(vm.groups).toEqual([]);
  });

  it("puts an idle conversation in the history tier, not the live tier", () => {
    const vm = build([src({ id: "a" })]);
    expect(vm.live).toEqual([]);
    expect(vm.groups.flatMap((g) => g.items.map((r) => r.id))).toEqual(["a"]);
  });

  it("never lists the same conversation in both tiers", () => {
    const vm = build([src({ id: "a", streaming: true }), src({ id: "b" })]);
    const liveIds = vm.live.map((r) => r.id);
    const histIds = vm.groups.flatMap((g) => g.items.map((r) => r.id));
    expect(liveIds).toEqual(["a"]);
    expect(histIds).toEqual(["b"]);
  });

  it("labels a permission-blocked conversation needs-input, NOT running, even though it is still streaming", () => {
    // The whole point of the live tier: a blocked turn has streaming:true
    // because its finally has not run. Reading streaming first would say
    // "working" about something that is waiting for the user.
    const vm = build([src({ id: "a", streaming: true, pendingPerm: true })]);
    expect(vm.live[0].lane).toBe("needs-input");
    expect(vm.live[0].reason).toBe("perm");
  });

  it("distinguishes an ask-blocked conversation from a permission-blocked one", () => {
    const vm = build([src({ id: "a", streaming: true, pendingAsk: true })]);
    expect(vm.live[0].lane).toBe("needs-input");
    expect(vm.live[0].reason).toBe("ask");
  });

  it("sorts needs-input ahead of running in the live tier", () => {
    const vm = build([
      src({ id: "running", streaming: true }),
      src({ id: "blocked", streaming: true, pendingAsk: true }),
    ]);
    expect(vm.live.map((r) => r.id)).toEqual(["blocked", "running"]);
  });

  it("sorts the live tier by recency within the same lane", () => {
    const vm = build([
      src({ id: "old", streaming: true, updatedAt: NOON - 2 * HOUR }),
      src({ id: "new", streaming: true, updatedAt: NOON }),
    ]);
    expect(vm.live.map((r) => r.id)).toEqual(["new", "old"]);
  });
});

describe("buildChatList — exclusions", () => {
  it("drops archived conversations from both tiers", () => {
    const vm = build([src({ id: "a", archived: true })]);
    expect(vm.live).toEqual([]);
    expect(vm.groups).toEqual([]);
    expect(vm.total).toBe(0);
  });

  it("drops an archived conversation even while it is streaming", () => {
    const vm = build([src({ id: "a", archived: true, streaming: true })]);
    expect(vm.live).toEqual([]);
  });

  it("drops empty New chat husks", () => {
    const vm = build([src({ id: "a", hasMessages: false })]);
    expect(vm.live).toEqual([]);
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
});

describe("buildChatList — search", () => {
  it("matches on title, case-insensitively", () => {
    const vm = build([src({ id: "a", title: "Drag and Drop" }), src({ id: "b", title: "Other" })], "DRAG");
    expect(vm.groups.flatMap((g) => g.items.map((r) => r.id))).toEqual(["a"]);
  });

  it("matches on preview as well as title", () => {
    const vm = build([src({ id: "a", title: "Untitled", preview: "fix the gutter" })], "gutter");
    expect(vm.matched).toBe(1);
  });

  it("treats a whitespace-only query as no query", () => {
    const vm = build([src({ id: "a" }), src({ id: "b" })], "   ");
    expect(vm.matched).toBe(2);
  });

  it("filters the live tier too, not only history", () => {
    const vm = build([src({ id: "a", title: "keep", streaming: true }), src({ id: "b", title: "drop", streaming: true })], "keep");
    expect(vm.live.map((r) => r.id)).toEqual(["a"]);
  });

  it("reports total and matched separately so the view can tell 'no chats' from 'no matches'", () => {
    const vm = build([src({ id: "a", title: "alpha" }), src({ id: "b", title: "beta" })], "zzz");
    expect(vm.total).toBe(2);
    expect(vm.matched).toBe(0);
    expect(vm.live).toEqual([]);
    expect(vm.groups).toEqual([]);
  });
});

describe("buildChatList — grouping", () => {
  it("buckets by calendar day, not by rolling 24 hours", () => {
    // 23:00 yesterday is "Yesterday" read at noon today, even though it is
    // only 13 hours ago.
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
