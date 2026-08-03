/* Pick Productivity Dashboard — ดึงข้อมูลสดจาก BigQuery (ผ่าน Apps Script Web App)
   Productivity คิดจาก "ชั่วโมงกะ (ปกติ) + OT" ไม่ใช่ช่วงหยิบชิ้นแรก–สุดท้าย
   กะเช้า 07:00–16:00 (OT 16:30–19:00) · กะดึก 19:00–04:00 (OT 04:30–07:00)
   แยก 2 ระบบ PTT / BPS · ทุก KPI/กราฟคำนวณสดตามช่วงวันที่ + กะ ที่เลือก */

// ====== ตั้งค่า: วาง URL ของ Apps Script Web App (ลงท้าย /exec) ตรงนี้ ======
const DATA_URL = 'https://script.google.com/macros/s/AKfycbyM0IVjD6Eo867rWbR_WjLlJJPSXLCqCqEpPZkfFGnlkqVOr8yY-LR7f6Bl4HRwzBy0/exec';
// v5 sends pre-aggregated BigQuery cubes. Do not accept an older payload:
// its pick_qty may have the retired Pack Size semantics or row-level format.
const DASHBOARD_SCHEMA_VERSION = 'pick-units-v5-cubes';
const PICKER_NAME_FALLBACK = (typeof window !== 'undefined' && window.PICKER_NAME_FALLBACK) ? window.PICKER_NAME_FALLBACK : {};
const PICKER_AFFILIATION_FALLBACK = (typeof window !== 'undefined' && window.PICKER_AFFILIATION_FALLBACK) ? window.PICKER_AFFILIATION_FALLBACK : {};
const ZONE_MASTER_FALLBACK = (typeof window !== 'undefined' && window.ZONE_MASTER_FALLBACK) ? window.ZONE_MASTER_FALLBACK : {};
const ZONE_LAYOUT_CONFIG = (typeof window !== 'undefined' && window.ZONE_LAYOUT) ? window.ZONE_LAYOUT : {};
// ==========================================================================

// ====== ตั้งค่ากะ/OT (ปรับได้) ======
const REG_HOURS = 9;     // ชั่วโมงทำงานปกติต่อกะ (07:00–16:00 / 19:00–04:00). ถ้าหักพักเที่ยงให้ใช้ 8
const OT_MAX    = 2.5;   // OT สูงสุดต่อกะ (ชม.)
const MIN_PRODUCTIVE_HOURS = 3; // งานต่ำกว่านี้ไม่นับใน Productivity
// OT นับเป็นบล็อกละ 30 นาทีที่ทำครบ เริ่มนับจาก 16:30 (เช้า) / 04:30 (ดึก)
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
const TITLES = {overview:'ภาพรวม',prod:'Productivity',zones:'โซน & ผังคลัง',typebreak:'Activity by Type Pick',pickers:'พนักงาน (Picker)',time:'ช่วงเวลา',items:'สินค้า (Items)'};
const SHIFT_LABEL = {morning:'🌅 เช้า', night:'🌙 ดึก', '-':'-'};

Chart.register(ChartDataLabels);
Chart.defaults.font.family = "'Prompt',sans-serif";
Chart.defaults.color = '#64748b';

