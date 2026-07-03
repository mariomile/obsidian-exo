import { spawn } from "child_process";
import { homedir } from "os";
import { existsSync, readdirSync } from "fs";
import { dirname } from "path";

/** A resolved CLI invocation: the binary plus an enriched PATH for the spawn. */
export interface ResolvedCli {
  bin: string;
  pathEnv: string;
}

/**
 * Resolve a CLI binary (`claude` or `codex`) + a usable PATH.
 *
 * GUI apps (Obsidian) don't inherit the shell PATH, and tools like nvm only
 * export PATH from `.zshrc` (interactive shells). Resolution order (highest to
 * lowest priority):
 *
 *   1. explicit setting
 *   2. fixed well-known install paths (~/.claude/local, ~/.local, homebrew, /usr/local)
 *   3. the live npm global prefix from the login shell (`npm prefix -g`)
 *   4. version-manager / fallback dirs (volta, asdf, npm-global, $npm_config_prefix,
 *      the Obsidian-app-adjacent dir on macOS, then nvm)
 *   5. an interactive login-shell `command -v` lookup
 *   6. the bare command name
 *
 * Why the live npm prefix (3) beats the version-manager dirs (4): a stale,
 * orphaned copy can linger in an nvm version dir long after the user's real npm
 * prefix moved elsewhere. Updates land in the login shell's prefix, so it must
 * win over those version-manager hits — but still lose to explicit well-known
 * install paths (2), which are canonical.
 *
 * Adapted from obsidian-selection-toolbar/src/ai/client.ts, generalized for any
 * binary name.
 */
const cliCache = new Map<string, ResolvedCli>();

export async function resolveCli(name: string, configured: string): Promise<ResolvedCli> {
  if (!/^[a-z]+$/.test(name)) throw new Error(`Invalid CLI name: ${name}`);
  const key = `${name} ${configured.trim()}`;
  const cached = cliCache.get(key);
  if (cached) return cached;
  const home = homedir();
  const bin =
    (configured && configured.trim()) ||
    firstExisting(fixedPathCandidates(name, home)) ||
    (await probeNpmPrefix(name)) ||
    firstExisting(
      versionManagerCandidates(name, home, {
        npmConfigPrefix: process.env.npm_config_prefix,
        nvmVersions: nvmVersionDirs(home),
      })
    ) ||
    (await probeLoginShell(name)) ||
    name;
  const resolved = { bin, pathEnv: buildPathEnv(bin) };
  cliCache.set(key, resolved);
  return resolved;
}

/* --------------------------- path candidates -------------------------- */

/** Canonical, well-known install locations — checked first (they beat the live
 *  npm prefix and every version-manager dir). Pure/injectable for tests. */
export function fixedPathCandidates(name: string, home: string): string[] {
  return [
    `${home}/.${name}/local/${name}`, // e.g. ~/.claude/local/claude
    `${home}/.local/bin/${name}`,
    `${home}/.local/node/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ];
}

/** Version-manager + fallback locations — checked AFTER the live npm prefix, so
 *  a stale copy here can't beat a freshly-updated global install. Order: volta,
 *  asdf, npm-global, $npm_config_prefix (if set), the Obsidian-app-adjacent dir
 *  (macOS only), then nvm version dirs (newest first). Pure/injectable. */
export function versionManagerCandidates(
  name: string,
  home: string,
  opts: {
    npmConfigPrefix?: string;
    nvmVersions?: string[];
    platform?: NodeJS.Platform;
    execPath?: string;
  } = {}
): string[] {
  const platform = opts.platform ?? process.platform;
  const execPath = opts.execPath ?? process.execPath;
  const out = [
    `${home}/.volta/bin/${name}`,
    `${home}/.asdf/shims/${name}`,
    `${home}/.npm-global/bin/${name}`,
  ];
  if (opts.npmConfigPrefix) out.push(`${opts.npmConfigPrefix}/bin/${name}`);
  if (platform === "darwin" && execPath) out.push(`${dirname(execPath)}/${name}`);
  for (const v of opts.nvmVersions ?? []) out.push(`${home}/.nvm/versions/node/${v}/bin/${name}`);
  return out;
}

/** Return the first candidate path that exists on disk (null if none). The
 *  `exists` predicate is injectable so ordering can be unit-tested without fs. */
export function firstExisting(candidates: string[], exists: (p: string) => boolean = safeExists): string | null {
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return null;
}

/** nvm version dirs (newest first), or [] if nvm isn't installed. */
function nvmVersionDirs(home: string): string[] {
  try {
    return readdirSync(`${home}/.nvm/versions/node`).sort().reverse();
  } catch {
    return []; // no nvm
  }
}

/* ----------------------------- shell probes --------------------------- */

/** Run a command in an *interactive* login shell (sources .zshrc, where nvm /
 *  PATH setup usually lives) and resolve its raw stdout. Interactive rc files
 *  can stall, so we hard-kill after `timeoutMs`. Never rejects — resolves "". */
function loginShellExec(cmd: string, timeoutMs = 6000): Promise<string> {
  return new Promise((resolve) => {
    try {
      const shell = process.env.SHELL || "/bin/zsh";
      const c = spawn(shell, ["-ilc", cmd], { env: process.env });
      let out = "";
      c.stdout.on("data", (d: Buffer | string) => (out += d.toString()));
      c.on("error", () => resolve(""));
      c.on("close", () => resolve(out));
      setTimeout(() => {
        try {
          c.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve("");
      }, timeoutMs);
    } catch {
      resolve("");
    }
  });
}

/** The user's global npm prefix, queried once via the login shell (cached).
 *  This is where `npm i -g` updates actually land, so it's a reliable pointer
 *  to the *live* binary even when a version manager holds a stale copy. */
let npmPrefixQuery: Promise<string | null> | null = null;
function getNpmPrefix(): Promise<string | null> {
  if (!npmPrefixQuery) {
    npmPrefixQuery = loginShellExec("npm prefix -g").then((out) => {
      const line = out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .find((l) => l.startsWith("/"));
      return line ?? null;
    });
  }
  return npmPrefixQuery;
}

/** Probe `<npm prefix -g>/bin/<name>` (cached prefix lookup). */
async function probeNpmPrefix(name: string): Promise<string | null> {
  const prefix = await getNpmPrefix();
  if (!prefix) return null;
  const p = `${prefix}/bin/${name}`;
  return safeExists(p) ? p : null;
}

/** Last-resort `command -v <name>` in the interactive login shell. */
async function probeLoginShell(name: string): Promise<string | null> {
  const out = await loginShellExec(`command -v ${name}`);
  const lines = out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const l of lines.reverse()) {
    if (l.startsWith("/") && safeExists(l)) return l;
  }
  return null;
}

function buildPathEnv(bin: string): string {
  const home = homedir();
  const dirs = [
    bin.includes("/") ? dirname(bin) : "",
    `${home}/.local/bin`,
    `${home}/.local/node/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    process.env.PATH || "",
  ];
  return dirs.filter(Boolean).join(":");
}

function safeExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/* --------------------------- diagnostics ------------------------------ */

/** What Settings shows under a binary-path field. `found` is true when we could
 *  confirm a real binary (a `--version` reply, or the resolved path exists). */
export interface CliDiagnostics {
  bin: string;
  version: string | null;
  found: boolean;
}

const diagCache = new Map<string, Promise<CliDiagnostics>>();

/** Resolve a CLI and read its `--version`, for the Settings diagnostics line.
 *  Cached per (name, configured); never blocks — the caller fills the UI async. */
export function cliDiagnostics(name: string, configured: string): Promise<CliDiagnostics> {
  const key = `${name} ${configured.trim()}`;
  const cached = diagCache.get(key);
  if (cached) return cached;
  const p = (async (): Promise<CliDiagnostics> => {
    const { bin, pathEnv } = await resolveCli(name, configured);
    const version = await probeVersion(bin, pathEnv);
    return { bin, version, found: version !== null || safeExists(bin) };
  })();
  diagCache.set(key, p);
  return p;
}

/** Spawn `<bin> --version` with the enriched PATH; parse a semver → "vX.Y.Z".
 *  5s timeout, resolves null on any failure. */
function probeVersion(bin: string, pathEnv: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const c = spawn(bin, ["--version"], { env: { ...process.env, PATH: pathEnv } });
      let out = "";
      c.stdout.on("data", (d: Buffer | string) => (out += d.toString()));
      c.on("error", () => resolve(null));
      c.on("close", () => {
        const m = out.match(/\d+\.\d+\.\d+[\w.-]*/);
        resolve(m ? `v${m[0]}` : null);
      });
      setTimeout(() => {
        try {
          c.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve(null);
      }, 5000);
    } catch {
      resolve(null);
    }
  });
}

/* ------------------------------ update -------------------------------- */

/** Install the latest Claude CLI via `npm i -g` in the user's *login* shell, so
 *  it lands in the same real npm prefix our resolution probes read (not some
 *  GUI-inherited PATH). Never rejects. On success clears the resolution + diag
 *  caches so the next probe re-resolves the freshly-installed binary. Output is
 *  a bounded tail of combined stdout/stderr for surfacing in a Notice. */
export function updateClaudeCli(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let out = "";
    const append = (d: Buffer | string) => {
      out += d.toString();
      if (out.length > 8000) out = out.slice(-8000); // bounded ring
    };
    try {
      const shell = process.env.SHELL || "/bin/zsh";
      const c = spawn(shell, ["-ilc", "npm install -g @anthropic-ai/claude-code@latest"], {
        env: process.env,
      });
      c.stdout.on("data", append);
      c.stderr.on("data", append);
      c.on("error", (e: Error) => resolve({ ok: false, output: e.message }));
      c.on("close", (code: number | null) => {
        const ok = code === 0;
        if (ok) {
          cliCache.clear();
          diagCache.clear();
        }
        resolve({ ok, output: out.trim() });
      });
      // npm installs can be slow; give it up to 3 minutes before giving up.
      setTimeout(() => {
        try {
          c.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve({ ok: false, output: out.trim() || "Update timed out." });
      }, 180_000);
    } catch (e) {
      resolve({ ok: false, output: e instanceof Error ? e.message : String(e) });
    }
  });
}

/* ------------------------------ errors -------------------------------- */

export function makeAbortError(): Error {
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
}

/** True when the error is our own abort (cancel / restart). */
export function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/** Map a spawn/CLI error to a short, user-facing message. */
export function describeError(e: unknown, cliName = "CLI"): string {
  if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "ENOENT") {
    return `${cliName} not found. Run \`which ${cliName.toLowerCase()}\` in a terminal and paste the path in Exo settings.`;
  }
  if (e instanceof Error) {
    const msg = e.message || "";
    if (/not logged in|unauthorized|authentication/i.test(msg)) {
      return `${cliName} is not logged in — run it once in a terminal to sign in.`;
    }
    return msg || `${cliName} error.`;
  }
  return "Unknown error.";
}
