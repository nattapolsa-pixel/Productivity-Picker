// หลังถอดหน่วย "ชิ้น" ออกจาก UI ทุกตารางต้องมี <th> เท่ากับ <td> ต่อแถว
// และแถว placeholder ต้องมี colspan ตรงกับจำนวนคอลัมน์
// เรนเดอร์ renderer จริงด้วย DOM stub แบบ catch-all แล้วนับจาก HTML ที่ออกมา
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const initMarker = source.search(/\/\/ init\r?\nloadExcludedSkusFromStorage\(\);/);
assert(initMarker > 0, 'Unable to isolate dashboard functions from browser bootstrap');

/* ---------- DOM stub: getElementById คืน element ให้ทุก id ---------- */
const elements = new Map();
function makeEl(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, hidden: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {}, insertAdjacentElement() {}, insertBefore() {},
    addEventListener() {}, removeAttribute() {}, setAttribute() {}, scrollIntoView() {},
    closest() { return null; }, getAttribute() { return null; },
    parentNode: null, nextSibling: null
  };
}
function getEl(id) {
  if (!elements.has(id)) elements.set(id, makeEl(id));
  return elements.get(id);
}

const context = vm.createContext({
  console: { log() {}, warn() {}, error() {}, info() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  URL, Blob, AbortController, Intl,
  ChartDataLabels: {},
  Chart: class {
    constructor() {}
    static defaults = { font: {}, color: '' };
    static register() {}
    static getChart() { return null; }
    destroy() {}
  },
  window: {},
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  document: {
    getElementById: getEl,
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement(tag) { return makeEl('created-' + tag); },
    head: { appendChild() {} },
    body: { appendChild() {} },
    visibilityState: 'visible'
  }
});
context.globalThis = context;
vm.runInContext(source.slice(0, initMarker), context, { filename: 'app.js' });

/* ---------- ข้อมูลทดสอบครอบ 2 ระบบ 2 โซน 2 owner 2 SKU ---------- */
vm.runInContext(`
  excludedSkus = new Set();
  excludedZones = new Set();
  CURRENT_SHEET_DATA = null;
  ZONE_MASTER = {
    AH: { zone: 'AH-AI', typePick: 'Full Rack', owner: 'Punthai' },
    AN: { zone: 'AN-CA', typePick: 'Half Rack', owner: 'Max Mart' }
  };
  ITEM_MASTER = {
    'DM02\\u0001SKU1': { key: 'DM02\\u0001SKU1', owner: 'DM02', sku: 'SKU1', item: 'SKU1', name: 'สินค้า 1', inMaster: true },
    'DP02\\u0001SKU2': { key: 'DP02\\u0001SKU2', owner: 'DP02', sku: 'SKU2', item: 'SKU2', name: 'สินค้า 2', inMaster: true }
  };
  ITEM_MASTER_BY_SKU = {};
  DATA = {
    meta: {
      schema_version: DASHBOARD_SCHEMA_VERSION,
      picker_names: { P1: 'พนักงาน หนึ่ง', P2: 'พนักงาน สอง' },
      picker_affiliations: { P1: 'PTG', P2: '40HRS' },
      picker_roster_teams: { P1: 'A', P2: 'B' },
      picker_roster_zones: { P1: 'AH', P2: 'AN' },
      picker_responsibilities: { P1: 'PICKER', P2: 'PICKER' }
    },
    PTT: {
      row_width: 10, item_row_width: 8, slot_row_width: 8,
      dates: ['2026-08-03', '2026-08-04'], pickers: ['P1', 'P2'], skus: ['SKU1', 'SKU2'],
      rows: [
        0, 0, 'AH', 0, 1200, 1000, 40, 0, 300, 0b1111100,
        0, 1, 'AN', 1, 700, 400, 25, 0, 300, 0b1111100,
        1, 0, 'AH', 0, 900, 800, 30, 0, 300, 0b1111100
      ],
      item_rows: [
        0, 0, 'AH', 'DM02', 0, 1200, 1000, 40,
        0, 1, 'AN', 'DP02', 1, 700, 400, 25
      ],
      slot_rows: [
        0, 0, 'AH', 0, 7, 600, 500, 20,
        0, 0, 'AH', 0, 8, 600, 500, 20,
        0, 1, 'AN', 1, 20, 700, 400, 25
      ]
    },
    BPS: { row_width: 10, item_row_width: 8, slot_row_width: 8, dates: [], pickers: [], skus: [], rows: [], item_rows: [], slot_rows: [] }
  };
  prepShifts();
  computeBounds();
  dfrom = '2026-08-03'; dto = '2026-08-04'; sys = 'PTT'; shiftF = 'all';
  aggregateCache.clear();
  A = aggregate('PTT', dfrom, dto, 'all');
`, context);

/* ---------- ตัวตรวจ ---------- */
const problems = [];
function checkHtml(html, label) {
  const src = String(html || '');
  // renderer บางตัวเขียน innerHTML ของ <table> ที่มีอยู่แล้ว จึงไม่มีแท็ก <table> ใน HTML ที่ออกมา
  let tables = [...src.matchAll(/<table[\s\S]*?<\/table>/g)].map(m => m[0]);
  if (!tables.length && /<thead[\s>]/.test(src)) tables = [src];
  tables.forEach((table, ti) => {
    const thead = table.match(/<thead[\s\S]*?<\/thead>/);
    const tbody = table.match(/<tbody[\s\S]*?<\/tbody>/);
    if (!thead || !tbody) return;
    const thCount = (thead[0].match(/<th[\s>]/g) || []).length;
    if (!thCount) return;
    // ตารางที่ใช้ rowspan จับกลุ่ม (แถวถัดไปมี td น้อยกว่า th อย่างถูกต้อง) นับตรงๆ ไม่ได้ จึงข้ามทั้งตาราง
    // (ไม่มีตารางไหนใช้ rowspan อยู่แล้วตอนนี้ — เผื่อไว้สำหรับตารางใหม่ในอนาคต)
    if (/rowspan=/.test(tbody[0])) return;
    [...tbody[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].forEach((m, ri) => {
      const row = m[1];
      const colspan = row.match(/colspan="(\d+)"/);
      if (colspan) {
        if (Number(colspan[1]) !== thCount) {
          problems.push(`${label} table#${ti}: colspan=${colspan[1]} but th=${thCount}`);
        }
        return;
      }
      const tdCount = (row.match(/<td[\s>]/g) || []).length;
      if (tdCount !== thCount) {
        problems.push(`${label} table#${ti} row#${ri}: td=${tdCount} but th=${thCount}`);
      }
    });
  });
  return tables.length;
}

/* ---------- เรียก renderer ที่แก้ไปทั้งหมด ---------- */
const renderers = [
  'renderZoneProductivityBreakdown',
  'renderAffiliationBreakdown',
  'renderEfficiencyPage',
  'renderCycleTimePage',
  'renderIncentivePage',
  'renderTopPickersView',
  'renderTargetDailyTable',
  'renderSheetAnalysisView',
  'renderBelowTargetPage',
  'renderTrendPage',
  'renderIndividualPage',
  // ตาราง Picker / Items / Zone อยู่ใน builders ไม่ใช่ฟังก์ชันแยก
  'builders.pickers',
  'builders.items',
  'builders.zones',
  'builders.typebreak',
  'builders.overview'
];

let renderedTables = 0;
renderers.forEach(fn => {
  elements.forEach(el => { el.innerHTML = ''; });
  try {
    vm.runInContext(`if (typeof (${fn}) === 'function') (${fn})();`, context);
  } catch (err) {
    problems.push(`${fn} threw: ${err && err.message}`);
    return;
  }
  elements.forEach((el, id) => {
    if (el.innerHTML) renderedTables += checkHtml(el.innerHTML, `${fn}#${id}`);
  });
});

assert(renderedTables > 0, 'No table was rendered — the harness is not exercising the renderers');
assert.deepEqual(problems, [], 'Table column mismatches:\n  ' + problems.join('\n  '));

/* ---------- ห้ามมีคอลัมน์ "ชิ้น" กลับมาในหัวตาราง ---------- */
const pcsHeader = /<th[^>]*>[^<]*ชิ้น/;
elements.forEach(el => { el.innerHTML = ''; });
renderers.forEach(fn => {
  vm.runInContext(`if (typeof ${fn} === 'function') ${fn}();`, context);
});
elements.forEach((el, id) => {
  if (el.innerHTML && pcsHeader.test(el.innerHTML)) {
    problems.push(`${id} still renders a "ชิ้น" column header`);
  }
});
assert.deepEqual(problems, [], 'Pcs columns must stay removed:\n  ' + problems.join('\n  '));

console.log(`Table column contract passed (${renderedTables} tables checked across ${renderers.length} renderers)`);
