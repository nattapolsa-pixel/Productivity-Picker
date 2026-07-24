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
const UPLOAD_SCHEMA_VERSION = 'pick-detail-wms-v1';
const MAX_UPLOAD_ROWS = 50000;
const MAX_POST_BYTES = 12 * 1024 * 1024;
const JOB_DEADLINE_MS = 240000;
// ==========================================================

const CACHE_TTL = 1800;   // เก็บผลลัพธ์ไว้กี่วินาที (1800 = 30 นาที) เพื่อไม่ต้องยิง BigQuery ทุกครั้ง

function doGet(e) {
  try {
    // fresh=1 ใช้หลังอัปโหลด/กดลองอีกครั้ง เพื่อข้าม BigQuery query cache
    const fresh = !!(e && e.parameter && e.parameter.fresh === '1');
    const dataObj = buildDashboardData_(!fresh);
    return textJson_(JSON.stringify(dataObj));
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

function clearCache_() {
  try {
    const c = CacheService.getScriptCache();
    const n = c.get('dash_n');
    if (n) {
      const cnt = parseInt(n, 10), keys = ['dash_n'];
      for (let i = 0; i < cnt; i++) keys.push('dash_' + i);
      c.removeAll(keys);
    }
  } catch (_) {}
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json_({ status: 'error', code: 'EMPTY_REQUEST', message: 'ไม่พบข้อมูลที่ส่งมา' });
    }
    if (Number(e.postData.length || e.postData.contents.length) > MAX_POST_BYTES) {
      return json_({
        status: 'error',
        code: 'PAYLOAD_TOO_LARGE',
        message: 'ไฟล์มีข้อมูลหลังแปลงเกินขนาดที่รองรับ กรุณาแบ่งไฟล์ให้เล็กกว่าเดิม'
      });
    }
    const postData = JSON.parse(e.postData.contents);
    if (postData.action === 'upload_rows' && Array.isArray(postData.rows)) {
      const result = uploadToBigQuery_(postData.rows, postData.fmt, postData.meta || {});
      return json_(Object.assign({ status: 'success' }, result));
    }
    return json_({ status: 'error', code: 'INVALID_ACTION', message: 'คำสั่งหรือข้อมูลแถวไม่ถูกต้อง' });
  } catch (err) {
    const details = err && err.uploadDetails ? err.uploadDetails : null;
    return json_({
      status: 'error',
      code: err && err.code ? err.code : 'UPLOAD_FAILED',
      message: String(err && err.message || err),
      details: details
    });
  }
}

