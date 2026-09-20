import type { ObjectSpec } from './spec.js';
import type { ObjectMaterial } from './materials.js';

export type SizePreset = 'tiny' | 'small' | 'medium' | 'large' | 'huge';

/** Approximate size, in cm, along the object's longest side. */
export const SIZE_PRESETS_CM: Readonly<Record<SizePreset, number>> = Object.freeze({
  tiny: 15,
  small: 40,
  medium: 80,
  large: 160,
  huge: 280,
});

const SIZE_WORD_TO_PRESET: Readonly<Record<string, SizePreset>> = Object.freeze({
  tiny: 'tiny', miniature: 'tiny',
  small: 'small', little: 'small', compact: 'small', petite: 'small',
  medium: 'medium', 'mid-sized': 'medium', 'average-sized': 'medium',
  large: 'large', big: 'large', spacious: 'large', wide: 'large',
  huge: 'huge', giant: 'huge', massive: 'huge', oversized: 'huge', enormous: 'huge',
});

// Text-to-3D has no documented negative_prompt, so exclusions live in the positive
// prompt. Without them the model fills shelves with books and stages a room.
const GEOMETRY_SCAFFOLD =
  'single freestanding object, complete and unbroken, clean straight edges, ' +
  'physically plausible construction, completely empty and undecorated, ' +
  'nothing stored on or inside it, no background, no props, no other objects';

// Meshy 7.1 ignores remove_lighting, so this suffix is the only lever against
// lighting baked into the albedo — which is what makes a later tint look muddy.
const FLAT_LIGHTING =
  'flat even studio lighting, no cast shadows, uniform albedo, no baked highlights';

// Deliberately light and undyed: tinting multiplies, so it can only darken. A dark
// walnut bake goes muddy under a blue tint where a pale oak bake stays clean.
const NEUTRAL_BASE: Readonly<Record<string, string>> = Object.freeze({
  wood: 'pale natural oak, fine straight grain, matte clear finish',
  painted_wood: 'pale natural oak, fine straight grain, matte clear finish',
  fabric: 'undyed natural linen weave, fine even texture',
  leather: 'undyed pale vegetable-tanned leather, soft even grain',
  metal: 'brushed stainless steel, fine linear grain',
  plastic: 'matte off-white moulded plastic',
  glass: 'clear colourless glass',
  matte: 'light warm grey matte surface',
});

export interface ResolvedSize {
  targetCm: number;
  preset: SizePreset;
  source: 'explicit-cm' | 'explicit-preset' | 'inferred-from-text' | 'default';
  textWord: string | null;
  caveats: string[];
}

export interface SizeInput {
  preset?: SizePreset;
  targetCm?: number;
}

function findSizeWords(text: string): { word: string; preset: SizePreset; index: number }[] {
  const found: { word: string; preset: SizePreset; index: number }[] = [];
  for (const [word, preset] of Object.entries(SIZE_WORD_TO_PRESET)) {
    const match = text.match(new RegExp(`\\b${word}\\b`, 'i'));
    if (match) found.push({ word: match[0], preset, index: match.index ?? 0 });
  }
  return found.sort((a, b) => a.index - b.index);
}

function nearestPreset(targetCm: number): SizePreset {
  let best: SizePreset = 'medium';
  let bestDiff = Infinity;
  for (const [preset, cm] of Object.entries(SIZE_PRESETS_CM) as [SizePreset, number][]) {
    const diff = Math.abs(cm - targetCm);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = preset;
    }
  }
  return best;
}

/** Resolves size intent to one number. Explicit input wins; the wording is never rewritten. */
export function resolveSize(description: string, size?: SizeInput): ResolvedSize {
  const caveats: string[] = [];
  const wordsInText = findSizeWords(description);
  const textWord = wordsInText[0] ?? null;

  if (wordsInText.length > 1 && new Set(wordsInText.map((w) => w.preset)).size > 1) {
    caveats.push(
      `Description mentions multiple, conflicting size words (${wordsInText.map((w) => `"${w.word}"`).join(', ')}); using the first one found.`,
    );
  }

  if (size && typeof size.targetCm === 'number') {
    if (!Number.isFinite(size.targetCm) || size.targetCm <= 0) {
      throw new Error('size.targetCm must be a positive, finite number of centimetres');
    }
    if (textWord && textWord.preset !== nearestPreset(size.targetCm)) {
      caveats.push(
        `Description says "${textWord.word}" but a different target size (${size.targetCm}cm) was requested explicitly; kept the wording as written and used the requested size for scaling.`,
      );
    }
    return { targetCm: size.targetCm, preset: nearestPreset(size.targetCm), source: 'explicit-cm', textWord: textWord?.word ?? null, caveats };
  }

  if (size && size.preset) {
    if (!(size.preset in SIZE_PRESETS_CM)) throw new Error(`Unknown size preset "${size.preset}"`);
    if (textWord && textWord.preset !== size.preset) {
      caveats.push(
        `Description says "${textWord.word}" but preset "${size.preset}" was requested explicitly; kept the wording as written and used the requested preset for scaling.`,
      );
    }
    return { targetCm: SIZE_PRESETS_CM[size.preset], preset: size.preset, source: 'explicit-preset', textWord: textWord?.word ?? null, caveats };
  }

  if (textWord) {
    return { targetCm: SIZE_PRESETS_CM[textWord.preset], preset: textWord.preset, source: 'inferred-from-text', textWord: textWord.word, caveats };
  }

  caveats.push(`No size specified in the description or as a parameter; defaulted to "medium" (~${SIZE_PRESETS_CM.medium}cm on the longest side).`);
  return { targetCm: SIZE_PRESETS_CM.medium, preset: 'medium', source: 'default', textWord: null, caveats };
}

type ObjectPromptInput = Pick<ObjectSpec, 'prompt'> & {
  structure?: Partial<ObjectSpec['structure']>;
};

/**
 * Prompt for the text-to-3D preview stage, which produces geometry only.
 * A stated count is restated as a hard constraint: it is the one detail a viewer
 * can check by eye, and the model drifts off it without the emphasis.
 */
export function buildObjectPrompt(spec: ObjectPromptInput): string {
  const subject = spec.prompt.trim().replace(/\.+$/, '');
  const compartmentCount = spec.structure?.compartmentCount ?? null;
  const countedFeature = spec.structure?.countedFeature ?? null;
  const layout = compartmentCount === 4 && countedFeature === 'compartments'
    ? ' arranged as two columns by two rows'
    : '';
  const rule = compartmentCount
    ? `, EXACTLY ${compartmentCount} ${countedFeature}${layout}, no additional ${countedFeature} or dividers`
    : '';
  return `${subject}${rule}, ${GEOMETRY_SCAFFOLD}`.slice(0, 800);
}

/**
 * Prompt for the refine stage. Describes a neutral base material only — the
 * prompt's colour is applied later as a tint, not baked in.
 */
export function buildTexturePrompt(
  spec: Pick<ObjectSpec, 'category'>,
  material: Pick<ObjectMaterial, 'family'>,
): string {
  const base = NEUTRAL_BASE[material.family] ?? NEUTRAL_BASE.matte;
  const subject = spec.category === 'unknown' ? 'object' : spec.category.replace(/_/g, ' ');
  return `${base}, photoreal physically based material on a ${subject}, high surface detail, ${FLAT_LIGHTING}`.slice(0, 800);
}
