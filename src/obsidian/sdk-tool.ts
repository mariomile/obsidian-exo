import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * An SDK tool with its input shape erased, so tools of different shapes can
 * share one list. `handler` takes `never`: parameters are contravariant, so
 * every concrete handler is assignable to it. The one caller that invokes it
 * directly (the Codex bridge) validates input against `inputSchema` first.
 */
export type AnyTool = Omit<SdkMcpToolDefinition, "handler"> & {
  handler: (args: never, extra: unknown) => Promise<CallToolResult>;
};

/** Hand an erased list back to the SDK, which types `tools` per shape. */
export const toSdkTools = (tools: AnyTool[]): SdkMcpToolDefinition[] => tools as SdkMcpToolDefinition[];
