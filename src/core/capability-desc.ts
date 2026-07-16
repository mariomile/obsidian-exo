import { App } from "obsidian";
import { readdir, readFile, stat } from "fs/promises";
import { homedir } from "os";

/** name → one-line description, per capability kind. Names keep their CLI
 *  form: plugin-scoped entries are `plugin:name`, everything else is bare. */
export interface DescIndex {
  skills: Map<string, string>;
  commands: Map<string, string>;
  agents: Map<string, string>;
}

const DESC_MAX = 140;

/** Extract `description:` from a YAML frontmatter block. Handles single-line
 *  values (optionally quoted) and block scalars (`>-`, `|`, …) by joining the
 *  indented continuation lines. Returns undefined when absent. */
export function frontmatterDescription(raw: string): string | undefined {
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!fm) return undefined;
  const lines = fm.split(/\r?\n/);
  const i = lines.findIndex((l) => /^description:/.test(l));
  if (i === -1) return undefined;
  let val = lines[i].slice("description:".length).trim();
  if (val === "" || /^[>|][+-]?$/.test(val)) {
    const parts: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (!/^\s+\S/.test(lines[j])) break;
      parts.push(lines[j].trim());
    }
    val = parts.join(" ");
  }
  return val.replace(/^["']|["']$/g, "").trim() || undefined;
}

/** First non-empty body line (frontmatter stripped, heading/quote markers
 *  removed) — fallback for commands written without a frontmatter block. */
export function firstBodyLine(raw: string): string | undefined {
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  for (const line of body.split(/\r?\n/)) {
    const t = line.replace(/^#{1,6}\s+/, "").replace(/^>\s*/, "").trim();
    if (t) return t;
  }
  return undefined;
}

const baseName = (p: string) => p.split("/").pop()!.replace(/\.md$/, "");

async function descFrom(read: () => Promise<string>, bodyFallback = false): Promise<string | undefined> {
  try {
    // Frontmatter lives at the top — reading the whole file is fine (they're
    // small), but only the head is parsed.
    const raw = (await read()).slice(0, 6000);
    const desc = frontmatterDescription(raw) ?? (bodyFallback ? firstBodyLine(raw) : undefined);
    return desc?.slice(0, DESC_MAX);
  } catch {
    return undefined;
  }
}

/** A capability root: `skills/` (folders with SKILL.md, or loose .md files),
 *  `commands/` and `agents/` (.md files). Reader is injected so the same walk
 *  covers vault-adapter paths and plain filesystem paths. */
interface Scope {
  /** List a subdir → { folders, files } as full paths (missing dir → empty). */
  list: (sub: string) => Promise<{ folders: string[]; files: string[] }>;
  read: (path: string) => Promise<string>;
  /** Prepended to every name (e.g. `posthog:` for plugin scopes). */
  prefix?: string;
}

async function scanScope(idx: DescIndex, scope: Scope): Promise<void> {
  const put = (map: Map<string, string>, name: string, desc?: string) => {
    if (desc && !map.has(name)) map.set(name, desc);
  };
  const pre = scope.prefix ?? "";
  const skills = await scope.list("skills");
  const commands = await scope.list("commands");
  const agents = await scope.list("agents");
  await Promise.all([
    ...skills.folders.map(async (f) =>
      put(idx.skills, pre + baseName(f), await descFrom(() => scope.read(`${f}/SKILL.md`)))
    ),
    ...skills.files
      .filter((f) => f.endsWith(".md"))
      .map(async (f) => put(idx.skills, pre + baseName(f), await descFrom(() => scope.read(f)))),
    ...commands.files
      .filter((f) => f.endsWith(".md"))
      // Commands often skip frontmatter and open with a one-line summary —
      // fall back to the first body line so they still get a snippet.
      .map(async (f) => put(idx.commands, pre + baseName(f), await descFrom(() => scope.read(f), true))),
    ...agents.files
      .filter((f) => f.endsWith(".md"))
      .map(async (f) => put(idx.agents, pre + baseName(f), await descFrom(() => scope.read(f)))),
  ]);
}

function fsScope(root: string, prefix?: string): Scope {
  return {
    prefix,
    list: async (sub) => {
      try {
        const entries = await readdir(`${root}/${sub}`, { withFileTypes: true });
        const folders: string[] = [];
        const files: string[] = [];
        for (const e of entries) {
          const p = `${root}/${sub}/${e.name}`;
          let isDir = e.isDirectory();
          // Skills are commonly symlinked into ~/.claude/skills (Dirent reports
          // them as symlinks, not directories) — follow to classify.
          if (e.isSymbolicLink()) {
            try {
              isDir = (await stat(p)).isDirectory();
            } catch {
              continue; // dangling link
            }
          }
          (isDir ? folders : files).push(p);
        }
        return { folders, files };
      } catch {
        return { folders: [], files: [] };
      }
    },
    read: (p) => readFile(p, "utf8"),
  };
}

function vaultScope(app: App): Scope {
  return {
    list: async (sub) => {
      try {
        const res = await app.vault.adapter.list(`.claude/${sub}`);
        return { folders: res.folders, files: res.files };
      } catch {
        return { folders: [], files: [] };
      }
    },
    read: (p) => app.vault.adapter.read(p),
  };
}

/** Installed-plugin roots from `~/.claude/plugins/installed_plugins.json`,
 *  each yielding `pluginName:`-prefixed capability names. */
async function pluginScopes(): Promise<Scope[]> {
  try {
    const raw = await readFile(`${homedir()}/.claude/plugins/installed_plugins.json`, "utf8");
    const json = JSON.parse(raw) as { plugins?: Record<string, { installPath?: string }[]> };
    const scopes: Scope[] = [];
    for (const [key, entries] of Object.entries(json.plugins ?? {})) {
      const plugin = key.split("@")[0];
      for (const e of entries ?? []) {
        if (e?.installPath) scopes.push(fsScope(e.installPath, `${plugin}:`));
      }
    }
    return scopes;
  } catch {
    return [];
  }
}

/** Scan every capability scope for frontmatter descriptions. First write wins,
 *  so scope order encodes precedence: vault `.claude/` > global `~/.claude/` >
 *  installed plugins. Never throws — unreadable dirs/files just yield no desc. */
export async function buildDescIndex(app: App): Promise<DescIndex> {
  const idx: DescIndex = { skills: new Map(), commands: new Map(), agents: new Map() };
  await scanScope(idx, vaultScope(app));
  await scanScope(idx, fsScope(`${homedir()}/.claude`));
  for (const scope of await pluginScopes()) await scanScope(idx, scope);
  return idx;
}
