/** Category, size and dimensions are derived by the analyzer, never written here. */
export interface CatalogObject {
  id: string;
  prompt: string;
  /** Scored against the user's prompt. Keep them discriminating, not decorative. */
  keywords: string[];
  /** Human label for the baked finish, shown in the tint disclosure. */
  baseFinish: string;
  /**
   * Whether a prompt colour may be multiplied over the bake. False where the bake
   * carries its own colour — green leaves, a painted canvas — since tinting only
   * darkens and would turn those to mud.
   */
  tintable?: boolean;
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

  // Flat objects are the known weak reconstruction case. These two build first, on
  // their own, so the evidence arrives before the rest of the budget is committed.
  {
    id: 'framed-painting',
    prompt: 'a framed painting, a rectangular canvas in a plain flat wooden frame',
    keywords: ['framed', 'canvas'],
    baseFinish: 'painted canvas',
    tintable: false,
  },
  {
    id: 'wall-mirror',
    prompt: 'a round wall mirror with a slim flat wooden frame',
    keywords: ['round', 'wall'],
    baseFinish: 'mirrored glass',
    tintable: false,
  },

  // Room staples — the gaps that stop a room looking furnished.
  {
    id: 'three-seat-sofa',
    prompt: 'a large three seat sofa upholstered in undyed natural linen with pale wooden legs',
    keywords: ['three seat', 'sofa'],
    baseFinish: 'natural linen',
  },
  {
    id: 'platform-bed',
    prompt: 'a large upholstered platform bed in undyed natural linen with a low headboard',
    keywords: ['platform', 'headboard'],
    baseFinish: 'natural linen',
  },
  {
    id: 'writing-desk',
    prompt: 'a writing desk in pale oak with one drawer and four straight legs',
    keywords: ['writing', 'drawer'],
    baseFinish: 'pale oak',
  },
  {
    // Deliberately not "wide": that word reads as large, and this is the medium
    // counterpart to tall-shelving-unit so the matcher has a size to choose on.
    id: 'low-bookshelf',
    prompt: 'a low bookshelf in pale oak with three open shelves',
    keywords: ['low', 'open'],
    baseFinish: 'pale oak',
  },
  {
    id: 'tripod-floor-lamp',
    prompt: 'a tripod floor lamp with three pale wooden legs and a natural linen drum shade',
    keywords: ['tripod', 'drum shade'],
    baseFinish: 'natural linen',
  },
  {
    id: 'two-drawer-nightstand',
    prompt: 'a nightstand in pale oak with two drawers and four straight legs',
    keywords: ['bedside', 'drawers'],
    baseFinish: 'pale oak',
  },

  // Screens and office.
  {
    id: 'television-on-stand',
    prompt: 'a flat screen television resting on a low pale oak stand',
    keywords: ['flat screen', 'stand'],
    baseFinish: 'matte black and pale oak',
    tintable: false,
  },
  {
    id: 'desk-monitor',
    prompt: 'a computer monitor on a slim central stand with a flat base',
    keywords: ['computer', 'stand'],
    baseFinish: 'matte grey',
    tintable: false,
  },
  {
    id: 'task-chair',
    prompt: 'an office chair with a mesh back, an upholstered seat and a five point base on castors',
    keywords: ['mesh back', 'castors'],
    baseFinish: 'grey mesh',
  },

  // Decor and showcase pieces.
  {
    id: 'stone-statue',
    prompt: 'a marble statue of an abstract standing figure on a square plinth',
    keywords: ['abstract', 'plinth'],
    baseFinish: 'honed marble',
  },
  {
    id: 'tall-ceramic-vase',
    prompt: 'a tall ceramic vase with a narrow neck and a rounded body',
    keywords: ['narrow neck', 'rounded'],
    baseFinish: 'unglazed ceramic',
  },

  // Greenery, the weakest reconstruction case here — expect a re-roll. Avoids
  // "terracotta", which is an explicit stone word and would beat foliage.
  {
    id: 'potted-plant',
    prompt: 'a potted plant with broad upright leaves in a plain round pot',
    keywords: ['potted', 'leaves'],
    baseFinish: 'green foliage',
    tintable: false,
  },
];
