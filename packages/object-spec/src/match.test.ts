import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_THRESHOLD, matchCatalog, scoreEntry, type CatalogEntry } from './match.js';
import { interpretPrompt } from './spec.js';
import { materialFromSpec } from './materials.js';

const ENTRIES: CatalogEntry[] = [
  {
    id: 'tall-shelving-unit', status: 'complete', category: 'shelving_unit', size: 'large',
    materialFamily: 'wood', baseFinish: 'pale oak', tintable: true,
    keywords: ['freestanding', 'tall'], structure: { compartmentCount: 4 },
    sha256: 'a'.repeat(64), file: 'assets/a.glb',
  },
  {
    id: 'low-bookshelf', status: 'complete', category: 'shelving_unit', size: 'medium',
    materialFamily: 'wood', baseFinish: 'pale oak', tintable: true,
    keywords: ['low', 'wide'], structure: { compartmentCount: 3 },
    sha256: 'b'.repeat(64), file: 'assets/b.glb',
  },
  {
    id: 'oak-dining-table', status: 'complete', category: 'table', size: 'large',
    materialFamily: 'wood', baseFinish: 'pale oak', tintable: true,
    keywords: ['rectangular', 'dining'], structure: {},
    sha256: 'c'.repeat(64), file: 'assets/c.glb',
  },
  {
    id: 'patterned-vase', status: 'complete', category: 'vase', size: 'medium',
    materialFamily: 'matte', baseFinish: 'glazed pattern', tintable: false,
    keywords: [], structure: {},
    sha256: 'd'.repeat(64), file: 'assets/d.glb',
  },
];

const CATALOG = { entries: ENTRIES };

function match(prompt: string) {
  const spec = interpretPrompt({ prompt });
  return matchCatalog(CATALOG, spec, materialFromSpec(spec));
}

test('the headline demo prompt is an instant catalog hit', () => {
  const hit = match('A large blue freestanding shelving unit with four empty compartments');
  assert.ok(hit);
  assert.equal(hit.entry.id, 'tall-shelving-unit');
  assert.ok(hit.score > CATALOG_THRESHOLD);
  assert.deepEqual(hit.matched, ['freestanding']);
  assert.ok(hit.disclosures.includes('pre-made catalog object'));
  assert.ok(hit.disclosures.some((d) => d.includes('blue applied as a tint over the baked pale oak finish')));
});

test('a different compartment count is never substituted', () => {
  assert.equal(match('A large blue shelving unit with six compartments'), null);
});

test('category is a hard gate', () => {
  assert.equal(match('a two-door wardrobe'), null);
  assert.equal(match('an oak dining chair'), null);
});

test('an explicit material the catalog does not have is vetoed', () => {
  assert.equal(match('a large glass dining table'), null);
  assert.equal(match('a large dining table')?.entry.id, 'oak-dining-table');
});

test('size breaks the tie between two entries in one category', () => {
  assert.equal(match('a shelving unit')?.entry.id, 'low-bookshelf');
  assert.equal(match('a tall shelving unit')?.entry.id, 'tall-shelving-unit');
});

test('an untintable entry rejects an explicit colour', () => {
  assert.equal(match('a navy vase'), null);
  assert.equal(match('a vase')?.entry.id, 'patterned-vase');
});

test('an off-catalog prompt falls through', () => {
  assert.equal(match('a brass telescope'), null);
});

test('size mismatch is disclosed rather than hidden', () => {
  const spec = interpretPrompt({ prompt: 'a large dining table' });
  const medium = { ...ENTRIES[2]!, size: 'medium' as const };
  const hit = matchCatalog({ entries: [medium] }, spec, materialFromSpec(spec));
  assert.ok(hit);
  assert.ok(hit.disclosures.includes('requested large; catalog entry is medium'));
});

test('scoreEntry reports every veto, not just the first', () => {
  const spec = interpretPrompt({ prompt: 'a glass table with two doors' });
  const scored = scoreEntry(spec, materialFromSpec(spec), ENTRIES[0]!);
  assert.deepEqual(scored.vetoes.sort(), ['category', 'compartments', 'material']);
});
