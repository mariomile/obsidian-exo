/**
 * Persisted conversation data model — the pure, UI-free types shared between
 * `view.ts` and the extracted `core/` logic modules. Moved out of `view.ts`
 * verbatim so the pure logic (recovery recap, persistence planning) can be
 * unit-tested without importing `obsidian`.
 */

export interface AskQuestion {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export type Segment =
  | { t: "text"; md: string }
  | { t: "tool"; name: string; input: unknown; ok: boolean | null; output: string }
  | { t: "ask"; questions: AskQuestion[]; answers: Record<string, string> }
  | { t: "artifact"; path: string };

/** Per-turn file snapshot for code rewind: path → content before the turn (null = didn't exist). */
export type Checkpoint = Map<string, string | null>;

export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; segments: Segment[]; checkpoint?: Checkpoint };

/** On-disk form of a message: the checkpoint Map is stored as [path, content] entries. */
export type PersistedMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; segments: Segment[]; checkpoint?: [string, string | null][] };
