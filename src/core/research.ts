/**
 * Research Mode contract and command parsing.
 *
 * Pure by design: the view owns per-conversation persistence and injects the
 * generated contract into provider-only outbound text.
 */

export type ResearchScope = "vault" | "web" | "both";
export type ResearchDepth = "quick" | "standard" | "deep";

export interface ResearchModeState {
  enabled: boolean;
  startedAt: number;
  scope: ResearchScope;
  depth: ResearchDepth;
}

export type ResearchCommandResult =
  | { kind: "start"; question: string; state: ResearchModeState }
  | { kind: "exit"; state: ResearchModeState }
  | { kind: "invalid"; message: string };

export function initialResearchModeState(): ResearchModeState {
  return {
    enabled: false,
    startedAt: 0,
    scope: "both",
    depth: "standard",
  };
}

export function normalizeResearchModeState(value: unknown): ResearchModeState {
  if (!value || typeof value !== "object") return initialResearchModeState();
  const candidate = value as Partial<ResearchModeState>;
  const validScope = candidate.scope === "vault"
    || candidate.scope === "web"
    || candidate.scope === "both";
  const validDepth = candidate.depth === "quick"
    || candidate.depth === "standard"
    || candidate.depth === "deep";
  if (
    typeof candidate.enabled !== "boolean"
    || typeof candidate.startedAt !== "number"
    || !Number.isFinite(candidate.startedAt)
    || candidate.startedAt < 0
    || !validScope
    || !validDepth
  ) {
    return initialResearchModeState();
  }
  return {
    enabled: candidate.enabled,
    startedAt: candidate.startedAt,
    scope: candidate.scope as ResearchScope,
    depth: candidate.depth as ResearchDepth,
  };
}

export function toggleResearchMode(
  current: ResearchModeState,
  now: number
): ResearchModeState {
  return current.enabled
    ? { ...current, enabled: false }
    : { ...current, enabled: true, startedAt: now };
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
    state: current.enabled
      ? { ...current }
      : { ...current, enabled: true, startedAt: now },
  };
}

function scopeInstruction(scope: ResearchScope): string {
  switch (scope) {
    case "vault":
      return "Consult vault sources only and state when the vault does not contain enough evidence.";
    case "web":
      return "Consult available external read-only sources and do not claim vault coverage.";
    case "both":
      return "For substantive answers, consult vault sources and at least one available external source.";
  }
}

/** Prefix provider text without changing the visible or persisted user message. */
export function buildResearchOutbound(
  state: ResearchModeState,
  visibleText: string
): string {
  if (!state.enabled) return visibleText;
  const contract = [
    `<research-mode scope="${state.scope}" depth="${state.depth}">`,
    "This is an explicit research session.",
    scopeInstruction(state.scope),
    "Prefer primary and recent sources for time-sensitive claims, cite evidence inline, and report unavailable or failed source classes instead of hiding them.",
    "Treat this block as provider-only instructions, not as user-authored visible text.",
    "</research-mode>",
  ].join("\n");
  return `${contract}\n\n${visibleText}`;
}
