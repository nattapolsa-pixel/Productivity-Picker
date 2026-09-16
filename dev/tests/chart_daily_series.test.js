// กราฟกางทั้งเดือนได้โดยไม่หุบตามตัวกรองวันที่ (dailySeriesForRange)
// สิ่งสำคัญที่สุด: ตัวเลขต้องตรงกับ aggregate().daily เป๊ะ ไม่งั้นกราฟกับตารางจะไม่ตรงกัน
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
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

/* ---------- ข้อมูล 6 วันคร่อม 2 เดือน 2 picker 2 กะ ---------- */
vm.runInContext(`
  excludedSkus = new Set();
  excludedZones = new Set();
  CURRENT_SHEET_DATA = null;
  ZONE_MASTER = {
    AH: { zone: 'AH-AI', typePick: 'Full Rack', owner: 'Punthai' },
    AN: { zone: 'AN-CA', typePick: 'Half Rack', owner: 'Max Mart' }
  };
  DATA = {
    meta: {
      schema_version: DASHBOARD_SCHEMA_VERSION,
      picker_names: { P1: 'คน หนึ่ง', P2: 'คน สอง' },
      picker_affiliations: { P1: 'PTG', P2: 'PTG' },
      picker_roster_teams: { P1: 'A', P2: 'B' }
    },
    PTT: {
      row_width: 10, item_row_width: 8, slot_row_width: 8,
      dates: ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-08', '2026-09-09', '2026-09-15'],
      pickers: ['P1', 'P2'], skus: [],
      rows: [
        0, 0, 'AH', 0, 1000,  900, 30, 0, 300, 0b1111100,
        1, 0, 'AH', 0, 1100, 1000, 32, 0, 300, 0b1111100,
        2, 0, 'AH', 0, 1200, 1100, 35, 0, 300, 0b1111100,
        2, 1, 'AN', 1,  600,  500, 20, 0, 300, 0b1111100,
        3, 0, 'AH', 0, 1300, 1250, 40, 0, 300, 0b1111100,
        3, 1, 'AN', 1,  700,  650, 22, 0, 300, 0b1111100,
        4, 0, 'AH', 0,  800,  750, 25, 0, 300, 0b1111100,
        5, 1, 'AN', 1,  900,  850, 28, 0, 300, 0b1111100
      ],
      item_rows: [], slot_rows: []
    },
    BPS: { row_width: 10, item_row_width: 8, slot_row_width: 8, dates: [], pickers: [], skus: [], rows: [], item_rows: [], slot_rows: [] }
  };
  prepShifts();
  computeBounds();
  sys = 'PTT'; shiftF = 'all';
  dfrom = '2026-09-08'; dto = '2026-09-08';
`, context);

const j = v => JSON.parse(JSON.stringify(v));

/* ---------- 1) ตัวเลขต้องตรงกับ aggregate().daily ทุกช่วง/ทุกกะ ----------
   aggregate().daily มี field เสริมอีกหลายตัว (weighted breakdown, shift split)
   จึงเทียบเฉพาะ field ที่กราฟใช้จริง ซึ่งเป็นสัญญาที่สำคัญ: เลขกราฟต้องตรงกับตาราง */
const CORE = ['date', 'lines', 'pcs', 'qty', 'pickers', 'hours', 'avg_prod', 'avg_pcs_prod'];
const core = rows => j(rows).map(d => {
  const o = {};
  CORE.forEach(k => { o[k] = d[k]; });
  return o;
});

function assertParity(from, to, sf, label) {
  vm.runInContext(`
    aggregateCache.clear();
    chartDailyCache.clear();
    globalThis.__agg = aggregate('PTT', '${from}', '${to}', '${sf}').daily;
    chartDailyCache.clear();
    globalThis.__series = dailySeriesForRange('PTT', '${from}', '${to}', '${sf}');
  `, context);
  assert.deepEqual(core(context.__series), core(context.__agg),
    `${label}: dailySeriesForRange must match aggregate().daily for ${from}..${to} shift=${sf}`);
}

