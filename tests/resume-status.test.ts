import { describe, it, expect, vi } from "vitest";
import {
  projectDirName,
  resumeStatus,
  resumableFrom,
  type SessionFileProbe,
} from "../src/core/resume-status";

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

describe("resumableFrom", () => {
  /** A probe that records whether it ran, so the short-circuit guards can be
   *  asserted as such and not merely as "returned the right boolean anyway". */
  const probing = (result: SessionFileProbe) => vi.fn<() => SessionFileProbe>(() => result);
  const base = {
    provider: "claude",
    sessionId: "sess-1",
    vaultBase: "/Users/m/Vaults/marioverse.ai",
  };

  it("is resumable when the probe finds the session file", () => {
    expect(resumableFrom({ ...base, probe: probing("present") })).toBe(true);
  });

  it("is NOT resumable when the probe positively finds the file missing", () => {
    // The only input allowed to change behavior — the expired-session case that
    // used to send the model in with an id, no session, and no recap.
    expect(resumableFrom({ ...base, probe: probing("absent") })).toBe(false);
  });

  it("stays resumable when the probe itself failed (an error is not evidence)", () => {
    // Reading this as absence would prepend a recap to every turn of every
    // conversation for as long as the filesystem misbehaves.
    expect(resumableFrom({ ...base, probe: probing("failed") })).toBe(true);
  });

  it("is NOT resumable when no session was ever created, without probing", () => {
    // Distinct from the cases above: there is no id to look up. Asserting the
    // probe never ran is what proves the short-circuit, since a probe returning
    // "absent" would produce the same false for the wrong reason.
    const probe = probing("absent");
    expect(resumableFrom({ ...base, sessionId: undefined, probe })).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it("leaves a Codex conversation resumable, without probing", () => {
    // Its id is a ~/.codex thread: the Claude project directory would report it
    // missing and mark every Codex chat cold. The probe says "absent" here
    // precisely so the guard is what carries the assertion.
    const probe = probing("absent");
    expect(resumableFrom({ ...base, provider: "codex", probe })).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("leaves a conversation resumable when there is no vault base, without probing", () => {
    // "" would aim the lookup at ~/.claude/projects itself — readable, holds no
    // session file, and would answer "gone" with total confidence.
    const probe = probing("absent");
    expect(resumableFrom({ ...base, vaultBase: "", probe })).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });
});
