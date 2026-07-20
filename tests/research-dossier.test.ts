import { describe, expect, it, vi } from "vitest";
import { WriteQueue } from "../src/core/write-queue";
import {
  buildResearchDossier,
  researchDossierPath,
  writeResearchDossier,
  type ResearchDossierAdapter,
  type ResearchDossierRequest,
} from "../src/obsidian/research-dossier";

const receipt = {
  scope: "both" as const,
  depth: "standard" as const,
  startedAt: Date.parse("2026-07-20T09:00:00Z"),
  completedAt: Date.parse("2026-07-20T09:05:00Z"),
  status: "partial" as const,
  sources: [
    { kind: "vault" as const, label: "Active/Project Alpha", status: "consulted" as const },
    { kind: "web" as const, label: "Primary source", status: "failed" as const },
  ],
};

const request = (approved = true): ResearchDossierRequest => ({
  approved,
  date: "2026-07-20",
  question: "What's changed in Exo's research workflow?",
  response: [
    "The local design and current source disagree on one constraint.",
    "",
    "## Conflicts",
    "- The vault assumes A; the external source now specifies B.",
    "",
    "## Open questions",
    "- Should the local decision be revised?",
  ].join("\n"),
  receipt,
});

function memoryAdapter(): ResearchDossierAdapter & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    exists: async (path) => files.has(path) || path === "_system/reports",
    read: async (path) => files.get(path) ?? null,
    ensureDir: vi.fn(async () => undefined),
    write: vi.fn(async (path, content) => {
      files.set(path, content);
    }),
  };
}

describe("Research dossier", () => {
  it("builds the required deterministic reports path and safe slug", () => {
    expect(researchDossierPath(request())).toBe(
      "_system/reports/2026-07-20-whats-changed-in-exos-research-workflow.md"
    );
  });

  it("reproduces the question, response sections, and source receipt", () => {
    const body = buildResearchDossier(request());

    expect(body).toContain("## Question\n\nWhat's changed in Exo's research workflow?");
    expect(body).toContain("## Cited findings");
    expect(body).toContain("## Conflicts\n\n- The vault assumes A");
    expect(body).toContain("## Open questions\n\n- Should the local decision be revised?");
    expect(body).toContain("## Source receipt");
    expect(body).toContain("Vault · Checked · Active/Project Alpha");
    expect(body).toContain("Web · Failed · Primary source");
  });

  it("never writes without explicit approval", async () => {
    const adapter = memoryAdapter();
    const result = await writeResearchDossier(adapter, new WriteQueue(), request(false));

    expect(result).toEqual({ status: "skipped", reason: "approval-required" });
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it("serializes retry/double-click and returns the existing identical dossier", async () => {
    const adapter = memoryAdapter();
    const queue = new WriteQueue();
    const [first, retry] = await Promise.all([
      writeResearchDossier(adapter, queue, request()),
      writeResearchDossier(adapter, queue, request()),
    ]);

    expect(first).toMatchObject({ status: "saved", created: true });
    expect(retry).toEqual({
      status: "saved",
      path: researchDossierPath(request()),
      created: false,
    });
    expect(adapter.write).toHaveBeenCalledTimes(1);
  });

  it("uses a numbered path rather than overwriting different existing content", async () => {
    const adapter = memoryAdapter();
    adapter.files.set(researchDossierPath(request()), "different dossier");

    const result = await writeResearchDossier(adapter, new WriteQueue(), request());

    expect(result).toMatchObject({
      status: "saved",
      path: "_system/reports/2026-07-20-whats-changed-in-exos-research-workflow-2.md",
      created: true,
    });
  });
});
