import { spawn } from "child_process";
import { homedir } from "os";
import { existsSync, readdirSync, realpathSync } from "fs";
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
 *  asdf, bun, npm-global, $npm_config_prefix (if set), the Obsidian-app-adjacent
 *  dir (macOS only), then nvm version dirs (newest first). Pure/injectable. */
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
    `${home}/.bun/bin/${name}`,
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
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: string): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve(value);
      };
      c.stdout.on("data", (d: Buffer | string) => (out += d.toString()));
      c.on("error", () => finish(""));
      c.on("close", () => finish(out));
      timer = setTimeout(() => {
        try {
          c.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish("");
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
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve(value);
      };
      c.stdout.on("data", (d: Buffer | string) => (out += d.toString()));
      c.on("error", () => finish(null));
      c.on("close", () => {
        const m = out.match(/\d+\.\d+\.\d+[\w.-]*/);
        finish(m ? `v${m[0]}` : null);
      });
      timer = setTimeout(() => {
        try {
          c.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish(null);
      }, 5000);
    } catch {
      resolve(null);
    }
  });
}

/* ------------------------- install channel ---------------------------- */

export type InstallChannel = "native" | "npm";

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p; // broken symlink / missing — treat the path as-is
  }
}

/** How the resolved `claude` binary was installed — which decides the updater.
 *  The launcher path alone can't tell us (an npm-global bin lives at
 *  `<prefix>/bin/claude`, same shape as any other bin), so we follow the symlink:
 *  an npm install resolves to a file under `node_modules`, the native installer
 *  resolves into `~/.local/share/claude/…`. Anything else (homebrew, a bare
 *  path) defaults to native, because `claude update` is the CLI's own,
 *  install-method-aware self-updater and the safe general answer. `realpath` is
 *  injectable for tests. */
export function claudeInstallChannel(
  bin: string,
  realpath: (p: string) => string = safeRealpath
): InstallChannel {
  const target = realpath(bin).replace(/\\/g, "/");
  return /\/node_modules\//.test(target) ? "npm" : "native";
}

/* ------------------------------ update -------------------------------- */

/** Update the Claude CLI in place, using the updater that matches how it was
 *  installed. Native installs (the default installer) self-update via the CLI's
 *  own `claude update`; npm-global installs use `npm i -g …@latest` in the login
 *  shell (so it lands in the real npm prefix our probes read, not a GUI-inherited
 *  PATH). The npm path used to run unconditionally — a no-op or a *downgrade* for
 *  native installs, the common case, because npm's `latest` dist-tag trails the
 *  native channel and installs into a lower-priority path than `~/.local/bin`.
 *  Never rejects. On success clears the resolve + diag caches so the next probe
 *  re-resolves the fresh binary. `output` is a bounded tail of stdout+stderr. */
export function updateClaudeCli(cli: ResolvedCli): Promise<{ ok: boolean; output: string }> {
  const channel = claudeInstallChannel(cli.bin);
  const shell = process.env.SHELL || "/bin/zsh";
  return runUpdater(() =>
    channel === "npm"
      ? spawn(shell, ["-ilc", "npm install -g @anthropic-ai/claude-code@latest"], { env: process.env })
      : spawn(cli.bin, ["update"], { env: { ...process.env, PATH: cli.pathEnv } })
  );
}

/** Shared update runner: bounded output ring, 3-minute cap, and a resolve/diag
 *  cache-clear on success so the next probe sees the freshly-installed binary. */
function runUpdater(spawnProc: () => ReturnType<typeof spawn>): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: { ok: boolean; output: string }): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(result);
    };
    const append = (d: Buffer | string) => {
      out += d.toString();
      if (out.length > 8000) out = out.slice(-8000); // bounded ring
    };
    try {
      const c = spawnProc();
      c.stdout?.on("data", append);
      c.stderr?.on("data", append);
      c.on("error", (e: Error) => finish({ ok: false, output: e.message }));
      c.on("close", (code: number | null) => {
        const ok = code === 0;
        if (ok) {
          cliCache.clear();
          diagCache.clear();
          npmPrefixQuery = null;
        }
        finish({ ok, output: out.trim() });
      });
      // Both npm installs and `claude update` can be slow; cap at 3 minutes.
      timer = setTimeout(() => {
        try {
          c.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish({ ok: false, output: out.trim() || "Update timed out." });
      }, 180_000);
    } catch (e) {
      finish({ ok: false, output: e instanceof Error ? e.message : String(e) });
    }
  });
}

/* ------------------------------- mcp auth ----------------------------- */

/** (Re)authenticate an OAuth / remote MCP server via `claude mcp login <name>`.
 *  The CLI opens the system browser for the OAuth round-trip and stores the
 *  credentials in its own credential store; this resolves when that process
 *  exits. `cwd` must be the vault root so project-scoped (.mcp.json) servers
 *  resolve by name, and the enriched PATH is passed for the same reason the
 *  session spawn does (Obsidian doesn't inherit the login-shell PATH). Args are
 *  passed as an array (no shell), so the server name can't inject. Never
 *  rejects — resolves `{ ok, output }` with a bounded tail of stdout+stderr. */
export function mcpLogin(cli: ResolvedCli, name: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    if (!name.trim()) return resolve({ ok: false, output: "No server name." });
    let out = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: { ok: boolean; output: string }): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(result);
    };
    const append = (d: Buffer | string) => {
      out += d.toString();
      if (out.length > 8000) out = out.slice(-8000); // bounded ring
    };
    try {
      const c = spawn(cli.bin, ["mcp", "login", name], { cwd, env: { ...process.env, PATH: cli.pathEnv } });
      c.stdout.on("data", append);
      c.stderr.on("data", append);
      c.on("error", (e: Error) => finish({ ok: false, output: e.message }));
      c.on("close", (code: number | null) => finish({ ok: code === 0, output: out.trim() }));
      // OAuth is user-paced (browser round-trip) — give it 3 minutes before giving up.
      timer = setTimeout(() => {
        try {
          c.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish({ ok: false, output: out.trim() || "Authentication timed out." });
      }, 180_000);
    } catch (e) {
      finish({ ok: false, output: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** Clear stored OAuth credentials for an MCP server via `claude mcp logout <name>`.
 *  Unlike {@link mcpLogin} this is local and synchronous (no browser round-trip),
 *  so a short timeout is enough. Same never-rejects contract. */
export function mcpLogout(cli: ResolvedCli, name: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    if (!name.trim()) return resolve({ ok: false, output: "No server name." });
    let out = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: { ok: boolean; output: string }): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(result);
    };
    const append = (d: Buffer | string) => {
      out += d.toString();
      if (out.length > 8000) out = out.slice(-8000);
    };
    try {
      const c = spawn(cli.bin, ["mcp", "logout", name], { cwd, env: { ...process.env, PATH: cli.pathEnv } });
      c.stdout.on("data", append);
      c.stderr.on("data", append);
      c.on("error", (e: Error) => finish({ ok: false, output: e.message }));
      c.on("close", (code: number | null) => finish({ ok: code === 0, output: out.trim() }));
      timer = setTimeout(() => {
        try {
          c.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish({ ok: false, output: out.trim() || "Logout timed out." });
      }, 15_000);
    } catch (e) {
      finish({ ok: false, output: e instanceof Error ? e.message : String(e) });
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
