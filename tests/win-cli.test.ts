import { describe, it, expect } from "vitest";
import {
  isBatchShim,
  isWindowsAbsolute,
  pickWhereHit,
  pickWindowsPrefix,
  resolveCmdShim,
  resolveWindowsBin,
  type WinResolveDeps,
  spawnSpec,
  windowsFixedCandidates,
  windowsManagerCandidates,
  windowsNpmPrefixCandidate,
  windowsPathEnv,
} from "../src/core/win-cli";
import { toVaultRelative } from "../src/core/vault-path";

const HOME = "C:\\Users\\alice";
const ENV = {
  USERPROFILE: HOME,
  APPDATA: "C:\\Users\\alice\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
};

describe("windowsFixedCandidates", () => {
  it("puts the native installer first, then the npm global shim", () => {
    expect(windowsFixedCandidates("claude", HOME, ENV)).toEqual([
      "C:\\Users\\alice\\.local\\bin\\claude.exe",
      "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd",
    ]);
  });

  it("skips the npm dir when APPDATA is missing", () => {
    expect(windowsFixedCandidates("codex", HOME, {})).toEqual(["C:\\Users\\alice\\.local\\bin\\codex.exe"]);
  });
});

describe("windowsManagerCandidates", () => {
  it("lists volta, scoop, bun, pnpm, then $npm_config_prefix", () => {
    expect(
      windowsManagerCandidates("claude", HOME, { ...ENV, npm_config_prefix: "D:\\npm" })
    ).toEqual([
      "C:\\Users\\alice\\AppData\\Local\\Volta\\bin\\claude.exe",
      "C:\\Users\\alice\\scoop\\shims\\claude.exe",
      "C:\\Users\\alice\\.bun\\bin\\claude.exe",
      "C:\\Users\\alice\\AppData\\Local\\pnpm\\claude.cmd",
      "D:\\npm\\claude.cmd",
    ]);
  });
});

describe("npm prefix on Windows", () => {
  it("has no bin segment", () => {
    expect(windowsNpmPrefixCandidate("C:\\nvm4w\\nodejs", "claude")).toBe("C:\\nvm4w\\nodejs\\claude.cmd");
  });

  it("picks the absolute path out of noisy cmd output", () => {
    expect(pickWindowsPrefix("npm warn something\r\nC:\\Users\\alice\\AppData\\Roaming\\npm\r\n")).toBe(
      "C:\\Users\\alice\\AppData\\Roaming\\npm"
    );
    expect(pickWindowsPrefix("/usr/local\n")).toBeNull();
  });
});

describe("isWindowsAbsolute", () => {
  it("accepts drive-letter and UNC paths, rejects POSIX and relative ones", () => {
    expect(isWindowsAbsolute("C:\\x")).toBe(true);
    expect(isWindowsAbsolute("c:/x")).toBe(true);
    expect(isWindowsAbsolute("\\\\server\\share\\x")).toBe(true);
    expect(isWindowsAbsolute("/usr/bin")).toBe(false);
    expect(isWindowsAbsolute("claude")).toBe(false);
  });
});

describe("pickWhereHit", () => {
  const out = [
    "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude",
    "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd",
    "C:\\Users\\alice\\.local\\bin\\claude.exe",
  ].join("\r\n");

  it("skips npm's extensionless POSIX script and returns the first executable hit", () => {
    expect(pickWhereHit(out, () => true)).toBe("C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd");
  });

  it("honours the exists predicate", () => {
    expect(pickWhereHit(out, (p) => p.endsWith(".exe"))).toBe("C:\\Users\\alice\\.local\\bin\\claude.exe");
  });

  it("returns null for 'INFO: Could not find files'", () => {
    expect(pickWhereHit("INFO: Could not find files for the given pattern(s).", () => true)).toBeNull();
  });
});

describe("resolveCmdShim", () => {
  const SHIM = "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd";

  it("resolves npm's shim for the claude native binary to the .exe", () => {
    const content = [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
    ].join("\r\n");
    expect(resolveCmdShim(SHIM, content)).toBe(
      "C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"
    );
  });

  it("resolves npm's node-script shim (codex) to the .js, skipping node.exe", () => {
    const content = [
      "@ECHO off",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ") ELSE (",
      '  SET "_prog=node"',
      "  SET PATHEXT=%PATHEXT:;.JS;=;%",
      ")",
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ].join("\r\n");
    expect(resolveCmdShim("C:\\npm\\codex.cmd", content)).toBe(
      "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"
    );
  });

  it("resolves a pnpm-style %~dp0 shim with a relative hop", () => {
    const content = '@SETLOCAL\r\n"%~dp0\\..\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
    expect(resolveCmdShim("C:\\pnpm\\bin\\codex.cmd", content)).toBe(
      "C:\\pnpm\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js"
    );
  });

  it("returns null for a shim it does not understand", () => {
    expect(resolveCmdShim(SHIM, "@echo off\r\nclaude-launcher %*\r\n")).toBeNull();
  });
});

describe("isBatchShim", () => {
  it("flags .cmd and .bat only", () => {
    expect(isBatchShim("C:\\npm\\claude.cmd")).toBe(true);
    expect(isBatchShim("C:\\npm\\claude.BAT")).toBe(true);
    expect(isBatchShim("C:\\x\\claude.exe")).toBe(false);
  });
});

