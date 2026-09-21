import { apiURL } from '../runtime/api-url';
import { setObjectCatalog, type CatalogObjectEntry } from '../runtime/object-catalog';

/**
 * Fills the editor's catalog cache from the server.
 *
 * Kept out of the runtime module because that one is imported by the Node gate, which
 * cannot load anything that reaches React Native. An unreachable server leaves the
 * cache empty and every add falls back to the procedural families.
 *
 * RETRIED, because the usual dev sequence is that the app launches while the server is
 * still coming up. A single attempt lost that race permanently and silently: the cache
 * stayed empty, the voice session got no catalog menu, and since a lamp and a television
 * have no `family` equivalent, they could not be asked for at all.
 */
const RETRY_DELAYS_MS = [400, 800, 1600, 3200];

export async function loadObjectCatalog(): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`${apiURL()}/objects/catalog`);
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { entries?: CatalogObjectEntry[] };
      const entries = body.entries ?? [];
      setObjectCatalog(entries);
      // A server that answers with an empty catalog is a configuration problem
      // (OBJECT_CATALOG_DIR unset), not a race. Retrying cannot fix it.
      return entries.length;
    } catch {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  setObjectCatalog([]);
  return 0;
}
