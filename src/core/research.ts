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

export type ResearchSourceKind = "vault" | "web" | "mcp";
export type ResearchSourceStatus = "consulted" | "failed" | "unavailable" | "skipped";

export interface ResearchReceiptSource {
  kind: ResearchSourceKind;
  label: string;
  status: ResearchSourceStatus;
  detail?: string;
}

export interface ResearchReceipt {
  scope: ResearchScope;
  depth: ResearchDepth;
  startedAt: number;
  completedAt: number;
  status: "complete" | "partial" | "no-sources";
  sources: ResearchReceiptSource[];
}

export interface ResearchReceiptSummary {
  label: "Sources checked" | "Partial coverage" | "No sources consulted";
  consulted: number;
  issues: number;
}

export interface ResearchSourceAvailability {
  vault: boolean;
  web: boolean;
  mcpServers: { name: string; status: string }[];
}

export interface ResearchToolObservation {
  name: string;
  input: unknown;
  ok: boolean | null;
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
    "Use external MCP capabilities only for read operations; never mutate external systems during research.",
    "Treat this block as provider-only instructions, not as user-authored visible text.",
    "</research-mode>",
  ].join("\n");
  return `${contract}\n\n${visibleText}`;
}

const VAULT_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "mcp__obsidian__read_note",
  "mcp__obsidian__search_vault",
  "mcp__obsidian__list_notes",
  "mcp__obsidian__get_backlinks",
]);

const WEB_TOOLS = new Set(["WebSearch", "WebFetch", "web_search", "web_fetch"]);

function recordInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function cleanVaultLabel(value: string): string {
  const wikilink = value.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
  return (wikilink?.[1] ?? value).replace(/^\.\//, "");
}

function observationKind(name: string): ResearchSourceKind | null {
  if (VAULT_TOOLS.has(name) || name.startsWith("mcp__obsidian__")) return "vault";
  if (WEB_TOOLS.has(name)) return "web";
  if (name.startsWith("mcp__")) return "mcp";
  return null;
}

function observationLabel(tool: ResearchToolObservation, kind: ResearchSourceKind): string {
  if (kind === "mcp") {
    const match = tool.name.match(/^mcp__([^_].*?)__(.+)$/);
    return match ? `${match[1]}: ${match[2]}` : "External MCP source";
  }
  const input = recordInput(tool.input);
  const candidates = kind === "vault"
    ? [input.file_path, input.path, input.target, input.query, input.pattern]
    : [input.query, input.url];
  const value = candidates.find((candidate): candidate is string =>
    typeof candidate === "string" && candidate.trim().length > 0
  );
  if (!value) return kind === "vault" ? "Vault source" : "Web source";
  return kind === "vault" ? cleanVaultLabel(value.trim()) : value.trim();
}

function placeholder(
  kind: "vault" | "web",
  status: ResearchSourceStatus,
  detail: string
): ResearchReceiptSource {
  return {
    kind,
    label: kind === "vault" ? "Vault sources" : "Web sources",
    status,
    detail,
  };
}

/**
 * Build an auditable, model-independent receipt from observed tool calls.
 * External MCP arguments are deliberately excluded because connector queries
 * can contain private data; only the server and tool names are retained.
 */
export function buildResearchReceipt(input: {
  state: ResearchModeState;
  completedAt: number;
  availability: ResearchSourceAvailability;
  tools: ResearchToolObservation[];
}): ResearchReceipt {
  const observed = input.tools.flatMap((tool): ResearchReceiptSource[] => {
    const kind = observationKind(tool.name);
    if (!kind) return [];
    return [{
      kind,
      label: observationLabel(tool, kind),
      status: tool.ok === true ? "consulted" : "failed",
    }];
  });
  const unique = observed.filter((source, index, all) =>
    all.findIndex((candidate) =>
      candidate.kind === source.kind
      && candidate.label === source.label
      && candidate.status === source.status
    ) === index
  );

  const vaultRequired = input.state.scope !== "web";
  const externalRequired = input.state.scope !== "vault";
  const connectedMcp = input.availability.mcpServers.some((server) =>
    server.status.toLowerCase() === "connected"
  );
  const hasVault = unique.some((source) => source.kind === "vault");
  const hasWeb = unique.some((source) => source.kind === "web");

  const sources: ResearchReceiptSource[] = [];
  if (hasVault) sources.push(...unique.filter((source) => source.kind === "vault"));
  else if (!vaultRequired) sources.push(placeholder("vault", "skipped", "Outside selected scope"));
  else if (!input.availability.vault) sources.push(placeholder("vault", "unavailable", "No observable vault capability"));
  else sources.push(placeholder("vault", "skipped", "No source consulted"));

  if (hasWeb) sources.push(...unique.filter((source) => source.kind === "web"));
  else if (!externalRequired) sources.push(placeholder("web", "skipped", "Outside selected scope"));
  else if (!input.availability.web && !connectedMcp) sources.push(placeholder("web", "unavailable", "No observable web capability"));
  else sources.push(placeholder("web", "skipped", "No source consulted"));

  sources.push(...unique.filter((source) => source.kind === "mcp"));

  const requestedSuccesses = sources.filter((source) =>
    source.status === "consulted"
    && (source.kind === "vault" ? vaultRequired : externalRequired)
  );
  const vaultComplete = !vaultRequired
    || sources.some((source) => source.kind === "vault" && source.status === "consulted");
  const externalComplete = !externalRequired
    || sources.some((source) =>
      (source.kind === "web" || source.kind === "mcp") && source.status === "consulted"
    );
  const requestedFailure = sources.some((source) =>
    source.status === "failed"
    && (source.kind === "vault" ? vaultRequired : externalRequired)
  );
  const status = requestedSuccesses.length === 0
    ? "no-sources"
    : vaultComplete && externalComplete && !requestedFailure
      ? "complete"
      : "partial";

  return {
    scope: input.state.scope,
    depth: input.state.depth,
    startedAt: input.state.startedAt,
    completedAt: input.completedAt,
    status,
    sources,
  };
}

/** Quiet copy contract for the UI: absence of evidence is never completion. */
export function summarizeResearchReceipt(receipt: ResearchReceipt): ResearchReceiptSummary {
  const consulted = receipt.sources.filter((source) => source.status === "consulted").length;
  const issues = receipt.sources.filter((source) =>
    source.status === "failed" || source.status === "unavailable"
  ).length;
  return {
    label: receipt.status === "complete"
      ? "Sources checked"
      : receipt.status === "partial"
        ? "Partial coverage"
        : "No sources consulted",
    consulted,
    issues,
  };
}
