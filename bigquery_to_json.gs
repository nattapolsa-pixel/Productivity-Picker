/*************************************************************
 *  BigQuery -> JSON  (Web App สำหรับ Pick Productivity Dashboard)
 *  ทำให้หน้าเว็บ (GitHub Pages) ดึงข้อมูลสดจาก BigQuery ได้เอง
 *  โครงสร้าง JSON ที่ส่งออก = เหมือน data.js ทุกอย่าง (RAW)
 *
 *  ── ตั้งค่าครั้งเดียว (ดู SETUP_dashboard_live_TH.md) ──
 *   1) Apps Script > เมนูซ้าย "Services" (+) > เพิ่ม "BigQuery API"
 *   2) Deploy > New deployment > เลือก type = Web app
 *        - Execute as     : Me (บัญชีที่เข้าถึง BigQuery ได้)
 *        - Who has access : Anyone
 *   3) ก็อป Web app URL (ลงท้าย /exec) ไปวางใน app.js ที่ตัวแปร DATA_URL
 *
 *  ทดสอบ: เลือกฟังก์ชัน testRun แล้วกด Run เพื่อดูใน Log ว่าดึงกี่แถว
 *************************************************************/

// ====== แก้ค่าตรงนี้ให้ตรงกับของคุณ (ปกติตรงอยู่แล้ว) ======
const BQ_PROJECT  = 'productivity-pick';
const BQ_DATASET  = 'pick_analytics';
const BQ_LOCATION = 'asia-southeast1';   // ต้องตรงกับ region ของ dataset (ไม่งั้นเจอ "Not found: Job")
const RECENT_DAYS = 90;   // ดึงข้อมูลย้อนหลังกี่วัน (คุมขนาด/ความเร็ว) — ปรับได้
// ==========================================================

const CACHE_TTL = 1800;   // เก็บผลลัพธ์ไว้กี่วินาที (1800 = 30 นาที) เพื่อไม่ต้องยิง BigQuery ทุกครั้ง

function doGet(e) {
  try {
    const fresh = e && e.parameter && e.parameter.fresh === '1';   // ?fresh=1 = บังคับดึงใหม่ (ปุ่มรีเฟรช)
    if (!fresh) { const cached = getCached_(); if (cached) return textJson_(cached); }
    const str = JSON.stringify(buildDashboardData_());
    try { setCached_(str); } catch (_) {}
    return textJson_(str);
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    const postData = JSON.parse(e.postData.contents);
    if (postData.action === 'upload_rows' && Array.isArray(postData.rows)) {
      const result = uploadToBigQuery_(postData.rows, postData.fmt);
      CacheService.getScriptCache().remove('dash_n');
      return json_({ status: 'success', message: result.message, rowsProcessed: result.rowsProcessed });
    }
    return json_({ status: 'error', message: 'Invalid action or missing rows payload' });
  } catch (err) {
    return json_({ status: 'error', message: String(err && err.message || err) });
  }
}

