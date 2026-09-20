export type SizeClass = 'medium' | 'large';

export type DimensionsSource = 'explicit' | 'category-default' | 'unresolved';

export interface DimensionsM {
  width: number;
  height: number;
  depth: number;
}

export interface ObjectSpec {
  schemaVersion: 1;
  prompt: string;
  category: string;
  size: SizeClass;
  dimensionsM: DimensionsM | null;
  dimensionsSource: DimensionsSource;
  structure: { compartmentCount: number | null; countedFeature: string | null };
  finish: { colorName: string; colorHex: string };
  disclosedDefaults: string[];
  unresolved: string[];
}

const COLORS = new Map<string, string>([
  ['blue', '#2867b2'], ['red', '#b83b3b'], ['green', '#3f7f55'],
  ['black', '#202226'], ['white', '#ecebe7'], ['orange', '#d87532'],
  ['yellow', '#d7ad36'], ['gray', '#777b82'], ['grey', '#777b82'],
  ['walnut', '#68452f'], ['oak', '#a77b4f'],
  ['sage', '#9aa88b'], ['cream', '#e8dfcd'], ['navy', '#2a3a5c'],
  ['charcoal', '#3c3f44'], ['terracotta', '#b9663f'], ['beige', '#d6c9b4'],
  ['teal', '#2f6f6b'], ['olive', '#6b6f3c'], ['mustard', '#c39b2e'],
  ['blush', '#d8a9a0'], ['tan', '#b99771'], ['ivory', '#efe9db'],
]);

// First match wins. Each entry must precede any broader pattern that also matches it:
// "coffee table" before "table", "two-seat sofa" before the chair pattern's "seat".
const CATEGORY_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['table_lamp', /\b(table lamp|desk lamp|bedside lamp)\b/i],
  ['floor_lamp', /\b(floor lamp|standing lamp|tripod lamp)\b/i],
  ['coffee_table', /\b(coffee table|cocktail table)\b/i],
  ['nightstand', /\b(nightstand|night stand|bedside table|bedside cabinet)\b/i],
  ['sideboard', /\b(sideboard|credenza|buffet)\b/i],
  ['wardrobe', /\b(wardrobe|armoire)\b/i],
  ['dresser', /\b(dresser|chest of drawers|drawer chest)\b/i],
  ['shelving_unit', /\b(shelf|shelves|shelving|bookcase|bookshelf|etagere)\b/i],
  ['armchair', /\b(armchair|arm chair|lounge chair|wingback)\b/i],
  ['sofa', /\b(sofa|couch|settee|loveseat|sectional)\b/i],
  ['stool', /\b(stool|ottoman|pouf)\b/i],
  ['bench', /\b(bench)\b/i],
  ['chair', /\b(chair|seat)\b/i],
  ['desk', /\b(desk|writing table|workstation)\b/i],
  ['bed', /\b(bed|headboard)\b/i],
  ['table', /\b(table)\b/i],
  ['cabinet', /\b(cabinet|cupboard|hutch)\b/i],
  ['vase', /\b(vase|urn)\b/i],
];

const DEFAULTS: Record<string, Record<SizeClass, DimensionsM>> = {
  shelving_unit: {
    medium: { width: 0.8, height: 1.4, depth: 0.3 },
    large: { width: 1.2, height: 1.8, depth: 0.35 },
  },
  chair: {
    medium: { width: 0.5, height: 0.85, depth: 0.55 },
    large: { width: 0.65, height: 1.0, depth: 0.65 },
  },
  armchair: {
    medium: { width: 0.78, height: 0.82, depth: 0.82 },
    large: { width: 0.95, height: 0.95, depth: 0.95 },
  },
  sofa: {
    medium: { width: 1.6, height: 0.82, depth: 0.88 },
    large: { width: 2.3, height: 0.85, depth: 0.95 },
  },
  stool: {
    medium: { width: 0.38, height: 0.65, depth: 0.38 },
    large: { width: 0.45, height: 0.78, depth: 0.45 },
  },
  bench: {
    medium: { width: 1.2, height: 0.45, depth: 0.38 },
    large: { width: 1.8, height: 0.48, depth: 0.42 },
  },
  table: {
    medium: { width: 1.2, height: 0.75, depth: 0.7 },
    large: { width: 1.8, height: 0.75, depth: 0.9 },
  },
  coffee_table: {
    medium: { width: 1.0, height: 0.42, depth: 0.55 },
    large: { width: 1.35, height: 0.45, depth: 0.7 },
  },
  desk: {
    medium: { width: 1.2, height: 0.75, depth: 0.6 },
    large: { width: 1.6, height: 0.75, depth: 0.75 },
  },
  nightstand: {
    medium: { width: 0.45, height: 0.55, depth: 0.4 },
    large: { width: 0.6, height: 0.65, depth: 0.45 },
  },
  cabinet: {
    medium: { width: 0.9, height: 1.2, depth: 0.42 },
    large: { width: 1.4, height: 1.8, depth: 0.5 },
  },
  sideboard: {
    medium: { width: 1.4, height: 0.78, depth: 0.42 },
    large: { width: 1.9, height: 0.82, depth: 0.48 },
  },
  wardrobe: {
    medium: { width: 1.0, height: 1.9, depth: 0.58 },
    large: { width: 1.5, height: 2.2, depth: 0.62 },
  },
  dresser: {
    medium: { width: 1.1, height: 0.8, depth: 0.45 },
    large: { width: 1.6, height: 0.95, depth: 0.5 },
  },
  bed: {
    medium: { width: 1.5, height: 0.95, depth: 2.03 },
    large: { width: 1.93, height: 1.05, depth: 2.03 },
  },
  floor_lamp: {
    medium: { width: 0.4, height: 1.5, depth: 0.4 },
    large: { width: 0.5, height: 1.8, depth: 0.5 },
  },
  table_lamp: {
    medium: { width: 0.28, height: 0.48, depth: 0.28 },
    large: { width: 0.36, height: 0.62, depth: 0.36 },
  },
  vase: {
    medium: { width: 0.28, height: 0.42, depth: 0.28 },
    large: { width: 0.42, height: 0.65, depth: 0.42 },
  },
};

