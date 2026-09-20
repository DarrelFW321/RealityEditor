/** Category, size and dimensions are derived by the analyzer, never written here. */
export interface CatalogObject {
  id: string;
  prompt: string;
  /** Scored against the user's prompt. Keep them discriminating, not decorative. */
  keywords: string[];
  /** Human label for the baked finish, shown in the tint disclosure. */
  baseFinish: string;
}

export const CATALOG_OBJECTS: readonly CatalogObject[] = [
  {
    id: 'tall-shelving-unit',
    prompt: 'a tall freestanding shelving unit with four empty compartments, pale oak, mid-century modern',
    keywords: ['freestanding', 'tall'],
    baseFinish: 'pale oak',
  },
  {
    id: 'oak-dining-chair',
    prompt: 'a pale oak dining chair with a spindle back and four straight legs',
    keywords: ['dining', 'spindle'],
    baseFinish: 'pale oak',
  },
  {
    id: 'rectangular-dining-table',
    prompt: 'a large rectangular pale oak dining table with four straight legs',
    keywords: ['rectangular', 'dining'],
    baseFinish: 'pale oak',
  },
  {
    id: 'round-coffee-table',
    prompt: 'a round pale oak coffee table with three tapered legs',
    keywords: ['round', 'tapered'],
    baseFinish: 'pale oak',
  },
  {
    id: 'two-door-cabinet',
    prompt: 'a pale oak cabinet with two doors on tapered legs',
    keywords: ['two doors', 'tapered'],
    baseFinish: 'pale oak',
  },
  {
    id: 'linen-armchair',
    prompt: 'a mid-century lounge armchair upholstered in undyed natural linen with pale wooden legs',
    keywords: ['lounge', 'mid-century'],
    baseFinish: 'natural linen',
  },
];
