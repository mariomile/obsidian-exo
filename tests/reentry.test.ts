import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REENTRY_SLOTS,
  advanceReadIndex,
  clampReadIndex,
  hasReentryNews,
  reentryLine,
  reentrySlots,
  resumeVerbs,
  shouldRenderReentry,
  workSince,
  type ResumeState,
} from "../src/core/reentry";
import type { Message } from "../src/core/model";

/**
 * Phase 6 — the re-entry system. Three behaviours are under test here: the
 * read-position lifecycle (the one new persisted fact), what the fixed-slot
 * line says, and the verbs offered above an empty composer.
 */

const user = (text: string): Message => ({ role: "user", text });
const tool = (name: string, input: unknown): Message => ({
  role: "assistant",
  segments: [{ t: "tool", name, input, ok: true, output: "" }],
});
const answered = (): Message => ({
  role: "assistant",
  segments: [{ t: "ask", questions: [], answers: { q: "yes" } }],
});
const unanswered = (): Message => ({
  role: "assistant",
  segments: [{ t: "ask", questions: [], answers: {} }],
});

describe("the read position", () => {
  it("advances to the whole transcript once read", () => {
    expect(advanceReadIndex(0)).toBe(0);
    expect(advanceReadIndex(7)).toBe(7);
  });

  it("reads an absent position as never-read", () => {
    // Every conversation that existed before this phase has no stored value,
    // and none of them may claim to have been read.
    expect(clampReadIndex(undefined, 5)).toBe(0);
    expect(clampReadIndex(Number.NaN, 5)).toBe(0);
  });

  it("clamps a stored position to a transcript that shrank (a rewind)", () => {
    expect(clampReadIndex(9, 4)).toBe(4);
    expect(clampReadIndex(-3, 4)).toBe(0);
    expect(clampReadIndex(2, 4)).toBe(2);
  });

  it("reports nothing once the position has caught up — the line cannot return", () => {
    const messages = [user("a"), tool("Write", { file_path: "/v/a.md" })];
    const first = workSince(messages, 1);
    expect(hasReentryNews(first)).toBe(true);
    // Reading advances the position; the same position asked again is empty.
    const after = workSince(messages, advanceReadIndex(messages.length));
    expect(hasReentryNews(after)).toBe(false);
    expect(after).toEqual({ steps: 0, files: 0, questions: 0, paths: [] });
  });
});

describe("what the unread stretch contains", () => {
  const messages: Message[] = [
    user("go"),
    tool("Read", { file_path: "/v/seen.md" }),
    user("carry on"),
    tool("Write", { file_path: "/v/a.md" }),
    tool("Edit", { file_path: "/v/a.md" }),
    tool("Bash", { command: "ls" }),
    tool("Write", { file_path: "/v/b.md" }),
    unanswered(),
  ];

  it("counts only what happened after the read position", () => {
    const work = workSince(messages, 2);
    expect(work.steps).toBe(4); // the four tool calls after the position, none before
    expect(work.files).toBe(2); // a.md written twice counts once, b.md once
    expect(work.questions).toBe(1);
    expect(work.paths).toEqual(["/v/a.md", "/v/b.md"]);
  });

  it("counts reads as steps but never as files changed", () => {
    const work = workSince([user("x"), tool("Read", { file_path: "/v/n.md" })], 1);
    expect(work.steps).toBe(1);
    expect(work.files).toBe(0);
  });

  it("counts an answered ask as settled, an unanswered one as waiting", () => {
    expect(workSince([user("x"), answered()], 1).questions).toBe(0);
    expect(workSince([user("x"), unanswered()], 1).questions).toBe(1);
  });

  it("counts an unapproved plan as a question waiting", () => {
    const plan: Message = {
      role: "assistant",
      segments: [{ t: "plan", md: "do this", approved: null }],
    };
    expect(workSince([user("x"), plan], 1).questions).toBe(1);
  });
});

describe("the fixed-slot line", () => {
  it("keeps the three slots in one order, populated or not", () => {
    expect([...REENTRY_SLOTS]).toEqual(["steps", "files", "questions"]);
    const slots = reentrySlots({ steps: 0, files: 3, questions: 0, paths: ["a", "b", "c"] });
    expect(slots.map((s) => s.key)).toEqual(["steps", "files", "questions"]);
    expect(slots.map((s) => s.populated)).toEqual([false, true, false]);
  });

  it("says what the plan says it says", () => {
    const line = reentryLine({ steps: 12, files: 3, questions: 1, paths: ["a", "b", "c"] });
    expect(line).toBe("since you left · 12 steps · 3 files changed · 1 question waiting");
  });

  it("singularizes each slot on its own", () => {
    const line = reentryLine({ steps: 1, files: 1, questions: 2, paths: ["a"] });
    expect(line).toBe("since you left · 1 step · 1 file changed · 2 questions waiting");
  });

  it("omits an empty slot from the text and says nothing at all when empty", () => {
    expect(reentryLine({ steps: 4, files: 0, questions: 0, paths: [] })).toBe(
      "since you left · 4 steps",
    );
    expect(reentryLine({ steps: 0, files: 0, questions: 0, paths: [] })).toBe("");
  });
});

