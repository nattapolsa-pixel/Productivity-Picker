// ตรวจว่า 3 หน้าใหม่ (ไม่ถึงเป้า / เทรน / รายบุคคล) และ Target ราย Zone
// เรนเดอร์ได้จริงจากข้อมูล cube และให้ตัวเลขตรงตามเกณฑ์ที่ตกลงกันไว้
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const initMarker = source.search(/\/\/ init\r?\nloadExcludedSkusFromStorage\(\);/);
assert(initMarker > 0, 'Unable to isolate dashboard functions from browser bootstrap');

/* ---------- DOM stub เล็กๆ พอให้ renderer เขียน innerHTML ได้ ---------- */
function makeEl(id) {
  const el = {
    id,
    innerHTML: '',
    textContent: '',
    style: {},
    dataset: {},
    value: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {},
    insertAdjacentElement() {},
    addEventListener() {},
    scrollIntoView() {}
  };
  return el;
}

const elements = new Map();
[
  'belowtargetPage', 'trendPage', 'individualPage', 'targetZoneListHost', 'targetSaveStatus',
  // canvas ปลายทางของกราฟ — ลงทะเบียนไว้เพื่อให้โค้ดวาดกราฟถูกเรียกจริงและจับ error ใน config ได้
  'belowTargetZoneChart', 'trendPeriodChart', 'trendChangeChart', 'individualCompareChart', 'individualTrendChart'
].forEach(id => elements.set(id, makeEl(id)));

const chartsCreated = [];
const context = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  URL,
  Blob,
  AbortController,
  Intl,
  ChartDataLabels: {},
  Chart: class {
    constructor(el, cfg) { chartsCreated.push({ id: el && el.id, cfg }); }
    static defaults = { font: {}, color: '' };
    static register() {}
    static getChart() { return null; }
    destroy() {}
  },
  window: {},
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  document: {
    getElementById(id) { return elements.get(id) || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement(tag) { return makeEl('created-' + tag); },
    head: { appendChild() {} }
  }
});
context.globalThis = context;

vm.runInContext(source.slice(0, initMarker), context, { filename: 'app.js' });

/* ---------- ข้อมูลทดสอบ: 3 picker, 2 โซน, 2 วัน ---------- */
vm.runInContext(`
  excludedSkus = new Set();
  excludedZones = new Set();
  CURRENT_SHEET_DATA = null;
  ZONE_MASTER = {
    AH: { zone: 'AH-AI', typePick: 'Full Rack', owner: 'Punthai' },
    AI: { zone: 'AH-AI', typePick: 'Full Rack', owner: 'Punthai' },
    AN: { zone: 'AN-CA', typePick: 'Half Rack', owner: 'Max Mart' },
    CA: { zone: 'AN-CA', typePick: 'Half Rack', owner: 'Max Mart' }
  };
  DATA = {
    meta: {
      schema_version: DASHBOARD_SCHEMA_VERSION,
      picker_names: { P1: 'พนักงาน หนึ่ง', P2: 'พนักงาน สอง', P3: 'พนักงาน สาม' },
      picker_affiliations: { P1: 'PTG', P2: '40HRS', P3: 'Man Power' },
      picker_roster_teams: { P1: 'A', P2: 'A', P3: 'B' }
    },
    PTT: {
      row_width: 10, item_row_width: 8, slot_row_width: 8,
      dates: ['2026-08-03', '2026-08-10'], pickers: ['P1', 'P2', 'P3'], skus: [],
      rows: [
        // [dateIdx, shiftCode, zone, pickerIdx, pcs, pickQty, lines, minSm, maxSm, hourMask]
        // hourMask 0b1111100 = ชั่วโมง 2-6 → Active 5 ชม.
        0, 0, 'AH', 0, 1200, 1000, 40, 0, 300, 0b1111100,
        0, 0, 'AN', 1, 700, 400, 25, 0, 300, 0b1111100,
        1, 0, 'AH', 0, 1400, 1200, 45, 0, 300, 0b1111100,
        1, 0, 'AN', 2, 500, 300, 20, 0, 300, 0b1111100
      ],
      item_rows: [], slot_rows: []
    },
    BPS: { row_width: 10, item_row_width: 8, slot_row_width: 8, dates: [], pickers: [], skus: [], rows: [], item_rows: [], slot_rows: [] }
  };
  prepShifts();
  computeBounds();
  dfrom = '2026-08-03'; dto = '2026-08-10'; sys = 'PTT'; shiftF = 'all';
  aggregateCache.clear();
  A = aggregate('PTT', dfrom, dto, 'all');
`, context);