const ranges = [
  ['2026-09-01', '2026-09-30', 'all'],
  ['2026-09-01', '2026-09-30', 'morning'],
  ['2026-09-01', '2026-09-30', 'night'],
  ['2026-08-01', '2026-08-31', 'all'],
  ['2026-09-08', '2026-09-08', 'all'],
  ['2026-08-30', '2026-09-15', 'all']
];
ranges.forEach(([from, to, sf]) => assertParity(from, to, sf, 'BigQuery only'));

/* ---------- 2) กราฟกางทั้งเดือนได้แม้ตัวกรองเหลือวันเดียว ---------- */
vm.runInContext(`
  aggregateCache.clear(); chartDailyCache.clear();
  globalThis.__tableDaily = aggregate('PTT', dfrom, dto, shiftF).daily.map(d => d.date);
  const mr = chartMonthRange();
  globalThis.__chartRange = mr;
  globalThis.__chartDates = dailySeriesForRange('PTT', mr.from, mr.to, shiftF).map(d => d.date);
`, context);
assert.deepEqual(j(context.__tableDaily), ['2026-09-08'],
  'ตาราง/KPI ต้องเหลือแค่วันที่ที่เลือก');
assert.equal(context.__chartRange.from, '2026-09-01');
assert.equal(context.__chartRange.to, '2026-09-30', 'กันยายนมี 30 วัน');
assert.deepEqual(j(context.__chartDates), ['2026-09-01', '2026-09-08', '2026-09-09', '2026-09-15'],
  'กราฟต้องเห็นทุกวันที่มีข้อมูลในเดือนนั้น ไม่ใช่แค่วันที่เลือก');

/* ---------- 3) เดือนของกราฟตามวันที่เลือก และเลื่อนด้วย ‹ › ได้ ---------- */
vm.runInContext(`
  chartMonth = null;
  globalThis.__autoMonth = activeChartMonth();
  globalThis.__isAuto1 = chartMonthIsAuto();
  globalThis.__months = availableChartMonths();
  globalThis.__movedBack = shiftChartMonth(-1);
  globalThis.__afterBack = activeChartMonth();
  globalThis.__isAuto2 = chartMonthIsAuto();
  globalThis.__backRange = chartMonthRange();
  globalThis.__movedBackAgain = shiftChartMonth(-1);
  resetChartMonth();
  globalThis.__afterReset = activeChartMonth();
`, context);
assert.equal(context.__autoMonth, '2026-09', 'เดือนเริ่มต้นของกราฟ = เดือนของวันที่ที่เลือก');
assert.equal(context.__isAuto1, true);
assert.deepEqual(j(context.__months), ['2026-08', '2026-09'], 'เดือนที่เลือกได้ต้องมาจากช่วงข้อมูลจริง');
assert.equal(context.__movedBack, true, 'กด ‹ ถอยไปสิงหาคมได้');
assert.equal(context.__afterBack, '2026-08');
assert.equal(context.__isAuto2, false, 'พอเลื่อนเองแล้วต้องไม่ใช่โหมด auto (ปุ่มกลับต้องโผล่)');
assert.equal(context.__backRange.to, '2026-08-31', 'สิงหาคมมี 31 วัน');
assert.equal(context.__movedBackAgain, false, 'ถอยเกินช่วงข้อมูลต้องไม่ขยับ');
assert.equal(context.__afterReset, '2026-09', 'กดกลับแล้วต้องกลับไปเดือนของวันที่เลือก');

/* ---------- 4) หน้าเทรนต้องกางทุกงวด ไม่หุบตามตัวกรองวันเดียว ---------- */
vm.runInContext(`
  A = aggregate('PTT', dfrom, dto, shiftF);
  trendPeriodMode = 'month';
  globalThis.__monthPeriods = buildTrendPeriods('month').map(g => ({ key: g.key, qty: g.qty, inFilter: g.inFilter }));
  trendPeriodMode = 'week';
  globalThis.__weekPeriods = buildTrendPeriods('week').map(g => ({ key: g.key, inFilter: g.inFilter }));
`, context);
const monthPeriods = j(context.__monthPeriods);
assert.deepEqual(monthPeriods.map(g => g.key), ['2026-08', '2026-09'],
  'หน้าเทรนต้องเห็นทั้ง 2 เดือน แม้ตัวกรองเหลือวันเดียว');
