/* Pick Productivity Dashboard — ดึงข้อมูลสดจาก BigQuery (ผ่าน Apps Script Web App)
   Productivity คิดจากช่วงหยิบแรก–สุดท้ายที่ทับกับเวลาทำงานจริง โดยหักพักตามกะ และนับ OT เฉพาะช่วง OT
   กะ A / กะ B ใช้ Team จาก Sheet บันทึกเวลาทำงาน; ถ้า Team ไม่ใช่ A/B ใช้เวลาจริงเป็น fallback
   แยก 2 ระบบ PTT / BPS · ทุก KPI/กราฟคำนวณสดตามช่วงวันที่ + กะ ที่เลือก */

// ====== ตั้งค่า: วาง URL ของ Apps Script Web App (ลงท้าย /exec) ตรงนี้ ======
const DATA_URL = 'https://script.google.com/macros/s/AKfycbyM0IVjD6Eo867rWbR_WjLlJJPSXLCqCqEpPZkfFGnlkqVOr8yY-LR7f6Bl4HRwzBy0/exec';
// v7 sends only the compact work cube first, then lazy-loads item/time detail in daily chunks.
// its pick_qty may have the retired Pack Size semantics or row-level format.
const DASHBOARD_SCHEMA_VERSION = 'pick-units-v11-workforce-planner';
const PICKER_NAME_FALLBACK = (typeof window !== 'undefined' && window.PICKER_NAME_FALLBACK) ? window.PICKER_NAME_FALLBACK : {};
const PICKER_AFFILIATION_FALLBACK = (typeof window !== 'undefined' && window.PICKER_AFFILIATION_FALLBACK) ? window.PICKER_AFFILIATION_FALLBACK : {};
const ZONE_MASTER_FALLBACK = (typeof window !== 'undefined' && window.ZONE_MASTER_FALLBACK) ? window.ZONE_MASTER_FALLBACK : {};
const ZONE_LAYOUT_CONFIG = (typeof window !== 'undefined' && window.ZONE_LAYOUT) ? window.ZONE_LAYOUT : {};
// ==========================================================================

// ====== ตั้งค่ากะ / เวลาพัก / OT ======
// กะ A: 07:00–10:30 ทำงาน, 10:30–12:00 พัก, 12:00–16:00 ทำงาน,
//       16:00–16:30 พักก่อน OT, 16:30–19:00 OT
// กะ B: 19:00–22:50 ทำงาน, 22:50–00:00 พัก, 00:00–04:00 ทำงาน,
//       04:00–04:30 พักก่อน OT, 04:30–07:00 OT
const SHIFT_A_REGULAR_HOURS = 7.5;
const SHIFT_B_REGULAR_HOURS = 470 / 60; // 7 ชม. 50 นาที
const OT_MAX = 2.5;
const MIN_PRODUCTIVE_HOURS = 3;
const SHIFT_WORK_INTERVALS = Object.freeze({
  morning: Object.freeze([[0,210],[300,540],[570,720]]), // A: ทำงานปกติ + OT (ไม่นับช่วงพัก)
  night:   Object.freeze([[0,230],[300,540],[570,720]])  // B: ทำงานปกติ + OT (ไม่นับช่วงพัก)
});
// ====================================

const fmt = n => Number(n).toLocaleString('en-US');
const PALETTE = ['#6366f1','#14b8a6','#f59e0b','#f43f5e','#0ea5e9','#8b5cf6','#10b981','#ec4899','#f97316','#22c55e','#3b82f6','#eab308'];
const ZONE_OWNER_COLORS = Object.freeze({
  'max mart':'#0f766e',
  'punthai':'#2563eb',
  'gfa':'#ea580c',
  'lube':'#be123c',
  '-':'#64748b'
});
const ZONE_TYPE_COLORS = Object.freeze({
  'full rack':'#7c3aed',
  'half rack':'#0891b2',
  'mezzanine':'#c026d3',
  'micro rack':'#16a34a',
  'pick to sort':'#d97706',
  'on floor':'#475569',
  '-':'#94a3b8'
});
const TITLES = {overview:'ภาพรวม',prod:'Productivity',zones:'โซน & ผังคลัง',typebreak:'Activity by Type Pick',pickers:'พนักงาน (Picker)',time:'ช่วงเวลา',items:'สินค้า (Items)',report:'📊 สรุปผล & Insights',simulator:'วางแผนกำลังคน & OT'};
const SHIFT_LABEL = {morning:'🅰️ กะ A', night:'🅱️ กะ B', '-':'-'};

Chart.register(ChartDataLabels);
Chart.defaults.font.family = "'Prompt',sans-serif";
Chart.defaults.color = '#64748b';

// ===== state =====
const emptyData = () => ({
  meta:{schema_version:DASHBOARD_SCHEMA_VERSION},
  PTT:{row_width:9,item_row_width:8,slot_row_width:8,dates:[],pickers:[],skus:[],rows:[],item_rows:[],slot_rows:[]},
  BPS:{row_width:9,item_row_width:8,slot_row_width:8,dates:[],pickers:[],skus:[],rows:[],item_rows:[],slot_rows:[]}
});
let DATA = emptyData();
let ALL_DATES = [], DMIN = '', DMAX = '';
let sys = 'PTT', currentPage = 'overview', dfrom = '', dto = '', shiftF = 'all', built = {}, A = null;
let unitMode = 'units'; // เปิดหน้าเริ่มต้นเป็นหน่วยหยิบ (UOM ที่ BigQuery คำนวณแล้ว)
let trendMode = 'day';
let datePresetMode = 'all';
let excludedSkus = new Set();
let excludedSkusSavedAt = null;
let itemSearchTerm = '';
let zoneBreakdownMode = 'owner';
let hasLiveData = false;
let activeLoadPromise = null;
let activeLoadIsFresh = false;
let queuedFreshPromise = null;
let ZONE_MASTER = {...ZONE_MASTER_FALLBACK};
let aggregateCache = new Map();
let excludedSkuRevision = 0;
let dashboardCacheRevision = '';
let activeZoneDetailCode = '';
const DASHBOARD_TIMEOUT_MS = 180000;
const EXCLUDED_SKUS_STORAGE_KEY = 'pick_dashboard_excluded_items_v2';
const LEGACY_EXCLUDED_SKUS_STORAGE_KEY = 'pick_dashboard_excluded_skus_v1';
const DASHBOARD_CACHE_DB = 'pick_dashboard_cache_v1';
const DASHBOARD_CACHE_STORE = 'responses';
// แยก cache ออกจากข้อมูลรุ่นที่เคยคำนวณ Pack Size ใน browser เพื่อไม่ให้ใช้ยอดเก่า
const DASHBOARD_CACHE_KEY = DASHBOARD_SCHEMA_VERSION + ':bq-pick-qty:latest';
const DASHBOARD_CUBE_CACHE_PREFIX = DASHBOARD_SCHEMA_VERSION + ':cube:';
// แสดงข้อมูลที่เคยโหลดสำเร็จก่อนทันที แล้วตรวจ revision เบื้องหลัง
// เก็บได้นานขึ้นเพื่อไม่ให้ผู้ใช้เจอหน้าว่างเพียงเพราะไม่ได้เปิดเว็บเกิน 1 วัน
const DASHBOARD_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PLANNER_ROSTER_AUTO_REFRESH_MS = 5 * 60 * 1000;
let plannerRosterLastCheckedAt = 0;
let plannerRosterRefreshPromise = null;
let plannerRosterAutoTimer = null;

function normalizeSkuKey(sku){
  const value = String(sku ?? '').replace(/\u00a0/g, ' ').trim();
  return /^\d+\.0+$/.test(value) ? value.slice(0, value.indexOf('.')) : value;
}

function normalizeOwnerKey(owner){
  return String(owner ?? '-').replace(/\u00a0/g, ' ').trim().toUpperCase() || '-';
}

const ITEM_KEY_SEPARATOR = '\u0001';
let ITEM_MASTER = Object.create(null);
let ITEM_MASTER_BY_SKU = Object.create(null);

function itemCompositeKey(owner, sku){
  return normalizeOwnerKey(owner) + ITEM_KEY_SEPARATOR + normalizeSkuKey(sku);
}

function parseItemCompositeKey(key){
  const raw = String(key || '');
  const pos = raw.indexOf(ITEM_KEY_SEPARATOR);
  return pos >= 0
    ? {owner:raw.slice(0, pos) || '-', item:raw.slice(pos + 1)}
    : {owner:'*', item:normalizeSkuKey(raw)};
}

function skuKeyVariants(sku){
  const key = normalizeSkuKey(sku);
  if(!key) return [];
  const keys = new Set([key]);
  if(/^\d+$/.test(key)) keys.add(key.replace(/^0+(?=\d)/, ''));
  if(/^\d+(?:\.\d+)?e[+-]?\d+$/i.test(key)){
    const numeric = Number(key);
    if(Number.isSafeInteger(numeric)) keys.add(String(numeric));
  }
  return [...keys];
}

function itemKeyVariants(owner, sku){
  const ownerKey = normalizeOwnerKey(owner);
  const keys = [];
  skuKeyVariants(sku).forEach(item => {
    keys.push(itemCompositeKey(ownerKey, item));
    keys.push(itemCompositeKey('*', item)); // รองรับรายการยกเว้นรุ่นเก่าที่ไม่มี Owner
  });
  return [...new Set(keys)];
}

function isSkuExcluded(sku, owner='*'){
  if(excludedSkus.size === 0) return false;
  return itemKeyVariants(owner, sku).some(key => excludedSkus.has(key));
}

function currentExcludedItemList(){
  return [...excludedSkus].map(parseItemCompositeKey)
    .filter(x => x.owner && x.item)
    .map(x => ({owner:normalizeOwnerKey(x.owner), item:normalizeSkuKey(x.item)}))
    .sort((a,b) => a.owner.localeCompare(b.owner) || a.item.localeCompare(b.item));
}

function currentExcludedSkuList(){
  // คงชื่อเดิมสำหรับ cache key ภายใน แต่ค่าจริงเป็น Owner + Item
  return currentExcludedItemList();
}

function dashboardScopeQuery(){
  return 'excluded_items=' + encodeURIComponent(JSON.stringify(currentExcludedItemList()));
}

function getItemInfo(owner, sku) {
  const ownerKey = normalizeOwnerKey(owner);
  const item = normalizeSkuKey(sku);
  if (!item) return { key:'', sku:'', item:'', name:'-', owner:ownerKey, inMaster:false, matchStatus:'NOT_IN_MASTER' };
  let master = null;
  for(const variant of skuKeyVariants(item)){
    master = ITEM_MASTER[itemCompositeKey(ownerKey, variant)];
    if(master) break;
  }
  // กรณีข้อมูลกิจกรรมไม่มี Owner ที่เชื่อถือได้ ให้ใช้ชื่อได้เมื่อ SKU นี้มีใน Master เพียง Owner เดียว
  if(!master){
    for(const variant of skuKeyVariants(item)){
      const candidates = ITEM_MASTER_BY_SKU[variant] || [];
      if(candidates.length === 1){ master = candidates[0]; break; }
    }
  }
  return master ? {...master} : {
    key:itemCompositeKey(ownerKey, item), sku:item, item, name:item,
    owner:ownerKey, pickType:'', itemPack:'', pickPackSize:null, casePackSize:null,
    uomDivisor:null, matchStatus:'NOT_IN_MASTER', inMaster:false
  };
}

function formatThaiDateTime(value){
  if(!value) return '';
  const dt = new Date(value);
  if(Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleString('th-TH', {dateStyle:'short', timeStyle:'short'});
}

function loadExcludedSkusFromStorage(){
  try{
    let raw = localStorage.getItem(EXCLUDED_SKUS_STORAGE_KEY);
    let parsed = raw ? JSON.parse(raw) : null;
    let keys = [];
    if(parsed && Array.isArray(parsed.items)){
      keys = parsed.items.map(x => itemCompositeKey(x.owner, x.item == null ? x.sku : x.item));
    }else if(Array.isArray(parsed)){
      keys = parsed.map(x => itemCompositeKey('*', x));
    }else{
      const legacyRaw = localStorage.getItem(LEGACY_EXCLUDED_SKUS_STORAGE_KEY);
      const legacy = legacyRaw ? JSON.parse(legacyRaw) : null;
      const list = Array.isArray(legacy) ? legacy : (legacy && Array.isArray(legacy.skus) ? legacy.skus : []);
      keys = list.map(x => itemCompositeKey('*', x));
    }
    excludedSkus = new Set(keys.filter(Boolean));
    excludedSkusSavedAt = parsed && parsed.updatedAt ? parsed.updatedAt : null;
  }catch(_){
    excludedSkus = new Set();
    excludedSkusSavedAt = null;
  }
}

function saveExcludedSkusToStorage(){
  try{
    const payload = {
      version: 2,
      updatedAt: new Date().toISOString(),
      items: currentExcludedItemList()
    };
    localStorage.setItem(EXCLUDED_SKUS_STORAGE_KEY, JSON.stringify(payload));
    excludedSkusSavedAt = payload.updatedAt;
  }catch(_){}
}

// ===== Productivity Target State & Functions =====
const DEFAULT_PROD_TARGETS = {
  overall: 170,
  fullRack: 170,
  halfRack: 200,
  microRack: 170,
  pickToSort: 170,
  mezzanine: 170,
  training: 100
};

let prodTargets = { ...DEFAULT_PROD_TARGETS };
let prodTarget = prodTargets.overall;
const PROD_TARGETS_STORAGE_KEY = 'pick_dashboard_prod_targets_v2';
const PROD_TARGET_STORAGE_KEY = 'pick_dashboard_prod_target_v1';

function loadProdTargetFromStorage(){
  try {
    const savedV2 = localStorage.getItem(PROD_TARGETS_STORAGE_KEY);
    if (savedV2 !== null) {
      const parsed = JSON.parse(savedV2);
      prodTargets = { ...DEFAULT_PROD_TARGETS, ...parsed };
      prodTarget = prodTargets.overall;
      return;
    }
    const savedV1 = localStorage.getItem(PROD_TARGET_STORAGE_KEY);
    if (savedV1 !== null) {
      const val = Number(savedV1);
      if (Number.isFinite(val) && val > 0) {
        prodTargets.overall = val;
        prodTarget = val;
      }
    }
  } catch(e){}
}

function saveProdTargetsToStorage(targets){
  try {
    prodTargets = { ...DEFAULT_PROD_TARGETS, ...targets };
    prodTarget = prodTargets.overall;
    localStorage.setItem(PROD_TARGETS_STORAGE_KEY, JSON.stringify(prodTargets));
    localStorage.setItem(PROD_TARGET_STORAGE_KEY, String(prodTarget));
  } catch(e){}
}

function saveProdTargetToStorage(val){
  saveProdTargetsToStorage({ ...prodTargets, overall: val });
}

function getTargetForZoneOrType(typePick, zone) {
  const tStr = String(typePick || zone || '').toLowerCase();
  if (tStr.includes('full rack') || tStr.includes('fullrack')) return prodTargets.fullRack;
  if (tStr.includes('half rack') || tStr.includes('halfrack')) return prodTargets.halfRack;
  if (tStr.includes('micro rack') || tStr.includes('microrack')) return prodTargets.microRack;
  if (tStr.includes('pick to sort') || tStr.includes('pick-to-sort') || tStr.includes('bps')) return prodTargets.pickToSort;
  if (tStr.includes('mezzanine') || tStr.includes('mezz')) return prodTargets.mezzanine;
  if (tStr.includes('training') || tStr.includes('train')) return prodTargets.training;
  return prodTargets.overall || prodTarget;
}

// ===== Excluded Zones State & Functions =====
let excludedZones = new Set();
let excludedZonesSavedAt = null;
const EXCLUDED_ZONES_STORAGE_KEY = 'pick_dashboard_excluded_zones_v1';

function isZoneExcluded(zoneCode){
  if(excludedZones.size === 0) return false;
  const z = String(zoneCode || '').trim().toUpperCase();
  if(!z || z === '-') return false;
  return excludedZones.has(z);
}

function loadExcludedZonesFromStorage(){
  try{
    const raw = localStorage.getItem(EXCLUDED_ZONES_STORAGE_KEY);
    if(!raw){
      excludedZones = new Set();
      excludedZonesSavedAt = null;
      return;
    }
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.zones) ? parsed.zones : []);
    excludedZones = new Set(list.map(z => String(z).trim().toUpperCase()).filter(Boolean));
    excludedZonesSavedAt = parsed && parsed.updatedAt ? parsed.updatedAt : null;
  }catch(_){
    excludedZones = new Set();
    excludedZonesSavedAt = null;
  }
}

function saveExcludedZonesToStorage(){
  try{
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      zones: [...excludedZones].map(z => String(z).trim().toUpperCase()).filter(Boolean).sort()
    };
    localStorage.setItem(EXCLUDED_ZONES_STORAGE_KEY, JSON.stringify(payload));
    excludedZonesSavedAt = payload.updatedAt;
  }catch(_){}
}

function toggleZoneExclusion(zoneCode){
  const z = String(zoneCode || '').trim().toUpperCase();
  if(!z) return;
  if(excludedZones.has(z)){
    excludedZones.delete(z);
  }else{
    excludedZones.add(z);
  }
  saveExcludedZonesToStorage();
  invalidateAggregationCache();
  updateExcludedZonesBar();
  render();
}

function clearExcludedZones(){
  excludedZones.clear();
  saveExcludedZonesToStorage();
  invalidateAggregationCache();
  updateExcludedZonesBar();
  render();
}

function updateExcludedZonesBar(){
  const bar = document.getElementById('excludedZonesBar');
  const countBadge = document.getElementById('excludedZonesCountBadge');
  const savedAtBadge = document.getElementById('excludedZonesSavedAt');
  const badgesContainer = document.getElementById('excludedZonesBadges');

  if(!bar) return;

  if(excludedZones.size === 0){
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'block';
  if(countBadge) countBadge.textContent = excludedZones.size.toLocaleString();
  if(savedAtBadge){
    savedAtBadge.textContent = excludedZonesSavedAt
      ? `บันทึกล่าสุด: ${formatThaiDateTime(excludedZonesSavedAt)}`
      : '';
  }

  if(badgesContainer){
    let badgesHtml = '';
    excludedZones.forEach(zCode => {
      badgesHtml += `
        <span style="display:inline-flex; align-items:center; gap:6px; background:#ffffff; border:1px solid #bbf7d0; color:#15803d; padding:4px 10px; border-radius:8px; font-size:12px; font-weight:600; box-shadow:0 2px 4px rgba(0,0,0,0.02);">
          <span>📍 Zone ${escapeZoneHtml(zCode)}</span>
          <button onclick="toggleZoneExclusion('${escapeZoneHtml(zCode)}')" style="border:0; background:none; color:#dc2626; cursor:pointer; font-weight:700; padding:0 2px;">✕</button>
        </span>`;
    });
    badgesContainer.innerHTML = badgesHtml;
  }
}

function invalidateAggregationCache(){
  excludedSkuRevision++;
  aggregateCache.clear();
}

// ===== shift helpers =====
// tmin = นาทีของวัน (เวลา local) · แปลงเป็น กะ + วันของกะ + นาทีนับจากต้นกะ
function addDays(ds, n){                     // เลื่อนวันที่แบบสตริง (ไม่ใช้ Date เพื่อความเร็ว)
  let [y,m,d] = ds.split('-').map(Number); d += n;
  const dim = mm => [31,((y%4===0&&y%100!==0)||y%400===0)?29:28,31,30,31,30,31,31,30,31,30,31][mm-1];
  while(d < 1){ m--; if(m<1){ m=12; y--; } d += dim(m); }
  while(d > dim(m)){ d -= dim(m); m++; if(m>12){ m=1; y++; } }
  return y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
}
function clampDate(ds){
  if(!ds) return ds;
  if(DMIN && ds < DMIN) return DMIN;
  if(DMAX && ds > DMAX) return DMAX;
  return ds;
}
function weekStart(ds){
  const dt = new Date(ds + 'T00:00:00');
  const day = (dt.getDay() + 6) % 7; // Monday = 0
  return addDays(ds, -day);
}
function monthEnd(ds){
  let last = ds.slice(0, 7) + '-28';
  while(addDays(last, 1).slice(0, 7) === ds.slice(0, 7)) last = addDays(last, 1);
  return last;
}
function rangeForPeriod(mode, baseDate){
  const base = clampDate(baseDate || dto || DMAX);
  if(!base) return {from:dfrom, to:dto};
  if(mode === 'week'){
    const start = weekStart(base);
    return {from:clampDate(start), to:clampDate(addDays(start, 6))};
  }
  if(mode === 'month'){
    return {from:clampDate(base.slice(0, 7) + '-01'), to:clampDate(monthEnd(base))};
  }
  return {from:base, to:base};
}
function shiftOf(ds, t){
  if(t >= 420 && t < 1140) return {sh:'morning', sd:ds,            sm:t-420};   // fallback กะ A: 07:00–18:59
  if(t >= 1140)            return {sh:'night',   sd:ds,            sm:t-1140};  // fallback กะ B: 19:00–23:59
  return                          {sh:'night',   sd:addDays(ds,-1), sm:t+300};  // fallback กะ B: 00:00–06:59 ของวันกะก่อน
}
// OT = จำนวนบล็อก 30 นาทีที่ทำครบ นับจากนาทีที่ 570 (16:30/04:30) ต้นกะ, สูงสุด OT_MAX
function otHours(maxSm){
  const mx = Math.min(720, Number(maxSm));
  if(!Number.isFinite(mx) || mx <= 570) return 0;
  return Math.min(OT_MAX, Math.floor((mx - 570)/30) * 0.5);
}
function shiftRegularHours(sh){
  return sh === 'night' ? SHIFT_B_REGULAR_HOURS : SHIFT_A_REGULAR_HOURS;
}
function shiftWorkHoursBetween(sh, minSm, maxSm){
  const mn = Math.max(0, Number(minSm));
  const mx = Math.min(720, Number(maxSm));
  if(!Number.isFinite(mn) || !Number.isFinite(mx) || mx <= mn) return 0;
  const intervals = SHIFT_WORK_INTERVALS[sh === 'night' ? 'night' : 'morning'];
  let minutes = 0;
  intervals.forEach(([start,end]) => {
    minutes += Math.max(0, Math.min(mx,end) - Math.max(mn,start));
  });
  return Math.round((minutes / 60) * 100) / 100;
}

// payload รุ่นเร็วเป็น cube แยกตามงาน: Work / Item / Time slot
function packedRowCount(S){
  const width = Number(S && S.row_width) || 0;
  return S && Array.isArray(S.rows) ? (width ? Math.floor(S.rows.length / width) : S.rows.length) : 0;
}
// ช่องที่ 6 ของ payload คือ pick_qty ที่ BigQuery คำนวณและตรวจสอบแล้ว
// ห้าม fallback เป็นจำนวนชิ้น เพราะจะทำให้ SKU ที่ยังไม่มี master ถูกนับผิดโดยไม่รู้ตัว
function readBigQueryPickQty(value){
  const qty = Number(value);
  return Number.isFinite(qty) ? qty : 0;
}

function packedRowData(S, i){
  if (Number(S && S.row_width) !== 9) {
    throw new Error('Dashboard payload schema ไม่ตรงกับหน้าเว็บ');
  }
  const offset = i * 9;
  return {
    dateIdx: S.rows[offset],
    shiftCode: Number(S.rows[offset+1]) || 0,
    zone: S.rows[offset+2],
    pickerIdx: S.rows[offset+3],
    pcs: Number(S.rows[offset+4]) || 0,
    pickQty: readBigQueryPickQty(S.rows[offset+5]),
    lines: Number(S.rows[offset+6]) || 0,
    minSm: Number(S.rows[offset+7]) || 0,
    maxSm: Number(S.rows[offset+8]) || 0
  };
}

function packedItemRowCount(S){
  const width = Number(S && S.item_row_width) || 0;
  return S && Array.isArray(S.item_rows) && width ? Math.floor(S.item_rows.length / width) : 0;
}
function packedItemRowData(S, i){
  if(Number(S && S.item_row_width) !== 8) throw new Error('Dashboard item cube ไม่ตรงกับหน้าเว็บ');
  const o = i * 8;
  return {
    dateIdx:S.item_rows[o], shiftCode:Number(S.item_rows[o+1])||0,
    zone:S.item_rows[o+2], owner:S.item_rows[o+3], skuIdx:S.item_rows[o+4],
    pcs:Number(S.item_rows[o+5])||0, pickQty:readBigQueryPickQty(S.item_rows[o+6]),
    lines:Number(S.item_rows[o+7])||0
  };
}
function packedSlotRowCount(S){
  const width = Number(S && S.slot_row_width) || 0;
  return S && Array.isArray(S.slot_rows) && width ? Math.floor(S.slot_rows.length / width) : 0;
}
function packedSlotRowData(S, i){
  if(Number(S && S.slot_row_width) !== 8) throw new Error('Dashboard time-slot cube ไม่ตรงกับหน้าเว็บ');
  const o = i * 8;
  return {
    dateIdx:S.slot_rows[o], shiftCode:Number(S.slot_rows[o+1])||0,
    zone:S.slot_rows[o+2], pickerIdx:S.slot_rows[o+3], hour:Number(S.slot_rows[o+4])||0,
    pcs:Number(S.slot_rows[o+5])||0, pickQty:readBigQueryPickQty(S.slot_rows[o+6]),
    lines:Number(S.slot_rows[o+7])||0
  };
}

// Work cube ส่งวันของกะและ min/max นาทีจากต้นกะมาแล้ว จึงไม่ต้องคำนวณซ้ำจากข้อมูลรายบรรทัด
function prepShifts(){
  ['PTT','BPS'].forEach(n => {
    const S = DATA[n];
    if(!S || !Array.isArray(S.rows)) return;
    const count = packedRowCount(S);
    S._sh = new Array(count);
    for(let i=0;i<count;i++) {
      const offset = i * 9;
      const dateIdx = S.rows[offset];
      const timeShift = Number(S.rows[offset + 1]) === 1 ? 'night' : 'morning';
      const pickerIdx = Number(S.rows[offset + 3]) || 0;
      const pickerId = String(S.pickers[pickerIdx] || '').trim();
      const sh = getPickerRosterShift(pickerId, timeShift);
      S._sh[i] = {
        sd:S.dates[dateIdx], sh,
        sm:Number(S.rows[offset + 7]) || 0,
        smMin:Number(S.rows[offset + 7]) || 0,
        smMax:Number(S.rows[offset + 8]) || 0
      };
    }
  });
}

function computeBounds(){
  prepShifts();
  const set = new Set();
  ['PTT','BPS'].forEach(n => { const S = DATA[n]; if(S && S._sh) for(const si of S._sh) set.add(si.sd); });
  ALL_DATES = [...set].sort();
  DMIN = ALL_DATES[0] || ''; DMAX = ALL_DATES[ALL_DATES.length-1] || '';
}

function getPickerName(code){
  const s = String(code || '').trim();
  if(!s) return '-';
  const maps = [
    DATA && DATA.meta && DATA.meta.picker_names,
    PICKER_NAME_FALLBACK
  ];
  for (const map of maps) {
    if (map && typeof map === 'object') {
      const byExact = map[s];
      if (byExact && String(byExact).trim()) return String(byExact).trim();
      const byNoLeadZero = map[s.replace(/^0+/, '')];
      if (byNoLeadZero && String(byNoLeadZero).trim()) return String(byNoLeadZero).trim();
    }
  }
  return s;
}

function getPickerAffiliation(code){
  const s = String(code || '').trim();
  if(!s) return 'ไม่พบสังกัด';
  const maps = [
    DATA && DATA.meta && DATA.meta.picker_affiliations,
    PICKER_AFFILIATION_FALLBACK
  ];
  for (const map of maps) {
    if (map && typeof map === 'object') {
      const byExact = map[s];
      if (byExact && String(byExact).trim()) return String(byExact).trim();
      const byNoLeadZero = map[s.replace(/^0+/, '')];
      if (byNoLeadZero && String(byNoLeadZero).trim()) return String(byNoLeadZero).trim();
    }
  }
  return 'ไม่พบสังกัด';
}



function getPickerRosterShift(code, fallbackShift='morning'){
  const s = String(code || '').trim();
  const fallback = fallbackShift === 'night' ? 'night' : 'morning';
  if(!s) return fallback;
  const map = DATA && DATA.meta && DATA.meta.picker_shift_teams;
  if(map && typeof map === 'object'){
    const raw = map[s] != null ? map[s] : map[s.replace(/^0+/, '')];
    const team = String(raw == null ? '' : raw).trim().toUpperCase();
    if(team === 'A') return 'morning';
    if(team === 'B') return 'night';
  }
  // Team อื่น (เช่น C/D), ช่องว่าง หรือหาไม่พบ -> ใช้ช่วงเวลาจริงเดิม
  return fallback;
}

function getPickerRosterTeam(code, fallbackShift='morning'){
  return getPickerRosterShift(code, fallbackShift) === 'night' ? 'B' : 'A';
}

function getPickerMetaMapValue(mapName, code){
  const s = String(code || '').trim();
  if(!s) return '';
  const map = DATA && DATA.meta && DATA.meta[mapName];
  if(!map || typeof map !== 'object') return '';
  const exact = map[s];
  if(exact != null && String(exact).trim()) return String(exact).trim();
  const alt = map[s.replace(/^0+/, '')];
  return alt != null ? String(alt).trim() : '';
}

function getPickerResponsibility(code){ return getPickerMetaMapValue('picker_responsibilities', code); }
function getPickerRosterRawTeam(code){ return getPickerMetaMapValue('picker_roster_teams', code).toUpperCase(); }
function getPickerRosterHomeZone(code){ return getPickerMetaMapValue('picker_roster_zones', code); }

function getPickerRosterPlanningSummary(){
  const meta = DATA && DATA.meta || {};
  const roles = meta.picker_responsibilities || {};
  const teams = meta.picker_roster_teams || {};
  const names = meta.picker_names || {};
  const affiliations = meta.picker_affiliations || {};
  const rosterZones = meta.picker_roster_zones || {};
  const all=[], a=[], b=[], flex=[];
  Object.keys(roles).forEach(id => {
    const role = String(roles[id] || '').trim();
    if(role.toLowerCase() !== 'picker') return;
    const team = String(teams[id] || '').trim().toUpperCase();
    const rec = {id, name:String(names[id]||id).trim()||id, affiliation:String(affiliations[id]||'').trim(), team, homeZone:String(rosterZones[id]||'').trim(), responsibility:role};
    all.push(rec);
    if(team==='A') a.push(rec);
    else if(team==='B') b.push(rec);
    else flex.push(rec);
  });
  return {all,a,b,flex,total:all.length,countA:a.length,countB:b.length,countFlex:flex.length};
}


function applyPlannerRosterPayload(payload){
  if(!payload || payload.schema_version !== DASHBOARD_SCHEMA_VERSION) throw new Error('Roster schema ไม่ตรงกับหน้าเว็บ');
  const meta = DATA.meta || (DATA.meta = {});
  ['picker_names','picker_affiliations','picker_shift_teams','picker_roster_teams','picker_responsibilities','picker_roster_zones'].forEach(key => {
    if(payload[key] && typeof payload[key] === 'object') meta[key] = payload[key];
  });
  meta.picker_roster_generated = String(payload.generated || new Date().toISOString());
  meta.picker_roster_cache_ttl_seconds = Number(payload.cache_ttl_seconds) || 300;
  // กะของ Work cube ถูกคำนวณซ้ำใน browser จาก roster ล่าสุด จึงไม่ต้อง Query BigQuery ใหม่
  aggregateCache.clear();
  computeBounds();
  A = aggregate(sys, dfrom, dto, shiftF);
  return getPickerRosterPlanningSummary();
}


function plannerActionTimeText(){
  try {
    return new Intl.DateTimeFormat('th-TH',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date());
  } catch (_) {
    return new Date().toLocaleTimeString('th-TH');
  }
}

function plannerActionIconSvg(type){
  if(type === 'loading') return '<span class="planner-popup-spinner" aria-hidden="true"></span>';
  if(type === 'error') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5m0 3h.01M10.3 3.7 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/></svg>';
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
}

function showPlannerActionPopup(type, title, message, options={}){
  let overlay=document.getElementById('plannerActionPopup');
  if(!overlay){
    overlay=document.createElement('div');
    overlay.id='plannerActionPopup';
    overlay.innerHTML='<div class="planner-popup-card"><div class="planner-popup-icon"></div><div class="planner-popup-copy"><div class="planner-popup-title"></div><div class="planner-popup-message"></div><div class="planner-popup-time"></div></div><button type="button" class="planner-popup-close" aria-label="ปิด">×</button></div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.planner-popup-close').addEventListener('click',()=>overlay.classList.remove('show'));
    overlay.addEventListener('click',e=>{ if(e.target===overlay && !overlay.classList.contains('loading')) overlay.classList.remove('show'); });
  }
  if(!document.getElementById('plannerActionPopupStyle')){
    const style=document.createElement('style');
    style.id='plannerActionPopupStyle';
    style.textContent=`
#plannerActionPopup{position:fixed;inset:0;z-index:10050;background:rgba(15,23,42,.28);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;pointer-events:none;transition:.18s ease}
#plannerActionPopup.show{opacity:1;pointer-events:auto}
.planner-popup-card{width:min(430px,calc(100vw - 32px));background:#fff;border:1px solid #e2e8f0;border-radius:18px;box-shadow:0 24px 70px rgba(15,23,42,.22);padding:20px;display:grid;grid-template-columns:48px 1fr 28px;gap:14px;align-items:start}
.planner-popup-icon{width:48px;height:48px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:#ecfdf5;color:#047857}
.planner-popup-icon svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
#plannerActionPopup.error .planner-popup-icon{background:#fef2f2;color:#b91c1c}
#plannerActionPopup.loading .planner-popup-icon{background:#eff6ff;color:#2563eb}
.planner-popup-title{font-size:16px;font-weight:800;color:#0f172a;margin-top:1px}
.planner-popup-message{font-size:12.5px;line-height:1.65;color:#475569;margin-top:5px;white-space:pre-line}
.planner-popup-time{font-size:11px;color:#94a3b8;margin-top:9px}
.planner-popup-close{border:0;background:#f8fafc;color:#64748b;border-radius:8px;width:28px;height:28px;cursor:pointer;font-size:20px;line-height:1}
#plannerActionPopup.loading .planner-popup-close{visibility:hidden}
.planner-popup-spinner{width:24px;height:24px;border:3px solid #bfdbfe;border-top-color:#2563eb;border-radius:50%;animation:plannerSpin .75s linear infinite}
@keyframes plannerSpin{to{transform:rotate(360deg)}}`;
    document.head.appendChild(style);
  }
  overlay.className='show '+String(type||'success');
  overlay.querySelector('.planner-popup-icon').innerHTML=plannerActionIconSvg(type);
  overlay.querySelector('.planner-popup-title').textContent=title||'';
  overlay.querySelector('.planner-popup-message').textContent=message||'';
  overlay.querySelector('.planner-popup-time').textContent=type==='loading'?'กำลังประมวลผลข้อมูล':'ดำเนินการเมื่อ '+plannerActionTimeText()+' น.';
  const status=document.getElementById('simActionStatus');
  if(status && type!=='loading'){
    status.textContent=(type==='error'?'ดำเนินการไม่สำเร็จ':'อัปเดตล่าสุด '+plannerActionTimeText()+' น.');
    status.dataset.state=type;
  }
  if(type!=='loading' && options.autoClose!==false){
    const wait=Number(options.autoClose)||2800;
    clearTimeout(window._plannerPopupTimer);
    window._plannerPopupTimer=setTimeout(()=>{ if(overlay.classList.contains(type)) overlay.classList.remove('show'); },wait);
  }
  return overlay;
}

function plannerSetButtonBusy(btn,busy,busyText){
  if(!btn) return;
  if(busy){
    if(!btn.dataset.originalHtml) btn.dataset.originalHtml=btn.innerHTML;
    btn.disabled=true;
    btn.classList.add('is-busy');
    btn.innerHTML='<span class="planner-inline-spinner"></span><span>'+String(busyText||'กำลังดำเนินการ...')+'</span>';
  }else{
    btn.disabled=false;
    btn.classList.remove('is-busy');
    if(btn.dataset.originalHtml){ btn.innerHTML=btn.dataset.originalHtml; delete btn.dataset.originalHtml; }
  }
}

async function refreshPlannerRoster(force=false, options={}){
  if(plannerRosterRefreshPromise) return plannerRosterRefreshPromise;
  const silent = !!options.silent;
  const btn = document.getElementById('btnSimRefreshRoster');
  if(btn) plannerSetButtonBusy(btn,true,'กำลังอัปเดต...');
  if(!silent) showPlannerActionPopup('loading','กำลังอัปเดตรายชื่อพนักงาน','ระบบกำลังอ่านข้อมูลล่าสุดจากชีตบันทึกเวลาทำงาน');
  const task = (async()=>{
    const url = DATA_URL + (DATA_URL.includes('?')?'&':'?') +
      'mode=roster&fresh=' + (force?'1':'0') + '&t=' + Date.now();
    const response = await fetchWithTransientRetry(url, {cache:'no-store'}, 2);
    if(!response.ok) throw new Error('HTTP ' + response.status);
    const payload = JSON.parse(await response.text());
    if(payload && payload.error) throw new Error(payload.error);
    const roster = applyPlannerRosterPayload(payload);
    plannerRosterLastCheckedAt = Date.now();
    if(window._simState){
      const core = roster.countA + roster.countB;
      if(core > 0){
        const ratioA = Math.round(roster.countA / core * 100);
        window._simState.shiftARatio = ratioA;
        window._simState.shiftBRatio = 100 - ratioA;
      }
      window._simState.userPickersA = {};
      window._simState.userPickersB = {};
    }
    built.simulator = false;
    if(currentPage === 'simulator' && hasLiveData) builders.simulator();
    if(!silent) showPlannerActionPopup('success','อัปเดตรายชื่อพนักงานสำเร็จ',`พบ Picker ${roster.total} คน\nกะ A ${roster.countA} คน · กะ B ${roster.countB} คน · Flex ${roster.countFlex} คน`);
    return roster;
  })().catch(err=>{
    console.warn('refreshPlannerRoster failed:', err);
    if(!silent) showPlannerActionPopup('error','อัปเดตรายชื่อพนักงานไม่สำเร็จ',String(err.message || err),{autoClose:false});
    throw err;
  }).finally(()=>{
    plannerRosterRefreshPromise = null;
    if(btn && btn.isConnected) plannerSetButtonBusy(btn,false);
  });
  plannerRosterRefreshPromise = task;
  return task;
}

function schedulePlannerRosterAutoRefresh(){
  if(plannerRosterAutoTimer){ clearTimeout(plannerRosterAutoTimer); plannerRosterAutoTimer = null; }
  if(currentPage !== 'simulator') return;
  const elapsed = Date.now() - plannerRosterLastCheckedAt;
  const wait = Math.max(1000, PLANNER_ROSTER_AUTO_REFRESH_MS - elapsed);
  plannerRosterAutoTimer = setTimeout(()=>{
    plannerRosterAutoTimer = null;
    if(currentPage === 'simulator') void refreshPlannerRoster(false,{silent:true}).catch(()=>{});
  }, wait);
}

function normalizeLocationCode(value){
  const text = String(value || '').trim().toUpperCase();
  return text ? text.slice(0, 2) : '??';
}

function prepareZoneMaster(){
  const merged = {};
  const add = source => {
    if(!source || typeof source !== 'object') return;
    Object.entries(source).forEach(([rawLocation, rawInfo]) => {
      const location = normalizeLocationCode(rawLocation);
      if(!rawInfo || typeof rawInfo !== 'object') return;
      merged[location] = {
        zone: String(rawInfo.zone || location).trim() || location,
        typePick: String(rawInfo.typePick || rawInfo.type_pick || '-').trim() || '-',
        owner: String(rawInfo.owner || '-').trim() || '-'
      };
    });
  };
  add(ZONE_MASTER_FALLBACK);
  add(DATA && DATA.meta && DATA.meta.zone_master);
  ZONE_MASTER = merged;
}

function getZoneInfo(rawLocation){
  const location = normalizeLocationCode(rawLocation);
  const info = ZONE_MASTER[location];
  return {
    location,
    zone: info ? info.zone : location,
    typePick: info ? info.typePick : 'ไม่พบใน Zone_V2',
    owner: info ? info.owner : '-',
    known: Boolean(info)
  };
}

function getZoneMasterEntries(){
  return Object.entries(ZONE_MASTER).map(([location, info]) => ({
    location,
    zone: info.zone,
    typePick: info.typePick,
    owner: info.owner,
    known: true
  }));
}

function escapeZoneHtml(value){
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatRankBadge(index) {
  const rank = index + 1;
  if (rank === 1) return `<span class="rank rank-1">🥇 1</span>`;
  if (rank === 2) return `<span class="rank rank-2">🥈 2</span>`;
  if (rank === 3) return `<span class="rank rank-3">🥉 3</span>`;
  return `<span class="rank">${rank}</span>`;
}

function formatMapValue(value){
  const n = Number(value) || 0;
  if(n < 100000) return fmt(n);
  return new Intl.NumberFormat('en-US', {
    notation:'compact',
    maximumFractionDigits:1
  }).format(n);
}

function hexToRgb(hex){
  const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
  if(!m) return [100,116,139];
  return [0,1,2].map(i => parseInt(m[1].slice(i*2, i*2+2), 16));
}

function colorForLabel(palette, label){
  const key = String(label || '-').trim().toLowerCase();
  return palette[key] || palette['-'];
}

function mapGroupColors(info){
  return {
    owner: colorForLabel(ZONE_OWNER_COLORS, info && info.owner),
    type: colorForLabel(ZONE_TYPE_COLORS, info && info.typePick)
  };
}

function zoneMapColor(value, maxValue, isPcs, info){
  const val = Number(value) || 0;
  const monoColor = '#4f46e5';
  const monoRgb = hexToRgb(monoColor);
  if(val <= 0) return {background:'#ffffff', border:'#c7d2fe', accent:'#c7d2fe', owner:monoColor, type:monoColor, color:'#334155', intensity:0};
  const ratio = Math.min(1, val / Math.max(1, maxValue));
  const intensity = .15 + .85 * Math.pow(ratio, .48);
  const base = [248,250,252];
  const mixed = base.map((v,i)=>Math.round(v + (monoRgb[i]-v)*intensity));
  return {
    background:`rgb(${mixed.join(',')})`,
    border:`rgba(${monoRgb.join(',')},${(.3 + intensity*.55).toFixed(2)})`,
    color:intensity > .58 ? '#ffffff' : '#1e293b',
    accent:monoColor,
    owner:monoColor,
    type:monoColor,
    intensity
  };
}

function renderWarehouseMap(activeLocations, isPcs){
  const root = document.getElementById('warehouseMap');
  if(!root) return;
  const layout = ZONE_LAYOUT_CONFIG;
  const required = ['onFloor','selectiveTop','selectiveBottom','microRack'];
  if(required.some(key => !Array.isArray(layout[key]))){
    root.innerHTML = '<div class="floor-map-empty">โหลดโครงสร้างแผนผัง Zone ไม่สำเร็จ กรุณารีเฟรชหน้าเว็บ</div>';
    return;
  }

  const mappedCodes = [
    ...layout.onFloor,
    ...layout.selectiveTop,
    ...layout.selectiveBottom,
    ...layout.microRack
  ];
  const mappedSet = new Set(mappedCodes);
  const activeRows = [...activeLocations.values()];
  const mainValue = row => isPcs ? Number(row && row.pcs || 0) : Number(row && row.qty || 0);
  const maxValue = Math.max(1, ...mappedCodes.map(code => mainValue(activeLocations.get(code))));
  const mainUnit = isPcs ? 'ชิ้น' : 'หน่วยหยิบ';
  const secondaryUnit = isPcs ? 'หยิบ' : 'ชิ้น';

  function metadata(code){
    const info = getZoneInfo(code);
    if(!info.known && code === 'PF'){
      return {...info, zone:'PF', typePick:'On Floor', owner:'Max Mart'};
    }
    return info;
  }

  function card(code, extraClass){
    const row = activeLocations.get(code) || {location:code, pcs:0, qty:0, lines:0, pickers:0};
    const info = metadata(code);
    const primary = mainValue(row);
    const secondary = isPcs ? Number(row.qty || 0) : Number(row.pcs || 0);
    const color = zoneMapColor(primary, maxValue, isPcs, info);
    const active = Number(row.lines || 0) > 0;

    const zProdMap = A && A.zone_prod_map;
    const zProd = zProdMap ? (zProdMap[info.zone] || zProdMap[code]) : null;
    const prodVal = zProd ? (isPcs ? Number(zProd.avg_pcs_prod || 0) : Number(zProd.avg_prod || 0)) : 0;
    const prodText = prodVal > 0 ? (prodVal >= 10000 ? formatMapValue(prodVal) : fmt(Math.ceil(prodVal))) : '-';

    const title = [
      `Location: ${code}`,
      `Zone: ${info.zone}`,
      `Type Pick: ${info.typePick}`,
      `Owner: ${info.owner}`,
      `จำนวนชิ้น: ${fmt(row.pcs || 0)} ชิ้น`,
      `หน่วยหยิบ: ${fmt(row.qty || 0)} หน่วย`,
      `Productivity: ${fmt(prodVal > 0 ? Math.ceil(prodVal) : 0)} ${isPcs ? 'ชิ้น/ชม.' : 'หน่วย/ชม.'}`,
      `Picker: ${fmt(row.pickers || 0)} คน`
    ].join('\n');
    return `<div class="floor-loc ${extraClass || ''} ${active ? 'active' : 'inactive'}" data-location="${escapeZoneHtml(code)}"` +
      ` onclick="openZoneDetailModal('${escapeZoneHtml(code)}')" style="cursor:pointer;--floor-bg:${color.background};--floor-border:${color.border};--floor-accent:${color.accent || color.border};--floor-fg:${color.color}" data-owner="${escapeZoneHtml(info.owner)}" data-type-pick="${escapeZoneHtml(info.typePick)}" title="${escapeZoneHtml(title)}">` +
      `<div class="floor-loc-code">${escapeZoneHtml(code)}</div>` +
      `<div class="floor-loc-metric"><strong>${formatMapValue(primary)}</strong><span>${escapeZoneHtml(mainUnit)}</span></div>` +
      `<div class="floor-loc-secondary">${formatMapValue(secondary)} ${escapeZoneHtml(secondaryUnit)}</div>` +
      `<div class="floor-loc-prod">⚡ ${escapeZoneHtml(prodText)}</div>` +
      `<div class="floor-loc-pickers">👤 ${fmt(row.pickers || 0)} คน</div>` +
      `</div>`;
  }

  function bands(list){
    return (list || []).map(band =>
      `<div class="floor-owner-band ${escapeZoneHtml(band.tone || '')}" style="grid-column:${Number(band.start)} / span ${Number(band.span)}">${escapeZoneHtml(band.label)}</div>`
    ).join('');
  }

  const outsideCodes = new Set();
  getZoneMasterEntries().forEach(row => { if(!mappedSet.has(row.location)) outsideCodes.add(row.location); });
  activeRows.forEach(row => { if(!mappedSet.has(row.location)) outsideCodes.add(row.location); });
  const outside = [...outsideCodes].sort((a,b)=>{
    const diff = mainValue(activeLocations.get(b)) - mainValue(activeLocations.get(a));
    return diff || a.localeCompare(b);
  });
  root.innerHTML =
    `<div class="floor-map-legend"><div><span class="floor-legend-dot low"></span>น้อย</div><div><span class="floor-legend-bar ${isPcs ? 'pcs' : 'units'}"></span>มาก</div>` +
    `<div class="floor-legend-unit">ตัวเลขหลัก = ${escapeZoneHtml(mainUnit)} · 💡 คลิกกล่อง Zone เพื่อดูรายละเอียดเชิงลึก</div></div>` +
    `<div class="floor-map-group-legends"><b>การอ่านสี:</b> ใช้สีเดียวทั้งแผนผัง · สีเข้ม = ยอดหยิบมาก · สีอ่อน = ยอดหยิบน้อย · 💡 <b>คลิกกล่อง Zone ใดก็ได้เพื่อเปิด Popup วิเคราะห์พนักงาน, สินค้า และชั่วโมงทำงาน</b></div>` +
    `<div class="warehouse-map-scroll"><div class="warehouse-floor">` +
      `<section class="floor-onfloor">` +
        `<div class="floor-section-title">On Floor</div><div class="floor-owner-strip maxmart">MAX MART</div>` +
        `<div class="floor-onfloor-grid">${layout.onFloor.map(code=>card(code,'onfloor')).join('')}</div>` +
      `</section>` +
      `<div class="floor-divider" aria-hidden="true"></div>` +
      `<section class="floor-selective">` +
        `<div class="floor-section-title selective-title">Selective Rack</div>` +
        `<div class="floor-selective-body"><div class="floor-rack-main">` +
          `<div class="floor-owner-grid">${bands(layout.topBands)}</div>` +
          `<div class="floor-rack-grid top">${layout.selectiveTop.map(code=>card(code,'rack')).join('')}</div>` +
          `<div class="floor-rack-grid bottom">${layout.selectiveBottom.map(code=>card(code,'rack')).join('')}</div>` +
          `<div class="floor-owner-grid bottom">${bands(layout.bottomBands)}</div>` +
        `</div><div class="floor-micro">` +
          `<div class="floor-micro-owner">MAX MART</div>` +
          `<div class="floor-micro-stack">${layout.microRack.map(code=>card(code,'micro')).join('')}</div>` +
        `</div></div>` +
      `</section>` +
    `</div></div>` +
    `<div class="floor-outside-wrap"><div class="floor-outside-title">Location นอกแผนผัง (${outside.length})</div>` +
      `<div class="floor-outside">${outside.length ? outside.map(code=>card(code,'outside')).join('') : '<span class="floor-all-mapped">Location ทั้งหมดอยู่ในแผนผังแล้ว</span>'}</div>` +
    `</div>`;
}

function openZoneDetailModal(zoneCode) {
  try {
    activeZoneDetailCode = String(zoneCode || '').trim().toUpperCase();
    const isPcs = unitMode === 'pcs';
    const S = DATA[sys];
    if (!S || !Array.isArray(S.rows)) return;
    const count = packedRowCount(S);
    const zoneInfo = getZoneInfo(zoneCode);

    let totalQty = 0, totalPcs = 0, totalLines = 0;
    const uniqueSkus = new Map();
    const uniquePickers = new Map();

    for (let i = 0; i < count; i++) {
      const sh = S._sh ? S._sh[i] : null;
      if (!sh || sh.sd < dfrom || sh.sd > dto) continue;
      if (shiftF !== 'all' && sh.sh !== shiftF) continue;

      const row = packedRowData(S, i);
      const rawLoc = (S.locations && S.locations[row.zone]) ? S.locations[row.zone] : row.zone;
      const zInfo = getZoneInfo(rawLoc);
      const zCode = zInfo.zone || zInfo.location || String(rawLoc || '-').trim().toUpperCase();
      const rawLocStr = String(rawLoc || '-').trim().toUpperCase();
      if (zCode !== zoneCode && zInfo.location !== zoneCode && rawLocStr !== zoneCode) continue;

      const qty = row.pickQty;
      const pcs = row.pcs;
      const pickerId = String(S.pickers[row.pickerIdx] || '-').trim();

      totalQty += qty;
      totalPcs += pcs;
      totalLines += row.lines;

      // Picker aggregation
      if (!uniquePickers.has(pickerId)) {
        uniquePickers.set(pickerId, {
          pickerId,
          pickerName: getPickerName(pickerId),
          affiliation: getPickerAffiliation(pickerId),
          qty: 0,
          pcs: 0,
          lines: 0,
          minSm: sh.smMin,
          maxSm: sh.smMax
        });
      }
      const pRec = uniquePickers.get(pickerId);
      pRec.qty += qty;
      pRec.pcs += pcs;
      pRec.lines += row.lines;
      if (sh.smMin < pRec.minSm) pRec.minSm = sh.smMin;
      if (sh.smMax > pRec.maxSm) pRec.maxSm = sh.smMax;
    }

    // SKU โหลดแบบ lazy เฉพาะเมื่อเปิดรายละเอียด Zone ไม่เพิ่มภาระให้หน้าแรก
    const itemRowsReady = forEachCurrentItemRow(sys, dfrom, dto, shiftF, row => {
      const zInfo = getZoneInfo(row.zone);
      const zCode = zInfo.zone || zInfo.location || String(row.zone || '-').trim().toUpperCase();
      const rawLocStr = String(row.zone || '-').trim().toUpperCase();
      if(zCode !== zoneCode && zInfo.location !== zoneCode && rawLocStr !== zoneCode) return;
      const sku = row.sku;
      const owner = normalizeOwnerKey(row.owner);
      if(isSkuExcluded(sku, owner)) return;
      const itemInfo = getItemInfo(owner, sku);
      const itemKey = itemCompositeKey(owner, sku);
      const skuRec = uniqueSkus.get(itemKey) || {
        key:itemKey, sku, name:itemInfo.name || sku, owner:itemInfo.owner || owner || zInfo.owner || '-', qty:0, pcs:0, lines:0
      };
      skuRec.qty += row.pickQty;
      skuRec.pcs += row.pcs;
      skuRec.lines += row.lines;
      uniqueSkus.set(itemKey, skuRec);
    });
    if(!itemRowsReady) void loadCurrentItemCube(false);

    let totalWorkHours = 0;
    const pickerList = [...uniquePickers.values()].map(p => {
      let spanMin = p.maxSm - p.minSm;
      let wh = Math.max(spanMin / 60.0, 0.5);
      if (wh >= 8.5 && wh <= 9.5) wh = 9.0;
      wh = Math.round(wh * 10) / 10;
      totalWorkHours += wh;
      const pVal = isPcs ? p.pcs : p.qty;
      const prod = wh > 0 ? (pVal / wh) : 0;
      return { ...p, wh, prod };
    });
    pickerList.sort((a, b) => (isPcs ? b.pcs - a.pcs : b.qty - a.qty));

    const skuList = [...uniqueSkus.values()].sort((a, b) => (isPcs ? b.pcs - a.pcs : b.qty - a.qty));

    const overallVal = isPcs ? totalPcs : totalQty;
    const overallProd = totalWorkHours > 0 ? (overallVal / totalWorkHours) : 0;

    const isEx = isZoneExcluded(zoneCode);
    const exBtnStyle = isEx
      ? 'background:#16a34a; color:#fff; border:0; padding:6px 14px; border-radius:8px; font-size:12px; font-weight:700; cursor:pointer; box-shadow:0 2px 6px rgba(22,163,74,0.3); transition:.2s;'
      : 'background:#ef4444; color:#fff; border:0; padding:6px 14px; border-radius:8px; font-size:12px; font-weight:700; cursor:pointer; box-shadow:0 2px 6px rgba(239,68,68,0.3); transition:.2s;';
    const exBtnText = isEx
      ? `✅ นำโซน ${escapeZoneHtml(zoneCode)} กลับเข้าการคำนวณ`
      : `🚫 ตัดโซน ${escapeZoneHtml(zoneCode)} ออกจากการคำนวณ`;

    const titleEl = document.getElementById('zoneModalTitle');
    const subEl = document.getElementById('zoneModalSub');
    if (titleEl) {
      titleEl.innerHTML = `<div style="display:flex; justify-content:space-between; align-items:center; width:100%; flex-wrap:wrap; gap:10px;">
        <span>📍 รายละเอียดและผลงานใน Zone: <span style="color:#fbbf24; font-weight:800; font-size:20px; text-decoration:underline;">${escapeZoneHtml(zoneCode)}</span> ${isEx ? '<span style="background:#ef4444; color:#fff; font-size:11px; padding:2px 8px; border-radius:6px; margin-left:6px; font-weight:700;">[ถูกตัดออกจากการคำนวณ]</span>' : ''}</span>
        <button onclick="toggleZoneExclusion('${escapeZoneHtml(zoneCode)}'); openZoneDetailModal('${escapeZoneHtml(zoneCode)}');" style="${exBtnStyle}">${exBtnText}</button>
      </div>`;
    }
    if (subEl) subEl.textContent = `ชนิดการจัดเก็บ: ${zoneInfo.typePick || '-'} · เจ้าของสินค้า: ${zoneInfo.owner || '-'} · ช่วงวันที่: ${dfrom} ถึง ${dto}`;

    const bodyEl = document.getElementById('zoneModalBody');
    if (bodyEl) {
      let bodyHtml = `
        <!-- 4 Strategic KPI Cards -->
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:12px;">
          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-left:4px solid #4338ca; padding:12px 14px; border-radius:10px;">
            <div style="font-size:11px; color:#64748b; font-weight:600;">📦 ยอดหยิบรวม</div>
            <div style="font-size:20px; font-weight:800; color:#0f172a; margin-top:2px;">${fmt(Math.ceil(overallVal))} <span style="font-size:11px; font-weight:400;">${isPcs ? 'ชิ้น' : 'หน่วย'}</span></div>
            <div style="font-size:10px; color:#64748b; margin-top:2px;">${isPcs ? fmt(Math.ceil(totalQty)) + ' หน่วยหยิบ' : fmt(totalPcs) + ' ชิ้น'}</div>
          </div>

          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-left:4px solid #0284c7; padding:12px 14px; border-radius:10px;">
            <div style="font-size:11px; color:#64748b; font-weight:600;">📋 รายการหยิบ (Lines)</div>
            <div style="font-size:20px; font-weight:800; color:#0f172a; margin-top:2px;">${fmt(totalLines)} <span style="font-size:11px; font-weight:400;">บรรทัด</span></div>
            <div style="font-size:10px; color:#64748b; margin-top:2px;">จาก ${skuList.length} รายการ SKU</div>
          </div>

          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-left:4px solid #d97706; padding:12px 14px; border-radius:10px;">
            <div style="font-size:11px; color:#64748b; font-weight:600;">⏱️ ชั่วโมงทำงานใน Zone</div>
            <div style="font-size:20px; font-weight:800; color:#0f172a; margin-top:2px;">${fmt(Math.round(totalWorkHours * 10) / 10)} <span style="font-size:11px; font-weight:400;">ชม.</span></div>
            <div style="font-size:10px; color:#64748b; margin-top:2px;">พนักงานปฏิบัติงาน ${pickerList.length} คน</div>
          </div>

          <div style="background:#f8fafc; border:1px solid #e2e8f0; border-left:4px solid #16a34a; padding:12px 14px; border-radius:10px;">
            <div style="font-size:11px; color:#64748b; font-weight:600;">⚡ Productivity เฉลี่ย</div>
            <div style="font-size:20px; font-weight:800; color:#16a34a; margin-top:2px;">${fmt(Math.ceil(overallProd))} <span style="font-size:11px; font-weight:400;">${isPcs ? 'ชิ้น/ชม.' : 'หยิบ/ชม.'}</span></div>
            <div style="font-size:10px; color:#64748b; margin-top:2px;">ผลรวมงาน ÷ ชั่วโมงกะ</div>
          </div>
        </div>

        <!-- 👥 1. Picker List Table in Zone -->
        <div>
          <h4 style="font-size:14.5px; font-weight:700; color:#0f172a; margin:0 0 8px 0; display:flex; justify-content:space-between; align-items:center;">
            <span>👥 รายชื่อพนักงานปฏิบัติงานใน Zone ${escapeZoneHtml(zoneCode)} (${pickerList.length} คน)</span>
          </h4>
          <div style="overflow-x:auto; max-height:220px; border:1px solid #e2e8f0; border-radius:8px;">
            <table style="width:100%; border-collapse:collapse; font-size:12px;">
              <thead>
                <tr style="background:#f1f5f9; color:#475569; text-align:left;">
                  <th style="padding:8px 10px;">#</th>
                  <th style="padding:8px 10px;">ชื่อพนักงาน / ID</th>
                  <th style="padding:8px 10px;">สังกัด</th>
                  <th style="padding:8px 10px;" class="num">ปริมาณหยิบ</th>
                  <th style="padding:8px 10px;" class="num">บรรทัด</th>
                  <th style="padding:8px 10px;" class="num">ชั่วโมง</th>
                  <th style="padding:8px 10px;" class="num">Productivity</th>
                </tr>
              </thead>
              <tbody>`;

      if (pickerList.length === 0) {
        bodyHtml += `<tr><td colspan="7" class="empty-cell" style="text-align:center; padding:16px; color:#94a3b8;">ไม่มีการหยิบสินค้าใน Zone นี้ช่วงวันที่เลือก</td></tr>`;
      } else {
        pickerList.forEach((p, idx) => {
          const val = isPcs ? p.pcs : p.qty;
          bodyHtml += `
            <tr style="border-bottom:1px solid #f1f5f9;">
              <td style="padding:6px 10px; font-weight:600; color:#64748b;">${idx + 1}</td>
              <td style="padding:6px 10px;">
                <div style="font-weight:700; color:#0f172a;">${escapeZoneHtml(p.pickerName)}</div>
                <div style="font-size:10px; color:#64748b;">ID: ${escapeZoneHtml(p.pickerId)}</div>
              </td>
              <td style="padding:6px 10px;"><span class="pill" style="background:#f1f5f9; color:#334155; font-size:11px;">${escapeZoneHtml(p.affiliation)}</span></td>
              <td style="padding:6px 10px; font-weight:700; color:#4338ca;" class="num">${fmt(Math.ceil(val))} ${isPcs ? 'ชิ้น' : 'หน่วย'}</td>
              <td style="padding:6px 10px;" class="num">${fmt(p.lines)}</td>
              <td style="padding:6px 10px;" class="num">${p.wh} ชม.</td>
              <td style="padding:6px 10px; font-weight:700; color:#16a34a;" class="num">${fmt(Math.ceil(p.prod))} ${isPcs ? 'ชิ้น/ชม.' : 'หยิบ/ชม.'}</td>
            </tr>`;
        });
      }

      bodyHtml += `
              </tbody>
            </table>
          </div>
        </div>

        <!-- 📦 2. Top Items / SKUs Table in Zone -->
        <div>
          <h4 style="font-size:14.5px; font-weight:700; color:#0f172a; margin:0 0 8px 0;">
            📦 รายการสินค้าที่มีการหยิบใน Zone ${escapeZoneHtml(zoneCode)} (Top 10 SKUs)
          </h4>
          <div style="overflow-x:auto; max-height:220px; border:1px solid #e2e8f0; border-radius:8px;">
            <table style="width:100%; border-collapse:collapse; font-size:12px;">
              <thead>
                <tr style="background:#f1f5f9; color:#475569; text-align:left;">
                  <th style="padding:8px 10px;">#</th>
                  <th style="padding:8px 10px;">SKU Code</th>
                  <th style="padding:8px 10px;">ชื่อสินค้า</th>
                  <th style="padding:8px 10px;">Owner</th>
                  <th style="padding:8px 10px;" class="num">ปริมาณหยิบรวม</th>
                  <th style="padding:8px 10px;" class="num">บรรทัด</th>
                  <th style="padding:8px 10px;" class="num">สัดส่วน %</th>
                </tr>
              </thead>
              <tbody>`;

      if (skuList.length === 0) {
        const itemState = itemCubeLoadState.get(itemCubeRequestKey());
        const itemMessage = !itemRowsReady && itemState && itemState.status === 'error'
          ? `โหลดรายการสินค้าไม่สำเร็จ: ${escapeZoneHtml(itemState.message || '')} <button onclick="retryCurrentItemCube()" class="refreshbtn">ลองอีกครั้ง</button>`
          : (!itemRowsReady ? 'กำลังโหลดรายการสินค้าเฉพาะช่วงที่เลือก…' : 'ไม่มีรายการสินค้าใน Zone นี้ช่วงวันที่เลือก');
        bodyHtml += `<tr><td colspan="7" class="empty-cell" style="text-align:center; padding:16px; color:#94a3b8;">${itemMessage}</td></tr>`;
      } else {
        skuList.slice(0, 10).forEach((item, idx) => {
          const val = isPcs ? item.pcs : item.qty;
          const sharePct = overallVal > 0 ? ((val / overallVal) * 100).toFixed(1) : '0.0';
          bodyHtml += `
            <tr style="border-bottom:1px solid #f1f5f9;">
              <td style="padding:6px 10px; font-weight:600; color:#64748b;">${idx + 1}</td>
              <td style="padding:6px 10px; font-weight:700; color:#0f172a;">${escapeZoneHtml(item.sku)}</td>
              <td style="padding:6px 10px; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeZoneHtml(item.name)}</td>
              <td style="padding:6px 10px;"><span class="pill" style="background:#eef2ff; color:#4338ca; font-size:10.5px;">${escapeZoneHtml(item.owner)}</span></td>
              <td style="padding:6px 10px; font-weight:700; color:#0f172a;" class="num">${fmt(Math.ceil(val))} ${isPcs ? 'ชิ้น' : 'หน่วย'}</td>
              <td style="padding:6px 10px;" class="num">${fmt(item.lines)}</td>
              <td style="padding:6px 10px; font-weight:700; color:#4338ca;" class="num">${sharePct}%</td>
            </tr>`;
        });
      }

      bodyHtml += `
              </tbody>
            </table>
          </div>
        </div>
      `;

      bodyEl.innerHTML = bodyHtml;
    }

    const modalEl = document.getElementById('zoneDetailModal');
    if (modalEl) modalEl.style.display = 'flex';
  } catch (err) {
    console.error('openZoneDetailModal failed:', err);
  }
}

function closeZoneDetailModal() {
  activeZoneDetailCode = '';
  const modalEl = document.getElementById('zoneDetailModal');
  if (modalEl) modalEl.style.display = 'none';
}

function renderZoneProductivityBreakdown(){
  const root = document.getElementById('zoneBreakdown');
  if(!root || !A) return;
  const switchRoot = document.getElementById('zoneBreakdownSwitch');
  const mode = zoneBreakdownMode === 'type' ? 'type' : (zoneBreakdownMode === 'zone' ? 'zone' : 'owner');
  const rows = mode === 'type' ? (A.by_type_pick || []) : (mode === 'zone' ? (A.by_zone_prod || []) : (A.by_owner || []));
  const label = mode === 'type' ? 'Type Pick' : (mode === 'zone' ? 'Zone' : 'Owner');
  const palette = mode === 'type' ? ZONE_TYPE_COLORS : (mode === 'zone' ? PALETTE : ZONE_OWNER_COLORS);
  const blank = `<div class="floor-all-mapped">ยังไม่มีข้อมูล Productivity สำหรับช่วงที่เลือก</div>`;
  if(!rows.length){ root.innerHTML = blank; return; }
  const body = rows.map((row, index) => {
    const color = mode === 'zone' ? PALETTE[index % PALETTE.length] : colorForLabel(palette, row.name);
    const displayName = (mode === 'owner' && row.name === '-') ? 'ไม่พบ Owner' : row.name;
    const relatedLabel = mode === 'zone'
      ? `Owner: ${(row.owners||[]).map(x=>x==='-'?'ไม่พบ Owner':x).join(', ')} | Type: ${(row.types||[]).join(', ')}`
      : (mode === 'type' ? `Owner: ${(row.owners||[]).map(x=>x==='-'?'ไม่พบ Owner':x).join(', ')}` : `Type Pick: ${(row.types||[]).join(', ')}`);
    const productivity = Number(row.avg_prod || 0);
    const pcsProductivity = Number(row.avg_pcs_prod || 0);
    return `<tr>` +
      `<td><span class="rank">${index + 1}</span></td>` +
      `<td><span class="zone-breakdown-key"><i style="background:${color}"></i>${escapeZoneHtml(displayName)}</span><span class="metric-sub">${escapeZoneHtml(relatedLabel)}</span></td>` +
      `<td class="num">${fmt(row.pcs)}<span class="metric-sub">${fmt(row.eligiblePcs)} นับ Productivity</span></td>` +
      `<td class="num">${fmt(row.qty)}<span class="metric-sub">${fmt(row.eligibleQty)} นับ Productivity</span></td>` +
      `<td class="num">${fmt(row.hours)} ชม.<span class="metric-sub">${fmt(row.productiveGroups)} กลุ่ม ≥ 3 ชม.</span></td>` +
      `<td class="num"><span class="metric-main">${fmt(productivity)}</span> หยิบ/ชม.<span class="metric-sub">เฉลี่ยถ่วงน้ำหนัก</span></td>` +
      `<td class="num"><span class="metric-main">${fmt(pcsProductivity)}</span> ชิ้น/ชม.</td>` +
      `<td class="num">${fmt(row.productivePickers)} / ${fmt(row.pickers)} คน</td>` +
      `</tr>`;
  }).join('');
  root.innerHTML = `<div class="zone-breakdown-wrap"><table class="zone-breakdown-table"><thead><tr>` +
    `<th>#</th><th>${label}</th><th class="num">จำนวนชิ้นรวม</th><th class="num">หน่วยหยิบรวม</th><th class="num">ชั่วโมงที่นับ</th>` +
    `<th class="num">Productivity หยิบ/ชม.</th><th class="num">Productivity ชิ้น/ชม.</th><th class="num">Picker ที่นับ / ทั้งหมด</th>` +
    `</tr></thead><tbody>${body}</tbody></table></div>` +
    `<div class="zone-breakdown-foot">Productivity หักเวลาพักตามกะ และใช้เฉพาะกลุ่มที่มีเวลาทำงานจริงตั้งแต่ ${MIN_PRODUCTIVE_HOURS} ชั่วโมงขึ้นไป · จำนวนชิ้น/หน่วยหยิบรวมยังแสดงยอดทั้งหมดของช่วงที่เลือก</div>`;
  if(switchRoot){
    switchRoot.querySelectorAll('button').forEach(button => {
      const bMode = button.dataset.breakdown;
      button.classList.toggle('active', bMode === mode);
      button.onclick = () => {
        const next = bMode === 'type' ? 'type' : (bMode === 'zone' ? 'zone' : 'owner');
        if(zoneBreakdownMode === next) return;
        zoneBreakdownMode = next;
        renderZoneProductivityBreakdown();
      };
    });
  }
}

function renderAffiliationBreakdown(){
  const root = document.getElementById('affiliationBreakdown');
  if(!root || !A) return;
  const rows = A.by_affiliation || [];
  const daily = A.affiliation_daily || [];
  if(!rows.length){
    root.innerHTML = '<div class="floor-all-mapped">ยังไม่มีข้อมูล Productivity ตามสังกัดในช่วงที่เลือก</div>';
    return;
  }

  const summaryRows = rows.map((row, index) => `<tr>
    <td><span class="rank">${index + 1}</span></td>
    <td><span class="affiliation-key">${escapeZoneHtml(row.name)}</span><span class="metric-sub">${fmt(row.productivePickers)} / ${fmt(row.pickers)} คน นับ Productivity</span></td>
    <td class="num">${fmt(row.pcs)}<span class="metric-sub">${fmt(row.eligiblePcs)} ชิ้นที่นำไปคิด</span></td>
    <td class="num">${fmt(row.qty)}<span class="metric-sub">${fmt(row.eligibleQty)} หน่วยที่นำไปคิด</span></td>
    <td class="num">${fmt(row.hours)} ชม.<span class="metric-sub">${fmt(row.productiveGroups)} กลุ่ม ≥ ${MIN_PRODUCTIVE_HOURS} ชม.</span></td>
    <td class="num"><span class="metric-main">${fmt(row.avg_prod)}</span> หน่วย/ชม.</td>
    <td class="num"><span class="metric-main">${fmt(row.avg_pcs_prod)}</span> ชิ้น/ชม.</td>
    <td class="num">${row.ot > 0 ? fmt(row.ot) : '-'} ชม.</td>
  </tr>`).join('');

  const dailyRows = daily.map((row, index) => `<tr>
    <td>${escapeZoneHtml(row.date)}</td>
    <td><span class="affiliation-key">${escapeZoneHtml(row.name)}</span></td>
    <td class="num">${fmt(row.pickers)}</td>
    <td class="num">${fmt(row.pcs)}</td>
    <td class="num">${fmt(row.qty)}</td>
    <td class="num">${fmt(row.hours)} ชม.</td>
    <td class="num"><span class="metric-main">${fmt(row.avg_prod)}</span></td>
    <td class="num"><span class="metric-main">${fmt(row.avg_pcs_prod)}</span></td>
    <td class="num ot-cell">${row.ot > 0 ? fmt(row.ot) : '-'} ชม.</td>
  </tr>`).join('');

  root.innerHTML = `<div class="affiliation-table-wrap"><table class="affiliation-table"><thead><tr>
    <th>#</th><th>สังกัด</th><th class="num">จำนวนชิ้นรวม</th><th class="num">หน่วยหยิบรวม</th><th class="num">ชั่วโมงที่นับ</th>
    <th class="num">Productivity หน่วย/ชม.</th><th class="num">Productivity ชิ้น/ชม.</th><th class="num">OT รวม</th>
  </tr></thead><tbody>${summaryRows}</tbody></table></div>
  <div class="affiliation-daily-title">OT และ Productivity รายวันแยกตามสังกัด</div>
  <div class="affiliation-table-wrap"><table class="affiliation-table affiliation-daily-table"><thead><tr>
    <th>วันที่ (วันกะ)</th><th>สังกัด</th><th class="num">Picker</th><th class="num">จำนวนชิ้น</th><th class="num">หน่วยหยิบ</th>
    <th class="num">ชั่วโมงที่นับ</th><th class="num">หน่วย/ชม.</th><th class="num">ชิ้น/ชม.</th><th class="num">OT รายวัน</th>
  </tr></thead><tbody>${dailyRows || '<tr><td colspan="9" class="empty-cell">ยังไม่มีข้อมูลรายวัน</td></tr>'}</tbody></table></div>
  <div class="zone-breakdown-foot">สังกัดจับจากรหัสพนักงานใน Sheet “บันทึกเวลาทำงาน” · Productivity หักเวลาพักตามกะ · OT เริ่ม 16:30/04:30 · ไม่นับกลุ่มที่ทำงานจริงต่ำกว่า ${MIN_PRODUCTIVE_HOURS} ชั่วโมง</div>`;
}

// ===== core: aggregate ตามช่วงวันที่(ของกะ) + กะ =====
// Work cube = [shiftDateIdx, shiftCode, zone, pickerIdx, pcs, pick_qty, lines, minSm, maxSm]
function aggregate(system, from, to, sf){
  const cacheKey = [system, from, to, sf, excludedSkuRevision].join('|');
  if(aggregateCache.has(cacheKey)) return aggregateCache.get(cacheKey);

  const S = DATA[system];
  let lines = 0, pcs = 0, pickQty = 0;
  const pickers = new Set(), zones = new Set();
  const zoneMap = {}, locationMap = {}, itemMap = {}, itemMapAll = {}, slotMap = {}, dayVol = {}, grp = {}, zoneGrp = {}, ownerTypeGrp = {}, affiliationGrp = {}, pickerZoneCnt = {}, pickerLocationCnt = {}, pickerDrilldownMap = {};
  const SH = S._sh;

  const rowCount = packedRowCount(S);
  for(let i=0;i<rowCount;i++){
    const si = SH[i];
    if(si.sd < from || si.sd > to) continue;
    if(sf !== 'all' && si.sh !== sf) continue;
    const r = packedRowData(S, i);
    const zoneInfo = getZoneInfo(r.zone);
    const location = zoneInfo.location;
    const zone = zoneInfo.zone;
    const picker = S.pickers[r.pickerIdx];
    const pVal = r.pcs;
    const qVal = r.pickQty;
    const lineVal = r.lines;

    // หาก Zone นี้ถูกเลือกยกเว้น -> ข้ามไม่นำมาคิดสถิติรวมทั้งหมด
    if (isZoneExcluded(zone)) continue;

    lines += lineVal; pcs += pVal; pickQty += qVal; pickers.add(picker); zones.add(zone);
    (zoneMap[zone] = zoneMap[zone] || {
      pcs:0, qty:0, lines:0, pk:new Set(), locations:new Set(),
      typePick:zoneInfo.typePick, owner:zoneInfo.owner, known:zoneInfo.known
    });
    zoneMap[zone].pcs += pVal; zoneMap[zone].qty += qVal; zoneMap[zone].lines += lineVal; zoneMap[zone].pk.add(picker); zoneMap[zone].locations.add(location);

    (locationMap[location] = locationMap[location] || {
      location, zone, typePick:zoneInfo.typePick, owner:zoneInfo.owner, known:zoneInfo.known,
      pcs:0, qty:0, lines:0, pk:new Set()
    });
    locationMap[location].pcs += pVal; locationMap[location].qty += qVal; locationMap[location].lines += lineVal; locationMap[location].pk.add(picker);

    (pickerZoneCnt[picker] = pickerZoneCnt[picker] || {});
    pickerZoneCnt[picker][zone] = (pickerZoneCnt[picker][zone]||0)+lineVal;
    (pickerLocationCnt[picker] = pickerLocationCnt[picker] || {});
    pickerLocationCnt[picker][location] = (pickerLocationCnt[picker][location]||0)+lineVal;

    (dayVol[si.sd] = dayVol[si.sd] || {lines:0,pcs:0,qty:0,pk:new Set()});
    dayVol[si.sd].lines += lineVal; dayVol[si.sd].pcs += pVal; dayVol[si.sd].qty += qVal; dayVol[si.sd].pk.add(picker);

    // group ต่อ (คน, วันของกะ, กะ) เพื่อคิด work-hours + OT
    const k = picker+'|'+si.sd+'|'+si.sh;
    const b = grp[k] || (grp[k] = {picker, sd:si.sd, sh:si.sh, pcs:0, q:0, n:0, mx:-1, mn:999999});
    b.pcs += pVal; b.q += qVal; b.n += lineVal; if(si.smMax > b.mx) b.mx = si.smMax; if(si.smMin < b.mn) b.mn = si.smMin;

    // แยกกลุ่มตาม Zone เพื่อคำนวณ Zone Productivity
    const zoneGrpKey = picker+'|'+si.sd+'|'+si.sh+'|'+zone;
    const zoneGroup = zoneGrp[zoneGrpKey] || (zoneGrp[zoneGrpKey] = {
      picker, sd:si.sd, sh:si.sh, zone, owner:zoneInfo.owner||'-', typePick:zoneInfo.typePick||'-',
      pcs:0, q:0, n:0, mx:-1, mn:999999
    });
    zoneGroup.pcs += pVal; zoneGroup.q += qVal; zoneGroup.n += lineVal; if(si.smMax > zoneGroup.mx) zoneGroup.mx = si.smMax; if(si.smMin < zoneGroup.mn) zoneGroup.mn = si.smMin;

    // แยกกลุ่มเพื่อวัด Productivity ตาม Owner และ Type Pick โดยใช้กติกาเวลาเดียวกับรายคน
    const ownerTypeKey = picker+'|'+si.sd+'|'+si.sh+'|'+zoneInfo.owner+'|'+zoneInfo.typePick;
    const ownerType = ownerTypeGrp[ownerTypeKey] || (ownerTypeGrp[ownerTypeKey] = {
      picker, sd:si.sd, sh:si.sh, owner:zoneInfo.owner || '-', typePick:zoneInfo.typePick || '-',
      pcs:0, q:0, n:0, mx:-1, mn:999999
    });
    ownerType.pcs += pVal; ownerType.q += qVal; ownerType.n += lineVal; if(si.smMax > ownerType.mx) ownerType.mx = si.smMax; if(si.smMin < ownerType.mn) ownerType.mn = si.smMin;

    // ผูกสังกัดจากรหัสพนักงานใน Sheet บันทึกเวลาทำงาน เพื่อสรุป Productivity และ OT รายสังกัด
    const affiliation = getPickerAffiliation(picker);
    const affiliationKey = picker+'|'+si.sd+'|'+si.sh+'|'+affiliation;
    const affiliationGroup = affiliationGrp[affiliationKey] || (affiliationGrp[affiliationKey] = {
      picker, sd:si.sd, sh:si.sh, affiliation,
      pcs:0, q:0, n:0, mx:-1, mn:999999
    });
    affiliationGroup.pcs += pVal; affiliationGroup.q += qVal; affiliationGroup.n += lineVal; if(si.smMax > affiliationGroup.mx) affiliationGroup.mx = si.smMax; if(si.smMin < affiliationGroup.mn) affiliationGroup.mn = si.smMin;

    // สรุปข้อมูลเจาะลึกรายบุคคล (Picker Drill-down: Zone, Time Slot, SKU)
    const pDrill = pickerDrilldownMap[picker] || (pickerDrilldownMap[picker] = {
      picker,
      name: getPickerName(picker),
      affiliation,
      dates: new Set(),
      byDate: {}
    });
    pDrill.dates.add(si.sd);
    const dRec = pDrill.byDate[si.sd] || (pDrill.byDate[si.sd] = {
      date: si.sd, pcs: 0, qty: 0, lines: 0, minMinutes: 999999, maxMinutes: -1,
      zones: {}, slots: {}, skus: {}
    });
    dRec.pcs += pVal; dRec.qty += qVal; dRec.lines += lineVal;
    if (si.smMin < dRec.minMinutes) dRec.minMinutes = si.smMin;
    if (si.smMax > dRec.maxMinutes) dRec.maxMinutes = si.smMax;

    (dRec.zones[zone] = dRec.zones[zone] || { pcs: 0, qty: 0, lines: 0 });
    dRec.zones[zone].pcs += pVal; dRec.zones[zone].qty += qVal; dRec.zones[zone].lines += lineVal;
  }

  // Master_Item เป็นฐานสินค้า: เริ่มทุก Owner+Item ที่มีใน Master ด้วยยอด 0
  Object.values(ITEM_MASTER).forEach(info => {
    itemMapAll[info.key] = {
      ...info, pcs:0, qty:0, lines:0, hasActivity:false,
      locations: new Set(), zones: new Set()
    };
  });
  // Pick Detail เป็นกิจกรรม นำมาแมปด้วย Owner + Item; รายการที่ไม่มีใน Master ยังแสดงเพื่อตรวจสอบได้
  forEachCurrentItemRow(system, from, to, sf, r => {
    // Location ต้องเก็บค่าจริงจาก Pick Detail/BigQuery ห้ามส่งผ่าน normalizeLocationCode()
    // เพราะฟังก์ชันนั้นตั้งใจใช้หา Zone master และจะตัดเหลือ 2 ตัวแรก
    const locName = String(r.location || '').trim().toUpperCase();
    const rawZone = String(r.zone || '').trim().toUpperCase();
    const zInfo = getZoneInfo(locName || rawZone);
    const zoneName = (rawZone && rawZone !== '-' && rawZone !== '??')
      ? rawZone
      : (zInfo.zone || normalizeLocationCode(locName));
    if(isZoneExcluded(zoneName)) return;

    const info = getItemInfo(r.owner, r.sku);
    const key = itemCompositeKey(r.owner, r.sku);
    const all = itemMapAll[key] || (itemMapAll[key] = {
      ...info, key, owner:normalizeOwnerKey(r.owner), sku:normalizeSkuKey(r.sku),
      pcs:0, qty:0, lines:0, hasActivity:false,
      locations: new Set(), zones: new Set()
    });
    if(!all.locations) all.locations = new Set();
    if(!all.zones) all.zones = new Set();
    if(locName && locName !== '-' && locName !== '??') all.locations.add(locName);
    if(zoneName && zoneName !== '-' && zoneName !== '??') all.zones.add(zoneName);

    all.pcs += r.pcs; all.qty += r.pickQty; all.lines += r.lines; all.hasActivity = all.hasActivity || r.lines > 0;
    if(!isSkuExcluded(r.sku, r.owner)) {
      const item = itemMap[key] || (itemMap[key] = {
        ...all, pcs:0, qty:0, lines:0, hasActivity:false,
        locations: new Set(), zones: new Set()
      });
      if(!item.locations) item.locations = new Set();
      if(!item.zones) item.zones = new Set();
      if(locName && locName !== '-' && locName !== '??') item.locations.add(locName);
      if(zoneName && zoneName !== '-' && zoneName !== '??') item.zones.add(zoneName);

      item.pcs += r.pcs; item.qty += r.pickQty; item.lines += r.lines; item.hasActivity = item.hasActivity || r.lines > 0;
    }
  });

  // Time-slot cube โหลดแบบ lazy รายวันและตัด SKU ที่ยกเว้นจาก BigQuery แล้ว
  forEachCurrentSlotRow(system, from, to, sf, r => {
    const sd = r.date;
    const zone = getZoneInfo(r.zone).zone;
    if(isZoneExcluded(zone)) return;
    const hr = r.hour;
    const slot = slotMap[hr] || (slotMap[hr] = {pcs:0,qty:0,lines:0});
    slot.pcs += r.pcs; slot.qty += r.pickQty; slot.lines += r.lines;

    const picker = r.picker;
    const pDrill = pickerDrilldownMap[picker];
    const dRec = pDrill && pDrill.byDate[sd];
    if(dRec){
      const dSlot = dRec.slots[hr] || (dRec.slots[hr] = {pcs:0,qty:0,lines:0});
      dSlot.pcs += r.pcs; dSlot.qty += r.pickQty; dSlot.lines += r.lines;
    }
  });

  function applyProductivityHours(g){
    g.ot = otHours(g.mx);
    if(g.n <= 0 || g.mn < 0 || g.mn > g.mx){
      g.wh = 0;
    }else{
      // ชั่วโมงที่ใช้หาร Productivity = ช่วงหยิบแรก–สุดท้ายที่ทับกับเวลาทำงานจริงเท่านั้น
      // จึงไม่นับพัก A 10:30–12:00 / 16:00–16:30 และ B 22:50–00:00 / 04:00–04:30
      g.wh = shiftWorkHoursBetween(g.sh, g.mn, g.mx);
    }
    g.countable = g.wh >= MIN_PRODUCTIVE_HOURS;
    g.prod = g.countable ? (g.q / g.wh) : 0;
    g.pcsProd = g.countable ? (g.pcs / g.wh) : 0;
  }

  const groups = Object.values(grp);
  groups.forEach(applyProductivityHours);
  const zoneGroups = Object.values(zoneGrp);
  zoneGroups.forEach(applyProductivityHours);
  const ownerTypeGroups = Object.values(ownerTypeGrp);
  ownerTypeGroups.forEach(applyProductivityHours);
  const affiliationGroups = Object.values(affiliationGrp);
  affiliationGroups.forEach(applyProductivityHours);
  const r1 = n => Math.round(n*10)/10;
  const mean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;
  const productiveGroups = groups.filter(g => g.countable);

  const byDate = {}, byDatePcs = {};
  productiveGroups.forEach(g => {
    (byDate[g.sd] = byDate[g.sd] || []).push(g.prod);
    (byDatePcs[g.sd] = byDatePcs[g.sd] || []).push(g.pcsProd);
  });
  const daily = Object.keys(dayVol).sort().map(d => ({
    date: d,
    lines: dayVol[d].lines,
    pcs: dayVol[d].pcs,
    qty: dayVol[d].qty,
    pickers: dayVol[d].pk.size,
    avg_prod: r1(mean(byDate[d]||[])),
    avg_pcs_prod: r1(mean(byDatePcs[d]||[]))
  }));

  const byPicker = {};
  groups.forEach(g => {
    const o = byPicker[g.picker] || (byPicker[g.picker] = {pcs:0,q:0,n:0,ot:0,prods:[],prodsPcs:[],sh:{},affiliation:getPickerAffiliation(g.picker)});
    o.pcs += g.pcs; o.q += g.q; o.n += g.n; o.ot += g.ot;
    if(g.countable){
      o.prods.push(g.prod);
      o.prodsPcs.push(g.pcsProd);
    }
    o.sh[g.sh] = (o.sh[g.sh]||0)+g.n;
  });
  const by_picker = Object.entries(byPicker).map(([picker,o]) => {
    const zc = pickerZoneCnt[picker] || {}; const zone = Object.keys(zc).sort((a,b)=>zc[b]-zc[a])[0] || '-';
    const lc = pickerLocationCnt[picker] || {}; const location = Object.keys(lc).sort((a,b)=>lc[b]-lc[a])[0] || '-';
    const shift = Object.keys(o.sh).sort((a,b)=>o.sh[b]-o.sh[a])[0] || '-';
    return {
      picker, name:getPickerName(picker), affiliation:o.affiliation, pcs:o.pcs, qty:o.q, lines:o.n, ot:r1(o.ot), shift,
      avg_prod: r1(mean(o.prods)),
      avg_pcs_prod: r1(mean(o.prodsPcs)),
      zone, location
    };
  }).sort((a,b)=>b.qty-a.qty);

  const by_zone = Object.entries(zoneMap).map(([zone,v])=>({
    zone, typePick:v.typePick, owner:v.owner, known:v.known,
    locations:[...v.locations].sort(), pcs:v.pcs, qty:v.qty, lines:v.lines, pickers:v.pk.size
  })).sort((a,b)=>b.qty-a.qty);
  const by_location = Object.values(locationMap).map(v=>({
    location:v.location, zone:v.zone, typePick:v.typePick, owner:v.owner, known:v.known,
    pcs:v.pcs, qty:v.qty, lines:v.lines, pickers:v.pk.size
  })).sort((a,b)=>b.qty-a.qty);
  function buildBreakdown(sourceGroups, keyName){
    const map = {};
    sourceGroups.forEach(g => {
      const key = String(g[keyName] || '-').trim() || '-';
      const out = map[key] || (map[key] = {
        name:key, pcs:0, qty:0, lines:0, hours:0, eligiblePcs:0, eligibleQty:0,
        productiveGroups:0, pickers:new Set(), productivePickers:new Set(), types:new Set(), owners:new Set(), avgValues:[], avgPcsValues:[]
      });
      out.pcs += g.pcs; out.qty += g.q; out.lines += g.n; out.pickers.add(g.picker);
      if (g.typePick) out.types.add(g.typePick);
      if (g.owner) out.owners.add(g.owner);
      if(g.countable){
        out.hours += g.wh;
        out.eligiblePcs += g.pcs;
        out.eligibleQty += g.q;
        out.productiveGroups++;
        out.productivePickers.add(g.picker);
        out.avgValues.push(g.prod);
        out.avgPcsValues.push(g.pcsProd);
      }
    });
    return Object.values(map).map(v => ({
      name:v.name, pcs:v.pcs, qty:v.qty, lines:v.lines,
      hours:r1(v.hours), eligiblePcs:v.eligiblePcs, eligibleQty:v.eligibleQty,
      productiveGroups:v.productiveGroups, pickers:v.pickers.size, productivePickers:v.productivePickers.size,
      types:[...v.types].sort(), owners:[...v.owners].sort(),
      avg_prod:r1(v.hours ? v.eligibleQty / v.hours : 0),
      avg_pcs_prod:r1(v.hours ? v.eligiblePcs / v.hours : 0),
      mean_prod:r1(mean(v.avgValues)), mean_pcs_prod:r1(mean(v.avgPcsValues))
    })).sort((a,b)=>{
      const aUnknown = a.name === '-' || a.name === 'ไม่พบใน Zone_V2' ? 1 : 0;
      const bUnknown = b.name === '-' || b.name === 'ไม่พบใน Zone_V2' ? 1 : 0;
      return (aUnknown - bUnknown) || (b.avg_prod-a.avg_prod) || (b.qty-a.qty) || a.name.localeCompare(b.name);
    });
  }
  const by_zone_prod = buildBreakdown(zoneGroups, 'zone');
  const by_owner = buildBreakdown(ownerTypeGroups, 'owner');
  const by_type_pick = buildBreakdown(ownerTypeGroups, 'typePick');
  const zone_prod_map = {};
  by_zone_prod.forEach(z => zone_prod_map[z.name] = z);

  const affiliationMap = {};
  const affiliationDailyMap = {};
  affiliationGroups.forEach(g => {
    const key = String(g.affiliation || 'ไม่พบสังกัด').trim() || 'ไม่พบสังกัด';
    const out = affiliationMap[key] || (affiliationMap[key] = {
      name:key, pcs:0, qty:0, lines:0, ot:0, hours:0,
      eligiblePcs:0, eligibleQty:0, productiveGroups:0,
      pickers:new Set(), productivePickers:new Set()
    });
    out.pcs += g.pcs; out.qty += g.q; out.lines += g.n; out.ot += g.ot; out.pickers.add(g.picker);
    if(g.countable){
      out.hours += g.wh;
      out.eligiblePcs += g.pcs;
      out.eligibleQty += g.q;
      out.productiveGroups++;
      out.productivePickers.add(g.picker);
    }

    const dailyKey = g.sd + '|' + key;
    const day = affiliationDailyMap[dailyKey] || (affiliationDailyMap[dailyKey] = {
      date:g.sd, name:key, pcs:0, qty:0, lines:0, ot:0, hours:0,
      eligiblePcs:0, eligibleQty:0, productiveGroups:0,
      pickers:new Set(), productivePickers:new Set()
    });
    day.pcs += g.pcs; day.qty += g.q; day.lines += g.n; day.ot += g.ot; day.pickers.add(g.picker);
    if(g.countable){
      day.hours += g.wh;
      day.eligiblePcs += g.pcs;
      day.eligibleQty += g.q;
      day.productiveGroups++;
      day.productivePickers.add(g.picker);
    }
  });
  const by_affiliation = Object.values(affiliationMap).map(v => ({
    name:v.name, pcs:v.pcs, qty:v.qty, lines:v.lines, ot:r1(v.ot), hours:r1(v.hours),
    eligiblePcs:v.eligiblePcs, eligibleQty:v.eligibleQty,
    productiveGroups:v.productiveGroups, pickers:v.pickers.size, productivePickers:v.productivePickers.size,
    avg_prod:r1(v.hours ? v.eligibleQty / v.hours : 0),
    avg_pcs_prod:r1(v.hours ? v.eligiblePcs / v.hours : 0)
  })).sort((a,b)=>{
    const aUnknown = a.name === 'ไม่พบสังกัด' ? 1 : 0;
    const bUnknown = b.name === 'ไม่พบสังกัด' ? 1 : 0;
    return (aUnknown - bUnknown) || (b.qty-a.qty) || a.name.localeCompare(b.name);
  });
  const affiliation_daily = Object.values(affiliationDailyMap).map(v => ({
    date:v.date, name:v.name, pcs:v.pcs, qty:v.qty, lines:v.lines, ot:r1(v.ot), hours:r1(v.hours),
    eligiblePcs:v.eligiblePcs, eligibleQty:v.eligibleQty,
    productiveGroups:v.productiveGroups, pickers:v.pickers.size, productivePickers:v.productivePickers.size,
    avg_prod:r1(v.hours ? v.eligibleQty / v.hours : 0),
    avg_pcs_prod:r1(v.hours ? v.eligiblePcs / v.hours : 0)
  })).sort((a,b)=>b.date.localeCompare(a.date) || (b.qty-a.qty) || a.name.localeCompare(b.name));
  function finalizeItemLocationFields(v){
    const locations = v.locations instanceof Set
      ? [...v.locations]
      : (Array.isArray(v.locations) ? [...v.locations] : []);
    const zones = v.zones instanceof Set
      ? [...v.zones]
      : (Array.isArray(v.zones) ? [...v.zones] : []);
    const cleanLocations = [...new Set(locations.map(x=>String(x||'').trim().toUpperCase()).filter(x=>x && x!=='-' && x!=='??'))].sort();
    const cleanZones = [...new Set(zones.map(x=>String(x||'').trim().toUpperCase()).filter(x=>x && x!=='-' && x!=='??'))].sort();
    return {
      ...v,
      locations:cleanLocations,
      zones:cleanZones,
      locationStr:cleanLocations.length ? cleanLocations.join(', ') : '-',
      zoneStr:cleanZones.length ? cleanZones.join(', ') : '-'
    };
  }
  const by_item = Object.values(itemMap)
    .filter(v => v.hasActivity || v.pcs !== 0 || v.qty !== 0 || v.lines !== 0)
    .map(v => ({...finalizeItemLocationFields(v), excluded:false}))
    .sort((a,b)=>b.qty-a.qty || b.pcs-a.pcs || a.owner.localeCompare(b.owner) || a.sku.localeCompare(b.sku));
  const by_item_all = Object.values(itemMapAll).map(v => ({
    ...finalizeItemLocationFields(v),
    excluded:isSkuExcluded(v.sku, v.owner),
    status:!v.inMaster ? 'NOT_IN_MASTER' : (v.hasActivity ? 'ACTIVE' : 'NO_ACTIVITY')
  })).sort((a,b)=>b.qty-a.qty || b.pcs-a.pcs || Number(b.hasActivity)-Number(a.hasActivity) || a.owner.localeCompare(b.owner) || a.sku.localeCompare(b.sku));

  const by_timeslot = Object.keys(slotMap).map(Number).sort((a,b)=>a-b).map(h=>({label:String(h).padStart(2,'0')+':00', pcs:slotMap[h].pcs, qty:slotMap[h].qty, lines:slotMap[h].lines}));

  const totOt = groups.reduce((s,g)=>s+g.ot,0);
  const result = {
    kpis: {
      lines, pcs, qty: pickQty, pickers: pickers.size, ot: r1(totOt),
      avg_prod: r1(mean(productiveGroups.map(g=>g.prod))),
      avg_pcs_prod: r1(mean(productiveGroups.map(g=>g.pcsProd)))
    },
    daily, by_zone, by_location, by_picker, by_zone_prod, zone_prod_map, by_owner, by_type_pick, by_affiliation, affiliation_daily, by_timeslot, by_item, by_item_all, picker_drilldown: pickerDrilldownMap
  };
  aggregateCache.set(cacheKey, result);
  return result;
}

// ยอดรวมของระบบตามช่วง+กะ (สแกนครั้งเดียวได้ทั้งชิ้นและหน่วยหยิบ)
function sysTotals(system, from, to, sf){
  const S = DATA[system], SH = S._sh || [];
  let pcs = 0, qty = 0, lines = 0;
  const rowCount = packedRowCount(S);
  for(let i=0;i<rowCount;i++){
    const si = SH[i];
    if(si && si.sd>=from && si.sd<=to && (sf==='all'||si.sh===sf)){
      const r = packedRowData(S, i);
      if(isZoneExcluded(getZoneInfo(r.zone).zone)) continue;
      pcs += r.pcs;
      qty += r.pickQty;
      lines += r.lines;
    }
  }
  return {pcs, qty, lines};
}

// ===== controls =====
function ensureStyles(){
  if(document.getElementById('dash-style')) return;
  const st = document.createElement('style'); st.id = 'dash-style';
  st.textContent = '.sysbar{display:flex;align-items:center;gap:12px 16px;margin:-6px 0 20px;flex-wrap:wrap}.sysbar .lab{font-size:13px;color:#64748b;font-weight:600;display:inline-flex;align-items:center;gap:4px}'
    + '.systog{display:inline-flex;background:#f1f5f9;border-radius:12px;padding:4px;border:1px solid #e2e8f0}'
    + '.systog button{border:0;background:transparent;font-family:inherit;font-size:13px;font-weight:600;color:#64748b;padding:8px 16px;border-radius:9px;cursor:pointer;transition:all .2s}'
    + '.systog button:hover{color:#1e293b}'
    + '.systog button.active{color:#fff;box-shadow:0 6px 14px -6px rgba(14,165,233,.6)}'
    + '.systog button.active[data-sys="PTT"]{background:linear-gradient(135deg,#0ea5e9,#2563eb)}'
    + '.systog button.active[data-sys="BPS"]{background:linear-gradient(135deg,#f59e0b,#ea580c)}'
    + '.shiftog button.active{background:linear-gradient(135deg,#8b5cf6,#6366f1)}'
    + '.unittog button.active{background:linear-gradient(135deg,#0d9488,#0284c7);color:#fff;box-shadow:0 6px 14px -6px rgba(13,148,136,.6)}'
    + '.datebar{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1px solid #cbd5e1;border-radius:12px;padding:6px 10px;box-shadow:0 4px 12px -8px rgba(30,41,59,.15)}'
    + '.datebar input[type=date]{font-family:inherit;font-size:12.5px;font-weight:600;color:#1e293b;border:1px solid #e2e8f0;border-radius:8px;padding:5px 8px;background:#f8fafc;cursor:pointer}'
    + '.datebar input[type=date]:focus{outline:0;border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,0.15)}'
    + '.datebar .sep{color:#94a3b8;font-size:13px;font-weight:700}'
    + '.datepreset{display:inline-flex;align-items:center;gap:10px;flex-wrap:nowrap;max-width:100%}'
    + '.preset-range-group{display:inline-flex;background:#f1f5f9;border-radius:12px;padding:3px;border:1px solid #e2e8f0;flex-shrink:0}'
    + '.preset-range-group button{border:0;background:transparent;font-family:inherit;font-size:12px;font-weight:600;color:#475569;padding:6px 12px;border-radius:9px;cursor:pointer;transition:all .2s}'
    + '.preset-range-group button:hover{color:#1e293b;background:rgba(255,255,255,0.6)}'
    + '.preset-range-group button.active{background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;font-weight:700;box-shadow:0 4px 12px -2px rgba(99,102,241,0.4)}'
    + '.calendar-dropdown-wrap{position:relative;display:inline-block}'
    + '.cal-dropdown-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid #cbd5e1;background:linear-gradient(135deg,#ffffff,#f8fafc);font-family:inherit;font-size:12.5px;font-weight:600;color:#1e293b;padding:6px 12px;border-radius:10px;cursor:pointer;transition:all .18s ease;box-shadow:0 2px 6px -2px rgba(0,0,0,0.06)}'
    + '.cal-dropdown-btn:hover{border-color:#6366f1;color:#4338ca;background:#f5f3ff;box-shadow:0 4px 12px -2px rgba(99,102,241,0.18)}'
    + '.cal-dropdown-btn.active{background:linear-gradient(135deg,#6366f1,#4f46e5);border-color:transparent;color:#ffffff;box-shadow:0 4px 14px -3px rgba(99,102,241,0.45)}'
    + '.cal-popover{position:absolute;top:calc(100% + 6px);left:0;z-index:1000;width:270px;background:#ffffff;border:1px solid #cbd5e1;border-radius:14px;padding:12px;box-shadow:0 16px 36px -8px rgba(15,23,42,0.2),0 4px 12px -2px rgba(0,0,0,0.05);backdrop-filter:blur(16px);animation:calPopIn .18s cubic-bezier(0.16,1,0.3,1)}'
    + '.cal-popover.hidden{display:none !important}'
    + '@keyframes calPopIn{from{opacity:0;transform:translateY(-6px) scale(0.96)}to{opacity:1;transform:translateY(0) scale(1)}}'
    + '.cal-pop-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}'
    + '.cal-month-title{font-size:13.5px;font-weight:700;color:#0f172a}'
    + '.cal-nav-btn{border:0;background:#f1f5f9;color:#475569;width:26px;height:26px;border-radius:7px;cursor:pointer;font-size:11px;display:inline-flex;align-items:center;justify-content:center;transition:all .15s}'
    + '.cal-nav-btn:hover{background:#6366f1;color:#fff}'
    + '.cal-weekdays{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center;font-size:11px;font-weight:700;color:#94a3b8;margin-bottom:6px}'
    + '.cal-days-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}'
    + '.cal-day-cell{aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#334155;border-radius:8px;cursor:pointer;position:relative;transition:all .15s ease;border:1px solid transparent}'
    + '.cal-day-cell:hover:not(.disabled){background:#eef2ff;color:#4338ca;border-color:#c7d2fe}'
    + '.cal-day-cell.has-data::after{content:\'\';position:absolute;bottom:3px;width:4px;height:4px;background:#10b981;border-radius:50%}'
    + '.cal-day-cell.selected{background:linear-gradient(135deg,#6366f1,#4338ca) !important;color:#ffffff !important;font-weight:700;box-shadow:0 4px 10px -2px rgba(99,102,241,0.5)}'
    + '.cal-day-cell.selected::after{background:#ffffff !important}'
    + '.cal-day-cell.disabled{color:#cbd5e1;cursor:not-allowed;opacity:0.4}'
    + '.cal-pop-foot{display:flex;gap:6px;margin-top:10px;padding-top:8px;border-top:1px solid #f1f5f9}'
    + '.cal-foot-btn{flex:1;border:1px solid #e2e8f0;background:#f8fafc;font-family:inherit;font-size:11px;font-weight:600;color:#475569;padding:5px;border-radius:7px;cursor:pointer;transition:all .15s}'
    + '.cal-foot-btn:hover{background:#6366f1;color:#fff;border-color:transparent}'
    + '.refreshbtn{display:inline-flex;align-items:center;gap:6px;border:1px solid #cbd5e1;background:#fff;font-family:inherit;font-size:12px;font-weight:600;color:#0369a1;padding:7px 14px;border-radius:10px;cursor:pointer;transition:all .18s;box-shadow:0 2px 6px -2px rgba(0,0,0,0.05)}'
    + '.refreshbtn:hover{border-color:#0284c7;background:#f0fdfa;transform:translateY(-1px)}'
    + '.freshtxt{font-size:11.5px;color:#94a3b8}'
    + '#loadov{position:fixed;inset:0;background:#f8fafc;display:flex;align-items:center;justify-content:center;z-index:999}#loadov .sp{width:38px;height:38px;border:4px solid #e2e8f0;border-top-color:#6366f1;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}#loadov .msg{margin-left:14px;font-size:14px;color:#475569;font-weight:500}';
  document.head.appendChild(st);
}

let calViewYear = 2026;
let calViewMonth = 7;
const TH_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

function initCalViewDate() {
  const refDate = (dfrom && dfrom !== DMIN) ? new Date(dfrom) : new Date(DMAX || Date.now());
  if (!isNaN(refDate.getTime())) {
    calViewYear = refDate.getFullYear();
    calViewMonth = refDate.getMonth();
  }
}

function renderCalPopoverGrid(bar) {
  const grid = bar.querySelector('#calDaysGrid');
  const monthTitle = bar.querySelector('#calMonthTitle');
  if (!grid || !monthTitle) return;

  monthTitle.textContent = `${TH_MONTHS_SHORT[calViewMonth]} ${calViewYear + 543}`;
  grid.innerHTML = '';

  const firstDay = new Date(calViewYear, calViewMonth, 1).getDay();
  const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();

  for (let i = 0; i < firstDay; i++) {
    const blank = document.createElement('div');
    blank.className = 'cal-day-cell disabled';
    grid.appendChild(blank);
  }

  const activeDatesSet = new Set(ALL_DATES);

  for (let day = 1; day <= daysInMonth; day++) {
    const mm = String(calViewMonth + 1).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    const dateStr = `${calViewYear}-${mm}-${dd}`;

    const cell = document.createElement('div');
    cell.className = 'cal-day-cell';
    cell.textContent = day;

    if (activeDatesSet.has(dateStr)) {
      cell.classList.add('has-data');
    }

    if (datePresetMode === 'day' && dfrom === dateStr && dto === dateStr) {
      cell.classList.add('selected');
    }

    if (dateStr < DMIN || dateStr > DMAX) {
      cell.classList.add('disabled');
    } else {
      cell.onclick = (e) => {
        e.stopPropagation();
        datePresetMode = 'day';
        trendMode = 'day';
        dfrom = dateStr;
        dto = dateStr;
        const fromEl = bar.querySelector('#dfrom'), toEl = bar.querySelector('#dto');
        if (fromEl) fromEl.value = dfrom;
        if (toEl) toEl.value = dto;
        closeCalPopover();
        setPresetActive();
        render();
      };
    }
    grid.appendChild(cell);
  }
}

function closeCalPopover() {
  const popover = document.querySelector('#calPopover');
  if (popover) popover.classList.add('hidden');
}

if (typeof window !== 'undefined' && !window.__calCloseListenerRegistered) {
  window.__calCloseListenerRegistered = true;
  document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.calendar-dropdown-wrap');
    if (wrap && !wrap.contains(e.target)) {
      closeCalPopover();
    }
  });
}

function buildControls(){
  ensureStyles();
  const old = document.querySelector('.sysbar'); if(old) old.remove();
  const rangeBtns = `<div class="preset-range-group"><button data-all="1">ทั้งหมด</button><button data-range="week">Weekly</button><button data-range="month">Monthly</button></div>`;
  const calDropdown = `
    <div class="calendar-dropdown-wrap">
      <button id="btnCalendarDropdown" class="cal-dropdown-btn" title="คลิกเพื่อเลือกปฏิทินรายวัน">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <span id="calDropdownText">📅 เลือกรายวัน</span>
        <span style="font-size:10px; opacity:0.7;">▼</span>
      </button>
      <div id="calPopover" class="cal-popover hidden">
        <div class="cal-pop-head">
          <button id="calPrevMonth" class="cal-nav-btn">◄</button>
          <span id="calMonthTitle" class="cal-month-title">ส.ค. 2569</span>
          <button id="calNextMonth" class="cal-nav-btn">►</button>
        </div>
        <div class="cal-weekdays">
          <span>อา</span><span>จ</span><span>อ</span><span>พ</span><span>พฤ</span><span>ศ</span><span>ส</span>
        </div>
        <div id="calDaysGrid" class="cal-days-grid"></div>
        <div class="cal-pop-foot">
          <button id="calSelectToday" class="cal-foot-btn">ล่าสุด (${DMAX ? DMAX.slice(8)+'/'+DMAX.slice(5,7) : 'วันนี้'})</button>
          <button id="calSelectAll" class="cal-foot-btn">ทั้งหมดในระบบ</button>
        </div>
      </div>
    </div>`;
  const datePresetGroup = `<div class="datepreset">${rangeBtns}${calDropdown}</div>`;
  const bar = document.createElement('div'); bar.className = 'sysbar';
  const targetUnitTxt = unitMode === 'pcs' ? 'ชิ้น/ชม.' : 'หยิบ/ชม.';
  bar.innerHTML =
    '<span class="lab">ระบบ:</span>'
    + '<div class="systog"><button data-sys="PTT">Pick (PTT)</button><button data-sys="BPS">Pick to Sort (BPS)</button></div>'
    + '<span class="lab">หน่วยที่แสดง:</span>'
    + '<div class="systog unittog"><button data-unit="units">📦 หน่วยหยิบ (Units)</button><button data-unit="pcs">🧩 จำนวนชิ้น (Pcs)</button></div>'
    + '<span class="lab">กะ:</span>'
    + '<div class="systog shiftog"><button data-sh="all">ทุกกะ</button><button data-sh="morning">🅰️ กะ A</button><button data-sh="night">🅱️ กะ B</button></div>'
    + '<span class="lab">🎯 เป้า Target:</span>'
    + `<div class="datebar" style="padding:3px 6px; display:inline-flex; align-items:center; gap:4px;">`
    + `<input type="number" id="prodTargetInput" value="${prodTarget}" min="1" max="1000" style="width:55px; font-weight:700; text-align:center;">`
    + `<span style="font-size:11px; color:#64748b; font-weight:600; margin-right:4px;">${targetUnitTxt}</span>`
    + `<button id="btnOpenTargetModal" style="border:0; background:linear-gradient(135deg,#0284c7,#2563eb); color:#fff; padding:4px 10px; border-radius:6px; font-size:11.5px; font-weight:700; cursor:pointer; transition:.15s; display:inline-flex; align-items:center; gap:4px;" title="คลิกเพื่อตั้งค่า Target ละเอียดจำแนกประเภท Rack/Zone">⚙️ ตั้งค่า Target</button>`
    + `</div>`
    + '<span class="lab">วันที่:</span>'
    + `<div class="datebar"><input type="date" id="dfrom" min="${DMIN}" max="${DMAX}" value="${dfrom}"><span class="sep">→</span><input type="date" id="dto" min="${DMIN}" max="${DMAX}" value="${dto}"></div>`
    + datePresetGroup
    + '<button class="refreshbtn" id="refreshBtn">↻ รีเฟรช</button>'
    + '<button class="refreshbtn" id="exportPdfBtn" style="color:#4338ca; border-color:#c7d2fe; background:#eef2ff;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg> 📄 Export PDF</button>'
    + '<span class="freshtxt" id="freshTxt"></span>';
  document.querySelector('.pagehead').insertAdjacentElement('afterend', bar);

  const targetInp = bar.querySelector('#prodTargetInput');
  if (targetInp) {
    targetInp.onchange = () => {
      const val = Number(targetInp.value);
      if (Number.isFinite(val) && val > 0) {
        saveProdTargetToStorage(val);
        render();
      }
    };
  }

  const btnTargetModal = bar.querySelector('#btnOpenTargetModal');
  if (btnTargetModal) {
    btnTargetModal.onclick = () => openTargetSettingsModal();
  }

  const btnPdf = bar.querySelector('#exportPdfBtn');
  if (btnPdf) {
    btnPdf.onclick = () => {
      exportPDF();
    };
  }

  bar.querySelectorAll('.systog:not(.shiftog):not(.unittog) button').forEach(b => { b.classList.toggle('active', b.dataset.sys===sys); b.onclick = async () => {
    const nextSystem = b.dataset.sys;
    if(nextSystem === sys) return;
    if(!hasCurrentItemCube(nextSystem) || !hasCurrentSlotCube(nextSystem)){
      showLoading(true, `กำลังเตรียมข้อมูล ${nextSystem} ให้ครบทุกหน้า…`);
      dashboardBundleLoading = true;
      try{
        const [itemPayload, slotPayload] = await Promise.all([
          loadCurrentItemCube(false, nextSystem),
          loadCurrentSlotCube(false, nextSystem)
        ]);
        if(!itemPayload || !slotPayload) {
          const itemState = itemCubeLoadState.get(itemCubeRequestKey(nextSystem));
          const slotState = slotCubeLoadState.get(slotCubeRequestKey(nextSystem));
          const reason = [itemState && itemState.message, slotState && slotState.message].filter(Boolean).join(' / ');
          setSideBadge(`ข้อมูล ${nextSystem} ยังมาไม่ครบ\n${reason || 'กรุณากดลองสลับระบบอีกครั้ง'}`);
          return;
        }
      }finally{
        dashboardBundleLoading = false;
        showLoading(false);
      }
    }
    sys = nextSystem;
    bar.querySelectorAll('.systog:not(.shiftog):not(.unittog) button').forEach(x => x.classList.toggle('active', x.dataset.sys === sys));
    render();
  };});
  bar.querySelectorAll('.unittog button').forEach(b => { b.classList.toggle('active', b.dataset.unit===unitMode); b.onclick = () => {
    if(b.dataset.unit === unitMode) return; unitMode = b.dataset.unit;
    bar.querySelectorAll('.unittog button').forEach(x => x.classList.toggle('active', x.dataset.unit === unitMode));
    render();
  };});
  bar.querySelectorAll('.shiftog button').forEach(b => { b.classList.toggle('active', b.dataset.sh===shiftF); b.onclick = () => {
    if(b.dataset.sh === shiftF) return; shiftF = b.dataset.sh;
    bar.querySelectorAll('.shiftog button').forEach(x => x.classList.toggle('active', x.dataset.sh === shiftF));
    render();
  };});

  const fromEl = bar.querySelector('#dfrom'), toEl = bar.querySelector('#dto');
  const btnCalDrop = bar.querySelector('#btnCalendarDropdown');
  const popover = bar.querySelector('#calPopover');
  const calDropdownText = bar.querySelector('#calDropdownText');

  if (btnCalDrop && popover) {
    btnCalDrop.onclick = (e) => {
      e.stopPropagation();
      const isHidden = popover.classList.contains('hidden');
      if (isHidden) {
        initCalViewDate();
        renderCalPopoverGrid(bar);
        popover.classList.remove('hidden');
      } else {
        popover.classList.add('hidden');
      }
    };

    const btnPrev = bar.querySelector('#calPrevMonth');
    if (btnPrev) {
      btnPrev.onclick = (e) => {
        e.stopPropagation();
        calViewMonth--;
        if (calViewMonth < 0) { calViewMonth = 11; calViewYear--; }
        renderCalPopoverGrid(bar);
      };
    }

    const btnNext = bar.querySelector('#calNextMonth');
    if (btnNext) {
      btnNext.onclick = (e) => {
        e.stopPropagation();
        calViewMonth++;
        if (calViewMonth > 11) { calViewMonth = 0; calViewYear++; }
        renderCalPopoverGrid(bar);
      };
    }

    const btnToday = bar.querySelector('#calSelectToday');
    if (btnToday) {
      btnToday.onclick = (e) => {
        e.stopPropagation();
        datePresetMode = 'day';
        trendMode = 'day';
        dfrom = DMAX; dto = DMAX;
        fromEl.value = dfrom; toEl.value = dto;
        popover.classList.add('hidden');
        setPresetActive();
        render();
      };
    }

    const btnAll = bar.querySelector('#calSelectAll');
    if (btnAll) {
      btnAll.onclick = (e) => {
        e.stopPropagation();
        datePresetMode = 'all';
        dfrom = DMIN; dto = DMAX;
        fromEl.value = dfrom; toEl.value = dto;
        popover.classList.add('hidden');
        setPresetActive();
        render();
      };
    }
  }

  function setPresetActive(){
    bar.querySelectorAll('.datepreset button').forEach(x=>x.classList.remove('active'));
    if(datePresetMode === 'all'){ const a=bar.querySelector('.datepreset button[data-all]'); if(a) a.classList.add('active'); }
    else if(datePresetMode === 'week' || datePresetMode === 'month'){
      const r=bar.querySelector(`.datepreset button[data-range="${datePresetMode}"]`);
      if(r) r.classList.add('active');
    }

    if(datePresetMode === 'day' && dfrom===dto){
      if(btnCalDrop) btnCalDrop.classList.add('active');
      if(calDropdownText) calDropdownText.textContent = `📅 ${dfrom.slice(8)}/${dfrom.slice(5,7)}`;
    } else {
      if(btnCalDrop) btnCalDrop.classList.remove('active');
      if(calDropdownText) calDropdownText.textContent = '📅 เลือกรายวัน';
    }
  }
  function applyDates(){ if(dfrom > dto){ const t=dfrom; dfrom=dto; dto=t; fromEl.value=dfrom; toEl.value=dto; } setPresetActive(); render(); }
  fromEl.onchange = () => { datePresetMode = 'custom'; dfrom = fromEl.value || DMIN; applyDates(); };
  toEl.onchange   = () => { datePresetMode = 'custom'; dto   = toEl.value   || DMAX; applyDates(); };
  bar.querySelectorAll('.datepreset button').forEach(b => b.onclick = () => {
    if(b.dataset.all){
      datePresetMode = 'all';
      dfrom=DMIN; dto=DMAX;
    } else if(b.dataset.range) {
      datePresetMode = b.dataset.range;
      trendMode = b.dataset.range;
      const next = rangeForPeriod(b.dataset.range, DMAX);
      dfrom = next.from; dto = next.to;
    } else {
      datePresetMode = 'day';
      trendMode = 'day';
      dfrom=b.dataset.d; dto=b.dataset.d;
    }
    fromEl.value=dfrom; toEl.value=dto; setPresetActive(); render();
  });
  setPresetActive();
  bar.querySelector('#refreshBtn').onclick = () => loadData(true);
  updateFresh();
}

let lastFetchTime = null;

function updateFresh(){
  const el = document.getElementById('freshTxt'); if(!el) return;
  const g = lastFetchTime || (DATA.meta && DATA.meta.generated);
  const rows = DATA.meta && DATA.meta.rows;
  if(g){
    const dt = new Date(g);
    const rowTxt = rows ? (' (สด BigQuery ' + fmt(rows) + ' รายการ)') : '';
    el.textContent = 'ข้อมูล ณ ' + dt.toLocaleString('th-TH', {dateStyle:'medium', timeStyle:'short'}) + rowTxt;
  }
  else el.textContent = '';
}

function updateDateHeader(){
  const el = document.getElementById('daterange'); if(!el) return;
  const shTxt = shiftF==='all' ? '' : ' · '+SHIFT_LABEL[shiftF];
  el.innerHTML = (dfrom===dto ? 'ช่วงข้อมูล: <b>'+dfrom+'</b>' : 'ช่วงข้อมูล: <b>'+dfrom+'</b> ถึง <b>'+dto+'</b>') + shTxt;
}

// ===== KPI cards =====
function renderKPIs(){
  const k = A.kpis;
  const isPcs = unitMode === 'pcs';
  const defs = [
    {
      lbl: isPcs ? 'ปริมาณชิ้นรวม (QTY เดิม) ★' : 'จำนวนชิ้นรวม (QTY เดิม)',
      val: k.pcs,
      unit: 'ชิ้น',
      grad: isPcs ? 'linear-gradient(90deg,#14b8a6,#0ea5e9)' : 'linear-gradient(90deg,#94a3b8,#cbd5e1)'
    },
    {
      lbl: !isPcs ? 'หน่วยหยิบรวม (BigQuery) ★' : 'หน่วยหยิบรวม (BigQuery)',
      val: k.qty,
      unit: 'หน่วยหยิบ',
      grad: !isPcs ? 'linear-gradient(90deg,#3b82f6,#6366f1)' : 'linear-gradient(90deg,#94a3b8,#cbd5e1)'
    },
    {lbl:'พนักงานหยิบ', val:k.pickers, unit:'คน', grad:'linear-gradient(90deg,#f59e0b,#f97316)'},
    {
      lbl: isPcs ? 'Productivity (ชิ้น/ชม.)' : 'Productivity (หยิบ/ชม.)',
      val: isPcs ? k.avg_pcs_prod : k.avg_prod,
      unit: isPcs ? 'ชิ้น/ชม.' : 'หยิบ/ชม.',
      grad: 'linear-gradient(90deg,#f43f5e,#ec4899)'
    },
    {lbl:'OT รวม', val:k.ot, unit:'ชม.', grad:'linear-gradient(90deg,#10b981,#22c55e)'}
  ];
  const kw = document.getElementById('kpis'); kw.innerHTML = '';
  defs.forEach(d => {
    const e = document.createElement('div'); e.className = 'kpi';
    e.innerHTML = '<div class="bar" style="background:'+d.grad+'"></div><div class="lbl">'+d.lbl+'</div><div class="val"><span class="num" data-t="'+d.val+'">0</span><span class="unit">'+d.unit+'</span></div>';
    kw.appendChild(e);
  });
  countUp();
  renderTargetAlertBanner();
}

function renderTargetAlertBanner(){
  let alertBox = document.getElementById('prodTargetAlertBanner');
  if (!alertBox) {
    alertBox = document.createElement('div');
    alertBox.id = 'prodTargetAlertBanner';
    const kw = document.getElementById('kpis');
    if (kw && kw.parentNode) {
      kw.parentNode.insertBefore(alertBox, kw.nextSibling);
    }
  }

  const isPcs = unitMode === 'pcs';
  const currentProd = isPcs ? (A.kpis.avg_pcs_prod || 0) : (A.kpis.avg_prod || 0);
  const unitTxt = isPcs ? 'ชิ้น/ชม.' : 'หยิบ/ชม.';
  const isBelow = currentProd < prodTarget;

  if (isBelow) {
    const diff = (prodTarget - currentProd).toFixed(1);
    alertBox.className = 'card wide';
    alertBox.style.cssText = 'margin-top:14px; margin-bottom:18px; background:#fff5f5; border:1px solid #fecaca; border-left:6px solid #ef4444; padding:14px 18px; box-shadow:0 4px 14px rgba(239,68,68,0.12); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;';
    alertBox.innerHTML = `
      <div style="display:flex; align-items:center; gap:12px;">
        <span style="font-size:26px;">🚨</span>
        <div>
          <div style="font-weight:700; color:#991b1b; font-size:15px; display:flex; align-items:center; gap:8px;">
            <span>แจ้งเตือน: Productivity เฉลี่ยต่ำกว่าเป้าหมาย!</span>
            <span style="background:#ef4444; color:#fff; font-size:11px; padding:2px 8px; border-radius:6px; font-weight:700;">ต่ำกว่าเป้า ${diff} ${unitTxt}</span>
          </div>
          <div style="font-size:12.5px; color:#b91c1c; margin-top:3px;">
            ค่าปัจจุบัน: <b style="font-size:14px;">${currentProd}</b> ${unitTxt} · เป้าหมายที่ตั้งไว้: <b>${prodTarget}</b> ${unitTxt}
          </div>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="background:#fee2e2; color:#991b1b; padding:6px 12px; border-radius:8px; font-size:12px; font-weight:700; border:1px solid #fca5a5;">⚠️ ต้องการการปรับปรุงกระบวนการหยิบ</span>
      </div>`;
  } else {
    alertBox.className = 'card wide';
    alertBox.style.cssText = 'margin-top:14px; margin-bottom:18px; background:#f0fdf4; border:1px solid #bbf7d0; border-left:6px solid #16a34a; padding:12px 18px; box-shadow:0 4px 14px rgba(22,163,74,0.08); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;';
    alertBox.innerHTML = `
      <div style="display:flex; align-items:center; gap:12px;">
        <span style="font-size:24px;">🎯</span>
        <div>
          <div style="font-weight:700; color:#15803d; font-size:14.5px; display:flex; align-items:center; gap:8px;">
            <span>Productivity เฉลี่ยบรรลุตามเป้าหมาย!</span>
            <span style="background:#16a34a; color:#fff; font-size:11px; padding:2px 8px; border-radius:6px; font-weight:700;">ผ่านเกณฑ์</span>
          </div>
          <div style="font-size:12px; color:#166534; margin-top:2px;">
            ค่าปัจจุบัน: <b style="font-size:13.5px;">${currentProd}</b> ${unitTxt} · เป้าหมายที่ตั้งไว้: <b>${prodTarget}</b> ${unitTxt}
          </div>
        </div>
      </div>
      <div style="background:#dcfce7; color:#15803d; padding:5px 12px; border-radius:8px; font-size:12px; font-weight:700;">✅ การปฏิบัติงานได้ตามมาตรฐาน</div>`;
  }
}
function countUp(){
  document.querySelectorAll('#kpis .num[data-t]').forEach(el => {
    if(el.dataset.done) return;
    const rawT = Number(el.dataset.t);
    if(!Number.isFinite(rawT)) return;
    el.dataset.done = '1';
    if(el._countUpTimer) clearInterval(el._countUpTimer);
    const t = Math.ceil(rawT);
    let c = 0;
    const step = t / 45;
    if(t <= 0){
      el.textContent = fmt(Math.ceil(rawT));
      return;
    }
    el._countUpTimer = setInterval(() => {
      c += step;
      if(c >= t){
        c = t;
        clearInterval(el._countUpTimer);
        el._countUpTimer = null;
      }
      el.textContent = fmt(Math.ceil(c));
    }, 18);
  });
}

// ===== Individual Picker Drill-down Renderer =====
let selectedPickerId = '';
let selectedPickerDate = 'all';
const pickerItemPayloadCache = new Map();
const pickerItemLoadState = new Map();
const itemMasterPayloadCache = new Map();
const itemMasterLoadState = new Map();
const itemCubePayloadCache = new Map();
const itemCubeLoadState = new Map();
const itemCubeDailyPayloadCache = new Map();
const slotCubePayloadCache = new Map();
const slotCubeLoadState = new Map();
const slotCubeDailyPayloadCache = new Map();
let dashboardBundleLoading = false;

function dashboardDataEpoch(){
  const parts = String(dashboardCacheRevision || '0').split(':');
  return parts.length >= 2 ? parts.slice(0, 2).join(':') : parts[0];
}

function canonicalCubeScope(system = sys, from = dfrom, to = dto){
  return {
    system,
    from: DMIN || from,
    to: DMAX || to,
    shift: 'all'
  };
}
function itemCubeRequestKey(system = sys, from = dfrom, to = dto){
  const scope = canonicalCubeScope(system, from, to);
  return [dashboardDataEpoch(), scope.system, scope.from, scope.to, scope.shift,
    JSON.stringify(currentExcludedItemList())].join('|');
}
function isValidItemCubePayload(payload, system, from, to, shift, expectedEpoch = dashboardDataEpoch()){
  return !!payload && payload.schema_version === DASHBOARD_SCHEMA_VERSION &&
    String(payload.data_epoch || '') === String(expectedEpoch || '') &&
    payload.system === system && payload.from === from && payload.to === to &&
    payload.shift === shift && Number(payload.row_width) === 9 &&
    Array.isArray(payload.rows) && payload.rows.length % 9 === 0;
}
function dailyCubeRequestKey(kind, system, date, sf){
  return [kind, dashboardDataEpoch(), system, date, sf,
    (kind === 'slot' || kind === 'item') ? JSON.stringify(currentExcludedItemList()) : ''].join('|');
}

function cubeRequestDates(system, from, to){
  const dates = DATA && DATA[system] && Array.isArray(DATA[system].dates) ? DATA[system].dates : [];
  const selected = dates.filter(date => date >= from && date <= to);
  return selected.length ? selected : [from];
}

async function runWithConcurrency(tasks, limit = 3){
  const results = new Array(tasks.length);
  let cursor = 0;
  async function worker(){
    while(cursor < tasks.length){
      const index = cursor++;
      results[index] = await tasks[index]();
    }
  }
  const workers = [];
  for(let i=0; i<Math.min(limit, tasks.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

function itemMasterRequestKey(){
  return dashboardDataEpoch();
}

function isValidItemMasterPayload(payload, expectedEpoch = dashboardDataEpoch()){
  return !!payload && payload.schema_version === DASHBOARD_SCHEMA_VERSION &&
    String(payload.data_epoch || '') === String(expectedEpoch || '') &&
    Number(payload.row_width) === 9 && Array.isArray(payload.rows) && payload.rows.length % 9 === 0;
}

function applyItemMasterPayload(payload){
  if(!isValidItemMasterPayload(payload)) throw new Error('รูปแบบ Master_Item ไม่ตรงกับหน้าเว็บ');
  const exact = Object.create(null);
  const bySku = Object.create(null);
  for(let o=0; o<payload.rows.length; o+=9){
    const owner = normalizeOwnerKey(payload.rows[o]);
    const item = normalizeSkuKey(payload.rows[o+1]);
    if(!item) continue;
    const record = {
      key:itemCompositeKey(owner, item), owner, sku:item, item,
      name:String(payload.rows[o+2] || item), pickType:String(payload.rows[o+3] || ''),
      itemPack:String(payload.rows[o+4] || ''),
      pickPackSize:payload.rows[o+5] == null ? null : Number(payload.rows[o+5]),
      casePackSize:payload.rows[o+6] == null ? null : Number(payload.rows[o+6]),
      uomDivisor:payload.rows[o+7] == null ? null : Number(payload.rows[o+7]),
      matchStatus:String(payload.rows[o+8] || ''), inMaster:true
    };
    exact[record.key] = record;
    (bySku[item] = bySku[item] || []).push(record);
  }
  ITEM_MASTER = exact;
  ITEM_MASTER_BY_SKU = bySku;
  return Object.keys(exact).length;
}

async function loadItemMaster(force){
  if(!DATA_URL || !dashboardCacheRevision) return null;
  const requestKey = itemMasterRequestKey();
  const state = itemMasterLoadState.get(requestKey);
  if(state && state.status === 'loading') return state.promise;
  if(!force && itemMasterPayloadCache.has(requestKey)){
    const payload = itemMasterPayloadCache.get(requestKey);
    applyItemMasterPayload(payload);
    return payload;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  const task = (async () => {
    try{
      if(!force){
        const cached = await readDashboardCubeCache('itemmaster', requestKey);
        if(isValidItemMasterPayload(cached)){
          itemMasterPayloadCache.set(requestKey, cached);
          applyItemMasterPayload(cached);
          itemMasterLoadState.set(requestKey, {status:'done'});
          return cached;
        }
      }
      const query = ['mode=item_master', dashboardResponseEncodingQuery(), 't=' + Date.now()].join('&');
      const payload = await fetchDashboardCubeJson(
        DATA_URL + (DATA_URL.includes('?') ? '&' : '?') + query,
        {cache:'no-store', signal:controller.signal}
      );
      if(!isValidItemMasterPayload(payload)) throw dashboardTransientError('Master_Item เปลี่ยนระหว่างโหลด กรุณาลองใหม่อีกครั้ง');
      itemMasterPayloadCache.set(requestKey, payload);
      applyItemMasterPayload(payload);
      await writeDashboardCubeCache('itemmaster', requestKey, payload);
      itemMasterLoadState.set(requestKey, {status:'done'});
      aggregateCache.clear();
      delete built['items'];
      if(!dashboardBundleLoading && (currentPage === 'items' || currentPage === 'pickers')) render();
      return payload;
    }catch(err){
      const message = err && err.name === 'AbortError' ? 'โหลด Master_Item ใช้เวลานานเกิน 1 นาที' : String(err && err.message || err);
      itemMasterLoadState.set(requestKey, {status:'error', message, code:String(err && err.code || '')});
      return null;
    }finally{ clearTimeout(timeout); }
  })();
  itemMasterLoadState.set(requestKey, {status:'loading', promise:task});
  return task;
}

function hasCurrentItemCube(system = sys, from = dfrom, to = dto, sf = shiftF){
  if(itemCubePayloadCache.has(itemCubeRequestKey(system, from, to, sf))) return true;
  const source = DATA && DATA[system];
  return packedItemRowCount(source) > 0;
}
function forEachCurrentItemRow(system, from, to, sf, callback){
  const payload = itemCubePayloadCache.get(itemCubeRequestKey(system, from, to, sf));
  if(payload){
    const rows = payload.rows;
    const width = Number(payload.row_width) || 9;
    if(width === 9) {
      for(let offset=0; offset<rows.length; offset+=9){
        const date = String(rows[offset] || '');
        const shift = Number(rows[offset + 1]) === 1 ? 'night' : 'morning';
        if(date < from || date > to || (sf !== 'all' && shift !== sf)) continue;
        callback({
          date, shift,
          location: rows[offset + 2],
          zone: rows[offset + 3],
          owner: normalizeOwnerKey(rows[offset + 4]),
          sku: normalizeSkuKey(rows[offset + 5]) || '(none)',
          pcs: Number(rows[offset + 6]) || 0,
          pickQty: readBigQueryPickQty(rows[offset + 7]),
          lines: Number(rows[offset + 8]) || 0
        });
      }
      return true;
    }
    for(let offset=0; offset<rows.length; offset+=8){
      const date = String(rows[offset] || '');
      const shift = Number(rows[offset + 1]) === 1 ? 'night' : 'morning';
      if(date < from || date > to || (sf !== 'all' && shift !== sf)) continue;
      callback({
        date, shift,
        location: rows[offset + 2],
        zone: rows[offset + 2],
        owner: normalizeOwnerKey(rows[offset + 3]),
        sku: normalizeSkuKey(rows[offset + 4]) || '(none)',
        pcs: Number(rows[offset + 5]) || 0,
        pickQty: readBigQueryPickQty(rows[offset + 6]),
        lines: Number(rows[offset + 7]) || 0
      });
    }
    return true;
  }

  const source = DATA && DATA[system];
  const count = packedItemRowCount(source);
  for(let i=0; i<count; i++){
    const row = packedItemRowData(source, i);
    const date = source.dates[row.dateIdx];
    const shift = row.shiftCode === 1 ? 'night' : 'morning';
    if(date < from || date > to || (sf !== 'all' && shift !== sf)) continue;
    callback({
      date, shift,
      location: row.zone,
      zone: row.zone,
      owner: normalizeOwnerKey(row.owner),
      sku: normalizeSkuKey(source.skus[row.skuIdx]) || '(none)',
      pcs: row.pcs, pickQty: row.pickQty, lines: row.lines
    });
  }
  return count > 0;
}

function waitForRetry(ms, signal){
  return new Promise((resolve, reject) => {
    if(signal && signal.aborted){
      const err = new Error('Request aborted'); err.name = 'AbortError'; reject(err); return;
    }
    const timer = setTimeout(resolve, ms);
    if(signal) signal.addEventListener('abort', () => {
      clearTimeout(timer);
      const err = new Error('Request aborted'); err.name = 'AbortError'; reject(err);
    }, {once:true});
  });
}

async function fetchWithTransientRetry(url, options, retries = 1){
  const transientStatuses = new Set([404, 408, 429, 500, 502, 503, 504]);
  const reqOptions = Object.assign({ credentials: 'omit' }, options);
  let lastError = null;
  for(let attempt=0; attempt<=retries; attempt++){
    try{
      const response = await fetch(url, reqOptions);
      if(response.ok || !transientStatuses.has(response.status) || attempt === retries) return response;
      lastError = new Error('HTTP ' + response.status);
    }catch(err){
      if(err && err.name === 'AbortError') throw err;
      lastError = err;
      if(attempt === retries) throw err;
    }
    await waitForRetry(1200 * (attempt + 1), options && options.signal);
  }
  throw lastError || new Error('เชื่อมต่อไม่สำเร็จ');
}

function dashboardResponseEncodingQuery(){
  return typeof DecompressionStream !== 'undefined' ? 'encoding=gzip' : 'encoding=plain';
}

async function readDashboardJsonResponse(response){
  const outerText = await response.text();
  let payload;
  try{
    payload = JSON.parse(outerText);
  }catch(_){
    throw new Error('Apps Script ตอบกลับมาไม่ใช่ข้อมูล JSON');
  }
  if(payload && payload.encoding === 'gzip-base64-v1' && typeof payload.data === 'string'){
    try{
      const binary = atob(payload.data);
      const bytes = new Uint8Array(binary.length);
      for(let i=0; i<binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const decompressed = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      const body = await new Response(decompressed).text();
      return {payload:JSON.parse(body), body};
    }catch(_){
      throw new Error('เปิดข้อมูล Dashboard ที่บีบอัดไม่สำเร็จ กรุณากดรีเฟรชอีกครั้ง');
    }
  }
  return {payload, body:outerText};
}

async function fetchDashboardCubeJson(url, options){
  const transientCodes = new Set(['DATA_EPOCH_CHANGED','DASHBOARD_UPDATE_BUSY']);
  let lastError = null;
  for(let attempt=0; attempt<3; attempt++){
    const response = await fetchWithTransientRetry(url, options, 2);
    if(!response.ok) throw new Error('HTTP ' + response.status);
    const payload = (await readDashboardJsonResponse(response)).payload;
    if(!payload || !payload.error) return payload;
    const err = new Error(String(payload.error));
    err.code = String(payload.code || 'DASHBOARD_RESPONSE_ERROR');
    lastError = err;
    if(!transientCodes.has(err.code) || attempt === 2) throw err;
    await waitForRetry(1000 * (attempt + 1), options && options.signal);
  }
  throw lastError || new Error('โหลดข้อมูล Dashboard ไม่สำเร็จ');
}

function dashboardTransientError(message, code = 'DATA_EPOCH_CHANGED'){
  const err = new Error(message);
  err.code = code;
  return err;
}

async function fetchDailyItemCube(system, date, shift, signal, force){
  const dailyKey = dailyCubeRequestKey('item', system, date, shift);
  const requestEpoch = dashboardDataEpoch();
  if(!force && itemCubeDailyPayloadCache.has(dailyKey)) return itemCubeDailyPayloadCache.get(dailyKey);
  const query = [
    'mode=item_cube',
    'system=' + encodeURIComponent(system),
    'from=' + encodeURIComponent(date),
    'to=' + encodeURIComponent(date),
    'shift=' + encodeURIComponent(shift),
    dashboardResponseEncodingQuery(),
    dashboardScopeQuery(),
    't=' + Date.now()
  ].join('&');
  const payload = await fetchDashboardCubeJson(
    DATA_URL + (DATA_URL.includes('?') ? '&' : '?') + query,
    {cache:'no-store', signal}
  );
  if(!payload || payload.schema_version !== DASHBOARD_SCHEMA_VERSION ||
      String(payload.data_epoch || '') !== String(requestEpoch || '') ||
      payload.system !== system || payload.from !== date || payload.to !== date ||
      payload.shift !== shift || Number(payload.row_width) !== 9 ||
      !Array.isArray(payload.rows) || payload.rows.length % 9 !== 0){
    throw dashboardTransientError('ข้อมูลสินค้าเปลี่ยนระหว่างโหลด กรุณาลองใหม่อีกครั้ง');
  }
  itemCubeDailyPayloadCache.set(dailyKey, payload);
  while(itemCubeDailyPayloadCache.size > 80) itemCubeDailyPayloadCache.delete(itemCubeDailyPayloadCache.keys().next().value);
  return payload;
}

async function loadCurrentItemCube(force, system = sys){
  if(!DATA_URL || !dfrom || !dto) return;
  const requestSystem = system;
  const scope = canonicalCubeScope(requestSystem, dfrom, dto);
  const requestFrom = scope.from;
  const requestTo = scope.to;
  const requestShift = scope.shift;
  const requestEpoch = dashboardDataEpoch();
  const requestKey = itemCubeRequestKey(requestSystem, requestFrom, requestTo, requestShift);
  const currentState = itemCubeLoadState.get(requestKey);
  if(!force && currentState && currentState.status === 'loading') return currentState.promise;
  if(!force && itemCubePayloadCache.has(requestKey)) return itemCubePayloadCache.get(requestKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  const task = (async () => {
    try{
      await loadItemMaster(false);
      if(!force){
        const cached = await readDashboardCubeCache('item', requestKey);
        if(isValidItemCubePayload(cached, requestSystem, requestFrom, requestTo, requestShift, requestEpoch)){
          itemCubePayloadCache.set(requestKey, cached);
          itemCubeLoadState.set(requestKey, {status:'done'});
          return cached;
        }
      }
      const query = [
        'mode=item_cube',
        'system=' + encodeURIComponent(requestSystem),
        'from=' + encodeURIComponent(requestFrom),
        'to=' + encodeURIComponent(requestTo),
        'shift=' + encodeURIComponent(requestShift),
        dashboardResponseEncodingQuery(),
        dashboardScopeQuery(),
        't=' + Date.now()
      ].join('&');
      const payload = await fetchDashboardCubeJson(
        DATA_URL + (DATA_URL.includes('?') ? '&' : '?') + query,
        {cache:'no-store', signal:controller.signal}
      );
      if(!isValidItemCubePayload(payload, requestSystem, requestFrom, requestTo, requestShift, requestEpoch)){
        throw dashboardTransientError('ข้อมูลสินค้าเปลี่ยนระหว่างโหลด กรุณาลองใหม่อีกครั้ง');
      }
      itemCubePayloadCache.set(requestKey, payload);
      await writeDashboardCubeCache('item', requestKey, payload);
      while(itemCubePayloadCache.size > 8) itemCubePayloadCache.delete(itemCubePayloadCache.keys().next().value);
      itemCubeLoadState.set(requestKey, {status:'done'});
      if(itemCubeRequestKey() === requestKey){
        aggregateCache.clear();
        delete built['items'];
        if(!dashboardBundleLoading && currentPage === 'items') render();
        const modal = document.getElementById('zoneDetailModal');
        if(activeZoneDetailCode && modal && modal.style.display !== 'none') openZoneDetailModal(activeZoneDetailCode);
      }
      return payload;
    }catch(err){
      const message = err && err.name === 'AbortError'
        ? 'โหลดข้อมูลสินค้าใช้เวลานานเกิน 1 นาที'
        : String(err && err.message || err);
      itemCubeLoadState.set(requestKey, {status:'error', message, code:String(err && err.code || '')});
      if(!dashboardBundleLoading && itemCubeRequestKey() === requestKey && currentPage === 'items') render();
      return null;
    }finally{
      clearTimeout(timeout);
    }
  })();
  itemCubeLoadState.set(requestKey, {status:'loading', promise:task});
  if(!dashboardBundleLoading && currentPage === 'items') render();
  return task;
}

function retryCurrentItemCube(){
  const requestKey = itemCubeRequestKey();
  itemCubeLoadState.delete(requestKey);
  void loadCurrentItemCube(true);
}

function slotCubeRequestKey(system = sys, from = dfrom, to = dto){
  const scope = canonicalCubeScope(system, from, to);
  return ['slot', dashboardDataEpoch(), scope.system, scope.from, scope.to, scope.shift, JSON.stringify(currentExcludedSkuList())].join('|');
}

function isValidSlotCubePayload(payload, system, from, to, shift, expectedEpoch = dashboardDataEpoch()){
  return !!payload && payload.schema_version === DASHBOARD_SCHEMA_VERSION &&
    String(payload.data_epoch || '') === String(expectedEpoch || '') &&
    payload.system === system && payload.from === from && payload.to === to &&
    payload.shift === shift && Number(payload.row_width) === 8 &&
    Array.isArray(payload.rows) && payload.rows.length % 8 === 0;
}

function hasCurrentSlotCube(system = sys, from = dfrom, to = dto, sf = shiftF){
  if(slotCubePayloadCache.has(slotCubeRequestKey(system, from, to, sf))) return true;
  return packedSlotRowCount(DATA && DATA[system]) > 0;
}

function forEachCurrentSlotRow(system, from, to, sf, callback){
  const payload = slotCubePayloadCache.get(slotCubeRequestKey(system, from, to, sf));
  if(payload){
    const rows = payload.rows;
    for(let offset=0; offset<rows.length; offset+=8){
      const date = String(rows[offset] || '');
      const timeShift = Number(rows[offset + 1]) === 1 ? 'night' : 'morning';
      const picker = String(rows[offset + 3] || '(none)');
      const shift = getPickerRosterShift(picker, timeShift);
      if(date < from || date > to || (sf !== 'all' && shift !== sf)) continue;
      callback({
        date,
        shift,
        zone:rows[offset + 2],
        picker,
        hour:Number(rows[offset + 4]) || 0,
        pcs:Number(rows[offset + 5]) || 0,
        pickQty:readBigQueryPickQty(rows[offset + 6]),
        lines:Number(rows[offset + 7]) || 0
      });
    }
    return true;
  }

  const source = DATA && DATA[system];
  const count = packedSlotRowCount(source);
  for(let i=0; i<count; i++){
    const row = packedSlotRowData(source, i);
    const date = source.dates[row.dateIdx];
    const timeShift = row.shiftCode === 1 ? 'night' : 'morning';
    const picker = String(source.pickers[row.pickerIdx] || '(none)');
    const shift = getPickerRosterShift(picker, timeShift);
    if(date < from || date > to || (sf !== 'all' && shift !== sf)) continue;
    callback({
      date, shift, zone:row.zone, picker,
      hour:row.hour, pcs:row.pcs, pickQty:row.pickQty, lines:row.lines
    });
  }
  return count > 0;
}

async function fetchDailySlotCube(system, date, shift, signal, force){
  const dailyKey = dailyCubeRequestKey('slot', system, date, shift);
  const requestEpoch = dashboardDataEpoch();
  if(!force && slotCubeDailyPayloadCache.has(dailyKey)) return slotCubeDailyPayloadCache.get(dailyKey);
  const query = [
    'mode=slot_cube',
    'system=' + encodeURIComponent(system),
    'from=' + encodeURIComponent(date),
    'to=' + encodeURIComponent(date),
    'shift=' + encodeURIComponent(shift),
    dashboardResponseEncodingQuery(),
    dashboardScopeQuery(),
    't=' + Date.now()
  ].join('&');
  const payload = await fetchDashboardCubeJson(
    DATA_URL + (DATA_URL.includes('?') ? '&' : '?') + query,
    {cache:'no-store', signal}
  );
  if(!payload || payload.schema_version !== DASHBOARD_SCHEMA_VERSION ||
      String(payload.data_epoch || '') !== String(requestEpoch || '') ||
      payload.system !== system || payload.from !== date || payload.to !== date ||
      payload.shift !== shift || Number(payload.row_width) !== 8 ||
      !Array.isArray(payload.rows) || payload.rows.length % 8 !== 0){
    throw dashboardTransientError('ข้อมูลช่วงเวลาเปลี่ยนระหว่างโหลด กรุณาลองใหม่อีกครั้ง');
  }
  slotCubeDailyPayloadCache.set(dailyKey, payload);
  while(slotCubeDailyPayloadCache.size > 80) slotCubeDailyPayloadCache.delete(slotCubeDailyPayloadCache.keys().next().value);
  return payload;
}

async function loadCurrentSlotCube(force, system = sys){
  if(!DATA_URL || !dfrom || !dto) return null;
  const requestSystem = system;
  const scope = canonicalCubeScope(requestSystem, dfrom, dto);
  const requestFrom = scope.from;
  const requestTo = scope.to;
  const requestShift = scope.shift;
  const requestEpoch = dashboardDataEpoch();
  const requestKey = slotCubeRequestKey(requestSystem, requestFrom, requestTo, requestShift);
  const currentState = slotCubeLoadState.get(requestKey);
  if(!force && currentState && currentState.status === 'loading') return currentState.promise;
  if(!force && slotCubePayloadCache.has(requestKey)) return slotCubePayloadCache.get(requestKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  const task = (async () => {
    try{
      if(!force){
        const cached = await readDashboardCubeCache('slot', requestKey);
        if(isValidSlotCubePayload(cached, requestSystem, requestFrom, requestTo, requestShift, requestEpoch)){
          slotCubePayloadCache.set(requestKey, cached);
          slotCubeLoadState.set(requestKey, {status:'done'});
          return cached;
        }
      }
      const query = [
        'mode=slot_cube',
        'system=' + encodeURIComponent(requestSystem),
        'from=' + encodeURIComponent(requestFrom),
        'to=' + encodeURIComponent(requestTo),
        'shift=' + encodeURIComponent(requestShift),
        dashboardResponseEncodingQuery(),
        dashboardScopeQuery(),
        't=' + Date.now()
      ].join('&');
      const payload = await fetchDashboardCubeJson(
        DATA_URL + (DATA_URL.includes('?') ? '&' : '?') + query,
        {cache:'no-store', signal:controller.signal}
      );
      if(!isValidSlotCubePayload(payload, requestSystem, requestFrom, requestTo, requestShift, requestEpoch)){
        throw dashboardTransientError('ข้อมูลช่วงเวลาเปลี่ยนระหว่างโหลด กรุณาลองใหม่อีกครั้ง');
      }
      slotCubePayloadCache.set(requestKey, payload);
      await writeDashboardCubeCache('slot', requestKey, payload);
      while(slotCubePayloadCache.size > 8) slotCubePayloadCache.delete(slotCubePayloadCache.keys().next().value);
      slotCubeLoadState.set(requestKey, {status:'done'});
      if(slotCubeRequestKey(requestSystem, dfrom, dto, shiftF) === requestKey){
        aggregateCache.clear();
        if(!dashboardBundleLoading && (currentPage === 'time' || currentPage === 'typebreak')) render();
      }
      return payload;
    }catch(err){
      const message = err && err.name === 'AbortError'
        ? 'โหลดข้อมูลช่วงเวลาใช้เวลานานเกิน 1 นาที'
        : String(err && err.message || err);
      slotCubeLoadState.set(requestKey, {status:'error', message, code:String(err && err.code || '')});
      if(!dashboardBundleLoading && (currentPage === 'time' || currentPage === 'typebreak')) render();
      return null;
    }finally{
      clearTimeout(timeout);
    }
  })();
  slotCubeLoadState.set(requestKey, {status:'loading', promise:task});
  return task;
}

function retryCurrentSlotCube(){
  const requestKey = slotCubeRequestKey();
  slotCubeLoadState.delete(requestKey);
  void loadCurrentSlotCube(true);
}

function pickerItemsRequestKey(pickerId){
  return [
    dashboardCacheRevision || '0', sys, String(pickerId || '').trim(),
    dfrom, dto, shiftF, JSON.stringify(currentExcludedSkuList())
  ].join('|');
}
function applyPickerItemsPayload(pickerId, requestKey, payload){
  if(!A || !A.picker_drilldown) return false;
  const pData = A.picker_drilldown[pickerId];
  if(!pData) return false;
  Object.values(pData.byDate || {}).forEach(record => { record.skus = {}; });
  const rows = Array.isArray(payload && payload.rows) ? payload.rows : [];
  const width = Number(payload && payload.row_width) || 0;
  if(width !== 8 || rows.length % width !== 0) throw new Error('รูปแบบรายการ SKU รายพนักงานไม่ถูกต้อง');
  for(let offset=0; offset<rows.length; offset+=width){
    const date = String(rows[offset] || '');
    const timeShift = Number(rows[offset + 1]) === 1 ? 'night' : 'morning';
    const shift = getPickerRosterShift(pickerId, timeShift);
    if(shiftF !== 'all' && shift !== shiftF) continue;
    const dRec = pData.byDate && pData.byDate[date];
    if(!dRec) continue;
    const zone = getZoneInfo(rows[offset + 2]).zone;
    if(isZoneExcluded(zone)) continue;
    const owner = normalizeOwnerKey(rows[offset + 3]);
    const sku = normalizeSkuKey(rows[offset + 4]) || '(none)';
    if(isSkuExcluded(sku, owner)) continue;
    const key = itemCompositeKey(owner, sku);
    const rec = dRec.skus[key] || (dRec.skus[key] = {owner, sku, pcs:0, qty:0, lines:0});
    rec.pcs += Number(rows[offset + 5]) || 0;
    rec.qty += Number(rows[offset + 6]) || 0;
    rec.lines += Number(rows[offset + 7]) || 0;
  }
  pData._skuLoadKey = requestKey;
  return true;
}

async function loadPickerItemsForDrilldown(pickerId, force){
  const picker = String(pickerId || '').trim();
  if(!picker || !A || !A.picker_drilldown || !A.picker_drilldown[picker]) return;
  const requestKey = pickerItemsRequestKey(picker);
  const currentState = pickerItemLoadState.get(requestKey);
  if(!force && currentState && currentState.status === 'loading') return currentState.promise;
  if(!force && pickerItemPayloadCache.has(requestKey)){
    applyPickerItemsPayload(picker, requestKey, pickerItemPayloadCache.get(requestKey));
    pickerItemLoadState.set(requestKey, {status:'done'});
    if(selectedPickerId === picker) renderPickerDrilldown();
    return;
  }

  pickerItemLoadState.set(requestKey, {status:'loading'});
  if(selectedPickerId === picker) renderPickerDrilldown();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  const task = (async () => {
    try{
      const query = [
        'mode=picker_items',
        'system=' + encodeURIComponent(sys),
        'picker=' + encodeURIComponent(picker),
        'from=' + encodeURIComponent(dfrom),
        'to=' + encodeURIComponent(dto),
        'shift=' + encodeURIComponent(shiftF),
        dashboardScopeQuery(),
        't=' + Date.now()
      ].join('&');
      const response = await fetchWithTransientRetry(
        DATA_URL + (DATA_URL.includes('?') ? '&' : '?') + query,
        {cache:'no-store', signal:controller.signal},
        1
      );
      if(!response.ok) throw new Error('HTTP ' + response.status);
      const payload = await response.json();
      if(payload && payload.error) throw new Error(payload.error);
      if(!payload || payload.schema_version !== DASHBOARD_SCHEMA_VERSION ||
          String(payload.picker || '') !== picker || String(payload.system || '') !== sys || Number(payload.row_width) !== 8){
        throw new Error('Apps Script ตอบรายการ SKU คนละชุดกับหน้าที่เลือก');
      }
      pickerItemPayloadCache.set(requestKey, payload);
      // จำกัด memory ฝั่ง browser เพราะผู้ใช้ทั่วไปเปิดดูเพียงไม่กี่คนต่อครั้ง
      while(pickerItemPayloadCache.size > 12) pickerItemPayloadCache.delete(pickerItemPayloadCache.keys().next().value);
      // ผู้ใช้อาจเปลี่ยนระบบ/วันที่ระหว่างรอ ห้ามนำผลของตัวกรองเก่าไปปนกับ A ชุดใหม่
      if(pickerItemsRequestKey(picker) === requestKey){
        applyPickerItemsPayload(picker, requestKey, payload);
      }
      pickerItemLoadState.set(requestKey, {status:'done'});
    }catch(err){
      const message = err && err.name === 'AbortError'
        ? 'โหลดรายการ SKU ใช้เวลานานเกิน 90 วินาที'
        : String(err && err.message || err);
      pickerItemLoadState.set(requestKey, {status:'error', message});
    }finally{
      clearTimeout(timeout);
      if(selectedPickerId === picker) renderPickerDrilldown();
    }
  })();
  pickerItemLoadState.set(requestKey, {status:'loading', promise:task});
  return task;
}

function retryPickerItemsLoad(){
  if(!selectedPickerId) return;
  const requestKey = pickerItemsRequestKey(selectedPickerId);
  pickerItemLoadState.delete(requestKey);
  void loadPickerItemsForDrilldown(selectedPickerId, true);
}

function selectPickerDrilldown(pickerId){
  selectedPickerId = String(pickerId || '').trim();
  selectedPickerDate = 'all';
  const selectEl = document.getElementById('pickerSelect');
  if(selectEl) selectEl.value = selectedPickerId;
  void loadPickerItemsForDrilldown(selectedPickerId, false);
  renderPickerDrilldown();
  const cardEl = document.getElementById('pickerDetailContent');
  if(cardEl) cardEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let currentMacroDimension = 'typePick'; // 'typePick', 'owner', 'affiliation'
let selectedTypePickFilter = 'all';
let selectedTypePickZoneFilter = 'all';
let selectedTypePickPickerId = null;

function switchMacroDimension(dimName) {
  currentMacroDimension = dimName;
  selectedTypePickFilter = 'all';
  selectedTypePickZoneFilter = 'all';
  selectedTypePickPickerId = null;
  const segButtons = document.querySelectorAll('#macroDimSeg button');
  segButtons.forEach(b => b.classList.toggle('active', b.dataset.dim === dimName));
  if (builders.typebreak) builders.typebreak();
}

function resetTypePickDrilldown() {
  selectedTypePickFilter = 'all';
  selectedTypePickZoneFilter = 'all';
  selectedTypePickPickerId = null;
  if (builders.typebreak) builders.typebreak();
}

function selectTypePickFilter(categoryName) {
  if (selectedTypePickFilter === categoryName) {
    selectedTypePickFilter = 'all';
  } else {
    selectedTypePickFilter = categoryName;
  }
  selectedTypePickZoneFilter = 'all';
  selectedTypePickPickerId = null;
  if (builders.typebreak) builders.typebreak();
}

function selectTypePickZoneFilter(zoneCode) {
  if (selectedTypePickZoneFilter === zoneCode) {
    selectedTypePickZoneFilter = 'all';
  } else {
    selectedTypePickZoneFilter = zoneCode;
  }
  selectedTypePickPickerId = null;
  if (builders.typebreak) builders.typebreak();
}

function renderTypeBreakdownPage(){
  try {
  if(!hasCurrentSlotCube()) setTimeout(() => void loadCurrentSlotCube(false), 0);
  const isPcs = unitMode === 'pcs';
  const S = DATA[sys];
  if (!S || !Array.isArray(S.rows)) return;
  const count = packedRowCount(S);

  let standardCategories = [];
  let dimPalette = ZONE_TYPE_COLORS;
  let dimTitlePrefix = 'Type Pick';

  if (currentMacroDimension === 'typePick') {
    standardCategories = ['Full Rack', 'Half Rack', 'Mezzanine', 'Micro Rack', 'Pick to Sort', 'On Floor'];
    dimPalette = ZONE_TYPE_COLORS;
    dimTitlePrefix = 'ชนิดการหยิบ (Type Pick)';
  } else if (currentMacroDimension === 'owner') {
    standardCategories = ['Max Mart', 'Punthai', 'GFA', 'Lube'];
    dimPalette = ZONE_OWNER_COLORS;
    dimTitlePrefix = 'เจ้าของสินค้า (Owner)';
  } else if (currentMacroDimension === 'affiliation') {
    standardCategories = ['ประจำ', 'Outsource A', 'Outsource B'];
    dimPalette = { 'ประจำ': '#0f766e', 'outsource': '#d97706', '-': '#94a3b8' };
    dimTitlePrefix = 'สังกัดพนักงาน (Affiliation)';
  }

  const perPicker = new Map();
  const totalByType = {};
  const zonesInCurrentType = new Map();
  standardCategories.forEach(tp => { totalByType[tp] = { val: 0, lines: 0, pickers: new Set(), zones: new Set() }; });
  let totalGrandVal = 0;

  for (let i = 0; i < count; i++) {
    const sh = S._sh ? S._sh[i] : null;
    if (!sh || sh.sd < dfrom || sh.sd > dto) continue;
    if (shiftF !== 'all' && sh.sh !== shiftF) continue;

    const row = packedRowData(S, i);
    const val = isPcs ? row.pcs : row.pickQty;
    const lineVal = row.lines;
    const pickerId = String(S.pickers[row.pickerIdx] || '-').trim();
    const zoneInfo = getZoneInfo(row.zone);
    const zoneCode = zoneInfo.zone || String(row.zone || '-').trim().toUpperCase();
    if(isZoneExcluded(zoneCode)) continue;
    const pickerAffiliation = getPickerAffiliation(pickerId);

    let categoryVal = '';
    if (currentMacroDimension === 'typePick') {
      categoryVal = String(zoneInfo.typePick || '-').trim();
    } else if (currentMacroDimension === 'owner') {
      let rawOwner = String(zoneInfo.owner || '-').trim();
      if (rawOwner.replace(/\s+/g, '').toLowerCase() === 'maxmart') {
        categoryVal = 'Max Mart';
      } else {
        categoryVal = rawOwner;
      }
    } else if (currentMacroDimension === 'affiliation') {
      categoryVal = String(pickerAffiliation || '-').trim();
    }

    if (!categoryVal || categoryVal === '-') categoryVal = 'อื่นๆ / ไม่ระบุ';

    // Global Category Totals
    if (!totalByType[categoryVal]) {
      totalByType[categoryVal] = { val: 0, lines: 0, pickers: new Set(), zones: new Set() };
    }
    totalByType[categoryVal].val += val;
    totalByType[categoryVal].lines += lineVal;
    totalByType[categoryVal].pickers.add(pickerId);
    totalByType[categoryVal].zones.add(zoneCode);
    totalGrandVal += val;

    // Category Filter check
    if (selectedTypePickFilter !== 'all' && categoryVal !== selectedTypePickFilter) continue;

    // Track zones for selected category
    if (!zonesInCurrentType.has(zoneCode)) {
      zonesInCurrentType.set(zoneCode, { zone: zoneCode, typePick: zoneInfo.typePick, val: 0, lines: 0, pickers: new Set() });
    }
    const zRecord = zonesInCurrentType.get(zoneCode);
    zRecord.val += val;
    zRecord.lines += lineVal;
    zRecord.pickers.add(pickerId);

    // Zone Filter check
    if (selectedTypePickZoneFilter !== 'all' && zoneCode !== selectedTypePickZoneFilter) continue;

    if (!perPicker.has(pickerId)) {
      perPicker.set(pickerId, {
        pickerId,
        pickerName: getPickerName(pickerId),
        affiliation: pickerAffiliation,
        totalVal: 0,
        totalLines: 0,
        byType: {},
        byZone: {}
      });
    }

    const pData = perPicker.get(pickerId);
    pData.totalVal += val;
    pData.totalLines += lineVal;
    pData.byType[categoryVal] = (pData.byType[categoryVal] || 0) + val;

    if (!pData.byZone[zoneCode]) {
      pData.byZone[zoneCode] = { zone: zoneCode, typePick: zoneInfo.typePick, val: 0, lines: 0 };
    }
    pData.byZone[zoneCode].val += val;
    pData.byZone[zoneCode].lines += lineVal;
  }

  // 0. Render Breadcrumb Bar
  const bcEl = document.getElementById('typepickBreadcrumb');
  if (bcEl) {
    let bcHtml = `<span onclick="resetTypePickDrilldown()" style="cursor:pointer; background:#eef2ff; color:#4338ca; padding:4px 10px; border-radius:8px; border:1px solid #c7d2fe;">🏷️ ทุกมิติ (All)</span>`;
    
    if (selectedTypePickFilter !== 'all') {
      const typeColor = colorForLabel(dimPalette, selectedTypePickFilter);
      bcHtml += `<span style="color:#94a3b8;">➔</span>`;
      bcHtml += `<span onclick="selectTypePickFilter('${escapeZoneHtml(selectedTypePickFilter)}')" style="cursor:pointer; background:${typeColor}18; color:${typeColor}; padding:4px 12px; border-radius:8px; border:1px solid ${typeColor}40; font-weight:700;">📌 ${dimTitlePrefix}: ${escapeZoneHtml(selectedTypePickFilter)} ✕</span>`;
    }
    
    if (selectedTypePickZoneFilter !== 'all') {
      bcHtml += `<span style="color:#94a3b8;">➔</span>`;
      bcHtml += `<span onclick="selectTypePickZoneFilter('${escapeZoneHtml(selectedTypePickZoneFilter)}')" style="cursor:pointer; background:#0f172a; color:#fff; padding:4px 12px; border-radius:8px; font-weight:700;">📍 Zone: ${escapeZoneHtml(selectedTypePickZoneFilter)} ✕</span>`;
    }

    if (selectedTypePickPickerId) {
      const pickerName = getPickerName(selectedTypePickPickerId);
      bcHtml += `<span style="color:#94a3b8;">➔</span>`;
      bcHtml += `<span style="background:#dcfce7; color:#15803d; padding:4px 12px; border-radius:8px; font-weight:700; border:1px solid #86efac;">👤 ${escapeZoneHtml(pickerName)}</span>`;
    }

    bcEl.innerHTML = bcHtml;
  }

  // 1. Render Summary KPI Cards (Level 1 Drill-down Cards)
  const kpiEl = document.getElementById('typepickKpis');
  if (kpiEl) {
    let kpiHtml = '';
    const activeTypes = Object.keys(totalByType).filter(tp => (totalByType[tp]?.val || 0) > 0);
    activeTypes.sort((a,b) => (totalByType[b]?.val || 0) - (totalByType[a]?.val || 0));
    
    activeTypes.forEach(tp => {
      const data = totalByType[tp] || { val: 0, lines: 0, pickers: new Set(), zones: new Set() };
      const color = colorForLabel(dimPalette, tp);
      const pct = totalGrandVal > 0 ? ((data.val / totalGrandVal) * 100).toFixed(1) : '0.0';
      const isSelected = selectedTypePickFilter === tp;
      const borderStyle = isSelected ? `border: 2px solid ${color}; transform:scale(1.02); box-shadow:0 10px 25px -8px ${color}60;` : `border-top: 4px solid ${color};`;
      const cardBg = isSelected ? `background: linear-gradient(135deg, #ffffff 0%, ${color}0c 100%);` : '';

      kpiHtml += `
        <div class="zone-stat" onclick="selectTypePickFilter('${escapeZoneHtml(tp)}')" style="cursor:pointer; transition:all .2s; ${borderStyle} ${cardBg}">
          <div class="zone-stat-label" style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-weight:700; color:${isSelected ? color : '#334155'};">${isSelected ? '📌 ' : ''}${escapeZoneHtml(tp)}</span>
            <span style="background:${color}${isSelected ? '35' : '18'}; color:${color}; font-weight:700; padding:2px 7px; border-radius:6px; font-size:10.5px;">${pct}%</span>
          </div>
          <div class="zone-stat-value" style="color:${color}; font-size:22px; margin-top:6px;">${fmt(Math.ceil(data.val))} <span style="font-size:11px; font-weight:400; color:#64748b;">${isPcs ? 'ชิ้น' : 'หน่วย'}</span></div>
          <div class="zone-stat-detail">📦 ${fmt(data.lines)} บรรทัด · 📍 ${data.zones.size} Zone · 👤 ${data.pickers.size} คน</div>
        </div>
      `;
    });
    kpiEl.innerHTML = kpiHtml;
  }

  // ===== RENDER 3 MACRO DIMENSIONS CHARTS =====
  const typeMap = new Map();
  const ownerMap = new Map();
  const affMap = new Map();

  for (let i = 0; i < count; i++) {
    const sh = S._sh ? S._sh[i] : null;
    if (!sh || sh.sd < dfrom || sh.sd > dto) continue;
    if (shiftF !== 'all' && sh.sh !== shiftF) continue;

    const row = packedRowData(S, i);
    const rawLoc = (S.locations && S.locations[row.zone]) ? S.locations[row.zone] : row.zone;
    const zInfo = getZoneInfo(rawLoc);
    if(isZoneExcluded(zInfo.zone)) continue;
    const val = isPcs ? row.pcs : row.pickQty;

    // Type Pick aggregation
    const tp = zInfo.typePick || 'อื่นๆ';
    typeMap.set(tp, (typeMap.get(tp) || 0) + val);

    // Owner aggregation
    const ow = zInfo.owner && zInfo.owner !== '-' ? zInfo.owner : 'อื่นๆ';
    ownerMap.set(ow, (ownerMap.get(ow) || 0) + val);

    // Affiliation aggregation
    const pickerId = String(S.pickers[row.pickerIdx] || '-').trim();
    const aff = getPickerAffiliation(pickerId);
    if (!affMap.has(aff)) affMap.set(aff, { val: 0, pickers: new Set() });
    const affRec = affMap.get(aff);
    affRec.val += val;
    affRec.pickers.add(pickerId);
  }

  const unitTxt = isPcs ? 'ชิ้น' : 'หน่วยหยิบ';

  // Render Chart 1: Type Pick Chart
  const exTypeChart = Chart.getChart('macroTypePickChart'); if (exTypeChart) exTypeChart.destroy();
  const typeChartEl = document.getElementById('macroTypePickChart');
  if (typeChartEl) {
    const sortedTypes = [...typeMap.entries()].sort((a, b) => b[1] - a[1]);
    const typeLabels = sortedTypes.map(x => x[0]);
    const typeValues = sortedTypes.map(x => x[1]);
    const typeColors = typeLabels.map(lbl => colorForLabel(ZONE_TYPE_COLORS, lbl));

    new Chart(typeChartEl, {
      type: 'bar',
      data: {
        labels: typeLabels,
        datasets: [{
          label: unitTxt,
          data: typeValues,
          backgroundColor: typeColors,
          borderRadius: 6,
          barThickness: 20
        }]
      },
      options: {
        indexAxis: 'y',
        maintainAspectRatio: false,
        layout: { padding: { top: 6, right: 40, bottom: 4, left: 4 } },
        plugins: {
          legend: { display: false },
          datalabels: {
            anchor: 'end',
            align: 'end',
            color: '#334155',
            font: { weight: '700', size: 10.5 },
            formatter: (v) => fmt(Math.ceil(v))
          }
        },
        scales: {
          x: { grid: { color: '#f1f5f9' }, ticks: { callback: fmt } },
          y: { grid: { display: false }, ticks: { font: { weight: '600', size: 11 } } }
        }
      }
    });
  }

  // Render Chart 2: Owner Chart
  const exOwnerChart = Chart.getChart('macroOwnerChart'); if (exOwnerChart) exOwnerChart.destroy();
  const ownerChartEl = document.getElementById('macroOwnerChart');
  if (ownerChartEl) {
    const sortedOwners = [...ownerMap.entries()].sort((a, b) => b[1] - a[1]);
    const ownerLabels = sortedOwners.map(x => x[0]);
    const ownerValues = sortedOwners.map(x => x[1]);
    const ownerTotal = ownerValues.reduce((a, b) => a + b, 0) || 1;
    const ownerColors = ['#f59e0b', '#10b981', '#6366f1', '#ec4899', '#8b5cf6', '#64748b'];

    new Chart(ownerChartEl, {
      type: 'doughnut',
      data: {
        labels: ownerLabels,
        datasets: [{
          data: ownerValues,
          backgroundColor: ownerColors.slice(0, ownerLabels.length),
          borderWidth: 3,
          borderColor: '#fff'
        }]
      },
      options: {
        maintainAspectRatio: false,
        layout: { padding: 12 },
        cutout: '62%',
        plugins: {
          legend: { position: 'right', labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 } } },
          datalabels: {
            display: (ctx) => (ctx.dataset.data[ctx.dataIndex] / ownerTotal) > 0.05,
            color: '#fff',
            font: { weight: '700', size: 11 },
            formatter: (v) => Math.round((v / ownerTotal) * 100) + '%'
          }
        }
      }
    });
  }

  // Render Chart 3: Affiliation Chart
  const exAffChart = Chart.getChart('macroAffiliationChart'); if (exAffChart) exAffChart.destroy();
  const affChartEl = document.getElementById('macroAffiliationChart');
  if (affChartEl) {
    const sortedAff = [...affMap.entries()].sort((a, b) => b[1].val - a[1].val);
    const affLabels = sortedAff.map(x => x[0]);
    const affValues = sortedAff.map(x => x[1].val);
    const affPickers = sortedAff.map(x => x[1].pickers.size);

    new Chart(affChartEl, {
      type: 'bar',
      data: {
        labels: affLabels,
        datasets: [
          {
            label: `ปริมาณหยิบ (${unitTxt})`,
            data: affValues,
            backgroundColor: '#0f766e',
            borderRadius: 6,
            yAxisID: 'y'
          },
          {
            label: 'จำนวนพนักงาน (คน)',
            data: affPickers,
            backgroundColor: '#f59e0b',
            borderRadius: 6,
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        maintainAspectRatio: false,
        layout: { padding: { top: 18, right: 12, bottom: 4, left: 4 } },
        plugins: {
          legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8, font: { size: 11 } } },
          datalabels: {
            anchor: 'end',
            align: 'end',
            font: { weight: '700', size: 10 },
            formatter: (v) => fmt(Math.ceil(v))
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { weight: '600', size: 11 } } },
          y: { position: 'left', grid: { color: '#f1f5f9' }, ticks: { callback: fmt } },
          y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: fmt } }
        }
      }
    });
  }

  // 1.5 Zone Selector Pills (Level 2 Drill-down Pills)
  if (selectedTypePickFilter !== 'all') {
    const tableTitleEl = document.getElementById('typepickTableTitle');
    if (tableTitleEl) {
      const zoneList = [...zonesInCurrentType.values()].sort((a,b) => b.val - a.val);
      let zonePillsHtml = `<div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; align-items:center;">
        <span style="font-size:12px; color:#64748b; font-weight:600;">📍 เลือก Zone:</span>
        <button onclick="selectTypePickZoneFilter('all')" style="border:0; padding:3px 10px; border-radius:999px; font-size:11.5px; font-weight:700; cursor:pointer; ${selectedTypePickZoneFilter === 'all' ? 'background:#0f172a; color:#fff;' : 'background:#f1f5f9; color:#64748b;'}">ทั้งหมด (${zoneList.length})</button>`;
      
      zoneList.forEach(z => {
        const isSel = selectedTypePickZoneFilter === z.zone;
        const color = colorForLabel(dimPalette, selectedTypePickFilter);
        const btnStyle = isSel
          ? `background:${color}; color:#fff; font-weight:700; box-shadow:0 3px 8px ${color}50;`
          : `background:${color}15; color:${color}; border:1px solid ${color}30; font-weight:600;`;
        zonePillsHtml += `<button onclick="selectTypePickZoneFilter('${escapeZoneHtml(z.zone)}')" style="border:0; padding:3px 10px; border-radius:999px; font-size:11.5px; cursor:pointer; transition:.18s; ${btnStyle}">${escapeZoneHtml(z.zone)} (${fmt(Math.ceil(z.val))})</button>`;
      });
      zonePillsHtml += `</div>`;
      
      tableTitleEl.innerHTML = `🔥 พนักงานในกลุ่ม ${escapeZoneHtml(selectedTypePickFilter)}${selectedTypePickZoneFilter !== 'all' ? ' ➔ Zone ' + escapeZoneHtml(selectedTypePickZoneFilter) : ''} ${zonePillsHtml}`;
    }
  } else {
    const tableTitleEl = document.getElementById('typepickTableTitle');
    if (tableTitleEl) tableTitleEl.textContent = `🔥 Heatmap สัดส่วนการหยิบตาม ${dimTitlePrefix}`;
  }

  const pickerList = [...perPicker.values()].sort((a,b) => b.totalVal - a.totalVal);

  if (!selectedTypePickPickerId || !perPicker.has(selectedTypePickPickerId)) {
    selectedTypePickPickerId = pickerList[0] ? pickerList[0].pickerId : null;
  }

  // 2. Render Heatmap / Picker Table (Level 3)
  const table = document.getElementById('typepickHeatmapTable');
  if (table) {
    let allTypes = selectedTypePickFilter !== 'all'
      ? [selectedTypePickFilter]
      : Object.keys(totalByType).filter(tp => (totalByType[tp]?.val || 0) > 0);

    if (selectedTypePickFilter === 'all') {
      Object.keys(totalByType).forEach(tp => {
        if (!allTypes.includes(tp) && totalByType[tp].val > 0) allTypes.push(tp);
      });
    }

    let th = '<thead><tr><th style="width:38px;">#</th><th>พนักงาน / สังกัด</th><th class="num">รวม</th>';
    allTypes.forEach(tp => {
      const color = colorForLabel(dimPalette, tp);
      th += `<th class="num" style="border-bottom:2px solid ${color};">${escapeZoneHtml(tp)}</th>`;
    });
    th += '</tr></thead><tbody>';

    if (pickerList.length === 0) {
      th += `<tr><td colspan="${allTypes.length + 3}" class="empty-cell">ไม่พบข้อมูลตามเงื่อนไขที่เลือก</td></tr>`;
    } else {
      pickerList.forEach((p, idx) => {
        const isSelected = p.pickerId === selectedTypePickPickerId;
        const rowStyle = isSelected ? 'background:#eef2ff; font-weight:600;' : '';
        
        th += `<tr style="cursor:pointer; ${rowStyle}" onclick="selectTypePickPicker('${escapeZoneHtml(p.pickerId)}')">`;
        th += `<td>${formatRankBadge(idx)}</td>`;
        th += `<td>
          <div style="font-weight:700; color:#0f172a;">${escapeZoneHtml(p.pickerName)}</div>
          <div style="font-size:10.5px; color:#64748b;">ID: ${escapeZoneHtml(p.pickerId)} · ${escapeZoneHtml(p.affiliation)}</div>
        </td>`;
        th += `<td class="num" style="font-weight:700; color:#4338ca;">${fmt(Math.ceil(p.totalVal))}</td>`;

        allTypes.forEach(tp => {
          const val = p.byType[tp] || 0;
          const share = p.totalVal > 0 ? (val / p.totalVal) : 0;
          const color = colorForLabel(dimPalette, tp);

          let cellStyle = '';
          if (val > 0) {
            const opacity = (0.12 + 0.78 * Math.pow(share, 0.5)).toFixed(2);
            cellStyle = `background: ${color}${Math.round(opacity * 255).toString(16).padStart(2,'0')}; color: ${share > 0.4 ? '#0f172a' : '#334155'}; font-weight:${share > 0.3 ? '700' : '500'};`;
          }

          th += `<td class="num" style="${cellStyle}">`;
          if (val > 0) {
            th += `<div>${fmt(Math.ceil(val))}</div>`;
            th += `<div style="font-size:9.5px; opacity:0.85;">${(share * 100).toFixed(0)}%</div>`;
          } else {
            th += `<span style="color:#cbd5e1;">-</span>`;
          }
          th += `</td>`;
        });

        th += `</tr>`;
      });
    }
    th += '</tbody>';
    table.innerHTML = th;
  }

  // 3. Render Detail Panel (Radar & Zone Detail Table)
  renderTypePickDetail(selectedTypePickPickerId, perPicker, totalByType, totalGrandVal, standardCategories);
  } catch (err) {
    console.error('renderTypeBreakdownPage failed:', err);
    const table = document.getElementById('typepickHeatmapTable');
    if (table) table.innerHTML = '<tbody><tr><td class="empty-cell" style="color:#ef4444;">เกิดข้อผิดพลาดในการคำนวณ: ' + escapeZoneHtml(err.message) + '</td></tr></tbody>';
  }
}

function selectTypePickPicker(id) {
  selectedTypePickPickerId = id;
  if (builders.typebreak) builders.typebreak();
}

function renderTypePickDetail(pickerId, perPickerMap, totalByType, totalGrandVal, standardTypePicks) {
  const pData = perPickerMap.get(pickerId);
  const badge = document.getElementById('typepickPickerBadge');
  const title = document.getElementById('typepickDetailTitle');
  const isPcs = unitMode === 'pcs';

  if (!pData) {
    if (badge) badge.textContent = 'กรุณาคลิกเลือกพนักงาน';
    return;
  }

  if (badge) badge.textContent = `${pData.pickerName} (${pData.pickerId})`;
  if (title) title.textContent = `📍 รายการ Zone & ผลงาน: ${pData.pickerName}`;

  const zTable = document.getElementById('typepickZoneTable');
  if (zTable) {
    const zoneList = Object.values(pData.byZone).sort((a,b) => b.val - a.val);
    let zh = '<thead><tr><th>Zone</th><th>Type Pick</th><th class="num">ปริมาณ</th><th class="num">บรรทัด</th><th class="num">สัดส่วน</th></tr></thead><tbody>';

    if (zoneList.length === 0) {
      zh += '<tr><td colspan="5" class="empty-cell">ไม่มีข้อมูล Zone</td></tr>';
    } else {
      zoneList.forEach(z => {
        const sharePct = pData.totalVal > 0 ? ((z.val / pData.totalVal) * 100).toFixed(1) : '0.0';
        const color = colorForLabel(ZONE_TYPE_COLORS, z.typePick);

        zh += `<tr>`;
        zh += `<td><span class="pill" style="background:#f1f5f9; color:#0f172a; font-weight:700;">${escapeZoneHtml(z.zone)}</span></td>`;
        zh += `<td><span class="zone-tags" style="margin:0;"><span style="background:${color}18; color:${color}; border-color:${color}40; font-weight:600;">${escapeZoneHtml(z.typePick)}</span></span></td>`;
        zh += `<td class="num" style="font-weight:700;">${fmt(Math.ceil(z.val))} <span style="font-size:10px; font-weight:400; color:#64748b;">${isPcs ? 'ชิ้น' : 'หน่วย'}</span></td>`;
        zh += `<td class="num">${fmt(z.lines)}</td>`;
        zh += `<td class="num" style="font-weight:700; color:#4338ca;">${sharePct}%</td>`;
        zh += `</tr>`;
      });
    }
    zh += '</tbody>';
    zTable.innerHTML = zh;
  }
}

function renderPickerDrilldown(){
  const searchInputEl = document.getElementById('pickerSearchInput');
  const selectEl = document.getElementById('pickerSelect');
  const dateSelectEl = document.getElementById('pickerDateSelect');
  const contentEl = document.getElementById('pickerDetailContent');
  const resetBtn = document.getElementById('btnResetPickerFilter');
  if(!selectEl || !contentEl || !A) return;

  const drillMap = A.picker_drilldown || {};
  const pickersList = (A.by_picker || []).map(p => ({
    id: p.picker,
    name: p.name || getPickerName(p.picker),
    affiliation: p.affiliation || getPickerAffiliation(p.picker),
    qty: p.qty,
    pcs: p.pcs
  }));

  // Filter pickers based on search input
  let filteredList = pickersList;
  if(searchInputEl && searchInputEl.value.trim()){
    const q = searchInputEl.value.trim().toLowerCase();
    filteredList = pickersList.filter(p =>
      p.id.toLowerCase().includes(q) ||
      (p.name && p.name.toLowerCase().includes(q)) ||
      (p.affiliation && p.affiliation.toLowerCase().includes(q))
    );
  }

  // Populate picker select options
  let optionsHtml = `<option value="">-- เลือกพนักงาน (${filteredList.length}) --</option>`;
  filteredList.forEach(p => {
    const isPcs = unitMode === 'pcs';
    const label = `${p.id} - ${p.name !== '-' ? p.name : ''} (${p.affiliation}) [${fmt(isPcs ? p.pcs : p.qty)} ${isPcs ? 'ชิ้น' : 'หน่วย'}]`;
    optionsHtml += `<option value="${escapeZoneHtml(p.id)}"${p.id === selectedPickerId ? ' selected' : ''}>${escapeZoneHtml(label)}</option>`;
  });
  selectEl.innerHTML = optionsHtml;

  // Bind input search events
  if(searchInputEl && !searchInputEl._bound){
    searchInputEl._bound = true;
    searchInputEl.oninput = () => {
      renderPickerDrilldown();
      const currentSelect = document.getElementById('pickerSelect');
      if (currentSelect && currentSelect.options.length === 2 && currentSelect.options[1].value) {
        selectedPickerId = currentSelect.options[1].value;
        currentSelect.value = selectedPickerId;
        void loadPickerItemsForDrilldown(selectedPickerId, false);
        renderPickerDrilldown();
      }
    };
    searchInputEl.onkeydown = (e) => {
      if(e.key === 'Enter') {
        const currentSelect = document.getElementById('pickerSelect');
        if (currentSelect && currentSelect.options.length > 1 && currentSelect.options[1].value) {
          selectedPickerId = currentSelect.options[1].value;
          currentSelect.value = selectedPickerId;
          void loadPickerItemsForDrilldown(selectedPickerId, false);
          renderPickerDrilldown();
        }
      }
    };
  }

  // Bind change handlers once
  if(!selectEl._bound){
    selectEl._bound = true;
    selectEl.onchange = () => {
      selectedPickerId = selectEl.value;
      selectedPickerDate = 'all';
      void loadPickerItemsForDrilldown(selectedPickerId, false);
      renderPickerDrilldown();
    };
  }
  if(dateSelectEl && !dateSelectEl._bound){
    dateSelectEl._bound = true;
    dateSelectEl.onchange = () => {
      selectedPickerDate = dateSelectEl.value;
      renderPickerDrilldown();
    };
  }
  if(resetBtn && !resetBtn._bound){
    resetBtn._bound = true;
    resetBtn.onclick = () => {
      selectedPickerId = '';
      selectedPickerDate = 'all';
      if(searchInputEl) searchInputEl.value = '';
      if(selectEl) selectEl.value = '';
      renderPickerDrilldown();
    };
  }

  if(!selectedPickerId || !drillMap[selectedPickerId]){
    contentEl.innerHTML = `
      <div style="text-align:center; color:#94a3b8; padding:36px; background:#f8fafc; border-radius:14px; border:1px dashed #cbd5e1;">
        👆 กรุณาเลือกรายชื่อพนักงานจากดรอปดาวน์ด้านบน หรือกดเลือกจากตารางด้านล่างเพื่อเริ่มดูรายงานเจาะลึก
      </div>`;
    if(dateSelectEl) dateSelectEl.innerHTML = '<option value="all">ทุกวันที่</option>';
    return;
  }

  const pData = drillMap[selectedPickerId];
  const pickerSkuRequestKey = pickerItemsRequestKey(selectedPickerId);
  const pickerSkuState = pickerItemLoadState.get(pickerSkuRequestKey);
  if(pData._skuLoadKey !== pickerSkuRequestKey && !pickerSkuState){
    setTimeout(() => void loadPickerItemsForDrilldown(selectedPickerId, false), 0);
  }
  const datesArray = [...(pData.dates || [])].sort();

  // Populate date select options
  if(dateSelectEl){
    let dateOptions = '<option value="all">ทุกวันที่ (' + datesArray.length + ' วัน)</option>';
    datesArray.forEach(d => {
      dateOptions += `<option value="${d}"${d === selectedPickerDate ? ' selected' : ''}>📅 ${d}</option>`;
    });
    dateSelectEl.innerHTML = dateOptions;
  }

  // Filter records based on selectedPickerDate
  let totalPcs = 0, totalQty = 0, totalLines = 0;
  const activeZonesMap = {}, activeSlotsMap = {}, activeSkusMap = {};
  let totalWorkHours = 0;

  const targetDates = selectedPickerDate === 'all' ? datesArray : (pData.byDate[selectedPickerDate] ? [selectedPickerDate] : []);

  targetDates.forEach(d => {
    const dRec = pData.byDate[d];
    if(!dRec) return;
    totalPcs += dRec.pcs;
    totalQty += dRec.qty;
    totalLines += dRec.lines;

    // work hours per day
    if(dRec.minMinutes < dRec.maxMinutes){
      let spanMin = dRec.maxMinutes - dRec.minMinutes;
      let wh = spanMin / 60.0;
      if(wh >= 8.5 && wh <= 9.5 && dRec.maxMinutes <= 570) wh = 9.0;
      totalWorkHours += Math.max(wh, 0.1);
    }

    // zones
    Object.entries(dRec.zones || {}).forEach(([z, v]) => {
      const zRec = activeZonesMap[z] || (activeZonesMap[z] = { pcs: 0, qty: 0, lines: 0 });
      zRec.pcs += v.pcs; zRec.qty += v.qty; zRec.lines += v.lines;
    });

    // slots
    Object.entries(dRec.slots || {}).forEach(([hr, v]) => {
      const sRec = activeSlotsMap[hr] || (activeSlotsMap[hr] = { pcs: 0, qty: 0, lines: 0 });
      sRec.pcs += v.pcs; sRec.qty += v.qty; sRec.lines += v.lines;
    });

    // skus
    Object.entries(dRec.skus || {}).forEach(([key, v]) => {
      const kRec = activeSkusMap[key] || (activeSkusMap[key] = { owner:v.owner, sku:v.sku, pcs:0, qty:0, lines:0 });
      kRec.pcs += v.pcs; kRec.qty += v.qty; kRec.lines += v.lines;
    });
  });

  const isPcs = unitMode === 'pcs';
  const displayMainVal = isPcs ? totalPcs : totalQty;
  const displayMainUnit = isPcs ? 'ชิ้น' : 'หน่วยหยิบ';
  const prod = totalWorkHours > 0 ? (displayMainVal / totalWorkHours) : 0;

  const pickerName = pData.name !== '-' ? pData.name : pData.picker;
  const activeZonesList = Object.keys(activeZonesMap).sort((a,b) => (activeZonesMap[b].qty - activeZonesMap[a].qty) || (activeZonesMap[b].pcs - activeZonesMap[a].pcs));
  const activeSkusList = Object.keys(activeSkusMap).sort((a,b) => (activeSkusMap[b].qty - activeSkusMap[a].qty) || (activeSkusMap[b].pcs - activeSkusMap[a].pcs));
  const activeSlotsList = Object.keys(activeSlotsMap).map(Number).sort((a,b) => a - b);

  // Render Header KPIs & Details
  let html = `
  <div style="background:linear-gradient(135deg, #f8fafc 0%, #eef2ff 100%); border:1px solid #e2e8f0; border-radius:16px; padding:18px; margin-bottom:18px;">
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:14px;">
      <div>
        <div style="font-size:18px; font-weight:700; color:#1e293b; display:flex; align-items:center; gap:8px;">
          <span>👤 ${escapeZoneHtml(pickerName)}</span>
          <span style="font-size:12px; font-weight:600; color:#6366f1; background:#e0e7ff; padding:2px 8px; border-radius:6px;">รหัส ${escapeZoneHtml(pData.picker)}</span>
          <span style="font-size:12px; font-weight:600; color:#0f766e; background:#ccfbf1; padding:2px 8px; border-radius:6px;">สังกัด: ${escapeZoneHtml(pData.affiliation)}</span>
        </div>
        <div style="font-size:12px; color:#64748b; margin-top:4px;">
          📅 วันที่เลือก: <b>${selectedPickerDate === 'all' ? 'ทุกวันที่ (' + targetDates.length + ' วัน)' : selectedPickerDate}</b>
        </div>
      </div>
    </div>

    <!-- Mini KPIs -->
    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:10px;">
      <div style="background:#ffffff; padding:12px; border-radius:12px; border:1px solid #e2e8f0; box-shadow:0 2px 6px rgba(0,0,0,0.03);">
        <div style="font-size:11px; color:#64748b; font-weight:600;">ปริมาณชิ้น (QTY)</div>
        <div style="font-size:18px; font-weight:700; color:#0284c7; margin-top:2px;">${fmt(totalPcs)} <span style="font-size:11px; font-weight:400;">ชิ้น</span></div>
      </div>
      <div style="background:#ffffff; padding:12px; border-radius:12px; border:1px solid #e2e8f0; box-shadow:0 2px 6px rgba(0,0,0,0.03);">
        <div style="font-size:11px; color:#64748b; font-weight:600;">หน่วยหยิบ (BigQuery)</div>
        <div style="font-size:18px; font-weight:700; color:#4338ca; margin-top:2px;">${fmt(totalQty)} <span style="font-size:11px; font-weight:400;">หน่วย</span></div>
      </div>
      <div style="background:#ffffff; padding:12px; border-radius:12px; border:1px solid #e2e8f0; box-shadow:0 2px 6px rgba(0,0,0,0.03);">
        <div style="font-size:11px; color:#64748b; font-weight:600;">จำนวนบรรทัด</div>
        <div style="font-size:18px; font-weight:700; color:#0f766e; margin-top:2px;">${fmt(totalLines)} <span style="font-size:11px; font-weight:400;">lines</span></div>
      </div>
      <div style="background:#ffffff; padding:12px; border-radius:12px; border:1px solid #e2e8f0; box-shadow:0 2px 6px rgba(0,0,0,0.03);">
        <div style="font-size:11px; color:#64748b; font-weight:600;">ชั่วโมงหยิบจริง</div>
        <div style="font-size:18px; font-weight:700; color:#d97706; margin-top:2px;">${fmt(Math.round(totalWorkHours * 10) / 10)} <span style="font-size:11px; font-weight:400;">ชม.</span></div>
      </div>
      <div style="background:#ffffff; padding:12px; border-radius:12px; border:1px solid #e2e8f0; box-shadow:0 2px 6px rgba(0,0,0,0.03);">
        <div style="font-size:11px; color:#64748b; font-weight:600;">Productivity</div>
        <div style="font-size:18px; font-weight:700; color:#e11d48; margin-top:2px;">${fmt(Math.round(prod))} <span style="font-size:11px; font-weight:400;">${isPcs ? 'ชิ้น/ชม.' : 'หยิบ/ชม.'}</span></div>
      </div>
    </div>
  </div>

  <!-- Section Grid: Zone Breakdown & Time Slot -->
  <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:18px;">
    <!-- Zone Breakdown -->
    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:16px;">
      <h4 style="font-size:14px; font-weight:700; color:#1e293b; margin:0 0 10px; display:flex; justify-content:space-between;">
        <span>📍 โซนที่เข้าทำงาน (${activeZonesList.length} Zone)</span>
        <span style="font-size:11px; color:#64748b; font-weight:400;">เรียงตามปริมาณ</span>
      </h4>
      <div style="max-height:220px; overflow-y:auto;">
        <table style="width:100%; font-size:12.5px; border-collapse:collapse;">
          <thead>
            <tr style="background:#f8fafc; text-align:left; color:#64748b; font-size:11px;">
              <th style="padding:6px 8px;">Zone</th>
              <th style="padding:6px 8px;" class="num">ชิ้น (QTY)</th>
              <th style="padding:6px 8px;" class="num">หน่วยหยิบ</th>
              <th style="padding:6px 8px;" class="num">สัดส่วน</th>
            </tr>
          </thead>
          <tbody>`;

  activeZonesList.forEach(z => {
    const zv = activeZonesMap[z];
    const share = displayMainVal > 0 ? (isPcs ? (zv.pcs / displayMainVal) * 100 : (zv.qty / displayMainVal) * 100) : 0;
    html += `
            <tr style="border-bottom:1px solid #f1f5f9;">
              <td style="padding:7px 8px; font-weight:600;"><span class="pill">${escapeZoneHtml(z)}</span></td>
              <td style="padding:7px 8px;" class="num">${fmt(zv.pcs)}</td>
              <td style="padding:7px 8px;" class="num">${fmt(zv.qty)}</td>
              <td style="padding:7px 8px;" class="num"><span style="font-size:11px; font-weight:700; color:#6366f1;">${share.toFixed(1)}%</span></td>
            </tr>`;
  });

  html += `
          </tbody>
        </table>
      </div>
    </div>

    <!-- Time Slot Breakdown -->
    <div style="background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:16px;">
      <h4 style="font-size:14px; font-weight:700; color:#1e293b; margin:0 0 10px;">
        ⏰ ช่วงเวลาการทำงาน (Time Slot)
      </h4>
      <div style="max-height:220px; overflow-y:auto; padding-right:4px;">`;

  if(!activeSlotsList.length){
    html += `<div style="color:#94a3b8; text-align:center; padding:20px;">ไม่มีข้อมูลช่วงเวลา</div>`;
  } else {
    const maxValInSlots = Math.max(...activeSlotsList.map(hr => isPcs ? activeSlotsMap[hr].pcs : activeSlotsMap[hr].qty), 1);
    activeSlotsList.forEach(hr => {
      const sv = activeSlotsMap[hr];
      const val = isPcs ? sv.pcs : sv.qty;
      const pct = Math.min(100, Math.max(8, (val / maxValInSlots) * 100));
      const timeLabel = String(hr).padStart(2,'0') + ':00 - ' + String(hr).padStart(2,'0') + ':59';
      html += `
        <div style="margin-bottom:8px; font-size:12px;">
          <div style="display:flex; justify-content:space-between; margin-bottom:2px; font-weight:500;">
            <span style="color:#475569;">🕒 ${timeLabel}</span>
            <span style="font-weight:700; color:#0f172a;">${fmt(val)} ${displayMainUnit} <span style="font-size:10px; color:#94a3b8;">(${fmt(sv.lines)} lines)</span></span>
          </div>
          <div style="width:100%; height:8px; background:#f1f5f9; border-radius:4px; overflow:hidden;">
            <div style="width:${pct.toFixed(1)}%; height:100%; background:linear-gradient(90deg, #6366f1, #8b5cf6); border-radius:4px;"></div>
          </div>
        </div>`;
    });
  }

  html += `
      </div>
    </div>
  </div>

  <!-- SKU / Item Breakdown Table -->
  <div style="background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:16px;">
    <h4 style="font-size:14px; font-weight:700; color:#1e293b; margin:0 0 10px; display:flex; justify-content:space-between;">
      <span>📦 รายการสินค้าที่หยิบ (${activeSkusList.length} SKUs)</span>
      <span style="font-size:11px; color:#64748b; font-weight:400;">เรียงตามปริมาณ</span>
    </h4>
    <div style="max-height:280px; overflow-x:auto; overflow-y:auto;">
      <table style="width:100%; font-size:12.5px; border-collapse:collapse;">
        <thead>
          <tr style="background:#f8fafc; text-align:left; color:#64748b; font-size:11px; position:sticky; top:0; z-index:2;">
            <th style="padding:8px 10px;">#</th>
            <th style="padding:8px 10px;">รหัส SKU</th>
            <th style="padding:8px 10px;">ชื่อสินค้า</th>
            <th style="padding:8px 10px;">Owner</th>
            <th style="padding:8px 10px;" class="num">ชิ้น (QTY)</th>
            <th style="padding:8px 10px;" class="num">หน่วยหยิบ (BigQuery)</th>
            <th style="padding:8px 10px;" class="num">จำนวน Lines</th>
          </tr>
        </thead>
        <tbody>`;

  if(!activeSkusList.length){
    if(pickerSkuState && pickerSkuState.status === 'loading'){
      html += `<tr><td colspan="7" class="empty-cell">⏳ กำลังโหลดรายการ SKU ของพนักงานคนนี้…</td></tr>`;
    }else if(pickerSkuState && pickerSkuState.status === 'error'){
      html += `<tr><td colspan="7" class="empty-cell">⚠️ ${escapeZoneHtml(pickerSkuState.message || 'โหลดรายการ SKU ไม่สำเร็จ')} <button type="button" onclick="retryPickerItemsLoad()">ลองอีกครั้ง</button></td></tr>`;
    }else if(pData._skuLoadKey === pickerSkuRequestKey){
      html += `<tr><td colspan="7" class="empty-cell">ไม่พบรายการ SKU ในช่วงวันที่และตัวกรองที่เลือก</td></tr>`;
    }else{
      html += `<tr><td colspan="7" class="empty-cell">⏳ กำลังเตรียมโหลดรายการ SKU รายพนักงาน…</td></tr>`;
    }
  }
  activeSkusList.forEach((itemKey, idx) => {
    const kv = activeSkusMap[itemKey];
    const info = getItemInfo(kv.owner, kv.sku);
    html += `
          <tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:7px 10px;"><span class="rank" style="font-size:11px; width:20px; height:20px;">${idx + 1}</span></td>
            <td style="padding:7px 10px; font-weight:700; color:#0f172a;">${escapeZoneHtml(kv.sku)}</td>
            <td style="padding:7px 10px; color:#334155;"><div style="font-weight:600;">${escapeZoneHtml(info.name)}</div></td>
            <td style="padding:7px 10px;"><span class="pill" style="font-size:11px;">${escapeZoneHtml(info.owner)}</span></td>
            <td style="padding:7px 10px;" class="num" style="font-weight:700; color:#0284c7;">${fmt(kv.pcs)}</td>
            <td style="padding:7px 10px;" class="num" style="font-weight:700; color:#4338ca;">${fmt(kv.qty)}</td>
            <td style="padding:7px 10px;" class="num">${fmt(kv.lines)}</td>
          </tr>`;
  });

  html += `
        </tbody>
      </table>
    </div>
  </div>`;

  contentEl.innerHTML = html;
}

// ===== chart builders =====
const builders = {
  overview(){
    const daily = A.daily;
    const isPcs = unitMode === 'pcs';

    function bucket(mode){
      const map = {};
      daily.forEach(d => {
        let k = d.date; const dt = new Date(d.date);
        if(mode === 'week'){ const day = (dt.getDay()+6)%7; const mo = new Date(dt); mo.setDate(dt.getDate()-day); k = 'wk '+mo.toISOString().slice(5,10); }
        if(mode === 'month') k = d.date.slice(0,7);
        if(!map[k]) map[k] = {pcs:0, qty:0, ps:[], psPcs:[]};
        map[k].pcs += Number(d.pcs) || 0;
        map[k].qty += d.qty;
        if(d.avg_prod>0) map[k].ps.push(d.avg_prod);
        if(d.avg_pcs_prod>0) map[k].psPcs.push(d.avg_pcs_prod);
      });
      const ks = Object.keys(map).sort();
      return {
        labels:ks,
        pcs:ks.map(k=>map[k].pcs),
        qty:ks.map(k=>map[k].qty),
        prod:ks.map(k=>map[k].ps.length?Math.round(map[k].ps.reduce((a,b)=>a+b,0)/map[k].ps.length*10)/10:0),
        pcsProd:ks.map(k=>map[k].psPcs.length?Math.round(map[k].psPcs.reduce((a,b)=>a+b,0)/map[k].psPcs.length*10)/10:0)
      };
    }
    function drawTrend(mode){
      const b = bucket(mode);
      const mainQty = isPcs ? b.pcs : b.qty;
      const mainLabel = isPcs ? 'จำนวนชิ้น' : 'หน่วยหยิบ';
      const prodData = isPcs ? b.pcsProd : b.prod;
      const prodLabel = isPcs ? 'Productivity (ชิ้น/ชม.)' : 'Productivity (หยิบ/ชม.)';

      const maxMainQty = Math.max(1, ...mainQty);
      const cfg = {data:{labels:b.labels, datasets:[
        {
          type:'bar',
          label:mainLabel,
          data:mainQty,
          backgroundColor:isPcs?'rgba(20,184,166,.85)':'rgba(99,102,241,.85)',
          borderRadius:6,
          yAxisID:'y',
          datalabels:{
            display:(ctx)=>{
              const v = Number(ctx.dataset.data[ctx.dataIndex] || 0);
              return v > 0 && (v / maxMainQty >= .08 || ctx.dataset.data.length <= 2);
            },
            anchor:'end',
            align:'start',
            offset:4,
            formatter:fmt,
            color:'#fff',
            backgroundColor:'rgba(15,23,42,.16)',
            borderRadius:4,
            padding:{top:2,right:5,bottom:2,left:5},
            font:{weight:'700', size:10}
          }
        },
        {
          type:'line',
          label:prodLabel,
          data:prodData,
          borderColor:'#f43f5e',
          backgroundColor:'#f43f5e',
          tension:.35,
          borderWidth:3,
          pointRadius:5,
          pointBackgroundColor:'#fff',
          pointBorderWidth:2,
          yAxisID:'y1',
          datalabels:{
            display:(ctx)=>Number(ctx.dataset.data[ctx.dataIndex] || 0) > 0,
            align:'top',
            offset:10,
            color:'#e11d48',
            backgroundColor:'rgba(255,255,255,.96)',
            borderColor:'rgba(244,63,94,.28)',
            borderWidth:1,
            borderRadius:4,
            padding:{top:2,right:5,bottom:2,left:5},
            formatter:fmt,
            font:{weight:'700', size:10}
          }
        }
      ]}, options:{maintainAspectRatio:false, layout:{padding:{top:36,right:12,bottom:18,left:4}}, plugins:{legend:{display:true, position:'top', labels:{usePointStyle:true, boxWidth:8}}, datalabels:{clip:false, clamp:true}}, scales:{y:{grid:{color:'#eef2f7'}, ticks:{callback:fmt}}, y1:{position:'right', grid:{drawOnChartArea:false}, ticks:{callback:fmt}}}}};
      const ex = Chart.getChart('trend'); if(ex) ex.destroy();
      new Chart(document.getElementById('trend'), cfg);
    }
    drawTrend(trendMode);
    document.querySelectorAll('#seg button').forEach(b => b.onclick = () => {
      document.querySelectorAll('#seg button').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); trendMode = b.dataset.mode; drawTrend(trendMode);
    });
    document.querySelectorAll('#seg button').forEach(b => b.classList.toggle('active', b.dataset.mode === trendMode));
    const pttTotals = sysTotals('PTT', dfrom, dto, shiftF);
    const bpsTotals = sysTotals('BPS', dfrom, dto, shiftF);
    const catData = isPcs
      ? [pttTotals.pcs, bpsTotals.pcs]
      : [pttTotals.qty, bpsTotals.qty];
    const unitTxt = isPcs ? 'ชิ้น' : 'หน่วยหยิบ';
    const donutUnitTxt = isPcs ? 'ชิ้น' : 'หยิบ';
    const donutTotal = catData.reduce((a,b)=>a+b,0) || 1;
    const donutPct = v => (Number(v) || 0) / donutTotal * 100;

    // Update Stats Panel for BPS vs PTT
    const totalVol = catData.reduce((a, b) => a + b, 0);
    const pttPctVal = totalVol > 0 ? ((catData[0] / totalVol) * 100).toFixed(1) : '0.0';
    const bpsPctVal = totalVol > 0 ? ((catData[1] / totalVol) * 100).toFixed(1) : '0.0';

    const catBadgeEl = document.getElementById('catTotalBadge');
    if (catBadgeEl) catBadgeEl.textContent = `รวม ${fmt(Math.ceil(totalVol))} ${unitTxt}`;

    const pttPctEl = document.getElementById('pttSharePct');
    if (pttPctEl) pttPctEl.textContent = `${pttPctVal}%`;
    const pttValEl = document.getElementById('pttVal');
    if (pttValEl) pttValEl.textContent = `${fmt(Math.ceil(catData[0]))} ${unitTxt}`;
    const pttSubEl = document.getElementById('pttSubText');
    if (pttSubEl) pttSubEl.textContent = `${fmt(pttTotals.pcs)} ชิ้น · ${fmt(pttTotals.lines)} Lines`;

    const bpsPctEl = document.getElementById('bpsSharePct');
    if (bpsPctEl) bpsPctEl.textContent = `${bpsPctVal}%`;
    const bpsValEl = document.getElementById('bpsVal');
    if (bpsValEl) bpsValEl.textContent = `${fmt(Math.ceil(catData[1]))} ${unitTxt}`;
    const bpsSubEl = document.getElementById('bpsSubText');
    if (bpsSubEl) bpsSubEl.textContent = `${fmt(bpsTotals.pcs)} ชิ้น · ${fmt(bpsTotals.lines)} Lines`;

    // Re-render Cat Donut Chart with clean layout
    const exCat = Chart.getChart('cat'); if (exCat) exCat.destroy();
    new Chart(document.getElementById('cat'), {
      type: 'doughnut',
      data: {
        labels: ['Pick (PTT)', 'Pick to Sort (BPS)'],
        datasets: [{ data: catData, backgroundColor: ['#6366f1', '#f59e0b'], borderWidth: 3, borderColor: '#fff' }]
      },
      options: {
        maintainAspectRatio: false,
        layout: { padding: 10 },
        cutout: '68%',
        plugins: {
          legend: { display: false },
          datalabels: {
            display: (ctx) => Number(ctx.dataset.data[ctx.dataIndex] || 0) > 0,
            color: '#fff',
            font: { size: 11, weight: '700' },
            formatter: (v) => Math.round(donutPct(v)) + '%'
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const idx = ctx.dataIndex;
                const sysName = ctx.label;
                const pVal = idx === 0 ? pttTotals.pcs : bpsTotals.pcs;
                const qVal = idx === 0 ? pttTotals.qty : bpsTotals.qty;
                return [` ${sysName}`, ` จำนวนชิ้น: ${fmt(pVal)} ชิ้น`, ` หน่วยหยิบ: ${fmt(qVal)} หน่วย`];
              }
            }
          }
        }
      }
    });

    // Calculate Full Dynamic Type Pick Breakdown (All Type Pick Categories)
    const typePickMap = new Map();
    (A.by_location || []).forEach(loc => {
      const zInfo = getZoneInfo(loc.location);
      const val = isPcs ? Number(loc.pcs || 0) : Number(loc.qty || 0);
      const t = String(zInfo.typePick || 'อื่นๆ').trim() || 'อื่นๆ';
      typePickMap.set(t, (typePickMap.get(t) || 0) + val);
    });

    const sortedTypePicks = [...typePickMap.entries()].sort((a, b) => b[1] - a[1]);
    const typePickLabels = sortedTypePicks.map(x => x[0]);
    const typePickValues = sortedTypePicks.map(x => x[1]);
    const typePickColors = typePickLabels.map(lbl => colorForLabel(ZONE_TYPE_COLORS, lbl));

    const exStorage = Chart.getChart('storageTypeChart'); if (exStorage) exStorage.destroy();
    const storageEl = document.getElementById('storageTypeChart');
    if (storageEl) {
      new Chart(storageEl, {
        type: 'bar',
        data: {
          labels: typePickLabels,
          datasets: [{
            label: unitTxt,
            data: typePickValues,
            backgroundColor: typePickColors,
            borderRadius: 6,
            barThickness: 18
          }]
        },
        options: {
          indexAxis: 'y',
          maintainAspectRatio: false,
          layout: { padding: { top: 8, right: 45, bottom: 8, left: 10 } },
          plugins: {
            legend: { display: false },
            datalabels: {
              anchor: 'end',
              align: 'end',
              color: '#334155',
              font: { weight: '700', size: 10.5 },
              formatter: (v) => fmt(Math.ceil(v))
            }
          },
          scales: {
            x: { grid: { color: '#f1f5f9' }, ticks: { callback: fmt } },
            y: { grid: { display: false }, ticks: { font: { weight: '600', size: 11 } } }
          }
        }
      });
    }

    // 1. Hourly Peak Activity Timeline (00:00 - 23:00)
    const hourlyVol = new Array(24).fill(0);
    [sys].forEach(sName => {
      forEachCurrentSlotRow(sName, dfrom, dto, shiftF, row => {
        if(isZoneExcluded(getZoneInfo(row.zone).zone)) return;
        const hr = row.hour;
        const val = isPcs ? row.pcs : row.pickQty;
        hourlyVol[hr] += val;
      });
    });

    const hourlyLabels = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0') + ':00');
    const exHourly = Chart.getChart('hourlyPeakChart'); if (exHourly) exHourly.destroy();
    const hourlyEl = document.getElementById('hourlyPeakChart');
    if (hourlyEl) {
      const maxVol = Math.max(1, ...hourlyVol);
      new Chart(hourlyEl, {
        type: 'line',
        data: {
          labels: hourlyLabels,
          datasets: [{
            label: `ปริมาณการหยิบ (${unitTxt})`,
            data: hourlyVol,
            borderColor: '#6366f1',
            backgroundColor: 'rgba(99, 102, 241, 0.12)',
            fill: true,
            tension: 0.35,
            borderWidth: 2.8,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointBackgroundColor: '#4338ca'
          }]
        },
        options: {
          maintainAspectRatio: false,
          layout: { padding: { top: 32, right: 16, bottom: 8, left: 4 } },
          plugins: {
            legend: { display: false },
            datalabels: {
              display: (ctx) => {
                const val = ctx.dataset.data[ctx.dataIndex];
                return val > 0 && (val >= maxVol * 0.15 || ctx.dataIndex % 2 === 0);
              },
              anchor: 'end',
              align: 'top',
              offset: 6,
              color: '#3730a3',
              backgroundColor: 'rgba(255, 255, 255, 0.95)',
              borderColor: 'rgba(99, 102, 241, 0.3)',
              borderWidth: 1,
              borderRadius: 4,
              padding: { top: 2, right: 5, bottom: 2, left: 5 },
              font: { weight: '700', size: 10.5 },
              formatter: (v) => fmt(Math.ceil(v))
            }
          },
          scales: {
            x: { grid: { color: '#f1f5f9' }, ticks: { font: { weight: '600', size: 11 } } },
            y: { grid: { color: '#f1f5f9' }, ticks: { callback: fmt } }
          }
        }
      });
    }

    // 2. Owner Volume Share Chart
    const ownerMap = new Map();
    (A.by_location || []).forEach(loc => {
      const zInfo = getZoneInfo(loc.location);
      const owner = zInfo.owner && zInfo.owner !== '-' ? zInfo.owner : 'อื่นๆ';
      const val = isPcs ? Number(loc.pcs || 0) : Number(loc.qty || 0);
      ownerMap.set(owner, (ownerMap.get(owner) || 0) + val);
    });

    const sortedOwners = [...ownerMap.entries()].sort((a, b) => b[1] - a[1]);
    const ownerLabels = sortedOwners.map(x => x[0]);
    const ownerValues = sortedOwners.map(x => x[1]);
    const ownerColors = ['#f59e0b', '#10b981', '#6366f1', '#ec4899', '#8b5cf6', '#64748b'];

    const exOwner = Chart.getChart('ownerShareChart'); if (exOwner) exOwner.destroy();
    const ownerEl = document.getElementById('ownerShareChart');
    if (ownerEl) {
      new Chart(ownerEl, {
        type: 'bar',
        data: {
          labels: ownerLabels,
          datasets: [{
            label: unitTxt,
            data: ownerValues,
            backgroundColor: ownerColors.slice(0, ownerLabels.length),
            borderRadius: 6,
            barThickness: 24
          }]
        },
        options: {
          maintainAspectRatio: false,
          layout: { padding: { top: 18, right: 12, bottom: 4, left: 4 } },
          plugins: {
            legend: { display: false },
            datalabels: {
              anchor: 'end',
              align: 'end',
              offset: 2,
              color: '#334155',
              font: { weight: '700', size: 10.5 },
              formatter: (v) => fmt(Math.ceil(v))
            }
          },
          scales: {
            x: { grid: { display: false }, ticks: { font: { weight: '600', size: 11 } } },
            y: { grid: { color: '#f1f5f9' }, ticks: { callback: fmt } }
          }
        }
      });
    }

    // Affiliation Performance Chart for Overview
    const affMap = new Map();
    ['PTT', 'BPS'].forEach(sName => {
      const S = DATA[sName];
      if (!S || !Array.isArray(S.rows)) return;
      const count = packedRowCount(S);
      for (let i = 0; i < count; i++) {
        const sh = S._sh ? S._sh[i] : null;
        if (!sh || sh.sd < dfrom || sh.sd > dto) continue;
        if (shiftF !== 'all' && sh.sh !== shiftF) continue;
        const row = packedRowData(S, i);
        if(isZoneExcluded(getZoneInfo(row.zone).zone)) continue;

        const val = isPcs ? row.pcs : row.pickQty;
        const pickerId = String(S.pickers[row.pickerIdx] || '-').trim();
        const aff = getPickerAffiliation(pickerId);
        if (!affMap.has(aff)) affMap.set(aff, { val: 0, pickers: new Set() });
        const affRec = affMap.get(aff);
        affRec.val += val;
        affRec.pickers.add(pickerId);
      }
    });

    const exAffChart = Chart.getChart('macroAffiliationChart'); if (exAffChart) exAffChart.destroy();
    const affChartEl = document.getElementById('macroAffiliationChart');
    if (affChartEl) {
      const sortedAff = [...affMap.entries()].sort((a, b) => b[1].val - a[1].val);
      const affLabels = sortedAff.map(x => x[0]);
      const affValues = sortedAff.map(x => x[1].val);
      const affPickers = sortedAff.map(x => x[1].pickers.size);

      new Chart(affChartEl, {
        type: 'bar',
        data: {
          labels: affLabels,
          datasets: [
            {
              label: `ปริมาณหยิบ (${unitTxt})`,
              data: affValues,
              backgroundColor: '#0f766e',
              borderRadius: 6,
              yAxisID: 'y'
            },
            {
              label: 'จำนวนพนักงาน (คน)',
              data: affPickers,
              backgroundColor: '#f59e0b',
              borderRadius: 6,
              yAxisID: 'y1'
            }
          ]
        },
        options: {
          maintainAspectRatio: false,
          layout: { padding: { top: 18, right: 12, bottom: 4, left: 4 } },
          plugins: {
            legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 8, font: { size: 10.5 } } },
            datalabels: {
              anchor: 'end',
              align: 'end',
              font: { weight: '700', size: 10 },
              formatter: (v) => fmt(Math.ceil(v))
            }
          },
          scales: {
            x: { grid: { display: false }, ticks: { font: { weight: '600', size: 11 } } },
            y: { position: 'left', grid: { color: '#f1f5f9' }, ticks: { callback: fmt } },
            y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: fmt } }
          }
        }
      });
    }

    // 3. Shift Performance Comparison (Day Shift vs Night Shift)
    let dayVol = 0, nightVol = 0;
    ['PTT', 'BPS'].forEach(sName => {
      const S = DATA[sName];
      if (!S || !Array.isArray(S.rows)) return;
      const count = packedRowCount(S);
      for (let i = 0; i < count; i++) {
        const sh = S._sh ? S._sh[i] : null;
        if (!sh || sh.sd < dfrom || sh.sd > dto) continue;
        if (shiftF !== 'all' && sh.sh !== shiftF) continue;
        const row = packedRowData(S, i);
        if(isZoneExcluded(getZoneInfo(row.zone).zone)) continue;

        const val = isPcs ? row.pcs : row.pickQty;
        if (sh.sh === 'night') nightVol += val;
        else dayVol += val;
      }
    });

    const exShift = Chart.getChart('shiftCompareChart'); if (exShift) exShift.destroy();
    const shiftEl = document.getElementById('shiftCompareChart');
    if (shiftEl) {
      new Chart(shiftEl, {
        type: 'bar',
        data: {
          labels: ['🅰️ กะ A', '🅱️ กะ B'],
          datasets: [{
            label: unitTxt,
            data: [dayVol, nightVol],
            backgroundColor: ['#f59e0b', '#6366f1'],
            borderRadius: 8,
            barThickness: 32
          }]
        },
        options: {
          maintainAspectRatio: false,
          layout: { padding: { top: 22, right: 12, bottom: 4, left: 4 } },
          plugins: {
            legend: { display: false },
            datalabels: {
              anchor: 'end',
              align: 'end',
              offset: 3,
              color: '#0f172a',
              font: { weight: '800', size: 12 },
              formatter: (v) => fmt(Math.ceil(v)) + ' ' + unitTxt
            }
          },
          scales: {
            x: { grid: { display: false }, ticks: { font: { weight: '700', size: 11.5 } } },
            y: { grid: { color: '#f1f5f9' }, ticks: { callback: fmt } }
          }
        }
      });
    }
  },
  prod(){
    renderTargetVsActualChart();

    const isPcs = unitMode === 'pcs';
    let p = [...A.by_picker];
    p.sort((a, b) => isPcs ? (b.avg_pcs_prod - a.avg_pcs_prod) : (b.avg_prod - a.avg_prod));
    p = p.slice(0, 12);

    const mainProd = isPcs ? p.map(x => x.avg_pcs_prod) : p.map(x => x.avg_prod);
    const unitLabel = isPcs ? 'ชิ้น/ชม.' : 'หยิบ/ชม.';

    const exPicker = Chart.getChart('picker'); if (exPicker) exPicker.destroy();
    new Chart(document.getElementById('picker'), {
      type:'bar',
      data:{labels:p.map(x=>x.picker+' ('+x.location+')'), datasets:[{data:mainProd, backgroundColor:p.map((x,i)=>PALETTE[i%PALETTE.length]), borderRadius:6}]},
      options:{
        indexAxis:'y', maintainAspectRatio:false, layout:{padding:{right:55}},
        plugins:{
          legend:{display:false},
          datalabels:{anchor:'end', align:'end', formatter:(v)=>fmt(v)+' '+unitLabel, color:'#334155', font:{size:10, weight:'600'}},
          tooltip:{
            callbacks:{
              label:(ctx)=>{
                const picker = p[ctx.dataIndex];
                const zoneInfo = getZoneInfo(picker.location);
                const affiliation = picker.affiliation || getPickerAffiliation(picker.picker);
                return [
                  ` สังกัด: ${affiliation}`,
                  ` พนักงาน: ${picker.picker}${picker.name && picker.name !== picker.picker ? ' · ' + picker.name : ''}`,
                  ` Location / Zone: ${picker.location} / ${picker.zone}`,
                  ` Type Pick / Owner: ${zoneInfo.typePick} / ${zoneInfo.owner}`,
                  ` Productivity (หยิบ): ${fmt(picker.avg_prod)} หยิบ/ชม.`,
                  ` Productivity (ชิ้น): ${fmt(picker.avg_pcs_prod)} ชิ้น/ชม.`,
                  ` ปริมาณ: ${fmt(picker.pcs)} ชิ้น (${fmt(picker.qty)} หน่วยหยิบ) (OT: ${picker.ot > 0 ? picker.ot+' ชม.' : '-'})`
                ];
              }
            }
          }
        },
        scales:{x:{grid:{color:'#eef2f7'}, ticks:{callback:fmt}}, y:{grid:{display:false}}}
      }
    });
    renderAffiliationBreakdown();
  },
  zones(){
    const z = [...A.by_zone];
    const isPcs = unitMode === 'pcs';
    z.sort((a, b) => (b.qty - a.qty) || (b.pcs - a.pcs));
    const chartValues = isPcs ? z.map(x=>x.pcs) : z.map(x=>x.qty);
    const chartLabel = isPcs ? 'จำนวนชิ้น' : 'หน่วยหยิบ';
    const activeLocations = new Map(A.by_location.map(x => [x.location, x]));
    const masterEntries = getZoneMasterEntries();
    const masterLocationsByZone = {};
    masterEntries.forEach(x => {
      (masterLocationsByZone[x.zone] = masterLocationsByZone[x.zone] || []).push(x.location);
    });
    Object.values(masterLocationsByZone).forEach(list => list.sort());
    const unknownActive = A.by_location.filter(x => !ZONE_MASTER[x.location]);
    const locationRows = masterEntries.map(x => ({
      ...x,
      ...(activeLocations.get(x.location) || {pcs:0, qty:0, lines:0, pickers:0})
    })).concat(unknownActive);
    locationRows.sort((a,b) => {
      const av = Number(a.qty || 0);
      const bv = Number(b.qty || 0);
      return (bv - av) || (Number(b.pcs || 0) - Number(a.pcs || 0)) || a.location.localeCompare(b.location);
    });

    const summary = document.getElementById('zoneSummary');
    if(summary){
      const allTypes = new Set(masterEntries.map(x=>x.typePick).filter(x=>x && x !== '-'));
      const allOwners = new Set(masterEntries.map(x=>x.owner).filter(x=>x && x !== '-'));
      const cards = [
        {label:'Zone ที่มีรายการ', value:z.length, detail:`จาก Master ${new Set(masterEntries.map(x=>x.zone)).size} Zone`},
        {label:'Location ที่ใช้งาน', value:A.by_location.length, detail:`จาก Master ${masterEntries.length} Location`},
        {label:'Type Pick', value:allTypes.size, detail:[...allTypes].sort().join(' · ')},
        {label:'Owner', value:allOwners.size, detail:[...allOwners].sort().join(' · ')},
        {
          label:'Location นอก Zone_V2',
          value:unknownActive.length,
          detail:unknownActive.length ? unknownActive.map(x=>x.location).sort().join(', ') : 'ข้อมูลครบตาม Master'
        }
      ];
      summary.innerHTML = cards.map(card =>
        `<div class="zone-stat"><div class="zone-stat-label">${escapeZoneHtml(card.label)}</div>` +
        `<div class="zone-stat-value">${fmt(card.value)}</div><div class="zone-stat-detail">${escapeZoneHtml(card.detail)}</div></div>`
      ).join('');
    }

    renderWarehouseMap(activeLocations, isPcs);
    renderZoneProductivityBreakdown();

    new Chart(document.getElementById('zone'), {
      type:'bar',
      data:{labels:z.map(x=>x.zone), datasets:[{
        label:chartLabel, data:chartValues,
        backgroundColor:isPcs?'rgba(20,184,166,.9)':'rgba(99,102,241,.9)',
        borderRadius:6
      }]},
      options:{
        maintainAspectRatio:false, layout:{padding:{top:22}},
        plugins:{
          legend:{display:true, position:'top', labels:{usePointStyle:true, boxWidth:8}},
          datalabels:{anchor:'end', align:'end', formatter:fmt, color:'#334155', font:{size:10, weight:'600'}},
          tooltip:{
            callbacks:{
              afterLabel:(ctx)=>{
                const row = z[ctx.dataIndex];
                const locations = masterLocationsByZone[row.zone] || row.locations || [];
                return [
                  `Type Pick: ${row.typePick || '-'}`,
                  `Owner: ${row.owner || '-'}`,
                  `Location: ${locations.join(', ') || '-'}`,
                  `จำนวนชิ้น: ${fmt(row.pcs)} ชิ้น`,
                  `หน่วยหยิบ: ${fmt(row.qty)} หน่วย`
                ];
              }
            }
          }
        },
        scales:{y:{grid:{color:'#eef2f7'}, ticks:{callback:fmt}}, x:{grid:{display:false}}}
      }
    });

    const maxV = Math.max(1, ...z.map(x => isPcs ? x.pcs : x.qty));
    const heat = document.getElementById('heat'); heat.innerHTML = '';
    z.forEach(x => {
      const val = isPcs ? x.pcs : x.qty;
      const t = Math.pow(val/maxV, .55), c1 = [224,231,255], c2 = [67,56,202];
      const mx = c1.map((v,i)=>Math.round(v+(c2[i]-v)*t));
      const e = document.createElement('div'); e.className = 'tile'; e.style.background = 'rgb('+mx.join(',')+')';
      if(t < .35) e.style.color = '#334155';
      const mainTxt = isPcs ? `${fmt(x.pcs)} ชิ้น (${fmt(x.qty)} หน่วย)` : `${fmt(x.qty)} หน่วย (${fmt(x.pcs)} ชิ้น)`;
      const locations = masterLocationsByZone[x.zone] || x.locations || [];
      e.innerHTML =
        `<div class="z">${escapeZoneHtml(x.zone)}</div>` +
        `<div class="zone-tags"><span>${escapeZoneHtml(x.typePick || '-')}</span><span>${escapeZoneHtml(x.owner || '-')}</span></div>` +
        `<div class="q">${escapeZoneHtml(mainTxt)}</div>` +
        `<div class="p">Location: ${escapeZoneHtml(locations.join(', ') || '-')} · ${fmt(x.pickers)} คน</div>`;
      heat.appendChild(e);
    });

    const table = document.getElementById('zoneTable');
    if(table){
      const pcsHeaderStyle = isPcs ? 'background:#e0f2fe;color:#0369a1;font-weight:700;' : '';
      const qtyHeaderStyle = !isPcs ? 'background:#e0e7ff;color:#3730a3;font-weight:700;' : '';
      let h = `<thead><tr><th>#</th><th>Location</th><th>Zone</th><th>Type Pick</th><th>Owner</th>` +
        `<th class="num" style="${pcsHeaderStyle}">จำนวนชิ้น ${isPcs ? '★' : ''}</th>` +
        `<th class="num" style="${qtyHeaderStyle}">หน่วยหยิบ ${!isPcs ? '★' : ''}</th>` +
        `<th class="num">Picker</th><th>สถานะช่วงที่เลือก</th></tr></thead><tbody>`;
      locationRows.forEach((row, i) => {
        const active = Number(row.lines || 0) > 0;
        h += `<tr class="${active ? '' : 'zone-inactive'}">` +
          `<td><span class="rank">${i+1}</span></td>` +
          `<td><b>${escapeZoneHtml(row.location)}</b></td>` +
          `<td><span class="pill">${escapeZoneHtml(row.zone)}</span></td>` +
          `<td>${escapeZoneHtml(row.typePick)}</td>` +
          `<td>${escapeZoneHtml(row.owner)}</td>` +
          `<td class="num" style="${pcsHeaderStyle}">${fmt(row.pcs || 0)}</td>` +
          `<td class="num" style="${qtyHeaderStyle}">${fmt(row.qty || 0)}</td>` +
          `<td class="num">${fmt(row.pickers || 0)}</td>` +
          `<td><span class="zone-status ${active ? 'active' : ''}">${active ? 'มีรายการ' : 'ไม่มีรายการ'}</span></td></tr>`;
      });
      h += '</tbody>';
      table.innerHTML = h;
    }
  },
  typebreak(){
    renderTypeBreakdownPage();
  },
  pickers(){
    renderPickerDrilldown();

    const isPcs = unitMode === 'pcs';
    const list = [...A.by_picker];
    list.sort((a, b) => (b.qty - a.qty) || (b.pcs - a.pcs));

    const pcsHeaderStyle = isPcs ? 'background:#e0f2fe;color:#0369a1;font-weight:700;' : '';
    const qtyHeaderStyle = !isPcs ? 'background:#e0e7ff;color:#3730a3;font-weight:700;' : '';
    const prodHeaderLabel = isPcs ? 'ชิ้น/ชม.' : 'หยิบ/ชม.';

    let h = `<thead><tr><th>#</th><th>รหัส Picker</th><th>ชื่อพนักงาน</th><th>สังกัด</th><th>กะ</th><th>โซนหลัก</th><th class="num" style="${pcsHeaderStyle}">ชิ้น (QTY เดิม) ${isPcs ? '★' : ''}</th><th class="num" style="${qtyHeaderStyle}">หน่วยหยิบ (BigQuery) ${!isPcs ? '★' : ''}</th><th class="num">OT (ชม.)</th><th class="num">${prodHeaderLabel}</th><th style="text-align:center;">เจาะลึก</th></tr></thead><tbody>`;
    if(!list.length) h += '<tr><td colspan="11" style="text-align:center;color:#94a3b8;padding:24px">ไม่มีข้อมูลในช่วงที่เลือก</td></tr>';
    list.forEach((p,i) => {
      const pcsCellStyle = isPcs ? 'background:#f0f9ff;font-weight:700;color:#0284c7;' : 'color:#0f766e;font-weight:600;';
      const qtyCellStyle = !isPcs ? 'background:#e0e7ff;color:#3730a3;font-weight:700;' : 'color:#4338ca;font-weight:600;';
      const prodValue = isPcs ? (p.avg_pcs_prod || 0) : (p.avg_prod || 0);
      const pickerName = p.name || getPickerName(p.picker);
      const pickerNameText = pickerName && pickerName !== p.picker ? pickerName : '-';
      const itemTarget = getTargetForZoneOrType(p.typePick, p.location);
      const isLow = prodValue < itemTarget;
      const prodBadge = isLow
        ? `<span style="background:#fee2e2; color:#991b1b; font-size:10px; padding:2px 6px; border-radius:4px; font-weight:700; margin-left:4px; white-space:nowrap;" title="เป้าหมายโซนนี้: ${itemTarget}">⚠️ ต่ำกว่าเป้า (${itemTarget})</span>`
        : `<span style="background:#dcfce7; color:#15803d; font-size:10px; padding:2px 6px; border-radius:4px; font-weight:700; margin-left:4px; white-space:nowrap;" title="เป้าหมายโซนนี้: ${itemTarget}">✓ ผ่าน (${itemTarget})</span>`;
      const prodColor = isLow ? '#dc2626' : '#16a34a';

      h += `<tr style="cursor:pointer; ${isLow ? 'background:#fff5f5;' : ''}" onclick="selectPickerDrilldown('${p.picker}')" title="คลิกเพื่อดูรายงานเจาะลึกของ ${escapeZoneHtml(p.picker)}">
        <td><span class="rank">${i + 1}</span></td>
        <td><b>${p.picker}</b></td>
        <td style="line-height:1.35;"><div style="font-weight:600;">${pickerNameText}</div>${pickerNameText !== '-' ? `<div style="font-size:11px;color:#94a3b8;">${p.picker}</div>` : ''}</td>
        <td><span class="pill">${escapeZoneHtml(p.affiliation || getPickerAffiliation(p.picker))}</span></td>
        <td>${SHIFT_LABEL[p.shift] || p.shift}</td>
        <td><span class="pill">${p.zone}</span><div style="font-size:11px;color:#94a3b8;margin-top:3px;">Location ${p.location}</div></td>
        <td class="num" style="${pcsCellStyle}">${fmt(p.pcs)}</td>
        <td class="num" style="${qtyCellStyle}">${fmt(p.qty)}</td>
        <td class="num">${p.ot > 0 ? fmt(p.ot) : '-'}</td>
        <td class="num" style="font-weight:700;color:${prodColor};">${fmt(prodValue)} ${prodBadge}</td>
        <td style="text-align:center;"><button style="border:0; background:#e0e7ff; color:#4338ca; padding:4px 10px; border-radius:6px; font-size:11.5px; font-weight:600; cursor:pointer;">🔍 ดูเจาะลึก</button></td>
      </tr>`;
    });
    h += '</tbody>'; document.getElementById('ptable').innerHTML = h;
  },
  time(){
    if(!hasCurrentSlotCube()) setTimeout(() => void loadCurrentSlotCube(false), 0);
    const t = A.by_timeslot;
    const slotState = slotCubeLoadState.get(slotCubeRequestKey());
    const status = document.getElementById('slotLoadStatus');
    if(status){
      if(t.length) status.innerHTML = '';
      else if(slotState && slotState.status === 'error') {
        status.innerHTML = `โหลดข้อมูลช่วงเวลาไม่สำเร็จ: ${escapeZoneHtml(slotState.message || '')} <button onclick="retryCurrentSlotCube()" class="refreshbtn">ลองอีกครั้ง</button>`;
      } else status.textContent = '⏳ กำลังโหลดข้อมูลช่วงเวลาแบบรายวัน…';
    }
    const isPcs = unitMode === 'pcs';
    const chartValues = isPcs ? t.map(x=>x.pcs) : t.map(x=>x.qty);
    const chartLabel = isPcs ? 'จำนวนชิ้น' : 'หน่วยหยิบ';

    const exSlot = Chart.getChart('slot'); if(exSlot) exSlot.destroy();
    new Chart(document.getElementById('slot'), {
      type:'bar',
      data:{labels:t.map(x=>x.label), datasets:[{
        label:chartLabel, data:chartValues,
        backgroundColor:isPcs?'rgba(20,184,166,.9)':'rgba(99,102,241,.9)',
        borderRadius:6
      }]},
      options:{
        maintainAspectRatio:false, layout:{padding:{top:22}},
        plugins:{
          legend:{display:true, position:'top', labels:{usePointStyle:true, boxWidth:8}},
          datalabels:{anchor:'end', align:'end', formatter:fmt, color:'#0f766e', font:{size:9, weight:'600'}, rotation:-90, offset:2}
        },
        scales:{y:{grid:{color:'#eef2f7'}, ticks:{callback:fmt}}, x:{grid:{display:false}}}
      }
    });
  },
  items(){
    if(!hasCurrentItemCube()) setTimeout(() => void loadCurrentItemCube(false), 0);
    const isPcs = unitMode === 'pcs';
    let it = [...A.by_item];
    it.sort((a, b) => (b.qty - a.qty) || (b.pcs - a.pcs));
    it = it.slice(0, 10);

    const labels = it.map(x => {
      const nm = x.name || x.sku;
      return nm.length > 32 ? nm.slice(0, 30) + '…' : nm;
    });
    const chartValues = isPcs ? it.map(x=>x.pcs) : it.map(x=>x.qty);
    const chartLabel = isPcs ? 'จำนวนชิ้น' : 'หน่วยหยิบ';

    const exItem = Chart.getChart('item'); if(exItem) exItem.destroy();
    new Chart(document.getElementById('item'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: chartLabel,
          data: chartValues,
          backgroundColor: isPcs ? 'rgba(245,158,11,.9)' : 'rgba(99,102,241,.9)',
          borderRadius: 6
        }]
      },
      options: {
        indexAxis: 'y',
        maintainAspectRatio: false,
        layout: { padding: { right: 55 } },
        plugins: {
          legend: { display: true, position: 'top', labels: { usePointStyle: true, boxWidth: 8 } },
          datalabels: { anchor: 'end', align: 'end', formatter: fmt, color: '#b45309', font: { size: 10, weight: '600' } },
          tooltip: {
            callbacks: {
              title: (ctx) => {
                const item = it[ctx[0].dataIndex];
                return item ? (item.name || item.sku) : '';
              },
              label: (ctx) => {
                const item = it[ctx.dataIndex];
                if (!item) return '';
                return [
                  ` SKU: ${item.sku}`,
                  ` Owner: ${item.owner || '-'}`,
                  ` จำนวน: ${fmt(item.pcs)} ชิ้น (${fmt(item.qty)} หน่วยหยิบ)`
                ];
              }
            }
          }
        },
        scales: {
          x: { grid: { color: '#eef2f7' }, ticks: { callback: fmt } },
          y: { grid: { display: false } }
        }
      }
    });

    // ตารางค้นหาและตั้งค่ายกเว้นสินค้า
    const searchInput = document.getElementById('itemSearch');
    if (searchInput) {
      searchInput.value = itemSearchTerm;
      if (!searchInput._bound) {
        searchInput._bound = true;
        searchInput.addEventListener('input', (e) => {
          itemSearchTerm = e.target.value.toLowerCase().trim();
          renderItemTable();
        });
      }
    }

    function renderItemTable() {
      const elTable = document.getElementById('itable');
      if (!elTable) return;

      let allItems = [...(A.by_item_all || [])];
      allItems.sort((a, b) => (b.qty - a.qty) || (b.pcs - a.pcs));

      if (itemSearchTerm) {
        allItems = allItems.filter(x => 
          (x.sku && x.sku.toLowerCase().includes(itemSearchTerm)) ||
          (x.name && x.name.toLowerCase().includes(itemSearchTerm)) ||
          (x.owner && x.owner.toLowerCase().includes(itemSearchTerm)) ||
          (x.locationStr && x.locationStr.toLowerCase().includes(itemSearchTerm)) ||
          (x.zoneStr && x.zoneStr.toLowerCase().includes(itemSearchTerm))
        );
      }

      // แสดงรายการสินค้าทั้งหมดที่ตรงกับคำค้นหา (ไม่ตัดสั้นที่ 35 รายการ)
      const displayItems = allItems;

      const pcsHeaderStyle = isPcs ? 'background:#e0f2fe;color:#0369a1;font-weight:700;' : '';
      const qtyHeaderStyle = !isPcs ? 'background:#e0e7ff;color:#3730a3;font-weight:700;' : '';

      let h = `<thead><tr><th>#</th><th>รหัส SKU</th><th>ชื่อสินค้า</th><th>Owner</th><th>Location</th><th>Zone</th><th class="num" style="${pcsHeaderStyle}">จำนวนชิ้น (QTY เดิม) ${isPcs ? '★' : ''}</th><th class="num" style="${qtyHeaderStyle}">หน่วยหยิบ (BigQuery) ${!isPcs ? '★' : ''}</th><th style="text-align:center;">สถานะการคำนวณ</th></tr></thead><tbody>`;
      if (!displayItems.length) {
        const itemState = itemCubeLoadState.get(itemCubeRequestKey());
        if(!hasCurrentItemCube() && itemState && itemState.status === 'error'){
          h += `<tr><td colspan="9" style="text-align:center;color:#b91c1c;padding:24px">โหลดรายการสินค้าไม่สำเร็จ: ${escapeZoneHtml(itemState.message || '')} <button onclick="retryCurrentItemCube()" class="refreshbtn">ลองอีกครั้ง</button></td></tr>`;
        }else if(!hasCurrentItemCube()){
          h += '<tr><td colspan="9" style="text-align:center;color:#64748b;padding:24px">⏳ กำลังโหลดรายการสินค้าเฉพาะช่วงวันที่เลือก… หน้าอื่นยังใช้งานได้ตามปกติ</td></tr>';
        }else{
          h += '<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:24px">ไม่พบสินค้าที่ตรงกับคำค้นหา</td></tr>';
        }
      } else {
        displayItems.forEach((x, i) => {
          const isEx = isSkuExcluded(x.sku, x.owner);
          const rowBg = isEx ? 'style="background:#fff7ed;"' : '';
          const nameStyle = isEx ? 'style="text-decoration:line-through;color:#94a3b8;"' : '';
          const statusBadge = isEx
            ? '<span style="background:#fee2e2;color:#991b1b;padding:3px 9px;border-radius:6px;font-size:11.5px;font-weight:600;">🚫 ยกเว้นอยู่</span>'
            : (!x.inMaster
              ? '<span style="background:#fee2e2;color:#991b1b;padding:3px 9px;border-radius:6px;font-size:11.5px;font-weight:600;">⚠️ ไม่พบใน Master</span>'
              : (!x.hasActivity
                ? '<span style="background:#f1f5f9;color:#475569;padding:3px 9px;border-radius:6px;font-size:11.5px;font-weight:600;">○ ยังไม่มีการหยิบ</span>'
                : '<span style="background:#dcfce7;color:#166534;padding:3px 9px;border-radius:6px;font-size:11.5px;font-weight:600;">✅ แมป Master แล้ว</span>'));

          const btnAction = isEx
            ? `<button onclick="toggleExcludeSku(decodeURIComponent('${encodeURIComponent(x.owner)}'),decodeURIComponent('${encodeURIComponent(x.sku)}'))" style="border:0;background:#dcfce7;color:#15803d;padding:5px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;transition:.2s;">✅ นำกลับมาคำนวณ</button>`
            : `<button onclick="toggleExcludeSku(decodeURIComponent('${encodeURIComponent(x.owner)}'),decodeURIComponent('${encodeURIComponent(x.sku)}'))" style="border:0;background:#fee2e2;color:#b91c1c;padding:5px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;transition:.2s;">🚫 ยกเว้นคำนวณ</button>`;

          const pcsCellStyle = isPcs ? 'font-weight:700;color:#0284c7;background:#f0f9ff;' : 'font-weight:600;color:#0f766e;';
          const qtyCellStyle = !isPcs ? 'font-weight:700;color:#4338ca;background:#eef2ff;' : 'font-weight:600;color:#4338ca;';

          const locPill = x.locationStr && x.locationStr !== '-' 
            ? `<span class="pill" style="background:#f8fafc;color:#0f172a;border:1px solid #cbd5e1;font-family:monospace;font-weight:600;">${escapeZoneHtml(x.locationStr)}</span>`
            : '<span style="color:#94a3b8;">-</span>';
          const zonePill = x.zoneStr && x.zoneStr !== '-'
            ? `<span class="pill" style="background:#e0f2fe;color:#0369a1;font-weight:700;">${escapeZoneHtml(x.zoneStr)}</span>`
            : '<span style="color:#94a3b8;">-</span>';

          h += `<tr ${rowBg}>
            <td><span class="rank">${i + 1}</span></td>
            <td><b>${x.sku}</b></td>
            <td ${nameStyle}>${x.name || '-'}</td>
            <td><span class="pill">${x.owner || '-'}</span></td>
            <td>${locPill}</td>
            <td>${zonePill}</td>
            <td class="num" style="${isEx ? 'color:#94a3b8;' : pcsCellStyle}">${fmt(x.pcs)}</td>
            <td class="num" style="${isEx ? 'color:#94a3b8;' : qtyCellStyle}">${fmt(x.qty)}</td>
            <td style="text-align:center;display:flex;align-items:center;justify-content:center;gap:10px;">${statusBadge} ${btnAction}</td>
          </tr>`;
        });
      }
      h += '</tbody>';
      elTable.innerHTML = h;
    }

    renderItemTable();
  },

  report(){
    const el = document.getElementById('reportPage');
    if(!el) return;
    const isPcs = unitMode === 'pcs';
    const kpis = A.kpis;
    const daily = A.daily || [];
    const byPicker = A.by_picker || [];
    const byZone = A.by_zone_prod || A.by_zone || [];
    const bySlot = A.by_timeslot || [];

    // ── Smart insight computation ──────────────────────────────────────────
    const prodField = isPcs ? 'avg_pcs_prod' : 'avg_prod';
    const unitLabel = isPcs ? 'ชิ้น/ชม.' : 'หยิบ/ชม.';
    const volLabel  = isPcs ? 'ชิ้น' : 'หน่วยหยิบ';
    const volField  = isPcs ? 'pcs' : 'qty';

    const totalVol = isPcs ? kpis.pcs : kpis.qty;
    const avgProd  = isPcs ? kpis.avg_pcs_prod : kpis.avg_prod;

    // trend: compare first-half vs second-half
    let trendTxt = '', trendIcon = '📊', trendColor = '#64748b';
    if(daily.length >= 2){
      const mid = Math.floor(daily.length / 2);
      const firstH = daily.slice(0, mid).map(d => d[prodField]).filter(v=>v>0);
      const secondH = daily.slice(mid).map(d => d[prodField]).filter(v=>v>0);
      const fAvg = firstH.length ? firstH.reduce((a,b)=>a+b,0)/firstH.length : 0;
      const sAvg = secondH.length ? secondH.reduce((a,b)=>a+b,0)/secondH.length : 0;
      const delta = sAvg - fAvg;
      if(Math.abs(delta) < 1){ trendTxt='Productivity ทรงตัว ไม่เปลี่ยนแปลงมาก'; trendIcon='➡️'; trendColor='#64748b'; }
      else if(delta > 0){ trendTxt=`Productivity ดีขึ้น +${Math.round(delta*10)/10} ${unitLabel} เมื่อเทียบช่วงแรก`; trendIcon='📈'; trendColor='#10b981'; }
      else{ trendTxt=`Productivity ลดลง ${Math.round(delta*10)/10} ${unitLabel} เมื่อเทียบช่วงแรก`; trendIcon='📉'; trendColor='#ef4444'; }
    }

    // best / worst day
    const daysWithProd = daily.filter(d=>d[prodField]>0);
    const bestDay  = daysWithProd.sort((a,b)=>b[prodField]-a[prodField])[0];
    const worstDay = daysWithProd.sort((a,b)=>a[prodField]-b[prodField])[0];

    // top picker
    const activePickers = byPicker.filter(p=>(isPcs?p.avg_pcs_prod:p.avg_prod)>0);
    const topPicker = activePickers.sort((a,b)=>(isPcs?b.avg_pcs_prod-a.avg_pcs_prod:b.avg_prod-a.avg_prod))[0];
    const topVolPicker = byPicker.sort((a,b)=>b[volField]-a[volField])[0];

    // top zone
    const topZone = byZone.filter(z=>z.name&&z.name!=='-')[0];

    // peak time slot
    const peakSlot = bySlot.slice().sort((a,b)=>b[volField]-a[volField])[0];

    // target hit rate
    const hitDays = daily.filter(d=>d[prodField]>=prodTarget).length;
    const hitPct  = daily.length ? Math.round(hitDays/daily.length*100) : 0;

    // shift split from kpis (use daily with picker by shift if available)
    const shiftData = A.by_affiliation || [];

    // picker pass rate (>= target)
    const pickerPassCount = activePickers.filter(p=>(isPcs?p.avg_pcs_prod:p.avg_prod)>=prodTarget).length;
    const pickerPassPct   = activePickers.length ? Math.round(pickerPassCount/activePickers.length*100) : 0;

    // ── HTML template ─────────────────────────────────────────────────────
    el.innerHTML = `
<style>
.rpt-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px;}
.rpt-kcard{background:linear-gradient(135deg,var(--c1),var(--c2));border-radius:18px;padding:20px 18px;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,0.12);position:relative;overflow:hidden;}
.rpt-kcard::after{content:'';position:absolute;right:-18px;bottom:-18px;width:90px;height:90px;border-radius:50%;background:rgba(255,255,255,0.1);}
.rpt-kcard .icon{font-size:28px;margin-bottom:8px;}
.rpt-kcard .val{font-size:30px;font-weight:900;letter-spacing:-1px;line-height:1;}
.rpt-kcard .lbl{font-size:12px;opacity:.85;margin-top:5px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;}
.rpt-kcard .sub{font-size:11px;opacity:.7;margin-top:3px;}
.rpt-row2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;}
.rpt-row3{display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:24px;}
.rpt-card{background:#fff;border-radius:18px;padding:22px;box-shadow:0 2px 16px rgba(15,23,42,0.07);border:1px solid #f1f5f9;}
.rpt-card h4{margin:0 0 4px;font-size:15px;font-weight:700;color:#0f172a;}
.rpt-card .sub{font-size:12px;color:#94a3b8;margin:0 0 16px;}
.insight-box{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-radius:12px;margin-bottom:10px;}
.insight-box .icon{font-size:22px;flex-shrink:0;}
.insight-box .text{font-size:13.5px;line-height:1.55;color:#1e293b;}
.insight-box .text strong{color:#0f172a;}
.insight-box.good{background:linear-gradient(135deg,#ecfdf5,#d1fae5);border:1px solid #a7f3d0;}
.insight-box.warn{background:linear-gradient(135deg,#fff7ed,#ffedd5);border:1px solid #fed7aa;}
.insight-box.info{background:linear-gradient(135deg,#eff6ff,#dbeafe);border:1px solid #bfdbfe;}
.insight-box.neutral{background:linear-gradient(135deg,#f8fafc,#f1f5f9);border:1px solid #e2e8f0;}
.rpt-chartbox{height:220px;position:relative;}
.rpt-chartbox-tall{height:260px;position:relative;}
.rpt-bar-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;}
.rpt-bar-row .name{font-size:12.5px;color:#334155;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:80px;max-width:120px;}
.rpt-bar-wrap{flex:1;background:#f1f5f9;border-radius:6px;height:18px;overflow:hidden;}
.rpt-bar-fill{height:100%;border-radius:6px;transition:.5s;}
.rpt-bar-row .vval{font-size:12px;color:#64748b;font-weight:700;min-width:50px;text-align:right;}
.target-line{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-radius:10px;margin-bottom:8px;font-size:13px;font-weight:600;}
.rpt-section-title{font-size:17px;font-weight:800;color:#0f172a;margin:0 0 16px;display:flex;align-items:center;gap:8px;}
@media(max-width:900px){.rpt-grid{grid-template-columns:repeat(2,1fr);}.rpt-row2,.rpt-row3{grid-template-columns:1fr;}}
</style>

<!-- ── Section 1: KPI Overview ──────────────────────────────────────────── -->
<div style="margin-bottom:28px;">
  <div class="rpt-section-title">🎯 ภาพรวมผลการปฏิบัติงาน</div>
  <div class="rpt-grid">
    <div class="rpt-kcard" style="--c1:#6366f1;--c2:#4f46e5;">
      <div class="icon">📦</div>
      <div class="val">${fmt(totalVol)}</div>
      <div class="lbl">ปริมาณ${volLabel}รวม</div>
      <div class="sub">Lines: ${fmt(kpis.lines)}</div>
    </div>
    <div class="rpt-kcard" style="--c1:#0ea5e9;--c2:#0284c7;">
      <div class="icon">⚡</div>
      <div class="val">${avgProd}</div>
      <div class="lbl">Productivity เฉลี่ย</div>
      <div class="sub">${unitLabel}</div>
    </div>
    <div class="rpt-kcard" style="--c1:#10b981;--c2:#059669;">
      <div class="icon">👷</div>
      <div class="val">${kpis.pickers}</div>
      <div class="lbl">จำนวน Picker</div>
      <div class="sub">คนที่มีข้อมูลในช่วงนี้</div>
    </div>
    <div class="rpt-kcard" style="--c1:${hitPct>=70?'#f59e0b':'#ef4444'};--c2:${hitPct>=70?'#d97706':'#dc2626'};">
      <div class="icon">${hitPct>=70?'🏆':'⚠️'}</div>
      <div class="val">${hitPct}%</div>
      <div class="lbl">วันที่ถึงเป้า</div>
      <div class="sub">${hitDays} / ${daily.length} วัน (เป้า ${prodTarget} ${unitLabel})</div>
    </div>
  </div>
</div>

<!-- ── Section 2: Smart Insights ─────────────────────────────────────────── -->
<div style="margin-bottom:28px;">
  <div class="rpt-section-title">🧠 วิเคราะห์อัจฉริยะ · ภาษาคน</div>
  <div class="rpt-row2">
    <div>
      ${trendTxt ? `<div class="insight-box ${trendColor==='#10b981'?'good':trendColor==='#ef4444'?'warn':'neutral'}">
        <div class="icon">${trendIcon}</div>
        <div class="text">${trendTxt}</div>
      </div>` : ''}
      ${bestDay ? `<div class="insight-box good">
        <div class="icon">🌟</div>
        <div class="text"><strong>วันที่ดีที่สุด:</strong> ${bestDay.date} — Productivity ${bestDay[prodField]} ${unitLabel}<br>ปริมาณหยิบ ${fmt(bestDay[volField])} ${volLabel} / ${bestDay.pickers || '-'} คน</div>
      </div>` : ''}
      ${worstDay && worstDay.date !== (bestDay && bestDay.date) ? `<div class="insight-box warn">
        <div class="icon">!</div>
        <div class="text"><strong>วันที่ต่ำสุด:</strong> ${worstDay.date} — Productivity ${worstDay[prodField]} ${unitLabel}<br>ควรตรวจสอบสาเหตุ เช่น กำลังคน, งานหนัก, ชุดคำสั่งหยิบ</div>
      </div>` : ''}
      ${topPicker ? `<div class="insight-box info">
        <div class="icon">🏅</div>
        <div class="text"><strong>Picker ที่ดีที่สุด:</strong> ${escapeZoneHtml(topPicker.name||topPicker.picker)}<br>Productivity เฉลี่ย <strong>${isPcs?topPicker.avg_pcs_prod:topPicker.avg_prod} ${unitLabel}</strong></div>
      </div>` : ''}
    </div>
    <div>
      ${topZone ? `<div class="insight-box info">
        <div class="icon">🗺️</div>
        <div class="text"><strong>โซนที่ Productive สุด:</strong> ${escapeZoneHtml(topZone.name)}<br>Productivity ${isPcs?topZone.avg_pcs_prod:topZone.avg_prod} ${unitLabel} · ปริมาณ ${fmt(isPcs?topZone.pcs:topZone.qty)} ${volLabel}</div>
      </div>` : ''}
      ${peakSlot ? `<div class="insight-box good">
        <div class="icon">⏰</div>
        <div class="text"><strong>ช่วงเวลาที่หยิบเยอะสุด:</strong> ${peakSlot.label}<br>ปริมาณ ${fmt(isPcs?peakSlot.pcs:peakSlot.qty)} ${volLabel} — ควรวางแผนกำลังคนรองรับ</div>
      </div>` : ''}
      <div class="insight-box ${pickerPassPct>=70?'good':pickerPassPct>=40?'warn':'neutral'}">
        <div class="icon">${pickerPassPct>=70?'✅':pickerPassPct>=40?'🟡':'🔴'}</div>
        <div class="text"><strong>Picker ผ่านเป้าหมาย:</strong> ${pickerPassPct}% (${pickerPassCount} / ${activePickers.length} คน)<br>${pickerPassPct>=70?'ส่วนใหญ่ทำได้ดี ควรรักษาระดับนี้':pickerPassPct>=40?'ยังมี Picker ที่ต้องพัฒนาเพิ่ม':'กำลังคนส่วนใหญ่ยังต่ำกว่าเป้า ต้องวิเคราะห์เร่งด่วน'}</div>
      </div>
      ${topVolPicker && topVolPicker.picker !== (topPicker && topPicker.picker) ? `<div class="insight-box neutral">
        <div class="icon">📦</div>
        <div class="text"><strong>ปริมาณหยิบมากสุด:</strong> ${escapeZoneHtml(topVolPicker.name||topVolPicker.picker)}<br>${fmt(topVolPicker[volField])} ${volLabel} รวมทั้งช่วง</div>
      </div>` : ''}
    </div>
  </div>
</div>

<!-- ── Section 3: Daily Trend Chart ─────────────────────────────────────── -->
<div class="rpt-row3" style="margin-bottom:28px;">
  <div class="rpt-card">
    <h4>📈 แนวโน้ม Productivity รายวัน</h4>
    <p class="sub">เส้น = Productivity เฉลี่ย · แท่ง = ปริมาณ ${volLabel}</p>
    <div class="rpt-chartbox-tall"><canvas id="rptTrendChart"></canvas></div>
  </div>
  <div class="rpt-card">
    <h4>🕐 กิจกรรมรายชั่วโมง</h4>
    <p class="sub">ช่วงเวลาไหนหยิบเยอะ</p>
    <div class="rpt-chartbox-tall"><canvas id="rptSlotChart"></canvas></div>
  </div>
</div>

<!-- ── Section 4: Top Pickers + Zone Analysis ────────────────────────────── -->
<div class="rpt-row2" style="margin-bottom:28px;">
  <div class="rpt-card">
    <h4>👷 Top 8 Picker — Productivity</h4>
    <p class="sub">เรียงตาม Productivity (${unitLabel})</p>
    <div id="rptPickerBars"></div>
  </div>
  <div class="rpt-card">
    <h4>🗺️ Zone Breakdown</h4>
    <p class="sub">ปริมาณ${volLabel}ต่อโซน (Top 10)</p>
    <div class="rpt-chartbox"><canvas id="rptZoneChart"></canvas></div>
  </div>
</div>

<!-- ── Section 5: Target Achievement ─────────────────────────────────────── -->
<div class="rpt-card" style="margin-bottom:24px;">
  <h4>🎯 สรุปการบรรลุเป้าหมายรายวัน (เป้า: ${prodTarget} ${unitLabel})</h4>
  <p class="sub">แสดงแต่ละวันว่า Productivity ถึงเป้าหมายหรือไม่</p>
  <div id="rptTargetRows"></div>
</div>

<!-- ── Section 6: Item / SKU Analysis ─────────────────────────────────────── -->
<div style="margin-bottom:28px;">
  <div class="rpt-section-title">📦 วิเคราะห์รายสินค้า (SKU)</div>

  <!-- insight cards row -->
  <div id="rptItemInsights" style="margin-bottom:18px;"></div>

  <!-- chart + table row -->
  <div class="rpt-row3" style="margin-bottom:18px;">
    <div class="rpt-card">
      <h4>🏆 Top 10 สินค้าที่หยิบเยอะสุด</h4>
      <p class="sub">เรียงตามปริมาณ${volLabel} (แท่งสีเขียว = หยิบสูงสุด)</p>
      <div style="height:280px;position:relative;"><canvas id="rptItemChart"></canvas></div>
    </div>
    <div class="rpt-card">
      <h4>🥧 สัดส่วนปริมาณ Top 5</h4>
      <p class="sub">กระจุกตัวแค่ไหน</p>
      <div style="height:200px;position:relative;"><canvas id="rptItemPieChart"></canvas></div>
      <div id="rptItemConcentration" style="margin-top:12px;"></div>
    </div>
  </div>

  <!-- detail table -->
  <div class="rpt-card">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px;">
      <div>
        <h4 style="margin:0 0 2px;">📋 ตารางสินค้าทั้งหมด</h4>
        <p class="sub" style="margin:0;">เรียงจากปริมาณมากสุด · แสดง SKU, ชื่อ, Owner, ปริมาณ, Location</p>
      </div>
      <input id="rptItemSearch" type="text" placeholder="🔍 ค้นหา SKU / ชื่อ / Owner…"
        style="padding:8px 14px;border:1px solid #e2e8f0;border-radius:10px;font-size:13px;outline:none;font-family:inherit;min-width:220px;"
        oninput="window._rptItemFilter(this.value)" />
    </div>
    <div style="overflow-x:auto;">
      <table id="rptItemTable" style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="background:#f8fafc;">
          <th style="padding:10px 12px;text-align:left;font-weight:700;color:#475569;border-bottom:2px solid #e2e8f0;">ลำดับ</th>
          <th style="padding:10px 12px;text-align:left;font-weight:700;color:#475569;border-bottom:2px solid #e2e8f0;">SKU</th>
          <th style="padding:10px 12px;text-align:left;font-weight:700;color:#475569;border-bottom:2px solid #e2e8f0;">ชื่อสินค้า</th>
          <th style="padding:10px 12px;text-align:left;font-weight:700;color:#475569;border-bottom:2px solid #e2e8f0;">Owner</th>
          <th style="padding:10px 12px;text-align:right;font-weight:700;color:#475569;border-bottom:2px solid #e2e8f0;">ปริมาณ</th>
          <th style="padding:10px 12px;text-align:right;font-weight:700;color:#475569;border-bottom:2px solid #e2e8f0;">Lines</th>
          <th style="padding:10px 12px;text-align:left;font-weight:700;color:#475569;border-bottom:2px solid #e2e8f0;">Location</th>
          <th style="padding:10px 12px;text-align:left;font-weight:700;color:#475569;border-bottom:2px solid #e2e8f0;">Zone</th>
          <th style="padding:10px 12px;text-align:left;font-weight:700;color:#475569;border-bottom:2px solid #e2e8f0;">%รวม</th>
        </tr></thead>
        <tbody id="rptItemTbody"></tbody>
      </table>
    </div>
  </div>
</div>
`;

    // ── Render charts ──────────────────────────────────────────────────────
    // Trend chart
    const trendCanvas = document.getElementById('rptTrendChart');
    if(trendCanvas && daily.length > 0){
      const maxV = Math.max(1, ...daily.map(d=>isPcs?d.pcs:d.qty));
      new Chart(trendCanvas, {
        data:{
          labels: daily.map(d=>d.date.length>5?d.date.slice(5):d.date),
          datasets:[
            {type:'bar',label:`${volLabel}`,data:daily.map(d=>isPcs?d.pcs:d.qty),
              backgroundColor:daily.map(d=>d[prodField]>=prodTarget?'rgba(16,185,129,.75)':'rgba(99,102,241,.65)'),
              borderRadius:5,yAxisID:'y',
              datalabels:{display:ctx=>{const v=Number(ctx.dataset.data[ctx.dataIndex]||0);return v>0&&(v/maxV>=0.1||daily.length<=4);},anchor:'end',align:'start',offset:3,formatter:fmt,color:'#fff',backgroundColor:'rgba(15,23,42,.18)',borderRadius:4,padding:{top:2,right:5,bottom:2,left:5},font:{weight:'700',size:9}}},
            {type:'line',label:`Productivity (${unitLabel})`,data:daily.map(d=>d[prodField]),
              borderColor:'#f43f5e',backgroundColor:'rgba(244,63,94,.1)',tension:.35,
              pointRadius:4,pointBackgroundColor:'#f43f5e',fill:true,yAxisID:'y1',
              datalabels:{display:false}}
          ]
        },
        options:{maintainAspectRatio:false,layout:{padding:{top:22,right:10,bottom:0,left:10}},
          plugins:{legend:{display:true,position:'top',labels:{font:{weight:'600',size:11}}},datalabels:{}},
          scales:{y:{position:'left',grid:{color:'#f1f5f9'},ticks:{callback:fmt}},y1:{position:'right',grid:{drawOnChartArea:false},ticks:{callback:v=>v}}}}
      });
    }

    // Slot chart (polar/bar)
    const slotCanvas = document.getElementById('rptSlotChart');
    if(slotCanvas && bySlot.length > 0){
      const slotVols = bySlot.map(s=>isPcs?s.pcs:s.qty);
      const maxSlot = Math.max(1,...slotVols);
      new Chart(slotCanvas, {
        type:'bar',
        data:{
          labels:bySlot.map(s=>s.label),
          datasets:[{
            label:`${volLabel}`,data:slotVols,
            backgroundColor:slotVols.map(v=>`rgba(99,102,241,${0.35+0.55*(v/maxSlot)})`),
            borderRadius:6,datalabels:{display:false}
          }]
        },
        options:{maintainAspectRatio:false,plugins:{legend:{display:false},datalabels:{display:false}},
          scales:{x:{grid:{display:false},ticks:{font:{size:10}}},y:{grid:{color:'#f1f5f9'},ticks:{callback:fmt}}}}
      });
    }

    // Zone chart (horizontal doughnut-style via horizontal bar)
    const zoneCanvas = document.getElementById('rptZoneChart');
    const topZones = byZone.filter(z=>z.name&&z.name!=='-').slice(0,10);
    if(zoneCanvas && topZones.length > 0){
      const zVols = topZones.map(z=>isPcs?z.pcs:z.qty);
      const zColors = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#0ea5e9','#ec4899','#14b8a6','#f97316','#a855f7'];
      new Chart(zoneCanvas, {
        type:'doughnut',
        data:{labels:topZones.map(z=>z.name),datasets:[{data:zVols,backgroundColor:zColors,borderWidth:2,borderColor:'#fff'}]},
        options:{maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{font:{size:11},boxWidth:12}},datalabels:{display:false}}}
      });
    }

    // Top picker bars
    const pickerBarsEl = document.getElementById('rptPickerBars');
    if(pickerBarsEl){
      const sortedPickers = activePickers.slice().sort((a,b)=>(isPcs?b.avg_pcs_prod-a.avg_pcs_prod:b.avg_prod-a.avg_prod)).slice(0,8);
      const maxProd = sortedPickers.length ? Math.max(1,...sortedPickers.map(p=>isPcs?p.avg_pcs_prod:p.avg_prod)) : 1;
      let pbHtml = '';
      sortedPickers.forEach((p,i)=>{
        const pv = isPcs ? p.avg_pcs_prod : p.avg_prod;
        const pct = Math.round(pv/maxProd*100);
        const pass = pv >= prodTarget;
        const barCol = pass ? '#10b981' : i===0?'#6366f1':'#94a3b8';
        pbHtml += `<div class="rpt-bar-row">
          <div class="name" title="${escapeZoneHtml(p.name||p.picker)}">${pass?'✅ ':''}<b>${escapeZoneHtml((p.name||p.picker).length>14?(p.name||p.picker).slice(0,13)+'…':p.name||p.picker)}</b></div>
          <div class="rpt-bar-wrap"><div class="rpt-bar-fill" style="width:${pct}%;background:${barCol};"></div></div>
          <div class="vval">${pv} <span style="font-size:10px;color:#94a3b8">${unitLabel.split('/')[0]}</span></div>
        </div>`;
      });
      pickerBarsEl.innerHTML = pbHtml || '<div style="color:#94a3b8;font-size:13px;padding:10px;">ไม่พบข้อมูล Picker</div>';
    }

    // Target rows
    const targetRowsEl = document.getElementById('rptTargetRows');
    if(targetRowsEl && daily.length > 0){
      let trHtml = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;">';
      daily.forEach(d=>{
        const pv = d[prodField];
        const vv = d[volField];
        const pass = pv >= prodTarget;
        const pct = prodTarget > 0 ? Math.min(100,Math.round(pv/prodTarget*100)) : 0;
        trHtml += `<div style="border-radius:10px;padding:10px 14px;background:${pass?'#f0fdf4':'#fff7ed'};border:1px solid ${pass?'#a7f3d0':'#fed7aa'};">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
            <span style="font-weight:700;color:#0f172a;font-size:13px;">${d.date.length>5?d.date.slice(5):d.date}</span>
            <span style="font-size:11px;font-weight:700;color:${pass?'#059669':'#ea580c'}">${pass?'✅ ผ่าน':'⚠️ ยังไม่ผ่าน'}</span>
          </div>
          <div style="background:#e2e8f0;border-radius:4px;height:6px;overflow:hidden;margin-bottom:4px;">
            <div style="height:100%;width:${pct}%;background:${pass?'#10b981':'#f59e0b'};border-radius:4px;"></div>
          </div>
          <div style="font-size:12px;color:#475569;">${pv} ${unitLabel} · ${fmt(vv)} ${volLabel}</div>
        </div>`;
      });
      trHtml += '</div>';
      targetRowsEl.innerHTML = trHtml;
    }

    // ── Item / SKU analysis ────────────────────────────────────────────────
    const byItem = A.by_item || [];
    const topItems = byItem.slice(0, 10);
    const totalItemVol = byItem.reduce((s, x) => s + (isPcs ? x.pcs : x.qty), 0) || 1;
    const top5Vol = byItem.slice(0, 5).reduce((s, x) => s + (isPcs ? x.pcs : x.qty), 0);
    const top5Pct = Math.round(top5Vol / totalItemVol * 100);
    const top1 = byItem[0];
    const top1Vol = top1 ? (isPcs ? top1.pcs : top1.qty) : 0;
    const top1Pct = Math.round(top1Vol / totalItemVol * 100);
    const uniqueSKUs = byItem.length;
    const avgVolPerSKU = uniqueSKUs ? Math.round(totalItemVol / uniqueSKUs) : 0;

    // Item insights cards
    const itemInsightsEl = document.getElementById('rptItemInsights');
    if(itemInsightsEl){
      let iiHtml = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;">';
      if(top1){
        iiHtml += `<div class="insight-box good">
          <div class="icon">🥇</div>
          <div class="text"><strong>สินค้าหยิบเยอะสุด:</strong> ${escapeZoneHtml(top1.name||top1.sku)} (${escapeZoneHtml(top1.owner)})<br>ปริมาณ <strong>${fmt(top1Vol)} ${volLabel}</strong> · คิดเป็น <strong>${top1Pct}%</strong> ของทั้งหมด<br>Location: ${escapeZoneHtml(top1.locationStr||'-')} · Zone: ${escapeZoneHtml(top1.zoneStr||'-')}</div>
        </div>`;
      }
      iiHtml += `<div class="insight-box ${top5Pct>=80?'warn':'info'}">
        <div class="icon">${top5Pct>=80?'⚠️':'📊'}</div>
        <div class="text"><strong>ความกระจุกตัวของสินค้า:</strong> Top 5 SKU คิดเป็น <strong>${top5Pct}%</strong> ของปริมาณทั้งหมด<br>${top5Pct>=80?'สินค้าส่วนใหญ่กระจุกใน SKU น้อยมาก ควรบริหารความเสี่ยง':'การกระจายค่อนข้างดี'}</div>
      </div>`;
      iiHtml += `<div class="insight-box neutral">
        <div class="icon">🔢</div>
        <div class="text"><strong>SKU ที่มีกิจกรรม:</strong> <strong>${uniqueSKUs}</strong> รายการ<br>เฉลี่ย ${fmt(avgVolPerSKU)} ${volLabel} ต่อ SKU</div>
      </div>`;
      iiHtml += '</div>';
      itemInsightsEl.innerHTML = iiHtml;
    }

    // Top 10 items horizontal bar chart
    const itemChartCanvas = document.getElementById('rptItemChart');
    if(itemChartCanvas && topItems.length > 0){
      const itemVols = topItems.map(x => isPcs ? x.pcs : x.qty);
      const maxItemVol = Math.max(1, ...itemVols);
      const iColors = itemVols.map((v,i) => i===0?'#10b981':v/maxItemVol>=0.6?'#6366f1':'rgba(99,102,241,0.55)');
      const iLabels = topItems.map(x => {
        const n = (x.name || x.sku || '').length > 22 ? (x.name || x.sku).slice(0,21)+'…' : (x.name || x.sku);
        return n || x.sku;
      });
      new Chart(itemChartCanvas, {
        type:'bar',
        data:{
          labels: iLabels,
          datasets:[{
            label:volLabel, data:itemVols,
            backgroundColor:iColors, borderRadius:6,
            datalabels:{anchor:'end',align:'end',formatter:fmt,color:'#334155',font:{weight:'700',size:10}}
          }]
        },
        options:{
          indexAxis:'y', maintainAspectRatio:false,
          layout:{padding:{right:60}},
          plugins:{legend:{display:false},datalabels:{display:true}},
          scales:{x:{grid:{color:'#f1f5f9'},ticks:{callback:fmt}},y:{grid:{display:false},ticks:{font:{size:11}}}}
        }
      });
    }

    // Top 5 pie chart
    const itemPieCanvas = document.getElementById('rptItemPieChart');
    const top5Items = byItem.slice(0,5);
    const restVol = Math.max(0, totalItemVol - top5Vol);
    if(itemPieCanvas && top5Items.length > 0){
      const pieLabels = [...top5Items.map(x=>(x.name||x.sku||'').slice(0,18)), restVol>0?'อื่นๆ':''].filter(Boolean);
      const pieData  = [...top5Items.map(x=>isPcs?x.pcs:x.qty), restVol>0?restVol:null].filter(v=>v!==null);
      const pieColors = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#cbd5e1'];
      new Chart(itemPieCanvas, {
        type:'doughnut',
        data:{labels:pieLabels, datasets:[{data:pieData, backgroundColor:pieColors, borderWidth:2, borderColor:'#fff'}]},
        options:{maintainAspectRatio:false, plugins:{legend:{position:'bottom',labels:{font:{size:10},boxWidth:10}},datalabels:{display:false}}}
      });
      const conEl = document.getElementById('rptItemConcentration');
      if(conEl) conEl.innerHTML = `<div style="font-size:12.5px;color:#475569;text-align:center;padding:8px;background:#f8fafc;border-radius:8px;">Top 5 SKU รวมกัน <strong style="color:${top5Pct>=70?'#ef4444':'#10b981'}">${top5Pct}%</strong> ของปริมาณทั้งหมด</div>`;
    }

    // Item table with search
    const itemTbody = document.getElementById('rptItemTbody');
    window._rptAllItems = byItem;
    window._rptItemField = volField;
    window._rptItemTotalVol = totalItemVol;
    window._rptItemIsPcs = isPcs;
    window._rptItemVolLabel = volLabel;
    window._rptItemFilter = function(q){
      const term = (q||'').toLowerCase();
      const items = window._rptAllItems || [];
      const totalV = window._rptItemTotalVol || 1;
      const fld = window._rptItemField || 'qty';
      const filtered = term ? items.filter(x=>
        (x.sku||'').toLowerCase().includes(term)||
        (x.name||'').toLowerCase().includes(term)||
        (x.owner||'').toLowerCase().includes(term)||
        (x.locationStr||'').toLowerCase().includes(term)||
        (x.zoneStr||'').toLowerCase().includes(term)
      ) : items;
      const tBody = document.getElementById('rptItemTbody');
      if(!tBody) return;
      let cumPct = 0;
      tBody.innerHTML = filtered.slice(0,200).map((x,i)=>{
        const vol = x[fld] || 0;
        const pct = Math.round(vol/totalV*100);
        cumPct += pct;
        const rowBg = i % 2 === 0 ? '#fff' : '#f8fafc';
        const barW = Math.min(100, Math.round(vol/Math.max(1,filtered[0][fld]||1)*100));
        return `<tr style="background:${rowBg};border-bottom:1px solid #f1f5f9;">
          <td style="padding:9px 12px;color:#94a3b8;font-size:12px;">${i+1}</td>
          <td style="padding:9px 12px;"><code style="font-size:12px;font-weight:700;color:#6366f1;">${escapeZoneHtml(x.sku||'-')}</code></td>
          <td style="padding:9px 12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:#0f172a;" title="${escapeZoneHtml(x.name||'')}">${escapeZoneHtml((x.name||'-').length>28?(x.name||'-').slice(0,27)+'…':x.name||'-')}</td>
          <td style="padding:9px 12px;"><span style="background:#eff6ff;color:#1d4ed8;padding:2px 8px;border-radius:6px;font-size:11.5px;font-weight:600;">${escapeZoneHtml(x.owner||'-')}</span></td>
          <td style="padding:9px 12px;text-align:right;">
            <div style="display:flex;align-items:center;gap:6px;justify-content:flex-end;">
              <div style="width:50px;height:6px;background:#f1f5f9;border-radius:3px;overflow:hidden;"><div style="height:100%;width:${barW}%;background:#6366f1;border-radius:3px;"></div></div>
              <span style="font-weight:700;color:#334155;">${fmt(vol)}</span>
            </div>
          </td>
          <td style="padding:9px 12px;text-align:right;color:#64748b;">${fmt(x.lines||0)}</td>
          <td style="padding:9px 12px;font-size:12px;color:#334155;">${escapeZoneHtml(x.locationStr||'-')}</td>
          <td style="padding:9px 12px;"><span style="background:#f0fdf4;color:#15803d;padding:2px 8px;border-radius:6px;font-size:11.5px;font-weight:600;">${escapeZoneHtml(x.zoneStr||'-')}</span></td>
          <td style="padding:9px 12px;text-align:right;">
            <span style="font-size:12px;color:${pct>=10?'#ef4444':pct>=5?'#f59e0b':'#10b981'};font-weight:700;">${pct}%</span>
          </td>
        </tr>`;
      }).join('');
      if(filtered.length > 200) tBody.innerHTML += `<tr><td colspan="9" style="text-align:center;padding:12px;color:#94a3b8;font-size:12px;">แสดง 200 รายการแรกจาก ${filtered.length} รายการ — กรุณาใช้ช่องค้นหาเพื่อกรองข้อมูล</td></tr>`;
    };
    window._rptItemFilter('');
  },

  simulator(){
    const el = document.getElementById('simulatorPage');
    if(!el) return;
    // Workforce Planner ใช้หน่วยหยิบเท่านั้น ไม่สลับตามตัวเลือก Pcs/Units ของ Dashboard
    const volLabel = 'หน่วยหยิบ';
    const prodUnit = 'หน่วยหยิบ/ชม.';
    const roster = getPickerRosterPlanningSummary();
    const coreRoster = roster.countA + roster.countB;
    const defaultRatioA = coreRoster > 0 ? Math.round(roster.countA / coreRoster * 100) : 50;

    if(!window._simState || window._simState.version !== 42){
      window._simState = {
        version: 42,
        shiftARatio: defaultRatioA,
        shiftBRatio: 100 - defaultRatioA,
        customWorkload: null,
        customSourceName: '',
        productivitySystem: '',
        productivityOverrides: null,
        productivityDraft: null,
        userPickersA: {},
        userPickersB: {}
      };
    }
    const SState = window._simState;
    const planningDate = dto || DMAX || dfrom || '-';
    const PLANNER_ZONE_PROD_STORAGE_KEY = 'pick_dashboard_planner_zone_productivity_v1';

    function loadPlannerProductivityOverrides(){
      try{
        const raw = localStorage.getItem(PLANNER_ZONE_PROD_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        const bySystem = parsed && typeof parsed === 'object' ? (parsed[String(sys||'PTT').toUpperCase()] || {}) : {};
        const clean = {};
        Object.keys(bySystem || {}).forEach(z => {
          const v = Number(bySystem[z]);
          if(Number.isFinite(v) && v > 0) clean[String(z).trim()] = v;
        });
        return clean;
      }catch(_){ return {}; }
    }
    function savePlannerProductivityOverrides(overrides){
      try{
        const raw = localStorage.getItem(PLANNER_ZONE_PROD_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        const all = parsed && typeof parsed === 'object' ? parsed : {};
        const clean = {};
        Object.keys(overrides || {}).forEach(z => {
          const v = Number(overrides[z]);
          if(Number.isFinite(v) && v > 0) clean[String(z).trim()] = v;
        });
        all[String(sys||'PTT').toUpperCase()] = clean;
        all.updatedAt = new Date().toISOString();
        localStorage.setItem(PLANNER_ZONE_PROD_STORAGE_KEY, JSON.stringify(all));
      }catch(_){}
    }
    const plannerProductivitySystem = String(sys||'PTT').toUpperCase();
    if(SState.productivitySystem !== plannerProductivitySystem){
      SState.productivitySystem = plannerProductivitySystem;
      SState.productivityOverrides = loadPlannerProductivityOverrides();
      SState.productivityDraft = {...SState.productivityOverrides};
      SState.userPickersA = {}; SState.userPickersB = {};
    }else{
      if(!SState.productivityOverrides || typeof SState.productivityOverrides !== 'object') SState.productivityOverrides = loadPlannerProductivityOverrides();
      if(!SState.productivityDraft || typeof SState.productivityDraft !== 'object') SState.productivityDraft = {...SState.productivityOverrides};
    }

    // Productivity ใช้ข้อมูลย้อนหลังตามช่วงวันที่ที่เลือก
    // Workload ของ Workforce Planning จะมาจากไฟล์ ESTIMATED เท่านั้น (Column U / pu)
    const hist = aggregate(sys, dfrom, dto, 'all');
    const rateMap = {};
    (hist.by_zone_prod || []).forEach(z => {
      if(!z.name || z.name==='-' || z.name==='ไม่พบใน Zone_V2') return;
      // Productivity สำหรับ Planner = หน่วยหยิบ/ชม. เท่านั้น
      const rate = (z.avg_prod || z.mean_prod || 0);
      if(rate > 0) rateMap[z.name] = rate;
    });

    // ไม่มี Workload เริ่มต้นจาก BigQuery: ต้องนำเข้า ESTIMATED ก่อนจึงเริ่มวางแผน
    const activeWorkload = SState.customWorkload || {};
    const zones = Object.keys(activeWorkload).filter(z => Number(activeWorkload[z].vol) > 0).sort();
    const ratioA = Math.max(0, Math.min(1, Number(SState.shiftARatio || 0) / 100));
    const ratioB = 1 - ratioA;
    SState.shiftBRatio = 100 - Number(SState.shiftARatio || 0);

    const rows = zones.map(name => {
      const z = activeWorkload[name] || {};
      const vol = Number(z.vol)||0;
      const historicalRate = Number(rateMap[name])>0 ? Number(rateMap[name]) : (Number(z.prodRate)>0 ? Number(z.prodRate) : 100);
      const overrideRate = Number(SState.productivityOverrides && SState.productivityOverrides[name]);
      const rate = Number.isFinite(overrideRate) && overrideRate > 0 ? overrideRate : historicalRate;
      const volA = vol*ratioA, volB = vol-volA;
      return {name,vol,rate,historicalRate,hasOverride:Number.isFinite(overrideRate)&&overrideRate>0,lines:Number(z.lines)||0,volA,volB,
        phA:rate>0?volA/rate:0, phB:rate>0?volB/rate:0,
        rateFallback:!(Number(rateMap[name])>0 || Number(z.prodRate)>0)};
    });

    function allocate(rows,total,field){
      const out={}; rows.forEach(r=>out[r.name]=0);
      let people=Math.max(0,Math.floor(Number(total)||0));
      const active=rows.filter(r=>r[field]>0).map(r=>({name:r.name,w:r[field]})).sort((a,b)=>b.w-a.w||a.name.localeCompare(b.name));
      if(!people || !active.length) return out;
      if(people>=active.length){ active.forEach(r=>out[r.name]=1); people-=active.length; }
      else { for(let i=0;i<people;i++) out[active[i].name]=1; return out; }
      if(!people) return out;
      const sum=active.reduce((s,r)=>s+r.w,0); let used=0; const rem=[];
      active.forEach(r=>{ const q=people*r.w/sum, n=Math.floor(q); out[r.name]+=n; used+=n; rem.push({name:r.name,f:q-n,w:r.w}); });
      rem.sort((a,b)=>b.f-a.f||b.w-a.w);
      for(let i=0;i<people-used;i++) out[rem[i%rem.length].name]++;
      return out;
    }

    const recommendedA = allocate(rows, roster.countA, 'phA');
    const recommendedB = allocate(rows, roster.countB, 'phB');
    const fmt1=n=>Number.isFinite(Number(n))?(Math.round(Number(n)*10)/10).toLocaleString('en-US'):'-';
    const assigned=(map,z,def)=>Object.prototype.hasOwnProperty.call(map,z)?Math.max(0,Math.floor(Number(map[z])||0)):def;
    const hours=(vol,p,rate)=>vol<=0?0:(p>0&&rate>0?vol/(p*rate):Infinity);
    const plannerRegularHours = shift => shift === 'B' ? SHIFT_B_REGULAR_HOURS : SHIFT_A_REGULAR_HOURS;
    const badge=(h,hasWork,shift)=>{
      if(!hasWork) return '<span class="sim-badge neutral"><i></i>ไม่มีงาน</span>';
      if(!Number.isFinite(h)) return '<span class="sim-badge ot"><i></i>ไม่มีคน</span>';
      const regular = plannerRegularHours(shift);
      const extra = Math.max(0, h - regular);
      if(extra <= 0.001) return `<span class="sim-badge ok"><i></i>${fmt1(h)} ชม.</span>`;
      if(extra <= OT_MAX) return `<span class="sim-badge warn"><i></i>OT ${fmt1(extra)} ชม.</span>`;
      return `<span class="sim-badge ot"><i></i>เกิน OT สูงสุด ${fmt1(extra-OT_MAX)} ชม.</span>`;
    };

    el.innerHTML = `
<style>
.sim-page{--sim-blue:#2563eb;--sim-blue-dark:#1e3a8a;--sim-ink:#0f172a;--sim-muted:#64748b;--sim-line:#e2e8f0;--sim-soft:#f8fafc;--sim-a:#eef6ff;--sim-a-strong:#dbeafe;--sim-b:#f8f2ff;--sim-b-strong:#ede9fe}
.sim-hero{position:relative;overflow:hidden;border-radius:22px;background:linear-gradient(135deg,#0f172a 0%,#172554 54%,#1d4ed8 100%);color:#fff;box-shadow:0 18px 45px -28px rgba(15,23,42,.75);margin-bottom:16px}
.sim-hero:after{content:"";position:absolute;width:330px;height:330px;border-radius:50%;right:-120px;top:-170px;background:rgba(255,255,255,.08);pointer-events:none}.sim-hero:before{content:"";position:absolute;width:210px;height:210px;border-radius:50%;right:90px;bottom:-150px;background:rgba(147,197,253,.10);pointer-events:none}
.sim-hero-main{position:relative;z-index:1;padding:22px 24px 18px;display:flex;justify-content:space-between;gap:18px;align-items:flex-start;flex-wrap:wrap}.sim-hero-title{display:flex;gap:13px;align-items:flex-start}.sim-hero-icon{width:44px;height:44px;border-radius:13px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.16);display:flex;align-items:center;justify-content:center;flex:0 0 auto}.sim-hero-icon svg{width:24px;height:24px;fill:none;stroke:#fff;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.sim-title{font-size:20px;font-weight:800;line-height:1.25}.sim-title-sub{font-size:11.5px;color:#cbd5e1;margin-top:5px;line-height:1.55;max-width:680px}
.sim-actionbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.sim-btn{border:1px solid #d7e0ea;background:#fff;color:#334155;padding:8px 12px;border-radius:10px;font:700 11.5px Prompt,sans-serif;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px;transition:.18s;white-space:nowrap}.sim-btn:hover{border-color:#94a3b8;transform:translateY(-1px);box-shadow:0 7px 18px -12px rgba(15,23,42,.8)}.sim-btn svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.sim-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}.sim-btn.success{background:#047857;border-color:#047857;color:#fff}.sim-btn.soft{background:#fff}.sim-btn.dark{background:#0f172a;border-color:#0f172a;color:#fff}.sim-btn:disabled{cursor:not-allowed;opacity:.68;transform:none}.sim-hero .sim-btn.soft{background:rgba(255,255,255,.10);border-color:rgba(255,255,255,.2);color:#fff}.sim-hero .sim-btn.primary{background:#fff;border-color:#fff;color:#1e3a8a}.sim-hero .sim-btn.success{background:#10b981;border-color:#10b981}.planner-inline-spinner{width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:plannerSpin .7s linear infinite}.sim-status{font-size:10.5px;color:#dbeafe;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:6px 10px}.sim-status[data-state="success"]{background:rgba(16,185,129,.18);border-color:rgba(110,231,183,.35);color:#d1fae5}.sim-status[data-state="error"]{background:rgba(239,68,68,.16);border-color:rgba(254,202,202,.30);color:#fee2e2}
.sim-setup{position:relative;z-index:1;border-top:1px solid rgba(255,255,255,.10);background:rgba(15,23,42,.24);padding:14px 24px 17px;display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:10px}.sim-setup-card{min-width:0;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.06);border-radius:13px;padding:11px 13px}.sim-setup-label{font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:#93c5fd;font-weight:800}.sim-setup-value{font-size:12.5px;font-weight:800;color:#fff;margin-top:4px;line-height:1.4;overflow:hidden;text-overflow:ellipsis}.sim-setup-note{font-size:9.8px;color:#cbd5e1;margin-top:3px;line-height:1.4}.sim-setup-row{display:flex;gap:8px;align-items:center;margin-top:7px}.sim-range{width:100%;accent-color:#93c5fd}.sim-pending{font-size:10px;color:#fbbf24;margin-top:6px;display:none;font-weight:700}.sim-pending.show{display:block}.sim-setup-footer{grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;gap:10px;padding-top:2px}.sim-setup-footer-note{font-size:10px;color:#cbd5e1}.sim-confirm{border:1px solid rgba(255,255,255,.2);background:#fff;color:#172554;padding:8px 13px;border-radius:9px;font:800 11px Prompt,sans-serif;cursor:pointer;display:inline-flex;gap:7px;align-items:center}.sim-confirm svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.sim-kpis{display:grid;grid-template-columns:1.15fr repeat(4,1fr);gap:10px;margin-bottom:16px}.sim-kpi{position:relative;overflow:hidden;background:#fff;border:1px solid var(--sim-line);border-radius:16px;padding:14px 15px;box-shadow:0 6px 22px -20px rgba(15,23,42,.55)}.sim-kpi:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:#cbd5e1}.sim-kpi.workload:before{background:#2563eb}.sim-kpi.people:before{background:#4f46e5}.sim-kpi.shift-a:before{background:#0284c7}.sim-kpi.shift-b:before{background:#7c3aed}.sim-kpi.risk:before{background:var(--risk-color,#16a34a)}.sim-kpi .lbl{font-size:10px;font-weight:800;color:#64748b}.sim-kpi .val{font-size:22px;font-weight:900;margin-top:3px;color:#0f172a;line-height:1.1}.sim-kpi .subv{font-size:9.8px;color:#64748b;margin-top:5px;line-height:1.4}
.sim-panel{background:#fff;border:1px solid #e5eaf1;border-radius:18px;box-shadow:0 10px 34px -30px rgba(15,23,42,.65);margin-bottom:16px;overflow:hidden}.sim-panel-head{padding:16px 18px;border-bottom:1px solid #edf2f7;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;background:linear-gradient(180deg,#fff 0%,#fbfdff 100%)}.sim-panel-title-wrap{display:flex;gap:10px;align-items:flex-start}.sim-step{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:#eaf2ff;color:#1d4ed8;font-size:11px;font-weight:900;flex:0 0 auto}.sim-panel h4{margin:0;font-size:14.5px;font-weight:850;color:#0f172a}.sim-panel .sub{font-size:10.5px;color:#64748b;margin:3px 0 0;line-height:1.5}.sim-panel-actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.sim-counter{font-size:10.5px;font-weight:800;color:#475569;background:#f8fafc;border:1px solid #e2e8f0;padding:6px 9px;border-radius:8px}
.sim-prod-grid{display:grid;grid-template-columns:repeat(4,minmax(190px,1fr));gap:10px;padding:14px 16px 17px;background:#f8fafc}.sim-prod-card{background:#fff;border:1px solid #e2e8f0;border-radius:13px;padding:11px 12px;transition:.15s}.sim-prod-card:hover{border-color:#bfdbfe;box-shadow:0 7px 20px -18px rgba(37,99,235,.8)}.sim-prod-card.custom{border-color:#93c5fd;background:#f8fbff}.sim-prod-card.draft{border-color:#f59e0b;background:#fffbeb}.sim-prod-card.draft .sim-prod-state{background:#fef3c7;color:#b45309}.sim-prod-top{display:flex;justify-content:space-between;gap:8px;align-items:center}.sim-zone{font-size:12.5px;font-weight:900;color:#0f172a}.sim-prod-state{font-size:9px;font-weight:800;border-radius:999px;padding:3px 7px;background:#f1f5f9;color:#64748b;white-space:nowrap}.sim-prod-card.custom .sim-prod-state{background:#dbeafe;color:#1d4ed8}.sim-prod-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:9px}.sim-prod-cell{min-width:0}.sim-prod-label{font-size:9px;color:#94a3b8;font-weight:700}.sim-prod-actual-val{font-size:15px;font-weight:900;color:#475569;margin-top:2px}.sim-prod-input{width:100%;box-sizing:border-box;padding:6px 8px;border:1.5px solid #bfdbfe;border-radius:8px;font:800 14px Prompt,sans-serif;text-align:right;background:#eff6ff;color:#1e3a8a;margin-top:2px}.sim-prod-input:focus{outline:0;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.11)}.sim-prod-unit{font-size:8.8px;color:#94a3b8;margin-top:3px;text-align:right}
.sim-table-wrap{overflow:auto;max-height:610px}.sim-table{width:100%;border-collapse:separate;border-spacing:0;font-size:11.5px;min-width:1120px}.sim-table thead th{position:sticky;top:0;z-index:3;background:#f8fafc;padding:9px 10px;font-weight:800;color:#475569;border-bottom:1px solid #dfe7f0;white-space:nowrap}.sim-table td{padding:8px 10px;border-bottom:1px solid #edf2f7;background:#fff}.sim-table tbody tr:hover td{background:#fbfdff}.sim-table .col-zone{position:sticky;left:0;z-index:2;background:#fff;box-shadow:1px 0 0 #edf2f7}.sim-table thead .col-zone{z-index:4;background:#f8fafc}.sim-table .a-col{background:#f4f8ff}.sim-table .b-col{background:#faf7ff}.sim-table tbody tr:hover .a-col{background:#eef6ff}.sim-table tbody tr:hover .b-col{background:#f6f0ff}.sim-zone-work{font-weight:900;color:#0f172a}.sim-zone-sub{font-size:9px;color:#94a3b8;margin-top:2px}.sim-input-num{width:58px;padding:6px 7px;border:1.5px solid #cbd5e1;border-radius:8px;font:800 12px Prompt,sans-serif;text-align:center;background:#fff}.sim-input-num:focus{outline:0;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.1)}.sim-rec-hint{font-size:8.8px;color:#64748b;margin-top:2px;white-space:nowrap}.sim-finish{font-size:13px;font-weight:900;color:#0f172a;white-space:nowrap}.sim-badge{padding:4px 7px;border-radius:999px;font-size:9.5px;font-weight:800;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}.sim-badge i{width:5px;height:5px;border-radius:50%;background:currentColor}.sim-badge.ok{background:#ecfdf5;color:#047857}.sim-badge.warn{background:#fff7ed;color:#b45309}.sim-badge.ot{background:#fef2f2;color:#b91c1c}.sim-badge.neutral{background:#f1f5f9;color:#64748b}
.sim-advice{padding:14px 16px 16px}.sim-advice .insight-box{margin:0!important;border-radius:11px!important;font-size:10.5px!important}.sim-helpbar{padding:10px 16px;background:#f8fafc;border-top:1px solid #edf2f7;font-size:9.8px;color:#64748b;display:flex;gap:16px;flex-wrap:wrap}.sim-helpbar b{color:#334155}
@media(max-width:1180px){.sim-kpis{grid-template-columns:repeat(3,1fr)}.sim-prod-grid{grid-template-columns:repeat(3,minmax(180px,1fr))}.sim-setup{grid-template-columns:1fr 1fr}.sim-setup-card:first-child{grid-column:1/-1}}
@media(max-width:760px){.sim-hero-main{padding:18px}.sim-setup{padding:12px 18px 15px;grid-template-columns:1fr}.sim-setup-card:first-child{grid-column:auto}.sim-setup-footer{grid-column:1;align-items:flex-start;flex-direction:column}.sim-kpis{grid-template-columns:1fr 1fr}.sim-prod-grid{grid-template-columns:1fr 1fr}.sim-panel-head{align-items:flex-start}.sim-actionbar{width:100%}.sim-actionbar .sim-btn{flex:1}.sim-title{font-size:18px}}
@media(max-width:520px){.sim-kpis,.sim-prod-grid{grid-template-columns:1fr}.sim-hero-title{gap:9px}.sim-hero-icon{width:38px;height:38px}.sim-panel-head{padding:14px}.sim-prod-grid{padding:12px}.sim-btn{font-size:10.5px}}
</style>
<div class="sim-page">
  <div class="sim-hero">
    <div class="sim-hero-main">
      <div class="sim-hero-title">
        <div class="sim-hero-icon"><svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/><path d="m4 8 6-5 6 8 6-5"/></svg></div>
        <div><div class="sim-title">Workforce Planning</div><div class="sim-title-sub">วางแผนจำนวน Picker จาก Workload และ Productivity ของแต่ละ Zone เพื่อเห็นเวลาจบและความเสี่ยง OT ได้ทันที</div></div>
      </div>
      <div class="sim-actionbar">
        <span class="sim-status" id="simActionStatus">พร้อมใช้งาน</span>
        <button id="btnSimRefreshRoster" class="sim-btn primary" onclick="window._simRefreshRoster()"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0 2 5"/><path d="M20 4v7h-7"/></svg><span>อัปเดตรายชื่อ</span></button>
        <button id="btnSimResetWorkload" class="sim-btn soft" onclick="window._simResetWorkload()" ${SState.customWorkload ? '' : 'disabled'}><svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 10v6M14 10v6"/></svg><span>ล้าง Workload</span></button>
        <button id="btnSimUploadOrder" class="sim-btn success" onclick="document.getElementById('simFileInput').click()"><svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14a2 2 0 0 0 2-2v-4M3 15v4a2 2 0 0 0 2 2"/></svg><span>นำเข้า ESTIMATED</span></button>
        <input type="file" id="simFileInput" accept=".csv,.xlsx,.xls" style="display:none" onchange="window._simHandleOrderFile(event)">
      </div>
    </div>
    <div class="sim-setup">
      <div class="sim-setup-card"><div class="sim-setup-label">ข้อมูล Workload</div><div class="sim-setup-value" id="simWorkloadSourceTxt">${SState.customWorkload ? 'ไฟล์ ' + escapeZoneHtml(SState.customSourceName || 'ที่อัปโหลด') : 'รออัปโหลดไฟล์ ESTIMATED'}</div><div class="sim-setup-note">${SState.customWorkload ? 'ใช้ Column U (pu) · หน่วยหยิบเท่านั้น' : 'ยังไม่คำนวณแผนจนกว่าจะนำเข้า Column U (pu)'}</div></div>
      <div class="sim-setup-card"><div class="sim-setup-label">สัดส่วนงาน A / B</div><div class="sim-setup-value" id="simShiftRatioTxt">A ${SState.shiftARatio}% : B ${SState.shiftBRatio}%</div><div class="sim-setup-row"><input id="simShiftRatioInput" class="sim-range" type="range" min="0" max="100" value="${SState.shiftARatio}" oninput="window._simDraftShiftRatio(this.value)"><button class="sim-btn soft" type="button" onclick="window._simDraftRosterRatio()">ตามจำนวนคน</button></div><div class="sim-pending" id="simRatioPending">มีค่าที่ยังไม่ได้ยืนยัน</div></div>
      <div class="sim-setup-card"><div class="sim-setup-label">เวลาทำงานก่อน OT</div><div class="sim-setup-value">กะ A 7.5 ชม. · กะ B 7 ชม. 50 นาที</div><div class="sim-setup-note">OT สูงสุด 2.5 ชม. · Flex ${roster.countFlex} คน · Productivity ย้อนหลัง ${escapeZoneHtml(dfrom)} ถึง ${escapeZoneHtml(dto)}</div></div>
      <div class="sim-setup-footer"><div class="sim-setup-footer-note">ปรับสัดส่วน A/B แล้วกด “ยืนยันสัดส่วน” ก่อนคำนวณแผนใหม่</div><button id="btnSimConfirmSettings" class="sim-confirm" type="button" onclick="window._simConfirmSettings()"><svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg><span>ยืนยันสัดส่วน</span></button></div>
    </div>
  </div>

  <div id="simKpiSummary"></div>

  <div class="sim-panel">
    <div class="sim-panel-head">
      <div class="sim-panel-title-wrap"><span class="sim-step">1</span><div><h4>กำหนด Productivity ที่ใช้วางแผน</h4><p class="sub">แก้เฉพาะ Zone ที่ต้องการได้ ค่า “จริงย้อนหลัง” ยังแสดงไว้ให้เทียบ และค่าที่แก้จะยังไม่ถูกใช้จนกดยืนยัน</p><div class="sim-pending" id="simProdPending">มี Productivity ที่แก้ไขแต่ยังไม่ได้ยืนยัน</div></div></div>
      <div class="sim-panel-actions"><button id="btnSimResetProd" class="sim-btn soft" type="button" onclick="window._simResetProductivityDraft()"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/></svg><span>ใช้ค่าจริงทุก Zone</span></button><button id="btnSimConfirmProd" class="sim-btn primary" type="button" onclick="window._simConfirmProductivity()"><svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg><span>ยืนยัน Productivity</span></button></div>
    </div>
    <div id="simProdGrid" class="sim-prod-grid"></div>
  </div>

  <div class="sim-panel">
    <div class="sim-panel-head">
      <div class="sim-panel-title-wrap"><span class="sim-step">2</span><div><h4>จัดคนและดูเวลาจบราย Zone</h4><p class="sub">ใส่จำนวนคนได้โดยตรง ระบบคำนวณเวลาจบใหม่ทันทีจาก Workload ÷ (Productivity × จำนวนคน)</p><div class="sim-pending" id="simManualPending">มีการปรับจำนวนคนที่ยังไม่ได้ยืนยัน</div></div></div>
      <div class="sim-panel-actions"><div id="simAssignedCounter" class="sim-counter"></div><button id="btnSimUseRecommended" class="sim-btn soft" onclick="window._simFillRecommendedHeadcount()"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>ใช้จำนวนคนแนะนำ</span></button><button id="btnSimConfirmManual" class="sim-btn primary" type="button" onclick="window._simConfirmManualPlan()"><svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg><span>ยืนยันแผน</span></button></div>
    </div>
    <div class="sim-table-wrap"><table class="sim-table"><thead><tr><th class="col-zone">Zone</th><th style="text-align:right">Workload</th><th style="text-align:right">Productivity</th><th class="a-col" style="text-align:right">A งาน</th><th class="a-col" style="text-align:center">A คน</th><th class="a-col" style="text-align:center">A เวลาจบ</th><th class="b-col" style="text-align:right">B งาน</th><th class="b-col" style="text-align:center">B คน</th><th class="b-col" style="text-align:center">B เวลาจบ</th></tr></thead><tbody id="simWorkforceTbody"></tbody></table></div>
    <div class="sim-helpbar"><span><b>สีเขียว</b> จบในเวลาปกติ</span><span><b>สีส้ม</b> ต้องใช้ OT</span><span><b>สีแดง</b> เกิน OT สูงสุด</span><span>จำนวนคนในช่องสามารถแก้ได้ทันที</span></div>
  </div>

  <div class="sim-panel" style="margin-bottom:0">
    <div class="sim-panel-head"><div class="sim-panel-title-wrap"><span class="sim-step">3</span><div><h4>ข้อเสนอแนะและ Zone ที่ต้องเฝ้าระวัง</h4><p class="sub">ระบบดู Capacity ของทั้งกะและแนะนำการโยกคนจาก Zone ที่เบากว่าไปช่วย Zone ที่เสี่ยง OT</p></div></div></div>
    <div id="simAdviceBox" class="sim-advice"></div>
  </div>
</div>`;

    function calculateSim(){
      let totalWork=0, phA=0, phB=0, assignedA=0, assignedB=0, otPersonHours=0;
      const risk=new Set(), infoA=[], infoB=[]; let prodHtml='', workforceHtml='';
      rows.forEach(r=>{
        totalWork+=r.vol; phA+=r.phA; phB+=r.phB;
        const recA=recommendedA[r.name]||0, recB=recommendedB[r.name]||0;
        const recHA=hours(r.volA,recA,r.rate), recHB=hours(r.volB,recB,r.rate);
        const userA=assigned(SState.userPickersA,r.name,recA), userB=assigned(SState.userPickersB,r.name,recB);
        assignedA+=userA; assignedB+=userB;
        const hA=hours(r.volA,userA,r.rate), hB=hours(r.volB,userB,r.rate);
        const regularA=SHIFT_A_REGULAR_HOURS, regularB=SHIFT_B_REGULAR_HOURS;
        const otA=Number.isFinite(hA)?Math.max(0,hA-regularA):0, otB=Number.isFinite(hB)?Math.max(0,hB-regularB):0;
        otPersonHours+=otA*userA+otB*userB;
        if(r.volA>0&&(!Number.isFinite(hA)||hA>regularA)) risk.add(r.name);
        if(r.volB>0&&(!Number.isFinite(hB)||hB>regularB)) risk.add(r.name);
        infoA.push({zone:r.name,h:hA,user:userA,req:r.volA>0?Math.ceil(r.phA/regularA):0});
        infoB.push({zone:r.name,h:hB,user:userB,req:r.volB>0?Math.ceil(r.phB/regularB):0});
        const draftRateRaw = Object.prototype.hasOwnProperty.call(SState.productivityDraft||{}, r.name) ? Number(SState.productivityDraft[r.name]) : (r.hasOverride ? r.rate : r.historicalRate);
        const draftRate = Number.isFinite(draftRateRaw) && draftRateRaw > 0 ? draftRateRaw : r.historicalRate;
        prodHtml+=`<div class="sim-prod-card ${r.hasOverride?'custom':''}" data-zone="${escapeZoneHtml(r.name)}"><div class="sim-prod-top"><div class="sim-zone">${escapeZoneHtml(r.name)}</div><span class="sim-prod-state">${r.hasOverride?'กำหนดเอง':'ใช้ค่าจริง'}</span></div><div class="sim-prod-meta"><div class="sim-prod-cell"><div class="sim-prod-label">จริงย้อนหลัง</div><div class="sim-prod-actual-val">${fmt1(r.historicalRate)}</div><div class="sim-prod-unit" style="text-align:left">หน่วยหยิบ/ชม.</div></div><div class="sim-prod-cell"><div class="sim-prod-label" style="text-align:right">ใช้วางแผน</div><input class="sim-prod-input" data-zone="${escapeZoneHtml(r.name)}" type="number" min="1" step="1" value="${Math.round(draftRate*10)/10}" oninput="window._simDraftZoneProductivity('${escapeZoneHtml(r.name)}',this.value)"><div class="sim-prod-unit">หน่วยหยิบ/ชม.</div></div></div>${r.rateFallback?'<div style="margin-top:7px;font-size:9px;color:#b45309">ไม่มีประวัติ ใช้ค่าเริ่มต้น 100</div>':''}</div>`;
        workforceHtml+=`<tr><td class="col-zone"><div class="sim-zone-work">${escapeZoneHtml(r.name)}</div><div class="sim-zone-sub">${r.hasOverride?'Productivity กำหนดเอง':'Productivity จริงย้อนหลัง'}</div></td><td style="text-align:right;font-weight:850">${fmt(Math.round(r.vol))}</td><td style="text-align:right"><b>${fmt1(r.rate)}</b><div class="sim-zone-sub">หน่วย/ชม.</div></td><td class="a-col" style="text-align:right;font-weight:700">${fmt(Math.round(r.volA))}</td><td class="a-col" style="text-align:center"><input type="number" min="0" max="99" value="${userA}" class="sim-input-num" onchange="window._simSetUserPicker('${escapeZoneHtml(r.name)}','A',this.value)"><div class="sim-rec-hint">แนะนำ ${recA} คน</div></td><td class="a-col" style="text-align:center"><div class="sim-finish">${Number.isFinite(hA)?fmt1(hA)+' ชม.':'-'}</div><div style="margin-top:3px">${badge(hA,r.volA>0,'A')}</div></td><td class="b-col" style="text-align:right;font-weight:700">${fmt(Math.round(r.volB))}</td><td class="b-col" style="text-align:center"><input type="number" min="0" max="99" value="${userB}" class="sim-input-num" onchange="window._simSetUserPicker('${escapeZoneHtml(r.name)}','B',this.value)"><div class="sim-rec-hint">แนะนำ ${recB} คน</div></td><td class="b-col" style="text-align:center"><div class="sim-finish">${Number.isFinite(hB)?fmt1(hB)+' ชม.':'-'}</div><div style="margin-top:3px">${badge(hB,r.volB>0,'B')}</div></td></tr>`;
      });
      if(!rows.length){ prodHtml='<div style="grid-column:1/-1;text-align:center;padding:28px 18px;color:#64748b"><div style="font-weight:800;color:#334155;margin-bottom:5px">รอข้อมูล Workload</div><div>นำเข้าไฟล์ ESTIMATED ก่อน ระบบจะแสดงเฉพาะ Zone ที่มีงานเพื่อให้ตั้งค่า Productivity</div></div>'; workforceHtml='<tr><td colspan="9" style="text-align:center;padding:38px 20px;color:#64748b"><div style="font-weight:850;color:#334155;font-size:13px;margin-bottom:5px">ยังไม่มี Workload สำหรับวางแผน</div><div>กด “นำเข้า ESTIMATED” แล้วระบบจะอ่านจำนวนหน่วยหยิบจาก Column U (pu)</div></td></tr>'; }
      const prodBody=document.getElementById('simProdGrid'); if(prodBody) prodBody.innerHTML=prodHtml;
      const workBody=document.getElementById('simWorkforceTbody'); if(workBody) workBody.innerHTML=workforceHtml;
      const avgA=roster.countA>0?phA/roster.countA:Infinity, avgB=roster.countB>0?phB/roster.countB:Infinity;
      document.getElementById('simKpiSummary').innerHTML=`<div class="sim-kpis"><div class="sim-kpi workload"><div class="lbl">WORKLOAD วันนี้</div><div class="val">${fmt(Math.round(totalWork))}</div><div class="subv">หน่วยหยิบ · ${rows.length} Zone</div></div><div class="sim-kpi people"><div class="lbl">PICKER พร้อมใช้งาน</div><div class="val">${roster.total} คน</div><div class="subv">A ${roster.countA} · B ${roster.countB} · Flex ${roster.countFlex}</div></div><div class="sim-kpi shift-a"><div class="lbl">กะ A</div><div class="val">${assignedA}/${roster.countA} คน</div><div class="subv">กระจายสมดุล ~${Number.isFinite(avgA)?fmt1(avgA):'-'} ชม. · ปกติ 7.5 ชม.</div></div><div class="sim-kpi shift-b"><div class="lbl">กะ B</div><div class="val">${assignedB}/${roster.countB} คน</div><div class="subv">กระจายสมดุล ~${Number.isFinite(avgB)?fmt1(avgB):'-'} ชม. · ปกติ 7.83 ชม.</div></div><div class="sim-kpi risk" style="--risk-color:${risk.size?'#dc2626':'#16a34a'}"><div class="lbl">ZONE เสี่ยง OT</div><div class="val" style="color:${risk.size?'#b91c1c':'#15803d'}">${risk.size}</div><div class="subv">OT รวม ${fmt1(otPersonHours)} คน-ชม.</div></div></div>`;
      const c=document.getElementById('simAssignedCounter'); if(c) c.innerHTML=`A ${assignedA}/${roster.countA} คน · B ${assignedB}/${roster.countB} คน${assignedA>roster.countA||assignedB>roster.countB?' <span style="color:#dc2626">· จัดเกินคนจริง</span>':''}`;
      const advice=[];
      if(!rows.length){
        advice.push('<div class="insight-box neutral"><div class="icon">i</div><div class="text"><strong>รอไฟล์ ESTIMATED:</strong> ระบบจะเริ่มวิเคราะห์ Capacity, เวลาจบ และ OT หลังจากมี Workload จาก Column U (pu)</div></div>');
      }
      if(rows.length) [[infoA,'กะ A',avgA,roster.countA,SHIFT_A_REGULAR_HOURS],[infoB,'กะ B',avgB,roster.countB,SHIFT_B_REGULAR_HOURS]].forEach(([arr,label,avg,count,regularHours])=>{
        if(!count){ advice.push(`<div class="insight-box warn"><div class="icon">!</div><div class="text"><strong>${label}:</strong> ไม่มี Picker ใน roster</div></div>`); return; }
        if(avg<=regularHours) advice.push(`<div class="insight-box good"><div class="icon">✓</div><div class="text"><strong>${label} Capacity โดยรวมเพียงพอ:</strong> ถ้ากระจายคนสมดุล คาดว่างานจะจบประมาณ ${fmt1(avg)} ชม. อยู่ในเวลาปกติ ${fmt1(regularHours)} ชม.</div></div>`); else advice.push(`<div class="insight-box warn"><div class="icon">!</div><div class="text"><strong>${label} Capacity ไม่พอสำหรับ 0 OT:</strong> แม้กระจายคนสมดุล งานยังใช้เวลาประมาณ ${fmt1(avg)} ชม. สูงกว่าเวลาปกติ ${fmt1(regularHours)} ชม. ควรโยกคนจาก Zone ที่จบก่อนมาช่วย Zone คอขวด</div></div>`);
        const sp=arr.filter(x=>x.user>x.req).sort((a,b)=>(b.user-b.req)-(a.user-a.req)); const need=arr.filter(x=>x.req>x.user).sort((a,b)=>(b.req-b.user)-(a.req-a.user));
        let si=0,ni=0,moves=0; while(si<sp.length&&ni<need.length&&moves<4){ const n=Math.min(sp[si].user-sp[si].req,need[ni].req-need[ni].user); if(n>0){ advice.push(`<div class="insight-box info"><div class="icon">↔</div><div class="text"><strong>${label}:</strong> ลองโยก ${n} คน จาก Zone ${escapeZoneHtml(sp[si].zone)} → ${escapeZoneHtml(need[ni].zone)}</div></div>`); sp[si].user-=n; need[ni].user+=n; moves++; } if(sp[si].user<=sp[si].req)si++; if(need[ni].user>=need[ni].req)ni++; }
      });
      document.getElementById('simAdviceBox').innerHTML='<div style="display:flex;flex-direction:column;gap:8px">'+(advice.join('')||'<div class="insight-box neutral"><div class="icon">i</div><div class="text">ยังไม่มีข้อมูลเพียงพอ</div></div>')+'</div>';
    }

    window._simRefreshRoster=function(){ return refreshPlannerRoster(true,{silent:false}); };
    window._simDraftShiftRatio=function(v){
      v=Math.max(0,Math.min(100,Number(v)||0));
      const txt=document.getElementById('simShiftRatioTxt'); if(txt) txt.textContent=`A ${v}% : B ${100-v}%`;
      const note=document.getElementById('simRatioPending'); if(note) note.classList.toggle('show',Math.round(v)!==Math.round(Number(SState.shiftARatio)||0));
    };
    window._simDraftRosterRatio=function(){
      const input=document.getElementById('simShiftRatioInput'); if(input){ input.value=defaultRatioA; window._simDraftShiftRatio(defaultRatioA); }
    };
    window._simConfirmSettings=function(){
      const btn=document.getElementById('btnSimConfirmSettings');
      const ratioInput=document.getElementById('simShiftRatioInput');
      const nextRatio=Math.max(0,Math.min(100,Number(ratioInput&&ratioInput.value)||0));
      plannerSetButtonBusy(btn,true,'กำลังยืนยัน...');
      showPlannerActionPopup('loading','กำลังยืนยันการตั้งค่า','ระบบกำลังนำสัดส่วนงาน A/B ไปคำนวณแผนใหม่');
      setTimeout(()=>{
        SState.shiftARatio=nextRatio; SState.shiftBRatio=100-nextRatio;
        SState.userPickersA={}; SState.userPickersB={};
        calculateSim();
        const rn=document.getElementById('simRatioPending'); if(rn) rn.classList.remove('show');
        plannerSetButtonBusy(btn,false);
        showPlannerActionPopup('success','ยืนยันการตั้งค่าเรียบร้อย',`สัดส่วนงาน A ${nextRatio}% : B ${100-nextRatio}%\nเวลาปกติ A 7.5 ชม. · B 7 ชม. 50 นาที`);
      },180);
    };
    window._simDraftZoneProductivity=function(zone,value){
      const v=Number(value);
      if(!SState.productivityDraft || typeof SState.productivityDraft!=='object') SState.productivityDraft={...SState.productivityOverrides};
      if(Number.isFinite(v)&&v>0) SState.productivityDraft[zone]=v; else delete SState.productivityDraft[zone];
      const note=document.getElementById('simProdPending'); if(note) note.classList.add('show');
      const input=[...document.querySelectorAll('#simProdGrid .sim-prod-input')].find(x=>String(x.dataset.zone||'')===String(zone));
      const card=input&&input.closest('.sim-prod-card'); if(card){ card.classList.add('draft'); const st=card.querySelector('.sim-prod-state'); if(st) st.textContent='รอยืนยัน'; }
    };
    window._simResetProductivityDraft=function(){
      SState.productivityDraft={};
      const inputs=document.querySelectorAll('#simProdGrid .sim-prod-input');
      inputs.forEach(input=>{ const zone=String(input.dataset.zone||'').trim(); const row=rows.find(r=>r.name===zone); if(row) input.value=Math.round(row.historicalRate*10)/10; const card=input.closest('.sim-prod-card'); if(card){card.classList.add('draft'); const st=card.querySelector('.sim-prod-state'); if(st) st.textContent='รอยืนยัน';} });
      const note=document.getElementById('simProdPending'); if(note) note.classList.add('show');
      showPlannerActionPopup('loading','เตรียมกลับไปใช้ Productivity จริง','กรุณากด “ยืนยัน Productivity” เพื่อใช้งานค่าจริงทุก Zone',{autoClose:true});
    };
    window._simConfirmProductivity=function(){
      const btn=document.getElementById('btnSimConfirmProd');
      plannerSetButtonBusy(btn,true,'กำลังยืนยัน...');
      showPlannerActionPopup('loading','กำลังยืนยัน Productivity','ระบบกำลังคำนวณแผนใหม่ด้วยค่า Productivity ที่กำหนด');
      setTimeout(()=>{
        const next={};
        rows.forEach(r=>{
          const raw=Number(SState.productivityDraft && SState.productivityDraft[r.name]);
          if(Number.isFinite(raw)&&raw>0 && Math.abs(raw-r.historicalRate)>0.0001) next[r.name]=raw;
        });
        SState.productivityOverrides=next;
        SState.productivityDraft={...next};
        savePlannerProductivityOverrides(next);
        SState.userPickersA={}; SState.userPickersB={};
        plannerSetButtonBusy(btn,false);
        const note=document.getElementById('simProdPending'); if(note) note.classList.remove('show');
        built.simulator=false; show('simulator');
        setTimeout(()=>showPlannerActionPopup('success','ยืนยัน Productivity เรียบร้อย',`${Object.keys(next).length} Zone ใช้ค่ากำหนดเอง · Zone อื่นใช้ Productivity จริงย้อนหลัง`),80);
      },180);
    };
    window._simSetUserPicker=function(z,s,v){ const n=Math.max(0,Math.floor(Number(v)||0)); if(s==='A')SState.userPickersA[z]=n; else SState.userPickersB[z]=n; calculateSim(); const note=document.getElementById('simManualPending'); if(note) note.classList.add('show'); };
    window._simConfirmManualPlan=function(){ const note=document.getElementById('simManualPending'); if(note) note.classList.remove('show'); const summary=(document.getElementById('simAssignedCounter')||{}).textContent||'แผนกำลังคนถูกยืนยันแล้ว'; showPlannerActionPopup('success','ยืนยันแผนกำลังคนเรียบร้อย',summary.trim()); };
    window._simFillRecommendedHeadcount=function(){
      const btn=document.getElementById('btnSimUseRecommended'); plannerSetButtonBusy(btn,true,'กำลังใช้แผน...');
      SState.userPickersA={...recommendedA}; SState.userPickersB={...recommendedB}; calculateSim(); const note=document.getElementById('simManualPending'); if(note) note.classList.remove('show'); plannerSetButtonBusy(btn,false);
      showPlannerActionPopup('success','ใช้แผนแนะนำเรียบร้อย',`จัดสรรกำลังคนตาม Workload และ Productivity ที่ยืนยันแล้ว\nกะ A ${roster.countA} คน · กะ B ${roster.countB} คน`);
    };
    window._simResetWorkload=function(){
      const btn=document.getElementById('btnSimResetWorkload'); plannerSetButtonBusy(btn,true,'กำลังล้าง...');
      SState.customWorkload=null; SState.customSourceName=''; SState.userPickersA={}; SState.userPickersB={}; built.simulator=false; show('simulator');
      setTimeout(()=>{ const b=document.getElementById('btnSimResetWorkload'); plannerSetButtonBusy(b,false); showPlannerActionPopup('success','ล้าง Workload เรียบร้อย','ระบบกลับสู่สถานะรออัปโหลดไฟล์ ESTIMATED และยังไม่คำนวณแผนกำลังคน'); },120);
    };
    window._simHandleOrderFile=function(e){
      const file=e.target.files&&e.target.files[0]; if(!file)return; const isXlsx=/\.(xlsx|xls)$/i.test(file.name); const reader=new FileReader(); const uploadBtn=document.getElementById('btnSimUploadOrder'); plannerSetButtonBusy(uploadBtn,true,'กำลังอ่านไฟล์...'); showPlannerActionPopup('loading','กำลังนำเข้าไฟล์ ESTIMATED',file.name);
      reader.onload=function(evt){ try{
        let matrix=[]; if(isXlsx&&typeof XLSX!=='undefined'){ const wb=XLSX.read(new Uint8Array(evt.target.result),{type:'array'}); matrix=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:''}); } else { const txt=typeof evt.target.result==='string'?evt.target.result:new TextDecoder().decode(evt.target.result); matrix=txt.split(/\r?\n/).map(x=>x.split(',')); }
        if(!matrix||matrix.length<2)throw new Error('ไฟล์ไม่มีข้อมูล'); let headerRow=0,header=[];
        for(let i=0;i<Math.min(20,matrix.length);i++){
          const h=(matrix[i]||[]).map(v=>String(v||'').trim().toLowerCase());
          const hasZone=h.some(x=>x==='zone'||x==='z'||x.includes('โซน')||x==='location'||x==='loc');
          const hasPickUnits=h.some(x=>x==='pu'||x==='pick unit'||x==='pick units'||x==='pickunit'||x==='pickunits'||x.includes('หน่วยหยิบ'));
          if(hasZone&&hasPickUnits){headerRow=i;header=h;break;}
        }
        if(!header.length)header=(matrix[0]||[]).map(v=>String(v||'').trim().toLowerCase());
        let zIdx=header.findIndex(h=>h==='z'||h==='zone'||h.includes('โซน'));
        let locIdx=header.findIndex(h=>h==='loc'||h==='location'||h.includes('โลเคชั่น'));
        let puIdx=header.findIndex(h=>h==='pu'||h==='pick unit'||h==='pick units'||h==='pickunit'||h==='pickunits'||h.includes('หน่วยหยิบ'));
        if(zIdx<0)zIdx=locIdx>=0?locIdx:8;   // ESTIMATED: Column I = z
        if(puIdx<0)puIdx=20;                // ESTIMATED: Column U = pu (0-based index 20)
        const map={}; let n=0, totalPu=0;
        for(let i=headerRow+1;i<matrix.length;i++){
          const row=matrix[i]||[];
          const raw=String(row[zIdx]||(locIdx>=0?row[locIdx]:'')||'').trim();
          if(!raw)continue;
          const pu=Math.max(0,parseFloat(row[puIdx])||0);
          if(pu<=0)continue;
          const zi=getZoneInfo(raw), zn=zi.zone||raw;
          if(!map[zn])map[zn]={name:zn,vol:0,lines:0,prodRate:rateMap[zn]||100,rateFallback:!(rateMap[zn]>0)};
          map[zn].vol+=pu; map[zn].lines++; n++; totalPu+=pu;
        }
        if(!Object.keys(map).length)throw new Error('ไม่พบ Zone และหน่วยหยิบจาก Column U (pu) ที่ใช้วางแผน');
        SState.customWorkload=map; SState.customSourceName=`${file.name} · Column U (pu) · ${fmt(n)} รายการ`; SState.userPickersA={}; SState.userPickersB={}; built.simulator=false; show('simulator');
        setTimeout(()=>showPlannerActionPopup('success','นำเข้าไฟล์ ESTIMATED สำเร็จ',`${file.name}\nWorkload จาก Column U (pu) = ${fmt(totalPu)} หน่วยหยิบ\nประมวลผล ${fmt(n)} รายการ · ${Object.keys(map).length} Zone`),80);
      }catch(err){showPlannerActionPopup('error','นำเข้าไฟล์ไม่สำเร็จ',String(err.message||err),{autoClose:false});} finally{ const b=document.getElementById('btnSimUploadOrder'); plannerSetButtonBusy(b,false); e.target.value='';} };
      if(isXlsx)reader.readAsArrayBuffer(file); else reader.readAsText(file);
    };
    calculateSim();
    schedulePlannerRosterAutoRefresh();
    if(Date.now() - plannerRosterLastCheckedAt >= PLANNER_ROSTER_AUTO_REFRESH_MS){
      setTimeout(()=>void refreshPlannerRoster(false,{silent:true}).catch(()=>{}), 0);
    }
  }
};




function renderTargetVsActualChart() {
  const el = document.getElementById('targetVsActualChart');
  if (!el || !A || !A.daily) return;

  const exChart = Chart.getChart('targetVsActualChart');
  if (exChart) exChart.destroy();

  const isPcs = unitMode === 'pcs';
  const unitLabel = isPcs ? 'ชิ้น/ชม.' : 'หยิบ/ชม.';

  const badgeVal = document.getElementById('targetBadgeVal');
  if (badgeVal) badgeVal.textContent = prodTarget + ' ' + unitLabel;

  const labels = A.daily.map(d => d.date.length > 5 ? d.date.slice(5) : d.date);
  const actualValues = A.daily.map(d => isPcs ? (d.avg_pcs_prod || 0) : (d.avg_prod || 0));
  const targetValues = A.daily.map(() => prodTarget);
  const barColors = actualValues.map(v => v >= prodTarget ? '#10b981' : '#ef4444');

  new Chart(el, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          type: 'line',
          label: `เป้าหมาย (${prodTarget} ${unitLabel})`,
          data: targetValues,
          borderColor: '#6366f1',
          borderWidth: 2.5,
          borderDash: [6, 6],
          pointRadius: 4,
          pointBackgroundColor: '#6366f1',
          fill: false,
          order: 1
        },
        {
          type: 'bar',
          label: `Productivity จริง (${unitLabel})`,
          data: actualValues,
          backgroundColor: barColors,
          borderRadius: 6,
          barThickness: 24,
          order: 2
        }
      ]
    },
    options: {
      maintainAspectRatio: false,
      layout: { padding: { top: 20, right: 10, bottom: 0, left: 10 } },
      plugins: {
        legend: { display: true, position: 'top', labels: { font: { weight: '600', size: 12 } } },
        datalabels: {
          anchor: 'end',
          align: 'end',
          color: '#334155',
          font: { weight: '700', size: 11 },
          formatter: (v, ctx) => ctx.datasetIndex === 1 ? (fmt(v) + ' ' + unitLabel) : ''
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { weight: '600' } } },
        y: { grid: { color: '#f1f5f9' }, ticks: { callback: fmt } }
      }
    }
  });
}

function exportPDF() {
  const tsEl = document.getElementById('printTimestamp');
  if (tsEl) {
    const now = new Date();
    tsEl.textContent = now.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
  }
  window.print();
}

window.toggleExcludeSku = function(owner, sku) {
  const ownerKey = normalizeOwnerKey(owner);
  const item = normalizeSkuKey(sku);
  const key = itemCompositeKey(ownerKey, item);
  const wildcardKeys = skuKeyVariants(item).map(v => itemCompositeKey('*', v));
  if (excludedSkus.has(key)) excludedSkus.delete(key);
  else if(wildcardKeys.some(k => excludedSkus.has(k))) wildcardKeys.forEach(k => excludedSkus.delete(k));
  else if(item) excludedSkus.add(key);
  saveExcludedSkusToStorage();
  invalidateAggregationCache();
  dashboardCacheRevision = '';
  itemCubePayloadCache.clear();
  itemCubeLoadState.clear();
  slotCubePayloadCache.clear();
  slotCubeLoadState.clear();
  void loadData(false);
};

window.clearExcludedSkus = function() {
  excludedSkus.clear();
  saveExcludedSkusToStorage();
  invalidateAggregationCache();
  dashboardCacheRevision = '';
  itemCubePayloadCache.clear(); itemCubeLoadState.clear();
  slotCubePayloadCache.clear(); slotCubeLoadState.clear();
  void loadData(false);
};
function renderExcludedBadges() {
  const bar = document.getElementById('excludedBar');
  const badgeContainer = document.getElementById('excludedBadges');
  const countBadge = document.getElementById('excludedCountBadge');
  const savedAtBadge = document.getElementById('excludedSavedAt');
  const btnClear = document.getElementById('btnClearExcluded');
  if (btnClear && !btnClear._bound) { btnClear._bound = true; btnClear.addEventListener('click', clearExcludedSkus); }
  if (!bar || !badgeContainer || !countBadge) return;
  if (excludedSkus.size === 0) { bar.style.display = 'none'; if (savedAtBadge) savedAtBadge.textContent = ''; return; }
  bar.style.display = 'block';
  countBadge.textContent = excludedSkus.size.toLocaleString();
  if (savedAtBadge) savedAtBadge.textContent = excludedSkusSavedAt ? `บันทึกล่าสุด: ${formatThaiDateTime(excludedSkusSavedAt)}` : 'รายการนี้จะถูกจำไว้ในเครื่องนี้อัตโนมัติ';
  let h = '';
  excludedSkus.forEach(key => {
    const parsed = parseItemCompositeKey(key);
    const info = getItemInfo(parsed.owner, parsed.item);
    const name = info.name || parsed.item;
    const displayLabel = name.length > 28 ? name.slice(0, 26) + '…' : name;
    h += `<div style="display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid #fdba74;color:#c2410c;padding:5px 12px;border-radius:20px;font-size:12.5px;font-weight:500;box-shadow:0 2px 6px rgba(249,115,22,0.12);">
      <span><b>${escapeZoneHtml(parsed.owner)} / ${escapeZoneHtml(parsed.item)}</b> · ${escapeZoneHtml(displayLabel)}</span>
      <button onclick="toggleExcludeSku(decodeURIComponent('${encodeURIComponent(parsed.owner)}'),decodeURIComponent('${encodeURIComponent(parsed.item)}'))" style="border:0;background:#ffedd5;color:#c2410c;width:18px;height:18px;border-radius:50%;cursor:pointer;font-weight:700;font-size:11px;display:flex;align-items:center;justify-content:center;line-height:1;" title="นำกลับมาคำนวณ">✕</button>
    </div>`;
  });
  badgeContainer.innerHTML = h;
}

function destroyCharts(){ ['trend','cat','picker','zone','slot','item','typepickRadar'].forEach(id => { const c = Chart.getChart(id); if(c) c.destroy(); }); }

function show(page){
  if(!hasLiveData) return;
  currentPage = page;
  document.querySelectorAll('.nav').forEach(n => n.classList.toggle('active', n.dataset.page === page));
  document.querySelectorAll('.page').forEach(s => s.classList.toggle('active', s.dataset.page === page));
  document.getElementById('ptitle').textContent = TITLES[page];
  if(!built[page]){ builders[page](); built[page] = true; }
}
function preloadAllCubes(){
  if(!hasLiveData || !dfrom || !dto) return;
  setTimeout(() => void loadItemMaster(false), 20);
  if(!hasCurrentSlotCube()) setTimeout(() => void loadCurrentSlotCube(false), 60);
  if(!hasCurrentItemCube()) setTimeout(() => void loadCurrentItemCube(false), 100);
}

function render(){
  A = aggregate(sys, dfrom, dto, shiftF);
  destroyCharts();
  renderExcludedBadges();
  document.getElementById('ptable').innerHTML = '';
  const elItable = document.getElementById('itable'); if (elItable) elItable.innerHTML = '';
  document.querySelectorAll('#kpis .num[data-t]').forEach(el => el.removeAttribute('data-done'));
  built = {};
  updateDateHeader();
  renderKPIs();
  show(currentPage);
  preloadAllCubes();
}

function setSideBadge(message){
  const badge = document.querySelector('.sidebadge');
  if(badge) badge.textContent = message;
}

function clearDashboardState(){
  hasLiveData = false;
  DATA = emptyData();
  dashboardCacheRevision = '';
  aggregateCache.clear();
  ITEM_MASTER = Object.create(null); ITEM_MASTER_BY_SKU = Object.create(null);
  prepareZoneMaster();
  ALL_DATES = []; DMIN = ''; DMAX = ''; dfrom = ''; dto = '';
  datePresetMode = 'all';
  trendMode = 'day';
  A = null; built = {}; lastFetchTime = null;
  itemSearchTerm = '';
  destroyCharts();
  const sysbar = document.querySelector('.sysbar'); if(sysbar) sysbar.remove();
  const daterange = document.getElementById('daterange'); if(daterange) daterange.textContent = '';
  const kpis = document.getElementById('kpis'); if(kpis) kpis.innerHTML = '';
  const ptable = document.getElementById('ptable'); if(ptable) ptable.innerHTML = '';
  const itable = document.getElementById('itable'); if(itable) itable.innerHTML = '';
}

function showDataState(kind, message, meta){
  clearDashboardState();
  DATA.meta = meta || {};
  lastFetchTime = DATA.meta.generated || null;

  const content = document.querySelector('.content');
  const state = document.getElementById('dataState');
  const icon = document.getElementById('dataStateIcon');
  const title = document.getElementById('dataStateTitle');
  const text = document.getElementById('dataStateMessage');
  const upload = document.getElementById('dataStateUpload');
  const retry = document.getElementById('dataStateRetry');

  if(content) content.classList.add('data-unavailable');
  if(state) state.hidden = false;

  const config = {
    loading:{icon:'⏳', title:'กำลังโหลดข้อมูลจาก BigQuery'},
    empty:{icon:'📭', title:'BigQuery ยังไม่มีข้อมูล'},
    error:{icon:'⚠️', title:'ไม่สามารถโหลดข้อมูลจาก BigQuery'}
  }[kind] || {icon:'ℹ️', title:'สถานะข้อมูล'};

  if(icon) icon.textContent = config.icon;
  if(title) title.textContent = config.title;
  if(text) text.textContent = message;
  if(upload) upload.hidden = kind === 'loading';
  if(retry) retry.hidden = kind === 'loading';

  if(kind === 'empty') setSideBadge('BigQuery 0 แถว\nพร้อมรับไฟล์ใหม่');
  else if(kind === 'error') setSideBadge('BigQuery โหลดไม่สำเร็จ\nไม่ใช้ข้อมูลสำรอง');
  else setSideBadge('กำลังเชื่อมต่อ BigQuery…');
}

function hideDataState(){
  const content = document.querySelector('.content');
  const state = document.getElementById('dataState');
  if(content) content.classList.remove('data-unavailable');
  if(state) state.hidden = true;
  hasLiveData = true;
}

function bindDataStateActions(){
  const upload = document.getElementById('dataStateUpload');
  const retry = document.getElementById('dataStateRetry');
  if(upload) upload.onclick = () => document.getElementById('btnUploadModal')?.click();
  // Retry ต้องยอมอ่าน Script Cache: คำขอก่อนหน้าอาจประมวลผลเสร็จหลัง browser timeout
  // การบังคับ fresh ที่นี่ทำให้ทุกครั้งเริ่ม query หลายแสนแถวใหม่และวนช้าซ้ำเดิม
  if(retry) retry.onclick = () => loadData(false);
}

// ===== loading overlay =====
function showLoading(on, msg){
  let ov = document.getElementById('loadov');
  if(on){
    if(!ov){ ensureStyles(); ov = document.createElement('div'); ov.id='loadov'; ov.innerHTML='<div class="sp"></div><div class="msg"></div>'; document.body.appendChild(ov); }
    ov.querySelector('.msg').textContent = msg || 'กำลังโหลดข้อมูลจาก BigQuery…';
    ov.style.display='flex';
  } else if(ov){ ov.style.display='none'; }
}

function setUpdating(on){
  const el = document.getElementById('freshTxt'); if(!el) return;
  if(on) el.textContent = '⏳ กำลังอัปเดตข้อมูลล่าสุด…'; else updateFresh();
}

// ===== IndexedDB cache: แสดงข้อมูลรอบล่าสุดทันที แล้วตรวจ revision เบื้องหลัง =====
function openDashboardCacheDb(){
  return new Promise((resolve, reject) => {
    if(typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DASHBOARD_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if(!db.objectStoreNames.contains(DASHBOARD_CACHE_STORE)) {
        db.createObjectStore(DASHBOARD_CACHE_STORE, {keyPath:'key'});
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('เปิด cache ไม่สำเร็จ'));
    request.onblocked = () => reject(new Error('Dashboard cache ถูกใช้งานอยู่'));
  });
}

function idbRequestResult(request){
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('อ่าน cache ไม่สำเร็จ'));
  });
}

async function readDashboardResponseCache(){
  let db;
  try{
    db = await openDashboardCacheDb();
    const tx = db.transaction(DASHBOARD_CACHE_STORE, 'readonly');
    const record = await idbRequestResult(tx.objectStore(DASHBOARD_CACHE_STORE).get(DASHBOARD_CACHE_KEY));
    if(!record || typeof record.body !== 'string') return null;
    if(Date.now() - Number(record.savedAt || 0) > DASHBOARD_CACHE_MAX_AGE_MS) {
      void clearDashboardResponseCache();
      return null;
    }
    return record;
  }catch(_){
    return null;
  }finally{
    if(db) db.close();
  }
}

async function writeDashboardResponseCache(body, payload){
  let db;
  try{
    db = await openDashboardCacheDb();
    const tx = db.transaction(DASHBOARD_CACHE_STORE, 'readwrite');
    tx.objectStore(DASHBOARD_CACHE_STORE).put({
      key: DASHBOARD_CACHE_KEY,
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      revision: String(payload && payload.meta && payload.meta.data_revision || ''),
      generated: String(payload && payload.meta && payload.meta.generated || ''),
      savedAt: Date.now(),
      body
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('บันทึก cache ไม่สำเร็จ'));
      tx.onabort = () => reject(tx.error || new Error('ยกเลิกการบันทึก cache'));
    });
  }catch(err){
    console.warn('บันทึก Dashboard cache ไม่สำเร็จ:', err);
  }finally{
    if(db) db.close();
  }
}

function dashboardCubeStorageKey(kind, requestKey){
  return DASHBOARD_CUBE_CACHE_PREFIX + kind + ':' + requestKey;
}

async function readDashboardCubeCache(kind, requestKey){
  let db;
  try{
    db = await openDashboardCacheDb();
    const tx = db.transaction(DASHBOARD_CACHE_STORE, 'readonly');
    const record = await idbRequestResult(
      tx.objectStore(DASHBOARD_CACHE_STORE).get(dashboardCubeStorageKey(kind, requestKey))
    );
    if(!record || !record.payload) return null;
    if(Date.now() - Number(record.savedAt || 0) > DASHBOARD_CACHE_MAX_AGE_MS) return null;
    return record.payload;
  }catch(_){
    return null;
  }finally{
    if(db) db.close();
  }
}

async function writeDashboardCubeCache(kind, requestKey, payload){
  let db;
  try{
    db = await openDashboardCacheDb();
    const tx = db.transaction(DASHBOARD_CACHE_STORE, 'readwrite');
    tx.objectStore(DASHBOARD_CACHE_STORE).put({
      key: dashboardCubeStorageKey(kind, requestKey),
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      revision: dashboardDataEpoch(),
      savedAt: Date.now(),
      payload
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('บันทึก cube cache ไม่สำเร็จ'));
      tx.onabort = () => reject(tx.error || new Error('ยกเลิกการบันทึก cube cache'));
    });
  }catch(err){
    console.warn('บันทึก Cube cache ไม่สำเร็จ:', err);
  }finally{
    if(db) db.close();
  }
}

async function pruneDashboardCubeCache(){
  let db;
  try{
    db = await openDashboardCacheDb();
    const tx = db.transaction(DASHBOARD_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(DASHBOARD_CACHE_STORE);
    const epoch = dashboardDataEpoch();
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('ลบ cache เก่าไม่สำเร็จ'));
      tx.onabort = () => reject(tx.error || new Error('ยกเลิกการลบ cache เก่า'));
      const cursorRequest = store.openCursor();
      cursorRequest.onerror = () => reject(cursorRequest.error || new Error('อ่านรายการ cache ไม่สำเร็จ'));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if(!cursor) return;
        const key = String(cursor.key || '');
        const record = cursor.value || {};
        if(key.startsWith(DASHBOARD_CUBE_CACHE_PREFIX) &&
            (String(record.revision || '') !== epoch ||
             Date.now() - Number(record.savedAt || 0) > DASHBOARD_CACHE_MAX_AGE_MS)) {
          cursor.delete();
        }
        cursor.continue();
      };
    });
  }catch(_){
    // IndexedDB เป็นเพียงตัวเร่ง ต้องไม่ทำให้ Dashboard หยุดทำงาน
  }finally{
    if(db) db.close();
  }
}

async function clearDashboardResponseCache(){
  let db;
  try{
    db = await openDashboardCacheDb();
    const tx = db.transaction(DASHBOARD_CACHE_STORE, 'readwrite');
    tx.objectStore(DASHBOARD_CACHE_STORE).delete(DASHBOARD_CACHE_KEY);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('ลบ cache ไม่สำเร็จ'));
      tx.onabort = () => reject(tx.error || new Error('ยกเลิกการลบ cache'));
    });
  }catch(_){
    // cache เป็นตัวช่วยเท่านั้น ต้องไม่ทำให้หน้าเว็บหยุดทำงาน
  }finally{
    if(db) db.close();
  }
}

function dashboardPayloadRowCount(payload){
  const validSource = source =>
    source && Number(source.row_width) === 9 && Number(source.item_row_width) === 8 && Number(source.slot_row_width) === 8 &&
    Array.isArray(source.dates) && Array.isArray(source.pickers) && Array.isArray(source.skus) &&
    Array.isArray(source.rows) && source.rows.length % 9 === 0 &&
    Array.isArray(source.item_rows) && source.item_rows.length % 8 === 0 &&
    Array.isArray(source.slot_rows) && source.slot_rows.length % 8 === 0;
  const validSchema = payload && payload.meta &&
    payload.meta.schema_version === DASHBOARD_SCHEMA_VERSION;
  const payloadExclusions = payload && payload.meta && Array.isArray(payload.meta.excluded_items)
    ? payload.meta.excluded_items.map(x => ({owner:normalizeOwnerKey(x.owner), item:normalizeSkuKey(x.item)}))
      .filter(x => x.owner && x.item).sort((a,b)=>a.owner.localeCompare(b.owner)||a.item.localeCompare(b.item))
    : [];
  const validScope = JSON.stringify(payloadExclusions) === JSON.stringify(currentExcludedItemList());
  if(!validSchema || !validScope || !validSource(payload.PTT) || !validSource(payload.BPS)) {
    throw new Error('รูปแบบข้อมูล BigQuery เป็นคนละรุ่นกับหน้าเว็บ กรุณากดรีเฟรชอีกครั้ง');
  }
  const packedRows = packedRowCount(payload.PTT) + packedRowCount(payload.BPS);
  return Number(payload.meta && payload.meta.input_lines) || packedRows;
}

function setDashboardSourceBadge(totalRows, source){
  const updated = formatThaiDateTime(lastFetchTime) || '-';
  if(source === 'cache') {
    setSideBadge(
      'ข้อมูลจากเครื่อง ' + fmt(totalRows) + ' แถว\n' +
      'UOM จาก BigQuery\n' +
      'ข้อมูล ณ ' + updated + '\nกำลังตรวจ BigQuery…'
    );
    return;
  }
  setSideBadge(
    'BigQuery ล่าสุด ' + fmt(totalRows) + ' แถว\n' +
    'UOM จาก BigQuery\n' +
    'อัปเดต ' + updated
  );
}

function finalizeDashboardBundle(totalRows, source){
  aggregateCache.clear();
  hideDataState();
  setDashboardSourceBadge(totalRows, source);
  buildControls();
  render();
  void pruneDashboardCubeCache();
}

function captureDashboardRuntime(){
  return {
    DATA,
    ALL_DATES:[...ALL_DATES], DMIN, DMAX,
    sys, shiftF, dfrom, dto, datePresetMode, trendMode,
    dashboardCacheRevision, lastFetchTime, hasLiveData
  };
}

function restoreDashboardRuntime(snapshot){
  if(!snapshot) return;
  DATA = snapshot.DATA;
  ALL_DATES = [...snapshot.ALL_DATES];
  DMIN = snapshot.DMIN; DMAX = snapshot.DMAX;
  sys = snapshot.sys; shiftF = snapshot.shiftF;
  dfrom = snapshot.dfrom; dto = snapshot.dto;
  datePresetMode = snapshot.datePresetMode; trendMode = snapshot.trendMode;
  dashboardCacheRevision = snapshot.dashboardCacheRevision;
  lastFetchTime = snapshot.lastFetchTime;
  hasLiveData = snapshot.hasLiveData;
  prepareZoneMaster();
}
async function restoreCurrentCubePairFromCache(){
  const scope = canonicalCubeScope(sys, dfrom, dto);
  const itemKey = itemCubeRequestKey(sys, scope.from, scope.to, scope.shift);
  const slotKey = slotCubeRequestKey(sys, scope.from, scope.to, scope.shift);
  const masterKey = itemMasterRequestKey();
  const [masterPayload, itemPayload, slotPayload] = await Promise.all([
    readDashboardCubeCache('itemmaster', masterKey),
    readDashboardCubeCache('item', itemKey),
    readDashboardCubeCache('slot', slotKey)
  ]);
  if(isValidItemMasterPayload(masterPayload)){
    itemMasterPayloadCache.set(masterKey, masterPayload); applyItemMasterPayload(masterPayload);
  }
  if(isValidItemCubePayload(itemPayload, sys, scope.from, scope.to, scope.shift)){
    itemCubePayloadCache.set(itemKey, itemPayload); itemCubeLoadState.set(itemKey, {status:'done'});
  }
  if(isValidSlotCubePayload(slotPayload, sys, scope.from, scope.to, scope.shift)){
    slotCubePayloadCache.set(slotKey, slotPayload); slotCubeLoadState.set(slotKey, {status:'done'});
  }
  return true;
}
async function ensureDashboardBundleReady(force, totalRows, source){
  dashboardBundleLoading = false;
  // แสดง Main Dashboard ทันที ไม่รอ Item/Time cube เพื่อไม่ย้อนกลับไปใช้ข้อมูลรอบเก่า
  finalizeDashboardBundle(totalRows, source);
  setTimeout(() => {
    void Promise.all([
      loadItemMaster(force),
      loadCurrentItemCube(force, sys),
      loadCurrentSlotCube(force, sys)
    ]);
  }, 30);
  const otherSystem = sys === 'PTT' ? 'BPS' : 'PTT';
  setTimeout(() => {
    void Promise.all([loadCurrentItemCube(false, otherSystem), loadCurrentSlotCube(false, otherSystem)]);
  }, 1000);
  return true;
}

function applyDashboardPayload(payload, previous, source, options){
  const totalRows = dashboardPayloadRowCount(payload);
  if(totalRows === 0) return 0;

  DATA = payload;
  aggregateCache.clear();
  prepareZoneMaster();
  lastFetchTime = payload.meta ? payload.meta.generated : new Date().toISOString();
  dashboardCacheRevision = String(payload.meta && payload.meta.data_revision || '');
  sys = previous.sys;
  shiftF = previous.shiftF;
  computeBounds();
  const keepFrom = previous.dfrom && previous.dfrom>=DMIN && previous.dfrom<=DMAX;
  const keepTo = previous.dto && previous.dto>=DMIN && previous.dto<=DMAX;
  dfrom = keepFrom ? previous.dfrom : DMIN;
  dto   = keepTo ? previous.dto : DMAX;
  datePresetMode = (keepFrom || keepTo) ? (previous.datePresetMode || 'custom') : 'all';
  trendMode = previous.trendMode || trendMode;
  if(options && options.deferReady){
    setSideBadge('กำลังเตรียมข้อมูลพนักงาน\nสินค้า และช่วงเวลา…');
  }else{
    finalizeDashboardBundle(totalRows, source);
  }
  return totalRows;
}
async function restoreDashboardFromCache(){
  const record = await readDashboardResponseCache();
  if(!record) return false;
  try{
    const payload = JSON.parse(record.body);
    const previous = {sys, shiftF, dfrom, dto, datePresetMode, trendMode};
    const rows = applyDashboardPayload(payload, previous, 'cache', {deferReady:false});
    if(rows <= 0) { void clearDashboardResponseCache(); return false; }
    preloadAllCubes();
    return true;
  }catch(err){
    console.warn('Dashboard cache ใช้งานไม่ได้ จะโหลดจาก BigQuery ใหม่:', err);
    void clearDashboardResponseCache();
    return false;
  }
}

async function fetchRevisionOrDashboard(signal){
  const url = DATA_URL + (DATA_URL.includes('?')?'&':'?') +
    'mode=revision&' + dashboardScopeQuery() + '&t=' + Date.now();
  const response = await fetchWithTransientRetry(url, {cache:'no-store', signal}, 2);
  if(!response.ok) throw new Error('HTTP ' + response.status);
  const body = await response.text();
  const payload = JSON.parse(body);
  if(payload && payload.error) {
    const err = new Error(payload.error);
    err.code = String(payload.code || 'DASHBOARD_RESPONSE_ERROR');
    throw err;
  }
  if(payload && payload.meta && payload.PTT && payload.BPS) {
    // รองรับ Apps Script deployment รุ่นเดิมที่ยังไม่รู้จัก mode=revision
    return {payload, body};
  }
  if(!payload || payload.schema_version !== DASHBOARD_SCHEMA_VERSION || payload.revision == null) {
    throw new Error('Apps Script ตอบ revision ไม่ถูกต้อง');
  }
  return {
    revision:String(payload.revision),
    minDate:String(payload.min_date || ''),
    maxDate:String(payload.max_date || '')
  };
}

// ===== โหลดข้อมูล: ดึงตรงจาก BigQuery และกันคำขอซ้อน =====
function loadData(force){
  if(activeLoadPromise){
    if(!force || activeLoadIsFresh) return activeLoadPromise;
    if(!queuedFreshPromise) {
      queuedFreshPromise = activeLoadPromise
        .then(() => loadData(true))
        .finally(() => { queuedFreshPromise = null; });
    }
    return queuedFreshPromise;
  }
  activeLoadIsFresh = Boolean(force);
  const task = loadDataOnce(Boolean(force));
  let wrapped;
  wrapped = task.finally(() => {
    if(activeLoadPromise === wrapped) {
      activeLoadPromise = null;
      activeLoadIsFresh = false;
    }
  });
  activeLoadPromise = wrapped;
  return wrapped;
}

async function loadDataOnce(force, transientAttempt = 0){
  document.querySelectorAll('.nav[data-page]').forEach(n => n.onclick = () => show(n.dataset.page));
  const previous = {sys, shiftF, dfrom, dto, datePresetMode, trendMode};
  const hadLiveData = hasLiveData;
  const runtimeSnapshot = hadLiveData ? captureDashboardRuntime() : null;
  if(!DATA_URL){
    showDataState('error', 'ยังไม่ได้ตั้งค่า Apps Script Web App และระบบจะไม่แสดงข้อมูลสำรอง');
    return {ok:false, rows:0};
  }

  if(!hadLiveData) {
    showDataState('loading', 'กำลังเชื่อมต่อ BigQuery กรุณารอสักครู่');
    showLoading(true, 'กำลังดึงข้อมูลสด 100% ตรงจาก BigQuery…');
  }
  setUpdating(true);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DASHBOARD_TIMEOUT_MS);

  try{
    let body = '';
    let j = null;
    let earlyCubePromise = null;
    let requestedRevision = '';

    // ขอ revision + ขอบเขตวันที่ก่อนเสมอ เพื่อเริ่ม Item/Time cube พร้อมกับ Main cube
    // ลด cold load จากเวลารวมแบบต่อคิวให้เหลือเวลาของคำขอที่ช้าที่สุด
    {
      const probe = await fetchRevisionOrDashboard(controller.signal);
      if(probe.revision != null) {
        requestedRevision = String(probe.revision);
        if(!force && hadLiveData && probe.revision === dashboardCacheRevision) {
          const currentRows = dashboardPayloadRowCount(DATA);
          if(!hasCurrentItemCube() || !hasCurrentSlotCube()) {
            showLoading(true, 'กำลังเตรียมข้อมูลพนักงาน สินค้า และช่วงเวลาให้พร้อมกัน…');
          }
          await ensureDashboardBundleReady(false, currentRows, 'live');
          return {ok:true, rows:currentRows, unchanged:true};
        }
        if(/^\d{4}-\d{2}-\d{2}$/.test(probe.minDate) &&
            /^\d{4}-\d{2}-\d{2}$/.test(probe.maxDate) && probe.minDate <= probe.maxDate) {
          dashboardCacheRevision = probe.revision;
          DMIN = probe.minDate;
          DMAX = probe.maxDate;
          dfrom = previous.dfrom && previous.dfrom >= DMIN && previous.dfrom <= DMAX ? previous.dfrom : DMIN;
          dto = previous.dto && previous.dto >= DMIN && previous.dto <= DMAX ? previous.dto : DMAX;
          showLoading(true, 'กำลังดึงข้อมูลพนักงาน สินค้า และช่วงเวลาพร้อมกัน…');
          earlyCubePromise = Promise.all([
            loadItemMaster(force),
            loadCurrentItemCube(force, sys),
            loadCurrentSlotCube(force, sys)
          ]);
          // ตัว loader แปลง error เป็น null อยู่แล้ว; catch นี้ป้องกัน unhandled rejection หาก browser ปิดคำขอ
          void earlyCubePromise.catch(() => null);
        }
      } else {
        j = probe.payload;
        body = probe.body;
      }
    }

    if(!j) {
      const url = DATA_URL + (DATA_URL.includes('?')?'&':'?') +
        'fresh=' + (force ? '1' : '0') + '&' + dashboardResponseEncodingQuery() + '&' +
        dashboardScopeQuery() + '&t=' + Date.now();
      const res = await fetchWithTransientRetry(url, {cache:'no-store', signal:controller.signal}, 2);
      if(!res.ok) throw new Error('HTTP ' + res.status);
      try {
        const decoded = await readDashboardJsonResponse(res);
        body = decoded.body;
        j = decoded.payload;
      } catch(parseErr) {
        if(String(parseErr && parseErr.message || '').includes('ไม่มีหน่วยความจำ')) {
          throw new Error('Apps Script มีหน่วยความจำไม่พอสำหรับข้อมูลชุดนี้');
        }
        throw parseErr;
      }
    }
    if(j && j.error) {
      const err = new Error(j.error);
      err.code = String(j.code || 'DASHBOARD_RESPONSE_ERROR');
      throw err;
    }
    if(requestedRevision && String(j && j.meta && j.meta.data_revision || '') !== requestedRevision) {
      throw dashboardTransientError('ข้อมูล BigQuery มีการอัปเดตระหว่างโหลด ระบบกำลังลองใหม่ให้อัตโนมัติ');
    }
    const totalRows = dashboardPayloadRowCount(j);
    if(totalRows === 0){
      dashboardCacheRevision = '';
      await clearDashboardResponseCache();
      showDataState('empty', 'ไม่มีข้อมูลเก่าค้างอยู่แล้ว กรุณานำเข้าไฟล์ Pick Detail ชุดใหม่', j.meta);
      return {ok:true, rows:0};
    }

    applyDashboardPayload(j, previous, 'live', {deferReady:true});
    showLoading(true, 'กำลังเตรียมข้อมูลพนักงาน สินค้า และช่วงเวลาให้พร้อมกัน…');
    if(earlyCubePromise) void earlyCubePromise.catch(() => null);
    await ensureDashboardBundleReady(force, totalRows, 'live');
    await writeDashboardResponseCache(body, j);
    return {ok:true, rows:totalRows};
  }catch(err){
    console.warn('ดึงข้อมูลสดไม่สำเร็จ:', err);
    if(['DATA_EPOCH_CHANGED','DASHBOARD_UPDATE_BUSY'].includes(String(err && err.code || '')) && transientAttempt < 2){
      dashboardBundleLoading = false;
      if(hadLiveData) {
        restoreDashboardRuntime(runtimeSnapshot);
      } else {
        clearDashboardState();
        sys = previous.sys;
        shiftF = previous.shiftF;
      }
      await waitForRetry(1200 * (transientAttempt + 1));
      return await loadDataOnce(force, transientAttempt + 1);
    }
    const message = err && err.name === 'AbortError'
      ? 'BigQuery ใช้เวลาตอบกลับเกิน 3 นาที กรุณากดลองอีกครั้ง'
      : (err && err.message ? err.message : 'ระบบเชื่อมต่อ BigQuery ไม่สำเร็จ');
    if(hadLiveData){
      restoreDashboardRuntime(runtimeSnapshot);
      setSideBadge('อัปเดต BigQuery ไม่สำเร็จ\nยังแสดงข้อมูลรอบก่อน');
    } else {
      showDataState('error', message);
    }
    return {ok:false, rows:0, error:err};
  }finally{
    clearTimeout(timeout);
    showLoading(false);
    setUpdating(false);
  }
}

// init
loadExcludedSkusFromStorage();
loadExcludedZonesFromStorage();
loadProdTargetFromStorage();
bindDataStateActions();
updateExcludedZonesBar();
document.querySelectorAll('.nav[data-page]').forEach(n => n.onclick = () => show(n.dataset.page));
async function bootstrapDashboard(){
  await restoreDashboardFromCache();
  return loadData(false);
}
bootstrapDashboard();

// ===== ระบบอัปโหลดไฟล์ Pick Detail (.csv) ตรงเข้า BigQuery =====
(function initWebUploader(){
  const btnOpen = document.getElementById('btnUploadModal');
  const btnClose = document.getElementById('btnCloseUpload');
  const btnCancel = document.getElementById('btnCancelUpload');
  const btnStart = document.getElementById('btnStartUpload');
  const modal = document.getElementById('uploadModal');
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('csvFileInput');
  const progressBox = document.getElementById('uploadProgress');
  const progressBar = document.getElementById('progressBar');
  const statusText = document.getElementById('uploadStatusText');

  if(!btnOpen || !modal) return;

  let selectedFile = null;
  let xlsxLoadPromise = null;
  const UPLOAD_SCHEMA_VERSION = 'pick-detail-wms-v1';
  const MAX_UPLOAD_ROWS = 100000;
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  // ส่งข้อมูลเป็น CSV UTF-8 ก้อนใหญ่ขึ้น เพื่อลดจำนวนรอบ Apps Script/BigQuery Load Job
  const UPLOAD_CHUNK_TARGET_BYTES = 2 * 1024 * 1024;
  const UPLOAD_CHUNK_MAX_ROWS = 6000;
  const UPLOAD_CHUNK_CONCURRENCY = 2;
  const XLSX_SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  const REQUIRED_HEADERS = [
    {index:1, name:'PICKDETAILKEY'},
    {index:12, name:'ID'},
    {index:28, name:'QTY'},
    {index:31, name:'SKU'},
    {index:36, name:'STORERKEY'},
    {index:40, name:'UOMQTY'},
    {index:55, name:'EXT_UDF_STR7'},
    {index:56, name:'EXT_UDF_STR8'},
    {index:58, name:'EXT_UDF_STR10'},
    {index:64, name:'EXT_UDF_STR16'},
    {index:66, name:'EXT_UDF_DATE1'}
  ];

  function ensureXlsxLoaded(){
    if(typeof XLSX !== 'undefined') return Promise.resolve(XLSX);
    if(xlsxLoadPromise) return xlsxLoadPromise;

    xlsxLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = XLSX_SCRIPT_URL;
      script.async = true;
      script.dataset.xlsxLoader = '1';
      script.onload = () => {
        if(typeof XLSX !== 'undefined') resolve(XLSX);
        else {
          script.remove();
          xlsxLoadPromise = null;
          reject(new Error('โหลดตัวอ่านไฟล์ Excel ไม่สำเร็จ'));
        }
      };
      script.onerror = () => {
        script.remove();
        xlsxLoadPromise = null;
        reject(new Error('เชื่อมต่อ CDN สำหรับเปิดไฟล์ Excel ไม่สำเร็จ กรุณาลองอีกครั้ง'));
      };
      document.head.appendChild(script);
    });
    return xlsxLoadPromise;
  }

  const openModal = () => {
    modal.style.display = 'flex';
    resetUI();
    // เริ่มโหลด SheetJS เมื่อผู้ใช้เปิดหน้าต่างอัปโหลดเท่านั้น
    void ensureXlsxLoaded().catch(err => {
      if(progressBox) progressBox.style.display = 'block';
      if(progressBar) {
        progressBar.style.width = '100%';
        progressBar.style.background = '#ef4444';
      }
      if(statusText) statusText.textContent = '❌ ' + err.message;
    });
  };
  const closeModal = () => { modal.style.display = 'none'; resetUI(); };

  btnOpen.onclick = openModal;
  if(btnClose) btnClose.onclick = closeModal;
  if(btnCancel) btnCancel.onclick = closeModal;

  if(dropZone){
    dropZone.onclick = () => fileInput.click();
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.style.borderColor = '#2563eb'; };
    dropZone.ondragleave = () => { dropZone.style.borderColor = '#3b82f6'; };
    dropZone.ondrop = (e) => {
      e.preventDefault();
      dropZone.style.borderColor = '#3b82f6';
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    };
  }

  if(fileInput){
    fileInput.onchange = (e) => {
      if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
    };
  }

  function handleFile(file) {
    const ext = file.name.toLowerCase();
    if (!ext.endsWith('.csv') && !ext.endsWith('.xlsx') && !ext.endsWith('.xls')) {
      alert('กรุณาเลือกไฟล์ประเภท .csv, .xlsx หรือ .xls เท่านั้นครับ');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      alert('ไฟล์มีขนาดเกิน 25 MB กรุณาแบ่งไฟล์ก่อนนำเข้า');
      return;
    }
    selectedFile = file;
    dropZone.innerHTML = `
      <div style="font-size:36px;margin-bottom:10px;">✅</div>
      <div style="font-size:15px;font-weight:700;color:#059669;">เลือกไฟล์: ${escapeHtml(file.name)}</div>
      <div style="font-size:12px;color:#64748b;margin-top:6px;">ขนาด: ${(file.size/1048576).toFixed(2)} MB · คลิกหากต้องการเปลี่ยนไฟล์</div>
    `;
    btnStart.textContent = 'ตรวจสอบและนำเข้า BigQuery';
    btnStart.disabled = false;
    btnStart.style.display = 'inline-block';
  }

  function resetUI() {
    selectedFile = null;
    if(fileInput) fileInput.value = '';
    if(btnStart){
      btnStart.style.display = 'none';
      btnStart.disabled = false;
      btnStart.textContent = 'ตรวจสอบและนำเข้า BigQuery';
    }
    if(btnClose) btnClose.disabled = false;
    if(btnCancel) btnCancel.disabled = false;
    if(progressBox) progressBox.style.display = 'none';
    if(progressBar) progressBar.style.width = '0%';
    if(dropZone){
      dropZone.innerHTML = `
        <div style="font-size:36px;margin-bottom:10px;">📄</div>
        <div style="font-size:15px;font-weight:600;color:#1d4ed8;">คลิกเพื่อเลือกไฟล์ หรือ ลากวางไฟล์ Excel / CSV ที่นี่</div>
        <div style="font-size:12px;color:#64748b;margin-top:6px;">รองรับไฟล์ Pick Detail (.xlsx, .xls, .csv) สกัดโดยตรงจาก WMS</div>
      `;
    }
  }

  if(btnStart){
    btnStart.onclick = async () => {
      if (!selectedFile || !DATA_URL) return;
      const fileForUpload = selectedFile;
      setUploadBusy(true);
      progressBox.style.display = 'block';
      statusText.textContent = '⏳ กำลังอ่านข้อมูลไฟล์...';
      progressBar.style.width = '15%';
      progressBar.style.background = 'linear-gradient(90deg,#2563eb,#3b82f6)';

      try {
        await ensureXlsxLoaded();
        statusText.textContent = '⚙️ กำลังตรวจโครงสร้างและข้อมูลทุกแถว...';
        progressBar.style.width = '30%';
        const parsed = await readPickDetailFile(fileForUpload);
        const rows = parsed.rows;
        if (rows.length === 0) throw new Error('ไม่พบข้อมูลในไฟล์ หรือรูปแบบไฟล์ไม่ถูกต้อง');
        if (rows.length > MAX_UPLOAD_ROWS) {
          throw new Error(`ไฟล์มี ${rows.length.toLocaleString()} แถว เกินขีดจำกัด ${MAX_UPLOAD_ROWS.toLocaleString()} แถวต่อครั้ง`);
        }
        const localErrors = validateRowsBeforeUpload(rows);
        if (localErrors.length) {
          throw new Error(
            `พบข้อมูลไม่ถูกต้อง ${localErrors.length.toLocaleString()} จุด เช่น ` +
            localErrors.slice(0, 5).join(', ')
          );
        }

        const chunks = splitUploadRowsAsCsv(rows);
        const sessionId = createUploadSessionId();
        let completedChunks = 0;
        statusText.textContent =
          `🚀 ตรวจผ่าน ${rows.length.toLocaleString()} แถว แปลงเป็น CSV และแบ่งส่ง ${chunks.length.toLocaleString()} ชุด...`;
        progressBar.style.width = '40%';

        const chunkTasks = chunks.map((chunk, chunkIndex) => async () => {
          const chunkPayload = JSON.stringify({
            action: 'upload_chunk_csv',
            sessionId,
            chunkIndex,
            totalChunks: chunks.length,
            totalRows: rows.length,
            rowCount: chunk.rowCount,
            format: 'csv-v1',
            csv: chunk.csv,
            meta: parsed.meta
          });
          const response = await postUploadWithRetry(
            chunkPayload,
            `CSV ชุดที่ ${chunkIndex + 1}/${chunks.length}`
          );
          completedChunks += 1;
          const pct = 40 + Math.round((completedChunks / chunks.length) * 35);
          progressBar.style.width = pct + '%';
          statusText.textContent =
            `📦 BigQuery รับ CSV แล้ว ${completedChunks.toLocaleString()}/${chunks.length.toLocaleString()} ชุด ` +
            `(${rows.length.toLocaleString()} แถวทั้งหมด)`;
          return response;
        });
        await runWithConcurrency(chunkTasks, UPLOAD_CHUNK_CONCURRENCY);

        progressBar.style.width = '78%';
        statusText.textContent = '🔗 ได้รับครบทุกชุดแล้ว กำลังตรวจจำนวนและ Merge เข้า BigQuery ครั้งเดียว...';
        const json = await postUploadWithRetry(JSON.stringify({
          action: 'upload_commit',
          sessionId,
          totalChunks: chunks.length,
          totalRows: rows.length,
          meta: parsed.meta
        }), 'ขั้นตอน Merge');
        const counts = json.counts || {};
        progressBar.style.width = '90%';
        statusText.textContent =
          `✅ BigQuery รับแล้ว ${Number(counts.staged || json.rowsProcessed || 0).toLocaleString()} แถว ` +
          `(เพิ่ม ${Number(counts.inserted || 0).toLocaleString()}, แก้ไข ${Number(counts.updated || 0).toLocaleString()}, ` +
          `มีอยู่แล้ว ${Number(counts.unchanged || 0).toLocaleString()}) กำลังตรวจหน้าเว็บ...`;

        const refreshPromise = refreshDashboardAfterUpload();
        progressBar.style.width = '100%';
        const refreshed = await refreshPromise;

        const now = new Date();
        const completionTimeStr = now.toLocaleDateString('th-TH', {
          year: 'numeric', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        }) + ' น.';

        const successData = {
          completionTime: completionTimeStr,
          filename: fileForUpload ? fileForUpload.name : '-',
          totalRows: Number(counts.visible || json.rowsProcessed || rows.length || 0),
          inserted: Number(counts.inserted || 0),
          updated: Number(counts.updated || 0),
          unchanged: Number(counts.unchanged || 0)
        };

        if (refreshed) {
          statusText.textContent =
            `🎉 นำเข้าสำเร็จและหน้าเว็บอัปเดตแล้ว ` +
            `${Number(counts.visible || json.rowsProcessed || 0).toLocaleString()} แถว`;
          closeModal();
          showUploadSuccessModal(successData);
        } else {
          progressBar.style.background = '#f59e0b';
          statusText.textContent =
            '✅ ข้อมูลเข้า BigQuery สำเร็จแล้ว แต่หน้าเว็บยังตอบกลับไม่ทัน กรุณากด “ลองอีกครั้ง” บนหน้า Dashboard';
          selectedFile = null;
          showUploadSuccessModal(successData);
        }

      } catch (err) {
        console.error('การนำเข้าล้มเหลว:', err);
        progressBar.style.width = '100%';
        progressBar.style.background = '#ef4444';
        statusText.textContent = '❌ ' + (err && err.message ? err.message : 'การนำเข้าล้มเหลว');
        alert(statusText.textContent);
      } finally {
        setUploadBusy(false);
      }
    };
  }

  function setUploadBusy(busy) {
    if(btnStart) {
      btnStart.disabled = busy;
      btnStart.style.display = busy ? 'none' : (selectedFile ? 'inline-block' : 'none');
      if(!busy && selectedFile) btnStart.textContent = 'ลองนำเข้าอีกครั้ง';
    }
    if(btnClose) btnClose.disabled = busy;
    if(btnCancel) btnCancel.disabled = busy;
    if(dropZone) dropZone.style.pointerEvents = busy ? 'none' : '';
  }

  async function readPickDetailFile(file) {
    const ext = file.name.toLowerCase();
    let workbook;
    if (ext.endsWith('.xlsx') || ext.endsWith('.xls')) {
      const buffer = await file.arrayBuffer();
      workbook = XLSX.read(buffer, {type:'array', dense:true, cellDates:true});
    } else {
      const text = await file.text();
      workbook = XLSX.read(text, {type:'string', dense:true, cellDates:true});
    }
    if (!workbook.SheetNames || !workbook.SheetNames.length) {
      throw new Error('ไฟล์ไม่มี Worksheet');
    }
    const source = findPickDetailWorksheet(workbook);
    const firstSheet = source.sheetName;
    const headers = REQUIRED_HEADERS.map(header =>
      String(readWorksheetCellValue(source.sheet, source.headerRowIndex, header.index) || '')
        .trim()
        .toUpperCase()
    );
    REQUIRED_HEADERS.forEach((header, index) => {
      if (headers[index] !== header.name) {
        const column = XLSX.utils.encode_col(header.index);
        const actual = readWorksheetCellValue(source.sheet, source.headerRowIndex, header.index);
        throw new Error(
          `หัวคอลัมน์ ${column} ต้องเป็น ${header.name} แต่พบ “${String(actual || '').trim() || '(ว่าง)'}”`
        );
      }
    });
    return {
      rows: parsePickRowsFromWorksheet(source.sheet, source.headerRowIndex, source.lastRowIndex),
      meta: {
        schemaVersion: UPLOAD_SCHEMA_VERSION,
        filename: file.name,
        sheetName: firstSheet,
        headerRow: source.headerRowIndex + 1,
        sourceRowCount: Math.max(source.lastRowIndex - source.headerRowIndex - 1, 0),
        headers: headers
      }
    };
  }

  function findPickDetailWorksheet(workbook) {
    for(const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if(!sheet) continue;

      for(let rowIndex = 0; rowIndex < 10; rowIndex++) {
        const matches = REQUIRED_HEADERS.every(header => {
          const value = readWorksheetCellValue(sheet, rowIndex, header.index);
          return String(value == null ? '' : value).trim().toUpperCase() === header.name;
        });
        if(!matches) continue;

        let lastRowIndex = rowIndex;
        try {
          if(sheet['!ref']) {
            lastRowIndex = Math.max(XLSX.utils.decode_range(sheet['!ref']).e.r, rowIndex);
          }
        } catch(_) {}

        return {sheetName, sheet, headerRowIndex:rowIndex, lastRowIndex};
      }
    }
    throw new Error(
      'ไม่พบหัวตาราง Pick Detail ใน 10 แถวแรกของทุก Worksheet กรุณาใช้ไฟล์ Export จาก WMS รูปแบบเดียวกับ Pick 20'
    );
  }

  function readWorksheetCellValue(sheet, rowIndex, columnIndex) {
    const cell = Array.isArray(sheet)
      ? (sheet[rowIndex] && sheet[rowIndex][columnIndex])
      : sheet[XLSX.utils.encode_cell({r:rowIndex, c:columnIndex})];
    return cell ? cell.v : '';
  }

  function createUploadSessionId() {
    if(window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID().replace(/-/g, '').toLowerCase();
    }
    const seed = String(Date.now()) + '|' + String(Math.random()) + '|' + String(performance.now());
    let out = '';
    for(let i = 0; i < seed.length; i++) {
      out += (seed.charCodeAt(i) % 16).toString(16);
    }
    return (out + '00000000000000000000000000000000').slice(0, 32);
  }

  function csvUploadField(value) {
    const text = String(value == null ? '' : value);
    // ใส่ quote เฉพาะค่าที่จำเป็น เพื่อลดขนาดข้อมูล แต่ยังรักษา comma/quote/newline ได้ครบ
    return /[",\r\n]/.test(text)
      ? `"${text.replace(/"/g, '""')}"`
      : text;
  }

  function uploadRowToCsvLine(row) {
    return row.map(csvUploadField).join(',');
  }

  function splitUploadRowsAsCsv(rows) {
    const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const chunks = [];
    let lines = [];
    let currentBytes = 0;

    function byteLength(text) {
      return encoder ? encoder.encode(text).length : text.length * 3;
    }

    function flushChunk() {
      if(!lines.length) return;
      const csv = lines.join('\n');
      chunks.push({ csv, rowCount: lines.length, csvBytes: currentBytes });
      lines = [];
      currentBytes = 0;
    }

    rows.forEach(row => {
      const line = uploadRowToCsvLine(row);
      const rowBytes = byteLength(line) + 1;
      if(lines.length &&
          (currentBytes + rowBytes > UPLOAD_CHUNK_TARGET_BYTES || lines.length >= UPLOAD_CHUNK_MAX_ROWS)) {
        flushChunk();
      }
      lines.push(line);
      currentBytes += rowBytes;
    });
    flushChunk();
    return chunks;
  }

  async function postUploadWithRetry(payload, phaseLabel) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 300000);
      try {
        if(attempt > 0) {
          statusText.textContent =
            `🔁 ${phaseLabel || 'การส่งข้อมูล'} ตอบกลับขาดช่วง กำลังส่งซ้ำอย่างปลอดภัย (${attempt + 1}/3)...`;
          await sleep(1500 * attempt);
        }
        const res = await fetch(DATA_URL, {
          method:'POST',
          headers:{'Content-Type':'text/plain;charset=utf-8'},
          body:payload,
          cache:'no-store',
          credentials:'omit',
          signal:controller.signal
        });
        const responseText = await res.text();
        let json = null;
        try {
          json = JSON.parse(responseText);
        } catch(_) {
          const excerpt = responseText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
          const parseError = new Error(
            `Apps Script ตอบกลับไม่ใช่ JSON${excerpt ? `: ${excerpt}` : ''}`
          );
          parseError.code = 'INVALID_SERVER_RESPONSE';
          parseError.httpStatus = res.status;
          throw parseError;
        }
        if(!res.ok) {
          const httpError = new Error(
            `[HTTP_${res.status}] ${json.message || 'Apps Script ตอบกลับด้วยสถานะผิดพลาด'}`
          );
          httpError.code = json.code || `HTTP_${res.status}`;
          httpError.httpStatus = res.status;
          throw httpError;
        }
        if(json.status !== 'success') {
          const examples = json.details && Array.isArray(json.details.errors)
            ? json.details.errors.slice(0, 5).map(e => `แถว ${e.row}: ${e.message}`).join(', ')
            : '';
          const missing = json.details && Array.isArray(json.details.missingChunks)
            ? ` — ขาดชุด ${json.details.missingChunks.join(', ')}`
            : '';
          const code = String(json.code || 'UPLOAD_FAILED');
          const backendError = new Error(
            `[${code}] ${json.message || 'เกิดข้อผิดพลาดในการนำเข้า BigQuery'}` +
            (examples ? ` — ${examples}` : '') + missing
          );
          backendError.code = code;
          throw backendError;
        }
        return json;
      } catch(err) {
        lastError = err;
        const status = Number(err && err.httpStatus || 0);
        const code = String(err && err.code || '');
        const retryable = err && (
          err.name === 'AbortError' || status === 404 || status === 408 || status === 429 || status >= 500 ||
          ['UPLOAD_BUSY','QUERY_TIMEOUT','QUERY_FAILED','LOAD_TIMEOUT','LOAD_JOB_FAILED',
            'CHUNK_VERIFY_FAILED','MISSING_CHUNKS','MERGE_RESULT_MISSING',
            'CHUNK_MANIFEST_WRITE_FAILED','RECEIPT_PERSIST_FAILED','INVALID_SERVER_RESPONSE'].includes(code) ||
          /Failed to fetch|NetworkError/i.test(err.message || '')
        );
        if(!retryable || attempt === 2) break;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError || new Error('ไม่สามารถส่งข้อมูลเข้า BigQuery ได้');
  }

  async function refreshDashboardAfterUpload() {
    statusText.textContent = '🔄 BigQuery บันทึกสำเร็จแล้ว กำลังอัปเดตหน้าเว็บหนึ่งครั้ง...';
    // A GET that started before the MERGE may still be in flight. Wait for it,
    // then force one new request so the upload result cannot be hidden by that response.
    const pendingLoad = activeLoadPromise;
    if(pendingLoad) {
      try { await pendingLoad; } catch(_) {}
    }
    const result = await loadData(true);
    return !!(result && result.ok && result.rows > 0);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function showUploadSuccessModal(data) {
    const modal = document.getElementById('uploadSuccessModal');
    if(!modal) return;
    const timeEl = document.getElementById('succModalTime');
    const fileEl = document.getElementById('succModalFilename');
    const rowsEl = document.getElementById('succModalTotalRows');
    const insEl = document.getElementById('succModalInserted');
    const updEl = document.getElementById('succModalUpdated');
    const uncEl = document.getElementById('succModalUnchanged');

    if(timeEl) timeEl.textContent = data.completionTime || '-';
    if(fileEl) fileEl.textContent = data.filename || '-';
    if(rowsEl) rowsEl.textContent = (data.totalRows || 0).toLocaleString() + ' แถว';
    if(insEl) insEl.textContent = (data.inserted || 0).toLocaleString() + ' แถว';
    if(updEl) updEl.textContent = (data.updated || 0).toLocaleString() + ' แถว';
    if(uncEl) uncEl.textContent = (data.unchanged || 0).toLocaleString() + ' แถว';

    modal.style.display = 'flex';
  }

  function closeUploadSuccessModal() {
    const modal = document.getElementById('uploadSuccessModal');
    if(modal) modal.style.display = 'none';
  }

  const btnCloseSucc = document.getElementById('btnCloseUploadSuccess');
  if(btnCloseSucc) btnCloseSucc.onclick = closeUploadSuccessModal;
  const succModal = document.getElementById('uploadSuccessModal');
  if(succModal) {
    succModal.onclick = (e) => {
      if(e.target === succModal) closeUploadSuccessModal();
    };
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    })[char]);
  }

  // แปลง Date cell จาก Excel เป็น "DD/MM/YYYY HH:mm"
  // รองรับ: JS Date object, Excel serial number (ตัวเลข), หรือ string เดิม
  // *** ใช้ getUTC* เสมอ เพราะ XLSX.js สร้าง Date จาก UTC ที่ตรงกับเวลาในไฟล์ Excel ***
  function fmtExcelDate(v) {
    if (v == null || v === '') return '';

    // Case 1: JS Date instance (CellDates: true in XLSX)
    if (v instanceof Date) {
      const dd = String(v.getUTCDate()).padStart(2, '0');
      const mm = String(v.getUTCMonth() + 1).padStart(2, '0');
      const hh = String(v.getUTCHours()).padStart(2, '0');
      const mi = String(v.getUTCMinutes()).padStart(2, '0');
      return `${dd}/${mm}/${v.getUTCFullYear()} ${hh}:${mi}`;
    }

    // Case 2: Excel serial date number
    if (typeof v === 'number' && v > 1000) {
      const epoch = Math.round((v - 25569) * 86400 * 1000);
      const d = new Date(epoch);
      if (!isNaN(d.getTime())) {
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mi = String(d.getUTCMinutes()).padStart(2, '0');
        return `${dd}/${mm}/${d.getUTCFullYear()} ${hh}:${mi}`;
      }
    }

    let s = String(v).trim();
    if (!s) return '';

    // Case 3: Already DD/MM/YYYY HH:mm or DD/MM/YYYY HH:mm:ss (e.g. "23/07/2026 16:21")
    const dmyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (dmyMatch) {
      const dd = String(dmyMatch[1]).padStart(2, '0');
      const mm = String(dmyMatch[2]).padStart(2, '0');
      const yyyy = dmyMatch[3];
      const hh = String(dmyMatch[4]).padStart(2, '0');
      const mi = dmyMatch[5];
      return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
    }

    // Case 4: US Date Format M/D/YY h:mm AM/PM (e.g. "7/19/26 8:09 AM" or "7/19/2026 08:09 AM")
    const usMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)?$/i);
    if (usMatch) {
      const month = parseInt(usMatch[1], 10);
      const day = parseInt(usMatch[2], 10);
      let year = parseInt(usMatch[3], 10);
      if (year < 100) year += 2000;
      let hour = parseInt(usMatch[4], 10);
      const min = String(usMatch[5]).padStart(2, '0');
      const ampm = usMatch[6] ? usMatch[6].toUpperCase() : '';

      if (ampm === 'PM' && hour < 12) hour += 12;
      if (ampm === 'AM' && hour === 12) hour = 0;

      const dd = String(day).padStart(2, '0');
      const mm = String(month).padStart(2, '0');
      const hh = String(hour).padStart(2, '0');
      return `${dd}/${mm}/${year} ${hh}:${min}`;
    }

    // Case 5: ISO YYYY-MM-DD HH:mm:ss
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (isoMatch) {
      return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]} ${isoMatch[4]}:${isoMatch[5]}`;
    }

    return s;
  }

  function parsePickRowsFromWorksheet(sheet, headerRowIndex, lastRowIndex) {
    if (!sheet || lastRowIndex < headerRowIndex + 2) return [];
    const parsedRows = [];
    const relevant = REQUIRED_HEADERS.map(header => header.index);
    for (let rowIndex = headerRowIndex + 2; rowIndex <= lastRowIndex; rowIndex++) {
      // อ่านเฉพาะ 11 คอลัมน์ที่ระบบใช้จริง ไม่สร้าง array ครบทุกคอลัมน์/ทุกแถว
      const values = {};
      relevant.forEach(columnIndex => {
        values[columnIndex] = readWorksheetCellValue(sheet, rowIndex, columnIndex);
      });
      if(relevant.every(index => values[index] == null || String(values[index]).trim() === '')) continue;
      parsedRows.push([
        values[1] != null ? String(values[1]).trim() : '',
        values[12] != null ? String(values[12]).trim() : '',
        numericValue(values[28]),
        values[31] != null ? String(values[31]).trim() : '',
        values[36] != null ? String(values[36]).trim() : '',
        numericValue(values[40]),
        values[55] != null ? String(values[55]).trim().toUpperCase() : '',
        String(values[56] || values[58] || '').trim(),
        values[64] != null ? String(values[64]).trim() : '',
        fmtExcelDate(values[66]),
        rowIndex + 1
      ]);
    }
    return parsedRows;
  }

  function numericValue(value) {
    if(value == null || String(value).trim() === '') return '';
    const parsed = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(parsed) ? parsed : String(value).trim();
  }

  function validateRowsBeforeUpload(rows) {
    const errors = [];
    const seen = new Map();
    for(let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const sourceRow = Number(row[10]) || i + 3;
      const key = String(row[0] || '').trim();
      const qty = Number(row[2]);
      const sku = String(row[3] || '').trim();
      const uomQty = Number(row[5]);
      const category = String(row[6] || '').trim().toUpperCase();
      const picker = String(row[7] || '').trim();
      const location = String(row[8] || '').trim();
      const timestamp = String(row[9] || '').trim();
      const issues = [];
      if(!key) issues.push('ไม่มี Pick Detail #');
      if(!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) issues.push('QTY ไม่ถูกต้อง');
      if(!sku) issues.push('ไม่มี SKU');
      if(!Number.isFinite(uomQty) || uomQty <= 0) issues.push('UOMQTY ไม่ถูกต้อง');
      if(category !== 'PTT' && category !== 'BPS') issues.push('Category ไม่ใช่ PTT/BPS');
      if(!picker) issues.push('ไม่มี Picker');
      if(!location) issues.push('ไม่มี Location');
      if(!/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(timestamp)) issues.push('วันที่/เวลาไม่ถูกต้อง');
      if(issues.length) errors.push(`แถว ${sourceRow}: ${issues.join('/')}`);

      if(key) {
        const fingerprint = JSON.stringify(row.slice(1, 10));
        if(seen.has(key) && seen.get(key) !== fingerprint) {
          errors.push(`แถว ${sourceRow}: Pick Detail # ${key} ซ้ำแต่ข้อมูลไม่เหมือนกัน`);
        } else if(!seen.has(key)) {
          seen.set(key, fingerprint);
        }
      }
      if(errors.length >= 100) break;
    }
    return errors;
  }
})();

// ===== Target Settings Modal Functions =====
function openTargetSettingsModal() {
  const modal = document.getElementById('targetSettingsModal');
  if (!modal) return;
  
  const inOverall = document.getElementById('targetInputOverall');
  const inFull = document.getElementById('targetInputFullRack');
  const inHalf = document.getElementById('targetInputHalfRack');
  const inMicro = document.getElementById('targetInputMicroRack');
  const inPts = document.getElementById('targetInputPickToSort');
  const inMezz = document.getElementById('targetInputMezzanine');
  const inTrain = document.getElementById('targetInputTraining');

  if(inOverall) inOverall.value = prodTargets.overall || 170;
  if(inFull) inFull.value = prodTargets.fullRack || 170;
  if(inHalf) inHalf.value = prodTargets.halfRack || 200;
  if(inMicro) inMicro.value = prodTargets.microRack || 170;
  if(inPts) inPts.value = prodTargets.pickToSort || 170;
  if(inMezz) inMezz.value = prodTargets.mezzanine || 170;
  if(inTrain) inTrain.value = prodTargets.training || 100;

  modal.style.display = 'flex';
}

function closeTargetSettingsModal() {
  const modal = document.getElementById('targetSettingsModal');
  if (modal) modal.style.display = 'none';
}

function saveTargetSettingsFromModal() {
  const inOverall = Number(document.getElementById('targetInputOverall')?.value);
  const inFull = Number(document.getElementById('targetInputFullRack')?.value);
  const inHalf = Number(document.getElementById('targetInputHalfRack')?.value);
  const inMicro = Number(document.getElementById('targetInputMicroRack')?.value);
  const inPts = Number(document.getElementById('targetInputPickToSort')?.value);
  const inMezz = Number(document.getElementById('targetInputMezzanine')?.value);
  const inTrain = Number(document.getElementById('targetInputTraining')?.value);

  const updated = {
    overall: Number.isFinite(inOverall) && inOverall > 0 ? inOverall : DEFAULT_PROD_TARGETS.overall,
    fullRack: Number.isFinite(inFull) && inFull > 0 ? inFull : DEFAULT_PROD_TARGETS.fullRack,
    halfRack: Number.isFinite(inHalf) && inHalf > 0 ? inHalf : DEFAULT_PROD_TARGETS.halfRack,
    microRack: Number.isFinite(inMicro) && inMicro > 0 ? inMicro : DEFAULT_PROD_TARGETS.microRack,
    pickToSort: Number.isFinite(inPts) && inPts > 0 ? inPts : DEFAULT_PROD_TARGETS.pickToSort,
    mezzanine: Number.isFinite(inMezz) && inMezz > 0 ? inMezz : DEFAULT_PROD_TARGETS.mezzanine,
    training: Number.isFinite(inTrain) && inTrain > 0 ? inTrain : DEFAULT_PROD_TARGETS.training
  };

  saveProdTargetsToStorage(updated);
  closeTargetSettingsModal();
  render();
}

function resetTargetSettingsDefaults() {
  saveProdTargetsToStorage(DEFAULT_PROD_TARGETS);
  openTargetSettingsModal();
  render();
}

// Bind modal events
(function initTargetModalEvents(){
  const bind = () => {
    const btnClose = document.getElementById('btnCloseTargetSettings');
    const btnSave = document.getElementById('btnSaveTargetSettings');
    const btnReset = document.getElementById('btnResetTargetDefaults');
    const modal = document.getElementById('targetSettingsModal');

    if(btnClose) btnClose.onclick = closeTargetSettingsModal;
    if(btnSave) btnSave.onclick = saveTargetSettingsFromModal;
    if(btnReset) btnReset.onclick = resetTargetSettingsDefaults;
    if(modal) {
      modal.onclick = (e) => {
        if(e.target === modal) closeTargetSettingsModal();
      };
    }
  };
  if(document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
