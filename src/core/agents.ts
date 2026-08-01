/**
 * Agents — pure registry core (no Obsidian imports).
 *
 * A named agent is two files with two different owners:
 *
 *   .claude/agents/<slug>.md    THE BRAIN    — CLI-native, portable across
 *                                              Claude Code / Cowork / Codex.
 *                                              Exo reads it, never writes it.
 *   _system/agents/<slug>.md    THE CONTRACT — Exo-owned: triggers, autonomy
 *                                              tier, scope globs, allowlist.
 *
 * The split is not taste. `.claude/` is gitignored and does not sync to mobile,
 * so trigger config kept there would be neither versioned nor visible on a
 * phone; and the brain has a different audience (every harness) than the
 * trigger config (this plugin's runtime). The join key is the slug.
 *
 * This module owns parsing, validation and decisions. The store (impure) owns
 * scanning and vault IO. Architecture rule: the engine is the product — the
 * brain is the agent's prompt, and nothing here tries to replace it.
 */

import { type Cadence, cadenceLabel, parseCadenceInput } from "./automations";

/* ------------------------------- types ------------------------------- */

/** What an autonomous run is allowed to do with its conclusions. */
export type AgentAutonomy =
  /** Write a report note; touch nothing else. */
  | "notify"
  /** Route every change through the Proposal Kernel (inert until accepted). */
  | "propose"
  /** Write directly, checkpointed and restorable. */
  | "act";

export const AGENT_AUTONOMY: readonly AgentAutonomy[] = ["notify", "propose", "act"];

/** Where a brain was discovered. Order encodes precedence (first wins). */
export type AgentSource = "vault" | "user" | "codex" | "plugin";

export const AGENT_SOURCE_ORDER: readonly AgentSource[] = ["vault", "user", "codex", "plugin"];

/** The CLI-native half: `.claude/agents/<slug>.md` frontmatter. Read-only. */
export interface AgentBrain {
  /** Scope-prefixed filename base — the join key with the contract sidecar. */
  slug: string;
  /** Frontmatter `name:`, falling back to the slug. */
  name: string;
  /**
   * The id the CLI actually answers to — what must go into `subagent_type`.
   *
   * NOT the slug: verified against a live `system/init` capability snapshot,
   * `.claude/agents/career-coach.md` with `name: Career Coach` is invoked as
   * "Career Coach", and a plugin's `foo.agent.md` as "plugin:foo". So the id is
   * the scope prefix plus the frontmatter name — the filename is only ever the
   * fallback.
   */
  invocable: string;
  description?: string;
  /** Frontmatter `model:` — overrides the conversation model when bound. */
  model?: string;
  /** Frontmatter `tools:` — informational; the CLI enforces it. */
  tools?: string[];
  source: AgentSource;
  /** Full path of the brain file, for "open definition" affordances. */
  path?: string;
}

export type AgentTrigger =
  | { on: "schedule"; cadence: Cadence }
  | { on: "vault-event"; event: "create" | "modify" | "rename"; path: string }
  | { on: "note-mention" }
  | { on: "tag"; tag: string };

/** The Exo-owned half: `_system/agents/<slug>.md` frontmatter. */
export interface AgentContract {
  slug: string;
  enabled: boolean;
  /** Lucide icon id. Never an emoji. */
  icon: string;
  autonomy: AgentAutonomy;
  /** Minimum ms between two autonomous runs of this agent. */
  cooldownMs: number;
  /** Glob allowlists. Empty read = no restriction; empty write = no writes. */
  scope: { read: string[]; write: string[] };
  /** Slugs this agent may hand work to via `invoke_agent`. */
  canCall: string[];
  triggers: AgentTrigger[];
}

/** A resolved agent: brain + contract. */
export interface AgentDef {
  brain: AgentBrain;
  contract: AgentContract;
}

export const DEFAULT_AGENT_ICON = "bot";
export const DEFAULT_COOLDOWN_MS = 30 * 60_000;

/** Contract used for an agent whose sidecar is missing or unparseable. Inert by
 *  design: disabled, no triggers, no write scope — discovering a brain must
 *  never grant it autonomy. */
export function defaultContract(slug: string): AgentContract {
  return {
    slug,
    enabled: false,
    icon: DEFAULT_AGENT_ICON,
    autonomy: "propose",
    cooldownMs: DEFAULT_COOLDOWN_MS,
    scope: { read: [], write: [] },
    canCall: [],
    triggers: [],
  };
}

/* ------------------------------- slugs ------------------------------- */