describe("when the band may appear", () => {
  const work = { steps: 4, files: 1, questions: 0, paths: ["a.md"] };

  it("appears when a chat worked without you", () => {
    expect(shouldRenderReentry({ streaming: false, readIndex: 2, total: 6, work })).toBe(true);
  });

  it("never appears during a stream — the invariant allows one live surface", () => {
    expect(shouldRenderReentry({ streaming: true, readIndex: 2, total: 6, work })).toBe(false);
  });

  it("never appears on a chat you have never opened", () => {
    expect(shouldRenderReentry({ streaming: false, readIndex: 0, total: 6, work })).toBe(false);
  });

  it("never appears when the position has already caught up", () => {
    expect(shouldRenderReentry({ streaming: false, readIndex: 6, total: 6, work })).toBe(false);
  });

  it("never appears over an unread stretch that did no work", () => {
    const none = { steps: 0, files: 0, questions: 0, paths: [] };
    expect(shouldRenderReentry({ streaming: false, readIndex: 2, total: 6, work: none })).toBe(
      false,
    );
  });
});

describe("resume verbs", () => {
  const state = (over: Partial<ResumeState> = {}): ResumeState => ({
    streaming: false,
    pendingPerm: false,
    pendingAsk: false,
    stopped: false,
    poisoned: false,
    hasMessages: true,
    draftEmpty: true,
    ...over,
  });

  it("offers Resume and Course-correct on a settled chat", () => {
    expect(resumeVerbs(state()).map((v) => v.label)).toEqual(["Resume", "Course-correct"]);
  });

  it("offers Approve, and only Approve, when a permission is waiting", () => {
    const verbs = resumeVerbs(state({ pendingPerm: true, streaming: true }));
    expect(verbs.map((v) => v.key)).toEqual(["approve"]);
    // Approve is a verdict, not a message: it seeds no composer text.
    expect(verbs[0].prompt).toBeUndefined();
  });

  it("offers nothing while a turn is streaming", () => {
    expect(resumeVerbs(state({ streaming: true }))).toEqual([]);
  });

  it("offers nothing while a question card is open — the card is the surface", () => {
    expect(resumeVerbs(state({ pendingAsk: true, streaming: true }))).toEqual([]);
  });

  it("offers nothing on an empty new chat", () => {
    expect(resumeVerbs(state({ hasMessages: false }))).toEqual([]);
  });

  it("stands down as soon as the user writes their own message", () => {
    expect(resumeVerbs(state({ draftEmpty: false }))).toEqual([]);
  });

  it("words Resume differently after a stop or an error", () => {
    const settled = resumeVerbs(state())[0].prompt;
    const stopped = resumeVerbs(state({ stopped: true }))[0].prompt;
    const errored = resumeVerbs(state({ poisoned: true }))[0].prompt;
    expect(stopped).not.toBe(settled);
    expect(errored).toBe(stopped);
  });

  it("every message verb seeds the composer with something", () => {
    for (const v of resumeVerbs(state())) expect(v.prompt).toBeTruthy();
  });
});

/* ---------------------------------------------------------------------------
 * The wiring, read off the source. The band is DOM, and this suite runs in
 * `node` — so what is pinned here is the set of decisions that would otherwise
 * only be visible by mounting Obsidian.
 * ------------------------------------------------------------------------ */

const read = (rel: string): string => readFileSync(join(__dirname, "..", rel), "utf8");

describe("the re-entry band's wiring", () => {
  const ui = read("src/ui/reentry.ts");
  const view = read("src/view.ts");

  it("is not gated on pane width, unlike the Recap Rail", () => {
    // The rail is main-area-and-wide only (`view.ts` isWide → clientWidth > 900).
    // The re-entry line is the sidebar's too: a sidebar user comes back to a
    // chat exactly as often, and the line is the thing that tells them what
    // happened.
    expect(ui).not.toMatch(/900/);
    expect(ui).not.toMatch(/isWide|clientWidth|matchMedia/);
  });

  it("renders at the last-read position, not at the top or the bottom", () => {
    expect(ui).toMatch(/insertBefore/);
    expect(ui).toMatch(/\.mva-turn/);
  });

  it("refuses to paint while a turn is streaming", () => {
    expect(ui).toMatch(/streaming/);
  });

  it("is reached from the conversation-reveal path", () => {
    expect(view).toMatch(/revealReentry\(/);
    expect(view).toMatch(/renderResumeVerbs\(/);
  });

  it("persists the read position with the conversation", () => {
    // Both directions: written to disk in `toConvoData`, read back in `restore`.
    expect(view).toMatch(/readIndex/);
    expect(read("src/ui/convo-types.ts")).toMatch(/readIndex\?: number/);
  });
});
