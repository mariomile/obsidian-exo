/**
 * CLI diagnostics + one-click update row for the settings pane. Extracted from
 * settings.ts, which sits at its size ceiling: these two helpers only ever
 * touched `this.plugin`, so they lose nothing by becoming free functions.
 */
import { Notice, Setting } from "obsidian";
import type ExoPlugin from "../main";
import { cliDiagnostics, updateClaudeCli } from "../cli";
import { compareSemver } from "../core/semver";

/** When the resolved Claude CLI is older than the latest known published
 *  version, offer a one-click `npm i -g …@latest` update (never auto-run). */
export function maybeRenderCliUpdate(
  plugin: ExoPlugin,
  containerEl: HTMLElement,
  currentVersion: string,
): void {
  const latest = plugin.settings.cliLatestKnown;
  if (!latest || compareSemver(currentVersion, latest) >= 0) return; // unknown or up to date
  const row = new Setting(containerEl)
    .setName(`Update available: ${latest}`)
    .setDesc("A newer Claude CLI has been published. Updating installs it into your global npm prefix.");
  row.addButton((b) =>
    b
      .setButtonText("Update")
      .setCta()
      .onClick(async () => {
        b.setButtonText("Updating…").setDisabled(true);
        new Notice("Updating Claude CLI…");
        const { ok, output } = await updateClaudeCli();
        if (ok) {
          new Notice(`Updated to ${latest} — restart sessions to pick it up.`);
          b.buttonEl.remove();
        } else {
          const tail = output.split("\n").filter(Boolean).slice(-4).join("\n");
          new Notice(`Claude CLI update failed:\n${tail || "unknown error"}`);
          b.setButtonText("Update").setDisabled(false);
        }
      })
  );
}

/** Resolve the configured CLI and print what it actually is, plus its version
 *  (async, never blocks render). Turns future binary-drift debugging into a
 *  5-second glance. */
export function renderCliDiagnostics(
  plugin: ExoPlugin,
  containerEl: HTMLElement,
  name: string,
  configured: string,
): void {
  const el = containerEl.createDiv({ cls: "setting-item-description mva-cli-diag" });
  el.setText("Resolving…");
  // Lazily run (or reuse) the daily update check for Claude, so the button
  // below can appear once both the resolved version and the latest are known.
  if (name === "claude") void plugin.maybeCheckCliUpdate();
  void cliDiagnostics(name, configured)
    .then((d) => {
      el.setText(
        d.found
          ? `Resolved: ${d.bin}${d.version ? ` — ${d.version}` : ""}`
          : "Not found — set the path explicitly"
      );
      if (name === "claude" && d.found && d.version) maybeRenderCliUpdate(plugin, containerEl, d.version);
    })
    .catch(() => el.setText("Not found — set the path explicitly"));
}
