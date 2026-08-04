/**
 * Automation model — the unified, file-based automation (pure, no Obsidian).
 *
 * One automation = one `_system/automations/<slug>.md` file: readable
 * frontmatter (name, description, when, mode, scope, agent, cooldown,
 * enabled) plus the prompt as the markdown body. This module owns the type,
 * the human-readable `when` grammar, and the frontmatter round-trip; the
 * store (impure) owns vault IO and the executor owns timers.
 *
 * The `when` grammar is the single representation shared by the file, the
 * editor and the card sentence — "daily 07:00", "weekly mon 07:00",
 * "on create in _inbox/**", "on tag #todo". Parsing is lenient (minutes
 * accepted, Italian day names, bare folders normalized to globs); formatting
 * always emits the canonical form so files converge on save.
 */

import { type Cadence, cadenceLabel, parseCadenceInput } from "./automations";
import {
  frontmatterBlock,
  stripFrontmatter,
  fmScalar,
  fmList,
  parseDuration,
  formatDuration,
} from "./agents";

/* ------------------------------- types ------------------------------- */

/** What a run may do: read-only report, inert proposals, or direct writes. */
export type AutomationMode = "report" | "propose" | "act";

export const AUTOMATION_MODES: readonly AutomationMode[] = ["report", "propose", "act"];

export type AutomationWhen =
  | { on: "schedule"; cadence: Cadence }
  | { on: "vault-event"; event: "create" | "modify" | "rename"; path: string }
  | { on: "tag"; tag: string };

export interface Automation {
  slug: string;
  name: string;
  description: string;
  /** Lucide icon id. Never an emoji. */
  icon: string;
  when: AutomationWhen[];
  mode: AutomationMode;
  /** Write-scope folders/globs; only meaningful for propose/act. */
  scope: string[];
  /** Optional brain slug (.claude/agents) this automation delegates to. */
  agent?: string;
  /** Built-in executor passthrough (Daily Pulse). */
  system?: "daily-pulse";
  /** Minimum ms between two event-triggered runs. */
  cooldownMs: number;
  enabled: boolean;
  /** Markdown body — the playbook itself. */
  prompt: string;
}

export const DEFAULT_AUTOMATION_ICON = "zap";
export const DEFAULT_AUTOMATION_COOLDOWN_MS = 15 * 60_000;

/* ---------------------------- when grammar ---------------------------- */

const EVENTS = ["create", "modify", "rename"] as const;

