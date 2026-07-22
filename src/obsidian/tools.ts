import { App, TFile, prepareSimpleSearch, getAllTags } from "obsidian";
import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { resolveLink, neighborhood, basename } from "./graph";
import { exoPaths, LEGACY_MEMORY_ROOT, type ExoPaths } from "../core/paths";
import { gatherConnections, linkMentionsIn } from "../mentions/connections";
import { loadIgnoreStore, ignoreMention } from "../mentions/ignore-store";
import { fold } from "../mentions/tokenizer";
import {
  formatEntry,
  parseStoreFile,
  monthFileName,
  scoreEntries,
  resolveSupersedence,
  type MemoryEntry,
} from "../core/memory-store";
import { currentAsOf, isValidAsOfDate } from "../core/memory-asof";
import {
  formatLoop,
  parseLoopsFile,
  activeLoops,
  dueLoops,
  closeLoop,
  type LoopEntry,
} from "../core/open-loops";
import { WriteQueue } from "../core/write-queue";
import { patchFrontmatter } from "../core/frontmatter-patch";
import { createBacklogTask, adaptAppToTaskVault } from "./task-store";
import {
  automationLastRunKey,
  cadenceLabel,
  nextDueAt,
  parseCadenceInput,
  unreviewedWriteRuns,
  type AutomationConfig,
  type AutomationRunRecord,
} from "../core/automations";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

/** The slice of the exo plugin the automation tools use — resolved live from
 *  app.plugins (same cross-plugin convention as getSonar; here it's our own
 *  plugin, reached this way to avoid a tools→main import cycle). */
interface ExoAutomationsHost {
  settings: {
    automations: AutomationConfig[];
    customPrompts: { name: string; prompt: string }[];
    scheduledLastRun: Record<string, number>;
  };
  saveSettings(): Promise<void>;
  loadAutomationRuns(): Promise<AutomationRunRecord[]>;
  restoreAutomationRun(id: string): Promise<string[]>;
  markAutomationRunReviewed(id: string): Promise<void>;
  runPlaybook(name: string, prompt: string, opts?: { write?: boolean }): Promise<boolean>;
}