/** Filename/handle form: lowercase, non-alphanumerics collapsed to hyphens. */
export function slugifyAgent(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/* --------------------------- frontmatter ---------------------------- */

/** The raw frontmatter block, or null when the file has none. */
export function frontmatterBlock(raw: string): string | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return m ? m[1] : null;
}

function unquote(value: string): string {
  const t = value.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** A top-level scalar value. Comments after the value are stripped. */
export function fmScalar(fm: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:[ \\t]*(.*)$`, "m");
  const hit = fm.match(re)?.[1];
  if (hit === undefined) return undefined;
  const v = unquote(hit.replace(/\s+#.*$/, ""));
  return v || undefined;
}

/** A top-level list, in either YAML form:
 *    key: [a, b]            (flow)
 *    key:\n  - a\n  - b     (block)
 *  Returns [] when the key is absent or empty. */
export function fmList(fm: string, key: string): string[] {
  const lines = fm.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (start === -1) return [];
  const inline = lines[start].slice(key.length + 1).replace(/\s+#.*$/, "").trim();
  if (inline.startsWith("[")) {
    const body = inline.replace(/^\[|\]$/g, "");
    return body
      .split(",")
      .map((s) => unquote(s))
      .filter(Boolean);
  }
  if (inline) return [unquote(inline)];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^[ \t]*-[ \t]+(.*)$/);
    if (!m) break;
    const v = unquote(m[1].replace(/\s+#.*$/, ""));
    if (v) out.push(v);
  }
  return out;
}

/* ------------------------------- brain ------------------------------- */

/** Parse a `.claude/agents/<slug>.md` frontmatter block into a brain.
 *
 *  This is the single agent-frontmatter parser: `capability-desc` (autocomplete
 *  descriptions) and the Capabilities panel both went their own way before, with
 *  three subtly different regexes. Never throws — a brain with unreadable
 *  frontmatter still exists, it just carries less metadata. */
export function parseAgentBrain(raw: string, slug: string, source: AgentSource, path?: string): AgentBrain {
  // A plugin scope prefixes its slug (`plugin:name`); the prefix belongs to the
  // invocable id too, while the frontmatter name replaces only the base.
  const cut = slug.lastIndexOf(":");
  const prefix = cut === -1 ? "" : slug.slice(0, cut + 1);
  const base = cut === -1 ? slug : slug.slice(cut + 1);
  const fm = frontmatterBlock(raw);
  if (!fm) return { slug, name: base, invocable: slug, source, path };
  const name = fmScalar(fm, "name") ?? base;
  const tools = fmList(fm, "tools");
  return {
    slug,
    name,
    invocable: `${prefix}${name}`,
    description: fmScalar(fm, "description"),
    model: fmScalar(fm, "model"),
    tools: tools.length ? tools : undefined,
    source,
    path,
  };
}

/** True when a file in the agents folder is an Exo contract rather than an
 *  unrelated note that happens to live there. Vaults predating this feature can
 *  have `_system/agents/*.md` notes with other purposes — treating those as
 *  contracts (or scaffolding over them) would be destructive. */
export function isAgentSidecar(raw: string): boolean {
  const fm = frontmatterBlock(raw);
  return fm !== null && fmScalar(fm, "type") === "agent";
}

/* ------------------------------ duration ----------------------------- */

/** `"30m"` / `"2h"` / `"90s"` / `"45"` (bare = minutes) → ms. Null = invalid. */
export function parseDuration(input: string): number | null {
  const m = input.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const factors: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.round(n * (factors[m[2] ?? "m"] ?? 60_000));
}

export function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0 && ms >= 86_400_000) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0 && ms >= 3_600_000) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/* ------------------------------ triggers ----------------------------- */

/**
 * Triggers are a one-line DSL so the sidecar stays a plain YAML string list —
 * hand-editable on a phone, diffable in git, and parseable without a YAML
 * dependency (this module must stay Obsidian- and dep-free):
 *
 *   schedule hourly
 *   schedule daily 08
 *   schedule weekly mon 08
 *   vault-event create _inbox/**
 *   note-mention
 *   tag #needs/post
 */
