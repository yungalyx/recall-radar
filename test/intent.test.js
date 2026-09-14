// The router has to work on *spoken* input, not just typed input. Every string below is in the
// form AssemblyAI's formatted transcripts actually arrive in -- verified against the live
// streaming API, which returned "A rolling stone gathers no moss." for a spoken sentence:
// leading capital, terminal punctuation, numbers spelled as words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route, spokenNumber, parseItem, HELP } from '../src/intent.js';

const MATCHES = [{ recall_id: 'cpsc:20062' }, { recall_id: 'nhtsa:22V-123' }];

test('spokenNumber: digits, words, ordinals, and trailing punctuation', () => {
  assert.equal(spokenNumber('1'), 1);
  assert.equal(spokenNumber('one'), 1);
  assert.equal(spokenNumber('One.'), 1);
  assert.equal(spokenNumber('second'), 2);
  assert.equal(spokenNumber('#3'), 3);
  assert.equal(spokenNumber('ten'), 10);
  assert.equal(spokenNumber('banana'), null);
  assert.equal(spokenNumber(undefined), null);
});

test('spoken commands route the same as typed ones', () => {
  const cases = [
    ['Is anything in my house recalled?', ['check_recalls', {}]],
    ['is anything recalled', ['check_recalls', {}]],
    ['What do I own?', ['list_items', {}]],
    ['Import my orders.', ['import', {}]],
    ['Details one.', ['recall_details', { recall_id: 'cpsc:20062' }]],
    ['details 1', ['recall_details', { recall_id: 'cpsc:20062' }]],
    ['Tell me about two.', ['recall_details', { recall_id: 'nhtsa:22V-123' }]],
    ['Help me fix one.', ['start_remedy', { recall_id: 'cpsc:20062' }]],
    ['help me fix the second one', ['start_remedy', { recall_id: 'nhtsa:22V-123' }]],
    ['Remove item two.', ['remove_item', { id: 2 }]],
    ['remove #2', ['remove_item', { id: 2 }]],
    ['Forget item one.', ['remove_item', { id: 1 }]],
  ];
  for (const [said, want] of cases) {
    assert.deepEqual(route(said, MATCHES), want, `"${said}"`);
  }
});

test('add_item survives capitalisation and a trailing period', () => {
  assert.deepEqual(route('Add a Graco 4Ever car seat.', MATCHES),
    ['add_item', { name: 'Graco 4Ever car seat', brand: 'Graco' }]);
  assert.deepEqual(route('Add a 2020 Honda Civic.', MATCHES),
    ['add_item', { name: '2020 Honda Civic', brand: 'Honda' }]);
  assert.deepEqual(route('I bought a Graco 4Ever car seat, model 2075634.', MATCHES),
    ['add_item', { name: 'Graco 4Ever car seat', brand: 'Graco', model: '2075634' }]);
});

test('an explicit item number still scopes the recall check', () => {
  assert.deepEqual(route('check recalls on item #2', MATCHES), ['check_recalls', { item_id: 2 }]);
});

test('a reference with no result behind it explains itself instead of hitting the server', () => {
  assert.throws(() => route('details nine', MATCHES), /result number 9/);
  assert.throws(() => route('remove item banana', MATCHES), /which item number/i);
});

test('unrecognised speech falls through to help, and help names real commands', () => {
  assert.equal(route("What's the weather?", MATCHES), null);
  for (const phrase of ['details one', 'remove item two', 'is anything recalled?']) {
    assert.ok(HELP.includes(phrase), `HELP should offer "${phrase}"`);
  }
});

test('parseItem keeps a VIN out of the name', () => {
  assert.deepEqual(parseItem('2022 Honda Odyssey, VIN: 5FNRL6H82NB012345'),
    { name: '2022 Honda Odyssey', brand: 'Honda', model: '5FNRL6H82NB012345' });
});
