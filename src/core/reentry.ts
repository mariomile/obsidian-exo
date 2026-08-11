/**
 * Re-entry — the pure model behind "coming back to a chat is a designed
 * moment". Two things live here and nothing else: what a conversation did
 * WHILE YOU WERE NOT READING IT, and which verb should be on offer above an
 * empty composer given the state you are coming back to.
 *
 * The read position is the one new persisted fact in this phase, and it is
 * deliberately an INDEX, not a timestamp: the band has to be rendered AT a
 * position in the transcript, and a transcript is a list of messages, not a
 * clock. `readIndex` counts messages the user has already seen, so it is also
 * the DOM index of the first unread turn — one number that answers both "what
 * is new" and "where does the line go".
 *
 * Everything here is Obsidian-free and DOM-free, same discipline as
 * `chat-rows.ts`: this decides what the line SAYS and whether it may appear,
 * `ui/reentry.ts` owns the elements and the click targets.
 */
import type { Message } from "./model";
import { fileEditKey } from "./steps";

/**
 * The three slots of the "since you left" line, in the ONE order they are ever
 * painted in. Fixed by position is the whole design: the line is read at a
 * glance on re-entry, and a line whose second number means "files" on Monday
 * and "questions" on Tuesday has to be read word by word instead.
 */
export const REENTRY_SLOTS = ["steps", "files", "questions"] as const;

export type ReentrySlotKey = (typeof REENTRY_SLOTS)[number];

/** What the unread stretch of a conversation contains. */
export interface ReentryWork {
  /** Tool calls in the unread assistant turns — the "12 steps" number. */
  steps: number;
  /** Distinct files the unread stretch WROTE (via `fileEditKey`, the same
   *  write-classification the steps header counts with). */
  files: number;
  /** Answers still owed: an `ask` card nobody answered and a plan nobody
   *  approved both count — each is a turn that cannot continue without you. */
  questions: number;
  /** The written paths, first-seen order. The files slot's click target: a
   *  number you cannot open is a number you have to go looking for. */
  paths: string[];
}

/** One painted slot. `count === 0` slots are still returned — they hold their
 *  position — but they are not populated, so they are not clickable. */
export interface ReentrySlot {
  key: ReentrySlotKey;
  count: number;
  /** "12 steps" / "3 files changed" / "1 question waiting". */
  label: string;
  populated: boolean;
}

const EMPTY_WORK: ReentryWork = { steps: 0, files: 0, questions: 0, paths: [] };

/**
 * What happened in `messages` after the first `readIndex` of them. A
 * `readIndex` past the end (a conversation that was rewound since it was last
 * read) reports nothing rather than counting backwards.
 */
export function workSince(messages: readonly Message[], readIndex: number): ReentryWork {
  const from = Math.max(0, Math.min(readIndex, messages.length));
  if (from >= messages.length) return { ...EMPTY_WORK };
  let steps = 0;
  let questions = 0;
  const paths: string[] = [];
  for (const m of messages.slice(from)) {
    if (m.role !== "assistant") continue;
    for (const seg of m.segments) {
      if (seg.t === "tool") {
        steps++;
        const key = fileEditKey(seg.name, seg.input);
        if (key && !paths.includes(key)) paths.push(key);
      } else if (seg.t === "ask") {
        if (Object.keys(seg.answers ?? {}).length === 0) questions++;
      } else if (seg.t === "plan") {
        if (seg.approved === null) questions++;
      }
    }
  }
  return { steps, files: paths.length, questions, paths };
}

/** Is there anything to report at all? An unread stretch of pure prose — the
 *  agent answered and did no work — is news the transcript already carries. */
