import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";

// ESM: __dirname does not exist. Derive it from import.meta.url.
const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "..", "catalog", "manifest.json");

export const CatalogEntrySchema = z.object({
  id: z.string(),
  class: z.string(),
  style_tags: z.array(z.string()),
  dims_m: z.object({ w: z.number(), h: z.number(), d: z.number() }),
  usdz_file: z.string(),
  poly_count: z.number(),
  variants: z.array(z.string()),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const ManifestSchema = z.object({
  version: z.number(),
  materials: z.array(z.object({
    id: z.string(),
    style_tags: z.array(z.string()),
    base_color_hex: z.string(),
  })),
  entries: z.array(CatalogEntrySchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;

let cached: Manifest | null = null;

export function loadManifest(): Manifest {
  if (!cached) {
    cached = ManifestSchema.parse(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")));
  }
  return cached;
}

/**
 * Drops every catalog entry that cannot physically fit the measured free space.
 *
 * THIS IS THE HONESTY FILTER AND IT IS NOT OPTIONAL.
 *
 * A planner handed the whole catalogue will confidently place a three-metre
 * sectional in a room with 2.2m of clear floor, because it is reasoning about
 * style and has no way to reason about metres. Filtering first means the model
 * physically cannot pick something that does not fit — the constraint is
 * enforced by the input, not by asking nicely in the prompt.
 *
 * An entry survives if its footprint fits inside `largest_open_rect` in either
 * orientation, with `clearance` of walking room on each side.
 */
export function filterByFreeSpace(
  entries: CatalogEntry[],
  openRect: { size: [number, number] },
  clearance = 0.61,
): CatalogEntry[] {
  const availW = openRect.size[0] - clearance;
  const availD = openRect.size[1] - clearance;
  return entries.filter((e) => {
    const { w, d } = e.dims_m;
    const fitsAsIs = w <= availW && d <= availD;
    const fitsRotated = d <= availW && w <= availD;
    return fitsAsIs || fitsRotated;
  });
}