export function parseTrigger(line: string): AgentTrigger | null {
  const parts = line.trim().split(/\s+/).filter(Boolean);
  const kind = parts[0]?.toLowerCase();
  if (!kind) return null;

  if (kind === "schedule") {
    const sub = parts[1]?.toLowerCase();
    if (!sub) return null;
    // `weekly mon 08` → day then hour; `daily 08` / `hourly` → hour only.
    const cadence =
      sub === "weekly"
        ? parseCadenceInput("weekly", parts[3] === undefined ? undefined : Number(parts[3]), parts[2])
        : parseCadenceInput(sub, parts[2] === undefined ? undefined : Number(parts[2]));
    return cadence ? { on: "schedule", cadence } : null;
  }

  if (kind === "vault-event") {
    const event = parts[1]?.toLowerCase();
    const path = parts.slice(2).join(" ");
    if (event !== "create" && event !== "modify" && event !== "rename") return null;
    if (!path) return null;
    return { on: "vault-event", event, path };
  }

  if (kind === "note-mention") return { on: "note-mention" };

  if (kind === "tag") {
    const tag = parts[1];
    if (!tag) return null;
    return { on: "tag", tag: tag.startsWith("#") ? tag : `#${tag}` };
  }

  return null;
}

export function serializeTrigger(t: AgentTrigger): string {
  if (t.on === "schedule") {
    const c = t.cadence;
    if (c.kind === "hourly") return "schedule hourly";
    const hh = String(c.hour).padStart(2, "0");
    if (c.kind === "daily") return `schedule daily ${hh}`;
    return `schedule weekly ${["sun", "mon", "tue", "wed", "thu", "fri", "sat"][c.day]} ${hh}`;
  }
  if (t.on === "vault-event") return `vault-event ${t.event} ${t.path}`;
  if (t.on === "tag") return `tag ${t.tag}`;
  return "note-mention";
}

export function triggerLabel(t: AgentTrigger): string {
  if (t.on === "schedule") return cadenceLabel(t.cadence);
  if (t.on === "vault-event") return `on ${t.event} in ${t.path}`;
  if (t.on === "tag") return `on ${t.tag}`;
  return "on @mention in a note";
}

/** Stable identity of a trigger, for run dedupe keys. */
export function triggerKey(t: AgentTrigger): string {
  return serializeTrigger(t);
}

/* ------------------------------- globs ------------------------------- */

/** Glob → RegExp. Supports `**` (any depth, including none) and `*` (one
 *  segment). Everything else is matched literally.
 *
 *  `**` is position-sensitive, which is the whole subtlety: `a/**` must match
 *  `a/b/c` *and* `a` itself, while `a/**\/b` must match `a/b` with no
 *  intermediate segment at all. Both cases need the neighbouring slash to be
 *  able to disappear, so they are handled separately rather than by one
 *  substitution. */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      i += 2;
      if (pattern[i] === "/") {
        i++; // `**/rest` — any number of leading segments, including none
        out += "(?:[^/]*/)*";
      } else if (i >= pattern.length && out.endsWith("/")) {
        // trailing `a/**` — everything under `a`, and `a` itself
        out = `${out.slice(0, -1)}(?:/.*)?`;
      } else {
        out += ".*";
      }
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    i++;
  }
  return new RegExp(`^${out}$`);
}

/** True when `path` matches any pattern. An empty pattern list means "no
 *  allowlist configured" and is the caller's decision to interpret. */
export function matchesGlobs(path: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(path));
}

/** Write gate: a path is writable only if an explicit write glob covers it.
 *  No globs → no autonomous writes. Deny-by-default is deliberate. */
export function canWritePath(contract: AgentContract, path: string): boolean {
  return contract.scope.write.length > 0 && matchesGlobs(path, contract.scope.write);
}

/* ------------------------------ sidecar ------------------------------ */

export interface SidecarParse {
  contract: AgentContract;
  /** Human-readable problems. Never thrown — a broken sidecar degrades the
   *  agent to inert, it does not break the registry. */
  warnings: string[];
}

/** Parse `_system/agents/<slug>.md`. Unknown keys are ignored so the file can
 *  carry vault frontmatter (tags, created_by, …) alongside the contract. */
