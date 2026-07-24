/* Pick Productivity Dashboard — ดึงข้อมูลสดจาก BigQuery (ผ่าน Apps Script Web App)
   Productivity คิดจาก "ชั่วโมงกะ (ปกติ) + OT" ไม่ใช่ช่วงหยิบชิ้นแรก–สุดท้าย
   กะเช้า 07:00–16:00 (OT 16:30–19:00) · กะดึก 19:00–04:00 (OT 04:30–07:00)
   แยก 2 ระบบ PTT / BPS · ทุก KPI/กราฟคำนวณสดตามช่วงวันที่ + กะ ที่เลือก */

// ====== ตั้งค่า: วาง URL ของ Apps Script Web App (ลงท้าย /exec) ตรงนี้ ======
const DATA_URL = 'https://script.google.com/macros/s/AKfycbyM0IVjD6Eo867rWbR_WjLlJJPSXLCqCqEpPZkfFGnlkqVOr8yY-LR7f6Bl4HRwzBy0/exec';
// เว้นว่าง = ใช้ข้อมูลสำรองใน data.js
// ==========================================================================

// ====== ตั้งค่ากะ/OT (ปรับได้) ======
const REG_HOURS = 9;     // ชั่วโมงทำงานปกติต่อกะ (07:00–16:00 / 19:00–04:00). ถ้าหักพักเที่ยงให้ใช้ 8
const OT_MAX    = 2.5;   // OT สูงสุดต่อกะ (ชม.)
// OT นับเป็นบล็อกละ 30 นาทีที่ทำครบ เริ่มนับจาก 16:30 (เช้า) / 04:30 (ดึก)
// ====================================

const CACHE_KEY = 'pick_dashboard_cache_v2';
const fmt = n => Number(n).toLocaleString('en-US');
const PALETTE = ['#6366f1','#14b8a6','#f59e0b','#f43f5e','#0ea5e9','#8b5cf6','#10b981','#ec4899','#f97316','#22c55e','#3b82f6','#eab308'];
const TITLES = {overview:'ภาพรวม',prod:'Productivity',zones:'โซน & ผังคลัง',pickers:'พนักงาน (Picker)',time:'ช่วงเวลา',items:'สินค้า (Items)'};
const SHIFT_LABEL = {morning:'🌅 เช้า', night:'🌙 ดึก', '-':'-'};

Chart.register(ChartDataLabels);
Chart.defaults.font.family = "'Prompt',sans-serif";
Chart.defaults.color = '#64748b';

// ===== state =====
let DATA = (typeof RAW !== 'undefined') ? RAW : {meta:{},PTT:{dates:[],pickers:[],skus:[],rows:[]},BPS:{dates:[],pickers:[],skus:[],rows:[]}};
let ALL_DATES = [], DMIN = '', DMAX = '';
let sys = 'PTT', currentPage = 'overview', dfrom = '', dto = '', shiftF = 'all', built = {}, A = null;
let excludedSkus = new Set();
let itemSearchTerm = '';

// ===== shift helpers =====
// tmin = นาทีของวัน (เวลา local) · แปลงเป็น กะ + วันของกะ + นาทีนับจากต้นกะ
function addDays(ds, n){                     // เลื่อนวันที่แบบสตริง (ไม่ใช้ Date เพื่อความเร็ว)
  let [y,m,d] = ds.split('-').map(Number); d += n;
  const dim = mm => [31,((y%4===0&&y%100!==0)||y%400===0)?29:28,31,30,31,30,31,31,30,31,30,31][mm-1];
  while(d < 1){ m--; if(m<1){ m=12; y--; } d += dim(m); }
  while(d > dim(m)){ d -= dim(m); m++; if(m>12){ m=1; y++; } }
  return y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
}
function shiftOf(ds, t){
  if(t >= 420 && t < 1140) return {sh:'morning', sd:ds,            sm:t-420};   // 07:00–18:59 -> กะเช้า
  if(t >= 1140)            return {sh:'night',   sd:ds,            sm:t-1140};  // 19:00–23:59 -> กะดึก (วันนี้)
  return                          {sh:'night',   sd:addDays(ds,-1), sm:t+300};  // 00:00–06:59 -> กะดึกของ "คืนก่อน"
}
// OT = จำนวนบล็อก 30 นาทีที่ทำครบ นับจากนาทีที่ 570 (16:30/04:30) ต้นกะ, สูงสุด OT_MAX
function otHours(maxSm){ if(maxSm <= 570) return 0; return Math.min(OT_MAX, Math.floor((maxSm - 570)/30) * 0.5); }

