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
