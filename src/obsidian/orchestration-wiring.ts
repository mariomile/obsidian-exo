/**
 * The impure half of plugin-level orchestration: turns an `ExoPlugin` into the
 * `OrchestrationDeps` the runtime consumes. Everything that needs `obsidian` or
 * `ChatView` lives here, so `orchestration.ts` (the lifecycle) and
 * `orchestrator-driver.ts` (the controller) stay import-free and testable.
 */
import { Notice } from "obsidian";
import type ExoPlugin from "../main";
import { VIEW_TYPE } from "../view";
import * as convoBridge from "../ui/convo-bridge";
import { OrchestrationRuntime, type OrchestrationDeps } from "./orchestration";

/**
 * Can a task conversation be started right now?
 *
 * Three states, and only the middle one is a "no":
 *  - a ChatView is mounted → yes;
 *  - a ChatView leaf exists but is still DEFERRED (restored from the saved
 *    layout, never activated) → **no**. `convoBridge.chatView` returns null and
 *    kicks `loadIfDeferred()`, so asking again shortly is what materialises it.
 *    Spawning now would get "" back and burn the task as a failure;
 *  - no leaf at all → yes: `startTaskConversation` creates one on demand
 *    (hidden, no focus steal), exactly as it always has.
 *
 * Gated on `layoutReady` first: before it, creating a sidebar leaf races
 * Obsidian's own workspace restore.
 */
function canHostConversation(plugin: ExoPlugin): boolean {
  const { workspace } = plugin.app;
  if (!workspace.layoutReady) return false;
  if (convoBridge.chatView(plugin.app)) return true;
  return workspace.getLeavesOfType(VIEW_TYPE).length === 0;
}

export function createOrchestration(plugin: ExoPlugin): OrchestrationRuntime {
  const deps: OrchestrationDeps = {
    enabled: () => plugin.settings.orchestrationEnabled,
    store: {
      load: () => plugin.taskStore.load(),
      update: (id, patch) => plugin.taskStore.update(id, patch),
      move: (id, status, order) => plugin.taskStore.move(id, status, order),
      archive: (id) => plugin.taskStore.archive(id),
    },
    subscribe: (listener) => plugin.onConvoState(listener),
    spawn: (prompt, opts) => plugin.startTaskConversation(prompt, opts),
    liveness: (convoId) => {
      const s = plugin.readConvoState(convoId);
      return { exists: s.exists, streaming: s.streaming, pendingRequest: s.hasPending };
    },
    config: () => ({ maxConcurrent: Math.max(1, plugin.settings.orchestrationMaxConcurrent) }),
    notify: (message) => new Notice(message),
    lastAssistantText: (convoId) => plugin.lastAssistantTextOf(convoId),
    onChildReport: (report) => plugin.deliverChildReport(report),
    canSpawn: () => canHostConversation(plugin),
    onHostSignal: (cb) => {
      const { workspace } = plugin.app;
      const refs = [workspace.on("layout-change", cb), workspace.on("active-leaf-change", cb)];
      return () => {
        for (const ref of refs) workspace.offref(ref);
      };
    },
    watchLedger: (cb) => {
      const { vault } = plugin.app;
      const hit = (path: string) => {
        if (path === plugin.paths.tasks) cb();
      };
      const refs = [
        vault.on("modify", (file) => hit(file.path)),
        vault.on("create", (file) => hit(file.path)),
      ];
      return () => {
        for (const ref of refs) vault.offref(ref);
      };
    },
  };
  return new OrchestrationRuntime(deps);
}
