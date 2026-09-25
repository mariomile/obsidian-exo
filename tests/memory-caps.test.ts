import { describe, it, expect } from "vitest";
import { memoryCaps, type MemorySettings } from "../src/core/memory-caps";
import { DEFAULT_SETTINGS } from "../src/settings-schema";

const ON: MemorySettings = {
  memoryReadEnabled: true,
  memoryWriteEnabled: true,
  agentFolderEnabled: true,
  autoMemory: true,
  backgroundPassesEnabled: true,
};

describe("memoryCaps", () => {
  it("everything on in a chat grants every capability", () => {
    expect(memoryCaps(ON, { surface: "chat" })).toEqual({
      bootRead: true,
      identity: true,
      ledgerWrite: true,
      rethink: true,
      autoCapture: true,
      autoRecall: true,
      chatSearch: true,
      undo: true,
    });
  });

  it("defaults: automatic memory ON for every user, identity OFF", () => {
    const caps = memoryCaps(DEFAULT_SETTINGS, { surface: "chat" });
    expect(DEFAULT_SETTINGS.autoMemory).toBe(true);
    expect(caps.autoCapture).toBe(true);
    expect(caps.autoRecall).toBe(true);
    expect(caps.identity).toBe(false);
    expect(caps.rethink).toBe(false);
  });

  it("headless runs read memory but never write, capture or recall", () => {
    const caps = memoryCaps(ON, { surface: "headless" });
    expect(caps.bootRead).toBe(true);
    expect(caps.chatSearch).toBe(true);
    expect(caps.ledgerWrite).toBe(false);
    expect(caps.rethink).toBe(false);
    expect(caps.undo).toBe(false);
    expect(caps.autoCapture).toBe(false);
    expect(caps.autoRecall).toBe(false);
  });

  it("a read-only sandbox drops every write tool but keeps reads", () => {
    const caps = memoryCaps(ON, { surface: "chat", readOnlySandbox: true });
    expect(caps.ledgerWrite).toBe(false);
    expect(caps.rethink).toBe(false);
    expect(caps.undo).toBe(false);
    expect(caps.chatSearch).toBe(true);
  });

  it("autoMemory off turns off capture and recall only", () => {
    const caps = memoryCaps({ ...ON, autoMemory: false }, { surface: "chat" });
    expect(caps.autoCapture).toBe(false);
    expect(caps.autoRecall).toBe(false);
    expect(caps.ledgerWrite).toBe(true);
    expect(caps.bootRead).toBe(true);
  });

  it("the background master switch stops capture (it spends tokens), not recall", () => {
    const caps = memoryCaps({ ...ON, backgroundPassesEnabled: false }, { surface: "chat" });
    expect(caps.autoCapture).toBe(false);
    expect(caps.autoRecall).toBe(true);
  });

  it("memory write off stops capture and every write tool", () => {
    const caps = memoryCaps({ ...ON, memoryWriteEnabled: false }, { surface: "chat" });
    expect(caps.autoCapture).toBe(false);
    expect(caps.ledgerWrite).toBe(false);
    expect(caps.undo).toBe(false);
    expect(caps.autoRecall).toBe(true);
  });

  it("memory read off stops boot, identity, recall and chat search", () => {
    const caps = memoryCaps({ ...ON, memoryReadEnabled: false }, { surface: "chat" });
    expect(caps.bootRead).toBe(false);
    expect(caps.identity).toBe(false);
    expect(caps.autoRecall).toBe(false);
    expect(caps.chatSearch).toBe(false);
    expect(caps.autoCapture).toBe(true);
  });
});
