/**
 * Windows-specific CLI resolution rules, kept pure so they can be unit-tested
 * from any host OS. `src/cli.ts` owns the fs/spawn side and only calls in here
 * when `process.platform === "win32"`; macOS and Linux never touch this module.
 *
 * The shape of a Windows install:
 *   - native installer: `%USERPROFILE%\.local\bin\claude.exe` (a real .exe)
 *   - npm global:       `%APPDATA%\npm\claude.cmd`, a batch shim that points at
 *                       `node_modules\@anthropic-ai\claude-code\bin\claude.exe`
 *                       (claude) or `node_modules\@openai\codex\bin\codex.js`
 *                       run through `node` (codex)
 *   - scoop / volta / bun: `.exe` shims in their own bin dirs
 *
 * Node refuses to spawn a `.cmd`/`.bat` without `shell: true` since the April
 * 2024 security release (CVE-2024-27980), and the Claude Agent SDK spawns
 * `pathToClaudeCodeExecutable` directly with no shell. Going through cmd.exe
 * would also mangle arguments carrying quotes (Codex's `-c` JSON overrides).
 * So instead of shelling out we read the shim and resolve it to what it runs:
 * an `.exe` spawns directly, a `.js` spawns through `node`.
 */
import { win32 } from "path";

/** The env vars Windows resolution reads. Injected for tests. */
export interface WinEnv {
  USERPROFILE?: string;
  APPDATA?: string;
  LOCALAPPDATA?: string;
  npm_config_prefix?: string;
}

const EXEC_EXT = /\.(exe|cmd|bat|com)$/i;
const SHIM_EXT = /\.(cmd|bat)$/i;
const SCRIPT_EXT = /\.(c|m)?js$/i;

/** Canonical install locations, checked before the live npm prefix: the
 *  native installer, then npm's default global dir. */
export function windowsFixedCandidates(name: string, home: string, env: WinEnv): string[] {
  const out = [win32.join(home, ".local", "bin", `${name}.exe`)];
  if (env.APPDATA) out.push(win32.join(env.APPDATA, "npm", `${name}.cmd`));
  return out;
}

/** Package-manager shims, checked after the live npm prefix (mirrors the POSIX
 *  split: a stale copy here must not beat a freshly updated global install). */
export function windowsManagerCandidates(name: string, home: string, env: WinEnv): string[] {
  const out: string[] = [];
  if (env.LOCALAPPDATA) out.push(win32.join(env.LOCALAPPDATA, "Volta", "bin", `${name}.exe`));
  out.push(win32.join(home, "scoop", "shims", `${name}.exe`));
  out.push(win32.join(home, ".bun", "bin", `${name}.exe`));
  if (env.LOCALAPPDATA) out.push(win32.join(env.LOCALAPPDATA, "pnpm", `${name}.cmd`));
  if (env.npm_config_prefix) out.push(win32.join(env.npm_config_prefix, `${name}.cmd`));
  return out;
}

/** `<npm prefix -g>\<name>.cmd`: on Windows npm puts global shims directly in
 *  the prefix, with no `bin` segment. */
export function windowsNpmPrefixCandidate(prefix: string, name: string): string {
  return win32.join(prefix, `${name}.cmd`);
}

/** True for a drive-letter (`C:\`, `C:/`) or UNC (`\\server\share`) path. */
export function isWindowsAbsolute(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p);
}

/** First line of `npm prefix -g` output that is an absolute Windows path. */
export function pickWindowsPrefix(out: string): string | null {
  const line = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((l) => isWindowsAbsolute(l));
  return line ?? null;
}

/** From `where <name>` output, the first hit Windows can actually execute.
 *  `where` also lists the extensionless POSIX shell script npm drops next to
 *  the `.cmd` shim; that one is skipped. */
export function pickWhereHit(out: string, exists: (p: string) => boolean): string | null {
  for (const raw of out.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || !isWindowsAbsolute(l) || !EXEC_EXT.test(l)) continue;
    if (exists(l)) return l;
  }
  return null;
}

