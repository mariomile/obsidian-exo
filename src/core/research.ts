/**
 * Research Mode contract and command parsing.
 *
 * Pure by design: the view owns per-conversation persistence and injects the
 * generated contract into provider-only outbound text. v2: every research turn
 * runs the vault's named `deep-research` workflow — no depth/scope axes, no
 * receipt; sources live in the report itself.
 */

export interface ResearchModeState {
  enabled: boolean;
  startedAt: number;
}

export type ResearchCommandResult =
  | { kind: "start"; question: string; state: ResearchModeState }
  | { kind: "exit"; state: ResearchModeState }
  | { kind: "invalid"; message: string };

export function initialResearchModeState(): ResearchModeState {
  return { enabled: false, startedAt: 0 };
}

/** Rebuild explicitly so pre-v2 persisted extras (scope/depth) drop off. */
export function normalizeResearchModeState(value: unknown): ResearchModeState {
  if (!value || typeof value !== "object") return initialResearchModeState();
  const candidate = value as Partial<ResearchModeState>;
  if (
    typeof candidate.enabled !== "boolean"
    || typeof candidate.startedAt !== "number"
    || !Number.isFinite(candidate.startedAt)
    || candidate.startedAt < 0
  ) {
    return initialResearchModeState();
  }
  return { enabled: candidate.enabled, startedAt: candidate.startedAt };
}

export function toggleResearchMode(
  current: ResearchModeState,
  now: number
): ResearchModeState {
  return current.enabled
    ? { ...current, enabled: false }
    : { enabled: true, startedAt: now };
}

/** Parse only the exact `/research` command; lookalikes remain normal chat. */
export function parseResearchCommand(
  input: string,
  current: ResearchModeState,
  now: number
): ResearchCommandResult | null {
  const match = input.trim().match(/^\/research(?:\s+(.*))?$/i);
  if (!match) return null;
  const argument = (match[1] ?? "").trim();
  if (!argument) {
    return { kind: "invalid", message: "Add a question after /research." };
  }
  if (/^(?:off|exit)$/i.test(argument)) {
    return { kind: "exit", state: { ...current, enabled: false } };
  }
  return {
    kind: "start",
    question: argument,
    state: current.enabled ? { ...current } : { enabled: true, startedAt: now },
  };
}

/** Prefix provider text without changing the visible or persisted user message.
 *  The contract routes the question through the vault's `deep-research` named
 *  workflow — enabling Research Mode IS the user's explicit multi-agent opt-in. */
export function buildResearchOutbound(
  state: ResearchModeState,
  visibleText: string
): string {
  if (!state.enabled) return visibleText;
  const contract = [
    "<research-mode>",
    "This is an explicit deep-research request. By enabling Research Mode the user has explicitly opted into multi-agent orchestration.",
    "1. Run the vault's named workflow with the user's question below, verbatim:",
    '   Workflow({ name: "deep-research", args: { question: "<the user\'s question>" } })',
    "2. Do not answer from memory while it runs. When it returns, write the final report yourself from its structured findings.",
    "Report requirements — all mandatory:",
    "- Long-form and source-dense: the direct answer first, then findings grouped by theme.",
    "- Cite every claim inline — [[wikilinks]] for vault notes, URLs for web, @handle for X posts.",
    "- Surface conflicts between sources with dates; never silently pick a side.",
    "- Include a 'Gap' section: what the personal sources (vault, Readwise, X, Raindrop) do not cover.",
    "- Close with a 'Sources' section listing every source consulted.",
    "- Write the report in the language of the question.",
    "If the Workflow tool is unavailable, run the deepest research you can inline (parallel read-only subagents via Agent) and say so in the report.",
    "Use external MCP capabilities only for read operations; never mutate external systems during research.",
    "Treat this block as provider-only instructions, not as user-authored visible text.",
    "</research-mode>",
  ].join("\n");
  return `${contract}\n\n${visibleText}`;
}