assert.deepEqual(monthPeriods.map(g => g.inFilter), [false, true],
  'ต้องรู้ว่างวดไหนครอบวันที่เลือกอยู่ (ใช้ไฮไลต์)');
const weekPeriods = j(context.__weekPeriods);
assert(weekPeriods.length >= 4, 'week bucket ต้องมีหลายงวดจากช่วงข้อมูลทั้งหมด');
assert.equal(weekPeriods.filter(g => g.inFilter).length, 1,
  'ต้องมีสัปดาห์เดียวที่ครอบวันที่ 8 ก.ย.');

/* ---------- 5) Zone ที่ถูก exclude ต้องหลุดออกจากกราฟด้วย ---------- */
vm.runInContext(`
  excludedZones = new Set(['AN-CA']);
  chartDailyCache.clear(); aggregateCache.clear();
  globalThis.__exSeries = dailySeriesForRange('PTT', '2026-09-01', '2026-09-30', 'all');
  globalThis.__exAgg = aggregate('PTT', '2026-09-01', '2026-09-30', 'all').daily;
  excludedZones = new Set();
`, context);
assert.deepEqual(core(context.__exSeries), core(context.__exAgg),
  'การ exclude โซนต้องมีผลกับกราฟเหมือนกับตาราง');
assert(core(context.__exSeries).every(d => d.qty > 0),
  'หลัง exclude AN-CA ต้องยังเหลือยอดของโซนอื่น');

/* ---------- 6) เมื่อมีข้อมูล Google Sheet ยอดในกราฟต้องถูก Sheet ทับเหมือนตาราง ---------- */
vm.runInContext(`
  CURRENT_SHEET_DATA = {
    ok: true,
    totalPick: 9999,
    overall: { average: 155, target: 170 },
    pickers: { all: [{ userId: 'P1' }, { userId: 'P2' }] },
    monthlyTrend: {
      days: [
        // ทับวันที่มีอยู่แล้ว
        { date: '2026-09-08', hasData: true, totalPick: 5555, productivity: 222, count: 7 },
        // วันที่ BigQuery ไม่มี แต่ Sheet มี → ต้องถูกเพิ่มเข้ากราฟ
        { date: '2026-09-20', hasData: true, totalPick: 4444, productivity: 188, count: 6 },
        // hasData=false ต้องถูกข้าม
        { date: '2026-09-21', hasData: false, totalPick: 100, productivity: 100, count: 1 }
      ]
    }
  };
  aggregateCache.clear(); chartDailyCache.clear();
  globalThis.__sheetSeries = dailySeriesForRange('PTT', '2026-09-01', '2026-09-30', 'all');
`, context);
const sheetSeries = j(context.__sheetSeries);
const day8 = sheetSeries.find(d => d.date === '2026-09-08');
assert.equal(day8.qty, 5555, 'ยอดหน่วยหยิบต้องถูก Sheet ทับ');
assert.equal(day8.avg_prod, 222, 'Productivity ต้องถูก Sheet ทับ');
assert.equal(day8.pickers, 7, 'จำนวน Picker ต้องถูก Sheet ทับ');
assert(sheetSeries.some(d => d.date === '2026-09-20'), 'วันที่มีแต่ใน Sheet ต้องถูกเพิ่มเข้ากราฟ');
assert(!sheetSeries.some(d => d.date === '2026-09-21'), 'วันที่ hasData=false ต้องไม่เข้ากราฟ');
assert.deepEqual(sheetSeries.map(d => d.date), [...sheetSeries.map(d => d.date)].sort(),
  'ต้องเรียงวันที่จากน้อยไปมากหลังผสม Sheet');

// พาริตี้กับ aggregate().daily ต้องยังคงอยู่ตอนมี Sheet ด้วย
assertParity('2026-09-01', '2026-09-30', 'all', 'with Google Sheet');
assertParity('2026-09-01', '2026-09-30', 'night', 'with Google Sheet');

console.log('Chart daily series (month-wide charts + filtered tables) — tests passed');
