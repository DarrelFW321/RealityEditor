import test from 'node:test';
import assert from 'node:assert/strict';
import { materialFromSpec } from './materials.js';
import { interpretPrompt } from './spec.js';

test('uses painted wood for colored furniture', () => {
  const material = materialFromSpec(interpretPrompt({ prompt: 'a large blue shelf' }));
  assert.equal(material.family, 'painted_wood');
  assert.equal(material.colorHex, '#2867b2');
  assert.equal(material.metalness, 0);
});

test('explicit material language wins over category defaults', () => {
  const material = materialFromSpec(interpretPrompt({ prompt: 'a brushed steel blue shelf' }));
  assert.equal(material.family, 'metal');
  assert.equal(material.metalness, 0.9);
  assert.equal(material.explicit, true);
});

test('upholstered categories default to fabric, not painted wood', () => {
  for (const prompt of ['a navy sofa', 'a navy armchair', 'a navy bed']) {
    const material = materialFromSpec(interpretPrompt({ prompt }));
    assert.equal(material.family, 'fabric', prompt);
    assert.equal(material.explicit, false, prompt);
  }
});

test('neutral hard furniture reads as bare wood', () => {
  assert.equal(materialFromSpec(interpretPrompt({ prompt: 'a writing desk' })).family, 'wood');
});
