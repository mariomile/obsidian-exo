/**
 * Prompt surfaces for the memory layer: the short standing notes appended to the
 * boot preamble that tell the model which memory tools exist and when to use
 * them.
 *
 * WHY THIS FILE (2026-08-12): these three builders are pure string templates with
 * no `this`, no Obsidian, and exactly one call site each (`ensureSession` in
 * `view.ts`). They were module-level constants in `view.ts` only because that is
 * where the call site is. They belong next to `boot-content.ts` and
 * `context-assembly.ts`: this directory already owns what Exo injects and what it
 * costs, and the injected text is now editable without opening a 6.6k-line file.
 */

/** Prompt surface for the Memory Union Store — appended to the boot preamble only
 *  when the store tools are registered. Kept short: the tool descriptions carry
 *  the detail. */
export const memoryStoreNote = (storeDir: string): string =>
  "### Memory union store\n" +
  `A persistent, append-only memory store lives in \`${storeDir}/\` — verbatim preferences, facts, decisions, and lessons from past sessions. ` +
  "Call `recall` before answering anything that may depend on prior sessions instead of guessing, and use `remember` to store new durable statements in the user's exact words (never summarized).";

/** Variant used when proactive recall is ON: the plugin auto-injects the relevant
 *  memories, so the model no longer needs to *decide* to call `recall`. Kept short —
 *  `recall`/`remember` tool descriptions carry the detail. */
export const memoryStoreNoteProactive = (storeDir: string): string =>
  "### Memory union store\n" +
  `A persistent, append-only memory store lives in \`${storeDir}/\`. Relevant past memories are auto-provided each turn inside \`[recalled-memory]…[/recalled-memory]\` blocks — trusted verbatim context, but BACKGROUND from other sessions. ` +
  "When the user refers back to the running conversation ('continua', 'le altre cose proposte', 'quello sopra', 'as above', 'go on'), the referent is THIS conversation's own history — resolve it from the current thread, never from recalled memory or the boot `Recent sessions` digest. " +
  "Use `recall` for a deeper or explicit search (e.g. `as_of` point-in-time queries), and `remember` to store new durable statements in the user's exact words (never summarized).";

/** Prompt surface for the identity layer — appended when the agent folder is on
 *  and `rethink_memory` is registered. Explains WHEN to rethink (world-model
 *  change) vs `remember` (episodic), and the propose-only persona tier. */
export const agentFolderNote = (agentDir: string): string =>
  "### Identity — `rethink_memory`\n" +
  `Your identity lives in \`${agentDir}/\` (persona, human, now) and is already in your boot context above. ` +
  "Call `rethink_memory` only when your MODEL OF THE WORLD changes — a shifted priority (now.md), a durable update to how you understand the user (human.md, pass a rationale). NOT for episodic notes — those go to `remember`. " +
  "`persona.md` is propose-only: a `rethink_memory` on it records a proposal for the user to approve, it does not write.";
