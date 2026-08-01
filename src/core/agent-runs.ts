/**
 * Agent runs — pure decision core for unattended agent execution.
 *
 * Every trigger (schedule today; vault events and note-mentions later) funnels
 * through here, so there is exactly one place that answers "may this agent run
 * right now?". The executor owns timers, vault IO and the CLI; this module owns
 * the gates.
 *
 * The gates deliberately live OUTSIDE the agent's own reasoning loop — an agent
 * cannot talk its way past a cooldown, a concurrency cap or a budget stop, the
 * way it could if these were instructions in a prompt.
 */

import {
  isDue,
  currentSlotStart,
  type Cadence,
} from "./automations";
import { triggerLabel, triggerKey, type AgentAutonomy, type AgentDef, type AgentTrigger } from "./agents";

/** Persistence key for "when did this agent last run at all" (cooldown). */
export function agentLastRunKey(slug: string): string {
  return `agent:${slug}`;
}

/** Persistence key for "when did this agent last run FOR THIS TRIGGER" (slot
 *  semantics). Separate from the cooldown key so an agent with two schedules
 *  keeps one slot cursor per schedule. */
export function agentTriggerRunKey(slug: string, trigger: AgentTrigger): string {
  return `agent:${slug}::${triggerKey(trigger)}`;
}

export interface DueAgentRun {
  agent: AgentDef;
  trigger: AgentTrigger;
  /** Persistence key to stamp once the run completes. */
  runKey: string;
  /** Human-readable trigger label, for notices and the run report. */
  reason: string;
}

/**
 * Scheduled agents whose slot has come round.
 *
 * Slot semantics (shared with automations) are what make catch-up safe: an
 * agent that was due while Obsidian was closed runs ONCE when it reopens, not
 * once per missed slot.
 */
export function dueScheduledAgentRuns(
  agents: AgentDef[],
  lastRun: Record<string, number>,
  now: number
): DueAgentRun[] {
  const out: DueAgentRun[] = [];
  for (const agent of agents) {
    if (!agent.contract.enabled) continue;
    for (const trigger of agent.contract.triggers) {
      if (trigger.on !== "schedule") continue;
      const runKey = agentTriggerRunKey(agent.brain.slug, trigger);
      if (!isDue(trigger.cadence, lastRun[runKey] ?? 0, now)) continue;
      out.push({ agent, trigger, runKey, reason: triggerLabel(trigger) });
    }
  }
  return out;
}

/** When a scheduled agent will next fire (Cockpit/pane display). */
export function nextScheduledSlot(cadence: Cadence, lastRun: number, now: number): number {
  return isDue(cadence, lastRun, now) ? now : currentSlotStart(cadence, now);
}

export type RunRefusal = "disabled" | "cooldown" | "concurrency" | "duplicate" | "budget";

export type RunGate = { ok: true } | { ok: false; reason: RunRefusal; detail: string };

export interface GateInput {
  agent: AgentDef;
  /** Last run of this agent by ANY trigger. 0 = never. */
  lastRunAt: number;
  now: number;
  /** Runs already in flight (any agent). */
  running: number;
  maxConcurrent: number;
  /** Keys of runs already queued or in flight — dedupe target. */
  inFlightKeys: ReadonlySet<string>;
  runKey: string;
  /** False when the token/cost budget for background work is exhausted. */
  budgetAvailable: boolean;
  /** Manual runs bypass cooldown and schedule slots — a human asked. */
  manual?: boolean;
}

/**
 * Decide whether a single run may start. Order matters: the cheapest and most
 * absolute refusals come first, so a disabled agent is never reported as
 * merely rate-limited.
 */
export function gateAgentRun(input: GateInput): RunGate {
  const { agent, runKey, now, manual } = input;
  if (!agent.contract.enabled && !manual) {
    return { ok: false, reason: "disabled", detail: `${agent.brain.name} is disabled` };
  }
  if (input.inFlightKeys.has(runKey)) {
    return { ok: false, reason: "duplicate", detail: `${agent.brain.name} already has this run queued` };
  }
  if (input.running >= input.maxConcurrent) {
    return {
      ok: false,
      reason: "concurrency",
      detail: `${input.running}/${input.maxConcurrent} agent runs already in flight`,
    };
  }
  if (!input.budgetAvailable) {
    return { ok: false, reason: "budget", detail: "background budget exhausted" };
  }
  if (!manual) {
    const elapsed = now - input.lastRunAt;
    if (input.lastRunAt > 0 && elapsed < agent.contract.cooldownMs) {
      const left = Math.ceil((agent.contract.cooldownMs - elapsed) / 60_000);
      return { ok: false, reason: "cooldown", detail: `${agent.brain.name} is cooling down (${left}m left)` };
    }
  }
  return { ok: true };
}

/**
 * Whether an unattended run of this agent may write to the vault.
 *
 * Only `act` writes. `propose` runs read-only in this milestone and reports the
 * changes it would make — the inert Proposal Kernel channel is a later phase,
 * and a tier that silently wrote in the meantime would break its own promise.
 */
export function writeModeFor(autonomy: AgentAutonomy): boolean {
  return autonomy === "act";
}

/** Report name for a run — also the automation-run record's name, so agent
 *  runs appear in the existing review/restore queue alongside playbooks. */
export function agentRunName(agent: AgentDef, reason: string): string {
  return `${agent.brain.name} (${reason})`;
}

/**
 * The prompt an unattended run receives.
 *
 * It states the trigger, the tier, and the scope, then hands off to the agent's
 * own definition — Exo never restates the agent's job, because the job lives in
 * the brain file the CLI already loads.
 */
export function buildAgentRunPrompt(agent: AgentDef, reason: string): string {
  const { brain, contract } = agent;
  // `null` marks a line that dropped out conditionally; "" is a deliberate blank.
  const lines: (string | null)[] = [
    `<agent-run trigger="${reason}">`,
    `This is an unattended, scheduled run of the "${brain.name}" agent. No human is watching; there is nobody to ask.`,
    `Delegate the work to that subagent: Agent({ subagent_type: "${brain.invocable}", prompt: <the standing task below> }).`,
    "",
    "Standing task: do this agent's regular job as defined in its own agent file. If nothing needs doing right now, say so in one line and stop — an empty run is a good outcome, not a failure to be filled with busywork.",
    "",
    contract.scope.read.length ? `Read scope: ${contract.scope.read.join(", ")}.` : null,
    writeModeFor(contract.autonomy)
      ? contract.scope.write.length
        ? `Write scope: ${contract.scope.write.join(", ")}. Never write outside it. Every write is snapshotted and restorable.`
        : "This agent has no declared write scope, so do not write anything — report instead."
      : contract.autonomy === "propose"
        ? "Autonomy tier `propose`: this run is READ-ONLY. Describe precisely what you would change (file, and what edit) and stop. Do not write."
        : "Autonomy tier `notify`: this run is READ-ONLY. Report findings only.",
    "",
    "Close with a short summary a human can scan in ten seconds.",
    "</agent-run>",
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}