/* ---------- 1) Target ราย Zone ต้องชนะ Target ตามประเภท ---------- */
vm.runInContext(`
  globalThis.__zones = listTargetZones();
  globalThis.__typeTargetAH = getTargetForZoneOrType('', 'AH');
  zoneTargets = { 'AH-AI': 111 };
  targetZoneLabelCache = null;
  globalThis.__zoneTargetAH = getTargetForZoneOrType('', 'AH');
  globalThis.__zoneTargetAI = getTargetForZoneOrType('', 'AI');
  globalThis.__zoneTargetLabel = getTargetForZoneOrType('', 'AH-AI');
  globalThis.__untouchedAN = getTargetForZoneOrType('', 'AN');
  zoneTargets = {};
`, context);

// ค่าที่ข้ามมาจาก vm context เป็น Array ของ realm อื่น จึงต้องคัดลอกก่อนเทียบแบบ strict
assert.deepEqual(JSON.parse(JSON.stringify(context.__zones.map(z => z.label).sort())), ['AH-AI', 'AN-CA'],
  'listTargetZones must dedupe locations into Zone_V2 labels');
assert.equal(context.__typeTargetAH, 170, 'Full Rack default target must be 170');
assert.equal(context.__zoneTargetAH, 111, 'A per-zone target must win over the type target');
assert.equal(context.__zoneTargetAI, 111, 'A sibling location must resolve to the same zone target');
assert.equal(context.__zoneTargetLabel, 111, 'The compound zone label itself must resolve');
assert.equal(context.__untouchedAN, 200, 'Zones without an override keep the Half Rack target (200)');

/* ---------- 2) เกณฑ์รายบุคคล ---------- */
// P1: qty 1000+1200 = 2200, Active 5 ชม./วัน → prod รายวัน 200 และ 240 → เฉลี่ย 220 (Full Rack target 170 = ถึงเป้า)
// P2: qty 400, Active 5 → prod 80 (Half Rack target 200 = ไม่ถึงเป้า)
// P3: qty 300, Active 5 → prod 60 (Half Rack target 200 = ไม่ถึงเป้า)
vm.runInContext(`
  globalThis.__info = {};
  A.by_picker.forEach(p => { globalThis.__info[p.picker] = pickerTargetInfo(p); });
`, context);
const info = context.__info;
assert.equal(info.P1.zoneLabel, 'AH-AI', 'P1 dominant zone must map to AH-AI');
assert.equal(info.P1.target, 170);
assert.equal(info.P1.isBelow, false, 'P1 at 220 must clear the 170 Full Rack target');
assert.equal(info.P2.zoneLabel, 'AN-CA');
assert.equal(info.P2.target, 200);
assert.equal(info.P2.isBelow, true, 'P2 at 80 must miss the 200 Half Rack target');
assert.equal(info.P3.isBelow, true, 'P3 at 60 must miss the 200 Half Rack target');

/* ---------- 3) หน้า "ไม่ถึงเป้า" ---------- */
vm.runInContext('renderBelowTargetPage();', context);
const belowHtml = elements.get('belowtargetPage').innerHTML;
assert(belowHtml.includes('Zone AN-CA'), 'Below-target page must group the misses under their zone');
assert(!belowHtml.includes('Zone AH-AI'), 'A zone with no misses must not get a table');
assert(belowHtml.includes('P2') && belowHtml.includes('P3'), 'Both missing pickers must be listed');
assert(!/>P1</.test(belowHtml), 'A picker that hit target must not appear in the miss tables');
assert(belowHtml.includes('openIndividualScorecard'), 'Each row must link into the picker scorecard');
assert(chartsCreated.some(c => c.id === 'belowTargetZoneChart'), 'Below-target zone chart must be drawn');

