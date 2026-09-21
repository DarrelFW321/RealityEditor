import type { DimensionsM, ObjectSpec, SizeClass } from './spec';
import type { ObjectMaterial } from './materials';

export const CATALOG_THRESHOLD = 0.6;

export interface CatalogEntry {
  id: string;
  status: string;
  category: string;
  size: SizeClass;
  materialFamily: string;
  baseFinish?: string;
  tintable?: boolean;
  keywords?: string[];
  structure?: { compartmentCount?: number | null };
  dimensionsM?: DimensionsM;
  label?: string;
  sha256: string;
  file: string;
  bytes?: number;
  triangles?: number;
  textures?: number;
}

export interface ScoredEntry {
  entry: CatalogEntry;
  score: number;
  matched: string[];
  vetoes: string[];
}

export interface CatalogMatch {
  entry: CatalogEntry;
  score: number;
  matched: string[];
  disclosures: string[];
}

function keywordHits(prompt: string, keywords: string[]): string[] {
  const haystack = prompt.toLowerCase();
  return keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()));
}

export function scoreEntry(
  spec: ObjectSpec,
  material: Pick<ObjectMaterial, 'family' | 'explicit'>,
  entry: CatalogEntry,
): ScoredEntry {
  const vetoes: string[] = [];
  if (spec.category !== entry.category) vetoes.push('category');
  if (material.explicit && material.family !== entry.materialFamily) vetoes.push('material');
  // A count the audience can verify by eye. If the prompt states one, the entry must
  // match it exactly — an unrecorded count is not a match either.
  const wantedCount = spec.structure.compartmentCount;
  if (wantedCount && wantedCount !== entry.structure?.compartmentCount) vetoes.push('compartments');
  if (spec.finish.colorName !== 'neutral' && entry.tintable === false) vetoes.push('colour');

  const keywords = entry.keywords ?? [];
  const matched = keywordHits(spec.prompt, keywords);
  const score = 0.6
    + (keywords.length ? 0.25 * (matched.length / keywords.length) : 0)
    + (entry.size === spec.size ? 0.1 : 0)
    + (entry.materialFamily === material.family ? 0.05 : 0);

  return { entry, score, matched, vetoes };
}

function disclosuresFor(spec: ObjectSpec, entry: CatalogEntry): string[] {
  const disclosures = ['pre-made catalog object'];
  if (spec.finish.colorName !== 'neutral') {
    disclosures.push(`${spec.finish.colorName} applied as a tint over the baked ${entry.baseFinish ?? 'neutral'} finish`);
  }
  if (entry.size !== spec.size) {
    disclosures.push(`requested ${spec.size}; catalog entry is ${entry.size}`);
  }
  return disclosures;
}

export function matchCatalog(
  catalog: { entries: CatalogEntry[] },
  spec: ObjectSpec,
  material: Pick<ObjectMaterial, 'family' | 'explicit'>,
  { threshold = CATALOG_THRESHOLD }: { threshold?: number } = {},
): CatalogMatch | null {
  let best: ScoredEntry | null = null;
  for (const entry of catalog.entries) {
    const scored = scoreEntry(spec, material, entry);
    if (scored.vetoes.length || scored.score < threshold) continue;
    if (!best || scored.score > best.score) best = scored;
  }
  if (!best) return null;
  return {
    entry: best.entry,
    score: Number(best.score.toFixed(3)),
    matched: best.matched,
    disclosures: disclosuresFor(spec, best.entry),
  };
}
