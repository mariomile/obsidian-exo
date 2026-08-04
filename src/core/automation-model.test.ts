import { describe, expect, it } from "vitest";
import { parseWhen, formatWhen, parseAutomationFile, serializeAutomation } from "./automation-model";

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
