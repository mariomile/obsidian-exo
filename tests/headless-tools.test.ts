import { describe, it, expect } from "vitest";
import { isReadOnlyExternalTool } from "../src/core/headless-tools";

describe("isReadOnlyExternalTool", () => {
  it("allows real read tools from the connected servers", () => {
    for (const t of [
      "mcp__claude_ai_Gmail__search_threads",
      "mcp__claude_ai_Gmail__get_message",
      "mcp__claude_ai_Gmail__get_thread",
      "mcp__claude_ai_Gmail__list_labels",
      "mcp__claude_ai_Slack__slack_read_channel",
      "mcp__claude_ai_Slack__slack_read_thread",
      "mcp__claude_ai_Slack__slack_search_public_and_private",
      "mcp__claude_ai_Slack__slack_search_users",
      "mcp__claude_ai_Google_Calendar__list_events",
      "mcp__claude_ai_Google_Calendar__get_event",
      "mcp__claude_ai_Google_Calendar__search_events",
      "mcp__claude_ai_Readwise__search",
      "mcp__claude_ai_Notion__notion-search",
      "mcp__claude_ai_Notion__notion-fetch",
    ]) {
      expect(isReadOnlyExternalTool(t), t).toBe(true);
    }
  });

  it("denies real mutating tools even when they sound harmless", () => {
    for (const t of [
      "mcp__claude_ai_Gmail__create_draft",
      "mcp__claude_ai_Gmail__label_message",
      "mcp__claude_ai_Gmail__apply_sensitive_thread_label",
      "mcp__claude_ai_Slack__slack_send_message",
      "mcp__claude_ai_Slack__slack_add_reaction",
      "mcp__claude_ai_Slack__slack_schedule_message",
      "mcp__claude_ai_Google_Calendar__create_event",
      "mcp__claude_ai_Google_Calendar__respond_to_event",
      "mcp__claude_ai_Google_Calendar__update_event",
      "mcp__claude_ai_Notion__notion-create-pages",
      "mcp__claude_ai_Notion__notion-update-page",
      "mcp__claude_ai_Stripe__authenticate",
      "mcp__claude_ai_Exa__complete_authentication",
    ]) {
      expect(isReadOnlyExternalTool(t), t).toBe(false);
    }
  });

  it("denies mixed names where a read verb coexists with a mutating one", () => {
    // "get_or_create_x" style: the mutating verb must win.
    expect(isReadOnlyExternalTool("mcp__srv__get_or_create_page")).toBe(false);
    expect(isReadOnlyExternalTool("mcp__srv__search_and_replace")).toBe(false);
  });

  it("denies ambiguous names with no recognized read verb", () => {
    expect(isReadOnlyExternalTool("mcp__srv__do_something")).toBe(false);
    expect(isReadOnlyExternalTool("mcp__srv__process")).toBe(false);
  });

  it("handles camelCase and kebab-case boundaries", () => {
    expect(isReadOnlyExternalTool("mcp__srv__listItems")).toBe(true);
    expect(isReadOnlyExternalTool("mcp__srv__createItem")).toBe(false);
    expect(isReadOnlyExternalTool("mcp__srv__read-page")).toBe(true);
  });

  it("is out of scope for non-MCP and obsidian in-process tools", () => {
    expect(isReadOnlyExternalTool("Read")).toBe(false);
    expect(isReadOnlyExternalTool("Bash")).toBe(false);
    expect(isReadOnlyExternalTool("mcp__obsidian__search_vault")).toBe(false);
  });
});