function uploadToBigQuery_(rows, fmt, meta) {
  if (!rows || rows.length === 0) {
    throw uploadError_('NO_ROWS', 'ไม่พบแถวข้อมูลสำหรับนำเข้า');
  }
  if (rows.length > MAX_UPLOAD_ROWS) {
    throw uploadError_(
      'TOO_MANY_ROWS',
      'ไฟล์มี ' + rows.length.toLocaleString() + ' แถว เกินขีดจำกัด ' +
        MAX_UPLOAD_ROWS.toLocaleString() + ' แถวต่อครั้ง'
    );
  }
  if (typeof BigQuery === 'undefined' || !BigQuery.Jobs || !BigQuery.Tables) {
    throw uploadError_(
      'BIGQUERY_SERVICE_DISABLED',
      'BigQuery API ยังไม่ได้ถูก Enable ใน Apps Script'
    );
  }
  validateUploadMeta_(meta);

  const normalized = normalizeUploadRows_(rows, fmt);
  if (normalized.errors.length > 0) {
    const err = uploadError_(
      'VALIDATION_FAILED',
      'พบข้อมูลไม่ถูกต้อง ' + normalized.errors.length.toLocaleString() +
        ' จุด ระบบจึงยังไม่นำเข้า BigQuery'
    );
    err.uploadDetails = {
      counts: normalized.counts,
      errors: normalized.errors.slice(0, 100)
    };
    throw err;
  }

  const canonical = normalized.rows
    .map(function(row) {
      return JSON.stringify([
        row.pickdetailkey,
        row.lpn,
        row.qty,
        row.sku,
        row.owner,
        row.uom_qty,
        row.category,
        row.picker_id,
        row.location,
        row.pick_ts_source
      ]);
    })
    .join('\n');
  const uploadId = sha256Hex_(UPLOAD_SCHEMA_VERSION + '\n' + canonical);
  const requestId = Utilities.getUuid().replace(/-/g, '');
  const stageTable = 'pick_stage_' + requestId.substring(0, 24);
  const loadJobId = 'pick_load_' + requestId;
  // uploadId ใช้ตอบกลับเพื่อตรวจสอบคำขอ แต่ไม่ต้องเขียนซ้ำในทุกแถวของ
  // temporary stage เพราะ MERGE อ้างอิงด้วย pickdetailkey เท่านั้น
  const ndjson = normalized.rows.map(function(row) {
    return JSON.stringify(row);
  }).join('\n');
  const blob = Utilities.newBlob(ndjson, 'application/octet-stream', stageTable + '.ndjson');
  if (blob.getBytes().length > MAX_POST_BYTES) {
    throw uploadError_(
      'NORMALIZED_PAYLOAD_TOO_LARGE',
      'ข้อมูลหลังตรวจสอบมีขนาดเกินขีดจำกัด กรุณาแบ่งไฟล์แล้วนำเข้าใหม่'
    );
  }

  let stageCreated = false;
  let loadJob = null;
  let mergeCounts = null;
  let lock = null;
  try {
    loadJob = startLoadJob_(stageTable, loadJobId, blob);
    stageCreated = true;
    setStageExpiry_(stageTable);
    const stagedRows = Number(
      loadJob && loadJob.statistics && loadJob.statistics.load &&
      loadJob.statistics.load.outputRows || 0
    );
    if (stagedRows !== normalized.rows.length) {
      throw uploadError_(
        'LOAD_ROW_COUNT_MISMATCH',
        'จำนวนแถวที่ BigQuery โหลดไม่ตรงกับจำนวนที่ตรวจสอบ (' +
          stagedRows + '/' + normalized.rows.length + ')'
      );
    }

    lock = LockService.getScriptLock();
    if (!lock.tryLock(120000)) {
      throw uploadError_(
        'UPLOAD_BUSY',
        'มีการนำเข้าอีกไฟล์กำลัง Merge อยู่ กรุณาลองใหม่อีกครั้ง'
      );
    }
    mergeCounts = mergeStage_(stageTable);
    clearCache_();
  } finally {
    if (lock && lock.hasLock()) {
      lock.releaseLock();
    }
    if (stageCreated) {
      try {
        BigQuery.Tables.remove(BQ_PROJECT, BQ_DATASET, stageTable);
      } catch (cleanupErr) {
        console.warn('Temporary stage cleanup failed: ' + cleanupErr);
      }
    }
  }

  return {
    message: 'โหลดและ Merge เข้า BigQuery สำเร็จ',
    uploadId: uploadId,
    filename: String(meta.filename || ''),
    rowsProcessed: normalized.rows.length,
    counts: Object.assign({}, normalized.counts, mergeCounts),
    loadJobId: loadJobId
  };
}

function validateUploadMeta_(meta) {
  const expectedHeaders = [
    'PICKDETAILKEY', 'ID', 'QTY', 'SKU', 'STORERKEY', 'UOMQTY',
    'EXT_UDF_STR7', 'EXT_UDF_STR8', 'EXT_UDF_STR10',
    'EXT_UDF_STR16', 'EXT_UDF_DATE1'
  ];
  if (!meta || meta.schemaVersion !== UPLOAD_SCHEMA_VERSION) {
    throw uploadError_(
      'SCHEMA_VERSION_MISMATCH',
      'เวอร์ชันโครงสร้างไฟล์ไม่ตรงกับระบบ กรุณารีเฟรชหน้าเว็บแล้วลองใหม่'
    );
  }
  if (!Array.isArray(meta.headers) || meta.headers.length !== expectedHeaders.length) {
    throw uploadError_('INVALID_HEADERS', 'ไม่พบหัวคอลัมน์ Pick Detail ที่ระบบต้องใช้');
  }
  for (let i = 0; i < expectedHeaders.length; i++) {
    if (String(meta.headers[i] || '').trim().toUpperCase() !== expectedHeaders[i]) {
      throw uploadError_(
        'INVALID_HEADERS',
        'หัวคอลัมน์ไม่ตรงกับไฟล์ Pick Detail มาตรฐานที่ตำแหน่ง ' + (i + 1)
      );
    }
  }
}

