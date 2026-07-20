/**
 * Privacy-safe local workflow signals.
 *
 * Signals retain only bounded intent/output categories, canonical capability
 * classes, and opaque conversation/turn ids. Tool arguments and user text are
 * accepted only as transient classifier input and never copied into the result.
 */

export type WorkflowIntent =
  | "research"
  | "summarize"
  | "write"
  | "edit"
  | "plan"
  | "analysis"
  | "organize"
  | "automate"
  | "communicate"
  | "task"
  | "other";

export type WorkflowOutputType =
  | "message"
  | "markdown"
  | "artifact"
  | "vault-write"
  | "structured";

export interface WorkflowSignal {
  id: string;
  signature: string;
  intent: WorkflowIntent;
  tools: string[];
  createdAt: number;
  convoId: string;
  turnId: string;
  succeeded: boolean;
}

export interface WorkflowToolObservation {
  name: string;
  /** Deliberately ignored and never retained. */
  input?: unknown;
}

export interface WorkflowSignalInput {
  userText: string;
  tools: WorkflowToolObservation[];
  outputType: WorkflowOutputType;
  createdAt: number;
  convoId: string;
  turnId: string;
  succeeded: boolean;
}

export interface WorkflowEligibilityInput {
  succeeded: boolean;
  stopped: boolean;
  errored: boolean;
  recoveryRetry: boolean;
  sideThread: boolean;
  playbookRun: boolean;
  sensitive: boolean;
  assistantChars: number;
  toolNames: string[];
  structuredOutput: boolean;
}

export type WorkflowIneligibleReason =
  | "stopped"
  | "error"
  | "recovery-retry"
  | "side-thread"
  | "playbook-run"
  | "sensitive"
  | "insubstantial"
  | "insufficient-structure";

export type WorkflowEligibility =
  | { eligible: true }
  | { eligible: false; reason: WorkflowIneligibleReason };

export interface WorkflowSignalLedger {
  version: 1;
  signals: WorkflowSignal[];
}

export const EMPTY_WORKFLOW_SIGNAL_LEDGER: WorkflowSignalLedger = { version: 1, signals: [] };

export interface WorkflowCandidate {
  signature: string;
  occurrences: number;
}

export interface RecordWorkflowOptions {
  threshold?: number;
  windowMs?: number;
  maxSignals?: number;
  blockedSignatures?: ReadonlySet<string>;
}

export interface RecordWorkflowResult {
  ledger: WorkflowSignalLedger;
  candidate: WorkflowCandidate | null;
}

const INTENT_RULES: readonly [WorkflowIntent, RegExp][] = [
  ["research", /\b(?:research|ricerc|cerca|confronta|compare|investigat|verify|verifica)\w*/i],
  ["summarize", /\b(?:summari[sz]|riassum|sintetizz|digest)\w*/i],
  ["plan", /\b(?:plan|piano|roadmap|strateg|progett)\w*/i],
  ["analysis", /\b(?:analy[sz]|analizz|audit|review|valut)\w*/i],
  ["edit", /\b(?:edit|modific|revision|riscriv|rewrite|refactor)\w*/i],
  ["write", /\b(?:write|scriv|draft|redig|crea|create|genera|generate)\w*/i],
  ["organize", /\b(?:organiz|organizz|classific|riordin|curat)\w*/i],
  ["automate", /\b(?:automat|schedul|programma|workflow)\w*/i],
  ["communicate", /\b(?:email|mail|messagg|message|send|invia|reply|rispondi)\w*/i],
  ["task", /\b(?:task|todo|azione|action|promemoria|reminder)\w*/i],
];

export function classifyWorkflowIntent(userText: string): WorkflowIntent {
  for (const [intent, pattern] of INTENT_RULES) {
    if (pattern.test(userText)) return intent;
  }
  return "other";
}

const IGNORED_TOOLS = new Set([
  "AskUserQuestion",
  "TodoWrite",
  "ExitPlanMode",
  "EnterPlanMode",
  "ListMcpResourcesTool",
]);

