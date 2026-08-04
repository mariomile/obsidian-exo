import { describe, expect, it } from "vitest";
import { runsForSlug, legacyRuns } from "./automations";
import { parseWhen, formatWhen, parseAutomationFile, serializeAutomation, automationFromPlaybook, automationFromAgent, contractFromAutomation, legacyConfigFromAutomation } from "./automation-model";

describe("when grammar", () => {
  it("parses schedules", () => {
    expect(parseWhen("hourly")).toEqual({ on: "schedule", cadence: { kind: "hourly" } });
    expect(parseWhen("daily 07:00")).toEqual({ on: "schedule", cadence: { kind: "daily", hour: 7 } });
    expect(parseWhen("daily 7")).toEqual({ on: "schedule", cadence: { kind: "daily", hour: 7 } });
    expect(parseWhen("weekly mon 07:00")).toEqual({ on: "schedule", cadence: { kind: "weekly", day: 1, hour: 7 } });
    expect(parseWhen("weekly lunedì 8")).toEqual({ on: "schedule", cadence: { kind: "weekly", day: 1, hour: 8 } });
  });

  it("parses events and tags", () => {
    expect(parseWhen("on create in _inbox/")).toEqual({ on: "vault-event", event: "create", path: "_inbox/**" });
    expect(parseWhen("on modify in Journal/Daily")).toEqual({ on: "vault-event", event: "modify", path: "Journal/Daily/**" });
    expect(parseWhen("on tag #todo")).toEqual({ on: "tag", tag: "todo" });
  });

  it("rejects garbage", () => {
    expect(parseWhen("daily 25:00")).toBeNull();
    expect(parseWhen("whenever")).toBeNull();
  });

  it("round-trips through formatWhen", () => {
    for (const s of ["hourly", "daily 07:00", "weekly mon 07:00", "on create in _inbox/**", "on tag #todo"]) {
      const w = parseWhen(s);
      expect(w).not.toBeNull();
      expect(parseWhen(formatWhen(w!))).toEqual(w);
    }
  });
});

describe("file round-trip", () => {
  it("parses and re-serializes stably", () => {
    const raw = [
      "---",
      "name: Inbox Triager",
      "description: Files _inbox notes",
      "icon: inbox",
      "when:",
      '  - "on create in _inbox/**"',
      "mode: act",
      "scope: [_inbox, Atlas]",
      "agent: inbox-triager",
      "cooldown: 15m",
      "enabled: true",
      "---",
      "",
      "Triage the inbox.",
      "",
    ].join("\n");
    const { automation, warnings } = parseAutomationFile("inbox-triager", raw);
    expect(warnings).toEqual([]);
    expect(automation.mode).toBe("act");
    expect(automation.when).toEqual([{ on: "vault-event", event: "create", path: "_inbox/**" }]);
    expect(automation.scope).toEqual(["_inbox", "Atlas"]);
    expect(automation.agent).toBe("inbox-triager");
    expect(automation.prompt).toBe("Triage the inbox.");
    const again = parseAutomationFile("inbox-triager", serializeAutomation(automation));
    expect(again.warnings).toEqual([]);
    expect(again.automation).toEqual(automation);
  });

  it("degrades unparseable when-lines to warnings, never drops the automation", () => {
    const raw = "---\nname: X\nwhen:\n  - nonsense\nenabled: true\n---\nBody";
    const { automation, warnings } = parseAutomationFile("x", raw);
    expect(automation.when).toEqual([]);
    expect(warnings.length).toBe(1);
  });

  it("defaults sanely on a minimal file", () => {
    const { automation } = parseAutomationFile("bare", "---\nname: Bare\n---\nDo it.");
    expect(automation.mode).toBe("report");
    expect(automation.icon).toBe("zap");
    expect(automation.enabled).toBe(false);
    expect(automation.when).toEqual([]);
    expect(automation.cooldownMs).toBe(15 * 60_000);
  });
});