/** True when `bin` is a batch shim Node cannot spawn without a shell. */
export function isBatchShim(bin: string): boolean {
  return SHIM_EXT.test(bin);
}

/**
 * The program a cmd-shim runs, as an absolute path, or null when the shim has
 * a shape we don't recognize.
 *
 * Handles the generators in the wild: npm's `cmd-shim` (`"%dp0%\node_modules\…"`),
 * pnpm / yarn (`"%~dp0\…"`), and absolute targets. Of all quoted paths in the
 * file, the last one naming a script or an executable other than `node.exe`
 * wins: `node.exe` is the interpreter, the path after it is the program.
 */
export function resolveCmdShim(shimPath: string, content: string): string | null {
  const dir = win32.dirname(shimPath);
  let target: string | null = null;
  for (const m of content.matchAll(/"([^"\r\n]+)"/g)) {
    let p = m[1].trim();
    if (/%~?dp0%?/i.test(p)) p = p.replace(/%~?dp0%?/gi, dir + "\\");
    else if (!isWindowsAbsolute(p)) continue;
    if (/(^|[\\/])node(\.exe)?$/i.test(p)) continue;
    if (!EXEC_EXT.test(p) && !SCRIPT_EXT.test(p)) continue;
    target = win32.normalize(p);
  }
  return target;
}

/** How to spawn a resolved binary on `platform`: a `.js` target (the codex
 *  npm shim's program) runs through `node`; anything else spawns as-is. Only
 *  win32 is rewritten, so POSIX spawns stay exactly what they were. */
export function spawnSpec(
  bin: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[] } {
  if (platform === "win32" && SCRIPT_EXT.test(bin)) return { command: "node", args: [bin, ...args] };
  return { command: bin, args };
}

/** The PATH handed to a spawned CLI on Windows: the binary's own dir, the
 *  native installer and npm dirs, then the inherited PATH. `;`-joined. */
export function windowsPathEnv(bin: string, home: string, env: WinEnv & { PATH?: string }): string {
  const dirs = [
    isWindowsAbsolute(bin) ? win32.dirname(bin) : "",
    win32.join(home, ".local", "bin"),
    env.APPDATA ? win32.join(env.APPDATA, "npm") : "",
    env.PATH || "",
  ];
  return dirs.filter(Boolean).join(";");
}

/** Side effects the Windows resolution chain needs, injected so the whole
 *  order can be tested from any host OS. */
export interface WinResolveDeps {
  home: string;
  env: WinEnv;
  exists: (p: string) => boolean;
  readFile: (p: string) => string;
  /** `npm prefix -g`, or null when npm is missing. */
  npmPrefix: () => Promise<string | null>;
  /** Raw stdout of `where <name>`. */
  where: (name: string) => Promise<string>;
}

/**
 * Resolve `name` on Windows: explicit setting, native installer and
 * `%APPDATA%\npm`, the live npm prefix, package-manager shims, then `where`,
 * then the bare name. A batch shim is unwrapped to the program it runs, so
 * the result is always something Node (and the Agent SDK) can spawn without
 * a shell; an unreadable or unrecognized shim is returned as-is.
 */
export async function resolveWindowsBin(name: string, configured: string, deps: WinResolveDeps): Promise<string> {
  const first = (cands: string[]) => cands.find((c) => deps.exists(c)) ?? null;
  const viaPrefix = async (): Promise<string | null> => {
    const prefix = await deps.npmPrefix();
    if (!prefix) return null;
    const p = windowsNpmPrefixCandidate(prefix, name);
    return deps.exists(p) ? p : null;
  };
  const found =
    configured ||
    first(windowsFixedCandidates(name, deps.home, deps.env)) ||
    (await viaPrefix()) ||
    first(windowsManagerCandidates(name, deps.home, deps.env)) ||
    pickWhereHit(await deps.where(name), deps.exists) ||
    name;
  if (!isBatchShim(found)) return found;
  try {
    const target = resolveCmdShim(found, deps.readFile(found));
    return target && deps.exists(target) ? target : found;
  } catch {
    return found;
  }
}
