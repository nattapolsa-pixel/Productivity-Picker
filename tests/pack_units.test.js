const assert = require('node:assert/strict');

require('../pack_size_master.js');
require('../pack_units.js');

const target = '250001008';
assert.deepEqual(globalThis.PACK_SIZE_MASTER[target], [72, 6, 1]);

const cases = [
  [144, 2, 72],
  [72, 1, 72],
  [48, 8, 6],
  [30, 5, 6],
  [12, 2, 6],
  [5, 5, 1]
];

for (const [pieces, expectedUnits, expectedPackSize] of cases) {
  const result = globalThis.PickUnits.detail(pieces, target, 999);
  assert.equal(result.units, expectedUnits, `${pieces} pieces`);
  assert.equal(result.packSize, expectedPackSize, `${pieces} pack size`);
  assert.equal(result.source, 'pack-size', `${pieces} source`);
}

const missing = globalThis.PickUnits.detail(10, 'SKU-NOT-IN-MASTER', 4);
assert.equal(missing.units, 4);
assert.equal(missing.source, 'missing-pack-size');

console.log('Pack Size unit tests passed');
