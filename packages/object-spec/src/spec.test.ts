import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretPrompt, parseObjectRequest } from './spec';

test('interprets the motivating shelf prompt', () => {
  const spec = interpretPrompt({ prompt: 'Create a large blue shelf with four empty compartments' });
  assert.equal(spec.category, 'shelving_unit');
  assert.deepEqual(spec.dimensionsM, { width: 1.2, height: 1.8, depth: 0.35 });
  assert.equal(spec.finish.colorName, 'blue');
  assert.equal(spec.dimensionsSource, 'category-default');
  assert.equal(spec.structure.compartmentCount, 4);
});

test('recognizes numeric compartment counts', () => {
  assert.equal(interpretPrompt({ prompt: 'Blue shelf with 6 compartments' }).structure.compartmentCount, 6);
});

test('recognizes explicit metric dimensions', () => {
  const spec = interpretPrompt({ prompt: 'Blue shelf, dimensions 120 x 180 x 35 cm' });
  assert.deepEqual(spec.dimensionsM, { width: 1.2, height: 1.8, depth: 0.35 });
  assert.equal(spec.dimensionsSource, 'explicit');
});

// CATEGORY_PATTERNS is first-match-wins, so a mis-ordered entry fails silently
// by resolving to a broader category instead of throwing.
const CATEGORY_CASES: readonly (readonly [string, string])[] = [
  ['a tall freestanding shelving unit', 'shelving_unit'],
  ['a low wide bookshelf', 'shelving_unit'],
  ['an oak dining chair', 'chair'],
  ['a wingback armchair', 'armchair'],
  ['a two-seat sofa on wooden legs', 'sofa'],
  ['a three-seat linen couch', 'sofa'],
  ['a bar stool', 'stool'],
  ['a round fabric ottoman', 'stool'],
  ['a slatted oak bench', 'bench'],
  ['a rectangular dining table', 'table'],
  ['a round coffee table', 'coffee_table'],
  ['a standing desk', 'desk'],
  ['a writing desk with one drawer', 'desk'],
  ['a bedside table', 'nightstand'],
  ['a two-drawer nightstand', 'nightstand'],
  ['a glass-front display cabinet', 'cabinet'],
  ['a mid-century credenza', 'sideboard'],
  ['a two-door wardrobe', 'wardrobe'],
  ['a chest of drawers', 'dresser'],
  ['a six-drawer dresser', 'dresser'],
  ['an upholstered platform bed', 'bed'],
  ['a tripod floor lamp', 'floor_lamp'],
  ['a ceramic table lamp', 'table_lamp'],
  ['a tall ceramic vase', 'vase'],
  ['a brass telescope', 'unknown'],
  // Screens and office. The first three all name a desk or a chair before
  // naming what they are, and resolved to `desk`/`chair` before these entries.
  ['a desk monitor', 'monitor'],
  ['a 27 inch monitor', 'monitor'],
  ['a desk chair', 'office_chair'],
  ['a task chair', 'office_chair'],
  ['an office chair', 'office_chair'],
  ['a television on a stand', 'television'],
  ['a wall mounted tv', 'television'],
  // Decor.
  ['a marble statue', 'statue'],
  ['a small bronze sculpture', 'statue'],
  ['a framed painting', 'painting'],
  ['a large canvas artwork', 'painting'],
  ['a round wall mirror', 'mirror'],
  ['a potted plant', 'plant'],
  ['a terracotta planter', 'plant'],
];

test('resolves one canonical phrase per category', () => {
  for (const [prompt, expected] of CATEGORY_CASES) {
    assert.equal(interpretPrompt({ prompt }).category, expected, `"${prompt}" should be ${expected}`);
  }
});

test('counts drawers and doors, not just compartments', () => {
  assert.equal(interpretPrompt({ prompt: 'a six-drawer dresser' }).structure.compartmentCount, 6);
  assert.equal(interpretPrompt({ prompt: 'a two-door wardrobe' }).structure.compartmentCount, 2);
  assert.equal(interpretPrompt({ prompt: 'a bookshelf with three shelves' }).structure.compartmentCount, 3);
  assert.equal(interpretPrompt({ prompt: 'a plain oak bench' }).structure.compartmentCount, null);
});

test('records which feature was counted', () => {
  assert.equal(interpretPrompt({ prompt: 'a six-drawer dresser' }).structure.countedFeature, 'drawers');
  assert.equal(interpretPrompt({ prompt: 'a shelf with four compartments' }).structure.countedFeature, 'compartments');
});

test('reads size words beyond "large"', () => {
  assert.equal(interpretPrompt({ prompt: 'a tall bookcase' }).size, 'large');
  assert.equal(interpretPrompt({ prompt: 'a big sofa' }).size, 'large');
  assert.equal(interpretPrompt({ prompt: 'an oak dining chair' }).size, 'medium');
});

test('rejects empty and oversized prompts', () => {
  assert.throws(() => parseObjectRequest({ prompt: ' ' }), /3–1000/);
  assert.throws(() => parseObjectRequest({ prompt: 'x'.repeat(1001) }), /3–1000/);
  assert.throws(() => parseObjectRequest({ prompt: 42 }), /must be a string/);
  assert.throws(() => parseObjectRequest(null), /must be an object/);
});
