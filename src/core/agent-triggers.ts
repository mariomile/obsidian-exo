/**
 * Agent event triggers — pure matching core (no Obsidian imports).
 *
 * Phase 3's genuinely new surface. Everything autonomous in Exo before this was
 * a poll (30 min / 5 min / 60 min) or a post-turn hook; these are the first
 * triggers that fire from a filesystem event, which is why the guards here are
 * deliberately conservative: a bulk sync, a git checkout, or a plugin rewriting
 * frontmatter can each produce hundreds of events in a second.
 *
 * The three defences, in order of how much they save:
 *   1. path exclusion — tool-owned trees never trigger anything (this is also
 *      what stops an agent's own write from re-triggering the agent);
 *   2. debounce, owned by the impure driver;
 *   3. the shared gates in `agent-runs.ts` (cooldown, concurrency, budget).
 */

import { matchesGlobs, triggerKey, type AgentDef, type AgentTrigger } from "./agents";
import { agentTriggerRunKey, type DueAgentRun } from "./agent-runs";
import { fold } from "../mentions/tokenizer";

export type VaultEventKind = "create" | "modify" | "rename";

export interface VaultEvent {
  path: string;
  kind: VaultEventKind;
  /** Tags currently on the note (frontmatter + inline), `#`-prefixed. */
  tags?: string[];
  /** Tags the note had the last time we saw it — absent on first sight. */
  previousTags?: string[];
  /** Note body, when the driver has it cheaply. Needed for `note-mention`. */
  body?: string;
}

/**
 * Paths that must never trigger an agent.
 *
 * `memoryRoot` is in here because agent runs write reports and ledgers there:
 * without it, an agent with a `modify` trigger would re-trigger itself on its
 * own output — the cheapest possible infinite loop.
 */
export function isIgnoredTriggerPath(path: string, memoryRoot: string): boolean {
  if (!path.endsWith(".md")) return true;
  const ignored = [".obsidian/", ".claude/", ".trash/", ".git/", `${memoryRoot}/`];
  return ignored.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix));
}

/* --------------------------- mention matching --------------------------- */

/** Fenced and inline code, so `@agent` in a snippet is documentation, not a call. */
function stripCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Agents `@mentioned` in a note body.
 *
 * Matches both the slug and the display name, and requires the `@` to start a
 * word so `mario@gmail.com` and `user@host` never count. Matching is
 * accent/case-folded via the same `fold` the unlinked-mention engine uses, so
 * "@ricerca" and "@Ricérca" behave identically.
 */
export function findAgentMentions(body: string, agents: AgentDef[]): AgentDef[] {
  const text = fold(stripCode(body));
  const hits: AgentDef[] = [];
  for (const agent of agents) {
    const candidates = [agent.brain.slug, agent.brain.name].map(fold).filter(Boolean);
    const found = candidates.some((c) =>
      // (^|non-word-and-not-@) @candidate (not followed by a word char)
      new RegExp(`(?:^|[^\\w@])@${escapeRe(c)}(?![\\w-])`, "u").test(text)
    );
    if (found) hits.push(agent);
  }
  return hits;
}

/* ---------------------------- event matching ---------------------------- */

/**
 * Every (agent, trigger) pair that fires for one vault event.
 *
 * The runKey intentionally carries the path for path-scoped triggers, so two
 * different notes landing in `_inbox/` are two runs rather than one deduped
 * away — while the same note firing twice inside the debounce window is not.
 */
export function matchVaultEvent(agents: AgentDef[], event: VaultEvent): DueAgentRun[] {
  const out: DueAgentRun[] = [];
  const previous = event.previousTags ? new Set(event.previousTags) : null;
  const current = new Set(event.tags ?? []);

  for (const agent of agents) {
    if (!agent.contract.enabled) continue;
    for (const trigger of agent.contract.triggers) {
      if (trigger.on === "vault-event") {
        if (trigger.event !== event.kind) continue;
        if (!matchesGlobs(event.path, [trigger.path])) continue;
        out.push({
          agent,
          trigger,
          runKey: `${agentTriggerRunKey(agent.brain.slug, trigger)}::${event.path}`,
          reason: `${event.kind} ${event.path}`,
        });
        continue;
      }

      if (trigger.on === "tag") {
        if (!current.has(trigger.tag)) continue;
        // Fire on the transition, not on the state: without a previous snapshot
        // every subsequent edit of a tagged note would re-fire.
        if (previous?.has(trigger.tag)) continue;
        if (!previous && event.kind !== "create") continue;
        out.push({
          agent,
          trigger,
          runKey: `${agentTriggerRunKey(agent.brain.slug, trigger)}::${event.path}`,
          reason: `${trigger.tag} on ${event.path}`,
        });
        continue;
      }

      if (trigger.on === "note-mention") {
        if (!event.body) continue;
        if (!findAgentMentions(event.body, [agent]).length) continue;
        out.push({
          agent,
          trigger,
          runKey: `${agentTriggerRunKey(agent.brain.slug, trigger)}::${event.path}`,
          reason: `@mention in ${event.path}`,
        });
      }
    }
  }
  return out;
}

/** True when any enabled agent has at least one event-driven trigger — lets the
 *  driver skip reading tags/body entirely when nothing is listening. */
export function anyEventTriggers(agents: AgentDef[]): boolean {
  return agents.some(
    (a) =>
      a.contract.enabled
      && a.contract.triggers.some((t) => t.on === "vault-event" || t.on === "tag" || t.on === "note-mention")
  );
}

/** Whether the driver needs the note body for this agent set (mention triggers). */
export function needsBody(agents: AgentDef[]): boolean {
  return agents.some((a) => a.contract.enabled && a.contract.triggers.some((t) => t.on === "note-mention"));
}

/** Stable label for a fired trigger, for logs and the run report. */
export function eventTriggerLabel(t: AgentTrigger, path: string): string {
  return `${triggerKey(t)} · ${path}`;
}
