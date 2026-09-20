import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";

// ESM: __dirname does not exist. Derive it from import.meta.url.
const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(here, "..", "..", "catalog", "manifest.json");

/** PBR texture sets: one directory per material id, each holding these three maps. */
export const MATERIALS_DIR = join(here, "..", "..", "catalog", "materials");
export const MATERIAL_MAPS = ["diff", "nor_gl", "rough"] as const;
export type MaterialMap = (typeof MATERIAL_MAPS)[number];

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

const GENERATED_MANIFEST = join(here, "..", "..", "catalog", "generated", "manifest.json");

/**
 * Generated objects, in the shape the planner already understands.
 *
 * They live in a separate manifest with a different schema, so without this the
 * planner cannot see them — it reported "no plant items are available" while a
 * generated potted plant sat on disk.
 */
export interface PlannerCandidate {
  id: string;
  class: string;
  style_tags: string[];
  dims_m: { w: number; h: number; d: number };
}

export function loadGeneratedEntries(): PlannerCandidate[] {
  let raw: string;
  try {
    raw = readFileSync(GENERATED_MANIFEST, "utf8");
  } catch {
    return [];
  }
  try {
    const manifest = JSON.parse(raw) as {
      entries?: {
        id: string;
        status: string;
        category: string;
        dimensionsM?: { width: number; height: number; depth: number };
        materialFamily?: string;
        size?: string;
      }[];
    };
    return (manifest.entries ?? [])
      .filter((e) => e.status === "complete" && e.dimensionsM)
      .map((e) => ({
        id: e.id,
        class: e.category,
        // Style tags drive the planner's aesthetic matching; these are honest but
        // coarse, since a generated object has a material and a size and no styling.
        style_tags: [e.materialFamily, e.size].filter((t): t is string => Boolean(t)),
        dims_m: { w: e.dimensionsM!.width, h: e.dimensionsM!.height, d: e.dimensionsM!.depth },
      }));
  } catch {
    return [];
  }
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
export function filterByFreeSpace<T extends { dims_m: { w: number; d: number } }>(
  entries: T[],
  openRect: { size: [number, number] },
  clearance = 0.61,
): T[] {
  const availW = openRect.size[0] - clearance;
  const availD = openRect.size[1] - clearance;
  return entries.filter((e) => {
    const { w, d } = e.dims_m;
    const fitsAsIs = w <= availW && d <= availD;
    const fitsRotated = d <= availW && w <= availD;
    return fitsAsIs || fitsRotated;
  });
}
