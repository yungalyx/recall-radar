// Matcher checks against real recall records fetched from CPSC, NHTSA and openFDA (test/fixtures/*.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rankMatches, scoreMatch, similar, tokens, inferCategory } from '../src/match.js';
import { normalizeCpsc, normalizeNhtsa, normalizeFda, remedySteps } from '../src/recalls.js';

const load = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const cpsc = load('cpsc_graco.json').map(normalizeCpsc);
const nhtsa = load('nhtsa_civic_2020.json').results.map(normalizeNhtsa);
const fda = load('fda_food_peanut.json').results.map(normalizeFda);
const top = (item, recs) => rankMatches(item, recs)[0];

test('tokens/similar: normalisation and typo tolerance', () => {
  assert.deepEqual(tokens("Graco Pack 'n Play Everest Playard"), ['graco', 'pack', 'play', 'everest', 'playard']);
  assert.ok(similar('odysey', 'odyssey'));
  assert.ok(!similar('civic', 'cinch'));
});

test('CPSC: brand + product words match the right Graco recall with an explainable reason', () => {
  const m = top({ name: 'Little Lounger rocking seat', brand: 'Graco' }, cpsc);
  assert.equal(m.recall.id, 'cpsc:20062');
  assert.ok(m.confidence >= 0.75, `confidence ${m.confidence}`);
  assert.match(m.reason, /brand "graco"/);
  assert.match(m.reason, /4\/4 product words/);
  assert.equal(top({ name: 'Pack n Play Everest playard', brand: 'Graco' }, cpsc).recall.id, 'cpsc:21052');
});

test('CPSC: a different brand does not match, and brand-only overlap stays below high', () => {
  assert.equal(rankMatches({ name: 'Bugaboo Fox stroller', brand: 'Bugaboo' }, cpsc).length, 0);
  const m = top({ name: 'Graco 4Ever car seat', brand: 'Graco' }, cpsc);
  assert.ok(!m || m.confidence < 0.75, 'same brand, different product must not be high confidence');
});

test('NHTSA: vehicle year/make/model gives full confidence; other make gives nothing', () => {
  const ms = rankMatches({ name: '2020 Honda Civic', brand: 'Honda', model: 'Civic', category: 'vehicle' }, nhtsa);
  assert.equal(ms.length, 5);
  assert.ok(ms.every((m) => m.confidence >= 0.9));
  assert.equal(rankMatches({ name: '2020 Toyota Camry', brand: 'Toyota', model: 'Camry', category: 'vehicle' }, nhtsa).length, 0);
});

test('openFDA: product words match; wrong brand is halved below threshold', () => {
  assert.equal(top({ name: 'peanut butter cookies', category: 'food' }, fda).recall.id, 'fda:F-2473-2016');
  assert.equal(rankMatches({ name: 'Jif creamy peanut butter', brand: 'Jif', category: 'food' }, fda).length, 0);
  assert.equal(scoreMatch({ name: 'lawn mower' }, fda[0]).confidence, 0);
});

test('inferCategory routes items to the right database', () => {
  assert.equal(inferCategory('2022 Honda Odyssey'), 'vehicle');
  assert.equal(inferCategory('Graco 4Ever car seat'), 'product');
  assert.equal(inferCategory('Tylenol 500mg tablets'), 'drug');
  assert.equal(inferCategory('ResMed CPAP machine'), 'device');
  assert.equal(inferCategory('Jif peanut butter'), 'food');
});

test('remedySteps extracts path, phone and web from a real CPSC record', () => {
  const r = remedySteps(cpsc.find((c) => c.id === 'cpsc:20062'));
  assert.equal(r.path, 'refund');
  assert.equal(r.phone, '800-345-4109');
  assert.equal(r.web, 'www.gracobaby.com');
  assert.equal(r.steps.length, 5);
  assert.match(r.reminder.on, /^\d{4}-\d{2}-\d{2}$/);
});