function normalizeUploadRows_(rows, fmt) {
  const isArray = fmt === 'array';
  const seen = Object.create(null);
  const output = [];
  const errors = [];
  let exactDuplicates = 0;
  let conflicts = 0;

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const sourceRow = Number(isArray ? raw[10] : raw.source_row_number) || (i + 3);
    const value = function(index, name) {
      return isArray ? raw[index] : raw[name];
    };
    const key = String(value(0, 'pickdetailkey') || '').trim();
    const lpn = String(value(1, 'lpn') || '').trim();
    const qty = Number(value(2, 'qty'));
    const sku = String(value(3, 'sku') || '').trim();
    const owner = String(value(4, 'owner') || '').trim();
    const uomQty = Number(value(5, 'uom_qty'));
    const category = String(value(6, 'category') || '').trim().toUpperCase();
    const pickerId = String(value(7, 'picker_id') || '').trim();
    const location = String(value(8, 'location') || '').trim();
    const timestamp = normalizeTimestamp_(value(9, 'pick_ts_source'));
    const rowErrors = [];

    if (!key) rowErrors.push(['pickdetailkey', 'ต้องมี Pick Detail #']);
    if (!Number.isFinite(qty) || qty <= 0 || Math.floor(qty) !== qty) {
      rowErrors.push(['qty', 'QTY ต้องเป็นจำนวนเต็มมากกว่า 0']);
    }
    if (!sku) rowErrors.push(['sku', 'ต้องมี SKU']);
    if (!Number.isFinite(uomQty) || uomQty <= 0) {
      rowErrors.push(['uom_qty', 'UOMQTY ต้องเป็นตัวเลขมากกว่า 0']);
    }
    if (category !== 'PTT' && category !== 'BPS') {
      rowErrors.push(['category', 'Category ต้องเป็น PTT หรือ BPS']);
    }
    if (!pickerId) rowErrors.push(['picker_id', 'ต้องมีรหัส Picker']);
    if (!location) rowErrors.push(['location', 'ต้องมี Location']);
    if (!timestamp) rowErrors.push(['pick_ts_source', 'รูปแบบวันที่/เวลาไม่ถูกต้อง']);

    if (rowErrors.length > 0) {
      for (let e = 0; e < rowErrors.length; e++) {
        if (errors.length < 500) {
          errors.push({
            row: sourceRow,
            field: rowErrors[e][0],
            message: rowErrors[e][1]
          });
        }
      }
      continue;
    }

    const normalizedRow = {
      pickdetailkey: key,
      lpn: lpn,
      qty: qty,
      sku: sku,
      owner: owner,
      uom_qty: uomQty,
      category: category,
      picker_id: pickerId,
      location: location,
      pick_ts_source: timestamp,
      source_row_number: sourceRow
    };
    const fingerprint = JSON.stringify([
      lpn, qty, sku, owner, uomQty, category, pickerId, location, timestamp
    ]);
    if (Object.prototype.hasOwnProperty.call(seen, key)) {
      if (seen[key] === fingerprint) {
        exactDuplicates++;
      } else {
        conflicts++;
        if (errors.length < 500) {
          errors.push({
            row: sourceRow,
            field: 'pickdetailkey',
            message: 'พบ Pick Detail # ซ้ำแต่ข้อมูลในแถวไม่เหมือนกัน'
          });
        }
      }
      continue;
    }
    seen[key] = fingerprint;
    output.push(normalizedRow);
  }

  return {
    rows: output,
    errors: errors,
    counts: {
      received: rows.length,
      validUnique: output.length,
      exactDuplicates: exactDuplicates,
      conflictingDuplicates: conflicts,
      rejected: errors.length
    }
  };
}

function normalizeTimestamp_(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return null;
  let match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (match) {
    return validDateParts_(Number(match[3]), Number(match[2]), Number(match[1]),
      Number(match[4]), Number(match[5]));
  }
  match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    let hour = Number(match[4]);
    const ampm = String(match[6] || '').toUpperCase();
    if (ampm === 'PM' && hour < 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    return validDateParts_(year, Number(match[1]), Number(match[2]), hour, Number(match[5]));
  }
  match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?$/);
  if (match) {
    return validDateParts_(Number(match[1]), Number(match[2]), Number(match[3]),
      Number(match[4]), Number(match[5]));
  }
  return null;
}

