/**
 * Turn-output classification for the workflow foundry — pure, Obsidian-free.
 *
 * Extracted from `view.ts`'s `maybeRecordWorkflowSignal`, where it sat inline as
 * a five-branch ternary ladder over two multiline regexes. That made it
 * unverifiable: `view.ts` has no behavioural tests (it is 7k+ lines of one
 * class), so the rules deciding whether a turn becomes a reusable playbook
 * signal — and whether it is `sensitive` enough to suppress — were shipped on
 * inspection alone. Here they are ordinary functions with ordinary tests.
 *
 * The caller keeps the impure half: reading `ctx.segments`/`ctx.fullText` and
 * feeding the result to `evaluateWorkflowEligibility`.
 */

import { WRITE_TOOLS } from "./touched";
import { isReadOnlyExternalTool } from "./headless-tools";
import type { WorkflowOutputType } from "./workflow-signals";

/** The minimal shape this module needs off a turn's tool segments — deliberately
 *  narrower than `Segment` so tests don't have to build whole transcripts. */
export interface ClassifiableTool {
  name: string;
}

export interface TurnOutputClassification {
  toolNames: string[];
  /** The turn produced a rendered artifact segment. */
  hasArtifact: boolean;
  /** At least one tool wrote to the vault. */
  hasVaultWrite: boolean;
  /** Output carries reusable structure (artifact, vault write, or markdown
   *  structure: headings, tables, json/csv fences, task list items). */
  structuredOutput: boolean;
  outputType: WorkflowOutputType;
  /** The turn touched something with side effects beyond the vault's read
   *  surface — shells, writes, or a non-Obsidian MCP tool that isn't read-only.
   *  Suppresses signal capture. */
  sensitive: boolean;
}

/** Structure that makes an output reusable rather than conversational: an ATX
 *  heading, a table row, a json/csv fence, or a task-list item. */
const STRUCTURED_RE = /(?:^|\n)(?:#{1,3}\s|\|.+\||```(?:json|csv)|[-*]\s+\[[ xX]\])/m;

/** Weaker than STRUCTURED_RE: any heading, bullet, or ordered item. Only
 *  consulted once `structuredOutput` is already false, to separate "prose with
 *  some markdown" from a plain chat reply. */
const MARKDOWN_RE = /(?:^|\n)(?:#{1,3}\s|[-*]\s|\d+\.\s)/m;

/** A tool whose effects reach outside the vault's read surface. `mcp__obsidian__`
 *  is exempt (it is the vault itself) and so is any external MCP tool the
 *  read-only allowlist recognises. */
export function isSensitiveTool(name: string): boolean {
  if (name === "Bash" || name === "Shell") return true;
  if (WRITE_TOOLS.test(name)) return true;
  return name.startsWith("mcp__") && !name.startsWith("mcp__obsidian__") && !isReadOnlyExternalTool(name);
}

/**
 * Classify what a completed turn produced.
 *
 * Order matters and is load-bearing: `artifact` beats `vault-write` beats
 * `structured` beats `markdown` beats `message`, because the earlier kinds are
 * strictly stronger evidence that the turn is worth replaying as a playbook.
 */
export function classifyTurnOutput(
  tools: readonly ClassifiableTool[],
  fullText: string,
  hasArtifact: boolean,
): TurnOutputClassification {
  const toolNames = tools.map((t) => t.name);
  const hasVaultWrite = tools.some((t) => WRITE_TOOLS.test(t.name));
  const structuredOutput = hasArtifact || hasVaultWrite || STRUCTURED_RE.test(fullText);
  const outputType: WorkflowOutputType = hasArtifact
    ? "artifact"
    : hasVaultWrite
      ? "vault-write"
      : structuredOutput
        ? "structured"
        : MARKDOWN_RE.test(fullText)
          ? "markdown"
          : "message";
  return {
    toolNames,
    hasArtifact,
    hasVaultWrite,
    structuredOutput,
    outputType,
    sensitive: tools.some((t) => isSensitiveTool(t.name)),
  };
}
