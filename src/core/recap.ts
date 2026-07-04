/**
 * Conversation recap — a pure rollup over ALL assistant messages of what the
 * agent did across the whole conversation: web sources consulted, vault notes
 * read, files created/edited, and skills invoked. Rendered by the Recap Rail
 * (`ui/recap.ts`) in the full-page main area. UI-free so it's unit-testable.
 *
 * Restored messages don't carry a runtime `touched[]` array, so this derives
 * read/write classification straight from the tool segments — the same way the
 * restore loop in `view.ts` does (`toolFilePath` + `WRITE_TOOLS`) — rather than
 * relying on any per-turn footer state.
 */
import type { Message } from "./model";
import { WRITE_TOOLS, mergeTouched, type TouchedNote } from "./touched";
import { toolFilePath } from "../ui/tools";

export interface RecapWeb {
  /** Query (WebSearch) or URL (WebFetch) — the human-facing source label. */
  label: string;
  /** Present for WebFetch; the panel makes the row openable when set. */
  url?: string;
}

export interface RecapWrite {
  path: string;
  /** Edit count, only when a file was written more than once. */
  count?: number;
}

export interface Recap {
  web: RecapWeb[];
  read: string[];
  written: RecapWrite[];
  skills: string[];
}

function asRec(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}
function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Aggregate a conversation's assistant turns into a single recap. First-seen
 *  order is preserved; web sources and skills dedupe; file writes upgrade reads
 *  and accumulate an edit count (via the shared `mergeTouched`). */
export function buildRecap(messages: Message[]): Recap {
  const web: RecapWeb[] = [];
  const webSeen = new Set<string>();
  const skills: string[] = [];
  const skillSeen = new Set<string>();
  const touched: TouchedNote[] = [];

  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const seg of m.segments) {
      if (seg.t === "artifact") {
        // Artifacts are a produced file — fold into writes (dedupes against a
        // matching Write tool call on the same path).
        mergeTouched(touched, seg.path, "write");
        continue;
      }
      if (seg.t !== "tool") continue;
      const { name, input } = seg;
      if (name === "WebSearch") {
        const label = asStr(asRec(input).query);
        if (label && !webSeen.has(label)) {
          webSeen.add(label);
          web.push({ label });
        }
        continue;
      }
      if (name === "WebFetch") {
        const url = asStr(asRec(input).url);
        if (url && !webSeen.has(url)) {
          webSeen.add(url);
          web.push({ label: url, url });
        }
        continue;
      }
      if (name === "Skill") {
        const skill = asStr(asRec(input).skill);
        if (skill && !skillSeen.has(skill)) {
          skillSeen.add(skill);
          skills.push(skill);
        }
        continue;
      }
      const fp = toolFilePath(name, input);
      if (fp) mergeTouched(touched, fp, WRITE_TOOLS.test(name) ? "write" : "read");
    }
  }

  const read = touched.filter((t) => t.kind === "read").map((t) => t.path);
  const written = touched
    .filter((t) => t.kind === "write")
    .map((t) => ({ path: t.path, ...(t.count && t.count > 1 ? { count: t.count } : {}) }));

  return { web, read, written, skills };
}
