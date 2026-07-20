import { describe, expect, it, vi } from "vitest";
import type { AutomationConfig } from "../src/core/automations";
import { createDailyPulseAutomation } from "../src/core/daily-pulse";
import { buildObsidianTools } from "../src/obsidian/tools";

function toolHandler(app: unknown, name: string) {
  const definition = buildObsidianTools(app as never).find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Missing tool: ${name}`);
  return definition.handler;
}

function fakeApp(automations: AutomationConfig[]) {
  const exo = {
    settings: {
      automations,
      customPrompts: [{ name: "Daily Pulse", prompt: "User playbook" }],
      scheduledLastRun: {
        "system:daily-pulse": Date.now(),
      },
    },
    saveSettings: vi.fn(async () => undefined),
    loadAutomationRuns: vi.fn(async () => []),
    restoreAutomationRun: vi.fn(async () => []),
    markAutomationRunReviewed: vi.fn(async () => undefined),
    runPlaybook: vi.fn(async () => true),
  };
  return {
    app: { plugins: { plugins: { exo } } },
    exo,
  };
}

describe("automation tools with system automations", () => {
  it("uses the system persistence key and describes marker-safe Daily Pulse writes", async () => {
    const system = { ...createDailyPulseAutomation(), enabled: true };
    const { app } = fakeApp([system]);

    const result = await toolHandler(app, "list_automations")({}, {});
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain("writes _system/review.md (marker-safe)");
    expect(text).not.toContain("due now");
    expect(text).not.toContain("checkpointed, restorable");
  });

  it("never mutates a same-name system automation through playbook management", async () => {
    const system = { ...createDailyPulseAutomation(), enabled: true };
    const playbookAutomation: AutomationConfig = {
      name: "Daily Pulse",
      cadence: { kind: "weekly", day: 1, hour: 9 },
      enabled: true,
      write: false,
    };
    const { app, exo } = fakeApp([system, playbookAutomation]);

    await toolHandler(app, "manage_automation")({
      action: "pause",
      name: "Daily Pulse",
    }, {});

    expect(system.enabled).toBe(true);
    expect(playbookAutomation.enabled).toBe(false);
    expect(exo.saveSettings).toHaveBeenCalledTimes(1);
  });
});