// precompute ข้อมูลกะต่อแถว "ครั้งเดียว" หลังโหลดข้อมูล -> re-render (เปลี่ยน filter) เร็วขึ้นมาก
function prepShifts(){
  ['PTT','BPS'].forEach(n => { const S = DATA[n]; if(S && S.rows) S._sh = S.rows.map(r => shiftOf(S.dates[r[0]], r[5])); });
}

function computeBounds(){
  prepShifts();
  const set = new Set();
  ['PTT','BPS'].forEach(n => { const S = DATA[n]; if(S && S._sh) for(const si of S._sh) set.add(si.sd); });
  ALL_DATES = [...set].sort();
  DMIN = ALL_DATES[0] || ''; DMAX = ALL_DATES[ALL_DATES.length-1] || '';
}

// ===== core: aggregate ตามช่วงวันที่(ของกะ) + กะ =====
// row = [dateIdx, zone, pickerIdx, skuIdx, qty, minOfDay]
function aggregate(system, from, to, sf){
  const S = DATA[system];
  let lines = 0, qty = 0;
  const pickers = new Set(), zones = new Set();
  const zoneMap = {}, itemMap = {}, itemMapAll = {}, slotMap = {}, dayVol = {}, grp = {}, pickerZoneCnt = {};
  const SH = S._sh;

  for(let i=0;i<S.rows.length;i++){
    const r = S.rows[i], si = SH[i];
    if(si.sd < from || si.sd > to) continue;
    if(sf !== 'all' && si.sh !== sf) continue;
    const zone = r[1], picker = S.pickers[r[2]], sku = S.skus[r[3]], q = r[4];
    
    // บันทึกสถิติสินค้าทั้งหมด (สำหรับหน้าค้นหา/ตั้งค่ายกเว้น)
    (itemMapAll[sku] = itemMapAll[sku] || {qty:0,lines:0}).qty += q; itemMapAll[sku].lines++;

    // หาก SKU นี้ถูกเลือกยกเว้น -> ข้ามไม่นำมาคิดสถิติรวมของระบบ
    if (excludedSkus.size > 0 && excludedSkus.has(sku)) continue;

    lines++; qty += q; pickers.add(picker); zones.add(zone);
    (zoneMap[zone] = zoneMap[zone] || {qty:0,lines:0,pk:new Set()}); zoneMap[zone].qty += q; zoneMap[zone].lines++; zoneMap[zone].pk.add(picker);
    (itemMap[sku] = itemMap[sku] || {qty:0,lines:0}); itemMap[sku].qty += q; itemMap[sku].lines++;
    const hr = Math.floor(r[5]/60);
    (slotMap[hr] = slotMap[hr] || {qty:0,lines:0}); slotMap[hr].qty += q; slotMap[hr].lines++;
    (pickerZoneCnt[picker] = pickerZoneCnt[picker] || {}); pickerZoneCnt[picker][zone] = (pickerZoneCnt[picker][zone]||0)+1;
    (dayVol[si.sd] = dayVol[si.sd] || {lines:0,qty:0,pk:new Set()}); dayVol[si.sd].lines++; dayVol[si.sd].qty += q; dayVol[si.sd].pk.add(picker);
    // group ต่อ (คน, วันของกะ, กะ) เพื่อคิด work-hours + OT
    const k = picker+'|'+si.sd+'|'+si.sh;
    const b = grp[k] || (grp[k] = {picker, sd:si.sd, sh:si.sh, q:0, n:0, mx:-1});
    b.q += q; b.n++; if(si.sm > b.mx) b.mx = si.sm;
  }

  const groups = Object.values(grp);
  groups.forEach(g => { g.ot = otHours(g.mx); g.wh = REG_HOURS + g.ot; g.prod = g.q / g.wh; });
  const r1 = n => Math.round(n*10)/10;
  const mean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;

  const byDate = {}; groups.forEach(g => { (byDate[g.sd] = byDate[g.sd] || []).push(g.prod); });
  const daily = Object.keys(dayVol).sort().map(d => ({date:d, lines:dayVol[d].lines, qty:dayVol[d].qty, pickers:dayVol[d].pk.size, avg_prod:r1(mean(byDate[d]||[]))}));

  const byPicker = {};
  groups.forEach(g => { const o = byPicker[g.picker] || (byPicker[g.picker] = {q:0,n:0,ot:0,prods:[],sh:{}}); o.q += g.q; o.n += g.n; o.ot += g.ot; o.prods.push(g.prod); o.sh[g.sh] = (o.sh[g.sh]||0)+g.n; });
  const by_picker = Object.entries(byPicker).map(([picker,o]) => {
    const zc = pickerZoneCnt[picker] || {}; const zone = Object.keys(zc).sort((a,b)=>zc[b]-zc[a])[0] || '-';
    const shift = Object.keys(o.sh).sort((a,b)=>o.sh[b]-o.sh[a])[0] || '-';
    return {picker, qty:o.q, lines:o.n, ot:r1(o.ot), shift, avg_prod:r1(mean(o.prods)), zone};
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

  const by_zone = Object.entries(zoneMap).map(([zone,v])=>({zone,qty:v.qty,lines:v.lines,pickers:v.pk.size})).sort((a,b)=>b.qty-a.qty);
  const by_item = Object.entries(itemMap).map(([sku,v])=>{
    const info = getItemInfo(sku);
    return { sku, name: info.name, owner: info.owner, qty: v.qty, lines: v.lines };
  }).sort((a,b)=>b.qty-a.qty);
  const by_item_all = Object.entries(itemMapAll).map(([sku,v])=>{
    const info = getItemInfo(sku);
    return { sku, name: info.name, owner: info.owner, qty: v.qty, lines: v.lines, excluded: excludedSkus.has(sku) };
  }).sort((a,b)=>b.qty-a.qty);

  const by_timeslot = Object.keys(slotMap).map(Number).sort((a,b)=>a-b).map(h=>({label:String(h).padStart(2,'0')+':00', qty:slotMap[h].qty, lines:slotMap[h].lines}));

  const totOt = groups.reduce((s,g)=>s+g.ot,0);
  return {kpis:{lines, qty, pickers:pickers.size, ot:r1(totOt), avg_prod:r1(mean(groups.map(g=>g.prod)))}, daily, by_zone, by_picker, by_timeslot, by_item, by_item_all};
}

// qty รวมของระบบตามช่วง+กะ (สำหรับกราฟเทียบ)
function sysQty(system, from, to, sf){
  const S = DATA[system], SH = S._sh || []; let q = 0;
  for(let i=0;i<S.rows.length;i++){ const si = SH[i]; if(si && si.sd>=from && si.sd<=to && (sf==='all'||si.sh===sf)) q += S.rows[i][4]; }
  return q;
}

// ===== controls =====
function ensureStyles(){
  if(document.getElementById('dash-style')) return;
  const st = document.createElement('style'); st.id = 'dash-style';
  st.textContent = '.sysbar{display:flex;align-items:center;gap:12px 16px;margin:-6px 0 20px;flex-wrap:wrap}.sysbar .lab{font-size:13px;color:#64748b;font-weight:500}.systog{display:inline-flex;background:#eef2ff;border-radius:12px;padding:4px}.systog button{border:0;background:transparent;font-family:inherit;font-size:13px;font-weight:600;color:#64748b;padding:9px 16px;border-radius:9px;cursor:pointer;transition:.2s}.systog button.active{color:#fff;box-shadow:0 6px 14px -6px rgba(14,165,233,.6)}.systog button.active[data-sys="PTT"]{background:linear-gradient(90deg,#0ea5e9,#6366f1)}.systog button.active[data-sys="BPS"]{background:linear-gradient(90deg,#f59e0b,#f97316)}.shiftog button.active{background:linear-gradient(90deg,#8b5cf6,#6366f1)}'
    + '.datebar{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:6px 10px;box-shadow:0 8px 20px -16px rgba(30,41,59,.4)}.datebar input[type=date]{font-family:inherit;font-size:13px;color:#1e293b;border:1px solid #e2e8f0;border-radius:8px;padding:6px 8px;background:#f8fafc}.datebar input[type=date]:focus{outline:0;border-color:#6366f1}.datebar .sep{color:#94a3b8;font-size:13px}'
    + '.datepreset{display:inline-flex;gap:6px;flex-wrap:wrap}.datepreset button{border:1px solid #e2e8f0;background:#fff;font-family:inherit;font-size:12.5px;font-weight:500;color:#475569;padding:7px 12px;border-radius:9px;cursor:pointer;transition:.18s}.datepreset button:hover{border-color:#6366f1;color:#4338ca}.datepreset button.active{background:linear-gradient(90deg,#6366f1,#8b5cf6);border-color:transparent;color:#fff}'
    + '.refreshbtn{display:inline-flex;align-items:center;gap:6px;border:1px solid #e2e8f0;background:#fff;font-family:inherit;font-size:12.5px;font-weight:600;color:#0e7490;padding:7px 12px;border-radius:9px;cursor:pointer;transition:.18s}.refreshbtn:hover{border-color:#14b8a6;background:#f0fdfa}.freshtxt{font-size:11.5px;color:#94a3b8}'
    + '#loadov{position:fixed;inset:0;background:rgba(248,250,252,.75);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:999}#loadov .sp{width:38px;height:38px;border:4px solid #e2e8f0;border-top-color:#6366f1;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}#loadov .msg{margin-left:14px;font-size:14px;color:#475569;font-weight:500}';
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
    + '<span class="lab">กะ:</span>'
    + '<div class="systog shiftog"><button data-sh="all">ทุกกะ</button><button data-sh="morning">🌅 เช้า</button><button data-sh="night">🌙 ดึก</button></div>'
    + '<span class="lab">วันที่:</span>'
    + `<div class="datebar"><input type="date" id="dfrom" min="${DMIN}" max="${DMAX}" value="${dfrom}"><span class="sep">→</span><input type="date" id="dto" min="${DMIN}" max="${DMAX}" value="${dto}"></div>`
    + `<div class="datepreset"><button data-all="1">ทั้งหมด</button>${presetBtns}</div>`
    + '<button class="refreshbtn" id="refreshBtn">↻ รีเฟรช</button>'
    + '<span class="freshtxt" id="freshTxt"></span>';
  document.querySelector('.pagehead').insertAdjacentElement('afterend', bar);

  bar.querySelectorAll('.systog:not(.shiftog) button').forEach(b => { b.classList.toggle('active', b.dataset.sys===sys); b.onclick = () => {
    if(b.dataset.sys === sys) return; sys = b.dataset.sys;
    bar.querySelectorAll('.systog:not(.shiftog) button').forEach(x => x.classList.toggle('active', x.dataset.sys === sys));
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
    if(dfrom===DMIN && dto===DMAX){ const a=bar.querySelector('.datepreset button[data-all]'); if(a) a.classList.add('active'); }
    else if(dfrom===dto){ const m=bar.querySelector(`.datepreset button[data-d="${dfrom}"]`); if(m) m.classList.add('active'); }
  }
  function applyDates(){ if(dfrom > dto){ const t=dfrom; dfrom=dto; dto=t; fromEl.value=dfrom; toEl.value=dto; } setPresetActive(); render(); }
  fromEl.onchange = () => { dfrom = fromEl.value || DMIN; applyDates(); };
  toEl.onchange   = () => { dto   = toEl.value   || DMAX; applyDates(); };
  bar.querySelectorAll('.datepreset button').forEach(b => b.onclick = () => {
    if(b.dataset.all){ dfrom=DMIN; dto=DMAX; } else { dfrom=b.dataset.d; dto=b.dataset.d; }
    fromEl.value=dfrom; toEl.value=dto; setPresetActive(); render();
  });
  setPresetActive();
  bar.querySelector('#refreshBtn').onclick = () => loadData(true);
  updateFresh();
}

function updateFresh(){
  const el = document.getElementById('freshTxt'); if(!el) return;
  const g = DATA.meta && DATA.meta.generated;
  if(g){ const dt = new Date(g); el.textContent = 'ข้อมูล ณ ' + dt.toLocaleString('th-TH', {dateStyle:'medium', timeStyle:'short'}); }
  else el.textContent = DATA_URL ? '' : 'ข้อมูลสำรอง (data.js)';
}

function updateDateHeader(){
  const el = document.getElementById('daterange'); if(!el) return;
  const shTxt = shiftF==='all' ? '' : ' · '+SHIFT_LABEL[shiftF];
  el.innerHTML = (dfrom===dto ? 'ช่วงข้อมูล: <b>'+dfrom+'</b>' : 'ช่วงข้อมูล: <b>'+dfrom+'</b> ถึง <b>'+dto+'</b>') + shTxt;
}

// ===== KPI cards =====
function renderKPIs(){
  const k = A.kpis;
  const defs = [
    {lbl:'บรรทัดที่หยิบ', val:k.lines, unit:'', grad:'linear-gradient(90deg,#6366f1,#8b5cf6)'},
    {lbl:'จำนวนชิ้นรวม', val:k.qty, unit:'ชิ้น', grad:'linear-gradient(90deg,#14b8a6,#0ea5e9)'},
    {lbl:'พนักงานหยิบ', val:k.pickers, unit:'คน', grad:'linear-gradient(90deg,#f59e0b,#f97316)'},
    {lbl:'Productivity เฉลี่ย', val:k.avg_prod, unit:'หยิบ/ชม.', grad:'linear-gradient(90deg,#f43f5e,#ec4899)'},
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
    function bucket(mode){
      const map = {};
      daily.forEach(d => {
        let k = d.date; const dt = new Date(d.date);
        if(mode === 'week'){ const day = (dt.getDay()+6)%7; const mo = new Date(dt); mo.setDate(dt.getDate()-day); k = 'wk '+mo.toISOString().slice(5,10); }
        if(mode === 'month') k = d.date.slice(0,7);
        if(!map[k]) map[k] = {qty:0, ps:[]};
        map[k].qty += d.qty; if(d.avg_prod>0) map[k].ps.push(d.avg_prod);
      });
      const ks = Object.keys(map).sort();
      return {labels:ks, qty:ks.map(k=>map[k].qty), prod:ks.map(k=>map[k].ps.length?Math.round(map[k].ps.reduce((a,b)=>a+b,0)/map[k].ps.length*10)/10:0)};
    }
    function drawTrend(mode){
      const b = bucket(mode);
      const cfg = {data:{labels:b.labels, datasets:[
        {type:'bar', label:'จำนวนชิ้น', data:b.qty, backgroundColor:'rgba(99,102,241,.85)', borderRadius:8, yAxisID:'y', datalabels:{anchor:'end', align:'end', formatter:fmt, color:'#4338ca', font:{weight:'600'}}},
        {type:'line', label:'Productivity', data:b.prod, borderColor:'#f43f5e', backgroundColor:'#f43f5e', tension:.35, borderWidth:3, pointRadius:5, pointBackgroundColor:'#fff', pointBorderWidth:2, yAxisID:'y1', datalabels:{align:'top', color:'#e11d48', formatter:fmt, font:{weight:'600'}}}
      ]}, options:{maintainAspectRatio:false, layout:{padding:{top:24}}, plugins:{legend:{display:true, position:'top', labels:{usePointStyle:true, boxWidth:8}}}, scales:{y:{grid:{color:'#eef2f7'}, ticks:{callback:fmt}}, y1:{position:'right', grid:{drawOnChartArea:false}}}}};
      const ex = Chart.getChart('trend'); if(ex) ex.destroy();
      new Chart(document.getElementById('trend'), cfg);
    }
    drawTrend('day');
    document.querySelectorAll('#seg button').forEach(b => b.onclick = () => {
      document.querySelectorAll('#seg button').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); drawTrend(b.dataset.mode);
    });
    const cq = sysQty('PTT', dfrom, dto, shiftF), bq = sysQty('BPS', dfrom, dto, shiftF);
    new Chart(document.getElementById('cat'), {type:'doughnut', data:{labels:['Pick (PTT)','Pick to Sort (BPS)'], datasets:[{data:[cq, bq], backgroundColor:['#6366f1','#f59e0b'], borderWidth:4, borderColor:'#fff'}]}, options:{maintainAspectRatio:false, cutout:'60%', plugins:{legend:{position:'bottom', labels:{usePointStyle:true, boxWidth:8}}, datalabels:{color:'#fff', font:{size:14, weight:'700'}, textAlign:'center', formatter:(v,c)=>{ const t = c.chart.data.datasets[0].data.reduce((a,b)=>a+b,0)||1; return fmt(v)+'\n('+Math.round(v/t*100)+'%)'; }}}}});
  },
  prod(){
    const p = A.by_picker.slice(0, 12);
    new Chart(document.getElementById('picker'), {type:'bar', data:{labels:p.map(x=>x.picker+' ('+x.zone+')'), datasets:[{data:p.map(x=>x.avg_prod), backgroundColor:p.map((x,i)=>PALETTE[i%PALETTE.length]), borderRadius:6}]}, options:{indexAxis:'y', maintainAspectRatio:false, layout:{padding:{right:48}}, plugins:{legend:{display:false}, datalabels:{anchor:'end', align:'end', formatter:fmt, color:'#334155', font:{size:10, weight:'600'}}}, scales:{x:{grid:{color:'#eef2f7'}, ticks:{callback:fmt}}, y:{grid:{display:false}}}}});
  },
  zones(){
    const z = A.by_zone;
    new Chart(document.getElementById('zone'), {type:'bar', data:{labels:z.map(x=>x.zone), datasets:[{data:z.map(x=>x.qty), backgroundColor:z.map((x,i)=>PALETTE[i%PALETTE.length]), borderRadius:7}]}, options:{maintainAspectRatio:false, layout:{padding:{top:22}}, plugins:{legend:{display:false}, datalabels:{anchor:'end', align:'end', formatter:fmt, color:'#334155', font:{size:10, weight:'600'}}}, scales:{y:{grid:{color:'#eef2f7'}, ticks:{callback:fmt}}, x:{grid:{display:false}}}}});
    const maxQ = Math.max(1, ...z.map(x=>x.qty));
    const heat = document.getElementById('heat'); heat.innerHTML = '';
    z.forEach(x => {
      const t = Math.pow(x.qty/maxQ, .55), c1 = [224,231,255], c2 = [67,56,202];
      const mx = c1.map((v,i)=>Math.round(v+(c2[i]-v)*t));
      const e = document.createElement('div'); e.className = 'tile'; e.style.background = 'rgb('+mx.join(',')+')';
      if(t < .35) e.style.color = '#334155';
      e.innerHTML = '<div class="z">'+x.zone+'</div><div class="q">'+fmt(x.qty)+' ชิ้น</div><div class="p">'+x.pickers+' คน · '+fmt(x.lines)+' บรรทัด</div>';
      heat.appendChild(e);
    });
  },
  pickers(){
    let h = '<thead><tr><th>#</th><th>รหัส Picker</th><th>กะ</th><th>โซนหลัก</th><th class="num">บรรทัด</th><th class="num">ชิ้น</th><th class="num">OT (ชม.)</th><th class="num">หยิบ/ชม.</th></tr></thead><tbody>';
    if(!A.by_picker.length) h += '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:24px">ไม่มีข้อมูลในช่วงที่เลือก</td></tr>';
    A.by_picker.forEach((p,i) => { h += '<tr><td><span class="rank">'+(i+1)+'</span></td><td>'+p.picker+'</td><td>'+(SHIFT_LABEL[p.shift]||p.shift)+'</td><td><span class="pill">'+p.zone+'</span></td><td class="num">'+fmt(p.lines)+'</td><td class="num">'+fmt(p.qty)+'</td><td class="num">'+(p.ot>0?fmt(p.ot):'-')+'</td><td class="num">'+fmt(p.avg_prod)+'</td></tr>'; });
    h += '</tbody>'; document.getElementById('ptable').innerHTML = h;
  },
  time(){
    const t = A.by_timeslot;
    new Chart(document.getElementById('slot'), {type:'bar', data:{labels:t.map(x=>x.label), datasets:[{data:t.map(x=>x.qty), backgroundColor:'rgba(20,184,166,.85)', borderRadius:6}]}, options:{maintainAspectRatio:false, layout:{padding:{top:22}}, plugins:{legend:{display:false}, datalabels:{anchor:'end', align:'end', formatter:fmt, color:'#0f766e', font:{size:9, weight:'600'}, rotation:-90, offset:2}}, scales:{y:{grid:{color:'#eef2f7'}, ticks:{callback:fmt}}, x:{grid:{display:false}}}}});
  },
  items(){
    const it = A.by_item.slice(0, 10);
    const labels = it.map(x => {
      const nm = x.name || x.sku;
      return nm.length > 32 ? nm.slice(0, 30) + '…' : nm;
    });

    new Chart(document.getElementById('item'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          data: it.map(x => x.qty),
          backgroundColor: 'rgba(245,158,11,.9)',
          borderRadius: 6
        }]
      },
      options: {
        indexAxis: 'y',
        maintainAspectRatio: false,
        layout: { padding: { right: 55 } },
        plugins: {
          legend: { display: false },
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
                  ` จำนวน: ${fmt(item.qty)} ชิ้น (${fmt(item.lines)} บรรทัด)`
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

      let allItems = A.by_item_all || [];
      if (itemSearchTerm) {
        allItems = allItems.filter(x => 
          (x.sku && x.sku.toLowerCase().includes(itemSearchTerm)) ||
          (x.name && x.name.toLowerCase().includes(itemSearchTerm)) ||
          (x.owner && x.owner.toLowerCase().includes(itemSearchTerm))
        );
      }

      // แสดง 30 รายการแรกที่ตรงกับคำค้นหา
      const displayItems = allItems.slice(0, 35);

      let h = '<thead><tr><th>#</th><th>รหัส SKU</th><th>ชื่อสินค้า</th><th>Owner</th><th class="num">บรรทัด</th><th class="num">ชิ้น</th><th style="text-align:center;">สถานะการคำนวณ</th></tr></thead><tbody>';
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

          h += `<tr ${rowBg}>
            <td><span class="rank">${i + 1}</span></td>
            <td><b>${x.sku}</b></td>
            <td ${nameStyle}>${x.name || '-'}</td>
            <td><span class="pill">${x.owner || '-'}</span></td>
            <td class="num">${fmt(x.lines)}</td>
            <td class="num" style="font-weight:600;color:${isEx ? '#94a3b8' : '#0f766e'}">${fmt(x.qty)}</td>
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

function boot(){
  computeBounds();
  if(!ALL_DATES.length){ document.getElementById('kpis').innerHTML = '<div style="padding:20px;color:#94a3b8">ไม่มีข้อมูล</div>'; return; }
  dfrom = DMIN; dto = DMAX;
  buildControls();
  render();
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

// ===== โหลดข้อมูล: แสดง cache ทันที -> อัปเดตสดเบื้องหลัง =====
async function loadData(force){
  document.querySelectorAll('.nav[data-page]').forEach(n => n.onclick = () => show(n.dataset.page));
  if(!DATA_URL){ updateFresh(); boot(); return; }

  // 1) มี cache ในเครื่อง -> แสดงทันที ไม่ต้องรอ BigQuery
  let shown = false;
  if(!force){
    try{ const c = localStorage.getItem(CACHE_KEY); if(c){ DATA = JSON.parse(c); boot(); shown = true; setUpdating(true); } }catch(_){}
  }
  if(!shown) showLoading(true);

  // 2) โหลดสดเบื้องหลัง แล้วค่อยสลับข้อมูล (คงระบบ/กะ/ช่วงวันที่ที่เลือกไว้)
  try{
    const url = DATA_URL + (DATA_URL.includes('?')?'&':'?') + (force?'fresh=1&':'') + 't=' + Date.now();
    const res = await fetch(url, {cache:'no-store'});
    const j = await res.json();
    if(j && j.error) throw new Error(j.error);
    if(j && j.PTT && j.BPS){
      DATA = j; try{ localStorage.setItem(CACHE_KEY, JSON.stringify(j)); }catch(_){}
      const kSys=sys, kSh=shiftF, kF=dfrom, kT=dto;
      computeBounds();
      sys=kSys; shiftF=kSh;
      dfrom = (kF && kF>=DMIN && kF<=DMAX) ? kF : DMIN;
      dto   = (kT && kT>=DMIN && kT<=DMAX) ? kT : DMAX;
      buildControls(); render();
    } else if(!shown) throw new Error('รูปแบบข้อมูลไม่ถูกต้อง');
  }catch(err){
    if(!shown){ try{ const c = localStorage.getItem(CACHE_KEY); if(c) DATA = JSON.parse(c); }catch(_){} boot(); }
    console.warn('โหลดสดไม่สำเร็จ:', err);
  }
  showLoading(false); setUpdating(false);
}

// init
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
      alert('กรุณาเลือกไฟล์ประเภท .csv หรือ .xlsx เท่านั้นครับ');
      return;
    }
    selectedFile = file;
    dropZone.innerHTML = `
      <div style="font-size:36px;margin-bottom:10px;">✅</div>
      <div style="font-size:15px;font-weight:700;color:#059669;">เลือกไฟล์: ${file.name}</div>
      <div style="font-size:12px;color:#64748b;margin-top:6px;">ขนาด: ${(file.size/1048576).toFixed(2)} MB · คลิกหากต้องการเปลี่ยนไฟล์</div>
    `;
    btnStart.style.display = 'inline-block';
  }

  function resetUI() {
    selectedFile = null;
    if(fileInput) fileInput.value = '';
    if(btnStart) btnStart.style.display = 'none';
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
      btnStart.style.display = 'none';
      progressBox.style.display = 'block';
      statusText.textContent = '⏳ กำลังอ่านข้อมูลไฟล์...';
      progressBar.style.width = '15%';

      try {
        const ext = selectedFile.name.toLowerCase();
        let rows = [];

        if ((ext.endsWith('.xlsx') || ext.endsWith('.xls')) && typeof XLSX !== 'undefined') {
          statusText.textContent = '⚙️ กำลังประมวลผลไฟล์ Excel (.xlsx)...';
          progressBar.style.width = '30%';
          const buffer = await selectedFile.arrayBuffer();
          // cellDates:true → ให้ XLSX อ่าน Date cell เป็น JS Date แทน serial number
          const workbook = XLSX.read(buffer, { type: 'array', dense: true, cellDates: true });
          const firstSheet = workbook.SheetNames[0];
          const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { header: 1, raw: true, defval: '' });
          rows = parseExcelToRows(sheetData);
        } else {
          statusText.textContent = '⚙️ กำลังประมวลผลไฟล์ CSV...';
          progressBar.style.width = '30%';
          const text = await selectedFile.text();
          rows = parseCSVToRows(text);
        }

        if (rows.length === 0) throw new Error('ไม่พบข้อมูลในไฟล์ หรือรูปแบบไฟล์ไม่ถูกต้อง');

        // ส่งเป็น Array แทน Object → ลด payload ~55%
        // format: [pickdetailkey, lpn, qty, sku, owner, uom_qty, category, picker_id, location, pick_ts_source]
        const sizeKB = Math.round(JSON.stringify(rows).length / 1024);
        statusText.textContent = `🚀 กำลังส่งข้อมูล ${rows.length.toLocaleString()} แถว (~${sizeKB} KB) เข้า BigQuery...`;
        progressBar.style.width = '55%';

        const res = await fetch(DATA_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'upload_rows', fmt: 'array', rows: rows })
        });

        progressBar.style.width = '85%';
        statusText.textContent = '⏳ BigQuery กำลัง Merge ข้อมูล...';

        const json = await res.json();
        if (json.status !== 'success') throw new Error(json.message || 'เกิดข้อผิดพลาดในการนำเข้า BigQuery');

        progressBar.style.width = '100%';
        statusText.textContent = `🎉 นำเข้าสำเร็จ ${json.rowsProcessed.toLocaleString()} แถว! กำลังรีเฟรชแดชบอร์ด...`;

        setTimeout(() => { closeModal(); loadData(true); }, 1200);

      } catch (err) {
        alert('การนำเข้าล้มเหลว: ' + err.message);
        resetUI();
      }
    };
  }

  // แปลง Date cell จาก Excel เป็น "DD/MM/YYYY HH:mm"
  // รองรับ: JS Date object, Excel serial number (ตัวเลข), หรือ string เดิม
  // *** ใช้ getUTC* เสมอ เพราะ XLSX.js สร้าง Date จาก UTC ที่ตรงกับเวลาในไฟล์ Excel ***
  function fmtExcelDate(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date) {
      // XLSX (cellDates:true) สร้าง Date.UTC จากค่าใน Excel → ต้องใช้ getUTC* เพื่อได้เวลาที่ถูกต้อง
      const dd = String(v.getUTCDate()).padStart(2, '0');
      const mm = String(v.getUTCMonth() + 1).padStart(2, '0');
      const hh = String(v.getUTCHours()).padStart(2, '0');
      const mi = String(v.getUTCMinutes()).padStart(2, '0');
      return `${dd}/${mm}/${v.getUTCFullYear()} ${hh}:${mi}`;
    }
    if (typeof v === 'number' && v > 1000) {
      // Excel serial date → แปลงมือ ใช้ XLSX.SSF ถ้ามี หรือคำนวณเอง
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
    return String(v).trim();   // string เดิม (เช่น "20/07/2026 19:43") ส่งตรง
  }

  function parseExcelToRows(sheetData) {
    if (!sheetData || sheetData.length <= 2) return [];
    const parsedRows = [];
    for (let i = 2; i < sheetData.length; i++) {
      const cols = sheetData[i];
      if (!cols || cols.length === 0) continue;
      const key = (cols[1] != null ? String(cols[1]) : '').trim();
      if (!key) continue;
      // ส่งเป็น Array แทน Object → ลด JSON payload ~55%
      // index: [0]=key [1]=lpn [2]=qty [3]=sku [4]=owner [5]=uom_qty [6]=cat [7]=picker_id [8]=loc [9]=ts
      parsedRows.push([
        key,
        cols[12] != null ? String(cols[12]).trim() : '',
        cols[28] != null ? (parseFloat(String(cols[28])) || 0) : 0,
        cols[31] != null ? String(cols[31]).trim() : '',
        cols[36] != null ? String(cols[36]).trim() : '',
        cols[40] != null ? (parseFloat(String(cols[40])) || 1.0) : 1.0,
        cols[55] != null ? String(cols[55]).trim() : '',
        String(cols[56] || cols[58] || '').trim(),
        cols[64] != null ? String(cols[64]).trim() : '',
        fmtExcelDate(cols[66])   // Column BO: แปลง Date เป็น "DD/MM/YYYY HH:mm"
      ]);
    }
    return parsedRows;
  }

  function parseCSVToRows(csvText) {
    const lines = csvText.split(/\r?\n/);
    if (lines.length <= 2) return [];

    const parsedRows = [];
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const cols = parseCSVLine(line);
      const key = (cols[1] || '').trim();
      if (!key) continue;

      // ส่งเป็น Array แทน Object → ลด JSON payload ~55%
      parsedRows.push([
        key,
        (cols[12] || '').trim(),
        cols[28] ? (parseFloat(cols[28]) || 0) : 0,
        (cols[31] || '').trim(),
        (cols[36] || '').trim(),
        cols[40] ? (parseFloat(cols[40]) || 1.0) : 1.0,
        (cols[55] || '').trim(),
        (cols[56] || cols[58] || '').trim(),
        (cols[64] || '').trim(),
        (cols[66] || '').trim()
      ]);
    }
    return parsedRows;
  }

  function parseCSVLine(str) {
    const arr = [];
    let quote = false;
    let col = '';
    for (let c = 0; c < str.length; c++) {
      const cc = str[c];
      if (cc === '"') { quote = !quote; }
      else if (cc === ',' && !quote) { arr.push(col); col = ''; }
      else { col += cc; }
    }
    arr.push(col);
    return arr;
  }
})();
