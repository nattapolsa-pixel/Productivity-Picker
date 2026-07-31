/*************************************************************
 *  BigQuery -> JSON  (Web App สำหรับ Pick Productivity Dashboard)
 *  ทำให้หน้าเว็บ (GitHub Pages) ดึงข้อมูลสดจาก BigQuery ได้เอง
 *  โครงสร้าง JSON ที่ส่งออก = payload สำหรับ Dashboard (RAW)
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
const DASHBOARD_SCHEMA_VERSION = 'pick-units-v4';
const MAX_UPLOAD_ROWS = 50000;
const MAX_POST_BYTES = 12 * 1024 * 1024;
const JOB_DEADLINE_MS = 240000;
// ==========================================================

const MASTER_CACHE_TTL = 900; // Master จาก Google Sheets เปลี่ยนไม่บ่อย ลดเวลาเปิด Sheet ทุก cache miss
const CACHE_TTL = MASTER_CACHE_TTL; // Payload cache ใช้หน้าต่างเดียวกับ revision เพื่อลด cache chunk เก่าค้าง
const CACHE_REVISION_PROPERTY = 'dash_data_revision';
const DASHBOARD_CACHE_FORMAT_VERSION = 'speed-v1';
const PICKER_NAME_SHEET_ID = '1AWOeqhCqmBlSfGI5FWJVU4F77lDGNWBUH-TYpJeiYnI';
const PICKER_NAME_TAB = 'บันทึกเวลาทำงาน';
const PICKER_NAME_START_ROW = 26;
const ZONE_MASTER_SHEET_ID = '1PMnlyYHswnV0nE73Alxh-ocIFtTipB9LMzACdNM9GFs';
const ZONE_MASTER_TAB = 'Zone_V2';

// ====== Master สำหรับคำนวณหน่วยหยิบใน BigQuery ======
// Master_Item / Data: B=Owner, C=Item, D=Description, E=Pack, JL=Pick Type
// Master_Pack / Data: B=Pack, D=Pick Pack, H=Case Pack
const MASTER_ITEM_SHEET_ID = '1Nw8Y9XiCjbDHfBb8sQEkSTG0lrbcAyILZzGVNBANOfk';
const MASTER_ITEM_TAB = 'Data';
const MASTER_ITEM_FIRST_DATA_ROW = 3;
const MASTER_PACK_SHEET_ID = '16KsbwbbaqwPDAax-un7kqnabjmRtXhtMPHyu4wPyQJc';
const MASTER_PACK_TAB = 'Data';
const MASTER_PACK_FIRST_DATA_ROW = 3;
const MASTER_SYNC_TIMEZONE = 'Asia/Bangkok';
const MASTER_STAGE_TABLE = 'dim_pick_master_stage';
const MASTER_CURRENT_TABLE = 'dim_pick_master_current';
const MASTER_SNAPSHOT_TABLE = 'dim_pick_master_snapshot';
const MASTER_SYNC_TRIGGER_HANDLER = 'syncPickMastersDaily';
const DASHBOARD_TABLE = 't_pick_dashboard'; // Materialized table for fast dashboard queries
// =======================================================

function doGet(e) {
  try {
    // mode=revision เป็นคำตอบขนาดเล็กสำหรับหน้าเว็บที่มี IndexedDB cache อยู่แล้ว
    // ช่วยไม่ต้องดาวน์โหลด dashboard หลาย MB ซ้ำเมื่อข้อมูล BigQuery ยังไม่เปลี่ยน
    const mode = String(e && e.parameter && e.parameter.mode || '').toLowerCase();
    const revision = getDashboardRevisionToken_(getDataRevision_());
    if (mode === 'revision') {
      return json_({
        schema_version: DASHBOARD_SCHEMA_VERSION,
        revision: revision
      });
    }

    // fresh=1 ข้ามเฉพาะ Script Cache; BigQuery query cache ปลอดภัยเพราะ
    // BigQuery จะยกเลิกผล cache เองเมื่อตารางต้นทางเปลี่ยน
    const fresh = !!(e && e.parameter && e.parameter.fresh === '1');
    if (!fresh) {
      try {
        const cached = getCached_(revision);
        if (cached) return textJson_(cached);
      } catch (cacheReadErr) {
        console.warn('Dashboard cache read failed: ' + cacheReadErr);
      }
    }
    const dataObj = buildDashboardData_(true);
    dataObj.meta.data_revision = revision;
    const json = JSON.stringify(dataObj);
    try {
      // กัน GET เก่าที่เริ่มก่อน upload เขียน cache ทับข้อมูลรุ่นใหม่
      if (getDashboardRevisionToken_(getDataRevision_()) === revision) setCached_(json, revision);
    } catch (cacheWriteErr) {
      console.warn('Dashboard cache write failed: ' + cacheWriteErr);
    }
    return textJson_(json);
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

function getDataRevision_() {
  return PropertiesService.getScriptProperties().getProperty(CACHE_REVISION_PROPERTY) || '0';
}

function getDashboardRefreshBucket_() {
  return Math.floor(Date.now() / (MASTER_CACHE_TTL * 1000));
}

function getDashboardRevisionToken_(dataRevision) {
  // Uploads bump dataRevision immediately. The time bucket also detects data
  // changed outside this endpoint (BigQuery or master Sheets) within 15 minutes.
  return String(dataRevision || '0') + ':' + getDashboardRefreshBucket_();
}

function bumpDataRevision_() {
  PropertiesService.getScriptProperties().setProperty(
    CACHE_REVISION_PROPERTY,
    String(Date.now())
  );
}

function cachePrefix_(revision) {
  // ผูก cache กับ schema เพื่อไม่ให้ deployment ใหม่อ่าน payload รุ่นเก่า
  return 'dash_' + DASHBOARD_SCHEMA_VERSION + '_' + DASHBOARD_CACHE_FORMAT_VERSION +
    '_' + String(revision || '0') + '_';
}

function clearCache_(revision) {
  try {
    const c = CacheService.getScriptCache();
    const prefix = cachePrefix_(revision);
    const n = c.get(prefix + 'n');
    if (n) {
      const cnt = parseInt(n, 10), keys = [prefix + 'n'];
      for (let i = 0; i < cnt; i++) keys.push(prefix + i);
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

  const requestId = Utilities.getUuid().replace(/-/g, '');
  const stageTable = 'pick_stage_' + requestId.substring(0, 24);
  const loadJobId = 'pick_load_' + requestId;
  // uploadId ใช้ตอบกลับเพื่อตรวจสอบคำขอ แต่ไม่ต้องเขียนซ้ำในทุกแถวของ
  // temporary stage เพราะ MERGE อ้างอิงด้วย pickdetailkey เท่านั้น
  // รหัส upload ไม่รวม source_row_number เพื่อให้ข้อมูลธุรกิจชุดเดิมได้รหัสเดิม
  // แม้ไฟล์จะย้ายตำแหน่งหัวตาราง/เลขแถวต้นทาง
  let canonical = normalized.rows.map(function(row) {
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
  }).join('\n');
  const uploadId = sha256Hex_(UPLOAD_SCHEMA_VERSION + '\n' + canonical);
  canonical = null;

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
    const previousRevision = getDashboardRevisionToken_(getDataRevision_());
    bumpDataRevision_();
    clearCache_(previousRevision);
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
    // เก็บ source/insert/update ในการ JOIN รอบเดียว ลดการสแกน stage/main ก่อน MERGE
    'SET (source_rows, inserted_rows, updated_rows) = (',
    '  SELECT AS STRUCT',
    '    COUNT(*) AS source_rows,',
    '    COUNTIF(T.pickdetailkey IS NULL) AS inserted_rows,',
    '    COUNTIF(T.pickdetailkey IS NOT NULL AND ' + different + ') AS updated_rows',
    '  FROM ' + stage + ' S LEFT JOIN ' + main + ' T USING (pickdetailkey)',
    ');',
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
function getCached_(revision) {
  const c = CacheService.getScriptCache();
  const prefix = cachePrefix_(revision);
  const n = c.get(prefix + 'n'); if (!n) return null;
  const cnt = parseInt(n, 10), keys = [];
  for (let i = 0; i < cnt; i++) keys.push(prefix + i);
  const got = c.getAll(keys), parts = [];
  for (let i = 0; i < cnt; i++) {
    const part = got[prefix + i];
    if (part == null) return null;
    parts.push(part);
  }
  return parts.join('');
}
function setCached_(str, revision) {
  const c = CacheService.getScriptCache();
  const prefix = cachePrefix_(revision);
  const CH = 95000, cnt = Math.ceil(str.length / CH), obj = {};
  for (let i = 0; i < cnt; i++) obj[prefix + i] = str.substring(i * CH, (i + 1) * CH);
  c.putAll(obj, CACHE_TTL);
  c.put(prefix + 'n', String(cnt), CACHE_TTL);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function masterCacheKey_(key) {
  // Keep master data in the same time window as the dashboard revision token.
  return 'master_' + DASHBOARD_SCHEMA_VERSION + '_' +
    getDashboardRefreshBucket_() + '_' + key;
}

function readMasterCache_(key) {
  try {
    const value = CacheService.getScriptCache().get(masterCacheKey_(key));
    return value ? JSON.parse(value) : null;
  } catch (_) {
    return null;
  }
}

function writeMasterCache_(key, value) {
  try {
    CacheService.getScriptCache().put(
      masterCacheKey_(key),
      JSON.stringify(value),
      MASTER_CACHE_TTL
    );
  } catch (_) {}
}

function loadPickerDirectory_() {
  const cached = readMasterCache_('picker_directory_v1');
  if (cached && cached.names && cached.affiliations) return cached;

  try {
    const ss = SpreadsheetApp.openById(PICKER_NAME_SHEET_ID);
    const sh = ss.getSheetByName(PICKER_NAME_TAB);
    if (!sh) return { names: {}, affiliations: {} };
    const lastRow = sh.getLastRow();
    if (lastRow < PICKER_NAME_START_ROW) return { names: {}, affiliations: {} };
    // B:E = รหัสพนักงาน, ชื่อ, ชื่อเล่น, สังกัด
    const values = sh.getRange(PICKER_NAME_START_ROW, 2, lastRow - PICKER_NAME_START_ROW + 1, 4).getDisplayValues();
    const directory = { names: {}, affiliations: {} };
    values.forEach(row => {
      const id = String(row[0] || '').trim();
      const name = String(row[1] || '').trim();
      const affiliation = String(row[3] || '').trim();
      if (id && name && !directory.names[id]) directory.names[id] = name;
      if (id && affiliation && !directory.affiliations[id]) directory.affiliations[id] = affiliation;
    });
    writeMasterCache_('picker_directory_v1', directory);
    return directory;
  } catch (err) {
    console.warn('loadPickerDirectory_ failed: ' + err);
    return { names: {}, affiliations: {} };
  }
}

function loadZoneMasterMap_() {
  const cached = readMasterCache_('zone_master_v1');
  if (cached) return cached;

  try {
    const ss = SpreadsheetApp.openById(ZONE_MASTER_SHEET_ID);
    const sh = ss.getSheetByName(ZONE_MASTER_TAB);
    if (!sh) return {};
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return {};
    const values = sh.getRange(2, 1, lastRow - 1, 8).getDisplayValues();
    const map = {};

    values.forEach(row => {
      // ตารางหลักทางขวา: Location | Zone | Type Pick | Owner (E:H)
      const location = String(row[4] || '').trim().toUpperCase();
      const zone = String(row[5] || '').trim();
      const typePick = String(row[6] || '').trim();
      const owner = String(row[7] || '').trim();
      if (location) {
        map[location] = {
          zone: zone || location,
          typePick: typePick || '-',
          owner: owner || '-'
        };
      }

      // ตารางสรุปทางซ้ายมี Zone พิเศษที่ไม่ได้แตกซ้ำใน E:H เช่น BE/EA/FA/HB
      const summaryZone = String(row[0] || '').trim().toUpperCase();
      if (summaryZone && summaryZone.indexOf('-') === -1 && !map[summaryZone]) {
        map[summaryZone] = {
          zone: summaryZone,
          typePick: String(row[1] || '').trim() || '-',
          owner: String(row[2] || '').trim() || '-'
        };
      }
    });
    writeMasterCache_('zone_master_v1', map);
    return map;
  } catch (err) {
    console.warn('loadZoneMasterMap_ failed: ' + err);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Master_Item + Master_Pack -> BigQuery
//
// ตาราง current เป็น master ที่ v_pick_clean ใช้คำนวณจริง ส่วน stage ใช้ตรวจสอบ
// ก่อน promote และ snapshot เก็บ master ล่าสุดของแต่ละวัน (เวลา Asia/Bangkok)
// ห้ามใช้ Column E แทน Column C จนกว่าจะยืนยันว่า Column C หา Master_Pack ไม่เจอ
// ---------------------------------------------------------------------------

function syncPickMastersDaily() {
  return syncPickMasters_('daily-trigger');
}

// เรียกจาก Apps Script editor เมื่อต้องการ sync ทันที โดยไม่ต้องรอ trigger รายวัน
function syncPickMastersNow() {
  return syncPickMasters_('manual');
}

// สร้าง trigger รายวันใกล้ 02:00 ตาม timezone ของ Apps Script project
// ตั้ง timezone ของ Script project เป็น Asia/Bangkok ก่อนเรียกครั้งแรก
function installPickMasterDailySync() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === MASTER_SYNC_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger(MASTER_SYNC_TRIGGER_HANDLER)
    .timeBased()
    .atHour(2)
    .everyDays(1)
    .create();
  return { status: 'success', handler: MASTER_SYNC_TRIGGER_HANDLER, hour: 2 };
}

function removePickMasterDailySync() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === MASTER_SYNC_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  return { status: 'success', removed: removed };
}

function syncPickMasters_(source) {
  if (typeof BigQuery === 'undefined' || !BigQuery.Jobs || !BigQuery.Tables) {
    throw uploadError_('BIGQUERY_API_DISABLED', 'ต้อง Enable BigQuery API ใน Apps Script ก่อน sync Master');
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw uploadError_('MASTER_SYNC_IN_PROGRESS', 'มีการ sync Master อีกงานหนึ่งกำลังทำงานอยู่');
  }

  try {
    const now = new Date();
    const syncId = 'master_' + Utilities.formatDate(now, 'UTC', 'yyyyMMdd_HHmmss_SSS') + '_' +
      Math.floor(Math.random() * 1000000);
    const snapshotDate = Utilities.formatDate(now, MASTER_SYNC_TIMEZONE, 'yyyy-MM-dd');
    const loaded = loadPickMasterRows_(syncId, now);
    if (!loaded.rows.length) {
      throw uploadError_('MASTER_EMPTY', 'ไม่พบรายการ Master_Item ที่พร้อมใช้งาน จึงไม่แทนที่ master เดิม');
    }

    ensurePickMasterTables_();
    loadPickMasterStage_(loaded.rows, syncId);
    const validation = validatePickMasterStage_();
    // Gate เข้มงวด: stage ผิด/หา Master_Pack ไม่เจอ/Type ไม่รองรับ ต้องไม่แทนที่ current
    if (validation.stage_rows !== loaded.rows.length || validation.duplicate_keys || validation.invalid_divisors ||
        validation.missing_master_pack_rows || validation.invalid_rule_rows ||
        loaded.summary.unknown_pick_type_rows) {
      throw uploadError_(
        'MASTER_STAGE_INVALID',
        'ตรวจสอบ stage ไม่ผ่าน: rows=' + validation.stage_rows +
          ', duplicate_keys=' + validation.duplicate_keys +
          ', invalid_divisors=' + validation.invalid_divisors +
          ', missing_master_pack_rows=' + validation.missing_master_pack_rows +
          ', invalid_rule_rows=' + validation.invalid_rule_rows +
          ', unknown_pick_type_rows=' + loaded.summary.unknown_pick_type_rows
      );
    }

    const promoted = promotePickMasterStage_(snapshotDate);
    // Refresh ตาราง Dashboard ให้ใช้ Master ใหม่ทันที
    try { refreshPickDashboardTable_(); } catch (refreshErr) {
      console.warn('Dashboard table refresh failed (non-fatal): ' + refreshErr);
    }
    const previousRevision = getDataRevision_();
    clearCache_(previousRevision);
    bumpDataRevision_();

    const result = {
      status: 'success',
      source: source || 'manual',
      sync_id: syncId,
      snapshot_date: snapshotDate,
      rows: validation.stage_rows,
      current_rows: promoted.current_rows,
      snapshot_rows: promoted.snapshot_rows,
      fallback_to_column_e_rows: loaded.summary.fallback_to_column_e_rows,
      fallback_skipped_collision_rows: loaded.summary.fallback_skipped_collision_rows,
      missing_master_pack_rows: validation.missing_master_pack_rows,
      invalid_rule_rows: validation.invalid_rule_rows,
      rule_counts: loaded.summary.rule_counts,
      unknown_pick_type_rows: loaded.summary.unknown_pick_type_rows
    };
    console.log('Pick master sync completed: ' + JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

// Safe preview สำหรับตรวจผล mapping โดยไม่เขียน BigQuery
function previewPickMasterSync() {
  const now = new Date();
  const loaded = loadPickMasterRows_('preview', now);
  return {
    status: 'success',
    rows: loaded.rows.length,
    fallback_to_column_e_rows: loaded.summary.fallback_to_column_e_rows,
    fallback_skipped_collision_rows: loaded.summary.fallback_skipped_collision_rows,
    missing_master_pack_rows: loaded.summary.missing_master_pack_rows,
    rule_counts: loaded.summary.rule_counts,
    unknown_pick_type_rows: loaded.summary.unknown_pick_type_rows,
    sample_fallback_rows: loaded.summary.sample_fallback_rows,
    sample_skipped_fallback_collision_rows: loaded.summary.sample_skipped_fallback_collision_rows
  };
}

function loadPickMasterRows_(syncId, syncedAt) {
  const itemSs = SpreadsheetApp.openById(MASTER_ITEM_SHEET_ID);
  const itemSheet = itemSs.getSheetByName(MASTER_ITEM_TAB);
  if (!itemSheet) throw uploadError_('MASTER_ITEM_TAB_NOT_FOUND', 'ไม่พบ Sheet ' + MASTER_ITEM_TAB + ' ใน Master_Item');
  const packSs = SpreadsheetApp.openById(MASTER_PACK_SHEET_ID);
  const packSheet = packSs.getSheetByName(MASTER_PACK_TAB);
  if (!packSheet) throw uploadError_('MASTER_PACK_TAB_NOT_FOUND', 'ไม่พบ Sheet ' + MASTER_PACK_TAB + ' ใน Master_Pack');

  const packMap = buildMasterPackMap_(packSheet);
  const lastItemRow = itemSheet.getLastRow();
  if (lastItemRow < MASTER_ITEM_FIRST_DATA_ROW) {
    throw uploadError_('MASTER_ITEM_EMPTY', 'Master_Item ไม่มีข้อมูลหลัง header');
  }

  const count = lastItemRow - MASTER_ITEM_FIRST_DATA_ROW + 1;
  // อ่านเฉพาะ B:E และ JL เพื่อไม่โหลดทั้ง 272 คอลัมน์เข้า memory ของ Apps Script
  const itemBase = itemSheet.getRange(MASTER_ITEM_FIRST_DATA_ROW, 2, count, 4).getDisplayValues();
  const itemPickType = itemSheet.getRange(MASTER_ITEM_FIRST_DATA_ROW, 272, count, 1).getDisplayValues();
  const candidates = [];
  const primaryCanonicalKeys = {};
  const invalidRows = [];
  const summary = {
    fallback_to_column_e_rows: 0,
    fallback_skipped_collision_rows: 0,
    missing_master_pack_rows: 0,
    unknown_pick_type_rows: 0,
    rule_counts: {},
    sample_fallback_rows: [],
    sample_skipped_fallback_collision_rows: []
  };
  const syncedAtText = syncedAt.toISOString();

  // First reserve every valid C-primary key. This pass makes the precedence
  // deterministic even when an E-fallback source row appears before its C row.
  itemBase.forEach(function(raw, index) {
    const sheetRow = MASTER_ITEM_FIRST_DATA_ROW + index;
    const owner = normalizeMasterKey_(raw[0]);       // B
    const sourceItem = normalizeMasterKey_(raw[1]);  // C: primary Item from Master_Item
    const description = normalizeMasterText_(raw[2]); // D
    const itemPack = normalizeMasterKey_(raw[3]);    // E: fallback Pack only when C has no match
    const pickType = normalizePickType_(itemPickType[index][0]); // JL
    const hasAnyValue = !!(owner || sourceItem || description || itemPack || pickType);
    if (!hasAnyValue) return;
    if (!owner || !sourceItem) {
      invalidRows.push('row ' + sheetRow + ' ต้องมี Owner (B) และ Item (C)');
      return;
    }

    const primaryPack = packMap.by_pack[sourceItem] || null;
    const primaryKey = owner + '\u0001' + sourceItem;
    if (primaryPack && primaryCanonicalKeys[primaryKey]) {
      invalidRows.push(
        'C-primary Owner+Item ซ้ำ: ' + owner + ' / ' + sourceItem +
        ' (rows ' + primaryCanonicalKeys[primaryKey] + ' และ ' + sheetRow + ')'
      );
      return;
    }
    if (primaryPack) primaryCanonicalKeys[primaryKey] = sheetRow;
    candidates.push({
      owner: owner,
      source_item: sourceItem,
      description: description,
      item_pack: itemPack,
      pick_type: pickType,
      master_item_row: sheetRow,
      primary_pack: primaryPack
    });
  });

  if (invalidRows.length) {
    throw uploadError_(
      'MASTER_ITEM_INVALID',
      'Master_Item มีข้อมูลที่ไม่ปลอดภัยสำหรับแทนที่ current: ' + invalidRows.slice(0, 10).join(' | ')
    );
  }

  const rows = [];
  const fallbackCanonicalKeys = {};
  const unmappedCanonicalKeys = {};
  candidates.forEach(function(candidate) {
    let item = candidate.source_item;
    let masterPack = candidate.primary_pack;
    let packSource = masterPack ? 'ITEM_C' : 'MISSING';

    if (!masterPack && candidate.item_pack && packMap.by_pack[candidate.item_pack]) {
      item = candidate.item_pack; // E is canonical only after C has no Master_Pack match
      masterPack = packMap.by_pack[item];
      packSource = 'PACK_E_FALLBACK';
      const fallbackKey = candidate.owner + '\u0001' + item;

      // A duplicate fallback source is still unsafe even when both rows would
      // be skipped because a C-primary mapping exists.
      if (fallbackCanonicalKeys[fallbackKey]) {
        invalidRows.push(
          'E-fallback Owner+Item ซ้ำ: ' + candidate.owner + ' / ' + item +
          ' (rows ' + fallbackCanonicalKeys[fallbackKey] + ' และ ' + candidate.master_item_row + ')'
        );
        return;
      }
      fallbackCanonicalKeys[fallbackKey] = candidate.master_item_row;

      // A C-primary entry always wins. The fallback remains visible in sync audit,
      // but does not create a second mapping or block the daily sync.
      if (primaryCanonicalKeys[fallbackKey]) {
        summary.fallback_skipped_collision_rows++;
        if (summary.sample_skipped_fallback_collision_rows.length < 10) {
          summary.sample_skipped_fallback_collision_rows.push({
            owner: candidate.owner,
            source_item: candidate.source_item,
            item: item,
            row: candidate.master_item_row,
            primary_row: primaryCanonicalKeys[fallbackKey]
          });
        }
        return;
      }
      summary.fallback_to_column_e_rows++;
      if (summary.sample_fallback_rows.length < 10) {
        summary.sample_fallback_rows.push({
          owner: candidate.owner,
          source_item: candidate.source_item,
          item: item,
          row: candidate.master_item_row
        });
      }
    }

    // Missing Master_Pack will be rejected by the strict stage gate. Keep a
    // source row in stage for diagnosis, and still reject duplicate source keys.
    if (!masterPack) {
      const unmappedKey = candidate.owner + '\u0001' + item;
      if (unmappedCanonicalKeys[unmappedKey]) {
        invalidRows.push(
          'Owner+Item ที่ไม่มี Master_Pack ซ้ำ: ' + candidate.owner + ' / ' + item +
          ' (rows ' + unmappedCanonicalKeys[unmappedKey] + ' และ ' + candidate.master_item_row + ')'
        );
        return;
      }
      unmappedCanonicalKeys[unmappedKey] = candidate.master_item_row;
      summary.missing_master_pack_rows++;
    }

    const divisor = choosePickDivisor_(candidate.pick_type, masterPack);
    if (candidate.pick_type && candidate.pick_type !== 'PICK' && candidate.pick_type !== 'CASE') {
      summary.unknown_pick_type_rows++;
    }
    summary.rule_counts[divisor.rule_code] = (summary.rule_counts[divisor.rule_code] || 0) + 1;

    rows.push({
      owner: candidate.owner,
      item: item,
      source_item: candidate.source_item,
      description: candidate.description || null,
      item_pack: candidate.item_pack || null,
      pick_type: candidate.pick_type || null,
      pack_key: masterPack ? masterPack.pack_key : null,
      pack_source: packSource,
      pick_pack_size: masterPack ? masterPack.pick_pack_size : null,
      case_pack_size: masterPack ? masterPack.case_pack_size : null,
      uom_divisor: divisor.value,
      rule_code: divisor.rule_code,
      match_status: masterPack ? 'MATCHED' : 'MISSING_MASTER_PACK',
      master_item_row: candidate.master_item_row,
      master_pack_row: masterPack ? masterPack.master_pack_row : null,
      sync_id: syncId,
      synced_at: syncedAtText
    });
  });

  if (invalidRows.length) {
    throw uploadError_(
      'MASTER_ITEM_INVALID',
      'Master_Item มีข้อมูลที่ไม่ปลอดภัยสำหรับแทนที่ current: ' + invalidRows.slice(0, 10).join(' | ')
    );
  }
  return { rows: rows, summary: summary };
}

function buildMasterPackMap_(packSheet) {
  const lastRow = packSheet.getLastRow();
  if (lastRow < MASTER_PACK_FIRST_DATA_ROW) {
    throw uploadError_('MASTER_PACK_EMPTY', 'Master_Pack ไม่มีข้อมูลหลัง header');
  }
  const count = lastRow - MASTER_PACK_FIRST_DATA_ROW + 1;
  // B:H เพื่ออ่าน B=Pack, D=Pick Pack และ H=Case Pack ใน call เดียว
  const values = packSheet.getRange(MASTER_PACK_FIRST_DATA_ROW, 2, count, 7).getDisplayValues();
  const byPack = {};
  const conflicts = [];

  values.forEach(function(raw, index) {
    const sheetRow = MASTER_PACK_FIRST_DATA_ROW + index;
    const packKey = normalizeMasterKey_(raw[0]); // B
    const pickPackSize = parsePositiveMasterNumber_(raw[2]); // D
    const casePackSize = parsePositiveMasterNumber_(raw[6]); // H
    const hasAnyValue = !!(packKey || raw[2] || raw[6]);
    if (!hasAnyValue) return;
    if (!packKey) {
      conflicts.push('row ' + sheetRow + ' มี D/H แต่ไม่มี Pack (B)');
      return;
    }
    const record = {
      pack_key: packKey,
      pick_pack_size: pickPackSize,
      case_pack_size: casePackSize,
      master_pack_row: sheetRow
    };
    const existing = byPack[packKey];
    if (existing &&
        (existing.pick_pack_size !== record.pick_pack_size || existing.case_pack_size !== record.case_pack_size)) {
      conflicts.push('Pack ซ้ำค่าไม่ตรงกัน: ' + packKey + ' (rows ' + existing.master_pack_row + ' และ ' + sheetRow + ')');
      return;
    }
    if (!existing) byPack[packKey] = record;
  });

  if (conflicts.length) {
    throw uploadError_('MASTER_PACK_INVALID', 'Master_Pack มี key ซ้ำ/ไม่ครบ: ' + conflicts.slice(0, 10).join(' | '));
  }
  return { by_pack: byPack };
}

function choosePickDivisor_(pickType, masterPack) {
  if (!masterPack) return { value: 1, rule_code: 'MASTER_PACK_MISSING_FALLBACK_1' };
  const d = Number(masterPack.pick_pack_size) || 0;
  const h = Number(masterPack.case_pack_size) || 0;
  if (pickType === 'PICK') {
    return d > 0 ? { value: d, rule_code: 'PICK_D' } : { value: 1, rule_code: 'PICK_D_FALLBACK_1' };
  }
  if (pickType === 'CASE') {
    return h > 0 ? { value: h, rule_code: 'CASE_H' } : { value: 1, rule_code: 'CASE_H_FALLBACK_1' };
  }
  if (!pickType) {
    return d > 0 ? { value: d, rule_code: 'BLANK_D' } : { value: 1, rule_code: 'BLANK_FALLBACK_1' };
  }
  // ไม่ปล่อยให้หารศูนย์ หากมี Pick Type นอกเหนือจาก Pick/Case ให้ตรวจจาก rule_code ได้
  return { value: 1, rule_code: 'UNKNOWN_PICK_TYPE_FALLBACK_1' };
}

function normalizeMasterKey_(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toUpperCase();
}

function normalizeMasterText_(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function normalizePickType_(value) {
  const type = normalizeMasterKey_(value);
  if (type === 'PICK' || type === 'CASE') return type;
  return type;
}

function parsePositiveMasterNumber_(value) {
  const raw = String(value == null ? '' : value).replace(/,/g, '').trim();
  if (!raw) return null;
  const number = Number(raw);
  return isFinite(number) && number > 0 ? number : null;
}

function pickMasterSchema_(includeSnapshotDate) {
  const fields = [];
  if (includeSnapshotDate) fields.push({ name: 'snapshot_date', type: 'DATE', mode: 'REQUIRED' });
  return fields.concat([
    { name: 'owner', type: 'STRING', mode: 'REQUIRED' },
    { name: 'item', type: 'STRING', mode: 'REQUIRED' },
    { name: 'source_item', type: 'STRING', mode: 'REQUIRED' },
    { name: 'description', type: 'STRING' },
    { name: 'item_pack', type: 'STRING' },
    { name: 'pick_type', type: 'STRING' },
    { name: 'pack_key', type: 'STRING' },
    { name: 'pack_source', type: 'STRING', mode: 'REQUIRED' },
    { name: 'pick_pack_size', type: 'NUMERIC' },
    { name: 'case_pack_size', type: 'NUMERIC' },
    { name: 'uom_divisor', type: 'NUMERIC', mode: 'REQUIRED' },
    { name: 'rule_code', type: 'STRING', mode: 'REQUIRED' },
    { name: 'match_status', type: 'STRING', mode: 'REQUIRED' },
    { name: 'master_item_row', type: 'INT64', mode: 'REQUIRED' },
    { name: 'master_pack_row', type: 'INT64' },
    { name: 'sync_id', type: 'STRING', mode: 'REQUIRED' },
    { name: 'synced_at', type: 'TIMESTAMP', mode: 'REQUIRED' }
  ]);
}

function pickMasterDataColumns_() {
  return pickMasterSchema_(false).map(function(field) { return field.name; });
}

function bqTableSql_(tableId) {
  return '`' + BQ_PROJECT + '.' + BQ_DATASET + '.' + tableId + '`';
}

function ensurePickMasterTables_() {
  ensurePickMasterTable_(MASTER_STAGE_TABLE, false);
  ensurePickMasterTable_(MASTER_CURRENT_TABLE, false);
  ensurePickMasterTable_(MASTER_SNAPSHOT_TABLE, true);
}

function ensurePickMasterTable_(tableId, isSnapshot) {
  let table;
  try {
    table = BigQuery.Tables.get(BQ_PROJECT, BQ_DATASET, tableId);
  } catch (err) {
    if (!isBigQueryNotFound_(err)) throw err;
  }
  const expectedFields = pickMasterSchema_(isSnapshot);
  if (table) {
    const actual = ((table.schema || {}).fields || []).reduce(function(map, field) {
      map[field.name] = field.type;
      return map;
    }, {});
    const missing = expectedFields.filter(function(field) {
      const actType = actual[field.name];
      if (!actType) return true;
      if (actType === field.type) return false;
      if ((field.type === 'INT64' || field.type === 'INTEGER') && (actType === 'INT64' || actType === 'INTEGER')) return false;
      return true;
    }).map(function(field) { return field.name + ':' + field.type; });
    if (missing.length) {
      throw uploadError_('MASTER_TABLE_SCHEMA_MISMATCH', tableId + ' schema ไม่ตรง: ' + missing.join(', '));
    }
    return;
  }

  const resource = {
    tableReference: { projectId: BQ_PROJECT, datasetId: BQ_DATASET, tableId: tableId },
    schema: { fields: expectedFields },
    clustering: { fields: ['owner', 'item'] }
  };
  if (isSnapshot) resource.timePartitioning = { type: 'DAY', field: 'snapshot_date' };
  BigQuery.Tables.insert(resource, BQ_PROJECT, BQ_DATASET);
}

function isBigQueryNotFound_(err) {
  return /not found|404/i.test(String(err && err.message || err));
}

function loadPickMasterStage_(rows, syncId) {
  const jobId = 'pick_master_' + syncId.replace(/[^A-Za-z0-9_]/g, '_');
  const blob = Utilities.newBlob(
    rows.map(function(row) { return JSON.stringify(row); }).join('\n'),
    'application/x-ndjson'
  );
  const job = {
    jobReference: { projectId: BQ_PROJECT, jobId: jobId, location: BQ_LOCATION },
    configuration: {
      load: {
        destinationTable: { projectId: BQ_PROJECT, datasetId: BQ_DATASET, tableId: MASTER_STAGE_TABLE },
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        createDisposition: 'CREATE_IF_NEEDED',
        writeDisposition: 'WRITE_TRUNCATE',
        maxBadRecords: 0,
        ignoreUnknownValues: false,
        schema: { fields: pickMasterSchema_(false) }
      }
    }
  };
  let current = BigQuery.Jobs.insert(job, BQ_PROJECT, blob);
  const started = Date.now();
  let waitMs = 500;
  while (!current.status || current.status.state !== 'DONE') {
    if (Date.now() - started > JOB_DEADLINE_MS) {
      throw uploadError_('MASTER_LOAD_TIMEOUT', 'BigQuery ใช้เวลาโหลด Master นานเกินกำหนด');
    }
    Utilities.sleep(waitMs);
    current = BigQuery.Jobs.get(BQ_PROJECT, jobId, { location: BQ_LOCATION });
    waitMs = Math.min(waitMs * 2, 5000);
  }
  if (current.status.errorResult) {
    throw uploadError_('MASTER_LOAD_FAILED', formatJobErrors_(current));
  }
}

function validatePickMasterStage_() {
  const stage = bqTableSql_(MASTER_STAGE_TABLE);
  const sql = [
    'SELECT',
    '  COUNT(*) AS stage_rows,',
    '  COUNT(*) - COUNT(DISTINCT TO_JSON_STRING(STRUCT(owner, item))) AS duplicate_keys,',
    '  COUNTIF(uom_divisor IS NULL OR uom_divisor <= 0) AS invalid_divisors,',
    "  COUNTIF(match_status = 'MISSING_MASTER_PACK') AS missing_master_pack_rows,",
    "  COUNTIF(rule_code IN ('PICK_D_FALLBACK_1', 'CASE_H_FALLBACK_1', 'UNKNOWN_PICK_TYPE_FALLBACK_1', 'MASTER_PACK_MISSING_FALLBACK_1')) AS invalid_rule_rows",
    'FROM ' + stage
  ].join('\n');
  const result = bqQueryAll_(sql, JOB_DEADLINE_MS);
  if (!result.length) throw uploadError_('MASTER_STAGE_VALIDATION_MISSING', 'BigQuery ไม่ส่งผลตรวจ Master stage');
  return {
    stage_rows: Number(result[0][0] || 0),
    duplicate_keys: Number(result[0][1] || 0),
    invalid_divisors: Number(result[0][2] || 0),
    missing_master_pack_rows: Number(result[0][3] || 0),
    invalid_rule_rows: Number(result[0][4] || 0)
  };
}

function promotePickMasterStage_(snapshotDate) {
  const stage = bqTableSql_(MASTER_STAGE_TABLE);
  const current = bqTableSql_(MASTER_CURRENT_TABLE);
  const snapshot = bqTableSql_(MASTER_SNAPSHOT_TABLE);
  const columns = pickMasterDataColumns_();
  const columnList = columns.join(', ');
  const snapshotDateLiteral = "DATE '" + snapshotDate + "'";
  const sql = [
    'BEGIN TRANSACTION;',
    'DELETE FROM ' + current + ' WHERE TRUE;',
    'INSERT INTO ' + current + ' (' + columnList + ')',
    'SELECT ' + columnList + ' FROM ' + stage + ';',
    'DELETE FROM ' + snapshot + ' WHERE snapshot_date = ' + snapshotDateLiteral + ';',
    'INSERT INTO ' + snapshot + ' (snapshot_date, ' + columnList + ')',
    'SELECT ' + snapshotDateLiteral + ', ' + columnList + ' FROM ' + stage + ';',
    'COMMIT TRANSACTION;',
    'SELECT',
    '  (SELECT COUNT(*) FROM ' + current + ') AS current_rows,',
    '  (SELECT COUNT(*) FROM ' + snapshot + ' WHERE snapshot_date = ' + snapshotDateLiteral + ') AS snapshot_rows;'
  ].join('\n');
  const result = bqQueryAll_(sql, JOB_DEADLINE_MS);
  if (!result.length) throw uploadError_('MASTER_PROMOTE_RESULT_MISSING', 'BigQuery ไม่ส่งผลหลัง promote Master');
  return {
    current_rows: Number(result[0][0] || 0),
    snapshot_rows: Number(result[0][1] || 0)
  };
}

function buildDashboardData_(useQueryCache) {
  const currentDate = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  const pickerDirectory = loadPickerDirectory_();
  const pickerNames = pickerDirectory.names;
  const pickerAffiliations = pickerDirectory.affiliations;
  const zoneMaster = loadZoneMasterMap_();
  // ดึงจาก t_pick_dashboard (Materialized Table) แทน v_pick_enriched (View ซ้อนกัน 3 ชั้น)
  // ทำให้ Apps Script ตอบเร็วกว่าเดิมมาก
  const sql =
    "SELECT category, " +
    "FORMAT_DATE('%Y-%m-%d', pick_date) AS d, " +
    "zone, picker_id AS picker, sku, tmin, pcs, pick_qty " +
    "FROM `" + BQ_PROJECT + "." + BQ_DATASET + "." + DASHBOARD_TABLE + "` " +
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
    const pcs = Number(r[6]) || 0;
    const pick_qty = Number(r[7]) || 0;
    const di = idx(S._d, S.dates, d), pi = idx(S._p, S.pickers, picker), si = idx(S._s, S.skus, sku);
    S.rows.push(di, zone, pi, si, pcs, pick_qty, tmin);
    total++;
  }, JOB_DEADLINE_MS, useQueryCache !== false);
  ['PTT','BPS'].forEach(c => sortDates_(sysd[c]));

  return {
    meta: { generated: new Date().toISOString(), source: 'BigQuery ' + DASHBOARD_TABLE,
            schema_version: DASHBOARD_SCHEMA_VERSION,
            unit_definition: {
              pieces: 'pcs',
              source_pick_units: 'BigQuery t_pick_dashboard.pick_qty',
              dashboard_pick_units: 'BigQuery Master_Item + Master_Pack (Owner+Item, Pick=D, Case=H, Blank=D then 1)'
            },
            picker_names: pickerNames,
            picker_affiliations: pickerAffiliations,
            zone_master: zoneMaster,
            zone_master_source: ZONE_MASTER_SHEET_ID + '/' + ZONE_MASTER_TAB,
            recent_days: RECENT_DAYS, rows: total },
    PTT: { row_width: 7, dates: sysd.PTT.dates, pickers: sysd.PTT.pickers, skus: sysd.PTT.skus, rows: sysd.PTT.rows },
    BPS: { row_width: 7, dates: sysd.BPS.dates, pickers: sysd.BPS.pickers, skus: sysd.BPS.skus, rows: sysd.BPS.rows }
  };
}

// -----------------------------------------------------------------------------
// Refresh t_pick_dashboard — เรียกหลัง sync master สำเร็จ เพื่อให้ยอด pick_qty อัปเดต
// -----------------------------------------------------------------------------
function refreshPickDashboardTable_() {
  const sql =
    'CREATE OR REPLACE TABLE `' + BQ_PROJECT + '.' + BQ_DATASET + '.' + DASHBOARD_TABLE + '` ' +
    'PARTITION BY pick_date CLUSTER BY category, picker_id AS ' +
    'SELECT ' +
    '  UPPER(category)   AS category, ' +
    '  DATE(pick_ts_local) AS pick_date, ' +
    '  zone, ' +
    '  picker_id, ' +
    '  sku, ' +
    '  CAST(EXTRACT(HOUR FROM pick_ts_local)*60 + EXTRACT(MINUTE FROM pick_ts_local) AS INT64) AS tmin, ' +
    '  qty  AS pcs, ' +
    '  pick_qty ' +
    'FROM `' + BQ_PROJECT + '.' + BQ_DATASET + '.v_pick_enriched` ' +
    'WHERE pick_ts_local IS NOT NULL AND UPPER(category) IN (\'PTT\',\'BPS\')';
  bqQueryEach_(sql, function() {}, JOB_DEADLINE_MS, false);
  console.log('t_pick_dashboard refreshed successfully');
}

// เรียกจาก Editor เพื่อ Refresh ตาราง Dashboard ด้วยตนเอง
function refreshDashboardTableNow() {
  refreshPickDashboardTable_();
  clearCache_(getDataRevision_());
  bumpDataRevision_();
  return { status: 'success', table: DASHBOARD_TABLE };
}

// เรียงวันที่ให้ต่อเนื่อง แล้ว remap index ของ rows ตามลำดับใหม่
function sortDates_(S) {
  const w = (S && S.row_width) || 7;
  const order = S.dates.map((d, i) => [d, i]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const remap = {}; order.forEach((o, ni) => remap[o[1]] = ni);
  for (let i = 0; i < S.rows.length; i += w) S.rows[i] = remap[S.rows[i]];
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
