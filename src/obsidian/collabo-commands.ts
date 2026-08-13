/**
 * Exo Collabo commands. They live here rather than in main.ts because main.ts
 * is at its size ceiling and this feature is self-contained: it needs the
 * plugin only for settings, the active file, and saveSettings.
 *
 * `shareNote` is separated from the command wiring so the interesting behaviour
 * (create once, reuse forever, persist the mapping) is testable without an app.
 */
import { FuzzySuggestModal, Notice, type App } from "obsidian";
import type ExoPlugin from "../main";
import type { CollaboShare } from "../settings-schema";
import {
  CollaboError,
  createDocument,
  type CollaboConfig,
  type HttpFn,
  type ShareRole,
} from "../core/collab-bridge";
import { obsidianHttp } from "./collabo-http";

export interface ShareDeps {
  http: HttpFn;
  cfg: CollaboConfig;
  shares: Record<string, CollaboShare>;
  save: () => Promise<void>;
}

const ROLES: { role: ShareRole; label: string }[] = [
  { role: "commenter", label: "Commenter: can comment and suggest, cannot change the text" },
  { role: "editor", label: "Editor: can change the text directly" },
  { role: "viewer", label: "Viewer: read only" },
];

class RolePicker extends FuzzySuggestModal<{ role: ShareRole; label: string }> {
  constructor(app: App, private onPick: (role: ShareRole) => void) {
    super(app);
    this.setPlaceholder("What can the person with this link do?");
  }
  getItems(): { role: ShareRole; label: string }[] {
    return ROLES;
  }
  getItemText(r: { role: ShareRole; label: string }): string {
    return r.label;
  }
  onChooseItem(r: { role: ShareRole; label: string }): void {
    this.onPick(r.role);
  }
}

/** The one place a document URL is built. The token decides what the opener
 *  can do: the scoped accessToken gives the recipient's role, the ownerSecret
 *  gives owner rights, which is how Mario accepts a suggestion. */
export function docUrl(cfg: CollaboConfig, slug: string, token: string): string {
  return `${cfg.baseUrl.replace(/\/+$/, "")}/d/${slug}?token=${encodeURIComponent(token)}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Deterministic per note path, not random per call: a note has exactly one
 *  document for its whole life (see `shareNote`), so the CREATE request for
 *  that note is naturally idempotent on its path alone. If a first attempt's
 *  response never reaches us (dropped connection, plugin reload mid-request)
 *  and the human re-runs the share command, this key is unchanged, so the
 *  service returns the document it already made instead of minting a second
 *  one. A random key per call would defeat exactly that protection. */
function createIdempotencyKey(path: string): string {
  return `collabo-create-${fnv1a(path)}`;
}

/** Share a note, or hand back the link of the document it already has. Returns
 *  the URL to give a human. */
export async function shareNote(
  deps: ShareDeps,
  opts: { path: string; markdown: string; title: string; role: ShareRole },
): Promise<string> {
  const existing = deps.shares[opts.path];
  if (existing) {
    // A note has exactly one document for its whole life. Re-running the
    // command is how you get the link back, not how you fork the conversation.
    return docUrl(deps.cfg, existing.slug, existing.accessToken);
  }
  const doc = await createDocument(
    deps.http,
    deps.cfg,
    { markdown: opts.markdown, title: opts.title, role: opts.role },
    createIdempotencyKey(opts.path),
  );
  deps.shares[opts.path] = {
    slug: doc.slug,
    ownerSecret: doc.ownerSecret,
    accessToken: doc.accessToken,
    role: doc.accessRole,
  };
  await deps.save();
  return doc.shareUrl;
}

/** Settings to config, or null when the feature is not set up. */
export function collaboConfig(plugin: ExoPlugin): CollaboConfig | null {
  const baseUrl = plugin.settings.collaboUrl.trim();
  if (!baseUrl) return null;
  return { baseUrl, apiKey: plugin.settings.collaboApiKey.trim() };
}

export function depsFor(plugin: ExoPlugin, cfg: CollaboConfig): ShareDeps {
  return {
    http: obsidianHttp,
    cfg,
    shares: plugin.settings.collaboShares,
    save: () => plugin.saveSettings(),
  };
}

export function registerCollaboCommands(plugin: ExoPlugin): void {
  plugin.addCommand({
    id: "collabo-share-note",
    name: "Share this note to Exo Collabo",
    // Hidden entirely when no service is configured: an entry that always
    // fails is worse than no entry.
    checkCallback: (checking: boolean) => {
      const cfg = collaboConfig(plugin);
      const file = plugin.app.workspace.getActiveFile();
      if (!cfg || !file || file.extension !== "md") return false;
      if (!checking) {
        new RolePicker(plugin.app, (role) => {
          void (async () => {
            try {
              const markdown = await plugin.app.vault.read(file);
              const url = await shareNote(depsFor(plugin, cfg), {
                path: file.path,
                markdown,
                title: file.basename,
                role,
              });
              await navigator.clipboard.writeText(url);
              new Notice("Exo Collabo: link copied to clipboard");
            } catch (e) {
              new Notice(
                e instanceof CollaboError
                  ? `Exo Collabo refused the share: ${e.message}`
                  : `Exo Collabo is unreachable: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          })();
        }).open();
      }
      return true;
    },
  });

  plugin.addCommand({
    id: "collabo-open-owner",
    name: "Open this note's shared document as owner",
    // The share command copies the RECIPIENT link, which carries their role.
    // Accepting a suggestion needs the owner secret, so it gets its own entry
    // rather than being a mode of the share command nobody would find.
    checkCallback: (checking: boolean) => {
      const cfg = collaboConfig(plugin);
      const file = plugin.app.workspace.getActiveFile();
      const share = file ? plugin.settings.collaboShares[file.path] : undefined;
      if (!cfg || !share) return false;
      if (!checking) window.open(docUrl(cfg, share.slug, share.ownerSecret), "_blank");
      return true;
    },
  });
}
