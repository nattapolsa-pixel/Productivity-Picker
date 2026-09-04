const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const initMarker = source.search(/\/\/ init\r?\nloadExcludedSkusFromStorage\(\);/);
assert(initMarker > 0, 'Unable to isolate dashboard functions from browser bootstrap');

const context = vm.createContext({
  console, setTimeout, clearTimeout, URL, Blob, AbortController,
  ChartDataLabels: {},
  Chart: { defaults:{font:{},color:''}, register(){}, getChart(){return null;} },
  window: {},
  localStorage: {getItem(){return null;},setItem(){},removeItem(){}},
  document: {getElementById(){return null;},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(){}}
});
vm.runInContext(source.slice(0, initMarker), context, {filename:'app.js'});

const cases = [
  ['2026-08-08', 419, 'night', '2026-08-07', 719],
  ['2026-08-08', 420, 'morning', '2026-08-08', 0],
  ['2026-08-08', 1139, 'morning', '2026-08-08', 719],
  ['2026-08-08', 1140, 'night', '2026-08-08', 0],
  ['2026-08-08', 1439, 'night', '2026-08-08', 299],
  ['2026-08-09', 0, 'night', '2026-08-08', 300]
];
for (const [date, minute, shift, shiftDate, shiftMinute] of cases) {
  context.__case = context.shiftOf(date, minute);
  assert.deepEqual(JSON.parse(JSON.stringify(context.__case)), {sh:shift, sd:shiftDate, sm:shiftMinute});
}

// Work cube shift code must win over roster Team; roster is planning metadata only.
vm.runInContext(`
  DATA = {
    meta:{picker_shift_teams:{P1:'B'},picker_roster_teams:{P1:'B'}},
    PTT:{row_width:10,dates:['2026-08-08'],pickers:['P1'],rows:[0,0,'AA',0,1,1,1,0,180,128]},
    BPS:{row_width:10,dates:[],pickers:[],rows:[]}
  };
  prepShifts();
  globalThis.__prepared = DATA.PTT._sh[0];
`, context);
assert.equal(context.__prepared.sh, 'morning');
assert.equal(context.__prepared.sd, '2026-08-08');
assert.equal(context.__prepared.team, 'B');

vm.runInContext(`
  DATA.meta.picker_roster_teams = {};
  prepShifts();
  globalThis.__unmapped = DATA.PTT._sh[0];
`, context);
assert.equal(context.__unmapped.team, 'NOT_FOUND');

const backend = fs.readFileSync(path.join(root, 'bigquery_to_json.gs'), 'utf8');
assert(backend.includes('function dashboardShiftDateSql_'));
assert(backend.includes('function dashboardShiftCodeSql_'));
assert(backend.includes('function pickerRosterTeamCodeSql_'));
const dateHelper = backend.slice(backend.indexOf('function dashboardShiftDateSql_'), backend.indexOf('function dashboardShiftCodeSql_'));
assert(dateHelper.includes("String(pickDateExpression || 'pick_date')"));
assert(backend.includes("if (!text || text === '-' || /^sun(day)?$/i.test(text)) return 0;"));
assert(backend.includes('if (dateCount > bestDateCount)'));
assert(backend.includes('rosterPayload.picker_sunday_ot = loadPickerSundayOtCalendar_(forceRoster)'));
assert.equal((backend.match(/pickerRosterShiftCodeSql_\('picker_id', 'tmin'\)/g) || []).length, 0);

const pipeline = fs.readFileSync(path.join(root, 'pick_uom_master_pipeline.sql'), 'utf8');
assert(pipeline.includes("WHEN UPPER(d.category) = 'PTT' THEN DATETIME_SUB(d.pick_ts, INTERVAL 7 HOUR)"));
assert(pipeline.includes("ELSE d.pick_ts"));
assert(pipeline.includes('AS shift_date'));
assert(pipeline.includes('AS shift_code'));

console.log('24-hour shift logic tests passed');
