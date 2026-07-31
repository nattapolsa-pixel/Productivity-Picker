const assert = require('node:assert/strict');

delete globalThis.PACK_SIZE_MASTER;
require('../pack_units.js');

const cases = [
  [2.5, 2.5],
  ['1.25', 1.25],
  [0, 0],
  [null, 0],
  [undefined, 0],
  ['not-a-number', 0]
];

for (const [pickQty, expectedUnits] of cases) {
  const result = globalThis.PickUnits.detail(pickQty);
  assert.equal(result.units, expectedUnits, `BigQuery pick_qty ${String(pickQty)}`);
  assert.equal(result.source, 'bigquery-pick-qty');
  assert.equal(globalThis.PickUnits.calculate(pickQty), expectedUnits);
}

assert.equal(globalThis.PACK_SIZE_MASTER, undefined);
console.log('BigQuery pick_qty unit tests passed');