export function hasReentryNews(work: ReentryWork): boolean {
  return work.steps > 0 || work.files > 0 || work.questions > 0;
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The three slots, always three, always in `REENTRY_SLOTS` order. */
export function reentrySlots(work: ReentryWork): ReentrySlot[] {
  const counts: Record<ReentrySlotKey, number> = {
    steps: work.steps,
    files: work.files,
    questions: work.questions,
  };
  const labels: Record<ReentrySlotKey, string> = {
    steps: plural(work.steps, "step"),
    files: `${plural(work.files, "file")} changed`,
    questions: `${plural(work.questions, "question")} waiting`,
  };
  return REENTRY_SLOTS.map((key) => ({
    key,
    count: counts[key],
    label: labels[key],
    populated: counts[key] > 0,
  }));
}

/** The whole line as one string: "since you left · 12 steps · 3 files changed
 *  · 1 question waiting". Empty slots are omitted from the TEXT (they still
 *  hold their position in the rendered row — see `reentrySlots`). */
export function reentryLine(work: ReentryWork): string {
  const parts = reentrySlots(work)
    .filter((s) => s.populated)
    .map((s) => s.label);
  return parts.length ? ["since you left", ...parts].join(" · ") : "";
}

/**
 * May the band be rendered right now?
 *
 *  - Never while a turn is streaming. THE STREAMING INVARIANT: exactly one of
 *    {working row, open card, caret} is the live surface, and a band that
 *    appeared mid-stream would be a second one.
 *  - Never at position 0. A chat you have never opened has no "since you left"
 *    — there is no left to be since, and the band would sit above the first
 *    message describing the whole conversation.
 *  - Never when there is nothing to report.
 */
export function shouldRenderReentry(o: {
  streaming: boolean;
  readIndex: number;
  total: number;
  work: ReentryWork;
}): boolean {
  if (o.streaming) return false;
  if (o.readIndex <= 0 || o.readIndex >= o.total) return false;
  return hasReentryNews(o.work);
}

/** The read position after a read: everything currently in the transcript.
 *  Advancing is what makes the band dissolve and never come back for the same
 *  position — the next reveal computes its work over an empty stretch. */
export function advanceReadIndex(total: number): number {
  return Math.max(0, total);
}

/** A stored read position, clamped to a transcript that may have shrunk (a
 *  rewind) or grown since it was written. */
export function clampReadIndex(stored: number | undefined, total: number): number {
  if (typeof stored !== "number" || !Number.isFinite(stored)) return 0;
  return Math.max(0, Math.min(Math.floor(stored), total));
}

/* -------------------------- resume verbs ---------------------------- */

export type ResumeVerbKey = "resume" | "course-correct" | "approve";

export interface ResumeVerb {
  key: ResumeVerbKey;
  label: string;
  /** Text to seed the composer with. Absent on `approve`, which is not a
   *  message: it settles the open permission prompt directly. */
  prompt?: string;
}

/** The state a conversation is being re-entered in. */
export interface ResumeState {
  streaming: boolean;
  pendingPerm: boolean;
  pendingAsk: boolean;
  stopped: boolean;
  poisoned: boolean;
  hasMessages: boolean;
  /** The composer is empty. The verbs are a fast path INTO the composer, so
   *  they stand down the moment the user starts writing their own. */
  draftEmpty: boolean;
}

const RESUME: ResumeVerb = {
  key: "resume",
  label: "Resume",
  prompt: "Continue from where we left off.",
};
const RESUME_AFTER_STOP: ResumeVerb = {
  key: "resume",
  label: "Resume",
  prompt: "Pick this back up and continue.",
};
const COURSE_CORRECT: ResumeVerb = {
  key: "course-correct",
  label: "Course-correct",
  prompt: "Change of direction: ",
};
const APPROVE: ResumeVerb = { key: "approve", label: "Approve" };

/**
 * Which verbs to offer, contextual to the state:
 *
 *  - blocked on a permission → Approve, and nothing else. The chat cannot
 *    move on a message; it moves on a verdict.
 *  - streaming, or blocked on a question → nothing. The live surface is the
 *    card or the caret, and a verb bar under it would be a second one.
 *  - stopped or errored → Resume (worded as picking it back up) +
 *    Course-correct.
 *  - settled with a history → Resume + Course-correct.
 *  - a brand-new empty chat → nothing. There is nothing to resume.
 */
export function resumeVerbs(s: ResumeState): ResumeVerb[] {
  if (!s.draftEmpty) return [];
  if (s.pendingPerm) return [APPROVE];
  if (s.streaming || s.pendingAsk) return [];
  if (!s.hasMessages) return [];
  return [s.stopped || s.poisoned ? RESUME_AFTER_STOP : RESUME, COURSE_CORRECT];
}