function canonicalTool(name: string): string | null {
  if (IGNORED_TOOLS.has(name) || name === "mcp__obsidian__ask_user") return null;
  if (name === "Grep" || name.includes("obsidian__search")) return "vault.search";
  if (name === "Read" || name === "NotebookRead" || name.includes("obsidian__read")) return "vault.read";
  if (name === "Glob" || name === "LS" || name.includes("obsidian__list")) return "vault.list";
  if (/^(?:Write|Edit|MultiEdit|NotebookEdit)$/.test(name) || /obsidian__(?:write|edit|create|append|patch)/.test(name)) {
    return "vault.write";
  }
  if (name === "WebSearch" || name === "web_search") return "web.search";
  if (name === "WebFetch" || name === "web_fetch") return "web.fetch";
  if (name === "Bash" || name === "Shell") return "shell";
  if (name === "Skill") return "skill";
  if (/^(?:Task|Agent|Subagent)/.test(name)) return "agent";
  if (name.startsWith("mcp__")) return "external.mcp";
  return "capability.other";
}

/** Preserve meaningful order while collapsing consecutive duplicate noise. */
export function significantToolSequence(names: readonly string[]): string[] {
  const tools: string[] = [];
  for (const name of names) {
    const canonical = canonicalTool(name);
    if (!canonical || tools.at(-1) === canonical) continue;
    tools.push(canonical);
  }
  return tools;
}

export function evaluateWorkflowEligibility(input: WorkflowEligibilityInput): WorkflowEligibility {
  if (input.stopped) return { eligible: false, reason: "stopped" };
  if (!input.succeeded || input.errored) return { eligible: false, reason: "error" };
  if (input.recoveryRetry) return { eligible: false, reason: "recovery-retry" };
  if (input.sideThread) return { eligible: false, reason: "side-thread" };
  if (input.playbookRun) return { eligible: false, reason: "playbook-run" };
  if (input.sensitive) return { eligible: false, reason: "sensitive" };
  const tools = significantToolSequence(input.toolNames);
  if (input.assistantChars < 120 && !input.structuredOutput) {
    return { eligible: false, reason: "insubstantial" };
  }
  if (tools.length < 2 && !input.structuredOutput) {
    return { eligible: false, reason: "insufficient-structure" };
  }
  return { eligible: true };
}

export function workflowSignature(input: {
  intent: WorkflowIntent;
  tools: readonly string[];
  outputType: WorkflowOutputType;
}): string {
  return `${input.intent}|${input.tools.join(">") || "no-tools"}|${input.outputType}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function createWorkflowSignal(input: WorkflowSignalInput): WorkflowSignal {
  const intent = classifyWorkflowIntent(input.userText);
  const tools = significantToolSequence(input.tools.map((tool) => tool.name));
  const signature = workflowSignature({ intent, tools, outputType: input.outputType });
  return {
    id: `wf-${input.createdAt.toString(36)}-${fnv1a(`${input.convoId}:${input.turnId}:${signature}`)}`,
    signature,
    intent,
    tools,
    createdAt: input.createdAt,
    convoId: input.convoId,
    turnId: input.turnId,
    succeeded: input.succeeded,
  };
}

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Pure rolling-window recorder. Duplicate turn ids are retry-safe no-ops. */
export function recordWorkflowOccurrence(
  ledger: WorkflowSignalLedger,
  signal: WorkflowSignal,
  now: number,
  options: RecordWorkflowOptions = {}
): RecordWorkflowResult {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const threshold = options.threshold ?? 3;
  const maxSignals = options.maxSignals ?? 1000;
  const cutoff = now - windowMs;
  const withinWindow = ledger.signals.filter((item) =>
    item.createdAt >= cutoff && item.createdAt <= now
  );
  if (withinWindow.some((item) => item.id === signal.id || (
    item.convoId === signal.convoId && item.turnId === signal.turnId
  ))) {
    return { ledger: { version: 1, signals: withinWindow }, candidate: null };
  }

  const appended = [...withinWindow, signal]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-maxSignals);
  const occurrences = appended.filter((item) =>
    item.signature === signal.signature && item.succeeded
  ).length;
  const blocked = options.blockedSignatures?.has(signal.signature) ?? false;
  return {
    ledger: { version: 1, signals: appended },
    candidate: occurrences >= threshold && !blocked
      ? { signature: signal.signature, occurrences }
      : null,
  };
}