function uploadToBigQuery_(rows, fmt) {
  if (!rows || rows.length === 0) return { message: 'No rows provided', rowsProcessed: 0 };

  // ตรวจสอบว่า BigQuery API Service ถูก Enable แล้ว
  if (typeof BigQuery === 'undefined' || !BigQuery.Tabledata || !BigQuery.Tabledata.insertAll) {
    throw new Error('BigQuery API ยังไม่ได้ถูก Enable — ไปที่ Apps Script > Services > เพิ่ม BigQuery API ก่อนครับ');
  }

  const TABLE_STAGING = 'pick_detail_staging';
  const isArray = (fmt === 'array');   // frontend ส่งเป็น Array เพื่อลด payload

  // filter แถวที่ไม่มี pickdetailkey
  const validRows = rows.filter(r => {
    const key = isArray ? r[0] : r.pickdetailkey;
    return key && String(key).trim() !== '';
  });
  if (validRows.length === 0) return { message: 'No valid rows after filtering', rowsProcessed: 0 };

  // เคลียร์ staging table (ทำครั้งเดียวตอนต้น ไม่ต้องทำซ้ำ  2 ครั้ง)
  const truncSql = "TRUNCATE TABLE `" + BQ_PROJECT + "." + BQ_DATASET + "." + TABLE_STAGING + "`";
  bqQueryAll_(truncSql);

  // Streaming Insert เข้า staging — batch 2000 ลด API trips ~4x
  const BATCH_SIZE = 2000;
  for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
    const chunk = validRows.slice(i, i + BATCH_SIZE);
    const insertRows = chunk.map((r, idx) => {
      const key        = isArray ? r[0] : r.pickdetailkey;
      const lpn        = isArray ? r[1] : r.lpn;
      const qty        = isArray ? r[2] : r.qty;
      const sku        = isArray ? r[3] : r.sku;
      const owner      = isArray ? r[4] : r.owner;
      const uom_qty    = isArray ? r[5] : r.uom_qty;
      const category   = isArray ? r[6] : r.category;
      const picker_id  = isArray ? r[7] : r.picker_id;
      const location   = isArray ? r[8] : r.location;
      const pick_ts    = isArray ? r[9] : r.pick_ts_source;
      return {
        insertId: String(key).trim() + '_' + (i + idx),
        json: {
          pickdetailkey : String(key  || '').trim(),
          lpn           : String(lpn  || '').trim(),
          qty           : parseFloat(qty)  || 0,
          sku           : String(sku  || '').trim(),
          owner         : String(owner || '').trim(),
          uom_qty       : parseFloat(uom_qty) || 1.0,
          category      : String(category || '').toUpperCase().trim(),
          picker_id     : String(picker_id || '').trim(),
          location      : String(location  || '').trim(),
          pick_ts_source: String(pick_ts   || '').trim()
        }
      };
    });

    const resp = BigQuery.Tabledata.insertAll(
      { rows: insertRows, skipInvalidRows: true, ignoreUnknownValues: true },
      BQ_PROJECT, BQ_DATASET, TABLE_STAGING
    );

    if (resp && resp.insertErrors && resp.insertErrors.length > 0) {
      const e0 = resp.insertErrors[0];
      const msg = (e0.errors && e0.errors[0]) ? e0.errors[0].message : JSON.stringify(e0);
      throw new Error('insertAll error (row ' + e0.index + '): ' + msg);
    }
    // ไม่ต้อง sleep — streaming insert ส่งไปแล้วเร็วมาก
  }

  // MERGE จาก staging -> pick_detail (dedup + upsert)
  const mergeSql =
    "MERGE `" + BQ_PROJECT + "." + BQ_DATASET + ".pick_detail` T " +
    "USING (" +
    "  SELECT * EXCEPT(rn) FROM (" +
    "    SELECT s.*, ROW_NUMBER() OVER (PARTITION BY pickdetailkey ORDER BY pick_ts_source DESC) AS rn " +
    "    FROM `" + BQ_PROJECT + "." + BQ_DATASET + "." + TABLE_STAGING + "` s " +
    "  ) WHERE rn = 1" +
    ") S " +
    "ON T.pickdetailkey = S.pickdetailkey " +
    "WHEN NOT MATCHED THEN " +
    "  INSERT (pickdetailkey, lpn, qty, sku, owner, uom_qty, category, picker_id, location, pick_ts_source, loaded_at) " +
    "  VALUES (S.pickdetailkey, S.lpn, S.qty, S.sku, S.owner, S.uom_qty, S.category, S.picker_id, S.location, S.pick_ts_source, CURRENT_TIMESTAMP()) " +
    "WHEN MATCHED AND (T.pick_ts_source IS NULL AND S.pick_ts_source IS NOT NULL) THEN " +
    "  UPDATE SET T.pick_ts_source = S.pick_ts_source, T.picker_id = S.picker_id, T.loaded_at = CURRENT_TIMESTAMP();";

  bqQueryAll_(mergeSql);
  bqQueryAll_(truncSql);   // เคลียร์ staging หลังเสร็จ

  return { message: 'Uploaded and merged successfully', rowsProcessed: validRows.length };
}

function textJson_(str) {
  return ContentService.createTextOutput(str).setMimeType(ContentService.MimeType.JSON);
}