function validDateParts_(year, month, day, hour, minute) {
  if (year < 2000 || year > 2100 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day || date.getUTCHours() !== hour ||
      date.getUTCMinutes() !== minute) {
    return null;
  }
  return pad2_(day) + '/' + pad2_(month) + '/' + year + ' ' +
    pad2_(hour) + ':' + pad2_(minute);
}

function pad2_(value) {
  return String(value).padStart(2, '0');
}

function sha256Hex_(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
    Utilities.Charset.UTF_8
  );
  return bytes.map(function(byte) {
    const unsigned = byte < 0 ? byte + 256 : byte;
    return ('0' + unsigned.toString(16)).slice(-2);
  }).join('');
}

function startLoadJob_(stageTable, jobId, blob) {
  const job = {
    jobReference: {
      projectId: BQ_PROJECT,
      jobId: jobId,
      location: BQ_LOCATION
    },
    configuration: {
      load: {
        destinationTable: {
          projectId: BQ_PROJECT,
          datasetId: BQ_DATASET,
          tableId: stageTable
        },
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        createDisposition: 'CREATE_IF_NEEDED',
        writeDisposition: 'WRITE_EMPTY',
        maxBadRecords: 0,
        ignoreUnknownValues: false,
        schema: {
          fields: [
            { name: 'pickdetailkey', type: 'STRING', mode: 'REQUIRED' },
            { name: 'lpn', type: 'STRING' },
            { name: 'qty', type: 'INT64', mode: 'REQUIRED' },
            { name: 'sku', type: 'STRING', mode: 'REQUIRED' },
            { name: 'owner', type: 'STRING' },
            { name: 'uom_qty', type: 'NUMERIC', mode: 'REQUIRED' },
            { name: 'category', type: 'STRING', mode: 'REQUIRED' },
            { name: 'picker_id', type: 'STRING', mode: 'REQUIRED' },
            { name: 'location', type: 'STRING', mode: 'REQUIRED' },
            { name: 'pick_ts_source', type: 'STRING', mode: 'REQUIRED' },
            { name: 'source_row_number', type: 'INT64', mode: 'REQUIRED' }
          ]
        }
      }
    }
  };
  let current = BigQuery.Jobs.insert(job, BQ_PROJECT, blob);
  const started = Date.now();
  let waitMs = 500;
  while (!current.status || current.status.state !== 'DONE') {
    if (Date.now() - started > JOB_DEADLINE_MS) {
      throw uploadError_('LOAD_TIMEOUT', 'BigQuery ใช้เวลาโหลดนานเกินกำหนด กรุณาลองนำเข้าไฟล์เดิมอีกครั้ง');
    }
    Utilities.sleep(waitMs);
    current = BigQuery.Jobs.get(BQ_PROJECT, jobId, { location: BQ_LOCATION });
    waitMs = Math.min(waitMs * 2, 5000);
  }
  if (current.status.errorResult) {
    throw uploadError_('LOAD_JOB_FAILED', formatJobErrors_(current));
  }
  return current;
}

function setStageExpiry_(stageTable) {
  try {
    BigQuery.Tables.patch(
      { expirationTime: String(Date.now() + 24 * 60 * 60 * 1000) },
      BQ_PROJECT,
      BQ_DATASET,
      stageTable
    );
  } catch (err) {
    console.warn('Could not set stage expiry: ' + err);
  }
}

