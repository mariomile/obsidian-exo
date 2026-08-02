import type { DiscoveryItem } from "./connections-scan";

/** Stable ordering inside every hub section: origin first, then name. */
export const byOriginThenName = (a: DiscoveryItem, b: DiscoveryItem): number =>
  a.origin.localeCompare(b.origin) || a.name.localeCompare(b.name);

export interface McpSections {
  connected: DiscoveryItem[];
  disabled: DiscoveryItem[];
  importable: DiscoveryItem[];
  inherited: DiscoveryItem[];
}

/** Partition MCP discovery items into the four fixed sections of the MCP tab.
 *  "Connected" is everything active that isn't explicitly disabled (including
 *  needs-auth / failed servers — they're live rows with recovery actions). */
export function mcpSections(items: DiscoveryItem[]): McpSections {
  return {
    connected: items.filter((i) => i.state === "active" && i.status !== "disabled").sort(byOriginThenName),
    disabled: items.filter((i) => i.state === "active" && i.status === "disabled").sort(byOriginThenName),
    importable: items.filter((i) => i.state === "importable").sort(byOriginThenName),
    inherited: items.filter((i) => i.state === "have").sort(byOriginThenName),
  };
}

export interface SkillGroup {
  origin: string;
  items: DiscoveryItem[];
}

export interface SkillSections {
  /** Skills installed in the vault (flat, listed first). */
  vault: DiscoveryItem[];
  /** Importable skills grouped by origin, origins sorted alphabetically. */
  groups: SkillGroup[];
  /** Count of skills Exo already has — collapsed to a single summary line. */
  haveCount: number;
}

/** Case-insensitive substring match against any field — the hub's search
 *  boxes (MCP, Skills). An empty/whitespace query always matches, so search
 *  is a no-op until the user actually types something. */
export function matchesQuery(query: string, ...fields: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => f?.toLowerCase().includes(q));
}

export function skillSections(items: DiscoveryItem[]): SkillSections {
  const vault = items.filter((s) => s.state === "active");
  const importable = items.filter((s) => s.state === "importable");
  const haveCount = items.filter((s) => s.state === "have").length;

  const byOrigin = new Map<string, DiscoveryItem[]>();
  for (const it of importable) {
    const arr = byOrigin.get(it.origin) ?? [];
    arr.push(it);
    byOrigin.set(it.origin, arr);
  }
  const groups = [...byOrigin.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((origin) => ({ origin, items: byOrigin.get(origin)! }));

  return { vault, groups, haveCount };
}
