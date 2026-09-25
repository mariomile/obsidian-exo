/**
 * Memory harvest, write half: apply the decider's ADD/UPDATE decisions under
 * the guardrails in `memory-harvest.ts`, snapshotting every file before its
 * first write. I/O is injected (`ApplyVault`), so this stays Obsidian-free and
 * the guardrails are testable end to end.
 */
import {
  applyAdd,
  applyUpdate,
  checkTarget,
  containsSecret,
  inboxNote,
  normalizeTarget,
  oneLine,
  HARVEST_MAX_WRITES,
  type Decision,
  type TargetEnv,
} from "./memory-harvest";

export interface ApplyVault {
  exists(path: string): boolean;
  read(path: string): Promise<string>;
  /** Overwrite an existing note. */
  modify(path: string, content: string): Promise<void>;
  /** Create a note (and its parent folders). */
  create(path: string, content: string): Promise<void>;
}

/** One line Exo wrote, for the digest and the commit. */
export interface AppliedWrite {
  path: string;
  op: "add" | "update";
  text: string;
}

/** Pre/post content of a touched file: the checkpoint that backs undo when
 *  the vault has no git. `before: null` = the harvest created the file. */
export interface FileSnapshot {
  path: string;
  before: string | null;
  after: string;
}

export interface ApplyResult {
  writes: AppliedWrite[];
  files: FileSnapshot[];
  rejected: { decision: Decision; reason: string }[];
}

export async function applyDecisions(
  vault: ApplyVault,
  decisions: readonly Decision[],
  env: TargetEnv & { today: string },
): Promise<ApplyResult> {
  const writes: AppliedWrite[] = [];
  const files = new Map<string, FileSnapshot>();
  const rejected: { decision: Decision; reason: string }[] = [];

  for (const d of decisions) {
    if (d.op === "noop") continue;
    if (writes.length >= HARVEST_MAX_WRITES) {
      rejected.push({ decision: d, reason: "write limit reached" });
      continue;
    }
    const path = normalizeTarget(d.path);
    const why = checkTarget(path, { ...env, exists: (p) => files.has(p) || env.exists(p) });
    if (why) {
      rejected.push({ decision: d, reason: why });
      continue;
    }
    const text = d.op === "add" ? d.text : d.newText;
    if (containsSecret(text) || (d.op === "update" && containsSecret(d.oldLine))) {
      rejected.push({ decision: d, reason: "looks like a credential" });
      continue;
    }

    const prior = files.get(path);
    const existed = prior ? prior.before !== null : env.exists(path);
    const current = prior ? prior.after : existed ? await vault.read(path) : inboxNote(env.today);

    let next: string | null;
    if (d.op === "add") next = applyAdd(current, d.section, d.text);
    else next = applyUpdate(current, d.oldLine, d.newText);
    if (next === null) {
      rejected.push({ decision: d, reason: "oldLine not found exactly once" });
      continue;
    }

    if (existed || prior) await vault.modify(path, next);
    else await vault.create(path, next);
    files.set(path, { path, before: prior ? prior.before : existed ? current : null, after: next });
    writes.push({ path, op: d.op, text: oneLine(text) });
  }
  return { writes, files: [...files.values()], rejected };
}
