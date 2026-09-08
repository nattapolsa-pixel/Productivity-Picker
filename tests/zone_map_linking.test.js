const assert = require('node:assert/strict');
require('../zone_layout.js');
require('../zone_master_fallback.js');

const layout = globalThis.ZONE_LAYOUT;
const master = globalThis.ZONE_MASTER_FALLBACK;

// 1. Verify layout boxes are separate and unmerged
assert.ok(layout.selectiveBottom.includes('AN'), 'AN must be a distinct box in selectiveBottom');
assert.ok(layout.selectiveBottom.includes('CA'), 'CA must be a distinct box in selectiveBottom');
assert.ok(layout.selectiveBottom.includes('CF'), 'CF must be a distinct box in selectiveBottom');
assert.ok(layout.selectiveTop.includes('DF'), 'DF must be a distinct box in selectiveTop');
assert.equal(new Set([...layout.onFloor, ...layout.selectiveTop, ...layout.selectiveBottom, ...layout.microRack]).size, 37, 'Total 37 distinct unmerged boxes on floor map');

// 2. Verify zone metadata matches compound pairs
assert.equal(master.AN.zone, 'AN-CA');
assert.equal(master.CA.zone, 'AN-CA');
assert.equal(master.CF.zone, 'CF-DF');
assert.equal(master.DF.zone, 'CF-DF');

// 3. Test linking logic when CA and DF have 0 direct scans
const activeLocations = new Map([
  ['AN', { location: 'AN', pcs: 125000, qty: 3218, lines: 1500, pickers: 14 }],
  ['CF', { location: 'CF', pcs: 82000, qty: 3844, lines: 2000, pickers: 23 }]
]);

function getRow(code) {
  let row = activeLocations.get(code) || { location: code, pcs: 0, qty: 0, lines: 0, pickers: 0 };
  let isLinked = false;
  let linkedSibling = '';
  if (Number(row.lines || 0) === 0 && (code === 'CA' || code === 'DF')) {
    linkedSibling = code === 'CA' ? 'AN' : 'CF';
    const sibRow = activeLocations.get(linkedSibling);
    if (sibRow && Number(sibRow.lines || 0) > 0) {
      row = { ...sibRow, location: code };
      isLinked = true;
    }
  }
  return { row, isLinked, linkedSibling };
}

const caResult = getRow('CA');
assert.equal(caResult.isLinked, true);
assert.equal(caResult.linkedSibling, 'AN');
assert.equal(caResult.row.qty, 3218);
assert.equal(caResult.row.pcs, 125000);
assert.equal(caResult.row.pickers, 14);

const dfResult = getRow('DF');
assert.equal(dfResult.isLinked, true);
assert.equal(dfResult.linkedSibling, 'CF');
assert.equal(dfResult.row.qty, 3844);
assert.equal(dfResult.row.pcs, 82000);
assert.equal(dfResult.row.pickers, 23);

// 4. If direct scans exist (historical data), verify it does NOT link
activeLocations.set('CA', { location: 'CA', pcs: 17218, qty: 850, lines: 400, pickers: 8 });
const directCaResult = getRow('CA');
assert.equal(directCaResult.isLinked, false);
assert.equal(directCaResult.row.qty, 850);
assert.equal(directCaResult.row.pcs, 17218);

console.log('Zone map linking and unmerged box tests passed successfully');
