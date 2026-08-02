/**
 * Plain-language descriptions of what an agent automation actually does.
 *
 * The contract is a schema — `act`, `vault-event create _inbox/**`, `15m`. That
 * is the right vocabulary for a file and the wrong one for a row: reading it
 * requires knowing the schema, so the surface that is supposed to answer "what
 * runs without me?" instead poses a second question.
 *
 * Pure so the sentence is testable and identical everywhere it appears — the
 * pane, the Automations tab, and the tool that reports a change back in chat
 * must not describe the same agent three different ways.
 */

import { formatDuration, type AgentContract, type AgentTrigger } from "./agents";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const hhmm = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** Strip the glob machinery: `_inbox/**` reads as `_inbox`. */
function folderName(glob: string): string {
  const trimmed = glob.replace(/\/\*+$/, "").replace(/\/+$/, "");
  return trimmed || glob;
}

/**
 * When this trigger fires, as a clause that can open a sentence.
 *
 * `note-mention` is deliberately phrased as something the reader does, because
 * it is: it fires when a human types the agent's name, which is invocation
 * rather than automation.
 */
export function triggerClause(t: AgentTrigger): string {
  if (t.on === "schedule") {
    const c = t.cadence;
    if (c.kind === "hourly") return "Every hour";
    if (c.kind === "daily") return `Every day at ${hhmm(c.hour)}`;
    return `Every ${DAYS[c.day] ?? "week"} at ${hhmm(c.hour)}`;
  }
  if (t.on === "vault-event") {
    const where = folderName(t.path);
    if (t.event === "create") return `When a note is added to ${where}`;
    if (t.event === "modify") return `When a note in ${where} changes`;
    return `When a note in ${where} is renamed`;
  }
  if (t.on === "tag") return `When ${t.tag} is added to a note`;
  return `When you write @${"mention"} in a note`;
}

/** What the agent is allowed to do with what it finds. */
export function autonomyClause(contract: AgentContract): string {
  if (contract.autonomy === "act") {
    return contract.scope.write.length
      ? "it makes the changes itself"
      : "it would make changes, but nothing is writable yet";
  }
  if (contract.autonomy === "propose") return "it suggests changes for you to accept";
  return "it only reports what it finds";
}

/** Where the write-up goes, as a trailing clause (empty for `silent`). */
export function outputClause(contract: AgentContract): string {
  if (contract.output === "journal") return "and logs one line in your daily note";
  if (contract.output === "report") return "and writes a report note";
  return "";
}

/**
 * The whole thing as one sentence a person can read without knowing the schema.
 *
 * Uses the first unattended trigger: an agent usually has one reason it runs on
 * its own, and listing every trigger turns the sentence back into a spec.
 */
export function describeAgentAutomation(contract: AgentContract): string {
  const auto = contract.triggers.filter((t) => t.on !== "note-mention");
  const lead = auto.length ? triggerClause(auto[0]) : "When you run it";
  const parts = [autonomyClause(contract), outputClause(contract)].filter(Boolean).join(" ");
  const extra = auto.length > 1 ? ` (+${auto.length - 1} more trigger${auto.length > 2 ? "s" : ""})` : "";
  return `${lead}, ${parts}.${extra}`;
}

/** The pacing note, kept separate so a row can render it quieter. */
export function cadenceNote(contract: AgentContract): string {
  return `At most once every ${spellDuration(contract.cooldownMs)}.`;
}

/** `15m` is a token; "15 min" is a reading. */
export function spellDuration(ms: number): string {
  const raw = formatDuration(ms);
  const m = raw.match(/^(\d+)([a-z]+)$/);
  if (!m) return raw;
  const n = Number(m[1]);
  const unit = { ms: "ms", s: "sec", m: "min", h: n === 1 ? "hour" : "hours", d: n === 1 ? "day" : "days" }[m[2]];
  return `${n} ${unit ?? m[2]}`;
}

/* --------------------------- control labels --------------------------- */

/** What each chip says at rest, and what its options mean. Plain language, so
 *  the control explains itself rather than naming a field. */
export const AUTONOMY_CHOICES = [
  { value: "notify", label: "only reports", hint: "Reads and tells you. Never changes anything." },
  { value: "propose", label: "suggests changes", hint: "Works out what to do and waits for you to accept." },
  { value: "act", label: "makes changes", hint: "Applies what it decides. Every run is reversible." },
] as const;

export const OUTPUT_CHOICES = [
  { value: "journal", label: "a line in my daily note", hint: "One line per run. No extra files." },
  { value: "report", label: "a report note", hint: "A note per run, in your reports folder." },
  { value: "silent", label: "nothing", hint: "Only the run history records it." },
] as const;

export const COOLDOWN_CHOICES = ["5m", "15m", "30m", "1h", "2h", "6h", "1d"] as const;
