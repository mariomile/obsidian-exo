import { describe, it, expect } from "vitest";
import {
  exoPaths,
  detectMemoryRoot,
  DEFAULT_MEMORY_ROOT,
  LEGACY_MEMORY_ROOT,
} from "../src/core/paths";

describe("exoPaths", () => {
  it("derives every path from a fresh-install root", () => {
    const p = exoPaths("_exo");
    expect(p.root).toBe("_exo");
    expect(p.memory).toBe("_exo/memory");
    expect(p.store).toBe("_exo/memory/store");
    expect(p.tasks).toBe("_exo/orchestration/tasks.md");
    expect(p.queue).toBe("_exo/exo-queue");
    expect(p.vaultContext).toBe("_exo/vault-context.md");
    expect(p.preferences).toBe("_exo/memory/preferences/preferences.md");
    expect(p.agentDir).toBe("_exo/agent");
  });

  it("reproduces the exact legacy _system/ layout (marioverse must not move)", () => {
    const p = exoPaths(LEGACY_MEMORY_ROOT);
    expect(p.vaultContext).toBe("_system/vault-context.md");
    expect(p.store).toBe("_system/memory/store");
    expect(p.tasks).toBe("_system/orchestration/tasks.md");
    expect(p.queue).toBe("_system/exo-queue");
    expect(p.review).toBe("_system/review.md");
    expect(p.rules).toBe("_system/memory/rules");
    expect(p.knownFalse).toBe("_system/memory/known-false.md");
    expect(p.workflowSignals).toBe("_system/memory/workflow-signals.json");
  });

  it("falls back to the default root on empty input", () => {
    expect(exoPaths("").root).toBe(DEFAULT_MEMORY_ROOT);
  });

  it("trims trailing slashes from a user-entered root", () => {
    expect(exoPaths("MyMemory/").memory).toBe("MyMemory/memory");
  });
});

describe("detectMemoryRoot", () => {
  it("keeps _system/ for an existing install", () => {
    expect(detectMemoryRoot(true)).toBe(LEGACY_MEMORY_ROOT);
  });
  it("adopts _exo/ for a fresh vault", () => {
    expect(detectMemoryRoot(false)).toBe(DEFAULT_MEMORY_ROOT);
  });
});