/** Bare folders become recursive globs; existing globs pass through. */
function normalizeEventPath(input: string): string {
  const p = input.trim().replace(/^\.\//, "");
  if (!p) return "**";
  if (p.includes("*")) return p;
  return p.replace(/\/+$/, "") + "/**";
}

/** Parse one `when` line. Null = not part of the grammar. */
export function parseWhen(line: string): AutomationWhen | null {
  const s = line.trim();
  if (!s) return null;
  const lower = s.toLowerCase();

  if (lower === "hourly") return { on: "schedule", cadence: { kind: "hourly" } };

  let m = lower.match(/^daily\s+(\d{1,2})(?::(\d{2}))?$/);
  if (m) {
    const cadence = parseCadenceInput("daily", Number(m[1]));
    return cadence ? { on: "schedule", cadence } : null;
  }

  m = lower.match(/^weekly\s+(\S+)\s+(\d{1,2})(?::(\d{2}))?$/);
  if (m) {
    const cadence = parseCadenceInput("weekly", Number(m[2]), m[1]);
    return cadence ? { on: "schedule", cadence } : null;
  }

  m = s.match(/^on\s+(create|modify|rename)\s+in\s+(.+)$/i);
  if (m) {
    const event = m[1].toLowerCase() as (typeof EVENTS)[number];
    return { on: "vault-event", event, path: normalizeEventPath(m[2]) };
  }

  m = s.match(/^on\s+tag\s+#?([^\s#]+)$/i);
  if (m) return { on: "tag", tag: m[1] };

  return null;
}

/** Canonical form — always re-parses to the same value. */
export function formatWhen(w: AutomationWhen): string {
  if (w.on === "schedule") return cadenceLabel(w.cadence);
  if (w.on === "vault-event") return `on ${w.event} in ${w.path}`;
  return `on tag #${w.tag}`;
}

const EVENT_VERBS: Record<string, string> = {
  create: "created",
  modify: "modified",
  rename: "renamed",
};

/** Plain-English sentence for a card row. */
export function whenSentence(w: AutomationWhen): string {
  if (w.on === "schedule") {
    const c = w.cadence;
    if (c.kind === "hourly") return "Runs every hour";
    const hh = `${String(c.hour).padStart(2, "0")}:00`;
    if (c.kind === "daily") return `Runs daily at ${hh}`;
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return `Runs every ${days[c.day] ?? "?"} at ${hh}`;
  }
  if (w.on === "vault-event") {
    const where = w.path.replace(/\/\*\*$/, "/");
    return `Runs when a note is ${EVENT_VERBS[w.event]} in ${where}`;
  }
  return `Runs when a note is tagged #${w.tag}`;
}

export function modeSentence(mode: AutomationMode): string {
  if (mode === "report") return "read-only";
  if (mode === "propose") return "proposes changes";
  return "can edit notes";
}

/* --------------------------- file round-trip --------------------------- */

export function parseAutomationFile(
  slug: string,
  raw: string,
): { automation: Automation; warnings: string[] } {
  const warnings: string[] = [];
  const fm = frontmatterBlock(raw) ?? "";
  if (!frontmatterBlock(raw)) warnings.push("missing frontmatter");

  const when: AutomationWhen[] = [];
  for (const line of fmList(fm, "when")) {
    const w = parseWhen(line);
    if (w) when.push(w);
    else warnings.push(`unparseable when "${line}"`);
  }

  const modeRaw = fmScalar(fm, "mode");
  let mode: AutomationMode = "report";
  if (modeRaw !== undefined) {
    if ((AUTOMATION_MODES as string[]).includes(modeRaw)) mode = modeRaw as AutomationMode;
    else warnings.push(`unknown mode "${modeRaw}" — using report`);
  }

  let cooldownMs = DEFAULT_AUTOMATION_COOLDOWN_MS;
  const cooldownRaw = fmScalar(fm, "cooldown");
  if (cooldownRaw !== undefined) {
    const parsed = parseDuration(cooldownRaw);
    if (parsed === null) warnings.push(`unparseable cooldown "${cooldownRaw}"`);
    else cooldownMs = parsed;
  }

  const systemRaw = fmScalar(fm, "system");
  if (systemRaw !== undefined && systemRaw !== "daily-pulse") {
    warnings.push(`unknown system "${systemRaw}" — ignored`);
  }

  const automation: Automation = {
    slug,
    name: fmScalar(fm, "name") ?? slug,
    description: fmScalar(fm, "description") ?? "",
    icon: fmScalar(fm, "icon") ?? DEFAULT_AUTOMATION_ICON,
    when,
    mode,
    scope: fmList(fm, "scope"),
    agent: fmScalar(fm, "agent"),
    system: systemRaw === "daily-pulse" ? "daily-pulse" : undefined,
    cooldownMs,
    enabled: fmScalar(fm, "enabled") === "true",
    prompt: stripFrontmatter(raw).trim(),
  };
  return { automation, warnings };
}

export function serializeAutomation(a: Automation): string {
  const lines: string[] = ["---", `name: ${a.name}`];
  if (a.description) lines.push(`description: ${a.description}`);
  lines.push(`icon: ${a.icon}`);
  if (a.when.length) {
    lines.push("when:");
    for (const w of a.when) lines.push(`  - "${formatWhen(w)}"`);
  }
  lines.push(`mode: ${a.mode}`);
  if (a.scope.length) lines.push(`scope: [${a.scope.join(", ")}]`);
  if (a.agent) lines.push(`agent: ${a.agent}`);
  if (a.system) lines.push(`system: ${a.system}`);
  lines.push(`cooldown: ${formatDuration(a.cooldownMs)}`);
  lines.push(`enabled: ${a.enabled}`);
  lines.push("---", "", a.prompt, "");
  return lines.join("\n");
}