/* ---------- 4) หน้าเทรน: รายสัปดาห์และรายเดือน ---------- */
vm.runInContext(`
  trendPeriodMode = 'week';
  globalThis.__weeks = buildTrendPeriods('week');
  trendPeriodMode = 'month';
  globalThis.__months = buildTrendPeriods('month');
`, context);
assert.equal(context.__weeks.length, 2, '2026-08-03 and 2026-08-10 are different ISO weeks');
assert.equal(context.__weeks[0].key, '2026-08-03', 'Week buckets must start on Monday');
assert.equal(context.__weeks[1].key, '2026-08-10');
assert.equal(context.__weeks[0].qty, 1400, 'Week 1 volume = 1000 + 400');
assert.equal(context.__weeks[1].qty, 1500, 'Week 2 volume = 1200 + 300');
assert.equal(context.__weeks[0].prodDeltaPct, null, 'The first period has nothing to compare against');
assert.equal(typeof context.__weeks[1].prodDeltaPct, 'number', 'Later periods must expose a WoW % change');
assert.equal(context.__months.length, 1, 'Both dates fall in 2026-08');
assert.equal(context.__months[0].qty, 2900, 'Month volume must sum every day');

vm.runInContext("trendPeriodMode = 'week'; renderTrendPage();", context);
const trendHtml = elements.get('trendPage').innerHTML;
assert(trendHtml.includes('data-tperiod="week"') && trendHtml.includes('data-tperiod="month"'),
  'Trend page must offer both period toggles');
assert(trendHtml.includes('WoW'), 'Weekly mode must label deltas as WoW');
assert(chartsCreated.some(c => c.id === 'trendPeriodChart'), 'Trend volume/productivity chart must be drawn');
assert(chartsCreated.some(c => c.id === 'trendChangeChart'), 'Trend % change chart must be drawn');

vm.runInContext("trendPeriodMode = 'month'; renderTrendPage();", context);
assert(elements.get('trendPage').innerHTML.includes('MoM'), 'Monthly mode must label deltas as MoM');

/* ---------- 5) หน้ารายบุคคล: ตารางเทียบ + Scorecard ---------- */
vm.runInContext('individualPickerId = null; individualSearchTerm = \'\'; renderIndividualPage();', context);
const compareHtml = elements.get('individualPage').innerHTML;
assert(compareHtml.includes('เทียบทุกคน'), 'Default individual view must be the compare table');
['P1', 'P2', 'P3'].forEach(id => assert(compareHtml.includes(id), `${id} must appear in the compare table`));
assert(compareHtml.includes('Scorecard'), 'Each row must offer a scorecard button');
assert(chartsCreated.some(c => c.id === 'individualCompareChart'), 'Compare chart must be drawn');

vm.runInContext("individualSearchTerm = 'P2'; renderIndividualPage();", context);
const filtered = elements.get('individualPage').innerHTML;
assert(filtered.includes('P2') && !/>P1</.test(filtered), 'Search must narrow the compare table');

vm.runInContext("individualSearchTerm = ''; individualPickerId = 'P1'; renderIndividualPage();", context);
const scorecard = elements.get('individualPage').innerHTML;
assert(scorecard.includes('พนักงาน หนึ่ง'), 'Scorecard must show the picker name');
assert(scorecard.includes('AH-AI'), 'Scorecard must show the zones actually worked');
assert(scorecard.includes('2026-08-03') && scorecard.includes('2026-08-10'), 'Scorecard must list every working day');
assert(scorecard.includes('closeIndividualScorecard'), 'Scorecard must offer a way back to the table');
assert(chartsCreated.some(c => c.id === 'individualTrendChart'), 'Scorecard trend chart must be drawn');