const NUMBER_WORDS = new Map<string, number>([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6],
  ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11], ['twelve', 12],
]);

const FEATURE_PLURALS = new Map<string, string>([
  ['compartment', 'compartments'], ['compartments', 'compartments'],
  ['shelves', 'shelves'], ['cubbies', 'cubbies'],
  ['drawer', 'drawers'], ['drawers', 'drawers'],
  ['door', 'doors'], ['doors', 'doors'],
]);

export function parseObjectRequest(input: unknown): { prompt: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Request must be an object');
  }
  const prompt = (input as { prompt?: unknown }).prompt;
  if (typeof prompt !== 'string') throw new TypeError('prompt must be a string');
  const trimmed = prompt.trim();
  if (trimmed.length < 3 || trimmed.length > 1000) {
    throw new RangeError('prompt must contain 3–1000 characters');
  }
  return Object.freeze({ prompt: trimmed });
}

function dimensionsFromText(prompt: string): DimensionsM | null {
  const triple = prompt.match(
    /(?:dimensions?\s*)?(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)\s*(m|cm|mm)\b/i,
  );
  if (!triple) return null;
  const unit = (triple[4] ?? '').toLowerCase();
  const divisor = unit === 'm' ? 1 : unit === 'cm' ? 100 : 1000;
  const values = [triple[1], triple[2], triple[3]].map((value) => Number(value) / divisor);
  if (values.some((value) => !Number.isFinite(value) || value < 0.02 || value > 20)) return null;
  const [width, height, depth] = values as [number, number, number];
  return { width, height, depth };
}

// A count the viewer can check by eye, so the catalog matcher refuses to substitute
// a different one. Covers "four empty compartments" and "six-drawer dresser" alike.
function countedFeatureFromText(prompt: string): ObjectSpec['structure'] {
  const none = { compartmentCount: null, countedFeature: null };
  const match = prompt.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})[\s-]+(?:empty[\s-]+)?(compartments?|shelves|cubbies|drawers?|doors?)\b/i,
  );
  if (!match) return none;
  const raw = (match[1] ?? '').toLowerCase();
  const count = NUMBER_WORDS.get(raw) ?? Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > 20) return none;
  return {
    compartmentCount: count,
    countedFeature: FEATURE_PLURALS.get((match[2] ?? '').toLowerCase()) ?? 'compartments',
  };
}

export function interpretPrompt(rawRequest: unknown): ObjectSpec {
  const { prompt } = parseObjectRequest(rawRequest);
  const category = CATEGORY_PATTERNS.find(([, pattern]) => pattern.test(prompt))?.[0] ?? 'unknown';
  const colorName = [...COLORS.keys()].find((name) => new RegExp(`\\b${name}\\b`, 'i').test(prompt));
  const size: SizeClass = /\b(large|big|tall|wide|oversized)\b/i.test(prompt) ? 'large' : 'medium';
  const explicitDimensions = dimensionsFromText(prompt);
  const structure = countedFeatureFromText(prompt);
  const defaults = category === 'unknown' ? null : DEFAULTS[category]?.[size] ?? null;

  const disclosedDefaults: string[] = [];
  if (!explicitDimensions && defaults) disclosedDefaults.push(`${size} ${category} dimensions`);
  if (!colorName) disclosedDefaults.push('neutral material color');

  return {
    schemaVersion: 1,
    prompt,
    category,
    size,
    dimensionsM: explicitDimensions ?? defaults,
    dimensionsSource: explicitDimensions ? 'explicit' : defaults ? 'category-default' : 'unresolved',
    structure,
    finish: {
      colorName: colorName ?? 'neutral',
      colorHex: colorName ? COLORS.get(colorName) ?? '#a8a49c' : '#a8a49c',
    },
    disclosedDefaults,
    unresolved: [
      ...(category === 'unknown' ? ['object category'] : []),
      ...(!explicitDimensions && !defaults ? ['dimensions'] : []),
    ],
  };
}
