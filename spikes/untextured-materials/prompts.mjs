/** Shared by both routes, so the comparison is the route and not the wording. */
export const PROMPTS = [
  {
    key: 'stone-statue',
    category: 'statue',
    materialFamily: 'stone',
    dimensionsM: { width: 0.3, height: 0.6, depth: 0.3 },
    prompt: 'a carved stone statue of a standing figure on a square plinth, smooth surfaces, single freestanding object, complete and unbroken, no background, no props',
  },
  {
    key: 'linen-armchair',
    category: 'armchair',
    materialFamily: 'fabric',
    dimensionsM: { width: 0.78, height: 0.82, depth: 0.82 },
    prompt: 'a mid-century lounge armchair with a curved upholstered shell, loose seat cushion and four splayed wooden legs, single freestanding object, complete and unbroken, no background, no props',
  },
  {
    key: 'oak-cabinet',
    category: 'cabinet',
    materialFamily: 'wood',
    dimensionsM: { width: 0.9, height: 1.2, depth: 0.42 },
    prompt: 'a cabinet with two flat doors on tapered legs, square edges, single freestanding object, complete and unbroken, completely empty, no background, no props',
  },
];
