import { describe, it, expect } from "vitest";
import { selectRecall, DEFAULT_RECALL_OPTS, type MemoryEntry } from "../src/core/memory-store";
import { RECALLED_MEMORY_OPEN, RECALLED_MEMORY_CLOSE } from "../src/core/observer";

/**
 * Guards the send-path seam in `view.ts`:
 *   outbound = [sendPrefix, recallBlock, message].filter(Boolean).join("\n\n")
 * where `recallBlock` is `formatRecallBlock(selectRecall(...))` or "" when the
 * flag is off / nothing is selected. These pure assertions pin the two contracts
 * the impure glue relies on: (1) flag-off → outbound is byte-identical to the bare
 * message; (2) the block the view formats matches the delimiters the observer
 * guard strips (no fence drift between writer and reader).
 */

const T = Date.UTC(2026, 6, 3, 12, 0, 0);
const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: `mem-${T}`,
  kind: "fact",
  at: T,
  session: "s",
  tags: [],
  source: "user",
  text: "verbatim",
  ...over,
});

/** Mirror of view.ts `formatRecallBlock` (kept in sync via the shared delimiters). */
function formatRecallBlock(entries: MemoryEntry[]): string {
  const lines = entries.map((e) => {
    const date = new Date(e.at).toISOString().slice(0, 10);
    return `- (${e.kind}, ${date}) ${e.text.replace(/\s+/g, " ").trim()}`;
  });
  return `${RECALLED_MEMORY_OPEN}\n${lines.join("\n")}\n${RECALLED_MEMORY_CLOSE}`;
}

/** Mirror of view.ts outbound construction. */
function outbound(sendPrefix: string | undefined, recalled: MemoryEntry[], message: string): string {
  const block = recalled.length ? formatRecallBlock(recalled) : "";
  return [sendPrefix, block, message].filter(Boolean).join("\n\n");
}

describe("send-path seam", () => {
  const message = "Context notes:\n- Foo\n\nwhat should I ship next";

  it("no recall + no recap → outbound is byte-identical to the message", () => {
    expect(outbound(undefined, [], message)).toBe(message);
  });

  it("recall selecting nothing (flag-off equivalent) → outbound unchanged", () => {
    // A single-word message never clears the minQueryWords guard → [].
    const recalled = selectRecall([entry()], "hi", new Set(), DEFAULT_RECALL_OPTS);
    expect(recalled).toEqual([]);
    expect(outbound(undefined, recalled, message)).toBe(message);
  });

  it("recall present → block precedes the message and is fenced with the shared delimiters", () => {
    const e = entry({ kind: "decision", text: "we chose proactive recall" });
    const out = outbound(undefined, [e], message);
    expect(out.startsWith(RECALLED_MEMORY_OPEN)).toBe(true);
    expect(out).toContain(RECALLED_MEMORY_CLOSE);
    expect(out.endsWith(message)).toBe(true);
    expect(out).toContain("- (decision, 2026-07-03) we chose proactive recall");
  });

  it("recap + recall compose in order: recap → recalled memory → message", () => {
    const out = outbound("RECAP-TEXT", [entry()], message);
    expect(out.indexOf("RECAP-TEXT")).toBeLessThan(out.indexOf(RECALLED_MEMORY_OPEN));
    expect(out.indexOf(RECALLED_MEMORY_OPEN)).toBeLessThan(out.indexOf(message));
  });
});
