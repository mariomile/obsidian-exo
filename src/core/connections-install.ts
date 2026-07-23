/**
 * Apply a Connections import. Two halves, both reversible and source-safe:
 *  - MCP: pure string→string over `.mcp.json` text (caller owns fs), reusing the
 *    existing mcp-config helpers so a connect is a normal enable/disable later.
 *  - Skill: recursive folder COPY into the vault (never move — the source repo
 *    stays the owner), idempotent (won't clobber without overwrite).
 * No action can destroy a source: MCP uninstall is a flag flip, skill uninstall
 * removes only the vault copy.
 */

import { parseMcpJson, serializeMcpJson, upsertServer, removeServer } from "./mcp-config";
import { cp, rm, access } from "fs/promises";

/** Apply an MCP import to `.mcp.json` text. Pure string→string so the caller
 *  owns fs. Throws on unparseable input — we never overwrite a file we can't
 *  round-trip safely. */
export function connectMcp(currentRaw: string, name: string, config: Record<string, unknown>): string {
  const parsed = parseMcpJson(currentRaw);
  if (parsed.error) throw new Error(`Refusing to write over unparseable .mcp.json: ${parsed.error}`);
  return serializeMcpJson(upsertServer(parsed.servers, name, config));
}

export function disconnectMcp(currentRaw: string, name: string): string {
  const parsed = parseMcpJson(currentRaw);
  if (parsed.error) throw new Error(`Refusing to write over unparseable .mcp.json: ${parsed.error}`);
  return serializeMcpJson(removeServer(parsed.servers, name));
}

const exists = async (p: string): Promise<boolean> => {
  try { await access(p); return true; } catch { return false; }
};

/** Copy a skill folder into the vault. Copy, never move — the source stays the
 *  owner. Idempotent: returns "exists" (and copies nothing) unless overwrite. */
export async function importSkill(srcDir: string, destDir: string, opts?: { overwrite?: boolean }): Promise<"copied" | "exists"> {
  if (await exists(destDir) && !opts?.overwrite) return "exists";
  await cp(srcDir, destDir, { recursive: true, force: true });
  return "copied";
}

export async function removeSkill(destDir: string): Promise<void> {
  await rm(destDir, { recursive: true, force: true });
}
