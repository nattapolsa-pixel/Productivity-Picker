// ตัวกรองกะ (A / B / Not Found) ต้องมีผลกับ Picker ที่มาจาก Google Sheet ด้วย
// บั๊กเดิม: บล็อกผสมข้อมูล Sheet วน s.pickers.all ทั้งหมดแล้ว push เข้า by_picker
// โดยไม่เช็ค sf → เลือก "กะ A" แล้วยังเห็นคนกะ B โผล่มา
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const initMarker = source.search(/\/\/ init\r?\nloadExcludedSkusFromStorage\(\);/);
assert(initMarker > 0, 'Unable to isolate dashboard functions from browser bootstrap');

const context = vm.createContext({
  console: { log() {}, warn() {}, error() {} },
  setTimeout, clearTimeout, URL, Blob, AbortController, Intl,
  ChartDataLabels: {},
  Chart: { defaults: { font: {}, color: '' }, register() {}, getChart() { return null; } },
  window: {},
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  document: { getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {} }
});
context.globalThis = context;
vm.runInContext(source.slice(0, initMarker), context, { filename: 'app.js' });

/* ----------------------------------------------------------------------
   P1 = Team A (มีงานใน BigQuery)
   P2 = Team B (มีงานใน BigQuery)
   P3 = Team B (มีแต่ใน Sheet ไม่มีใน BigQuery)  ← เคสที่ทำให้บั๊กโผล่ชัด
   P4 = ไม่มีใน roster → NOT_FOUND (มีแต่ใน Sheet)
---------------------------------------------------------------------- */
vm.runInContext(`
  excludedSkus = new Set();
  excludedZones = new Set();
  ZONE_MASTER = {
    AH: { zone: 'AH-AI', typePick: 'Full Rack', owner: 'Punthai' },
    AN: { zone: 'AN-CA', typePick: 'Half Rack', owner: 'Max Mart' }
  };
  DATA = {
    meta: {
      schema_version: DASHBOARD_SCHEMA_VERSION,
      picker_names: { P1: 'คน หนึ่ง', P2: 'คน สอง', P3: 'คน สาม', P4: 'คน สี่' },
      picker_affiliations: { P1: 'PTG', P2: 'PTG', P3: '40HRS', P4: 'Man Power' },
      picker_roster_teams: { P1: 'A', P2: 'B', P3: 'B' }
    },
    PTT: {
      row_width: 10, item_row_width: 8, slot_row_width: 8,
      dates: ['2026-09-01'], pickers: ['P1', 'P2'], skus: [],
      rows: [
        0, 0, 'AH', 0, 1200, 1000, 40, 0, 300, 0b1111100,
        0, 1, 'AN', 1, 700, 600, 25, 0, 300, 0b1111100
      ],
      item_rows: [], slot_rows: []
    },
    BPS: { row_width: 10, item_row_width: 8, slot_row_width: 8, dates: [], pickers: [], skus: [], rows: [], item_rows: [], slot_rows: [] }
  };
  prepShifts();

  CURRENT_SHEET_DATA = {
    ok: true,
    totalPick: 4000,
    overall: { average: 150, target: 170, status: 'ต่ำกว่า Target' },
    pickers: {
      total: 4,
      all: [
        { userId: 'P1', name: 'คน หนึ่ง', average: 200, totalPick: 1000, count: 5, target: 170, mainShift: 'A', mainZone: 'AH-AI', mainAffiliation: 'PTG' },
        { userId: 'P2', name: 'คน สอง', average: 120, totalPick: 600,  count: 5, target: 200, mainShift: 'B', mainZone: 'AN-CA', mainAffiliation: 'PTG' },
        { userId: 'P3', name: 'คน สาม', average: 90,  totalPick: 400,  count: 5, target: 200, mainShift: 'B', mainZone: 'AN-CA', mainAffiliation: '40HRS' },
        { userId: 'P4', name: 'คน สี่',  average: 80,  totalPick: 300,  count: 5, target: 170, mainShift: '-', mainZone: '-',      mainAffiliation: 'Man Power' }
      ]
    },
    monthlyTrend: { days: [] }
  };

  function pickerIdsFor(sf) {
    aggregateCache.clear();
    return aggregate('PTT', '2026-09-01', '2026-09-01', sf).by_picker.map(p => p.picker).sort();
  }
  globalThis.__all = pickerIdsFor('all');
  globalThis.__morning = pickerIdsFor('morning');
  globalThis.__night = pickerIdsFor('night');
  globalThis.__notFound = pickerIdsFor('not_found');

  aggregateCache.clear();
  globalThis.__morningKpis = aggregate('PTT', '2026-09-01', '2026-09-01', 'morning').kpis;
`, context);

const j = v => JSON.parse(JSON.stringify(v));

assert.deepEqual(j(context.__all), ['P1', 'P2', 'P3', 'P4'],
  'ตัวกรอง "ทุกกะ" ต้องเห็น Picker ครบทุกคนทั้งจาก BigQuery และ Sheet');

assert.deepEqual(j(context.__morning), ['P1'],
  'เลือก "กะ A" ต้องเหลือแค่ Team A — คนกะ B จาก Sheet ต้องไม่ถูก push เข้ามา');

assert.deepEqual(j(context.__night), ['P2', 'P3'],
  'เลือก "กะ B" ต้องได้ทั้งคนที่มีงานใน BigQuery และคนที่มีแต่ใน Sheet');

assert.deepEqual(j(context.__notFound), ['P4'],
  'เลือก "Not Found" ต้องได้เฉพาะคนที่ Team ไม่ใช่ A/B ใน roster');

assert.equal(context.__morningKpis.pickers, 1,
  'จำนวน Picker ใน KPI ต้องนับตามตัวกรองกะ ไม่ใช่จำนวนทั้งหมดใน Sheet');
assert.equal(context.__morningKpis.sheet_pickers, 1,
  'sheet_pickers ต้องนับหลังกรองกะแล้ว');

/* Team มาจาก roster ไม่ใช่คอลัมน์ Shift ใน Sheet — ให้เกณฑ์ตรงกับฝั่ง BigQuery */
vm.runInContext(`
  // P3 roster = B แต่ Sheet บอก mainShift = 'A' → ต้องยึด roster (B)
  CURRENT_SHEET_DATA.pickers.all[2].mainShift = 'A';
  aggregateCache.clear();
  globalThis.__morningAfterSheetLie = aggregate('PTT', '2026-09-01', '2026-09-01', 'morning').by_picker.map(p => p.picker).sort();
`, context);
assert.deepEqual(j(context.__morningAfterSheetLie), ['P1'],
  'ต้องยึด Team จาก roster (picker_roster_teams) ไม่ใช่คอลัมน์ Shift ใน Sheet');

console.log('Shift filter must apply to Google Sheet pickers — tests passed');
