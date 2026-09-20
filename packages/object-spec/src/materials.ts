import type { ObjectSpec } from './spec.js';

export type MaterialFamily =
  | 'painted_wood' | 'wood' | 'fabric' | 'leather'
  | 'metal' | 'plastic' | 'glass' | 'matte';

export interface ObjectMaterial {
  family: MaterialFamily;
  /** True when the prompt named the material outright. The catalog matcher vetoes on it. */
  explicit: boolean;
  colorHex: string;
  roughness: number;
  metalness: number;
  transmission: number;
}

const MATERIAL_PATTERNS: readonly (readonly [MaterialFamily, RegExp])[] = [
  ['glass', /\b(glass|crystal|transparent)\b/i],
  ['metal', /\b(metal|steel|aluminum|aluminium|chrome|iron|brass)\b/i],
  ['fabric', /\b(fabric|cloth|linen|velvet|upholstered)\b/i],
  ['leather', /\b(leather|suede)\b/i],
  ['plastic', /\b(plastic|acrylic)\b/i],
  ['wood', /\b(wood|wooden|oak|walnut|maple|pine)\b/i],
];

const PROPERTIES: Record<MaterialFamily, { roughness: number; metalness: number; transmission: number }> = {
  painted_wood: { roughness: 0.52, metalness: 0, transmission: 0 },
  wood: { roughness: 0.66, metalness: 0, transmission: 0 },
  fabric: { roughness: 0.92, metalness: 0, transmission: 0 },
  leather: { roughness: 0.58, metalness: 0, transmission: 0 },
  metal: { roughness: 0.3, metalness: 0.9, transmission: 0 },
  plastic: { roughness: 0.38, metalness: 0, transmission: 0 },
  glass: { roughness: 0.12, metalness: 0, transmission: 0.85 },
  matte: { roughness: 0.72, metalness: 0, transmission: 0 },
};

const SOFT_CATEGORIES = new Set(['sofa', 'armchair', 'bed']);

const HARD_FURNITURE = new Set([
  'shelving_unit', 'chair', 'stool', 'bench', 'table', 'coffee_table', 'desk',
  'nightstand', 'cabinet', 'sideboard', 'wardrobe', 'dresser',
]);

function impliedFamily(spec: ObjectSpec): MaterialFamily {
  if (SOFT_CATEGORIES.has(spec.category)) return 'fabric';
  if (!HARD_FURNITURE.has(spec.category)) return 'matte';
  return spec.finish.colorName === 'neutral' ? 'wood' : 'painted_wood';
}

export function materialFromSpec(spec: ObjectSpec): Readonly<ObjectMaterial> {
  const explicit = MATERIAL_PATTERNS.find(([, pattern]) => pattern.test(spec.prompt))?.[0];
  const family = explicit ?? impliedFamily(spec);
  return Object.freeze({
    family,
    explicit: Boolean(explicit),
    colorHex: spec.finish.colorHex,
    ...PROPERTIES[family],
  });
}
