const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('Picker Sheet Hybrid mapping (Sheet primary volume + BigQuery actual zones)', () => {
  const root = path.resolve(__dirname, '..', '..');
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const initMarker = source.search(/\/\/ init\r?\nloadExcludedSkusFromStorage\(\);/);
  assert(initMarker > 0, 'Unable to isolate dashboard functions');

  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    URL,
    Blob,
    AbortController,
    ChartDataLabels: {},
    Chart: {
      defaults: {font:{}, color:''},
      register(){},
      getChart(){ return null; }
    },
    window: {},
    localStorage: {getItem(){return null;}, setItem(){}, removeItem(){}},
    document: {getElementById(){return null;}, querySelector(){return null;}, querySelectorAll(){return [];}, addEventListener(){}}
  });

  vm.runInContext(source.slice(0, initMarker), context, {filename:'app.js'});

  vm.runInContext(`
    ZONE_MASTER = { AA: { location: 'AA', zone: 'AA', typePick: 'Full Rack', owner: 'Max Mart', known: true } };
    DATA = {
      meta:{schema_version:DASHBOARD_SCHEMA_VERSION, excluded_skus:[]},
      PTT:{row_width:10, item_row_width:8, slot_row_width:8, dates:['2026-09-04'], pickers:['25004'], skus:[], rows:[0,0,'AA',0,100,25,4,0,240,1920], item_rows:[], slot_rows:[]},
      BPS:{row_width:10, item_row_width:8, slot_row_width:8, dates:[], pickers:[], skus:[], rows:[], item_rows:[], slot_rows:[]}
    };
    CURRENT_SHEET_DATA = {
      ok: true,
      totalPick: 75049,
      overall: { average: 140.6, target: 170, status: 'ต่ำกว่า Target' },
      pickers: {
        all: [
          {
            userId: '25004',
            name: 'นางสาวปัทมา ระวิชัย',
            average: 118,
            count: 1,
            totalPick: 942,
            target: 170,
            gap: -52,
            status: 'ต่ำกว่า Target',
            mainShift: 'B',
            mainAffiliation: '40HRS',
            mainBu: 'Mart',
            mainPickType: 'Half Rack',
            mainZone: 'CB-DB-DC-CC'
          }
        ]
      }
    };
    prepShifts();
  `, context);

  const result = vm.runInContext("aggregate('PTT', '2026-09-04', '2026-09-04', 'all')", context);
  assert.ok(result, 'Aggregation result should be returned');
  assert.equal(result.kpis.qty, 75049, 'Total KPIs qty should match Sheet totalPick');

  const p = result.by_picker.find(x => x.picker === '25004');
  assert.ok(p, 'Picker 25004 must exist in by_picker');
  assert.equal(p.qty, 942, 'Picker qty must be set to Sheet totalPick');
  assert.equal(p.rawBqQty, 25, 'Raw BigQuery qty must be preserved in rawBqQty');
  assert.equal(p.avg_prod, 118, 'Picker avg_prod must be set to Sheet average');
  assert.equal(p.sheetZone, 'CB-DB-DC-CC', 'Picker sheetZone must match Sheet');
  assert.equal(p.sheetShift, 'B', 'Picker sheetShift must match Sheet');
});