vm.runInContext('globalThis.__dailyP1 = individualDailyRows(\'P1\');', context);
const dailyP1 = context.__dailyP1;
assert.equal(dailyP1.length, 2);
assert.equal(dailyP1[0].activeHours, 5, 'Active hours must come from the 24-bit hour mask');
assert.equal(dailyP1[0].prod, 200, '1000 units over 5 active hours = 200');
assert.equal(dailyP1[1].prod, 240, '1200 units over 5 active hours = 240');

/* ---------- 6) Modal Target ราย Zone ---------- */
vm.runInContext('renderTargetZoneInputs();', context);
const modalHtml = elements.get('targetZoneListHost').innerHTML;
assert(modalHtml.includes('Zone AH-AI') && modalHtml.includes('Zone AN-CA'),
  'Target modal must render an input per zone');
assert(modalHtml.includes('Full Rack') && modalHtml.includes('Half Rack'),
  'Target modal must group zones by Type Pick');
assert(modalHtml.includes('data-zone-key="AH-AI"'), 'Each input must carry its normalized zone key');
assert(modalHtml.includes('placeholder="170"') && modalHtml.includes('placeholder="200"'),
  'Empty inputs must hint the type target that will be used instead');

/* ---------- 7) ทุกตารางในหน้าใหม่ต้องมี <th> เท่ากับ <td> ต่อแถว ---------- */
// เรนเดอร์จริงแล้วนับจาก HTML ที่ออกมา จึงครอบคลุมเซลล์ที่สร้างผ่าน ${variable} ด้วย
function assertTableCellsBalanced(html, label) {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map(m => m[0]);
  assert(tables.length > 0, `${label} must render at least one table`);
  tables.forEach((table, ti) => {
    const thead = table.match(/<thead[\s\S]*?<\/thead>/);
    if (!thead) return;
    const thCount = (thead[0].match(/<th[\s>]/g) || []).length;
    const tbody = table.match(/<tbody[\s\S]*?<\/tbody>/);
    if (!tbody) return;
    const bodyRows = [...tbody[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
    bodyRows.forEach((row, ri) => {
      const colspan = row.match(/colspan="(\d+)"/);
      if (colspan) {
        assert.equal(Number(colspan[1]), thCount,
          `${label} table#${ti} placeholder row colspan must equal ${thCount}`);
        return;
      }
      const tdCount = (row.match(/<td[\s>]/g) || []).length;
      assert.equal(tdCount, thCount,
        `${label} table#${ti} row#${ri} has ${tdCount} <td> but the header has ${thCount} <th>`);
    });
  });
}

vm.runInContext('renderBelowTargetPage();', context);
assertTableCellsBalanced(elements.get('belowtargetPage').innerHTML, 'Below-target');

vm.runInContext("trendPeriodMode = 'week'; renderTrendPage();", context);
assertTableCellsBalanced(elements.get('trendPage').innerHTML, 'Trend');

vm.runInContext("individualPickerId = null; individualSearchTerm = ''; renderIndividualPage();", context);
assertTableCellsBalanced(elements.get('individualPage').innerHTML, 'Individual compare');

vm.runInContext("individualPickerId = 'P1'; renderIndividualPage();", context);
assertTableCellsBalanced(elements.get('individualPage').innerHTML, 'Individual scorecard');

// แถว placeholder (ไม่มีข้อมูล) ต้อง colspan ถูกด้วย
vm.runInContext(`
  const keep = A.by_picker;
  A.by_picker = [];
  A.picker_drilldown = {};
  aggregateCache.clear();
  individualPickerId = null;
  renderIndividualPage();
  renderBelowTargetPage();
  A.by_picker = keep;
`, context);
assertTableCellsBalanced(elements.get('individualPage').innerHTML, 'Individual empty');

console.log('New pages (below target / trend / individual) + zone target tests passed');
