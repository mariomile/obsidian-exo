import { describe, it, expect } from "vitest";
import { projectDirName, resumeStatus } from "../src/core/resume-status";

describe("projectDirName", () => {
  it("replaces every non-alphanumeric character with a dash", () => {
    // Both verified against real directories on disk before this plan was written.
    expect(projectDirName("/Users/mariomiletta/Vaults/marioverse.ai")).toBe(
      "-Users-mariomiletta-Vaults-marioverse-ai",
    );
    expect(projectDirName("/Users/mariomiletta/Dev Projects/obsidian-exo")).toBe(
      "-Users-mariomiletta-Dev-Projects-obsidian-exo",
    );
  });

  it("collapses nothing — each character maps to exactly one dash", () => {
    // A path with two adjacent non-alphanumerics must yield two dashes, not one.
    // Collapsing would silently point at the wrong directory.
    expect(projectDirName("/a//b")).toBe("-a--b");
  });

  it("leaves an already-safe segment untouched", () => {
    expect(projectDirName("abc123")).toBe("abc123");
  });
});

describe("resumeStatus", () => {
  const onDisk = new Set(["sess-alive"]);

  it("is resumable when the conversation's session file is on disk", () => {
    expect(resumeStatus({ sessionId: "sess-alive" }, onDisk)).toBe("resumable");
  });

  it("restarts when the session id points at a file that is gone", () => {
    expect(resumeStatus({ sessionId: "sess-expired" }, onDisk)).toBe("restarts");
  });

  it("restarts when the conversation never had a session at all", () => {
    // The c126/c147 case: the turn never produced a reply, so the CLI never
    // created a session. Same consequence for the user as an expired one.
    expect(resumeStatus({ sessionId: undefined }, onDisk)).toBe("restarts");
    expect(resumeStatus({}, onDisk)).toBe("restarts");
  });

  it("is unknown when the on-disk set could not be read", () => {
    // R2, the load-bearing case: a failed directory read must never be
    // reported as "everything restarts". Unknown is its own answer.
    expect(resumeStatus({ sessionId: "sess-alive" }, null)).toBe("unknown");
    expect(resumeStatus({ sessionId: undefined }, null)).toBe("unknown");
  });
});
