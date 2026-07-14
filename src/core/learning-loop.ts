/**
 * Learning loop (pure): after a successful, substantial turn, Exo offers to
 * save the flow as a reusable playbook (Hermes pattern — from "remembering"
 * to "learning how to do"). The proposal card is free (no tokens); the LLM
 * distillation runs only when the user accepts.
 *
 * This module owns the three testable decisions: does a turn qualify, what
 * does the distillation pass get asked, and how is its reply parsed.
 */

export interface TurnStats {
  /** Turn finished healthy (not stopped, not poisoned by an execution error). */
  ok: boolean;
  toolCount: number;
  distinctTools: number;
  durationMs: number;
  userText: string;
}

/** A turn is worth proposing when it was real work (several tool calls across
 *  more than one tool, long enough to not be a one-shot lookup) and the user
 *  wasn't already running a command/playbook. Thresholds are deliberately
 *  conservative — a noisy nudge would get the feature turned off. */
export function turnQualifies(s: TurnStats): boolean {
  if (!s.ok) return false;
  if (s.userText.trim().startsWith("/")) return false; // already a command/playbook
  return s.toolCount >= 5 && s.distinctTools >= 2 && s.durationMs >= 30_000;
}

export interface DistillInput {
  userText: string;
  /** One line per tool call, e.g. "search_vault: Captoo GTM" (capped by caller). */
  toolLines: string[];
  /** The turn's final assistant text (capped by caller). */
  finalText: string;
}

/** The utility-pass prompt: strict JSON out, so parsing is mechanical. */
export function buildDistillPrompt(input: DistillInput): string {
  return `You are distilling a completed AI-agent task into a REUSABLE playbook prompt.

The user asked:
"""
${input.userText.slice(0, 1200)}
"""

The agent's tool calls (in order):
${input.toolLines.join("\n")}

The agent's final answer began:
"""
${input.finalText.slice(0, 1200)}
"""

Write a reusable playbook that would reproduce this KIND of task on future inputs — generalize away the specifics of this one run (names, dates, single files) but keep the method: which sources to consult, in what order, what to produce. Use {{placeholders}} only if the task genuinely needs a variable input. Write the prompt in the same language as the user's request.

Reply with ONLY a JSON object, no markdown fences, exactly:
{"name": "<3-5 word title>", "prompt": "<the reusable playbook prompt, 3-10 sentences>"}`;
}

/** Tolerant parse of the distillation reply: find the JSON object, validate
 *  shapes and sane lengths. Null on anything off — the caller shows a soft
 *  failure, never a broken playbook. */
export function parseDistillReply(raw: string): { name: string; prompt: string } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const { name, prompt } = obj as { name?: unknown; prompt?: unknown };
  if (typeof name !== "string" || typeof prompt !== "string") return null;
  const cleanName = name.trim().slice(0, 60);
  const cleanPrompt = prompt.trim();
  if (!cleanName || cleanPrompt.length < 30 || cleanPrompt.length > 4000) return null;
  return { name: cleanName, prompt: cleanPrompt };
}

/** Dedup a proposed name against existing playbooks: "Name", "Name 2", "Name 3"… */
export function uniquePlaybookName(name: string, existing: string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