function mergeStage_(stageTable) {
  const stage = '`' + BQ_PROJECT + '.' + BQ_DATASET + '.' + stageTable + '`';
  const main = '`' + BQ_PROJECT + '.' + BQ_DATASET + '.pick_detail`';
  const visible = '`' + BQ_PROJECT + '.' + BQ_DATASET + '.v_pick_enriched`';
  const different =
    '(T.lpn IS DISTINCT FROM S.lpn OR T.qty IS DISTINCT FROM S.qty OR ' +
    'T.sku IS DISTINCT FROM S.sku OR T.owner IS DISTINCT FROM S.owner OR ' +
    'T.uom_qty IS DISTINCT FROM S.uom_qty OR T.category IS DISTINCT FROM S.category OR ' +
    'T.picker_id IS DISTINCT FROM S.picker_id OR T.location IS DISTINCT FROM S.location OR ' +
    'T.pick_ts_source IS DISTINCT FROM S.pick_ts_source)';
  const sql = [
    'DECLARE source_rows INT64;',
    'DECLARE inserted_rows INT64;',
    'DECLARE updated_rows INT64;',
    'DECLARE unchanged_rows INT64;',
    'SET source_rows = (SELECT COUNT(*) FROM ' + stage + ');',
    'SET inserted_rows = (SELECT COUNT(*) FROM ' + stage + ' S LEFT JOIN ' + main +
      ' T USING (pickdetailkey) WHERE T.pickdetailkey IS NULL);',
    'SET updated_rows = (SELECT COUNT(*) FROM ' + stage + ' S JOIN ' + main +
      ' T USING (pickdetailkey) WHERE ' + different + ');',
    'SET unchanged_rows = source_rows - inserted_rows - updated_rows;',
    'MERGE ' + main + ' T USING ' + stage + ' S ON T.pickdetailkey = S.pickdetailkey',
    'WHEN MATCHED AND ' + different + ' THEN UPDATE SET',
    '  lpn=S.lpn, qty=S.qty, sku=S.sku, owner=S.owner, uom_qty=S.uom_qty,',
    '  category=S.category, picker_id=S.picker_id, location=S.location,',
    '  pick_ts_source=S.pick_ts_source, loaded_at=CURRENT_TIMESTAMP()',
    'WHEN NOT MATCHED THEN INSERT',
    '  (pickdetailkey,lpn,qty,sku,owner,uom_qty,category,picker_id,location,pick_ts_source,loaded_at)',
    'VALUES',
    '  (S.pickdetailkey,S.lpn,S.qty,S.sku,S.owner,S.uom_qty,S.category,S.picker_id,S.location,S.pick_ts_source,CURRENT_TIMESTAMP());',
    'SELECT source_rows, inserted_rows, updated_rows, unchanged_rows,',
    '  (SELECT COUNT(*) FROM ' + visible + ' V JOIN ' + stage +
      ' S USING (pickdetailkey)) AS visible_rows;'
  ].join('\n');
  const result = bqQueryAll_(sql, JOB_DEADLINE_MS);
  if (!result.length || result[0].length < 5) {
    throw uploadError_('MERGE_RESULT_MISSING', 'BigQuery Merge สำเร็จแต่ไม่สามารถตรวจสอบจำนวนแถวได้');
  }
  return {
    staged: Number(result[0][0] || 0),
    inserted: Number(result[0][1] || 0),
    updated: Number(result[0][2] || 0),
    unchanged: Number(result[0][3] || 0),
    visible: Number(result[0][4] || 0)
  };
}

function formatJobErrors_(job) {
  const errors = job && job.status && job.status.errors || [];
  if (!errors.length && job && job.status && job.status.errorResult) {
    errors.push(job.status.errorResult);
  }
  return errors.map(function(error) {
    return error.message || JSON.stringify(error);
  }).join(' | ') || 'BigQuery job failed';
}

