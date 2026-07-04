import { describe, it, expect } from "vitest";
import { permDotRisk } from "../src/core/perm-dot";

describe("permDotRisk — Claude permission modes", () => {
  it("maps bypass to danger", () => {
    expect(permDotRisk("claude", "bypassPermissions")).toBe("is-danger");
  });
  it("maps acceptEdits and auto to caution", () => {
    expect(permDotRisk("claude", "acceptEdits")).toBe("is-caution");
    expect(permDotRisk("claude", "auto")).toBe("is-caution");
  });
  it("maps default, ask, and plan to ok", () => {
    expect(permDotRisk("claude", "default")).toBe("is-ok");
    expect(permDotRisk("claude", "plan")).toBe("is-ok");
  });
  it("falls back to ok for unknown modes", () => {
    expect(permDotRisk("claude", "something-else")).toBe("is-ok");
  });
});

describe("permDotRisk — Codex sandbox modes", () => {
  it("maps full-access to danger", () => {
    expect(permDotRisk("codex", "danger-full-access")).toBe("is-danger");
  });
  it("maps workspace-write to caution", () => {
    expect(permDotRisk("codex", "workspace-write")).toBe("is-caution");
  });
  it("maps read-only to ok", () => {
    expect(permDotRisk("codex", "read-only")).toBe("is-ok");
  });
});
