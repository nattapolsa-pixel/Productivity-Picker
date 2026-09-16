const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('Google Sheet Master persistence and immediate restoration on dashboard load', () => {
  const root = path.resolve(__dirname, '..', '..');
  const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const initMarker = source.search(/\/\/ init\r?\nloadExcludedSkusFromStorage\(\);/);
  assert(initMarker > 0, 'Unable to isolate dashboard functions');

  const mockStorage = new Map();
  const sampleSheetPayload = {
    ok: true,
    totalPick: 448697,
    overall: {
      average: 142,
      count: 356,
      target: 170,
      gap: -28,
      status: 'ต่ำกว่า Target'
    },
    pickers: {
      all: [
        {
          userId: '25004',
          name: 'นางสาวปัทมา ระวิชัย',
          average: 118,
          count: 5,
          totalPick: 4942,
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
    },
    monthlyTrend: {
      days: [
        { date: '2026-09-01', totalPick: 79801, productivity: 137.6, count: 63, hasData: true },
        { date: '2026-09-02', totalPick: 73009, productivity: 139.6, count: 63, hasData: true },
        { date: '2026-09-03', totalPick: 82167, productivity: 146.7, count: 63, hasData: true },
        { date: '2026-09-04', totalPick: 72324, productivity: 140.6, count: 61, hasData: true },
        { date: '2026-09-05', totalPick: 73123, productivity: 133.6, count: 56, hasData: true },
        { date: '2026-09-07', totalPick: 50023, productivity: 156.0, count: 50, hasData: true }
      ]
    }
  };

  mockStorage.set('pick_productivity_sheet_master_cache_v2', JSON.stringify(sampleSheetPayload));

  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    URL,
    Blob,
    AbortController,
    ChartDataLabels: {},
    Chart: {
      defaults: { font: {}, color: '' },
      register() {},
      getChart() { return null; }
    },
    window: {},
    localStorage: {
      getItem(k) { return mockStorage.get(k) || null; },
      setItem(k, v) { mockStorage.set(k, String(v)); },
      removeItem(k) { mockStorage.delete(k); }
    },
    document: {
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {}
    }
  });

  // Run script up to initMarker
  vm.runInContext(source.slice(0, initMarker), context, { filename: 'app.js' });

  // Verify that CURRENT_SHEET_DATA was automatically restored on load from localStorage!
  const restored = vm.runInContext('CURRENT_SHEET_DATA', context);
  assert.ok(restored, 'CURRENT_SHEET_DATA must be immediately restored from storage');
  assert.equal(restored.totalPick, 448697, 'Restored totalPick must match 448,697');
  assert.equal(restored.overall.average, 142, 'Restored average must match 142');

  // Setup sample BigQuery dataset (which only has up to 2026-09-05)
  vm.runInContext(`
    ZONE_MASTER = { AA: { location: 'AA', zone: 'AA', typePick: 'Full Rack', owner: 'Max Mart', known: true } };
    DATA = {
      meta: { schema_version: DASHBOARD_SCHEMA_VERSION, excluded_skus: [] },
      PTT: { row_width: 10, item_row_width: 8, slot_row_width: 8, dates: ['2026-09-01', '2026-09-05'], pickers: ['25004'], skus: [], rows: [0,0,'AA',0,100,25,4,0,240,1920, 1,0,'AA',0,100,25,4,0,240,1920], item_rows: [], slot_rows: [] },
      BPS: { row_width: 10, item_row_width: 8, slot_row_width: 8, dates: [], pickers: [], skus: [], rows: [], item_rows: [], slot_rows: [] }
    };
    prepShifts();
    computeBounds();
  `, context);

  // Bounds check: DMAX should include 2026-09-07 from Google Sheet!
  const dmax = vm.runInContext('DMAX', context);
  assert.equal(dmax, '2026-09-07', 'DMAX must cover Google Sheet dates beyond BigQuery');

  // Aggregate check: kpis.qty should immediately equal Google Sheet 448697
  const res = vm.runInContext("aggregate('PTT', '2026-09-01', '2026-09-07', 'all')", context);
  assert.equal(res.kpis.qty, 448697, 'KPIs qty must be official Sheet total 448,697');
  assert.equal(res.kpis.avg_prod, 142, 'KPIs avg_prod must be official Sheet avg 142');
  assert.equal(res.kpis.target, 170, 'KPIs target must be official Sheet target 170');

  // Check daily trend: Day 7 (which was not in BigQuery) must be present in result.daily!
  const day7 = res.daily.find(d => d.date === '2026-09-07');
  assert.ok(day7, 'Day 7 (2026-09-07) must be present in result.daily');
  assert.equal(day7.qty, 50023, 'Day 7 qty must match Sheet 50,023');
  assert.equal(day7.avg_prod, 156, 'Day 7 avg_prod must match Sheet 156');
  assert.equal(day7.pickers, 50, 'Day 7 pickers must match Sheet 50');

  // Test saving updated sheet data
  vm.runInContext(`
    saveSheetDataToStorage({ ok: true, totalPick: 500000, overall: { average: 150, target: 170 } }, '2026-09-01', '2026-09-07');
  `, context);
  const updatedStorage = mockStorage.get('pick_productivity_sheet_master_cache_v2');
  assert.ok(updatedStorage && updatedStorage.includes('500000'), 'saveSheetDataToStorage must update localStorage');
});
