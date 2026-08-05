import type { SessionCaps } from "./providers/types";

/**
 * Last session capability snapshot (skills/commands/agents/tools/mcpServers),
 * own file — NOT settings. It used to be mixed into data.json's
 * `cachedSessionCaps` (69% of the file's bytes, ~46KB of 66KB measured
 * 2026-08-06) even though it is pure cache: rebuilt from a live SDK session
 * every init, never authored, and every default-value migration in
 * settings.ts had to reason about a blob unrelated to any actual setting (the
 * exact shape of the recurring "flip a default, data.json doesn't migrate,
 * check live data" gotcha).
 *
 * Persisted anyway (not held only in memory) because it has real UX value: it
 * seeds the $/@// menus and the Capabilities panel immediately after an
 * Obsidian restart, before the first session's init arrives. Slightly stale
 * is fine here — it's menu seeding, not authorization — so this mirrors
 * dream-snapshot.json's contract exactly: simple write, no backup rotation,
 * corrupt/missing collapses to null instead of failing.
 *
 * Adapter is a narrow subset of Obsidian's `DataAdapter`, not the type
 * itself — same convention as `WorkflowSignalStoreAdapter` — so this stays
 * decoupled from the exact Obsidian version's surface.
 */
export interface SessionCapsCacheAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
}

// `pluginDir` mirrors `PluginManifest.dir`'s own type (`string | undefined`) —
// same as main.ts's sibling `dreamFile()`/`convoFile()`, which interpolate it
// unchecked. In practice Obsidian always sets it for an installed plugin; kept
// honest here rather than asserted, since the compiler now actually checks it.
export function sessionCapsCacheFile(pluginDir: string | undefined): string {
  return `${pluginDir}/session-caps-cache.json`;
}

export async function writeSessionCapsCache(
  adapter: SessionCapsCacheAdapter,
  pluginDir: string | undefined,
  caps: SessionCaps,
): Promise<boolean> {
  try {
    await adapter.write(sessionCapsCacheFile(pluginDir), JSON.stringify(caps));
    return true;
  } catch {
    return false;
  }
}

export async function readSessionCapsCache(
  adapter: SessionCapsCacheAdapter,
  pluginDir: string | undefined,
): Promise<SessionCaps | null> {
  try {
    const p = sessionCapsCacheFile(pluginDir);
    if (await adapter.exists(p)) return JSON.parse(await adapter.read(p)) as SessionCaps;
  } catch {
    /* corrupt/missing — same as a session that hasn't reported caps yet */
  }
  return null;
}

export async function removeSessionCapsCache(
  adapter: SessionCapsCacheAdapter,
  pluginDir: string | undefined,
): Promise<void> {
  try {
    const p = sessionCapsCacheFile(pluginDir);
    if (await adapter.exists(p)) await adapter.remove(p);
  } catch {
    /* ignore */
  }
}