// ===== state =====
const emptyData = () => ({
  meta:{schema_version:DASHBOARD_SCHEMA_VERSION},
  PTT:{row_width:9,item_row_width:7,slot_row_width:8,dates:[],pickers:[],skus:[],rows:[],item_rows:[],slot_rows:[]},
  BPS:{row_width:9,item_row_width:7,slot_row_width:8,dates:[],pickers:[],skus:[],rows:[],item_rows:[],slot_rows:[]}
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
const DASHBOARD_TIMEOUT_MS = 180000;
const EXCLUDED_SKUS_STORAGE_KEY = 'pick_dashboard_excluded_skus_v1';
const DASHBOARD_CACHE_DB = 'pick_dashboard_cache_v1';
const DASHBOARD_CACHE_STORE = 'responses';
// แยก cache ออกจากข้อมูลรุ่นที่เคยคำนวณ Pack Size ใน browser เพื่อไม่ให้ใช้ยอดเก่า
const DASHBOARD_CACHE_KEY = DASHBOARD_SCHEMA_VERSION + ':bq-pick-qty:latest';
// แสดงข้อมูลที่เคยโหลดสำเร็จก่อนทันที แล้วตรวจ revision เบื้องหลัง
// เก็บได้นานขึ้นเพื่อไม่ให้ผู้ใช้เจอหน้าว่างเพียงเพราะไม่ได้เปิดเว็บเกิน 1 วัน
const DASHBOARD_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeSkuKey(sku){
  const value = String(sku ?? '').replace(/\u00a0/g, ' ').trim();
  // BigQuery/CSV บางชุดส่งรหัส SKU เป็นตัวเลขแบบ 123.0 แต่ในรายการยกเว้นเก็บเป็น 123
  return /^\d+\.0+$/.test(value) ? value.slice(0, value.indexOf('.')) : value;
}

function skuKeyVariants(sku){
  const key = normalizeSkuKey(sku);
  if(!key) return [];
  const keys = new Set([key]);
  // รองรับรหัสเดียวกันที่ฝั่งหนึ่งมีเลข 0 นำหน้า และอีกฝั่งไม่มี
  if(/^\d+$/.test(key)) keys.add(key.replace(/^0+(?=\d)/, ''));
  // รองรับกรณีที่ตัวเลขจาก BigQuery ถูกส่งมาในรูป scientific notation
  if(/^\d+(?:\.\d+)?e[+-]?\d+$/i.test(key)){
    const numeric = Number(key);
    if(Number.isSafeInteger(numeric)) keys.add(String(numeric));
  }
  return [...keys];
}

function isSkuExcluded(sku){
  if(excludedSkus.size === 0) return false;
  return skuKeyVariants(sku).some(key => excludedSkus.has(key));
}

function currentExcludedSkuList(){
  return [...excludedSkus].map(normalizeSkuKey).filter(Boolean).sort();
}

function dashboardScopeQuery(){
  return 'excluded_skus=' + encodeURIComponent(JSON.stringify(currentExcludedSkuList()));
}

function formatThaiDateTime(value){
  if(!value) return '';
  const dt = new Date(value);
  if(Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleString('th-TH', {dateStyle:'short', timeStyle:'short'});
}

function loadExcludedSkusFromStorage(){
  try{
    const raw = localStorage.getItem(EXCLUDED_SKUS_STORAGE_KEY);
    if(!raw){
      excludedSkus = new Set();
      excludedSkusSavedAt = null;
      return;
    }
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.skus) ? parsed.skus : []);
    excludedSkus = new Set(list.map(normalizeSkuKey).filter(Boolean));
    excludedSkusSavedAt = parsed && parsed.updatedAt ? parsed.updatedAt : null;
  }catch(_){
    excludedSkus = new Set();
    excludedSkusSavedAt = null;
  }
}

function saveExcludedSkusToStorage(){
  try{
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      skus: [...excludedSkus].map(normalizeSkuKey).filter(Boolean).sort()
    };
    localStorage.setItem(EXCLUDED_SKUS_STORAGE_KEY, JSON.stringify(payload));
    excludedSkusSavedAt = payload.updatedAt;
  }catch(_){}
}

// ===== Productivity Target State & Functions =====
let prodTarget = 10;
const PROD_TARGET_STORAGE_KEY = 'pick_dashboard_prod_target_v1';

function loadProdTargetFromStorage(){
  try {
    const saved = localStorage.getItem(PROD_TARGET_STORAGE_KEY);
    if (saved !== null) {
      const val = Number(saved);
      if (Number.isFinite(val) && val > 0) prodTarget = val;
    }
  } catch(e){}
}