describe("migration mapping", () => {
  it("maps a playbook automation to a file automation", () => {
    const a = automationFromPlaybook(
      { name: "Morning Digest", cadence: { kind: "daily", hour: 7 }, enabled: true, write: true },
      "Summarize the day.",
    );
    expect(a.slug).toBe("morning-digest");
    expect(a.mode).toBe("act");
    expect(a.when).toEqual([{ on: "schedule", cadence: { kind: "daily", hour: 7 } }]);
    expect(a.prompt).toBe("Summarize the day.");
    expect(a.enabled).toBe(true);
  });

  it("keeps the daily-pulse system key", () => {
    const a = automationFromPlaybook(
      { name: "Daily Pulse", system: "daily-pulse", cadence: { kind: "daily", hour: 8 }, enabled: false, write: false },
      "",
    );
    expect(a.system).toBe("daily-pulse");
    expect(a.mode).toBe("report");
  });

  it("maps an agent contract, dropping note-mention", () => {
    const def = {
      brain: { slug: "inbox-triager", name: "Inbox Triager", invocable: "Inbox Triager", description: "Files inbox notes", source: "vault" as const },
      contract: {
        slug: "inbox-triager", enabled: true, icon: "inbox", autonomy: "act" as const, output: "journal" as const,
        cooldownMs: 15 * 60_000, scope: { read: ["_inbox/**"], write: ["_inbox/**", "Atlas/**"] }, canCall: [],
        triggers: [
          { on: "vault-event" as const, event: "create" as const, path: "_inbox/**" },
          { on: "note-mention" as const },
        ],
      },
    };
    const a = automationFromAgent(def);
    expect(a).not.toBeNull();
    expect(a!.agent).toBe("inbox-triager");
    expect(a!.mode).toBe("act");
    expect(a!.when).toEqual([{ on: "vault-event", event: "create", path: "_inbox/**" }]);
    expect(a!.scope).toEqual(["_inbox/**", "Atlas/**"]);
    expect(a!.icon).toBe("inbox");
    expect(a!.description).toBe("Files inbox notes");
  });

  it("returns null for mention-only agents", () => {
    const def = {
      brain: { slug: "helper", name: "Helper", invocable: "Helper", source: "vault" as const },
      contract: {
        slug: "helper", enabled: true, icon: "bot", autonomy: "notify" as const, output: "report" as const,
        cooldownMs: 0, scope: { read: [], write: [] }, canCall: [], triggers: [{ on: "note-mention" as const }],
      },
    };
    expect(automationFromAgent(def)).toBeNull();
  });
});

describe("executor bridges", () => {
  const auto = (over: Partial<import("./automation-model").Automation>) => ({
    slug: "x", name: "X", description: "", icon: "zap",
    when: [], mode: "report" as const, scope: [], canCall: [], cooldownMs: 15 * 60_000,
    enabled: true, prompt: "Do it.", ...over,
  });

  it("synthesizes a contract from an automation", () => {
    const c = contractFromAutomation(auto({
      mode: "act", scope: ["_inbox/**"],
      when: [{ on: "vault-event", event: "create", path: "_inbox/**" }],
    }));
    expect(c.autonomy).toBe("act");
    expect(c.output).toBe("journal");
    expect(c.triggers).toEqual([{ on: "vault-event", event: "create", path: "_inbox/**" }]);
    expect(c.scope.write).toEqual(["_inbox/**"]);
    expect(c.enabled).toBe(true);
  });

  it("report mode maps to notify autonomy with report output", () => {
    const c = contractFromAutomation(auto({}));
    expect(c.autonomy).toBe("notify");
    expect(c.output).toBe("report");
  });

  it("builds a legacy config for slot runners", () => {
    const cfg = legacyConfigFromAutomation(auto({
      system: "daily-pulse",
      when: [{ on: "schedule", cadence: { kind: "daily", hour: 8 } }],
    }));
    expect(cfg).toEqual({ name: "X", system: "daily-pulse", cadence: { kind: "daily", hour: 8 }, enabled: true, write: false });
    expect(legacyConfigFromAutomation(auto({}))).toBeNull();
  });
});

describe("run buckets", () => {
  const rec = (over: Partial<import("./automations").AutomationRunRecord>) => ({
    id: "r", name: "X", startedAt: 1, ok: true, reportPath: "", writes: [], checkpoint: [] as [string, string | null][], ...over,
  });
  it("splits per-slug and legacy runs", () => {
    const records = [rec({ id: "a", slug: "x", startedAt: 1 }), rec({ id: "b", slug: "x", startedAt: 5 }), rec({ id: "c" })];
    expect(runsForSlug(records, "x").map((r) => r.id)).toEqual(["b", "a"]);
    expect(legacyRuns(records).map((r) => r.id)).toEqual(["c"]);
  });
});
