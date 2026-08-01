import { describe, it, expect } from "vitest";
import { hasSeed, seededContract } from "../src/core/agent-seeds";
import { defaultContract } from "../src/core/agents";

const KNOWN = [
  "inbox-triager",
  "vault-librarian",
  "memory-keeper",
  "research-analyst",
  "knowledge-compiler",
  "ghostwriter",
  "crm-keeper",
  "strategy-advisor",
  "career-coach",
];

describe("seededContract — the safety invariant", () => {
  it("NEVER enables an agent, for any slug", () => {
    for (const slug of [...KNOWN, "totally-unknown", ""]) {
      expect(seededContract(slug).enabled).toBe(false);
    }
  });

  it("never seeds a write scope — blast radius is the vault owner's call", () => {
    for (const slug of KNOWN) {
      expect(seededContract(slug).scope.write).toEqual([]);
    }
  });

  it("never seeds the `act` tier", () => {
    for (const slug of KNOWN) {
      expect(seededContract(slug).autonomy).not.toBe("act");
    }
  });

  it("never seeds a self-call", () => {
    for (const slug of KNOWN) {
      expect(seededContract(slug).canCall).not.toContain(slug);
    }
  });
});

describe("seededContract — content", () => {
  it("every known agent gets at least one trigger, and all of them parse", () => {
    for (const slug of KNOWN) {
      const c = seededContract(slug);
      expect(c.triggers.length).toBeGreaterThan(0);
      expect(c.triggers.every((t) => typeof t.on === "string")).toBe(true);
    }
  });

  it("every seed includes note-mention — a human-initiated way in", () => {
    for (const slug of KNOWN) {
      expect(seededContract(slug).triggers.some((t) => t.on === "note-mention")).toBe(true);
    }
  });

  it("the inbox triager watches _inbox and proposes rather than acts", () => {
    const c = seededContract("inbox-triager");
    expect(c.autonomy).toBe("propose");
    const evt = c.triggers.find((t) => t.on === "vault-event");
    expect(evt).toMatchObject({ event: "create", path: "_inbox/**" });
  });

  it("the librarian and the memory keeper are the only scheduled seeds", () => {
    const scheduled = KNOWN.filter((s) => seededContract(s).triggers.some((t) => t.on === "schedule"));
    expect(scheduled.sort()).toEqual(["memory-keeper", "vault-librarian"]);
  });

  it("seeds the one meaningful delegation chain", () => {
    expect(seededContract("strategy-advisor").canCall).toEqual(["research-analyst"]);
    expect(seededContract("research-analyst").canCall).toEqual([]);
  });

  it("gives an unknown agent the generic seed, not an empty contract", () => {
    const c = seededContract("some-new-agent");
    expect(hasSeed("some-new-agent")).toBe(false);
    expect(c.triggers.map((t) => t.on)).toEqual(["note-mention"]);
    expect(c.autonomy).toBe(defaultContract("x").autonomy);
  });

  it("recognises the marioverse set", () => {
    for (const slug of KNOWN) expect(hasSeed(slug)).toBe(true);
  });

  it("parses seeded cooldowns into real durations", () => {
    expect(seededContract("inbox-triager").cooldownMs).toBe(15 * 60_000);
    expect(seededContract("vault-librarian").cooldownMs).toBe(6 * 3_600_000);
  });
});
