/**
 * Memory union store settings: proactive recall + observer cadence. Extracted
 * from settings.ts, which sits at its size ceiling — this block only ever
 * touched `plugin.settings` and a redraw callback, so it loses nothing by
 * becoming a free function (same pattern as settings-cli.ts).
 */
import { Setting } from "obsidian";
import type ExoPlugin from "../main";

/** Proactive recall (+ its per-turn count) and observer cadence (+ its step
 *  interval) — all act on the Memory Union Store, so the caller only renders
 *  this while `memoryStoreEnabled` is on. `redraw` re-renders the tab so the
 *  dependent fields (recall count, step interval) show/hide correctly. */
export function renderRecallSettings(plugin: ExoPlugin, el: HTMLElement, redraw: () => void): void {
  const s = plugin.settings;

  new Setting(el)
    .setName("Proactive recall")
    .setDesc(
      "Before each message is sent, surface the most relevant stored memories into the turn automatically — so the agent no longer has to decide to call recall. Deduped per conversation and relevance-gated, so irrelevant turns cost nothing. On by default; needs Read vault memory."
    )
    .addToggle((t) =>
      t.setValue(s.proactiveRecall).onChange(async (v) => {
        s.proactiveRecall = v;
        await plugin.saveSettings();
        redraw(); // show/hide the per-turn count field
      })
    );

  if (s.proactiveRecall) {
    new Setting(el)
      .setName("Proactive recall — memories per turn")
      .setDesc("How many relevant memories to inject at most, per message.")
      .addText((t) =>
        t
          .setPlaceholder("3")
          .setValue(String(s.proactiveRecallK))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n > 0) s.proactiveRecallK = n;
            await plugin.saveSettings();
          })
      );
  }

  new Setting(el)
    .setName("Observer cadence")
    .setDesc(
      "When self-writing memory captures. \"End of turn\" (default) is the behavior above, unchanged. \"Every N tool-call steps\" ALSO flushes a delta capture partway through a long, tool-call-heavy turn — so context isn't lost waiting for it to finish — then the end-of-turn pass only covers whatever's left. Step passes respect the background-AI budget below."
    )
    .addDropdown((d) =>
      d
        .addOptions({ "session-end": "End of turn", "every-n-steps": "Every N tool-call steps" })
        .setValue(s.observerCadence)
        .onChange(async (v) => {
          s.observerCadence = v as "session-end" | "every-n-steps";
          await plugin.saveSettings();
          redraw();
        })
    );

  if (s.observerCadence === "every-n-steps") {
    new Setting(el)
      .setName("Observer step interval")
      .setDesc("Flush a delta capture every this many tool-call steps within a conversation.")
      .addText((t) =>
        t
          .setPlaceholder("25")
          .setValue(String(s.observerStepInterval))
          .onChange(async (v) => {
            const n = Number.parseInt(v, 10);
            if (Number.isFinite(n) && n > 0) s.observerStepInterval = n;
            await plugin.saveSettings();
          })
      );
  }
}
