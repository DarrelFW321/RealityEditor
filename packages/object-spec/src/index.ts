/** Free-text → object specification. Keep dependency-free: both server and app import it. */
export {
  interpretPrompt,
  parseObjectRequest,
  type DimensionsM,
  type DimensionsSource,
  type ObjectSpec,
  type SizeClass,
} from './spec.js';

export {
  materialFromSpec,
  type MaterialFamily,
  type ObjectMaterial,
} from './materials.js';

export {
  buildObjectPrompt,
  buildTexturePrompt,
  resolveSize,
  SIZE_PRESETS_CM,
  type ResolvedSize,
  type SizeInput,
  type SizePreset,
} from './prompts.js';

export {
  matchCatalog,
  scoreEntry,
  CATALOG_THRESHOLD,
  type CatalogEntry,
  type CatalogMatch,
  type ScoredEntry,
} from './match.js';
