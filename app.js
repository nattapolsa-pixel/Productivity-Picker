/* Pick Productivity Dashboard — ดึงข้อมูลสดจาก BigQuery (ผ่าน Apps Script Web App)
   Productivity คิดจาก "ชั่วโมงกะ (ปกติ) + OT" ไม่ใช่ช่วงหยิบชิ้นแรก–สุดท้าย
   กะเช้า 07:00–16:00 (OT 16:30–19:00) · กะดึก 19:00–04:00 (OT 04:30–07:00)
   แยก 2 ระบบ PTT / BPS · ทุก KPI/กราฟคำนวณสดตามช่วงวันที่ + กะ ที่เลือก */

// ====== ตั้งค่า: วาง URL ของ Apps Script Web App (ลงท้าย /exec) ตรงนี้ ======
const DATA_URL = 'https://script.google.com/macros/s/AKfycbyM0IVjD6Eo867rWbR_WjLlJJPSXLCqCqEpPZkfFGnlkqVOr8yY-LR7f6Bl4HRwzBy0/exec';
const DASHBOARD_SCHEMA_VERSION = 'pick-units-v2';
// ==========================================================================

// ====== ตั้งค่ากะ/OT (ปรับได้) ======
const REG_HOURS = 9;     // ชั่วโมงทำงานปกติต่อกะ (07:00–16:00 / 19:00–04:00). ถ้าหักพักเที่ยงให้ใช้ 8
const OT_MAX    = 2.5;   // OT สูงสุดต่อกะ (ชม.)
// OT นับเป็นบล็อกละ 30 นาทีที่ทำครบ เริ่มนับจาก 16:30 (เช้า) / 04:30 (ดึก)
// ====================================

const fmt = n => Number(n).toLocaleString('en-US');
const PALETTE = ['#6366f1','#14b8a6','#f59e0b','#f43f5e','#0ea5e9','#8b5cf6','#10b981','#ec4899','#f97316','#22c55e','#3b82f6','#eab308'];
const TITLES = {overview:'ภาพรวม',prod:'Productivity',zones:'โซน & ผังคลัง',pickers:'พนักงาน (Picker)',time:'ช่วงเวลา',items:'สินค้า (Items)'};
const SHIFT_LABEL = {morning:'🌅 เช้า', night:'🌙 ดึก', '-':'-'};

Chart.register(ChartDataLabels);
Chart.defaults.font.family = "'Prompt',sans-serif";
Chart.defaults.color = '#64748b';

// ===== state =====
const emptyData = () => ({
  meta:{schema_version:DASHBOARD_SCHEMA_VERSION},
  PTT:{row_width:7,dates:[],pickers:[],skus:[],rows:[]},
  BPS:{row_width:7,dates:[],pickers:[],skus:[],rows:[]}
});
let DATA = emptyData();
let ALL_DATES = [], DMIN = '', DMAX = '';
let sys = 'PTT', currentPage = 'overview', dfrom = '', dto = '', shiftF = 'all', built = {}, A = null;
let unitMode = 'units'; // 'units' (หน่วยหยิบ) หรือ 'pcs' (จำนวนชิ้น)
let trendMode = 'day';
let datePresetMode = 'all';
let excludedSkus = new Set();
let itemSearchTerm = '';
let hasLiveData = false;
let activeLoadPromise = null;
let activeLoadIsFresh = false;
let queuedFreshPromise = null;
const DASHBOARD_TIMEOUT_MS = 180000;

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

// payload รุ่นปัจจุบันเป็น flat array 7 ช่องต่อแถว
function packedRowCount(S){
  const width = Number(S && S.row_width) || 0;
  return S && Array.isArray(S.rows) ? (width ? Math.floor(S.rows.length / width) : S.rows.length) : 0;
}
function packedRowData(S, i){
  if (Number(S && S.row_width) !== 7) {
    throw new Error('Dashboard payload schema ไม่ตรงกับหน้าเว็บ');
  }
  return {
    dateIdx: S.rows[i*7],
    zone: S.rows[i*7+1],
    pickerIdx: S.rows[i*7+2],
    skuIdx: S.rows[i*7+3],
    pcs: S.rows[i*7+4],
    pickQty: S.rows[i*7+5],
    tmin: S.rows[i*7+6]
  };
}

