const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const initMarker = source.search(/\/\/ init\r?\nloadExcludedSkusFromStorage\(\);/);
assert(initMarker > 0, 'Unable to isolate dashboard functions from browser bootstrap');

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
  excludedSkus = new Set(['*\u0001SKU2']);
  excludedZones = new Set();
  ZONE_MASTER = {
    AA:{location:'AA', zone:'AA', typePick:'Full Rack', owner:'Max Mart', known:true}
  };
  DATA = {
    meta:{schema_version:DASHBOARD_SCHEMA_VERSION, excluded_skus:['SKU2']},
    PTT:{
      row_width:10, item_row_width:8, slot_row_width:8,
      dates:['2026-08-01'], pickers:['P1'], skus:['SKU1','SKU2'],
      rows:[0,0,'AA',0,100,25,4,0,240,1920],
      item_rows:[0,0,'AA','-',0,100,25,4, 0,0,'AA','-',1,50,10,2],
      slot_rows:[0,0,'AA',0,7,40,10,2, 0,0,'AA',0,8,60,15,2]
    },
    BPS:{row_width:10,item_row_width:8,slot_row_width:8,dates:[],pickers:[],skus:[],rows:[],item_rows:[],slot_rows:[]}
  };
  prepShifts();
  globalThis.__cubeResult = aggregate('PTT','2026-08-01','2026-08-01','all');
`, context);

const result = context.__cubeResult;
assert.deepEqual(
  {pcs:result.kpis.pcs, qty:result.kpis.qty, lines:result.kpis.lines, pickers:result.kpis.pickers},
  {pcs:100, qty:25, lines:4, pickers:1}
);
assert.equal(result.kpis.avg_prod, 6);
assert.equal(result.by_item.length, 1);
assert.equal(result.by_item[0].sku, 'SKU1');
assert.equal(result.by_item_all.length, 2);
assert.equal(result.by_item_all.find(x => x.sku === 'SKU2').excluded, true);
assert.deepEqual(JSON.parse(JSON.stringify(result.by_timeslot.map(x => [x.label,x.qty,x.lines]))), [['07:00',10,2],['08:00',15,2]]);
assert.equal(result.by_picker[0].lines, 4);
assert.equal(result.by_zone[0].qty, 25);

vm.runInContext(`
  DATA.PTT.item_rows = [];
  DATA.PTT.skus = [];
  dashboardCacheRevision = 'revision:bucket:scope';
  aggregateCache.clear();
  itemCubePayloadCache.set(itemCubeRequestKey('PTT','2026-08-01','2026-08-01','all'), {
    schema_version:DASHBOARD_SCHEMA_VERSION, system:'PTT', from:'2026-08-01', to:'2026-08-01', shift:'all',
    row_width:9,
    rows:['2026-08-01',0,'AA','AA','-','SKU1',100,25,4, '2026-08-01',0,'AA','AA','-','SKU2',50,10,2]
  });
  globalThis.__lazyItemResult = aggregate('PTT','2026-08-01','2026-08-01','all');
`, context);

const lazyResult = context.__lazyItemResult;
assert.equal(lazyResult.by_item.length, 1);
assert.equal(lazyResult.by_item[0].sku, 'SKU1');
assert.equal(lazyResult.by_item_all.length, 2);
assert.equal(lazyResult.by_item_all.find(x => x.sku === 'SKU2').excluded, true);

vm.runInContext(`
  ITEM_MASTER = {
    'DM02\u0001ZERO1': {key:'DM02\u0001ZERO1',owner:'DM02',sku:'ZERO1',item:'ZERO1',name:'No movement',inMaster:true}
  };
  aggregateCache.clear();
  globalThis.__masterSeeded = aggregate('PTT','2026-08-01','2026-08-01','all');
`, context);
assert.equal(context.__masterSeeded.by_item_all.some(x => x.sku === 'ZERO1' && x.qty === 0 && x.status === 'NO_ACTIVITY'), true);

console.log('Compact cube aggregation tests passed');