function getExo(app: App): ExoAutomationsHost | null {
  const plugins = (app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins;
  const p = plugins?.plugins?.["exo"] as Partial<ExoAutomationsHost> | undefined;
  return p && typeof p.loadAutomationRuns === "function" && typeof p.runPlaybook === "function"
    ? (p as ExoAutomationsHost)
    : null;
}

/** "due now" / "in 3h" / "in 2d" — tool-output twin of the Cockpit's formatter. */
function fmtDueIn(ms: number): string {
  if (ms <= 60_000) return "due now";
  const HOUR = 3_600_000;
  if (ms < HOUR) return `in ${Math.floor(ms / 60_000)}m`;
  if (ms < 24 * HOUR) return `in ${Math.floor(ms / HOUR)}h`;
  return `in ${Math.floor(ms / (24 * HOUR))}d`;
}
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const err = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

/** Structured question shape for `ask_user`. Duplicated from view.ts to avoid a
 *  view→tools import cycle (tools.ts must not import from view.ts). */
interface AskQuestion {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** A `rethink_memory` request handed to the view-side bridge. The tool has NOT
 *  yet decided the tier — the bridge resolves `planRethink`, enacts the write
 *  (now/human) or records a pending proposal card (persona), and returns a short
 *  status line for the model. Kept minimal to avoid a tools→view import cycle. */
export interface RethinkRequest {
  block: "persona" | "human" | "now";
  content: string;
  rationale?: string;
}

const MAX_CONTENT = 8000;
const SKIP_LARGER_THAN = 200_000;
const MAX_SCAN_FILES = 2000; // cap the built-in fallback scan (Omnisearch has no such limit)

/** Omnisearch public API (when the plugin is installed). */
interface OmnisearchResult {
  score: number;
  path: string;
  basename: string;
  excerpt?: string;
}
interface OmnisearchApi {
  search(query: string): Promise<OmnisearchResult[]>;
}
function getOmnisearch(app: App): OmnisearchApi | null {
  const plugins = (app as unknown as { plugins?: { plugins?: Record<string, { api?: OmnisearchApi }> } }).plugins;
  const api = plugins?.plugins?.["omnisearch"]?.api;
  return api && typeof api.search === "function" ? api : null;
}

/** AIditor's cross-plugin read/action API (when the aiditor plugin is enabled). */
interface AIditorAnnotation {
  id: string;
  notePath: string;
  quote: string;
  body: string;
  status: "active" | "resolved" | "orphaned";
}
interface AIditorApi {
  getAnnotations(filter?: { notePath?: string; status?: string | string[] }): AIditorAnnotation[];
  resolveAnnotation(id: string): boolean;
}
/** Resolve AIditor's public API off its plugin instance, or null when absent/disabled. */
function getAIditor(app: App): AIditorApi | null {
  const plugins = (app as unknown as { plugins?: { plugins?: Record<string, Partial<AIditorApi>> } }).plugins;
  const p = plugins?.plugins?.["aiditor"];
  return p && typeof p.getAnnotations === "function" && typeof p.resolveAnnotation === "function"
    ? (p as AIditorApi)
    : null;
}

/** One-line rendering of an annotation for tool output — whitespace-collapsed, length-capped. */
function fmtAnnotation(a: AIditorAnnotation): string {
  const quote = a.quote.replace(/\s+/g, " ").trim().slice(0, 80);
  const body = a.body.replace(/\s+/g, " ").trim();
  return `- ${a.id} · ${a.status} · [[${a.notePath}]] · "${quote}" → ${body}`;
}

/** Sonar's cross-plugin action API (when the sonar plugin is enabled). Mirrors
 *  Obsidian's command palette: id, human title, owning plugin, and a
 *  destructive flag Sonar computes so callers can gate risky commands. */
interface SonarActionInfo {
  id: string;
  title: string;
  source: string;
  destructive: boolean;
}
interface SonarApi {
  getActions(): SonarActionInfo[];
  runAction(id: string): Promise<{ ok: boolean; destructive: boolean }>;
}
/** Resolve Sonar's public API off its plugin instance, or null when absent/disabled. */
function getSonar(app: App): SonarApi | null {
  const plugins = (app as unknown as { plugins?: { plugins?: Record<string, Partial<SonarApi>> } }).plugins;
  const p = plugins?.plugins?.["sonar"];
  return p && typeof p.getActions === "function" && typeof p.runAction === "function"
    ? (p as SonarApi)
    : null;
}

/** One-line rendering of a Sonar action for tool output. */
function fmtSonarAction(a: SonarActionInfo): string {
  return `- ${a.id} · ${a.title} (${a.source})${a.destructive ? " ⚠ destructive" : ""}`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
}
function today(): string {
  // Local date (not UTC) — toISOString() would roll to tomorrow late at night in +TZ.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Create any missing parent folders for a vault path (vault.create won't). */
async function ensureParentFolder(app: App, path: string): Promise<void> {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return;
  const dir = path.slice(0, slash);
  if (app.vault.getAbstractFileByPath(dir)) return;
  try {
    await app.vault.createFolder(dir);
  } catch {
    /* already exists (race) — fine */
  }
}

/** Options bag for {@link buildObsidianTools} — one field per gating/bridge
 *  input that `createObsidianToolServer` used to take positionally. */
export interface ObsidianToolOpts {
  alwaysLoad?: boolean;
  memoryWrite?: boolean;
  askBridge?: (questions: AskQuestion[]) => Promise<Record<string, string>>;
  memoryRead?: boolean;
  memoryWriteQueue?: WriteQueue;
  loopsWriteQueue?: WriteQueue;
  orchestrationEnabled?: boolean;
  tasksWriteQueue?: WriteQueue;
  agentFolderEnabled?: boolean;
  rethinkBridge?: (req: RethinkRequest) => Promise<string>;
  /** Resolved memory-layer paths. Absent → legacy `_system/` (test/fallback). */
  paths?: ExoPaths;
}

/**
 * Build the gated array of Obsidian-native tool definitions: graph
 * navigation, metadata-aware read/search, convention-aware writes, and
 * `_system/` memory capture. Handlers run in-process and use the Obsidian API
 * (metadataCache/vault/fileManager) — no shell, graph- and frontmatter-aware.
 * Consumed directly by the Codex↔Obsidian bridge, and wrapped by
 * {@link createObsidianToolServer} for the Claude Agent SDK.
 */
export function buildObsidianTools(app: App, opts?: ObsidianToolOpts): SdkMcpToolDefinition<any>[] {
  const {
    // Server-level flag only (consumed by createObsidianToolServer's
    // createSdkMcpServer call) — destructured here for ObsidianToolOpts
    // conformance, not used in tool-building itself.
    alwaysLoad: _alwaysLoad = true,
    memoryWrite = true,
    askBridge,
    memoryRead = true,
    memoryWriteQueue = new WriteQueue(),
    loopsWriteQueue = new WriteQueue(),
    /** Orchestration Board master flag (default OFF). Gates `add_task` only —
     *  every other tool above is unaffected, and the tool list sent to sessions
     *  must be byte-identical to before this parameter existed when this is false. */
    orchestrationEnabled = false,
    /** Shared write-queue for the tasks ledger (`_system/orchestration/tasks.md`),
     *  injected by the plugin the same way `memoryWriteQueue` is — so `add_task`
     *  and any future board-side writer serialize on the SAME queue. */
    tasksWriteQueue = new WriteQueue(),
    /** The Agent Is the Folder master flag (default OFF). Gates `rethink_memory`
     *  ONLY (in addition to memoryWrite) — every other tool is byte-identical to
     *  before this parameter existed when this is false. */
    agentFolderEnabled = false,
    /** View-side bridge that enacts a `rethink_memory` request: resolves the tier,
     *  writes (now/human) or records a pending proposal card (persona), and renders
     *  the feed diff+undo. Absent → the tool is not registered. */
    rethinkBridge,
    paths = exoPaths(LEGACY_MEMORY_ROOT),
  } = opts ?? {};
  const need = (target: string): TFile => {
    const f = resolveLink(app, target);
    if (!f) throw new Error(`Note not found: ${target}`);
    return f;
  };

  /**
   * One serialized write path for ALL appends to the Memory Union Store. Every
   * store writer (the `remember` tool, the Self-Writing Memory observer, future
   * dream passes) MUST enqueue on the SAME instance so concurrent read-modify-write
   * cycles never interleave or clobber a monthly store file. This is injected by
   * the plugin (`ExoPlugin.memoryWriteQueue`) and shared with `MemoryObserver`;
   * the `new WriteQueue()` default only exists for standalone callers (tests).
   */

  /** Serialized write path for the single-file Open-Loops Ledger. The plugin
   *  injects one shared instance across every conversation/session; the local
   *  default exists only for standalone tool registries in tests. */

  /* ----------------------------- read ----------------------------- */

  const searchVault = tool(
    "search_vault",
    "Full-text search across your vault — notes, and with Omnisearch also indexed attachments (PDF/image/canvas). Returns ranked paths with snippets, using Omnisearch (BM25 + fuzzy) when installed, else a built-in scorer. Prefer this over Grep for vault content.",
    { query: z.string(), limit: z.number().optional() },
    async (args) => {
      const limit = Math.min(args.limit ?? 10, 30);

      // Preferred path: Omnisearch plugin API (better ranking, fuzzy, attachments).
      const omni = getOmnisearch(app);
      if (omni) {
        try {
          const results = await omni.search(args.query);
          if (results.length === 0) return ok(`No matches for "${args.query}".`);
          return ok(
            results
              .slice(0, limit)
              .map((r) => `- [[${r.path}]] — ${(r.excerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 160)}`)
              .join("\n")
          );
        } catch {
          /* Omnisearch index not ready — fall back to the built-in scorer. */
        }
      }

      const search = prepareSimpleSearch(args.query);
      const hits: { path: string; score: number; snippet: string }[] = [];
      const files = app.vault
        .getMarkdownFiles()
        .filter((f) => f.stat.size <= SKIP_LARGER_THAN)
        .sort((a, b) => b.stat.mtime - a.stat.mtime);
      const scanned = files.slice(0, MAX_SCAN_FILES);
      for (const file of scanned) {
        let text = file.basename;
        try {
          text += "\n" + (await app.vault.cachedRead(file));
        } catch {
          continue; // skip unreadable
        }
        const r = search(text);
        if (r) {
          const at = r.matches[0]?.[0] ?? 0;
          const snippet = text.slice(Math.max(0, at - 40), at + 80).replace(/\s+/g, " ").trim();
          hits.push({ path: file.path, score: r.score, snippet });
        }
      }
      hits.sort((a, b) => b.score - a.score);
      const top = hits.slice(0, limit);
      if (top.length === 0) return ok(`No matches for "${args.query}".`);
      const body = top.map((h) => `- [[${h.path}]] — ${h.snippet}`).join("\n");
      const capped = files.length > MAX_SCAN_FILES
        ? `\n\n(Searched the ${MAX_SCAN_FILES} most recently edited notes of ${files.length}. Install Omnisearch for full-vault search.)`
        : "";
      return ok(body + capped);
    }
  );

  const readNote = tool(
    "read_note",
    "Read a note's content plus its metadata (frontmatter, tags, outgoing links). Accepts a wikilink or vault path.",
    { target: z.string() },
    async (args) => {
      const file = need(args.target);
      const cache = app.metadataCache.getFileCache(file);
      const tags = (cache && getAllTags(cache)) || [];
      const fm = cache?.frontmatter ?? {};
      let content = await app.vault.cachedRead(file);
      if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT) + "\n… (truncated)";
      const meta = [
        `path: ${file.path}`,
        tags.length ? `tags: ${tags.join(", ")}` : "",
        Object.keys(fm).length ? `frontmatter: ${JSON.stringify(fm)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return ok(`${meta}\n\n---\n${content}`);
    }
  );

  const getBacklinks = tool(
    "get_backlinks",
    "List the notes that link TO the given note.",
    { target: z.string() },
    async (args) => {
      const file = need(args.target);
      const bl = neighborhood(app, file).backlinks;
      return ok(bl.length ? bl.map((p) => `- [[${p}]]`).join("\n") : "No backlinks.");
    }
  );

  const getNeighborhood = tool(
    "get_neighborhood",
    "Get the graph neighborhood of a note: outgoing links, backlinks, and up/related frontmatter links.",
    { target: z.string() },
    async (args) => {
      const file = need(args.target);
      const n = neighborhood(app, file);
      const fmt = (xs: string[]) => (xs.length ? xs.map((p) => `  - [[${p}]]`).join("\n") : "  (none)");
      return ok(
        `Neighborhood of [[${file.path}]]:\n` +
          `outgoing:\n${fmt(n.outgoing)}\n` +
          `backlinks:\n${fmt(n.backlinks)}\n` +
          `related (up/related):\n${fmt(n.related)}`
      );
    }
  );

  const getConnections = tool(
    "get_connections",
    "Get a note's full connection picture: backlinks (Linked), up/related frontmatter (Related), and PLAIN-TEXT unlinked mentions elsewhere in the vault that aren't wikilinked yet (Unlinked, with a context snippet each). Use it to review a note's place in the graph and to judge which unlinked mentions are real references worth linking — then act with link_mentions or dismiss with ignore_mention. Accepts a wikilink/path; omit target for the active note.",
    { target: z.string().optional() },
    async (args) => {
      const file = args.target ? need(args.target) : app.workspace.getActiveFile();
      if (!file) return ok("No active note.");
      const ignore = await loadIgnoreStore(app);
      const c = await gatherConnections(app, file, ignore);
      const fmt = (xs: string[]) => (xs.length ? xs.map((p) => `  - [[${p}]]`).join("\n") : "  (none)");
      const unlinked = c.unlinked.length
        ? c.unlinked
            .map((u) => `  - [[${u.sourcePath}]] · ${u.ranges.length}× — "${u.snippet}"`)
            .join("\n")
        : "  (none)";
      return ok(
        `Connections for [[${file.path}]]:\n` +
          `Linked (backlinks):\n${fmt(c.linked)}\n` +
          `Related (up/related):\n${fmt(c.related)}\n` +
          `Unlinked mentions:\n${unlinked}`
      );
    }
  );

  const listNotes = tool(
    "list_notes",
    "List notes filtered by tag (e.g. '#domain/product') and/or folder prefix. Returns paths.",
    { tag: z.string().optional(), folder: z.string().optional(), limit: z.number().optional() },
    async (args) => {
      const limit = Math.min(args.limit ?? 50, 200);
      const wantTag = args.tag?.replace(/^#/, "");
      const out: string[] = [];
      for (const file of app.vault.getMarkdownFiles()) {
        if (args.folder && !file.path.startsWith(args.folder)) continue;
        if (wantTag) {
          const cache = app.metadataCache.getFileCache(file);
          const tags = (cache && getAllTags(cache)) || [];
          if (!tags.some((t) => t.replace(/^#/, "") === wantTag)) continue;
        }
        out.push(file.path);
        if (out.length >= limit) break;
      }
      return ok(out.length ? out.map((p) => `- [[${p}]]`).join("\n") : "No notes matched.");
    }
  );

  const listTags = tool(
    "list_tags",
    "List all tags in the vault with their note counts (most used first).",
    { limit: z.number().optional() },
    async (args) => {
      const counts = new Map<string, number>();
      for (const file of app.vault.getMarkdownFiles()) {
        const cache = app.metadataCache.getFileCache(file);
        for (const t of (cache && getAllTags(cache)) || []) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.min(args.limit ?? 60, 200));
      return ok(sorted.map(([t, c]) => `${t} (${c})`).join("\n") || "No tags.");
    }
  );

  const getActiveContext = tool(
    "get_active_context",
    "Get the note the user is currently viewing, the selected text (if any), its graph neighborhood, and any open AIditor comments Mario left on it. Treat those comments as Mario's margin notes — read them as context, and act on any that read as requests.",
    {},
    async () => {
      const file = app.workspace.getActiveFile();
      if (!file) return ok("No active note.");
      const n = neighborhood(app, file);
      const sel =
        app.workspace.activeEditor?.editor?.getSelection?.() ?? "";
      // Fold in the note's open annotations so the agent passively notices
      // comments whenever it orients on a note — no explicit call needed.
      const anns = getAIditor(app)?.getAnnotations({ notePath: file.path }) ?? [];
      const annText = anns.length
        ? `annotations (${anns.length} open — use list_annotations for the full set, resolve_annotation to close one):\n` +
          anns.slice(0, 8).map(fmtAnnotation).join("\n") + "\n"
        : "";
      return ok(
        `active: [[${file.path}]]\n` +
          (sel ? `selection:\n${sel}\n` : "") +
          annText +
          `related: ${[...n.related, ...n.backlinks].slice(0, 8).map(basename).join(", ") || "(none)"}`
      );
    }
  );

  const listAnnotations = tool(
    "list_annotations",
    "List AIditor margin comments Mario left on notes. Defaults to the active note and the open set (active + orphaned) — the comments awaiting attention. Pass scope:'vault' for every note, or notePath to target one; status 'resolved'/'all' to widen. Use it to read Mario's comments as context or enumerate open ones to act on, then close each with resolve_annotation.",
    {
      scope: z.enum(["note", "vault"]).optional(),
      notePath: z.string().optional(),
      status: z.enum(["open", "active", "orphaned", "resolved", "all"]).optional(),
    },
    async (args) => {
      const aiditor = getAIditor(app);
      if (!aiditor) return ok("AIditor plugin isn't enabled — no annotations available.");

      let notePath: string | undefined;
      if (args.notePath) {
        notePath = args.notePath;
      } else if ((args.scope ?? "note") === "note") {
        const f = app.workspace.getActiveFile();
        if (!f) return ok("No active note to read annotations from — pass scope:'vault' or a notePath.");
        notePath = f.path;
      }

      // 'open' (default) → omit status so aiditor applies its active+orphaned default.
      // 'all' → every status. Otherwise pass the single status through.
      const status = args.status ?? "open";
      const statusArg =
        status === "open" ? undefined : status === "all" ? ["active", "orphaned", "resolved"] : status;

      const anns = aiditor.getAnnotations({
        ...(notePath ? { notePath } : {}),
        ...(statusArg ? { status: statusArg } : {}),
      });
      if (!anns.length) {
        return ok(notePath ? `No matching annotations on [[${notePath}]].` : "No matching annotations.");
      }
      return ok(anns.map(fmtAnnotation).join("\n"));
    }
  );

  const listSonarActions = tool(
    "list_sonar_actions",
    "List runnable app commands via the Sonar plugin (Obsidian's command palette: every command from core and installed plugins). Use it when Mario asks to perform an app-level action — e.g. an intent handed off from Sonar's '?' mode like 'toggle the sidebar' or 'export this note' — to find the command id, then execute it with run_sonar_action. Pass query to filter (case-insensitive match on title/id/source).",
    { query: z.string().optional() },
    async (args) => {
      const sonar = getSonar(app);
      if (!sonar) return ok("Sonar plugin isn't enabled — no app actions available.");
      let actions = sonar.getActions();
      const q = args.query?.trim().toLowerCase();
      if (q) {
        actions = actions.filter((a) => `${a.title} ${a.id} ${a.source}`.toLowerCase().includes(q));
      }
      if (!actions.length) return ok(q ? `No actions match "${args.query}".` : "No actions available.");
      const CAP = 80;
      const lines = actions.slice(0, CAP).map(fmtSonarAction);
      if (actions.length > CAP) lines.push(`(+${actions.length - CAP} more — pass query to narrow)`);
      return ok(lines.join("\n"));
    }
  );

  const askUser = tool(
    "ask_user",
    "Ask the user structured questions with selectable options. Use this to resolve a genuine choice you can't infer — approach, scope, ambiguity between concrete options. Prefer it over asking in free text. Up to 4 questions; 2–6 options each; set multiSelect for multi-choice.",
    {
      questions: z
        .array(
          z.object({
            question: z.string(),
            header: z.string(),
            options: z
              // `preview` matches the built-in AskUserQuestion shape (aliased to
              // this tool) — accepted so aliased calls validate, ignored by the UI.
              .array(z.object({ label: z.string(), description: z.string().optional(), preview: z.string().optional() }))
              .min(2)
              .max(6),
            multiSelect: z.boolean().optional(),
          })
        )
        .min(1)
        .max(4),
    },
    async (args) => {
      if (!askBridge) return ok("No user is present (headless run) — proceed with your best judgment.");
      try {
        const answers = await askBridge(args.questions as AskQuestion[]);
        return ok(JSON.stringify(answers));
      } catch (e) {
        return ok(`User dismissed the question — proceed with your best judgment. (${e instanceof Error ? e.message : ""})`);
      }
    }
  );

  /* ----------------------------- write ---------------------------- */

  const createNote = tool(
    "create_note",
    "Create a new note. Provide tags in frontmatter following the vault's tag system (#type/*, #domain/*). Fails if the note exists.",
    {
      path: z.string().describe("Vault path ending in .md"),
      content: z.string(),
      frontmatter: z.record(z.string(), z.any()).optional(),
    },
    async (args) => {
      const path = args.path.endsWith(".md") ? args.path : `${args.path}.md`;
      if (app.vault.getAbstractFileByPath(path)) return err(`Already exists: ${path}`);
      await ensureParentFolder(app, path);
      const fm = args.frontmatter ?? {};
      const hasTags = Object.prototype.hasOwnProperty.call(fm, "tags");
      await app.vault.create(path, patchFrontmatter(args.content, {
        ...fm,
        ...(hasTags ? {} : { tags: ["type/note"] }),
      }));
      return ok(`Created [[${path}]]`);
    }
  );

  const appendToNote = tool(
    "append_to_note",
    "Append text to the end of an existing note.",
    { target: z.string(), text: z.string() },
    async (args) => {
      const file = need(args.target);
      await app.vault.append(file, `\n${args.text}\n`);
      return ok(`Appended to [[${file.path}]]`);
    }
  );

  const updateFrontmatter = tool(
    "update_frontmatter",
    "Merge keys into a note's YAML frontmatter (safe, structure-preserving).",
    { target: z.string(), changes: z.record(z.string(), z.any()) },
    async (args) => {
      const file = need(args.target);
      const content = await app.vault.read(file);
      await app.vault.modify(file, patchFrontmatter(content, args.changes));
      return ok(`Updated frontmatter of [[${file.path}]]`);
    }
  );

  const addLinks = tool(
    "add_links",
    "Add wikilinks to a note's `related` frontmatter (deduped). Use to connect notes in the graph.",
    { target: z.string(), targets: z.array(z.string()) },
    async (args) => {
      const file = need(args.target);
      const cached = app.metadataCache.getFileCache(file)?.frontmatter?.related;
      const cur = new Set<string>(Array.isArray(cached) ? cached.map(String) : cached ? [String(cached)] : []);
      for (const t of args.targets) cur.add(`[[${t.replace(/^\[\[|\]\]$/g, "")}]]`);
      const content = await app.vault.read(file);
      await app.vault.modify(file, patchFrontmatter(content, { related: [...cur] }));
      return ok(`Linked ${args.targets.length} note(s) from [[${file.path}]]`);
    }
  );

  const linkMentions = tool(
    "link_mentions",
    "Turn plain-text mentions of `target` inside `source` into wikilinks — one link/undo-safe edit, every occurrence in that note. Use after get_connections when you've judged an unlinked mention a real reference. Surfaces that differ from the target name are piped (`[[Target|surface]]`) so the reading view is unchanged.",
    { source: z.string(), target: z.string() },
    async (args) => {
      const source = need(args.source);
      const target = need(args.target);
      const n = await linkMentionsIn(app, source, target);
      return n > 0
        ? ok(`Linked ${n} mention(s) of [[${target.basename}]] in [[${source.path}]].`)
        : ok(`No unlinked mentions of [[${target.basename}]] found in [[${source.path}]].`);
    }
  );

  const ignoreMentionTool = tool(
    "ignore_mention",
    "Dismiss an unlinked mention: stop offering to link `target` inside `source`, permanently (persisted). Use when a plain-text match is a coincidence or a reference you deliberately won't wikilink. Scoped to that one note — the mention still surfaces elsewhere.",
    { source: z.string(), target: z.string() },
    async (args) => {
      const source = need(args.source);
      const target = need(args.target);
      await ignoreMention(app, fold(target.basename), source.path, Date.now());
      return ok(`Ignoring mentions of [[${target.basename}]] in [[${source.path}]].`);
    }
  );

  const openNote = tool(
    "open_note",
    "Open a note in the Obsidian UI for the user.",
    { target: z.string() },
    async (args) => {
      await app.workspace.openLinkText(args.target.replace(/^\[\[|\]\]$/g, ""), "", false);
      return ok(`Opened ${args.target}`);
    }
  );

  const editNote = tool(
    "edit_note",
    "Replace text in an existing note (Obsidian-native, link/frontmatter-safe). Fails if old_string is absent, or ambiguous unless replace_all is set. Prefer this over the built-in Edit for vault notes.",
    { target: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() },
    async (args) => {
      const file = need(args.target);
      const content = await app.vault.read(file);
      const count = args.old_string ? content.split(args.old_string).length - 1 : 0;
      if (count === 0) return err(`Text not found in ${file.path}.`);
      if (count > 1 && !args.replace_all) return err(`old_string appears ${count}× — pass replace_all or make it unique.`);
      let next: string;
      if (args.replace_all) {
        next = content.split(args.old_string).join(args.new_string);
      } else {
        const i = content.indexOf(args.old_string);
        next = content.slice(0, i) + args.new_string + content.slice(i + args.old_string.length);
      }
      await app.vault.modify(file, next);
      return ok(`Edited [[${file.path}]]`);
    }
  );

  const insertAtCursor = tool(
    "insert_at_cursor",
    "Insert text at the user's cursor in the active note (replaces the current selection if any). Use to write directly where the user is working.",
    { text: z.string() },
    async (args) => {
      const editor = app.workspace.activeEditor?.editor;
      if (!editor) return err("No active editor to insert into.");
      editor.replaceSelection(args.text);
      return ok("Inserted at cursor.");
    }
  );

  const renameNote = tool(
    "rename_note",
    "Rename or move a note, updating all backlinks across the vault (Obsidian-native). Fails if the destination already exists.",
    { target: z.string(), new_path: z.string() },
    async (args) => {
      const file = need(args.target);
      const dest = args.new_path.endsWith(".md") ? args.new_path : `${args.new_path}.md`;
      if (app.vault.getAbstractFileByPath(dest)) return err(`Already exists: ${dest}`);
      await ensureParentFolder(app, dest);
      await app.fileManager.renameFile(file, dest);
      return ok(`Renamed to [[${dest}]]`);
    }
  );

  const resolveAnnotation = tool(
    "resolve_annotation",
    "Mark an AIditor comment resolved by id (from list_annotations or get_active_context) — use once you've acted on what the comment asked for. The comment is archived, not deleted, and disappears from the open set.",
    { id: z.string() },
    async (args) => {
      const aiditor = getAIditor(app);
      if (!aiditor) return err("AIditor plugin isn't enabled — nothing to resolve.");
      const done = aiditor.resolveAnnotation(args.id);
      return done ? ok(`Resolved annotation ${args.id}.`) : err(`No annotation with id ${args.id}.`);
    }
  );

  const runSonarAction = tool(
    "run_sonar_action",
    "Execute an app command by id via the Sonar plugin (ids come from list_sonar_actions). This closes the loop on Sonar's '?' intent mode: find the matching command, then run it. Actions flagged '⚠ destructive' delete or overwrite data — confirm with Mario before running one unless he explicitly asked for exactly that action.",
    { id: z.string() },
    async (args) => {
      const sonar = getSonar(app);
      if (!sonar) return err("Sonar plugin isn't enabled — can't run app actions.");
      const res = await sonar.runAction(args.id);
      if (!res.ok) return err(`No action with id ${args.id} — check list_sonar_actions for the exact id.`);
      return ok(`Ran ${args.id}.${res.destructive ? " (was flagged destructive)" : ""}`);
    }
  );

  /* --------------------------- memory ----------------------------- */

  const captureDecision = tool(
    "capture_decision",
    "Record a decision into _system/memory/decisions/ following the vault's decision-record convention.",
    {
      title: z.string(),
      context: z.string(),
      decision: z.string(),
      rationale: z.string(),
      options: z.string().optional(),
      revisit: z.string().optional(),
      domain: z.string().optional(),
    },
    async (args) => {
      const path = `${paths.decisions}/${today()}-${slugify(args.title)}.md`;
      if (app.vault.getAbstractFileByPath(path)) return err(`Already exists: ${path}`);
      await ensureParentFolder(app, path);
      const body =
        `# Decision: ${args.title}\n\n` +
        `## Contesto\n${args.context}\n\n` +
        (args.options ? `## Opzioni considerate\n${args.options}\n\n` : "") +
        `## Decisione\n${args.decision}\n\n` +
        `## Razionale\n${args.rationale}\n\n` +
        (args.revisit ? `## Revisitare se\n${args.revisit}\n` : "");
      const file = await app.vault.create(path, body);
      await app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => {
        f.type = "decision";
        f.created_by = "exo";
        f.created = today();
        f.tags = ["type/decision", ...(args.domain ? [`domain/${args.domain.replace(/^#?domain\//, "")}`] : [])];
      });
      return ok(`Captured decision → [[${path}]]`);
    }
  );

  const logSession = tool(
    "log_session",
    "Prepend an entry to _system/memory/session-log.md. type ∈ ingest|query|decision|lint|build|triage.",
    { title: z.string(), summary: z.string(), type: z.string().optional() },
    async (args) => {
      const path = paths.sessionLog;
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      const entry = `## [${stamp}] ${args.type ?? "query"} | ${args.title}\n\n${args.summary}\n\n`;
      const file = app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const cur = await app.vault.read(file);
        await app.vault.modify(file, entry + cur);
      } else {
        await ensureParentFolder(app, path);
        await app.vault.create(path, entry);
      }
      return ok("Logged session entry.");
    }
  );

  const captureLearning = tool(
    "capture_learning",
    "Record a learning/pattern into _system/memory/learnings/. Set provenance='stated' when the user explicitly told you this (trusted higher than 'inferred').",
    {
      title: z.string(),
      observation: z.string(),
      evidence: z.string().optional(),
      context: z.string().optional(),
      provenance: z.enum(["stated", "inferred"]).optional(),
      confidence: z.enum(["low", "med", "high"]).optional(),
    },
    async (args) => {
      const path = `${paths.learnings}/${today()}-${slugify(args.title)}.md`;
      if (app.vault.getAbstractFileByPath(path)) return err(`Already exists: ${path}`);
      await ensureParentFolder(app, path);
      const body =
        `# Learning: ${args.title}\n\n` +
        `## Osservazione\n${args.observation}\n\n` +
        (args.evidence ? `## Evidenza\n${args.evidence}\n\n` : "") +
        (args.context ? `## Contesto\n${args.context}\n` : "");
      const file = await app.vault.create(path, body);
      await app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => {
        f.type = "memory";
        f.created_by = "exo";
        f.created = today();
        f.provenance = args.provenance ?? "inferred";
        f.confidence = args.confidence ?? "med";
        f.evidence = 1;
        f.status = "candidate";
        f.last_confirmed = today();
        f.tags = ["type/memory"];
      });
      return ok(`Captured learning → [[${path}]]`);
    }
  );

  /* ------------------- memory union store (v1) -------------------- */

  const remember = tool(
    "remember",
    "Call this when the user states a durable preference, fact, or decision, or corrects something you got wrong. Store their exact words — do not summarize. If it contradicts an earlier memory, pass that memory's id as supersedes instead of rewording history.",
    {
      text: z.string().describe("The user's exact words, stored verbatim."),
      kind: z.enum(["preference", "fact", "decision", "lesson"]),
      tags: z.array(z.string()).optional(),
      supersedes: z.string().optional().describe("Id (mem-…) of an earlier memory this one replaces."),
    },
    async (args) => {
      const at = Date.now();
      const entry: MemoryEntry = {
        id: `mem-${at}`,
        kind: args.kind,
        at,
        session: "unknown",
        tags: args.tags ?? [],
        // `remember` captures the user's own words — always @user provenance.
        source: "user",
        ...(args.supersedes ? { supersedes: args.supersedes } : {}),
        text: args.text,
      };
      const path = `${paths.store}/${monthFileName(at)}`;
      const block = formatEntry(entry);
      // Serialize the read-modify-write through the shared queue so concurrent
      // store writers never interleave or clobber the monthly file.
      await memoryWriteQueue.enqueue(async () => {
        const existing = app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
          const cur = await app.vault.read(existing);
          await app.vault.modify(existing, `${cur.replace(/\s+$/, "")}\n\n${block}\n`);
        } else {
          await ensureParentFolder(app, path);
          await app.vault.create(path, `${block}\n`);
        }
      });
      return ok(
        `Remembered ${entry.id} (${entry.kind})${entry.supersedes ? `, supersedes ${entry.supersedes}` : ""}.`
      );
    }
  );

  const recall = tool(
    "recall",
    "Call this before answering anything that may depend on prior sessions — user preferences, past decisions, project facts. Returns stored memories verbatim. Pass `as_of` (YYYY-MM-DD) for a point-in-time query — 'what did I believe on that date?' — resolving the supersedes chain as of that day (entries superseded only afterwards are still shown, flagged with how they later changed).",
    { query: z.string(), k: z.number().optional(), as_of: z.string().optional().describe("YYYY-MM-DD — resolve beliefs as of this date instead of now.") },
    async (args) => {
      const k = Math.min(Math.max(args.k ?? 5, 1), 12);
      const asOfDate = args.as_of;
      if (asOfDate !== undefined && !isValidAsOfDate(asOfDate)) {
        return err(`Invalid as_of date "${asOfDate}" — expected a real calendar date in YYYY-MM-DD.`);
      }
      const files = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${paths.store}/`));
      const all: MemoryEntry[] = [];
      for (const f of files) {
        try {
          all.push(...parseStoreFile(await app.vault.cachedRead(f)));
        } catch {
          /* skip unreadable file */
        }
      }
      if (all.length === 0) return ok("No memories stored yet.");

      // Point-in-time: resolve the belief set current as of `asOfDate`; else the live set.
      const asOf = asOfDate ? currentAsOf(all, asOfDate) : undefined;
      const pool = asOf ? asOf.current : resolveSupersedence(all);
      const scored = scoreEntries(args.query, pool)
        .filter((s) => s.score > 0)
        .slice(0, k);
      if (scored.length === 0) {
        return ok(
          asOfDate
            ? `No stored memories as of ${asOfDate} match "${args.query}".`
            : `No stored memories match "${args.query}".`
        );
      }
      const body = scored
        .map(({ entry }) => {
          const date = new Date(entry.at).toISOString().slice(0, 10);
          const tags = entry.tags.length ? ` · tags: ${entry.tags.join(", ")}` : "";
          // Mark autonomously-written memories; user memories need no marker.
          const prov = entry.source === "generated" ? " · @generated" : "";
          // In an as-of query, flag a belief that was superseded AFTER the queried date.
          const later = asOf?.supersededAfter.get(entry.id);
          const evolved = later ? ` · (superseded on ${later.on} by ${later.by})` : "";
          return `${entry.id} · ${entry.kind} · ${date}${tags}${prov}${evolved}\n${entry.text}`;
        })
        .join("\n\n");
      return ok(asOfDate ? `As of ${asOfDate}:\n\n${body}` : body);
    }
  );

  /* ------------------- agent identity (rethink) ------------------- */

  const rethinkMemory = tool(
    "rethink_memory",
    "Rewrite one of your identity blocks when your MODEL OF THE WORLD changes — not for episodic notes (those go to `remember`). `now.md` = what matters right now (hot projects, focus); `human.md` = your distilled working model of the user (pass a `rationale` — it's surfaced with the change); `persona.md` = how you behave (this only PROPOSES a change for the user to approve, it does not write). Pass the WHOLE new block content, not a patch.",
    {
      block: z.enum(["persona", "human", "now"]),
      new_content: z.string().describe("The complete new content for the block (replaces it whole; never truncated)."),
      rationale: z.string().optional().describe("Why the change — required for human.md, surfaced prominently in the change."),
    },
    async (args) => {
      if (!rethinkBridge) return err("The agent identity layer is off.");
      try {
        const status = await rethinkBridge({
          block: args.block,
          content: args.new_content,
          ...(args.rationale ? { rationale: args.rationale } : {}),
        });
        return ok(status);
      } catch (e) {
        return err(`Couldn't rethink ${args.block}.md: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  /* --------------------------- open loops -------------------------- */

  /** `YYYY-MM-DD`, matching the ledger's on-disk tickler-date format. */
  const RESURFACE_RE = /^\d{4}-\d{2}-\d{2}$/;

  async function readLoops(): Promise<LoopEntry[]> {
    const f = app.vault.getAbstractFileByPath(paths.openLoops);
    if (!(f instanceof TFile)) return [];
    try {
      return parseLoopsFile(await app.vault.cachedRead(f));
    } catch {
      return [];
    }
  }

  const openLoop = tool(
    "open_loop",
    "Record an open loop — a follow-up, promise, or thing to circle back on — in the Open-Loops Ledger. Optionally set a `resurface` tickler date (YYYY-MM-DD) for when it should come back up; omit it to make the loop due immediately.",
    {
      title: z.string(),
      context: z.string().describe("The verbatim context — what this loop is about, stored as-is."),
      resurface: z
        .string()
        .regex(RESURFACE_RE, "resurface must be YYYY-MM-DD")
        .optional(),
      tags: z.array(z.string()).optional(),
    },
    async (args) => {
      const openedAt = Date.now();
      const entry: LoopEntry = {
        id: `loop-${openedAt}`,
        title: args.title,
        note: args.context,
        openedAt,
        status: "open",
        ...(args.resurface ? { resurface: args.resurface } : {}),
        ...(args.tags && args.tags.length ? { tags: args.tags } : {}),
      };
      const block = formatLoop(entry);
      await loopsWriteQueue.enqueue(async () => {
        const existing = app.vault.getAbstractFileByPath(paths.openLoops);
        if (existing instanceof TFile) {
          const cur = await app.vault.read(existing);
          await app.vault.modify(existing, `${cur.replace(/\s+$/, "")}\n\n${block}\n`);
        } else {
          await ensureParentFolder(app, paths.openLoops);
          await app.vault.create(paths.openLoops, `${block}\n`);
        }
      });
      return ok(`Opened ${entry.id}: ${entry.title}${entry.resurface ? ` (resurfaces ${entry.resurface})` : ""}.`);
    }
  );

  const closeLoopTool = tool(
    "close_loop",
    "Close an open loop by id (from `open_loop` or `list_loops`). The entry is never deleted — it's kept in the ledger with status=closed and, if given, an appended outcome note.",
    { id: z.string(), outcome: z.string().optional() },
    async (args) => {
      let result: Result | undefined;
      await loopsWriteQueue.enqueue(async () => {
        const f = app.vault.getAbstractFileByPath(paths.openLoops);
        if (!(f instanceof TFile)) {
          result = err(`No open-loops ledger yet — nothing to close.`);
          return;
        }
        const cur = await app.vault.read(f);
        const entries = parseLoopsFile(cur);
        let closed: LoopEntry[];
        try {
          closed = closeLoop(entries, args.id, args.outcome);
        } catch {
          result = err(`No loop found with id ${args.id}.`);
          return;
        }
        const body = closed.map(formatLoop).join("\n\n");
        await app.vault.modify(f, `${body}\n`);
        result = ok(`Closed ${args.id}.`);
      });
      return result ?? err("Failed to close loop.");
    }
  );

  const listLoops = tool(
    "list_loops",
    "List open loops from the Open-Loops Ledger — due ones first, then other active ones. Read-only.",
    {},
    async () => {
      const entries = await readLoops();
      const due = dueLoops(entries);
      const dueIds = new Set(due.map((e) => e.id));
      const others = activeLoops(entries).filter((e) => !dueIds.has(e.id));
      if (due.length === 0 && others.length === 0) return ok("No open loops.");
      const line = (e: LoopEntry, label: string) =>
        `- [${label}] ${e.id} — ${e.title}${e.resurface ? ` (resurface: ${e.resurface})` : ""}`;
      const body = [
        ...due.map((e) => line(e, "due")),
        ...others.map((e) => line(e, "open")),
      ].join("\n");
      return ok(body);
    }
  );

  /* --------------------------- orchestration ------------------------ */

  const addTask = tool(
    "add_task",
    "Put something on the Orchestration Board as a backlog task — use this when the user asks to put this on the board, turn this into a task, or queue this up for later instead of doing it in this conversation right now. Creates a `backlog` entry; it does not run anything.",
    {
      title: z.string().describe("Short task title shown on the board card."),
      prompt: z.string().describe("The task prompt — what the spawned conversation should do, verbatim."),
      model: z.string().optional().describe("Provider model id to run the task with; omit to use the default from settings."),
    },
    async (args) => {
      const vault = adaptAppToTaskVault(app);
      const entry = await createBacklogTask(vault, tasksWriteQueue, {
        title: args.title,
        prompt: args.prompt,
        ...(args.model ? { model: args.model } : {}),
      });
      return ok(`Added ${entry.id} to the Backlog: ${entry.title}`);
    }
  );

  /* ------------------------- automations (exo) ------------------------- */
  // Chat-side management of scheduled playbook runs — the same operations as
  // the Automations panel, so "metti in pausa il digest" works as a sentence.
  // All four resolve the live exo plugin instance at call time (never cached).

  const listAutomations = tool(
    "list_automations",
    "List Exo's automations (scheduled playbook runs): cadence, on/paused, read-only vs write mode, last/next run — plus available playbooks and recent write runs with their review state and run ids. Use it before managing automations or when Mario asks what runs automatically.",
    {},
    async () => {
      const exo = getExo(app);
      if (!exo) return ok("Exo plugin not reachable.");
      const s = exo.settings;
      const now = Date.now();
      const lines: string[] = [];
      if (!s.automations.length) lines.push("No automations configured.");
      for (const a of s.automations) {
        const last = s.scheduledLastRun[automationLastRunKey(a)] ?? 0;
        const next = a.enabled ? ` · next ${fmtDueIn(nextDueAt(a.cadence, last, now) - now)}` : "";
        const mode = a.system === "daily-pulse"
          ? "writes _system/review.md (marker-safe)"
          : a.write ? "writes (checkpointed, restorable)" : "read-only";
        lines.push(
          `- ${a.name} — ${cadenceLabel(a.cadence)} · ${a.enabled ? "on" : "paused"} · ${mode}${next}`
        );
      }
      lines.push("", `Playbooks: ${s.customPrompts.map((p) => p.name).join(", ") || "(none)"}`);
      const runs = await exo.loadAutomationRuns();
      if (runs.length) {
        lines.push("", "Recent write runs:");
        for (const r of runs.slice(0, 6)) {
          const state = r.restoredAt ? "restored" : r.reviewedAt ? "reviewed" : "TO REVIEW";
          lines.push(`- [${r.id}] ${r.name} · ${new Date(r.startedAt).toLocaleString()} · ${r.writes.length} notes · ${state}`);
        }
      }
      return ok(lines.join("\n"));
    }
  );

  const savePlaybook = tool(
    "save_playbook",
    "Create or update a reusable playbook (a named prompt in Exo's settings — what automations and the / menu run). Show Mario the exact name and prompt you're saving BEFORE calling this. Set overwrite to update an existing playbook.",
    { name: z.string(), prompt: z.string(), overwrite: z.boolean().optional() },
    async (args) => {
      const exo = getExo(app);
      if (!exo) return ok("Exo plugin not reachable.");
      const s = exo.settings;
      const existing = s.customPrompts.find((p) => p.name.toLowerCase() === args.name.toLowerCase());
      if (existing && !args.overwrite) {
        return ok(`Playbook "${existing.name}" already exists — pass overwrite: true to replace it.`);
      }
      if (existing) existing.prompt = args.prompt;
      else s.customPrompts.push({ name: args.name, prompt: args.prompt });
      await exo.saveSettings();
      return ok(`${existing ? "Updated" : "Saved"} playbook "${args.name}".`);
    }
  );

  const manageAutomation = tool(
    "manage_automation",
    "Create, update, pause, resume, delete, or run an Exo automation. `name` is the playbook name (must exist for create — see list_automations). Cadence: kind hourly|daily|weekly, hour 0–23, day 0–6 or a day name. `write: true` lets scheduled runs edit vault notes (checkpointed + restorable) — confirm with Mario before enabling it. run_now executes the playbook immediately (may take minutes) and reports to _system/reports/.",
    {
      action: z.enum(["create", "update", "pause", "resume", "delete", "run_now"]),
      name: z.string(),
      cadence_kind: z.enum(["hourly", "daily", "weekly"]).optional(),
      hour: z.number().optional(),
      day: z.union([z.number(), z.string()]).optional(),
      write: z.boolean().optional(),
    },
    async (args) => {
      const exo = getExo(app);
      if (!exo) return ok("Exo plugin not reachable.");
      const s = exo.settings;
      const auto = s.automations.find(
        (a) => !a.system && a.name.toLowerCase() === args.name.toLowerCase()
      );
      const playbook = s.customPrompts.find((p) => p.name.toLowerCase() === args.name.toLowerCase());

      if (args.action === "run_now") {
        if (!playbook) return ok(`No playbook named "${args.name}" — see list_automations.`);
        const write = args.write ?? auto?.write ?? false;
        const okRun = await exo.runPlaybook(playbook.name, playbook.prompt, { write });
        if (okRun) {
          s.scheduledLastRun[playbook.name] = Date.now();
          await exo.saveSettings();
        }
        return ok(okRun ? "Run completed — report in _system/reports/." : "Run failed — see the report in _system/reports/.");
      }
      if (args.action === "create") {
        if (!playbook) return ok(`No playbook named "${args.name}" — create it first with save_playbook.`);
        if (auto) return ok(`Automation "${auto.name}" already exists — use update.`);
        const cadence = parseCadenceInput(args.cadence_kind ?? "daily", args.hour, args.day);
        if (!cadence) return ok("Invalid cadence — hour must be 0–23, day 0–6 or a day name.");
        s.automations.push({ name: playbook.name, cadence, enabled: true, write: args.write ?? false });
        // First fire at the next slot, not this instant.
        s.scheduledLastRun[playbook.name] = Date.now();
        await exo.saveSettings();
        return ok(`Automation created: ${playbook.name} — ${cadenceLabel(cadence)}, ${args.write ? "writes" : "read-only"}.`);
      }
      if (!auto) return ok(`No automation named "${args.name}" — see list_automations.`);
      if (args.action === "delete") {
        s.automations.splice(s.automations.indexOf(auto), 1);
        await exo.saveSettings();
        return ok(`Automation "${auto.name}" deleted (the playbook itself is untouched).`);
      }
      if (args.action === "pause" || args.action === "resume") {
        auto.enabled = args.action === "resume";
        await exo.saveSettings();
        return ok(`Automation "${auto.name}" ${auto.enabled ? "resumed" : "paused"}.`);
      }
      // update
      if (args.cadence_kind || args.hour !== undefined || args.day !== undefined) {
        const cadence = parseCadenceInput(
          args.cadence_kind ?? auto.cadence.kind,
          args.hour ?? (auto.cadence.kind !== "hourly" ? auto.cadence.hour : undefined),
          args.day ?? (auto.cadence.kind === "weekly" ? auto.cadence.day : undefined)
        );
        if (!cadence) return ok("Invalid cadence — hour must be 0–23, day 0–6 or a day name.");
        auto.cadence = cadence;
      }
      if (args.write !== undefined) auto.write = args.write;
      await exo.saveSettings();
      return ok(`Automation updated: ${auto.name} — ${cadenceLabel(auto.cadence)}, ${auto.enabled ? "on" : "paused"}, ${auto.write ? "writes" : "read-only"}.`);
    }
  );

  const reviewAutomationRun = tool(
    "review_automation_run",
    "Close out an automation write run: action 'reviewed' marks it OK; action 'restore' reverts EVERY note the run touched to its pre-run snapshot — destructive to the run's edits, confirm with Mario first. `id` comes from list_automations; omit it to target the most recent unreviewed run.",
    { action: z.enum(["reviewed", "restore"]), id: z.string().optional() },
    async (args) => {
      const exo = getExo(app);
      if (!exo) return ok("Exo plugin not reachable.");
      const runs = await exo.loadAutomationRuns();
      const target = args.id ? runs.find((r) => r.id === args.id) : unreviewedWriteRuns(runs)[0];
      if (!target) return ok(args.id ? `No run with id "${args.id}".` : "No unreviewed write runs.");
      if (args.action === "reviewed") {
        await exo.markAutomationRunReviewed(target.id);
        return ok(`Run "${target.name}" (${target.id}) marked as reviewed.`);
      }
      const restored = await exo.restoreAutomationRun(target.id);
      return ok(
        restored.length
          ? `Restored ${restored.length} note(s) from "${target.name}": ${restored.join(", ")}`
          : `Nothing restorable in "${target.name}" (missing snapshots).`
      );
    }
  );

  return [
    searchVault, readNote, getBacklinks, getNeighborhood, getConnections, listNotes, listTags, getActiveContext,
    listAnnotations, listSonarActions, askUser, listLoops,
    createNote, appendToNote, updateFrontmatter, addLinks, linkMentions, ignoreMentionTool, openNote,
    editNote, insertAtCursor, renameNote, resolveAnnotation, runSonarAction,
    listAutomations, savePlaybook, manageAutomation, reviewAutomationRun,
    ...(memoryRead ? [recall] : []),
    ...(memoryWrite ? [captureDecision, logSession, captureLearning, remember, openLoop, closeLoopTool] : []),
    // The Agent Is the Folder: `rethink_memory` needs BOTH memory-write and the
    // agent-folder flag, plus a live view bridge to render its diff/proposal.
    ...(memoryWrite && agentFolderEnabled && rethinkBridge ? [rethinkMemory] : []),
    ...(orchestrationEnabled ? [addTask] : []),
  ];
}

/**
 * In-process MCP server exposing Obsidian-native tools to the agent via the
 * Claude Agent SDK. Thin wrapper around {@link buildObsidianTools} — the tool
 * array itself is built there so the Codex↔Obsidian bridge can consume it
 * directly without going through `createSdkMcpServer`.
 */
export function createObsidianToolServer(
  app: App,
  alwaysLoad = true,
  memoryWrite = true,
  askBridge?: (questions: AskQuestion[]) => Promise<Record<string, string>>,
  memoryRead = true,
  memoryWriteQueue: WriteQueue = new WriteQueue(),
  orchestrationEnabled = false,
  tasksWriteQueue: WriteQueue = new WriteQueue(),
  agentFolderEnabled = false,
  rethinkBridge?: (req: RethinkRequest) => Promise<string>,
  loopsWriteQueue: WriteQueue = new WriteQueue(),
  paths: ExoPaths = exoPaths(LEGACY_MEMORY_ROOT)
) {
  return createSdkMcpServer({
    name: "obsidian",
    version: "1.0.0",
    alwaysLoad,
    instructions:
      "Obsidian-native tools. Prefer these over generic file/Bash tools for vault work — they respect links, tags, and frontmatter.",
    tools: buildObsidianTools(app, {
      alwaysLoad,
      memoryWrite,
      askBridge,
      memoryRead,
      memoryWriteQueue,
      loopsWriteQueue,
      orchestrationEnabled,
      tasksWriteQueue,
      agentFolderEnabled,
      rethinkBridge,
      paths,
    }),
  });
}

/** Read-only obsidian tools that can be auto-allowed without a permission card. */
export const OBSIDIAN_READ_TOOLS = new Set([
  "mcp__obsidian__search_vault",
  "mcp__obsidian__read_note",
  "mcp__obsidian__get_backlinks",
  "mcp__obsidian__get_neighborhood",
  "mcp__obsidian__get_connections",
  "mcp__obsidian__list_notes",
  "mcp__obsidian__list_tags",
  "mcp__obsidian__get_active_context",
  "mcp__obsidian__list_annotations",
  "mcp__obsidian__list_sonar_actions",
  "mcp__obsidian__recall",
  "mcp__obsidian__list_loops",
  "mcp__obsidian__list_automations",
]);

/** Memory-write tool names (gated separately by the memoryWrite setting). */
export const OBSIDIAN_MEMORY_TOOLS = new Set([
  "mcp__obsidian__capture_decision",
  "mcp__obsidian__log_session",
  "mcp__obsidian__capture_learning",
  "mcp__obsidian__remember",
  "mcp__obsidian__open_loop",
  "mcp__obsidian__close_loop",
  "mcp__obsidian__rethink_memory",
]);

/** Orchestration tool names — gated separately by the `orchestrationEnabled` setting. */
export const OBSIDIAN_ORCHESTRATION_TOOLS = new Set(["mcp__obsidian__add_task"]);