// precompute ข้อมูลกะต่อแถว "ครั้งเดียว" หลังโหลดข้อมูล -> re-render (เปลี่ยน filter) เร็วขึ้นมาก
function prepShifts(){
  ['PTT','BPS'].forEach(n => {
    const S = DATA[n];
    if(!S || !Array.isArray(S.rows)) return;
    const count = packedRowCount(S);
    S._sh = new Array(count);
    for(let i=0;i<count;i++) {
      const r = packedRowData(S, i);
      S._sh[i] = shiftOf(S.dates[r.dateIdx], r.tmin);
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

// ===== core: aggregate ตามช่วงวันที่(ของกะ) + กะ =====
// row width 7 = [dateIdx, zone, pickerIdx, skuIdx, pcs, pick_qty, minOfDay]
function aggregate(system, from, to, sf){
  const S = DATA[system];
  let lines = 0, pcs = 0, pickQty = 0;
  const pickers = new Set(), zones = new Set();
  const zoneMap = {}, itemMap = {}, itemMapAll = {}, slotMap = {}, dayVol = {}, grp = {}, pickerZoneCnt = {};
  const SH = S._sh;

  const rowCount = packedRowCount(S);
  for(let i=0;i<rowCount;i++){
    const si = SH[i];
    if(si.sd < from || si.sd > to) continue;
    if(sf !== 'all' && si.sh !== sf) continue;
    const r = packedRowData(S, i);
    const zone = r.zone;
    const picker = S.pickers[r.pickerIdx];
    const sku = S.skus[r.skuIdx];
    const pVal = r.pcs;
    const qVal = r.pickQty;

    // บันทึกสถิติสินค้าทั้งหมด (สำหรับหน้าค้นหา/ตั้งค่ายกเว้น)
    (itemMapAll[sku] = itemMapAll[sku] || {pcs:0,qty:0,lines:0}).pcs += pVal;
    itemMapAll[sku].qty += qVal;
    itemMapAll[sku].lines++;

    // หาก SKU นี้ถูกเลือกยกเว้น -> ข้ามไม่นำมาคิดสถิติรวมของระบบ
    if (excludedSkus.size > 0 && excludedSkus.has(sku)) continue;

    lines++; pcs += pVal; pickQty += qVal; pickers.add(picker); zones.add(zone);
    (zoneMap[zone] = zoneMap[zone] || {pcs:0,qty:0,lines:0,pk:new Set()});
    zoneMap[zone].pcs += pVal; zoneMap[zone].qty += qVal; zoneMap[zone].lines++; zoneMap[zone].pk.add(picker);

    (itemMap[sku] = itemMap[sku] || {pcs:0,qty:0,lines:0});
    itemMap[sku].pcs += pVal; itemMap[sku].qty += qVal; itemMap[sku].lines++;

    const hr = Math.floor(r.tmin/60);
    (slotMap[hr] = slotMap[hr] || {pcs:0,qty:0,lines:0});
    slotMap[hr].pcs += pVal; slotMap[hr].qty += qVal; slotMap[hr].lines++;

    (pickerZoneCnt[picker] = pickerZoneCnt[picker] || {});
    pickerZoneCnt[picker][zone] = (pickerZoneCnt[picker][zone]||0)+1;

    (dayVol[si.sd] = dayVol[si.sd] || {lines:0,pcs:0,qty:0,pk:new Set()});
    dayVol[si.sd].lines++; dayVol[si.sd].pcs += pVal; dayVol[si.sd].qty += qVal; dayVol[si.sd].pk.add(picker);

    // group ต่อ (คน, วันของกะ, กะ) เพื่อคิด work-hours + OT
    const k = picker+'|'+si.sd+'|'+si.sh;
    const b = grp[k] || (grp[k] = {picker, sd:si.sd, sh:si.sh, pcs:0, q:0, n:0, mx:-1});
    b.pcs += pVal; b.q += qVal; b.n++; if(si.sm > b.mx) b.mx = si.sm;
  }

  const groups = Object.values(grp);
  groups.forEach(g => {
    g.ot = otHours(g.mx);
    g.wh = REG_HOURS + g.ot;
    g.prod = g.q / g.wh;
    g.pcsProd = g.pcs / g.wh;
  });
  const r1 = n => Math.round(n*10)/10;
  const mean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;

  const byDate = {}, byDatePcs = {};
  groups.forEach(g => {
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
    const o = byPicker[g.picker] || (byPicker[g.picker] = {pcs:0,q:0,n:0,ot:0,prods:[],prodsPcs:[],sh:{}});
    o.pcs += g.pcs; o.q += g.q; o.n += g.n; o.ot += g.ot;
    o.prods.push(g.prod); o.prodsPcs.push(g.pcsProd);
    o.sh[g.sh] = (o.sh[g.sh]||0)+g.n;
  });
  const by_picker = Object.entries(byPicker).map(([picker,o]) => {
    const zc = pickerZoneCnt[picker] || {}; const zone = Object.keys(zc).sort((a,b)=>zc[b]-zc[a])[0] || '-';
    const shift = Object.keys(o.sh).sort((a,b)=>o.sh[b]-o.sh[a])[0] || '-';
    return {
      picker, pcs:o.pcs, qty:o.q, lines:o.n, ot:r1(o.ot), shift,
      avg_prod: r1(mean(o.prods)),
      avg_pcs_prod: r1(mean(o.prodsPcs)),
      zone
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

  const by_zone = Object.entries(zoneMap).map(([zone,v])=>({zone,pcs:v.pcs,qty:v.qty,lines:v.lines,pickers:v.pk.size})).sort((a,b)=>b.qty-a.qty);
  const by_item = Object.entries(itemMap).map(([sku,v])=>{
    const info = getItemInfo(sku);
    return { sku, name: info.name, owner: info.owner, pcs: v.pcs, qty: v.qty, lines: v.lines };
  }).sort((a,b)=>b.qty-a.qty);
  const by_item_all = Object.entries(itemMapAll).map(([sku,v])=>{
    const info = getItemInfo(sku);
    return { sku, name: info.name, owner: info.owner, pcs: v.pcs, qty: v.qty, lines: v.lines, excluded: excludedSkus.has(sku) };
  }).sort((a,b)=>b.qty-a.qty);

  const by_timeslot = Object.keys(slotMap).map(Number).sort((a,b)=>a-b).map(h=>({label:String(h).padStart(2,'0')+':00', pcs:slotMap[h].pcs, qty:slotMap[h].qty, lines:slotMap[h].lines}));

  const totOt = groups.reduce((s,g)=>s+g.ot,0);
  return {
    kpis: {
      lines, pcs, qty: pickQty, pickers: pickers.size, ot: r1(totOt),
      avg_prod: r1(mean(groups.map(g=>g.prod))),
      avg_pcs_prod: r1(mean(groups.map(g=>g.pcsProd)))
    },
    daily, by_zone, by_picker, by_timeslot, by_item, by_item_all
  };
}

// qty รวมของระบบตามช่วง+กะ (สำหรับกราฟเทียบ)
function sysQty(system, from, to, sf){
  const S = DATA[system], SH = S._sh || []; let q = 0;
  const rowCount = packedRowCount(S);
  for(let i=0;i<rowCount;i++){
    const si = SH[i];
    if(si && si.sd>=from && si.sd<=to && (sf==='all'||si.sh===sf)){
      const r = packedRowData(S, i), sku = S.skus[r.skuIdx];
      if(excludedSkus.size === 0 || !excludedSkus.has(sku)) q += r.pickQty;
    }
  }
  return q;
}
function sysPcs(system, from, to, sf){
  const S = DATA[system], SH = S._sh || []; let q = 0;
  const rowCount = packedRowCount(S);
  for(let i=0;i<rowCount;i++){
    const si = SH[i];
    if(si && si.sd>=from && si.sd<=to && (sf==='all'||si.sh===sf)){
      const r = packedRowData(S, i), sku = S.skus[r.skuIdx];
      if(excludedSkus.size === 0 || !excludedSkus.has(sku)) q += r.pcs;
    }
  }
  return q;
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
  bar.innerHTML =
    '<span class="lab">ระบบ:</span>'
    + '<div class="systog"><button data-sys="PTT">Pick (PTT)</button><button data-sys="BPS">Pick to Sort (BPS)</button></div>'
    + '<span class="lab">หน่วยที่แสดง:</span>'
    + '<div class="systog unittog"><button data-unit="units">📦 หน่วยหยิบ (Units)</button><button data-unit="pcs">🧩 จำนวนชิ้น (Pcs)</button></div>'
    + '<span class="lab">กะ:</span>'
    + '<div class="systog shiftog"><button data-sh="all">ทุกกะ</button><button data-sh="morning">🌅 เช้า</button><button data-sh="night">🌙 ดึก</button></div>'
    + '<span class="lab">วันที่:</span>'
    + `<div class="datebar"><input type="date" id="dfrom" min="${DMIN}" max="${DMAX}" value="${dfrom}"><span class="sep">→</span><input type="date" id="dto" min="${DMIN}" max="${DMAX}" value="${dto}"></div>`
    + `<div class="datepreset"><button data-all="1">ทั้งหมด</button><button data-range="week">Weekly</button><button data-range="month">Monthly</button>${presetBtns}</div>`
    + '<button class="refreshbtn" id="refreshBtn">↻ รีเฟรช</button>'
    + '<span class="freshtxt" id="freshTxt"></span>';
  document.querySelector('.pagehead').insertAdjacentElement('afterend', bar);

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
      lbl: isPcs ? 'ปริมาณชิ้นรวม ★' : 'จำนวนชิ้นรวม',
      val: k.pcs,
      unit: 'ชิ้น',
      grad: isPcs ? 'linear-gradient(90deg,#14b8a6,#0ea5e9)' : 'linear-gradient(90deg,#94a3b8,#cbd5e1)'
    },
    {
      lbl: !isPcs ? 'หน่วยหยิบรวม ★' : 'หน่วยหยิบรวม',
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
}
function countUp(){
  document.querySelectorAll('.num').forEach(el => {
    if(el.dataset.done) return; el.dataset.done = 1;
    const t = parseFloat(el.dataset.t), dec = t % 1 !== 0; let c = 0, s = t / 45;
    const iv = setInterval(() => { c += s; if(c >= t){ c = t; clearInterval(iv); } el.textContent = dec ? c.toFixed(1) : fmt(Math.round(c)); }, 18);
  });
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
        map[k].pcs += (d.pcs || d.qty);
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
    const cqPcs = sysPcs('PTT', dfrom, dto, shiftF), bqPcs = sysPcs('BPS', dfrom, dto, shiftF);
    const cqQty = sysQty('PTT', dfrom, dto, shiftF), bqQty = sysQty('BPS', dfrom, dto, shiftF);
    const catData = isPcs ? [cqPcs, bqPcs] : [cqQty, bqQty];
    const unitTxt = isPcs ? 'ชิ้น' : 'หน่วยหยิบ';
    const donutUnitTxt = isPcs ? 'ชิ้น' : 'หยิบ';
    const donutTotal = catData.reduce((a,b)=>a+b,0) || 1;
    const donutPct = v => (Number(v) || 0) / donutTotal * 100;
    const isSmallDonutSlice = ctx => donutPct(ctx.dataset.data[ctx.dataIndex]) < 8;

    new Chart(document.getElementById('cat'), {
      type:'doughnut',
      data:{labels:['Pick (PTT)','Pick to Sort (BPS)'], datasets:[{data:catData, backgroundColor:['#6366f1','#f59e0b'], borderWidth:4, borderColor:'#fff'}]},
      options:{
        maintainAspectRatio:false,
        layout:{padding:{top:28,right:58,bottom:22,left:58}},
        cutout:'60%',
        plugins:{
          legend:{position:'bottom', labels:{usePointStyle:true, boxWidth:8}},
          datalabels:{
            display:(ctx)=>Number(ctx.dataset.data[ctx.dataIndex] || 0) > 0,
            anchor:(ctx)=>isSmallDonutSlice(ctx) ? 'end' : 'center',
            align:(ctx)=>isSmallDonutSlice(ctx) ? 'end' : 'center',
            offset:(ctx)=>isSmallDonutSlice(ctx) ? 14 : 0,
            clamp:true,
            clip:false,
            color:(ctx)=>isSmallDonutSlice(ctx) ? '#92400e' : '#fff',
            backgroundColor:(ctx)=>isSmallDonutSlice(ctx) ? 'rgba(255,255,255,.96)' : 'rgba(15,23,42,.14)',
            borderColor:(ctx)=>isSmallDonutSlice(ctx) ? 'rgba(245,158,11,.45)' : 'transparent',
            borderWidth:(ctx)=>isSmallDonutSlice(ctx) ? 1 : 0,
            borderRadius:5,
            padding:{top:3,right:6,bottom:3,left:6},
            font:{size:12, weight:'700'},
            textAlign:'center',
            formatter:(v)=>{
              const pct = Math.round(donutPct(v));
              if(pct < 8) return fmt(v)+' '+donutUnitTxt+'\n'+pct+'%';
              return fmt(v)+' '+unitTxt+'\n('+pct+'%)';
            }
          },
          tooltip:{
            callbacks:{
              label:(ctx)=>{
                const idx = ctx.dataIndex;
                const sysName = ctx.label;
                const pVal = idx === 0 ? cqPcs : bqPcs;
                const qVal = idx === 0 ? cqQty : bqQty;
                return [
                  ` ${sysName}`,
                  ` จำนวนชิ้น: ${fmt(pVal)} ชิ้น`,
                  ` หน่วยหยิบ: ${fmt(qVal)} หน่วย`
                ];
              }
            }
          }
        }
      }
    });
  },
  prod(){
    const isPcs = unitMode === 'pcs';
    let p = [...A.by_picker];
    p.sort((a, b) => isPcs ? (b.avg_pcs_prod - a.avg_pcs_prod) : (b.avg_prod - a.avg_prod));
    p = p.slice(0, 12);

    const mainProd = isPcs ? p.map(x => x.avg_pcs_prod) : p.map(x => x.avg_prod);
    const unitLabel = isPcs ? 'ชิ้น/ชม.' : 'หยิบ/ชม.';

    new Chart(document.getElementById('picker'), {
      type:'bar',
      data:{labels:p.map(x=>x.picker+' ('+x.zone+')'), datasets:[{data:mainProd, backgroundColor:p.map((x,i)=>PALETTE[i%PALETTE.length]), borderRadius:6}]},
      options:{
        indexAxis:'y', maintainAspectRatio:false, layout:{padding:{right:55}},
        plugins:{
          legend:{display:false},
          datalabels:{anchor:'end', align:'end', formatter:(v)=>fmt(v)+' '+unitLabel, color:'#334155', font:{size:10, weight:'600'}},
          tooltip:{
            callbacks:{
              label:(ctx)=>{
                const picker = p[ctx.dataIndex];
                return [
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
  },
  zones(){
    const z = [...A.by_zone];
    const isPcs = unitMode === 'pcs';
    z.sort((a, b) => isPcs ? (b.pcs - a.pcs) : (b.qty - a.qty));
    const chartValues = isPcs ? z.map(x=>x.pcs) : z.map(x=>x.qty);
    const chartLabel = isPcs ? 'จำนวนชิ้น' : 'หน่วยหยิบ';

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
          datalabels:{anchor:'end', align:'end', formatter:fmt, color:'#334155', font:{size:10, weight:'600'}}
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
      e.innerHTML = '<div class="z">'+x.zone+'</div><div class="q">'+mainTxt+'</div><div class="p">'+x.pickers+' คน</div>';
      heat.appendChild(e);
    });
  },
  pickers(){
    const isPcs = unitMode === 'pcs';
    const list = [...A.by_picker];
    list.sort((a, b) => isPcs ? (b.pcs - a.pcs) : (b.qty - a.qty));

    const pcsHeaderStyle = isPcs ? 'background:#e0f2fe;color:#0369a1;font-weight:700;' : '';
    const qtyHeaderStyle = !isPcs ? 'background:#e0e7ff;color:#3730a3;font-weight:700;' : '';
    const prodHeaderLabel = isPcs ? 'ชิ้น/ชม.' : 'หยิบ/ชม.';

    let h = `<thead><tr><th>#</th><th>รหัส Picker</th><th>กะ</th><th>โซนหลัก</th><th class="num" style="${pcsHeaderStyle}">ชิ้น (Pcs) ${isPcs ? '★' : ''}</th><th class="num" style="${qtyHeaderStyle}">หน่วยหยิบ (Units) ${!isPcs ? '★' : ''}</th><th class="num">OT (ชม.)</th><th class="num">${prodHeaderLabel}</th></tr></thead><tbody>`;
    if(!list.length) h += '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:24px">ไม่มีข้อมูลในช่วงที่เลือก</td></tr>';
    list.forEach((p,i) => {
      const pcsCellStyle = isPcs ? 'background:#f0f9ff;font-weight:700;color:#0284c7;' : 'color:#0f766e;font-weight:600;';
      const qtyCellStyle = !isPcs ? 'background:#eef2ff;font-weight:700;color:#4338ca;' : 'color:#4338ca;font-weight:600;';
      const prodValue = isPcs ? p.avg_pcs_prod : p.avg_prod;

      h += `<tr>
        <td><span class="rank">${i + 1}</span></td>
        <td><b>${p.picker}</b></td>
        <td>${SHIFT_LABEL[p.shift] || p.shift}</td>
        <td><span class="pill">${p.zone}</span></td>
        <td class="num" style="${pcsCellStyle}">${fmt(p.pcs)}</td>
        <td class="num" style="${qtyCellStyle}">${fmt(p.qty)}</td>
        <td class="num">${p.ot > 0 ? fmt(p.ot) : '-'}</td>
        <td class="num" style="font-weight:700;color:#e11d48;">${fmt(prodValue)}</td>
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
    it.sort((a, b) => isPcs ? (b.pcs - a.pcs) : (b.qty - a.qty));
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
      allItems.sort((a, b) => isPcs ? (b.pcs - a.pcs) : (b.qty - a.qty));

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

      let h = `<thead><tr><th>#</th><th>รหัส SKU</th><th>ชื่อสินค้า</th><th>Owner</th><th class="num" style="${pcsHeaderStyle}">จำนวนชิ้น ${isPcs ? '★' : ''}</th><th class="num" style="${qtyHeaderStyle}">หน่วยหยิบ ${!isPcs ? '★' : ''}</th><th style="text-align:center;">สถานะการคำนวณ</th></tr></thead><tbody>`;
      if (!displayItems.length) {
        h += '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:24px">ไม่พบสินค้าที่ตรงกับคำค้นหา</td></tr>';
      } else {
        displayItems.forEach((x, i) => {
          const isEx = excludedSkus.has(x.sku);
          const rowBg = isEx ? 'style="background:#fff7ed;"' : '';
          const nameStyle = isEx ? 'style="text-decoration:line-through;color:#94a3b8;"' : '';
          const statusBadge = isEx 
            ? '<span style="background:#fee2e2;color:#991b1b;padding:3px 9px;border-radius:6px;font-size:11.5px;font-weight:600;">🚫 ยกเว้นอยู่</span>'
            : '<span style="background:#dcfce7;color:#166534;padding:3px 9px;border-radius:6px;font-size:11.5px;font-weight:600;">✅ คำนวณปกติ</span>';

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

    renderItemTable();
  }
};

window.toggleExcludeSku = function(sku) {
  if (excludedSkus.has(sku)) {
    excludedSkus.delete(sku);
  } else {
    excludedSkus.add(sku);
  }
  render();
};

window.clearExcludedSkus = function() {
  excludedSkus.clear();
  render();
};

function renderExcludedBadges() {
  const bar = document.getElementById('excludedBar');
  const badgeContainer = document.getElementById('excludedBadges');
  const countBadge = document.getElementById('excludedCountBadge');
  const btnClear = document.getElementById('btnClearExcluded');

  if (btnClear && !btnClear._bound) {
    btnClear._bound = true;
    btnClear.addEventListener('click', clearExcludedSkus);
  }

  if (!bar || !badgeContainer || !countBadge) return;

  if (excludedSkus.size === 0) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'block';
  countBadge.textContent = excludedSkus.size.toLocaleString();

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

function destroyCharts(){ ['trend','cat','picker','zone','slot','item'].forEach(id => { const c = Chart.getChart(id); if(c) c.destroy(); }); }

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
  document.querySelectorAll('.num').forEach(el => el.removeAttribute('data-done'));
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
  ALL_DATES = []; DMIN = ''; DMAX = ''; dfrom = ''; dto = '';
  datePresetMode = 'all';
  trendMode = 'day';
  A = null; built = {}; lastFetchTime = null;
  excludedSkus.clear(); itemSearchTerm = '';
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
  if(retry) retry.onclick = () => loadData(true);
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

  if(!hadLiveData) showDataState('loading', 'กำลังเชื่อมต่อ BigQuery กรุณารอสักครู่');
  showLoading(true, 'กำลังดึงข้อมูลสด 100% ตรงจาก BigQuery…');
  setUpdating(true);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DASHBOARD_TIMEOUT_MS);

  try{
    const url = DATA_URL + (DATA_URL.includes('?')?'&':'?') +
      'fresh=' + (force ? '1' : '0') + '&t=' + Date.now();
    const res = await fetch(url, {cache:'no-store', signal:controller.signal});
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.text();
    let j;
    try {
      j = JSON.parse(body);
    } catch(_) {
      if(body.includes('ไม่มีหน่วยความจำ')) {
        throw new Error('Apps Script มีหน่วยความจำไม่พอสำหรับข้อมูลชุดนี้');
      }
      throw new Error('Apps Script ตอบกลับมาไม่ใช่ข้อมูล JSON');
    }
    if(j && j.error) throw new Error(j.error);
    const validSource = s =>
      s && Number(s.row_width) === 7 &&
      Array.isArray(s.dates) && Array.isArray(s.pickers) && Array.isArray(s.skus) &&
      Array.isArray(s.rows) && s.rows.length % 7 === 0;
    const valid = j && j.meta && j.meta.schema_version === DASHBOARD_SCHEMA_VERSION &&
      validSource(j.PTT) && validSource(j.BPS);
    if(!valid) throw new Error('รูปแบบข้อมูล BigQuery เป็นคนละรุ่นกับหน้าเว็บ กรุณากดรีเฟรชอีกครั้ง');

    const packedRows = packedRowCount(j.PTT) + packedRowCount(j.BPS);
    const totalRows = Number(j.meta && j.meta.rows) || packedRows;
    if(totalRows === 0){
      showDataState('empty', 'ไม่มีข้อมูลเก่าค้างอยู่แล้ว กรุณานำเข้าไฟล์ Pick Detail ชุดใหม่', j.meta);
      return {ok:true, rows:0};
    }

    DATA = j;
    lastFetchTime = j.meta ? j.meta.generated : new Date().toISOString();
    sys = previous.sys; shiftF = previous.shiftF;
    computeBounds();
    const keepFrom = previous.dfrom && previous.dfrom>=DMIN && previous.dfrom<=DMAX;
    const keepTo = previous.dto && previous.dto>=DMIN && previous.dto<=DMAX;
    dfrom = keepFrom ? previous.dfrom : DMIN;
    dto   = keepTo ? previous.dto : DMAX;
    datePresetMode = (keepFrom || keepTo) ? (previous.datePresetMode || 'custom') : 'all';
    trendMode = previous.trendMode || trendMode;
    hideDataState();
    setSideBadge('BigQuery สด ' + fmt(totalRows) + ' แถว\nอัปเดต ' + new Date(lastFetchTime).toLocaleString('th-TH', {dateStyle:'short', timeStyle:'short'}));
    buildControls();
    render();
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
try{ localStorage.removeItem('pick_dashboard_cache_v2'); }catch(_){}
bindDataStateActions();
document.querySelectorAll('.nav[data-page]').forEach(n => n.onclick = () => show(n.dataset.page));
loadData();

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
  const UPLOAD_SCHEMA_VERSION = 'pick-detail-wms-v1';
  const MAX_UPLOAD_ROWS = 50000;
  const MAX_FILE_BYTES = 25 * 1024 * 1024;
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

  const openModal = () => { modal.style.display = 'flex'; resetUI(); };
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
        if (typeof XLSX === 'undefined') throw new Error('ไม่สามารถเปิดตัวอ่านไฟล์ Excel ได้ กรุณารีเฟรชหน้าเว็บ');
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
        const sizeKB = Math.round(new Blob([payload]).size / 1024);
        statusText.textContent = `🚀 ตรวจผ่าน ${rows.length.toLocaleString()} แถว กำลังส่งเข้า BigQuery (~${sizeKB.toLocaleString()} KB)...`;
        progressBar.style.width = '55%';

        const json = await postUploadWithRetry(payload);
        const counts = json.counts || {};
        progressBar.style.width = '90%';
        statusText.textContent =
          `✅ BigQuery รับแล้ว ${Number(counts.staged || json.rowsProcessed || 0).toLocaleString()} แถว ` +
          `(เพิ่ม ${Number(counts.inserted || 0).toLocaleString()}, แก้ไข ${Number(counts.updated || 0).toLocaleString()}, ` +
          `มีอยู่แล้ว ${Number(counts.unchanged || 0).toLocaleString()}) กำลังตรวจหน้าเว็บ...`;

        const refreshed = await refreshDashboardAfterUpload();
        progressBar.style.width = '100%';
        if (refreshed) {
          statusText.textContent =
            `🎉 นำเข้าสำเร็จและหน้าเว็บอัปเดตแล้ว ` +
            `${Number(counts.visible || json.rowsProcessed || 0).toLocaleString()} แถว`;
          await sleep(1200);
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
    const sheetData = XLSX.utils.sheet_to_json(source.sheet, {
      header:1,
      raw:true,
      defval:''
    });
    const headerRow = sheetData[0] || [];
    const headers = REQUIRED_HEADERS.map(h => String(headerRow[h.index] || '').trim().toUpperCase());
    REQUIRED_HEADERS.forEach((header, index) => {
      if (headers[index] !== header.name) {
        const column = XLSX.utils.encode_col(header.index);
        throw new Error(
          `หัวคอลัมน์ ${column} ต้องเป็น ${header.name} แต่พบ “${String(headerRow[header.index] || '').trim() || '(ว่าง)'}”`
        );
      }
    });
    return {
      rows: parsePickRows(sheetData, source.headerRowIndex),
      meta: {
        schemaVersion: UPLOAD_SCHEMA_VERSION,
        filename: file.name,
        sheetName: firstSheet,
        headerRow: source.headerRowIndex + 1,
        sourceRowCount: Math.max(sheetData.length - 2, 0),
        headers: headers
      }
    };
  }

  function findPickDetailWorksheet(workbook) {
    const maxRequiredColumn = Math.max(...REQUIRED_HEADERS.map(header => header.index));
    for(const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if(!sheet) continue;

      for(let rowIndex = 0; rowIndex < 10; rowIndex++) {
        const matches = REQUIRED_HEADERS.every(header => {
          const value = readWorksheetCellValue(sheet, rowIndex, header.index);
          return String(value == null ? '' : value).trim().toUpperCase() === header.name;
        });
        if(!matches) continue;

        let range;
        try {
          range = sheet['!ref']
            ? XLSX.utils.decode_range(sheet['!ref'])
            : {s:{r:rowIndex,c:0}, e:{r:rowIndex,c:maxRequiredColumn}};
        } catch(_) {
          range = {s:{r:rowIndex,c:0}, e:{r:rowIndex,c:maxRequiredColumn}};
        }
        range.s.r = rowIndex;
        range.s.c = 0;
        range.e.r = Math.max(range.e.r, rowIndex);
        range.e.c = Math.max(range.e.c, maxRequiredColumn);
        sheet['!ref'] = XLSX.utils.encode_range(range);

        return {sheetName, sheet, headerRowIndex:rowIndex};
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

  function parsePickRows(sheetData, headerRowIndex) {
    if (!sheetData || sheetData.length <= 2) return [];
    const parsedRows = [];
    for (let i = 2; i < sheetData.length; i++) {
      const cols = sheetData[i] || [];
      if (!cols || cols.length === 0) continue;
      const relevant = [1,12,28,31,36,40,55,56,58,64,66];
      if(relevant.every(index => cols[index] == null || String(cols[index]).trim() === '')) continue;
      parsedRows.push([
        cols[1] != null ? String(cols[1]).trim() : '',
        cols[12] != null ? String(cols[12]).trim() : '',
        numericValue(cols[28]),
        cols[31] != null ? String(cols[31]).trim() : '',
        cols[36] != null ? String(cols[36]).trim() : '',
        numericValue(cols[40]),
        cols[55] != null ? String(cols[55]).trim().toUpperCase() : '',
        String(cols[56] || cols[58] || '').trim(),
        cols[64] != null ? String(cols[64]).trim() : '',
        fmtExcelDate(cols[66]),
        Number(headerRowIndex || 0) + i + 1
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
