import type { FastifyInstance, FastifyReply } from "fastify";
import { createReadStream, existsSync, statSync, readdirSync } from "node:fs";
import { join, resolve, relative, sep, extname } from "node:path";

/**
 * GET /assets/* — the catalogue and the learned models, served instead of bundled.
 *
 * WHY THIS EXISTS. The app bundle was 280MB, of which 275MB was assets:
 *
 *     Models/ (LaMa CoreML)   207MB   74%
 *     usdz/   (catalogue)      68MB   24%
 *     the actual binary        4.9MB   2%
 *
 * Every rebuild shipped all of it to the phone over Wi-Fi, which is the thing
 * that made the app "take really long just to load". Both are already lazy at
 * RUNTIME — `LaMaPhotoInpainter.loadIfNeeded` and per-asset `Entity.load` — so
 * bundling them bought nothing except install time.
 *
 * WHAT THIS IS NOT. It is not the op path. The scene graph, the constraint
 * solver and deixis stay on the phone, where they measure ~4ms end to end
 * against a 20-200ms round trip to this process. Moving those here would make
 * the room slower and stop it working when the Wi-Fi does. This route moves
 * BYTES, not decisions.
 *
 * NO ARCHIVE FORMAT. A `.mlmodelc` is a directory, and the obvious answer —
 * zip it — needs an unarchiver, which iOS does not provide and this repo's
 * zero-third-party-packages rule forbids. So directories are served as an
 * index plus their files, and the client rebuilds the tree. Five files for
 * LaMa; nothing clever required on either side.
 */

/** Everything servable, relative to the repo root. Nothing outside these. */
const ROOTS = {
  usdz: "catalog/usdz",
  materials: "catalog/materials",
  models: "models",
} as const;

type RootName = keyof typeof ROOTS;

const MIME: Record<string, string> = {
  ".usdz": "model/vnd.usdz+zip",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".bin": "application/octet-stream",
  ".mil": "application/octet-stream",
};

export async function registerAssetRoutes(app: FastifyInstance, repoRoot: string) {
  const rootDir = (name: RootName) => resolve(repoRoot, ROOTS[name]);

  /**
   * Resolves a client-supplied path inside a root, or null.
   *
   * PATH TRAVERSAL IS THE ONLY SECURITY CONCERN THIS FILE HAS, and it is a real
   * one: the wildcard is attacker-controlled and this process can read the
   * developer's home directory. Resolve first, then require the result to still
   * be under the root — checking for ".." in the raw string misses encodings.
   */
  function safeJoin(name: RootName, requested: string): string | null {
    const base = rootDir(name);
    const target = resolve(base, requested);
    const rel = relative(base, target);
    if (rel.startsWith("..") || rel.startsWith(sep) || resolve(base, rel) !== target) {
      return null;
    }
    return target;
  }

  function listFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (current: string) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        // Skip dotfiles: .gitkeep and friends are repo bookkeeping, not assets.
        if (entry.name.startsWith(".")) continue;
        const full = join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) out.push(relative(dir, full).split(sep).join("/"));
      }
    };
    if (existsSync(dir)) walk(dir);
    return out.sort();
  }

  function sendFile(reply: FastifyReply, path: string) {
    const info = statSync(path);
    return reply
      .header("Content-Type", MIME[extname(path)] ?? "application/octet-stream")
      .header("Content-Length", info.size)
      // The client caches by (path, size, mtime); assets are immutable in
      // practice, so a long max-age is honest and saves a round trip.
      .header("Cache-Control", "public, max-age=86400")
      .header("X-Asset-Size", String(info.size))
      .header("X-Asset-Mtime", String(Math.floor(info.mtimeMs)))
      .send(createReadStream(path));
  }

  /**
   * An INDEX of everything the client may need, in one request.
   *
   * One call rather than one per asset because the client prefetches on launch
   * and needs to know the total byte count to show progress — and because 25
   * HEAD requests on conference Wi-Fi is its own kind of slow.
   */
  app.get("/assets/index", async (_request, reply) => {
    const index: Record<string, { path: string; bytes: number }[]> = {};
    let total = 0;
    for (const name of Object.keys(ROOTS) as RootName[]) {
      const dir = rootDir(name);
      index[name] = listFiles(dir).map((path) => {
        const bytes = statSync(join(dir, path)).size;
        total += bytes;
        return { path, bytes };
      });
    }
    return reply.send({ roots: index, total_bytes: total });
  });

  app.get<{ Params: { name: string; "*": string } }>(
    "/assets/:name/*",
    async (request, reply) => {
      const name = request.params.name as RootName;
      if (!(name in ROOTS)) {
        return reply.code(404).send({ error: "unknown_root", detail: request.params.name });
      }
      const requested = request.params["*"];
      const path = safeJoin(name, requested);
      if (!path) {
        request.log.warn({ requested }, "rejected a path outside the asset root");
        return reply.code(400).send({ error: "bad_path" });
      }
      if (!existsSync(path)) {
        return reply.code(404).send({ error: "not_found", detail: requested });
      }
      const info = statSync(path);
      // A directory is an index, so `.mlmodelc` needs no archive format.
      if (info.isDirectory()) {
        return reply.send({
          directory: requested,
          files: listFiles(path).map((p) => ({
            path: p,
            bytes: statSync(join(path, p)).size,
          })),
        });
      }
      return sendFile(reply, path);
    },
  );
}
