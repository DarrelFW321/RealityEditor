import test from 'node:test';
import assert from 'node:assert/strict';
import { buildObjectPrompt, buildTexturePrompt, resolveSize, SIZE_PRESETS_CM } from './prompts.js';

test('object prompt keeps the subject and adds the single-object scaffold', () => {
  const result = buildObjectPrompt({ prompt: 'A large blue freestanding shelving unit.' });
  assert.match(result, /^A large blue freestanding shelving unit, /);
  assert.match(result, /single freestanding object/);
  assert.match(result, /completely empty and undecorated/);
  assert.ok(result.length <= 800);
});

test('object prompt restates a counted feature as a hard constraint', () => {
  const shelf = buildObjectPrompt({
    prompt: 'a large blue shelving unit with four empty compartments',
    structure: { compartmentCount: 4, countedFeature: 'compartments' },
  });
  assert.match(shelf, /EXACTLY 4 compartments arranged as two columns by two rows/);

  const dresser = buildObjectPrompt({
    prompt: 'a six-drawer dresser',
    structure: { compartmentCount: 6, countedFeature: 'drawers' },
  });
  assert.match(dresser, /EXACTLY 6 drawers, no additional drawers or dividers/);
  assert.doesNotMatch(dresser, /columns by two rows/);

  assert.doesNotMatch(buildObjectPrompt({ prompt: 'a bench' }), /EXACTLY/);
});

test('texture prompt bakes a neutral base and never the requested colour', () => {
  const result = buildTexturePrompt({ category: 'shelving_unit' }, { family: 'painted_wood' });
  assert.match(result, /pale natural oak/);
  assert.doesNotMatch(result, /blue/i);
  assert.match(result, /shelving unit/);
  // The only defence against baked-in lighting on meshy-7.1.
  assert.ok(result.endsWith('no baked highlights'), result);
});

test('texture prompt falls back to a matte base for unknown families', () => {
  const result = buildTexturePrompt({ category: 'unknown' }, { family: 'matte' });
  assert.match(result, /light warm grey matte surface/);
  assert.match(result, /on a object/);
});

test('infers size from a word in the description', () => {
  const result = resolveSize('a large blue shelf');
  assert.equal(result.source, 'inferred-from-text');
  assert.equal(result.preset, 'large');
  assert.equal(result.targetCm, SIZE_PRESETS_CM.large);
  assert.equal(result.caveats.length, 0);
});

test('defaults to medium with a caveat when no size is known', () => {
  const result = resolveSize('a blue shelf');
  assert.equal(result.source, 'default');
  assert.equal(result.preset, 'medium');
  assert.equal(result.caveats.length, 1);
});

test('explicit targetCm overrides text and keeps the wording, with a caveat', () => {
  const result = resolveSize('a small chair', { targetCm: 140 });
  assert.equal(result.source, 'explicit-cm');
  assert.equal(result.targetCm, 140);
  assert.equal(result.textWord, 'small');
  assert.equal(result.caveats.length, 1);
  assert.match(result.caveats[0] ?? '', /kept the wording as written/);
});

test('explicit preset matching the text word adds no mismatch caveat', () => {
  assert.equal(resolveSize('a large shelf', { preset: 'large' }).caveats.length, 0);
});

test('flags conflicting size words but keeps the first one found', () => {
  const result = resolveSize('a small but wide shelf');
  assert.equal(result.preset, 'small');
  assert.match(result.caveats[0] ?? '', /conflicting size words/);
});

test('rejects a non-positive explicit size', () => {
  assert.throws(() => resolveSize('a shelf', { targetCm: 0 }), /positive, finite/);
});