function saveProdTargetToStorage(val){
  try {
    prodTarget = val;
    localStorage.setItem(PROD_TARGET_STORAGE_KEY, String(val));
  } catch(e){}
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
  if(t >= 420 && t < 1140) return {sh:'morning', sd:ds,            sm:t-420};   // 07:00–18:59 -> กะเช้า
  if(t >= 1140)            return {sh:'night',   sd:ds,            sm:t-1140};  // 19:00–23:59 -> กะดึก (วันนี้)
  return                          {sh:'night',   sd:addDays(ds,-1), sm:t+300};  // 00:00–06:59 -> กะดึกของ "คืนก่อน"
}
// OT = จำนวนบล็อก 30 นาทีที่ทำครบ นับจากนาทีที่ 570 (16:30/04:30) ต้นกะ, สูงสุด OT_MAX
function otHours(maxSm){ if(maxSm <= 570) return 0; return Math.min(OT_MAX, Math.floor((maxSm - 570)/30) * 0.5); }

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
  if(Number(S && S.item_row_width) !== 7) throw new Error('Dashboard item cube ไม่ตรงกับหน้าเว็บ');
  const o = i * 7;
  return {
    dateIdx:S.item_rows[o], shiftCode:Number(S.item_rows[o+1])||0,
    zone:S.item_rows[o+2], skuIdx:S.item_rows[o+3],
    pcs:Number(S.item_rows[o+4])||0, pickQty:readBigQueryPickQty(S.item_rows[o+5]),
    lines:Number(S.item_rows[o+6])||0
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
      const sh = Number(S.rows[offset + 1]) === 1 ? 'night' : 'morning';
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

function getItemInfo(sku) {
  if (!sku) return { sku: '', name: '-', owner: '-' };
  const s = String(sku).trim();
  let m = (typeof ITEM_MASTER !== 'undefined' && ITEM_MASTER) ? ITEM_MASTER[s] : null;

  if (!m && typeof ITEM_MASTER !== 'undefined' && ITEM_MASTER) {
    const sNoZero = s.replace(/^0+/, '');
    m = ITEM_MASTER[sNoZero];
  }

  return {
    sku: s,
    name: m ? (m.name || s) : s,
    owner: m ? (m.owner || '-') : '-'
  };
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

    // SKU มาจาก Item cube เพื่อไม่ให้ Work cube ต้องแบกมิติ SKU หลายแสนแถว
    const itemCount = packedItemRowCount(S);
    for(let i=0;i<itemCount;i++){
      const row = packedItemRowData(S, i);
      const sd = S.dates[row.dateIdx];
      const sh = row.shiftCode === 1 ? 'night' : 'morning';
      if(sd < dfrom || sd > dto || (shiftF !== 'all' && sh !== shiftF)) continue;
      const zInfo = getZoneInfo(row.zone);
      const zCode = zInfo.zone || zInfo.location || String(row.zone || '-').trim().toUpperCase();
      const rawLocStr = String(row.zone || '-').trim().toUpperCase();
      if(zCode !== zoneCode && zInfo.location !== zoneCode && rawLocStr !== zoneCode) continue;
      const sku = S.skus[row.skuIdx];
      if(isSkuExcluded(sku)) continue;
      const itemInfo = getItemInfo(sku);
      const skuRec = uniqueSkus.get(sku) || {
        sku, name:itemInfo.name || sku, owner:itemInfo.owner || zInfo.owner || '-', qty:0, pcs:0, lines:0
      };
      skuRec.qty += row.pickQty;
      skuRec.pcs += row.pcs;
      skuRec.lines += row.lines;
      uniqueSkus.set(sku, skuRec);
    }

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
        bodyHtml += `<tr><td colspan="7" class="empty-cell" style="text-align:center; padding:16px; color:#94a3b8;">ไม่มีรายการสินค้าใน Zone นี้ช่วงวันที่เลือก</td></tr>`;
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
    `<div class="zone-breakdown-foot">Productivity ใช้เฉพาะกลุ่มที่มีเวลาทำงานตั้งแต่ ${MIN_PRODUCTIVE_HOURS} ชั่วโมงขึ้นไป · จำนวนชิ้น/หน่วยหยิบรวมยังแสดงยอดทั้งหมดของช่วงที่เลือก</div>`;
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
  <div class="zone-breakdown-foot">สังกัดจับจากรหัสพนักงานใน Sheet “บันทึกเวลาทำงาน” · OT ใช้กติกาเดียวกับหน้า Productivity และ Productivity จะไม่นับกลุ่มที่ทำงานต่ำกว่า ${MIN_PRODUCTIVE_HOURS} ชั่วโมง</div>`;
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

  // Item cube มี SKU ครบทั้งหมดเพื่อให้รายการยกเว้นยังแสดงและนำกลับมาคำนวณได้
  const itemRowCount = packedItemRowCount(S);
  for(let i=0;i<itemRowCount;i++){
    const r = packedItemRowData(S, i);
    const sd = S.dates[r.dateIdx];
    const sh = r.shiftCode === 1 ? 'night' : 'morning';
    if(sd < from || sd > to || (sf !== 'all' && sh !== sf)) continue;
    const zone = getZoneInfo(r.zone).zone;
    if(isZoneExcluded(zone)) continue;
    const sku = S.skus[r.skuIdx];
    const all = itemMapAll[sku] || (itemMapAll[sku] = {pcs:0,qty:0,lines:0});
    all.pcs += r.pcs; all.qty += r.pickQty; all.lines += r.lines;
    if(isSkuExcluded(sku)) continue;
    const item = itemMap[sku] || (itemMap[sku] = {pcs:0,qty:0,lines:0});
    item.pcs += r.pcs; item.qty += r.pickQty; item.lines += r.lines;
  }

  // Time-slot cube เก็บชั่วโมงแยกตาม Picker/Zone โดยตัด SKU ที่ยกเว้นจาก BigQuery แล้ว
  const slotRowCount = packedSlotRowCount(S);
  for(let i=0;i<slotRowCount;i++){
    const r = packedSlotRowData(S, i);
    const sd = S.dates[r.dateIdx];
    const sh = r.shiftCode === 1 ? 'night' : 'morning';
    if(sd < from || sd > to || (sf !== 'all' && sh !== sf)) continue;
    const zone = getZoneInfo(r.zone).zone;
    if(isZoneExcluded(zone)) continue;
    const hr = r.hour;
    const slot = slotMap[hr] || (slotMap[hr] = {pcs:0,qty:0,lines:0});
    slot.pcs += r.pcs; slot.qty += r.pickQty; slot.lines += r.lines;

    const picker = S.pickers[r.pickerIdx];
    const pDrill = pickerDrilldownMap[picker];
    const dRec = pDrill && pDrill.byDate[sd];
    if(dRec){
      const dSlot = dRec.slots[hr] || (dRec.slots[hr] = {pcs:0,qty:0,lines:0});
      dSlot.pcs += r.pcs; dSlot.qty += r.pickQty; dSlot.lines += r.lines;
    }
  }

  function applyProductivityHours(g){
    g.ot = otHours(g.mx);
    if(g.n <= 0 || g.mn < 0 || g.mn > g.mx){
      g.wh = 0;
    }else{
      let spanMin = g.mx - g.mn;
      let wh = spanMin / 60.0;
      if(wh >= 8.5 && wh <= 9.5 && g.mx <= 570){
        wh = 9.0;
      }
      wh = Math.round(wh * 100) / 100;
      g.wh = Math.max(wh, 0.1);
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

  function getItemInfo(sku) {
    if (!sku) return { sku: '', name: '-', owner: '-' };
    const s = String(sku).trim();
    let m = (typeof ITEM_MASTER !== 'undefined' && ITEM_MASTER) ? ITEM_MASTER[s] : null;

    if (!m && typeof ITEM_MASTER !== 'undefined' && ITEM_MASTER) {
      const sNoZero = s.replace(/^0+/, '');
      m = ITEM_MASTER[sNoZero];
    }

    return {
      sku: s,
      name: m ? (m.name || s) : s,
      owner: m ? (m.owner || '-') : '-'
    };
  }

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
  const by_item = Object.entries(itemMap).map(([sku,v])=>{
    const info = getItemInfo(sku);
    return { sku, name: info.name, owner: info.owner, pcs: v.pcs, qty: v.qty, lines: v.lines };
  }).sort((a,b)=>b.qty-a.qty);
  const by_item_all = Object.entries(itemMapAll).map(([sku,v])=>{
    const info = getItemInfo(sku);
    return { sku, name: info.name, owner: info.owner, pcs: v.pcs, qty: v.qty, lines: v.lines, excluded: isSkuExcluded(sku) };
  }).sort((a,b)=>b.qty-a.qty);

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
  st.textContent = '.sysbar{display:flex;align-items:center;gap:12px 16px;margin:-6px 0 20px;flex-wrap:wrap}.sysbar .lab{font-size:13px;color:#64748b;font-weight:500}.systog{display:inline-flex;background:#eef2ff;border-radius:12px;padding:4px}.systog button{border:0;background:transparent;font-family:inherit;font-size:13px;font-weight:600;color:#64748b;padding:9px 16px;border-radius:9px;cursor:pointer;transition:.2s}.systog button.active{color:#fff;box-shadow:0 6px 14px -6px rgba(14,165,233,.6)}.systog button.active[data-sys="PTT"]{background:linear-gradient(90deg,#0ea5e9,#6366f1)}.systog button.active[data-sys="BPS"]{background:linear-gradient(90deg,#f59e0b,#f97316)}.shiftog button.active{background:linear-gradient(90deg,#8b5cf6,#6366f1)}.unittog button.active{background:linear-gradient(90deg,#14b8a6,#0ea5e9);color:#fff;box-shadow:0 6px 14px -6px rgba(20,184,166,.6)}'
    + '.datebar{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:6px 10px;box-shadow:0 8px 20px -16px rgba(30,41,59,.4)}.datebar input[type=date]{font-family:inherit;font-size:13px;color:#1e293b;border:1px solid #e2e8f0;border-radius:8px;padding:6px 8px;background:#f8fafc}.datebar input[type=date]:focus{outline:0;border-color:#6366f1}.datebar .sep{color:#94a3b8;font-size:13px}'
    + '.datepreset{display:inline-flex;gap:6px;flex-wrap:wrap}.datepreset button{border:1px solid #e2e8f0;background:#fff;font-family:inherit;font-size:12.5px;font-weight:500;color:#475569;padding:7px 12px;border-radius:9px;cursor:pointer;transition:.18s}.datepreset button:hover{border-color:#6366f1;color:#4338ca}.datepreset button.active{background:linear-gradient(90deg,#6366f1,#8b5cf6);border-color:transparent;color:#fff}.datepreset button[data-range]{background:#f8fafc;color:#0f766e;border-color:#ccfbf1}.datepreset button[data-range].active{background:linear-gradient(90deg,#0d9488,#14b8a6);color:#fff}'
    + '.refreshbtn{display:inline-flex;align-items:center;gap:6px;border:1px solid #e2e8f0;background:#fff;font-family:inherit;font-size:12.5px;font-weight:600;color:#0e7490;padding:7px 12px;border-radius:9px;cursor:pointer;transition:.18s}.refreshbtn:hover{border-color:#14b8a6;background:#f0fdfa}.freshtxt{font-size:11.5px;color:#94a3b8}'
    + '#loadov{position:fixed;inset:0;background:#f8fafc;display:flex;align-items:center;justify-content:center;z-index:999}#loadov .sp{width:38px;height:38px;border:4px solid #e2e8f0;border-top-color:#6366f1;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}#loadov .msg{margin-left:14px;font-size:14px;color:#475569;font-weight:500}';
  document.head.appendChild(st);
}

function buildControls(){
  ensureStyles();
  const old = document.querySelector('.sysbar'); if(old) old.remove();
  const presetBtns = ALL_DATES.map(d=>`<button data-d="${d}">${d.slice(8)+'/'+d.slice(5,7)}</button>`).join('');
  const bar = document.createElement('div'); bar.className = 'sysbar';
  const targetUnitTxt = unitMode === 'pcs' ? 'ชิ้น/ชม.' : 'หยิบ/ชม.';
  bar.innerHTML =
    '<span class="lab">ระบบ:</span>'
    + '<div class="systog"><button data-sys="PTT">Pick (PTT)</button><button data-sys="BPS">Pick to Sort (BPS)</button></div>'
    + '<span class="lab">หน่วยที่แสดง:</span>'
    + '<div class="systog unittog"><button data-unit="units">📦 หน่วยหยิบ (Units)</button><button data-unit="pcs">🧩 จำนวนชิ้น (Pcs)</button></div>'
    + '<span class="lab">กะ:</span>'
    + '<div class="systog shiftog"><button data-sh="all">ทุกกะ</button><button data-sh="morning">🌅 เช้า</button><button data-sh="night">🌙 ดึก</button></div>'
    + '<span class="lab">🎯 เป้า Productivity:</span>'
    + `<div class="datebar" style="padding:4px 8px;"><input type="number" id="prodTargetInput" value="${prodTarget}" min="1" max="500" style="width:58px; font-weight:700; text-align:center;"><span style="font-size:11px; color:#64748b; font-weight:600; margin-left:4px;">${targetUnitTxt}</span></div>`
    + '<span class="lab">วันที่:</span>'
    + `<div class="datebar"><input type="date" id="dfrom" min="${DMIN}" max="${DMAX}" value="${dfrom}"><span class="sep">→</span><input type="date" id="dto" min="${DMIN}" max="${DMAX}" value="${dto}"></div>`
    + `<div class="datepreset"><button data-all="1">ทั้งหมด</button><button data-range="week">Weekly</button><button data-range="month">Monthly</button>${presetBtns}</div>`
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

  const btnPdf = bar.querySelector('#exportPdfBtn');
  if (btnPdf) {
    btnPdf.onclick = () => {
      exportPDF();
    };
  }

  bar.querySelectorAll('.systog:not(.shiftog):not(.unittog) button').forEach(b => { b.classList.toggle('active', b.dataset.sys===sys); b.onclick = () => {
    if(b.dataset.sys === sys) return; sys = b.dataset.sys;
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
  function setPresetActive(){
    bar.querySelectorAll('.datepreset button').forEach(x=>x.classList.remove('active'));
    if(datePresetMode === 'all'){ const a=bar.querySelector('.datepreset button[data-all]'); if(a) a.classList.add('active'); return; }
    if(datePresetMode === 'week' || datePresetMode === 'month'){
      const r=bar.querySelector(`.datepreset button[data-range="${datePresetMode}"]`);
      if(r) r.classList.add('active');
      return;
    }
    if(datePresetMode === 'day' && dfrom===dto){ const m=bar.querySelector(`.datepreset button[data-d="${dfrom}"]`); if(m) m.classList.add('active'); }
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
  if(width !== 7 || rows.length % width !== 0) throw new Error('รูปแบบรายการ SKU รายพนักงานไม่ถูกต้อง');
  for(let offset=0; offset<rows.length; offset+=width){
    const date = String(rows[offset] || '');
    const shift = Number(rows[offset + 1]) === 1 ? 'night' : 'morning';
    if(shiftF !== 'all' && shift !== shiftF) continue;
    const dRec = pData.byDate && pData.byDate[date];
    if(!dRec) continue;
    const zone = getZoneInfo(rows[offset + 2]).zone;
    if(isZoneExcluded(zone)) continue;
    const sku = normalizeSkuKey(rows[offset + 3]) || '(none)';
    if(isSkuExcluded(sku)) continue;
    const rec = dRec.skus[sku] || (dRec.skus[sku] = {pcs:0, qty:0, lines:0});
    rec.pcs += Number(rows[offset + 4]) || 0;
    rec.qty += Number(rows[offset + 5]) || 0;
    rec.lines += Number(rows[offset + 6]) || 0;
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
      const response = await fetch(DATA_URL + (DATA_URL.includes('?') ? '&' : '?') + query, {
        cache:'no-store', signal:controller.signal
      });
      if(!response.ok) throw new Error('HTTP ' + response.status);
      const payload = await response.json();
      if(payload && payload.error) throw new Error(payload.error);
      if(!payload || payload.schema_version !== DASHBOARD_SCHEMA_VERSION ||
          String(payload.picker || '') !== picker || String(payload.system || '') !== sys){
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
    Object.entries(dRec.skus || {}).forEach(([sku, v]) => {
      const kRec = activeSkusMap[sku] || (activeSkusMap[sku] = { pcs: 0, qty: 0, lines: 0 });
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
  activeSkusList.forEach((sku, idx) => {
    const kv = activeSkusMap[sku];
    const info = getItemInfo(sku);
    html += `
          <tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:7px 10px;"><span class="rank" style="font-size:11px; width:20px; height:20px;">${idx + 1}</span></td>
            <td style="padding:7px 10px; font-weight:700; color:#0f172a;">${escapeZoneHtml(sku)}</td>
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
    ['PTT', 'BPS'].forEach(sName => {
      const S = DATA[sName];
      if (!S || !Array.isArray(S.slot_rows)) return;
      const count = packedSlotRowCount(S);
      for (let i = 0; i < count; i++) {
        const row = packedSlotRowData(S, i);
        const sd = S.dates[row.dateIdx];
        const sh = row.shiftCode === 1 ? 'night' : 'morning';
        if (sd < dfrom || sd > dto || (shiftF !== 'all' && sh !== shiftF)) continue;
        if(isZoneExcluded(getZoneInfo(row.zone).zone)) continue;
        const hr = row.hour;
        const val = isPcs ? row.pcs : row.pickQty;
        hourlyVol[hr] += val;
      }
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
          labels: ['☀️ กะวัน (07:00–16:00)', '🌙 กะดึก (19:00–04:00)'],
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
      const prodValue = isPcs ? (p.avg_pcs_prod || 0) : (p.avg_prod || 0);
      const pickerName = p.name || getPickerName(p.picker);
      const pickerNameText = pickerName && pickerName !== p.picker ? pickerName : '-';
      const isLow = prodValue < prodTarget;
      const prodBadge = isLow
        ? `<span style="background:#fee2e2; color:#991b1b; font-size:10px; padding:2px 6px; border-radius:4px; font-weight:700; margin-left:4px; white-space:nowrap;">⚠️ ต่ำกว่าเป้า</span>`
        : `<span style="background:#dcfce7; color:#15803d; font-size:10px; padding:2px 6px; border-radius:4px; font-weight:700; margin-left:4px; white-space:nowrap;">✓ ผ่าน</span>`;
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
    const t = A.by_timeslot;
    const isPcs = unitMode === 'pcs';
    const chartValues = isPcs ? t.map(x=>x.pcs) : t.map(x=>x.qty);
    const chartLabel = isPcs ? 'จำนวนชิ้น' : 'หน่วยหยิบ';
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
          (x.owner && x.owner.toLowerCase().includes(itemSearchTerm))
        );
      }

      // แสดง 35 รายการแรกที่ตรงกับคำค้นหา
      const displayItems = allItems.slice(0, 35);

      const pcsHeaderStyle = isPcs ? 'background:#e0f2fe;color:#0369a1;font-weight:700;' : '';
      const qtyHeaderStyle = !isPcs ? 'background:#e0e7ff;color:#3730a3;font-weight:700;' : '';

      let h = `<thead><tr><th>#</th><th>รหัส SKU</th><th>ชื่อสินค้า</th><th>Owner</th><th class="num" style="${pcsHeaderStyle}">จำนวนชิ้น (QTY เดิม) ${isPcs ? '★' : ''}</th><th class="num" style="${qtyHeaderStyle}">หน่วยหยิบ (BigQuery) ${!isPcs ? '★' : ''}</th><th style="text-align:center;">สถานะการคำนวณ</th></tr></thead><tbody>`;
      if (!displayItems.length) {
        h += '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:24px">ไม่พบสินค้าที่ตรงกับคำค้นหา</td></tr>';
      } else {
        displayItems.forEach((x, i) => {
          const isEx = isSkuExcluded(x.sku);
          const rowBg = isEx ? 'style="background:#fff7ed;"' : '';
          const nameStyle = isEx ? 'style="text-decoration:line-through;color:#94a3b8;"' : '';
          const statusBadge = isEx 
            ? '<span style="background:#fee2e2;color:#991b1b;padding:3px 9px;border-radius:6px;font-size:11.5px;font-weight:600;">🚫 ยกเว้นอยู่</span>'
            : '<span style="background:#dcfce7;color:#166534;padding:3px 9px;border-radius:6px;font-size:11.5px;font-weight:600;">✅ UOM จาก BigQuery</span>';

          const btnAction = isEx
            ? `<button onclick="toggleExcludeSku('${x.sku}')" style="border:0;background:#dcfce7;color:#15803d;padding:5px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;transition:.2s;">✅ นำกลับมาคำนวณ</button>`
            : `<button onclick="toggleExcludeSku('${x.sku}')" style="border:0;background:#fee2e2;color:#b91c1c;padding:5px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;transition:.2s;">🚫 ยกเว้นคำนวณ</button>`;

          const pcsCellStyle = isPcs ? 'font-weight:700;color:#0284c7;background:#f0f9ff;' : 'font-weight:600;color:#0f766e;';
          const qtyCellStyle = !isPcs ? 'font-weight:700;color:#4338ca;background:#eef2ff;' : 'font-weight:600;color:#4338ca;';

          h += `<tr ${rowBg}>
            <td><span class="rank">${i + 1}</span></td>
            <td><b>${x.sku}</b></td>
            <td ${nameStyle}>${x.name || '-'}</td>
            <td><span class="pill">${x.owner || '-'}</span></td>
            <td class="num" style="${isEx ? 'color:#94a3b8;' : pcsCellStyle}">${fmt(x.pcs)}</td>
            <td class="num" style="${isEx ? 'color:#94a3b8;' : qtyCellStyle}">${fmt(x.qty)}</td>
            <td style="text-align:center;display:flex;align-items:center;justify-content:center;gap:10px;">${statusBadge} ${btnAction}</td>
          </tr>`;
        });
      }
      h += '</tbody>';
      elTable.innerHTML = h;
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

window.toggleExcludeSku = function(sku) {
  const key = normalizeSkuKey(sku);
  const variants = skuKeyVariants(key);
  if (variants.some(k => excludedSkus.has(k))) {
    variants.forEach(k => excludedSkus.delete(k));
  } else if (key) {
    excludedSkus.add(key);
  }
  saveExcludedSkusToStorage();
  invalidateAggregationCache();
  dashboardCacheRevision = '';
  void loadData(false);
};

window.clearExcludedSkus = function() {
  excludedSkus.clear();
  saveExcludedSkusToStorage();
  invalidateAggregationCache();
  dashboardCacheRevision = '';
  void loadData(false);
};

function renderExcludedBadges() {
  const bar = document.getElementById('excludedBar');
  const badgeContainer = document.getElementById('excludedBadges');
  const countBadge = document.getElementById('excludedCountBadge');
  const savedAtBadge = document.getElementById('excludedSavedAt');
  const btnClear = document.getElementById('btnClearExcluded');

  if (btnClear && !btnClear._bound) {
    btnClear._bound = true;
    btnClear.addEventListener('click', clearExcludedSkus);
  }

  if (!bar || !badgeContainer || !countBadge) return;

  if (excludedSkus.size === 0) {
    bar.style.display = 'none';
    if (savedAtBadge) savedAtBadge.textContent = '';
    return;
  }

  bar.style.display = 'block';
  countBadge.textContent = excludedSkus.size.toLocaleString();
  if (savedAtBadge) {
    savedAtBadge.textContent = excludedSkusSavedAt
      ? `บันทึกล่าสุด: ${formatThaiDateTime(excludedSkusSavedAt)}`
      : 'รายการนี้จะถูกจำไว้ในเครื่องนี้อัตโนมัติ';
  }

  let h = '';
  excludedSkus.forEach(sku => {
    const info = (typeof ITEM_MASTER !== 'undefined' && ITEM_MASTER) ? ITEM_MASTER[sku] : null;
    const name = info ? (info.name || sku) : sku;
    const displayLabel = name.length > 28 ? name.slice(0, 26) + '…' : name;
    h += `<div style="display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid #fdba74;color:#c2410c;padding:5px 12px;border-radius:20px;font-size:12.5px;font-weight:500;box-shadow:0 2px 6px rgba(249,115,22,0.12);">
      <span><b>${sku}</b> · ${displayLabel}</span>
      <button onclick="toggleExcludeSku('${sku}')" style="border:0;background:#ffedd5;color:#c2410c;width:18px;height:18px;border-radius:50%;cursor:pointer;font-weight:700;font-size:11px;display:flex;align-items:center;justify-content:center;line-height:1;" title="นำกลับมาคำนวณ">✕</button>
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
    source && Number(source.row_width) === 9 && Number(source.item_row_width) === 7 && Number(source.slot_row_width) === 8 &&
    Array.isArray(source.dates) && Array.isArray(source.pickers) && Array.isArray(source.skus) &&
    Array.isArray(source.rows) && source.rows.length % 9 === 0 &&
    Array.isArray(source.item_rows) && source.item_rows.length % 7 === 0 &&
    Array.isArray(source.slot_rows) && source.slot_rows.length % 8 === 0;
  const validSchema = payload && payload.meta &&
    payload.meta.schema_version === DASHBOARD_SCHEMA_VERSION;
  const payloadExclusions = payload && payload.meta && Array.isArray(payload.meta.excluded_skus)
    ? payload.meta.excluded_skus.map(normalizeSkuKey).filter(Boolean).sort()
    : [];
  const validScope = JSON.stringify(payloadExclusions) === JSON.stringify(currentExcludedSkuList());
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

function applyDashboardPayload(payload, previous, source){
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
  hideDataState();
  setDashboardSourceBadge(totalRows, source);
  buildControls();
  render();
  return totalRows;
}

async function restoreDashboardFromCache(){
  const record = await readDashboardResponseCache();
  if(!record) return false;
  try{
    const payload = JSON.parse(record.body);
    const previous = {sys, shiftF, dfrom, dto, datePresetMode, trendMode};
    const rows = applyDashboardPayload(payload, previous, 'cache');
    if(rows <= 0) {
      void clearDashboardResponseCache();
      return false;
    }
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
  const response = await fetch(url, {cache:'no-store', signal});
  if(!response.ok) throw new Error('HTTP ' + response.status);
  const body = await response.text();
  const payload = JSON.parse(body);
  if(payload && payload.error) throw new Error(payload.error);
  if(payload && payload.meta && payload.PTT && payload.BPS) {
    // รองรับ Apps Script deployment รุ่นเดิมที่ยังไม่รู้จัก mode=revision
    return {payload, body};
  }
  if(!payload || payload.schema_version !== DASHBOARD_SCHEMA_VERSION || payload.revision == null) {
    throw new Error('Apps Script ตอบ revision ไม่ถูกต้อง');
  }
  return {revision:String(payload.revision)};
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

async function loadDataOnce(force){
  document.querySelectorAll('.nav[data-page]').forEach(n => n.onclick = () => show(n.dataset.page));
  const previous = {sys, shiftF, dfrom, dto, datePresetMode, trendMode};
  const hadLiveData = hasLiveData;
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

    if(!force && hadLiveData && dashboardCacheRevision) {
      const probe = await fetchRevisionOrDashboard(controller.signal);
      if(probe.revision != null) {
        if(probe.revision === dashboardCacheRevision) {
          const currentRows = dashboardPayloadRowCount(DATA);
          setDashboardSourceBadge(currentRows, 'live');
          return {ok:true, rows:currentRows, unchanged:true};
        }
      } else {
        j = probe.payload;
        body = probe.body;
      }
    }

    if(!j) {
      const url = DATA_URL + (DATA_URL.includes('?')?'&':'?') +
        'fresh=' + (force ? '1' : '0') + '&' + dashboardScopeQuery() + '&t=' + Date.now();
      const res = await fetch(url, {cache:'no-store', signal:controller.signal});
      if(!res.ok) throw new Error('HTTP ' + res.status);
      body = await res.text();
      try {
        j = JSON.parse(body);
      } catch(_) {
        if(body.includes('ไม่มีหน่วยความจำ')) {
          throw new Error('Apps Script มีหน่วยความจำไม่พอสำหรับข้อมูลชุดนี้');
        }
        throw new Error('Apps Script ตอบกลับมาไม่ใช่ข้อมูล JSON');
      }
    }
    if(j && j.error) throw new Error(j.error);
    const totalRows = dashboardPayloadRowCount(j);
    if(totalRows === 0){
      dashboardCacheRevision = '';
      await clearDashboardResponseCache();
      showDataState('empty', 'ไม่มีข้อมูลเก่าค้างอยู่แล้ว กรุณานำเข้าไฟล์ Pick Detail ชุดใหม่', j.meta);
      return {ok:true, rows:0};
    }

    applyDashboardPayload(j, previous, 'live');
    void writeDashboardResponseCache(body, j);
    return {ok:true, rows:totalRows};
  }catch(err){
    console.warn('ดึงข้อมูลสดไม่สำเร็จ:', err);
    const message = err && err.name === 'AbortError'
      ? 'BigQuery ใช้เวลาตอบกลับเกิน 3 นาที กรุณากดลองอีกครั้ง'
      : (err && err.message ? err.message : 'ระบบเชื่อมต่อ BigQuery ไม่สำเร็จ');
    if(hadLiveData){
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
  const MAX_UPLOAD_ROWS = 50000;
  const MAX_FILE_BYTES = 25 * 1024 * 1024;
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
      const hadDashboardBeforeUpload = hasLiveData;
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

        const payload = JSON.stringify({
          action: 'upload_rows',
          fmt: 'array',
          rows: rows,
          meta: parsed.meta
        });
        const sizeKB = Math.round(payload.length / 1024);
        statusText.textContent = `🚀 ตรวจผ่าน ${rows.length.toLocaleString()} แถว กำลังส่งเข้า BigQuery (~${sizeKB.toLocaleString()} KB)...`;
        progressBar.style.width = '55%';

        const json = await postUploadWithRetry(payload);
        const counts = json.counts || {};
        progressBar.style.width = '90%';
        statusText.textContent =
          `✅ BigQuery รับแล้ว ${Number(counts.staged || json.rowsProcessed || 0).toLocaleString()} แถว ` +
          `(เพิ่ม ${Number(counts.inserted || 0).toLocaleString()}, แก้ไข ${Number(counts.updated || 0).toLocaleString()}, ` +
          `มีอยู่แล้ว ${Number(counts.unchanged || 0).toLocaleString()}) กำลังตรวจหน้าเว็บ...`;

        const refreshPromise = refreshDashboardAfterUpload();
        progressBar.style.width = '100%';
        if(hadDashboardBeforeUpload) {
          setSideBadge(
            'นำเข้า BigQuery สำเร็จ ' +
            Number(counts.visible || json.rowsProcessed || 0).toLocaleString() +
            ' แถว\nกำลังอัปเดต Dashboard เบื้องหลัง…'
          );
          closeModal();
          void refreshPromise.then(refreshed => {
            if(!refreshed) {
              setSideBadge('ข้อมูลเข้า BigQuery แล้ว\nDashboard ยังตอบกลับไม่ทัน กรุณากดรีเฟรช');
            }
          });
          return;
        }

        const refreshed = await refreshPromise;
        if (refreshed) {
          statusText.textContent =
            `🎉 นำเข้าสำเร็จและหน้าเว็บอัปเดตแล้ว ` +
            `${Number(counts.visible || json.rowsProcessed || 0).toLocaleString()} แถว`;
          closeModal();
        } else {
          progressBar.style.background = '#f59e0b';
          statusText.textContent =
            '✅ ข้อมูลเข้า BigQuery สำเร็จแล้ว แต่หน้าเว็บยังตอบกลับไม่ทัน กรุณากด “ลองอีกครั้ง” บนหน้า Dashboard';
          selectedFile = null;
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

  async function postUploadWithRetry(payload) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 270000);
      try {
        if(attempt > 0) {
          statusText.textContent = '🔁 การตอบกลับขาดช่วง กำลังตรวจและส่งซ้ำอย่างปลอดภัย...';
          await sleep(2000);
        }
        const res = await fetch(DATA_URL, {
          method:'POST',
          headers:{'Content-Type':'text/plain;charset=utf-8'},
          body:payload,
          cache:'no-store',
          signal:controller.signal
        });
        if(!res.ok) throw new Error('HTTP ' + res.status);
        progressBar.style.width = '82%';
        statusText.textContent = '⏳ ได้รับผลตอบกลับจาก BigQuery กำลังตรวจจำนวนแถว...';
        const json = await res.json();
        if(json.status !== 'success') {
          const examples = json.details && Array.isArray(json.details.errors)
            ? json.details.errors.slice(0, 5).map(e => `แถว ${e.row}: ${e.message}`).join(', ')
            : '';
          throw new Error((json.message || 'เกิดข้อผิดพลาดในการนำเข้า BigQuery') + (examples ? ` — ${examples}` : ''));
        }
        return json;
      } catch(err) {
        lastError = err;
        const retryable = err && (err.name === 'AbortError' || /^HTTP 5/.test(err.message || '') || /Failed to fetch/i.test(err.message || ''));
        if(!retryable || attempt === 1) break;
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
