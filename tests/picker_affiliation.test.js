const assert = require('node:assert/strict');

require('../picker_affiliation_fallback.js');

const map = globalThis.PICKER_AFFILIATION_FALLBACK;
assert.equal(map['10090620'], 'PTG');
assert.equal(map['25135'], '40HRS');
assert.equal(map['MPPTG0431'], 'Man Power');
assert.equal(Object.keys(map).length, 220);

console.log('Picker affiliation fallback tests passed');
