import { describe, it, expect } from "vitest";
import {
  triggerClause,
  autonomyClause,
  outputClause,
  describeAgentAutomation,
  cadenceNote,
  spellDuration,
  AUTONOMY_CHOICES,
  OUTPUT_CHOICES,
} from "../src/core/agent-copy";
import { defaultContract, parseTrigger, type AgentContract } from "../src/core/agents";

const contract = (over: Partial<AgentContract> = {}, triggers: string[] = []): AgentContract => ({
  ...defaultContract("x"),
  triggers: triggers.map((t) => parseTrigger(t)!),
  ...over,
});

describe("triggerClause — no globs, no schema", () => {
  it("turns a folder glob into a folder name", () => {
    expect(triggerClause(parseTrigger("vault-event create _inbox/**")!)).toBe("When a note is added to _inbox");
    expect(triggerClause(parseTrigger("vault-event modify Active/**")!)).toBe("When a note in Active changes");
  });

  it("spells out schedules", () => {
    expect(triggerClause(parseTrigger("schedule hourly")!)).toBe("Every hour");
    expect(triggerClause(parseTrigger("schedule daily 08")!)).toBe("Every day at 08:00");
    expect(triggerClause(parseTrigger("schedule weekly mon 08")!)).toBe("Every Monday at 08:00");
  });

  it("reads a tag trigger as an action the user takes", () => {
    expect(triggerClause(parseTrigger("tag #needs/post")!)).toBe("When #needs/post is added to a note");
  });

  it("never leaks a glob into the sentence", () => {
    for (const t of ["vault-event create _inbox/**", "vault-event modify Atlas/People/**"]) {
      expect(triggerClause(parseTrigger(t)!)).not.toContain("*");
    }
  });
});

describe("autonomyClause", () => {
  it("says what it does, not what tier it is", () => {
    expect(autonomyClause(contract({ autonomy: "act", scope: { read: [], write: ["a/**"] } }))).toBe(
      "it makes the changes itself"
    );
    expect(autonomyClause(contract({ autonomy: "propose" }))).toBe("it suggests changes for you to accept");
    expect(autonomyClause(contract({ autonomy: "notify" }))).toBe("it only reports what it finds");
  });

  it("names the one combination that silently does nothing", () => {
    expect(autonomyClause(contract({ autonomy: "act", scope: { read: [], write: [] } }))).toContain(
      "nothing is writable"
    );
  });

  it("never uses the raw tier word", () => {
    for (const a of ["act", "propose", "notify"] as const) {
      expect(autonomyClause(contract({ autonomy: a }))).not.toMatch(/\b(act|propose|notify)\b/);
    }
  });
});

describe("outputClause", () => {
  it("describes the artefact, not the mode name", () => {
    expect(outputClause(contract({ output: "journal" }))).toContain("daily note");
    expect(outputClause(contract({ output: "report" }))).toContain("report note");
    expect(outputClause(contract({ output: "silent" }))).toBe("");
  });
});

describe("describeAgentAutomation", () => {
  it("reads as one sentence", () => {
    const c = contract(
      { autonomy: "act", output: "journal", scope: { read: [], write: ["_inbox/**"] } },
      ["vault-event create _inbox/**", "note-mention"]
    );
    expect(describeAgentAutomation(c)).toBe(
      "When a note is added to _inbox, it makes the changes itself and logs one line in your daily note."
    );
  });

  it("ignores note-mention when picking the lead — it is not why the agent is an automation", () => {
    const c = contract({ autonomy: "propose", output: "report" }, ["note-mention", "schedule daily 08"]);
    expect(describeAgentAutomation(c).startsWith("Every day at 08:00")).toBe(true);
  });

  it("falls back honestly when nothing fires on its own", () => {
    expect(describeAgentAutomation(contract({ autonomy: "notify", output: "silent" }))).toBe(
      "When you run it, it only reports what it finds."
    );
  });

  it("counts extra unattended triggers instead of listing them", () => {
    const c = contract({}, ["schedule daily 08", "vault-event create _inbox/**", "tag #x"]);
    expect(describeAgentAutomation(c)).toContain("(+2 more triggers)");
  });

  it("says +1 more trigger in the singular", () => {
    const c = contract({}, ["schedule daily 08", "tag #x"]);
    expect(describeAgentAutomation(c)).toContain("(+1 more trigger)");
  });

  it("drops the output clause entirely when silent", () => {
    const c = contract({ autonomy: "notify", output: "silent" }, ["schedule hourly"]);
    expect(describeAgentAutomation(c)).toBe("Every hour, it only reports what it finds.");
  });
});

describe("spellDuration / cadenceNote", () => {
  it("spells tokens into words", () => {
    expect(spellDuration(15 * 60_000)).toBe("15 min");
    expect(spellDuration(60 * 60_000)).toBe("1 hour");
    expect(spellDuration(2 * 3_600_000)).toBe("2 hours");
    expect(spellDuration(86_400_000)).toBe("1 day");
  });

  it("states the cooldown as a ceiling, not a frequency", () => {
    // "every 15m" reads as "it runs every 15 minutes", which is the opposite.
    expect(cadenceNote(contract({ cooldownMs: 15 * 60_000 }))).toBe("At most once every 15 min.");
  });
});

describe("control choices", () => {
  it("every option has a plain label and a hint, and never names its own value", () => {
    for (const c of [...AUTONOMY_CHOICES, ...OUTPUT_CHOICES]) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.hint.length).toBeGreaterThan(0);
      expect(c.label.toLowerCase()).not.toBe(c.value);
    }
  });

  it("covers every tier and every output mode", () => {
    expect(AUTONOMY_CHOICES.map((c) => c.value).sort()).toEqual(["act", "notify", "propose"]);
    expect(OUTPUT_CHOICES.map((c) => c.value).sort()).toEqual(["journal", "report", "silent"]);
  });
});