// เก็บ/อ่าน JSON ก้อนใหญ่ใน Script Cache แบบแบ่งชิ้น (แต่ละ key จำกัด ~100KB)
function getCached_() {
  const c = CacheService.getScriptCache();
  const n = c.get('dash_n'); if (!n) return null;
  const cnt = parseInt(n, 10), keys = [];
  for (let i = 0; i < cnt; i++) keys.push('dash_' + i);
  const got = c.getAll(keys); let s = '';
  for (let i = 0; i < cnt; i++) { const p = got['dash_' + i]; if (p == null) return null; s += p; }
  return s;
}
function setCached_(str) {
  const c = CacheService.getScriptCache();
  const CH = 95000, cnt = Math.ceil(str.length / CH), obj = {};
  for (let i = 0; i < cnt; i++) obj['dash_' + i] = str.substring(i * CH, (i + 1) * CH);
  c.putAll(obj, CACHE_TTL);
  c.put('dash_n', String(cnt), CACHE_TTL);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function buildDashboardData_() {
  const sql =
    "SELECT UPPER(category) AS category, " +
    "FORMAT_DATE('%Y-%m-%d', pick_date) AS d, " +
    "zone, picker_id AS picker, sku, " +
    "EXTRACT(HOUR FROM pick_ts_local)*60 + EXTRACT(MINUTE FROM pick_ts_local) AS tmin, " +
    "CAST(ROUND(SAFE_DIVIDE(qty, COALESCE(NULLIF(uom_qty, 0), 1))) AS INT64) AS qty " +
    "FROM `" + BQ_PROJECT + "." + BQ_DATASET + ".v_pick_enriched` " +
    "WHERE pick_date >= DATE_SUB(CURRENT_DATE('Asia/Bangkok'), INTERVAL " + RECENT_DAYS + " DAY)";

  const rows = bqQueryAll_(sql);

  const mk = () => ({ _d:{}, _p:{}, _s:{}, dates:[], pickers:[], skus:[], rows:[] });
  const sysd = { PTT: mk(), BPS: mk() };
  const idx = (map, arr, key) => { if (!(key in map)) { map[key] = arr.length; arr.push(key); } return map[key]; };

  let total = 0;
  for (const r of rows) {
    const cat = r[0];
    const S = sysd[cat];
    if (!S) continue;                       // เอาเฉพาะ PTT / BPS
    const d = r[1];
    const zone = r[2] || '??';
    const picker = r[3] || '(none)';
    const sku = r[4] || '(none)';
    const tmin = Number(r[5]) || 0;
    const qty = Number(r[6]) || 0;
    const di = idx(S._d, S.dates, d), pi = idx(S._p, S.pickers, picker), si = idx(S._s, S.skus, sku);
    S.rows.push([di, zone, pi, si, qty, tmin]);
    total++;
  }
  ['PTT','BPS'].forEach(c => sortDates_(sysd[c]));

  return {
    meta: { generated: new Date().toISOString(), source: 'BigQuery v_pick_enriched',
            recent_days: RECENT_DAYS, rows: total },
    PTT: { dates: sysd.PTT.dates, pickers: sysd.PTT.pickers, skus: sysd.PTT.skus, rows: sysd.PTT.rows },
    BPS: { dates: sysd.BPS.dates, pickers: sysd.BPS.pickers, skus: sysd.BPS.skus, rows: sysd.BPS.rows }
  };
}

// เรียงวันที่ให้ต่อเนื่อง แล้ว remap index ของ rows ตามลำดับใหม่
function sortDates_(S) {
  const order = S.dates.map((d, i) => [d, i]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const remap = {}; order.forEach((o, ni) => remap[o[1]] = ni);
  S.rows.forEach(row => { row[0] = remap[row[0]]; });
  S.dates = order.map(o => o[0]);
}

// ดึงผลลัพธ์ BigQuery ทั้งหมด (รองรับหลายหน้า)
function bqQueryAll_(sql) {
  let qr = BigQuery.Jobs.query({ query: sql, useLegacySql: false, timeoutMs: 60000, maxResults: 100000, location: BQ_LOCATION }, BQ_PROJECT);
  const jobId = qr.jobReference.jobId;
  const loc = qr.jobReference.location || BQ_LOCATION;
  while (!qr.jobComplete) { Utilities.sleep(800); qr = BigQuery.Jobs.getQueryResults(BQ_PROJECT, jobId, { location: loc, maxResults: 100000 }); }
  const out = [];
  let page = qr;
  while (true) {
    if (page.rows) for (const row of page.rows) out.push(row.f.map(c => c.v));
    if (!page.pageToken) break;
    page = BigQuery.Jobs.getQueryResults(BQ_PROJECT, jobId, { pageToken: page.pageToken, location: loc, maxResults: 100000 });
  }
  return out;
}

// รันเพื่อทดสอบใน Editor (ดูผลใน Execution log)
function testRun() {
  const d = buildDashboardData_();
  Logger.log('rows=%s  PTT dates=%s  BPS dates=%s', d.meta.rows,
             JSON.stringify(d.PTT.dates), JSON.stringify(d.BPS.dates));
}
