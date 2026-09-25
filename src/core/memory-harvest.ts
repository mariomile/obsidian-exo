/**
 * Memory harvest, pure half. After a chat goes idle Exo reads its new
 * messages, extracts candidate facts (step 1), decides per fact against the
 * notes it would touch whether to ADD a line, UPDATE one line, or do nothing
 * (step 2, Mem0-style), and applies the result under code-enforced guardrails.
 *
 * The one storage principle: the vault is the memory. Every write lands in an
 * existing Markdown note the user owns, or in the daily inbox note. Routing is
 * data: the vault's own memory rules (AGENTS.md) plus search hits reach the
 * model; the code only enforces generic guardrails. No Obsidian import.
 */
import { chatLines, type ChatLine, type ChatMessage } from "./recent-chats";

/* ------------------------------ scheduling ------------------------------ */

/** A conversation is due once it has sat idle this long with unharvested messages. */
export const HARVEST_IDLE_MS = 10 * 60 * 1000;
/** Messages older than this are never harvested: catch-up after a closed
 *  Obsidian covers days, not the whole history of a first install. */
export const HARVEST_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
/** Hard ceilings per harvest. */
export const HARVEST_MAX_WRITES = 8;
export const HARVEST_MAX_CANDIDATES = 12;
/** Transcript handed to the extractor. */
const TRANSCRIPT_MAX_CHARS = 16_000;

export interface HarvestConvoState {
  messageCount: number;
  harvestedIndex?: number;
  streaming: boolean;
  /** Epoch ms of the last activity (last message or update). */
  lastActivityAt: number;
}

/** Due = unharvested messages, not mid-turn, and idle for {@link HARVEST_IDLE_MS}
 *  (or `leaving`: the user switched away from it or closed it). */
export function isHarvestDue(c: HarvestConvoState, now: number, leaving = false): boolean {
  if (c.streaming) return false;
  if ((c.harvestedIndex ?? 0) >= c.messageCount) return false;
  return leaving || now - c.lastActivityAt >= HARVEST_IDLE_MS;
}

/** The unharvested stretch: lines from the watermark on, minus anything older
 *  than the lookback. `end` is the new watermark once the harvest settles. */
export function harvestSlice(
  messages: readonly ChatMessage[],
  harvestedIndex: number | undefined,
  now: number,
): { lines: ChatLine[]; end: number } {
  const start = Math.max(0, Math.min(harvestedIndex ?? 0, messages.length));
  const lines = chatLines(messages)
    .slice(start)
    .filter((l) => l.text.trim() && l.at !== undefined && now - l.at <= HARVEST_LOOKBACK_MS);
  return { lines, end: messages.length };
}

/** Too little user text to hold a durable fact: advance without a model call. */
export function worthExtracting(lines: readonly ChatLine[]): boolean {
  const userChars = lines
    .filter((l) => l.role === "user" && !l.text.trim().startsWith("/"))
    .reduce((n, l) => n + l.text.trim().length, 0);
  return userChars >= 20;
}

export function buildTranscript(lines: readonly ChatLine[]): string {
  const rendered = lines.map((l) => `${l.role === "user" ? "USER" : "ASSISTANT"}: ${l.text.trim()}`).join("\n\n");
  // Keep the END when clipping: the most recent exchange is the freshest signal.
  return rendered.length > TRANSCRIPT_MAX_CHARS ? `…\n${rendered.slice(-TRANSCRIPT_MAX_CHARS)}` : rendered;
}

/* ------------------------------- secrets -------------------------------- */

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\b(?:password|passwd|pwd|passphrase|api[_ -]?key|secret|token|access[_ -]?key)\s*[:=]\s*\S{6,}/i,
];

/** True when `text` carries something that looks like a credential. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/* ------------------------------ step 1: extract ------------------------------ */

