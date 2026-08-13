/**
 * Exo Collabo commands. They live here rather than in main.ts because main.ts
 * is at its size ceiling and this feature is self-contained: it needs the
 * plugin only for settings, the active file, and saveSettings.
 *
 * `shareNote` is separated from the command wiring so the interesting behaviour
 * (create once, reuse forever, persist the mapping) is testable without an app.
 */
import { FuzzySuggestModal, Modal, Notice, TFile, type App } from "obsidian";
import type ExoPlugin from "../main";
import type { CollaboShare } from "../settings-schema";
import {
  CollaboError,
  createDocument,
  fetchState,
  fnv1a,
  parseShareRef,
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
/** Moves a share registry entry from `oldPath` to `newPath`, matching how
 *  contracts and automations elsewhere in this plugin re-key on rename.
 *  Without this, renaming a shared note orphans its entry: the owner command
 *  and `collabo_list_shares` keep looking it up under the path that no
 *  longer exists. Returns the input unchanged (same reference) when the
 *  renamed file was never shared, so callers can skip a save. */
export function renameShare(
  shares: Record<string, CollaboShare>,
  oldPath: string,
  newPath: string,
): Record<string, CollaboShare> {
  const entry = shares[oldPath];
  if (!entry) return shares;
  const { [oldPath]: _dropped, ...rest } = shares;
  return { ...rest, [newPath]: entry };
}

export function docUrl(cfg: CollaboConfig, slug: string, token: string): string {
  return `${cfg.baseUrl.replace(/\/+$/, "")}/d/${slug}?token=${encodeURIComponent(token)}`;
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

/** Share a note, asking for a role only when there is a real decision to
 *  make. A note that already has a document keeps that document for its
 *  whole life: `shareNote`'s early return hands back the existing link no
 *  matter what role is passed in, so a picker shown on a re-run would let
 *  someone choose "editor", believe they just upgraded a colleague, and get
 *  nothing — the choice was silently discarded. Checking the registry first
 *  means the picker only ever opens when picking a role actually decides
 *  something. `pickRole` is injected so this is testable without the modal. */
export async function shareOrReuse(
  deps: ShareDeps,
  opts: { path: string; markdown: string; title: string },
  pickRole: () => Promise<ShareRole>,
): Promise<string> {
  const existing = deps.shares[opts.path];
  if (existing) return docUrl(deps.cfg, existing.slug, existing.accessToken);
  const role = await pickRole();
  return shareNote(deps, { ...opts, role });
}

/** Opens the role picker and resolves with the chosen role. Never resolves
 *  if the picker is dismissed without a choice, matching the picker's own
 *  behaviour before this fix: closing it without picking does nothing. */
function pickRoleVia(app: App): () => Promise<ShareRole> {
  return () => new Promise<ShareRole>((resolve) => new RolePicker(app, resolve).open());
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

/** Work out which document a paste refers to and which token opens it.
 *  A link carries its own token; a bare slug only works for a document this
 *  vault already knows, because nothing else supplies a credential. */
export function resolveImport(
  deps: ShareDeps,
  input: string,
): { slug: string; token: string; targetPath: string | null } | null {
  const ref = parseShareRef(input);
  if (!ref) return null;
  const owned = Object.entries(deps.shares).find(([, s]) => s.slug === ref.slug);
  const token = ref.token ?? owned?.[1].accessToken ?? null;
  if (!token) return null;
  return { slug: ref.slug, token, targetPath: owned?.[0] ?? null };
}

/** Read the accepted document. Pending suggestions are not part of state, so
 *  what comes back is exactly what the owner has promoted, never someone
 *  else's draft. */
export async function importDocument(
  deps: ShareDeps,
  input: string,
): Promise<{ markdown: string; targetPath: string | null; slug: string }> {
  const target = resolveImport(deps, input);
  if (!target) throw new Error("That is not an Exo Collabo link this vault can open.");
  const state = await fetchState(deps.http, deps.cfg, target.slug, target.token);
  return { markdown: state.markdown, targetPath: target.targetPath, slug: target.slug };
}

/** Where a document new to this vault lands, and whether the vault already
 *  has a file there. Pure so the fix is testable without mounting Obsidian:
 *  the path is deterministic per slug, so importing the same never-before-
 *  seen document a second time must resolve to "modify", never to a
 *  `vault.create` on a path the first import already made. The caller
 *  supplies `pathExists` because checking it needs the live app. */
export function planInboxImport(
  slug: string,
  pathExists: boolean,
): { path: string; mode: "modify" | "create" } {
  return { path: `_inbox/Collabo ${slug}.md`, mode: pathExists ? "modify" : "create" };
}

/** Confirm-before-write gate for the import command. Not a diff viewer like
 *  `NoteDiffModal` (that shows what already changed, after the fact): this
 *  blocks the write itself until the user agrees to it, because nothing
 *  stops a shared note from being edited directly in Obsidian at the same
 *  time (see the design doc: no continuous sync), and a silent overwrite
 *  would destroy edits the server never saw. */
class ImportOverwriteModal extends Modal {
  private decided = false;
  constructor(
    app: App,
    private path: string,
    private onDecide: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("mva-ie-modal");
    this.titleEl.setText("Replace note with Exo Collabo version?");
    const { contentEl } = this;
    contentEl.createEl("p", {
      text: `"${this.path}" already has content. Importing will replace it with the version from Exo Collabo. Any edits made only in this note, and not on the server, will be lost.`,
    });
    const actions = contentEl.createDiv({ cls: "mva-ie-actions" });
    actions.createEl("button", { cls: "mva-btn", text: "Cancel" }).onclick = () => this.close();
    const confirm = actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Import" });
    confirm.onclick = () => {
      this.decided = true;
      this.onDecide(true);
      this.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
    // Esc, backdrop click, or the Cancel button: any close that did not go
    // through the Import button above is a "no" that must still resolve the
    // caller's promise, or the import command hangs forever.
    if (!this.decided) this.onDecide(false);
  }
}

export interface ImportWriteDeps {
  fileExists: (path: string) => boolean;
  confirmOverwrite: (path: string) => Promise<boolean>;
  writeFile: (path: string, markdown: string, mode: "modify" | "create") => Promise<void>;
}

export interface ImportOutcome {
  path: string;
  mode: "modify" | "create";
  written: boolean;
}

/** Decide where an imported document's markdown lands, then write it —
 *  gated on an explicit confirmation whenever that write would overwrite a
 *  note that already has content, whether it is the note this vault shared
 *  FROM (the registered `targetPath`) or a document previously landed in
 *  `_inbox/`. `mode === "create"` (nothing at that path yet) needs no gate:
 *  there is no local content at risk. Pure aside from the three injected
 *  callables, so the gate is testable without mounting Obsidian. */
export async function performImport(
  fsDeps: ImportWriteDeps,
  out: { markdown: string; targetPath: string | null; slug: string },
): Promise<ImportOutcome> {
  let path: string;
  let mode: "modify" | "create";
  if (out.targetPath && fsDeps.fileExists(out.targetPath)) {
    path = out.targetPath;
    mode = "modify";
  } else {
    const plan = planInboxImport(out.slug, fsDeps.fileExists(`_inbox/Collabo ${out.slug}.md`));
    path = plan.path;
    mode = plan.mode;
  }
  if (mode === "modify") {
    const confirmed = await fsDeps.confirmOverwrite(path);
    if (!confirmed) return { path, mode, written: false };
  }
  await fsDeps.writeFile(path, out.markdown, mode);
  return { path, mode, written: true };
}

export function registerCollaboCommands(plugin: ExoPlugin): void {
  // Keeps collaboShares keyed by the note's CURRENT path, the same
  // registerEvent("rename") shape main.ts already uses for contracts and
  // automations. No-ops (and skips the save) for a rename that touches no
  // shared note.
  plugin.registerEvent(
    plugin.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile)) return;
      const moved = renameShare(plugin.settings.collaboShares, oldPath, file.path);
      if (moved === plugin.settings.collaboShares) return;
      plugin.settings.collaboShares = moved;
      void plugin.saveSettings();
    }),
  );

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
        void (async () => {
          try {
            const markdown = await plugin.app.vault.read(file);
            const url = await shareOrReuse(
              depsFor(plugin, cfg),
              { path: file.path, markdown, title: file.basename },
              pickRoleVia(plugin.app),
            );
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
      }
      return true;
    },
  });

  plugin.addCommand({
    id: "collabo-import",
    name: "Import a document from Exo Collabo",
    checkCallback: (checking: boolean) => {
      const cfg = collaboConfig(plugin);
      if (!cfg) return false;
      if (!checking) {
        void (async () => {
          const pasted = (await navigator.clipboard.readText().catch(() => "")).trim();
          try {
            const deps = depsFor(plugin, cfg);
            const resolved = resolveImport(deps, pasted);
            const out = await importDocument(deps, pasted);
            const outcome = await performImport(
              {
                fileExists: (path) => plugin.app.vault.getAbstractFileByPath(path) instanceof TFile,
                // Only the "modify" branch ever calls this (see performImport),
                // so this is exactly the before-the-write gate Finding 1 asked
                // for: no note with existing content is overwritten without it.
                confirmOverwrite: (path) =>
                  new Promise<boolean>((resolve) => new ImportOverwriteModal(plugin.app, path, resolve).open()),
                writeFile: async (path, markdown, mode) => {
                  if (mode === "modify") {
                    const file = plugin.app.vault.getAbstractFileByPath(path);
                    if (file instanceof TFile) await plugin.app.vault.modify(file, markdown);
                  } else {
                    await plugin.app.vault.create(path, markdown);
                  }
                },
              },
              out,
            );
            if (!outcome.written) {
              new Notice("Exo Collabo: import cancelled");
              return;
            }
            new Notice(
              outcome.mode === "modify"
                ? `Exo Collabo: updated ${outcome.path}`
                : `Exo Collabo: imported to ${outcome.path}`,
            );
            if (outcome.mode === "create" && !out.targetPath && resolved) {
              // Remember it under the note that now holds it, so a later
              // re-import (even from a bare slug) resolves to this note
              // instead of "never seen", the same one-note-per-document
              // invariant `shareNote` keeps for notes shared FROM this vault.
              // There is no ownerSecret to store: this vault did not create
              // the document, it only received a link to it. `ownerSecret`
              // stays empty, and "open as owner" below refuses to offer
              // itself for a share that has no real one.
              // The role a link's token grants is never told to us: only
              // the service knows it, so "unknown" is what we actually
              // know, not a guess dressed up as one of the three real roles.
              deps.shares[outcome.path] = {
                slug: out.slug,
                ownerSecret: "",
                accessToken: resolved.token,
                role: "unknown",
              };
              await deps.save();
            }
          } catch (e) {
            new Notice(
              e instanceof CollaboError
                ? `Exo Collabo refused the read: ${e.message}`
                : `Could not import: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        })();
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
      // A share recorded from an import has no owner secret: this vault
      // received the document, it did not create it, so it must not offer
      // owner access it does not have.
      if (!cfg || !share || !share.ownerSecret) return false;
      if (!checking) window.open(docUrl(cfg, share.slug, share.ownerSecret), "_blank");
      return true;
    },
  });
}