function uploadError_(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
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

function buildDashboardData_(useQueryCache) {
  const currentDate = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  const sql =
    "SELECT UPPER(category) AS category, " +
    "FORMAT_DATE('%Y-%m-%d', pick_date) AS d, " +
    "zone, picker_id AS picker, sku, " +
    "EXTRACT(HOUR FROM pick_ts_local)*60 + EXTRACT(MINUTE FROM pick_ts_local) AS tmin, " +
    "CAST(ROUND(SAFE_DIVIDE(qty, COALESCE(NULLIF(uom_qty, 0), 1))) AS INT64) AS qty " +
    "FROM `" + BQ_PROJECT + "." + BQ_DATASET + ".v_pick_enriched` " +
    "WHERE pick_date >= DATE_SUB(DATE '" + currentDate + "', INTERVAL " + RECENT_DAYS + " DAY)";

  const mk = () => ({ _d:{}, _p:{}, _s:{}, dates:[], pickers:[], skus:[], rows:[] });
  const sysd = { PTT: mk(), BPS: mk() };
  const idx = (map, arr, key) => { if (!(key in map)) { map[key] = arr.length; arr.push(key); } return map[key]; };

  let total = 0;
  bqQueryEach_(sql, function(r) {
    const cat = r[0];
    const S = sysd[cat];
    if (!S) return;                         // เอาเฉพาะ PTT / BPS
    const d = r[1];
    const zone = r[2] || '??';
    const picker = r[3] || '(none)';
    const sku = r[4] || '(none)';
    const tmin = Number(r[5]) || 0;
    const qty = Number(r[6]) || 0;
    const di = idx(S._d, S.dates, d), pi = idx(S._p, S.pickers, picker), si = idx(S._s, S.skus, sku);
    S.rows.push(di, zone, pi, si, qty, tmin);
    total++;
  }, JOB_DEADLINE_MS, useQueryCache !== false);
  ['PTT','BPS'].forEach(c => sortDates_(sysd[c]));

  return {
    meta: { generated: new Date().toISOString(), source: 'BigQuery v_pick_enriched',
            recent_days: RECENT_DAYS, rows: total },
    PTT: { row_width: 6, dates: sysd.PTT.dates, pickers: sysd.PTT.pickers, skus: sysd.PTT.skus, rows: sysd.PTT.rows },
    BPS: { row_width: 6, dates: sysd.BPS.dates, pickers: sysd.BPS.pickers, skus: sysd.BPS.skus, rows: sysd.BPS.rows }
  };
}

// เรียงวันที่ให้ต่อเนื่อง แล้ว remap index ของ rows ตามลำดับใหม่
function sortDates_(S) {
  const order = S.dates.map((d, i) => [d, i]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const remap = {}; order.forEach((o, ni) => remap[o[1]] = ni);
  for (let i = 0; i < S.rows.length; i += 6) S.rows[i] = remap[S.rows[i]];
  S.dates = order.map(o => o[0]);
}

// อ่านผลลัพธ์ BigQuery ทีละหน้า เพื่อลด peak memory ของ Apps Script
function bqQueryEach_(sql, onRow, deadlineMs, useQueryCache) {
  const deadline = Number(deadlineMs || JOB_DEADLINE_MS);
  const started = Date.now();
  const pageSize = 10000;
  let page = BigQuery.Jobs.query({
    query: sql,
    useLegacySql: false,
    useQueryCache: useQueryCache !== false,
    timeoutMs: 60000,
    maxResults: pageSize,
    location: BQ_LOCATION
  }, BQ_PROJECT);
  const jobId = page.jobReference.jobId;
  const loc = page.jobReference.location || BQ_LOCATION;
  while (!page.jobComplete) {
    if (Date.now() - started > deadline) {
      throw uploadError_('QUERY_TIMEOUT', 'BigQuery ใช้เวลาประมวลผลนานเกินกำหนด');
    }
    Utilities.sleep(800);
    page = BigQuery.Jobs.getQueryResults(BQ_PROJECT, jobId, {
      location: loc,
      maxResults: pageSize
    });
  }
  if (page.errors && page.errors.length) {
    throw uploadError_(
      'QUERY_FAILED',
      page.errors.map(function(error) {
        return error.message || JSON.stringify(error);
      }).join(' | ')
    );
  }
  let count = 0;
  while (true) {
    if (page.rows) {
      for (const row of page.rows) {
        onRow(row.f.map(function(cell) { return cell.v; }));
        count++;
      }
    }
    const pageToken = page.pageToken;
    page = null;
    if (!pageToken) break;
    if (Date.now() - started > deadline) {
      throw uploadError_('QUERY_TIMEOUT', 'BigQuery ใช้เวลาประมวลผลนานเกินกำหนด');
    }
    page = BigQuery.Jobs.getQueryResults(BQ_PROJECT, jobId, {
      pageToken: pageToken,
      location: loc,
      maxResults: pageSize
    });
  }
  return count;
}

// ใช้กับ query ผลลัพธ์ขนาดเล็ก เช่นการตรวจจำนวนหลัง MERGE
function bqQueryAll_(sql, deadlineMs) {
  const out = [];
  bqQueryEach_(sql, function(row) { out.push(row); }, deadlineMs, false);
  return out;
}

// รันเพื่อทดสอบใน Editor (ดูผลใน Execution log)
function testRun() {
  const d = buildDashboardData_();
  Logger.log('rows=%s  PTT dates=%s  BPS dates=%s', d.meta.rows,
             JSON.stringify(d.PTT.dates), JSON.stringify(d.BPS.dates));
}
