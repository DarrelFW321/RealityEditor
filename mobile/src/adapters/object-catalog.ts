import { apiURL } from '../runtime/api-url';
import { setObjectCatalog, type CatalogObjectEntry } from '../runtime/object-catalog';

/**
 * Fills the editor's catalog cache from the server, once, at startup.
 *
 * Kept out of the runtime module because that one is imported by the Node gate, which
 * cannot load anything that reaches React Native. An unreachable server leaves the
 * cache empty and every add falls back to the procedural families.
 */
export async function loadObjectCatalog(): Promise<number> {
  try {
    const response = await fetch(`${apiURL()}/objects/catalog`);
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as { entries?: CatalogObjectEntry[] };
    const entries = body.entries ?? [];
    setObjectCatalog(entries);
    return entries.length;
  } catch {
    setObjectCatalog([]);
    return 0;
  }
}