export function parseAgentSidecar(raw: string, slug: string): SidecarParse {
  const warnings: string[] = [];
  const base = defaultContract(slug);
  const fm = frontmatterBlock(raw);
  if (!fm) {
    warnings.push("no frontmatter block — using inert defaults");
    return { contract: base, warnings };
  }

  const enabledRaw = fmScalar(fm, "enabled");
  const enabled = enabledRaw === undefined ? base.enabled : /^(true|yes|on)$/i.test(enabledRaw);

  const autonomyRaw = fmScalar(fm, "autonomy");
  let autonomy = base.autonomy;
  if (autonomyRaw !== undefined) {
    const candidate = autonomyRaw.toLowerCase() as AgentAutonomy;
    if (AGENT_AUTONOMY.includes(candidate)) autonomy = candidate;
    else warnings.push(`unknown autonomy "${autonomyRaw}" — falling back to "${base.autonomy}"`);
  }

  let cooldownMs = base.cooldownMs;
  const cooldownRaw = fmScalar(fm, "cooldown");
  if (cooldownRaw !== undefined) {
    const parsed = parseDuration(cooldownRaw);
    if (parsed === null) warnings.push(`unparseable cooldown "${cooldownRaw}" — using ${formatDuration(base.cooldownMs)}`);
    else cooldownMs = parsed;
  }

  const triggers: AgentTrigger[] = [];
  for (const line of fmList(fm, "triggers")) {
    const t = parseTrigger(line);
    if (t) triggers.push(t);
    else warnings.push(`unparseable trigger "${line}" — ignored`);
  }

  const canCall = fmList(fm, "can_call").map(slugifyAgent).filter(Boolean);
  if (canCall.includes(slug)) warnings.push("can_call lists the agent itself — self-calls are always refused");

  const contract: AgentContract = {
    slug,
    enabled,
    icon: fmScalar(fm, "icon") ?? base.icon,
    autonomy,
    cooldownMs,
    scope: { read: fmList(fm, "read"), write: fmList(fm, "write") },
    canCall: canCall.filter((c) => c !== slug),
    triggers,
  };

  if (autonomy === "act" && contract.scope.write.length === 0) {
    warnings.push('autonomy is "act" but no write globs are declared — every write will be refused');
  }

  return { contract, warnings };
}

const yamlList = (items: string[]) => `[${items.map((i) => JSON.stringify(i)).join(", ")}]`;

/** Scaffold a sidecar for a newly discovered brain. Inert: disabled, no
 *  triggers, no write scope — the human turns it on. */
export function serializeAgentSidecar(contract: AgentContract, brain?: AgentBrain, today = ""): string {
  const lines = [
    "---",
    "type: agent",
    `agent: ${contract.slug}`,
    `enabled: ${contract.enabled}`,
    `icon: ${contract.icon}`,
    `autonomy: ${contract.autonomy}`,
    `cooldown: ${formatDuration(contract.cooldownMs)}`,
    `read: ${yamlList(contract.scope.read)}`,
    `write: ${yamlList(contract.scope.write)}`,
    `can_call: ${yamlList(contract.canCall)}`,
    "triggers:",
    ...(contract.triggers.length
      ? contract.triggers.map((t) => `  - ${serializeTrigger(t)}`)
      : ["  # - schedule daily 08", "  # - vault-event create _inbox/**", "  # - note-mention"]),
    "created_by: exo",
    ...(today ? [`last_updated: ${today}`] : []),
    "tags:",
    "  - type/agent",
    "---",
    "",
    `# ${brain?.name ?? contract.slug}`,
    "",
    brain?.description
      ? `> ${brain.description}`
      : "> Exo contract for this agent — triggers, autonomy and scope.",
    "",
    `The prompt lives in \`.claude/agents/${contract.slug}.md\`; this file only says *when* the`,
    "agent runs and *what* it may touch. Notes below are for humans — they are not sent to the model.",
    "",
    "## Notes",
    "",
  ];
  return lines.join("\n");
}

/* ------------------------------- merge ------------------------------- */

/** Join brains with contracts by slug. Brains without a sidecar get an inert
 *  default (the store scaffolds the file separately); contracts without a brain
 *  are dropped — a contract alone cannot run anything. */
export function mergeAgents(brains: AgentBrain[], contracts: AgentContract[]): AgentDef[] {
  const byslug = new Map(contracts.map((c) => [c.slug, c]));
  const seen = new Set<string>();
  const out: AgentDef[] = [];
  for (const brain of brains) {
    if (seen.has(brain.slug)) continue; // first source wins (vault > user > codex > plugin)
    seen.add(brain.slug);
    out.push({ brain, contract: byslug.get(brain.slug) ?? defaultContract(brain.slug) });
  }
  return out.sort((a, b) => a.brain.name.localeCompare(b.brain.name));
}

/** Slugs with a contract but no brain — surfaced so an orphan sidecar (renamed
 *  or deleted agent) is visible instead of silently inert. */
export function orphanContracts(brains: AgentBrain[], contracts: AgentContract[]): string[] {
  const known = new Set(brains.map((b) => b.slug));
  return contracts.filter((c) => !known.has(c.slug)).map((c) => c.slug).sort();
}

/**
 * Snap invocable ids to the engine's own capability list.
 *
 * The id is derived from where a file was found, and that derivation can drift:
 * an installed plugin is keyed in `installed_plugins.json` by an opaque id, so
 * its scope prefix may not match the one the CLI advertises (observed:
 * `vercel:ai-architect` on disk vs `b95178c7d8df:ai-architect` in the session's
 * init snapshot). The snapshot is ground truth, so when it is available we
 * adopt it — but only on an unambiguous single-candidate match, since guessing
 * a delegation target is worse than failing loudly.
 */
