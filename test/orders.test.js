import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCsv, parseOrders } from '../src/orders.js';

test('parseCsv: quotes, embedded commas/newlines, doubled quotes, CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n'), [['a', 'b'], ['x, y', 'say "hi"\nthere']]);
});

test('parseOrders: classic "Your Orders" layout, dedupes by ASIN, guesses brand and category', () => {
  const items = parseOrders(readFileSync(new URL('./fixtures/orders.csv', import.meta.url), 'utf8'));
  assert.equal(items.length, 3, 'duplicate ASIN row skipped');
  assert.deepEqual(items.map((i) => i.asin), ['B07DKQ3V7Q', 'B00CQLSMS4', 'B0EXAMPLE1']);
  assert.equal(items[0].name, 'Graco 4Ever DLX 4-in-1 Car Seat, Fairmont');
  assert.equal(items[0].brand, 'Graco');
  assert.equal(items[0].category, 'car_seat', 'Amazon category column wins when present');
  assert.equal(items[0].purchased_on, '2024-03-14');
  assert.equal(items[2].name, 'ResMed AirSense 10 CPAP Machine\nwith Humidifier');
});

test('parseOrders: privacy-export layout ("Product Name", "ASIN") and inferred categories', () => {
  const csv = 'Website,Order ID,Order Date,ASIN,Quantity,Product Name\nAmazon.com,1,2025-01-05T10:00:00Z,B1,2,Tylenol Extra Strength 500mg Caplets\nAmazon.com,2,2025-02-06,B2,1,Cosori Air Fryer 5.8QT\n';
  const items = parseOrders(csv);
  assert.equal(items.length, 2);
  assert.equal(items[0].category, 'drug');
  assert.equal(items[0].quantity, 2);
  assert.equal(items[0].purchased_on, '2025-01-05');
  assert.equal(items[1].category, 'product');
  assert.equal(items[1].brand, 'Cosori');
});

test('parseOrders: rejects a CSV without a title column', () => {
  assert.throws(() => parseOrders('a,b\n1,2\n'), /no "Title" or "Product Name"/);
});
