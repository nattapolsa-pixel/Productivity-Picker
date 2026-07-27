const assert = require('node:assert/strict');

require('../zone_layout.js');

const layout = globalThis.ZONE_LAYOUT;
assert.equal(layout.onFloor.length, 7);
assert.equal(layout.selectiveTop.length, 14);
assert.equal(layout.selectiveBottom.length, 14);
assert.deepEqual(layout.microRack, ['EA', 'FA']);

const codes = [
  ...layout.onFloor,
  ...layout.selectiveTop,
  ...layout.selectiveBottom,
  ...layout.microRack
];
assert.equal(codes.length, 37);
assert.equal(new Set(codes).size, codes.length, 'layout location codes must be unique');
assert.ok(codes.includes('PF'));
assert.ok(!codes.includes('BE'));
assert.ok(!codes.includes('HB'));
assert.deepEqual(layout.bottomBands.map(x => [x.label, x.start, x.span]), [
  ['MAX MART', 1, 1],
  ['PUNTHAI', 2, 4],
  ['MAX MART', 6, 8],
  ['LUBE', 14, 1]
]);

console.log('Zone layout tests passed');