export const FACT_KINDS = ["user", "person", "company", "project", "agent-lesson", "other"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export interface Candidate {
  kind: FactKind;
  statement: string;
  entity?: string;
  evidence: string;
}

export function buildExtractPrompt(transcript: string, today: string): string {
  return [
    "You extract durable facts from a chat between the owner of an Obsidian vault (USER) and their assistant (ASSISTANT).",
    `Today is ${today}.`,
    "",
    "A fact is something still worth knowing weeks from now. Kinds:",
    '- "user": the vault owner\'s preferences, working patterns, how they decide.',
    '- "person": a fact about a specific person (set entity to their name).',
    '- "company": a fact about a specific company or organization (set entity).',
    '- "project": state, constraint, decision or next step of a named project (set entity to the project).',
    '- "agent-lesson": an operational lesson for the assistant itself (a correction, a mistake not to repeat).',
    '- "other": reusable knowledge with no better kind.',
    "",
    "NOT facts: task chatter, one-off instructions for this chat, things the assistant merely proposed and the user did not confirm, anything obvious or generic, and never credentials, keys, tokens or passwords.",
    "Prefer what the USER stated or confirmed. Write each statement as one self-contained sentence in the language of the chat.",
    "",
    'Answer with JSON only, no prose: {"facts":[{"kind":"...","statement":"...","entity":"...","evidence":"short quote from the chat"}]}.',
    'No durable facts → {"facts":[]}.',
    "",
    "CHAT:",
    transcript,
  ].join("\n");
}

/** The JSON payload inside a model reply: code fences and prose around it are tolerated. */
export function extractJson(raw: string): unknown {
  const text = raw.replace(/```(?:json)?/gi, "").trim();
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** Typed candidates from the extractor's reply. Malformed entries and anything
 *  that trips the secret filter are dropped; at most {@link HARVEST_MAX_CANDIDATES}. */
export function parseCandidates(raw: string): Candidate[] {
  const json = extractJson(raw);
  const list = Array.isArray(json) ? json : (json as { facts?: unknown } | null)?.facts;
  if (!Array.isArray(list)) return [];
  const out: Candidate[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const kind = str(rec.kind) as FactKind;
    const statement = str(rec.statement);
    if (!FACT_KINDS.includes(kind) || statement.length < 8) continue;
    const entity = str(rec.entity);
    const evidence = str(rec.evidence);
    if (containsSecret(`${statement} ${entity} ${evidence}`)) continue;
    out.push({ kind, statement, ...(entity ? { entity } : {}), evidence });
    if (out.length >= HARVEST_MAX_CANDIDATES) break;
  }
  return out;
}

/* ------------------------------ step 2: decide ------------------------------ */

/** A note as the decider sees it: its sections, and the lines that matter. */
export interface NoteContext {
  path: string;
  headings: string[];
  lines: string[];
}

export interface CandidateContext {
  candidate: Candidate;
  notes: NoteContext[];
}

export type Decision =
  | { op: "noop"; candidate: number }
  | { op: "add"; candidate: number; path: string; section?: string; text: string }
  | { op: "update"; candidate: number; path: string; oldLine: string; newText: string };

/** The memory section of the vault's AGENTS.md: a `## Memory`/`## Memoria`
 *  heading (any level) up to the next heading of the same or higher level. */
export function memoryRulesSection(agentsMd: string): string {
  const lines = agentsMd.split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s+(memory|memoria)\b/i.test(l.trim()));
  if (start < 0) return "";
  const level = (lines[start].match(/^#+/) ?? ["##"])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

/** Vault paths the rules name explicitly (backticked `….md`), wildcards and
 *  placeholders excluded: the notes the decider needs to see the sections of. */
export function explicitRulePaths(rules: string): string[] {
  const out = new Set<string>();
  for (const m of rules.matchAll(/`([^`\s]+\.md)`/g)) {
    const p = m[1];
    if (/[*<>{}]|AAAA|YYYY/.test(p)) continue;
    out.add(p.replace(/^\.?\//, ""));
  }
  return [...out];
}

/** Heading texts of a note, in order. */
export function noteHeadings(content: string): string[] {
  return content
    .split("\n")
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => l.trim());
}

/** Content words of a statement, for picking the note lines worth showing. */
export function keywordsOf(text: string): string[] {
  const seen = new Set<string>();
  for (const w of text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/)) {
    if (w.length >= 4) seen.add(w);
  }
  return [...seen];
}

/** Non-heading lines of `content` that share a keyword with the statement:
 *  the lines an UPDATE could target, quoted exactly. */
export function matchingLines(content: string, keywords: readonly string[], max = 12): string[] {
  if (!keywords.length) return [];
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || /^#{1,6}\s/.test(t) || t === "---") continue;
    const folded = t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (keywords.some((k) => folded.includes(k))) {
      out.push(line.replace(/\s+$/, ""));
      if (out.length >= max) break;
    }
  }
  return out;
}

const DEFAULT_RULES = [
  "No memory rules found in this vault. Route by these defaults:",
  "- facts about the vault owner → their profile/preferences note if one exists",
  "- person or company → that entity's existing note",
  "- project → the project's existing overview/context note",
  "- agent lesson → the agent memory note",
  "- no obvious home → the inbox note",
].join("\n");

export function buildDecidePrompt(input: {
  today: string;
  rules: string;
  routingNotes: NoteContext[];
  inboxPath: string;
  agentLessonPath: string;
  items: CandidateContext[];
}): string {
  const renderNote = (n: NoteContext): string =>
    [
      `  NOTE ${n.path}`,
      n.headings.length ? `    sections: ${n.headings.join(" | ")}` : "    sections: (none)",
      ...n.lines.map((l) => `    line: ${l}`),
    ].join("\n");
  const items = input.items.map((it, i) =>
    [
      `FACT ${i} [${it.candidate.kind}${it.candidate.entity ? `: ${it.candidate.entity}` : ""}] ${it.candidate.statement}`,
      `  evidence: ${it.candidate.evidence}`,
      ...(it.notes.length ? it.notes.map(renderNote) : ["  (no related notes found)"]),
    ].join("\n"),
  );
  return [
    "You maintain the memory of an Obsidian vault. The vault IS the memory: facts live as single lines in the owner's existing notes.",
    `Today is ${input.today}.`,
    "",
    "For EACH fact below decide one operation:",
    '- {"op":"noop","candidate":i}: already recorded (same meaning), not worth keeping, or no safe place for it.',
    '- {"op":"add","candidate":i,"path":"...","section":"...","text":"..."}: append ONE line to an existing note, under the named section heading (omit section to append at the end).',
    '- {"op":"update","candidate":i,"path":"...","oldLine":"...","newText":"..."}: the fact CHANGED a line that exists. oldLine must be copied EXACTLY from a "line:" shown below. newText replaces that one line and keeps the old value as a trace.',
    "",
    "Rules:",
    "- Only paths shown below as NOTE, or the inbox. Never invent a path, never create notes.",
    `- Agent lessons go to ${input.agentLessonPath} when that note is shown; anything useful with no obvious home goes to the inbox: ${input.inboxPath}.`,
    "- Additive only: never remove or rewrite the owner's text beyond the single updated line.",
    "- Write text and newText in the language of the target note, one line, no leading bullet.",
    "- For an update, use the changed-fact format from the vault rules if they define one; otherwise `<new> (since YYYY-MM-DD; previously <old>)`.",
    "- Never write credentials, keys, tokens or passwords.",
    "",
    "VAULT MEMORY RULES:",
    input.rules || DEFAULT_RULES,
    "",
    input.routingNotes.length ? "NOTES NAMED BY THE RULES:" : "",
    ...input.routingNotes.map(renderNote),
    "",
    "FACTS:",
    items.join("\n\n"),
    "",
    'Answer with JSON only: {"decisions":[...]} with one decision per fact.',
  ]
    .filter((l, i, all) => !(l === "" && all[i - 1] === ""))
    .join("\n");
}

/** Typed decisions from the decider's reply; malformed ones are dropped. */
export function parseDecisions(raw: string, candidateCount: number): Decision[] {
  const json = extractJson(raw);
  const list = Array.isArray(json) ? json : (json as { decisions?: unknown } | null)?.decisions;
  if (!Array.isArray(list)) return [];
  const out: Decision[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const candidate = typeof rec.candidate === "number" ? rec.candidate : -1;
    if (candidate < 0 || candidate >= candidateCount) continue;
    const op = str(rec.op).toLowerCase();
    const path = str(rec.path);
    if (op === "noop") out.push({ op: "noop", candidate });
    else if (op === "add" && path && str(rec.text)) {
      const section = str(rec.section);
      out.push({ op: "add", candidate, path, ...(section ? { section } : {}), text: str(rec.text) });
    } else if (op === "update" && path && typeof rec.oldLine === "string" && str(rec.newText)) {
      out.push({ op: "update", candidate, path, oldLine: rec.oldLine, newText: str(rec.newText) });
    }
  }
  return out;
}

/* ------------------------------ guardrails ------------------------------ */

export interface TargetEnv {
  exists(path: string): boolean;
  /** Today's inbox note: the one path that may be created. */
  inboxPath: string;
  /** Agent kernel files (SOUL/USER/NOW, AGENTS.md, CLAUDE.md): never harvested into. */
  kernelPaths: ReadonlySet<string>;
  /** Folder prefixes that are sync-owned or user-excluded (`Input/`, …). */
  ignoredPrefixes: readonly string[];
}

export function normalizeTarget(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.?\//, "");
}

/** Null when `path` is a legal harvest target, else the reason it is not. */
export function checkTarget(path: string, env: TargetEnv): string | null {
  const p = normalizeTarget(path);
  if (!p.endsWith(".md")) return "not a markdown note";
  const parts = p.split("/");
  if (parts.some((part) => part === ".." || part === "")) return "invalid path";
  if (parts.some((part) => part.startsWith("."))) return "hidden or config folder";
  if (parts.slice(0, -1).some((part) => /readwise/i.test(part))) return "synced source folder";
  if (env.ignoredPrefixes.some((pre) => p === pre || p.startsWith(pre.endsWith("/") ? pre : `${pre}/`))) {
    return "ignored folder";
  }
  if (env.kernelPaths.has(p)) return "agent kernel file";
  if (!env.exists(p) && p !== env.inboxPath) return "note does not exist";
  return null;
}

/** One line, no leading bullet, no trailing whitespace. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/^[-*+]\s+/, "");
}

/** Append `- text` under `section` (a heading, matched without its #s,
 *  case-insensitively) or at the end of the note when there is no such section. */
export function applyAdd(content: string, section: string | undefined, text: string): string {
  const bullet = `- ${oneLine(text)}`;
  const lines = content.replace(/\s+$/, "").split("\n");
  const want = section?.replace(/^#+\s*/, "").trim().toLowerCase();
  if (want) {
    const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim().toLowerCase() === want);
    if (start >= 0) {
      const level = (lines[start].match(/^#+/) ?? ["#"])[0].length;
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        const m = lines[i].match(/^(#{1,6})\s/);
        if (m && m[1].length <= level) {
          end = i;
          break;
        }
      }
      let at = end;
      while (at > start + 1 && !lines[at - 1].trim()) at--;
      lines.splice(at, 0, bullet);
      return `${lines.join("\n")}\n`;
    }
  }
  const body = lines.join("\n");
  return `${body}${body ? "\n" : ""}${bullet}\n`;
}

/** Replace the ONE line equal (whitespace-trimmed) to `oldLine` with `newText`,
 *  keeping its indentation and bullet. Null unless the line occurs exactly once. */
export function applyUpdate(content: string, oldLine: string, newText: string): string | null {
  const want = oldLine.trim();
  if (!want) return null;
  const lines = content.split("\n");
  const hits = lines.flatMap((l, i) => (l.trim() === want ? [i] : []));
  if (hits.length !== 1) return null;
  const i = hits[0];
  const prefix = lines[i].match(/^\s*(?:[-*+]\s+(?:\[.\]\s+)?)?/)?.[0] ?? "";
  lines[i] = `${prefix}${oneLine(newText)}`;
  return lines.join("\n");
}

/** Starter content for a new daily inbox note. */
export function inboxNote(date: string): string {
  return `---\ntype: memory\ntags:\n  - type/memory\n---\n\n# Memory inbox: ${date}\n`;
}

/* -------------------------------- commit -------------------------------- */

export const HARVEST_COMMIT_PREFIX = "exo: memory harvest:";
export const REVERT_COMMIT_PREFIX = "exo: memory revert:";

export function harvestCommitMessage(writes: number, title: string): string {
  const t = oneLine(title).slice(0, 60) || "chat";
  return `${HARVEST_COMMIT_PREFIX} ${writes} scritture (${t})`;
}

export function revertCommitMessage(sha: string): string {
  return `${REVERT_COMMIT_PREFIX} ${sha}`;
}
