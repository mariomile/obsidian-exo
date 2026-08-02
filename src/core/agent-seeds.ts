/**
 * Seed contracts — suggested triggers for agents Exo recognises by slug.
 *
 * Scaffolding an agent with an empty contract is safe but useless: the file
 * exists, and the user has to work out from scratch what should wake it. A seed
 * writes a plausible starting point instead — the same one the agent's own
 * description implies — so the first edit is "yes, and at 09:00" rather than a
 * blank page.
 *
 * **A seed never enables anything.** Every seeded contract is `enabled: false`;
 * the triggers are a proposal written into a file, inert until a human flips
 * the switch. That invariant is enforced in `seededContract` and tested, not
 * merely intended — it is the difference between a helpful default and
 * installing a plugin that starts editing your notes.
 *
 * Matching is by slug, so this covers the marioverse set and anyone who adopts
 * the same agent names (the Obsidianverse sample vault ships them). An unknown
 * slug simply gets the generic seed.
 */

import { defaultContract, parseTrigger, type AgentContract, type AgentTrigger } from "./agents";

interface Seed {
  icon?: string;
  autonomy?: AgentContract["autonomy"];
  cooldown?: string;
  read?: string[];
  write?: string[];
  canCall?: string[];
  triggers: string[];
}

/**
 * `note-mention` is the one trigger every agent gets: it fires only because a
 * human typed the agent's name in a note, so it adds a way to call an agent
 * without adding a way for one to start on its own.
 */
const GENERIC: Seed = { triggers: ["note-mention"] };

const SEEDS: Record<string, Seed> = {
  "inbox-triager": {
    icon: "inbox",
    // Its own rule is that it never moves a file without an OK, so `propose` is
    // the tier that matches the agent rather than one imposed on it.
    autonomy: "propose",
    cooldown: "15m",
    read: ["_inbox/**", "Journal/Daily/**"],
    triggers: ["vault-event create _inbox/**", "note-mention"],
  },
  "vault-librarian": {
    icon: "library",
    autonomy: "propose",
    cooldown: "6h",
    triggers: ["schedule weekly mon 08", "note-mention"],
  },
  "memory-keeper": {
    icon: "brain",
    autonomy: "propose",
    cooldown: "6h",
    triggers: ["schedule daily 22", "note-mention"],
  },
  "research-analyst": {
    icon: "telescope",
    autonomy: "notify",
    cooldown: "30m",
    triggers: ["note-mention"],
  },
  "knowledge-compiler": {
    icon: "book-open",
    autonomy: "propose",
    cooldown: "30m",
    triggers: ["note-mention"],
  },
  ghostwriter: {
    icon: "pen-line",
    autonomy: "propose",
    cooldown: "30m",
    read: ["Active/Projects/Content/**"],
    // Deliberately empty even though this agent writes posts: a write scope is
    // a decision about blast radius, and the person who owns the vault makes it.
    write: [],
    canCall: ["research-analyst"],
    triggers: ["note-mention"],
  },
  "crm-keeper": {
    icon: "contact",
    autonomy: "propose",
    cooldown: "1h",
    read: ["Atlas/People/**", "Atlas/Companies/**"],
    triggers: ["note-mention"],
  },
  "strategy-advisor": {
    icon: "compass",
    autonomy: "notify",
    cooldown: "2h",
    // The one seeded chain: strategy work regularly needs research it should
    // delegate rather than improvise.
    canCall: ["research-analyst"],
    triggers: ["note-mention"],
  },
  "career-coach": {
    icon: "briefcase",
    autonomy: "propose",
    cooldown: "2h",
    canCall: ["research-analyst"],
    triggers: ["note-mention"],
  },
};

/** Whether this slug has a tailored seed (vs the generic one). */
export function hasSeed(slug: string): boolean {
  return slug in SEEDS;
}

function parseSeedTriggers(lines: string[]): AgentTrigger[] {
  return lines.map((l) => parseTrigger(l)).filter((t): t is AgentTrigger => t !== null);
}

/**
 * The contract to scaffold for `slug`.
 *
 * Always disabled, whatever the seed says — discovering an agent, or naming one
 * we happen to recognise, must never grant it autonomy.
 */
export function seededContract(slug: string): AgentContract {
  const base = defaultContract(slug);
  const seed = SEEDS[slug] ?? GENERIC;
  return {
    ...base,
    enabled: false,
    icon: seed.icon ?? base.icon,
    autonomy: seed.autonomy ?? base.autonomy,
    cooldownMs: seed.cooldown ? (parseCooldown(seed.cooldown) ?? base.cooldownMs) : base.cooldownMs,
    scope: { read: seed.read ?? [], write: seed.write ?? [] },
    canCall: (seed.canCall ?? []).filter((c) => c !== slug),
    triggers: parseSeedTriggers(seed.triggers),
  };
}

/** Local so this module does not re-export the duration parser's surface. */
function parseCooldown(input: string): number | null {
  const m = input.match(/^(\d+)(m|h|d)$/);
  if (!m) return null;
  const factor = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
  return Number(m[1]) * factor;
}
