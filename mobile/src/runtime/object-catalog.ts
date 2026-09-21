export interface CatalogObjectEntry {
  id: string;
  category: string;
  size: 'medium' | 'large';
  materialFamily: string;
  label?: string;
  sha256: string;
  dimensionsM?: { width: number; height: number; depth: number };
  triangles?: number;
  bytes?: number;
}

/**
 * Pure cache, deliberately free of any fetch.
 *
 * `editor.ts` imports this, and the milestone gate runs `editor.ts` under plain Node.
 * Reaching for `apiURL()` here would drag expo-constants — and with it the whole of
 * React Native — into that gate, which esbuild cannot parse. The adapter does the I/O.
 */
let entries: CatalogObjectEntry[] = [];
let byId = new Map<string, CatalogObjectEntry>();

/**
 * Notified whenever the catalog changes.
 *
 * The voice session sends its instructions once, when its data channel opens, and the
 * catalog is fetched asynchronously at startup. Without this, a session that opened
 * first held an empty menu for its whole life. That is invisible for a chair or a table
 * — those are `family` values too — but a lamp and a television exist ONLY as catalog
 * ids, so they became unaskable.
 */
const listeners = new Set<() => void>();

export function onObjectCatalogChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setObjectCatalog(list: readonly CatalogObjectEntry[]) {
  entries = list.filter((e) => e.id && e.sha256);
  byId = new Map(entries.map((e) => [e.id, e]));
  for (const listener of listeners) listener();
}

/** Null for an unknown id, so an invented one falls back to the family path. */
export function catalogEntry(id: string | undefined | null): CatalogObjectEntry | null {
  if (!id) return null;
  return byId.get(id.replace(/^catalog:/, '')) ?? null;
}

export function catalogIds(): string[] {
  return entries.map((e) => e.id);
}

/** What the voice model is told it may ask for, one entry per object. */
export function catalogMenu(): string {
  return entries.map((e) => `${e.id} (${e.category.replace(/_/g, ' ')}, ${e.size})`).join('; ');
}
