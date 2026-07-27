const assert = require('node:assert/strict');

require('../zone_master_fallback.js');

const master = globalThis.ZONE_MASTER_FALLBACK;
assert.equal(Object.keys(master).length, 38);
assert.deepEqual(master.AA, {
  zone: 'AA-AF',
  typePick: 'Full Rack',
  owner: 'Max Mart'
});
assert.deepEqual(master.BG, {
  zone: 'BG-BH',
  typePick: 'Half Rack',
  owner: 'GFA'
});
assert.deepEqual(master.BE, {
  zone: 'BE',
  typePick: 'Pick to Sort',
  owner: 'Punthai'
});
assert.deepEqual(master.HB, {
  zone: 'HB',
  typePick: 'Mezzanine',
  owner: 'Punthai'
});

console.log('Zone master tests passed');