export function reconcileInvocable(agents: AgentDef[], capsAgents: readonly string[]): AgentDef[] {
  if (!capsAgents.length) return agents;
  const exact = new Set(capsAgents);
  const bySuffix = new Map<string, string[]>();
  for (const id of capsAgents) {
    const tail = id.slice(id.lastIndexOf(":") + 1);
    const list = bySuffix.get(tail);
    if (list) list.push(id);
    else bySuffix.set(tail, [id]);
  }
  return agents.map((agent) => {
    const current = agent.brain.invocable;
    if (exact.has(current)) return agent;
    const candidates = bySuffix.get(current.slice(current.lastIndexOf(":") + 1)) ?? [];
    if (candidates.length !== 1) return agent;
    return { ...agent, brain: { ...agent.brain, invocable: candidates[0] } };
  });
}

/** Resolve by slug, name, or a loose `@handle`/display-name form. */
export function resolveAgent(agents: AgentDef[], query: string): AgentDef | null {
  const q = query.trim().replace(/^@/, "");
  if (!q) return null;
  const slug = slugifyAgent(q);
  return (
    agents.find((a) => a.brain.slug === q)
    ?? agents.find((a) => a.brain.slug === slug)
    ?? agents.find((a) => a.brain.name === q)
    ?? agents.find((a) => slugifyAgent(a.brain.name) === slug)
    ?? null
  );
}

/** Agents that declare at least one trigger of the given kind and are enabled. */
export function agentsWithTrigger<K extends AgentTrigger["on"]>(
  agents: AgentDef[],
  kind: K
): { agent: AgentDef; trigger: Extract<AgentTrigger, { on: K }> }[] {
  const out: { agent: AgentDef; trigger: Extract<AgentTrigger, { on: K }> }[] = [];
  for (const agent of agents) {
    if (!agent.contract.enabled) continue;
    for (const trigger of agent.contract.triggers) {
      if (trigger.on === kind) out.push({ agent, trigger: trigger as Extract<AgentTrigger, { on: K }> });
    }
  }
  return out;
}

/* ---------------------------- turn binding ---------------------------- */

/**
 * Provider-only rider that turns `@agent` from a hint into an instruction.
 *
 * Today selecting an agent in the composer inserts text and hopes the model
 * reads it. This makes the delegation explicit while staying inside the
 * engine's own subagent machinery — Exo does not run a second brain, it just
 * stops being ambiguous about which one the engine should use.
 */
export function buildAgentBindingOutbound(def: AgentDef, visibleText: string): string {
  const { brain, contract } = def;
  const lines = [
    "<agent-binding>",
    `The user explicitly addressed the "${brain.name}" agent.`,
    `Delegate this request to that subagent: Agent({ subagent_type: "${brain.invocable}", prompt: <the user's request> }).`,
    brain.description ? `Its remit: ${brain.description}` : "",
    contract.scope.read.length ? `It reads: ${contract.scope.read.join(", ")}.` : "",
    contract.scope.write.length
      ? `It may write only inside: ${contract.scope.write.join(", ")}. Refuse writes outside that scope.`
      : "It has no declared write scope — do not let it write; report back instead.",
    contract.autonomy === "act"
      ? ""
      : contract.autonomy === "propose"
        ? "Its autonomy tier is `propose`: present changes for approval before writing."
        : "Its autonomy tier is `notify`: report only, change nothing.",
    "If that subagent is unavailable, say so plainly and answer directly instead of silently substituting another agent.",
    "Treat this block as provider-only instructions, not as user-authored visible text.",
    "</agent-binding>",
  ].filter(Boolean);
  return `${lines.join("\n")}\n\n${visibleText}`;
}

/* ---------------------------- slash command ---------------------------- */

export type AgentCommandResult =
  | { kind: "bind"; query: string }
  | { kind: "clear" }
  | { kind: "invalid"; message: string };

/** Parse `/as <agent>` — binds the whole conversation. `/as off` clears it. */
export function parseAgentCommand(input: string): AgentCommandResult | null {
  const match = input.trim().match(/^\/as(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const argument = (match[1] ?? "").trim();
  if (!argument) return { kind: "invalid", message: "Add an agent name after /as (or `/as off` to clear)." };
  if (/^(?:off|none|clear|exit)$/i.test(argument)) return { kind: "clear" };
  return { kind: "bind", query: argument };
}