describe("spawnSpec", () => {
  it("runs a .js target through node on win32", () => {
    expect(spawnSpec("C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", ["app-server"], "win32")).toEqual({
      command: "node",
      args: ["C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", "app-server"],
    });
  });

  it("spawns an .exe as-is on win32", () => {
    expect(spawnSpec("C:\\x\\claude.exe", ["--version"], "win32")).toEqual({
      command: "C:\\x\\claude.exe",
      args: ["--version"],
    });
  });

  it("is the identity on POSIX, even for a .js path", () => {
    expect(spawnSpec("/opt/codex.js", ["--version"], "darwin")).toEqual({ command: "/opt/codex.js", args: ["--version"] });
    expect(spawnSpec("/usr/local/bin/claude", ["update"], "linux")).toEqual({
      command: "/usr/local/bin/claude",
      args: ["update"],
    });
  });
});

describe("windowsPathEnv", () => {
  it("prepends the binary dir, native and npm dirs, joined with ';'", () => {
    expect(windowsPathEnv("C:\\Users\\alice\\.local\\bin\\claude.exe", HOME, { ...ENV, PATH: "C:\\Windows" })).toBe(
      [
        "C:\\Users\\alice\\.local\\bin",
        "C:\\Users\\alice\\.local\\bin",
        "C:\\Users\\alice\\AppData\\Roaming\\npm",
        "C:\\Windows",
      ].join(";")
    );
  });

  it("drops the binary dir when resolution fell back to the bare name", () => {
    expect(windowsPathEnv("claude", HOME, {}).split(";")[0]).toBe("C:\\Users\\alice\\.local\\bin");
  });
});

describe("toVaultRelative", () => {
  it("keeps the POSIX behaviour", () => {
    expect(toVaultRelative("/vault/Notes/a.md", "/vault")).toBe("Notes/a.md");
    expect(toVaultRelative("/elsewhere/a.md", "/vault")).toBe("/elsewhere/a.md");
    expect(toVaultRelative("Notes/a.md", "/vault")).toBe("Notes/a.md");
    expect(toVaultRelative("/vault/a.md", ".")).toBe("/vault/a.md");
    expect(toVaultRelative("/vault/a.md", "")).toBe("/vault/a.md");
  });

  it("strips a Windows vault base despite backslashes and drive-letter case", () => {
    expect(toVaultRelative("C:\\Users\\alice\\Vault\\Input\\Call X.md", "C:\\Users\\alice\\Vault")).toBe(
      "Input/Call X.md"
    );
    expect(toVaultRelative("c:/Users/alice/Vault/a.md", "C:\\Users\\alice\\Vault")).toBe("a.md");
  });

  it("does not match a sibling folder that shares the prefix", () => {
    expect(toVaultRelative("C:\\Users\\alice\\Vault2\\a.md", "C:\\Users\\alice\\Vault")).toBe(
      "C:\\Users\\alice\\Vault2\\a.md"
    );
  });
});

describe("resolveWindowsBin: the full Windows chain", () => {
  const NPM = "C:\\Users\\alice\\AppData\\Roaming\\npm";
  const NATIVE = "C:\\Users\\alice\\.local\\bin\\claude.exe";
  const NPM_SHIM = `${NPM}\\claude.cmd`;
  const NPM_EXE = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  const SHIM_BODY = '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';

  const deps = (files: Record<string, string>, over: Partial<WinResolveDeps> = {}): WinResolveDeps => ({
    home: HOME,
    env: ENV,
    exists: (p) => p in files,
    readFile: (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
    npmPrefix: async () => null,
    where: async () => "",
    ...over,
  });

  it("an explicit setting wins over everything", async () => {
    expect(await resolveWindowsBin("claude", "D:\\tools\\claude.exe", deps({ [NATIVE]: "" }))).toBe(
      "D:\\tools\\claude.exe"
    );
  });

  it("finds the native installer binary (Alice's setup)", async () => {
    expect(await resolveWindowsBin("claude", "", deps({ [NATIVE]: "", [NPM_SHIM]: SHIM_BODY, [NPM_EXE]: "" }))).toBe(
      NATIVE
    );
  });

  it("unwraps the npm .cmd shim to the real .exe, so the SDK can spawn it without a shell", async () => {
    expect(await resolveWindowsBin("claude", "", deps({ [NPM_SHIM]: SHIM_BODY, [NPM_EXE]: "" }))).toBe(NPM_EXE);
  });

  it("unwraps a configured .cmd too", async () => {
    expect(await resolveWindowsBin("claude", NPM_SHIM, deps({ [NPM_SHIM]: SHIM_BODY, [NPM_EXE]: "" }))).toBe(NPM_EXE);
  });

  it("uses the live npm prefix (nvm-windows) before package-manager shims", async () => {
    const prefixShim = "C:\\nvm4w\\nodejs\\claude.cmd";
    const prefixExe = "C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
    const scoop = "C:\\Users\\alice\\scoop\\shims\\claude.exe";
    const files = { [prefixShim]: SHIM_BODY, [prefixExe]: "", [scoop]: "" };
    expect(await resolveWindowsBin("claude", "", deps(files, { npmPrefix: async () => "C:\\nvm4w\\nodejs" }))).toBe(
      prefixExe
    );
  });

  it("falls back to `where`, then to the bare name", async () => {
    const other = "E:\\bin\\claude.exe";
    expect(
      await resolveWindowsBin("claude", "", deps({ [other]: "" }, { where: async () => `E:\\bin\\claude\r\n${other}\r\n` }))
    ).toBe(other);
    expect(await resolveWindowsBin("claude", "", deps({}))).toBe("claude");
  });

  it("keeps the shim when its target is missing or the shim is unreadable", async () => {
    expect(await resolveWindowsBin("claude", "", deps({ [NPM_SHIM]: SHIM_BODY }))).toBe(NPM_SHIM);
    const unreadable = deps({ [NPM_SHIM]: SHIM_BODY }, { readFile: () => { throw new Error("EACCES"); } });
    expect(await resolveWindowsBin("claude", "", unreadable)).toBe(NPM_SHIM);
  });
});
