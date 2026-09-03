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
const DASHBOARD_SCHEMA_VERSION = 'pick-units-v24-sheet-master-all-items';
const MAX_UPLOAD_ROWS = 100000;
const MAX_POST_BYTES = 12 * 1024 * 1024;
const MAX_UPLOAD_CHUNKS = 100;
const MAX_UPLOAD_CHUNK_ROWS = 8000;
const UPLOAD_RECEIPT_PREFIX = 'upload_receipt_v1_';
const UPLOAD_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_RECEIPT_TABLE = 'pick_upload_receipts';
const JOB_DEADLINE_MS = 240000;
// ลดจำนวนรอบเรียก jobs.getQueryResults: ชุดข้อมูลปัจจุบัน ~410k แถว
// เดิมอ่านครั้งละ 10k ทำให้ต้องเรียก API มากกว่า 40 รอบต่อการเปิดเว็บหนึ่งครั้ง
const BQ_RESULT_PAGE_ROWS = 30000;
// ==========================================================

const MASTER_CACHE_TTL = 21600; // Master/BigQuery payload cache 6 ชม. เพื่อลด cold rebuild ของ Apps Script
const PICKER_ROSTER_CACHE_TTL = 300; // รายชื่อพนักงานอ่านจาก Google Sheet ใหม่อย่างน้อยทุก 5 นาที
const CACHE_TTL = MASTER_CACHE_TTL; // Payload cache ใช้หน้าต่างเดียวกับ revision เพื่อลด cache chunk เก่าค้าง
const CACHE_REVISION_PROPERTY = 'dash_data_revision';
const DASHBOARD_MIN_DATE_PROPERTY = 'dash_min_calendar_date_v4';
const DASHBOARD_MAX_DATE_PROPERTY = 'dash_max_calendar_date_v4';
const SHARED_EXCLUSIONS_PROPERTY = 'dashboard_shared_exclusions_v1';
const DASHBOARD_CACHE_FORMAT_VERSION = 'speed-v18-sheet-master-all-items';
const CACHE_CHUNK_CHARS = 60000; // base64 เป็น ASCII; ต่ำกว่าขีดจำกัด 100 KB ต่อ key ของ CacheService
const CACHE_CODEC = 'gzip-base64-v1';
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
const DASHBOARD_TABLE = 't_pick_dashboard'; // Materialized + stable history; upload ใหม่ MERGE เฉพาะ PickDetailKey
// =======================================================

function doGet(e) {
  try {
    // mode=revision เป็นคำตอบขนาดเล็กสำหรับหน้าเว็บที่มี IndexedDB cache อยู่แล้ว
    // ช่วยไม่ต้องดาวน์โหลด dashboard หลาย MB ซ้ำเมื่อข้อมูล BigQuery ยังไม่เปลี่ยน
    const mode = String(e && e.parameter && e.parameter.mode || '').toLowerCase();
    const wantsGzipEnvelope = String(e && e.parameter && e.parameter.encoding || '').toLowerCase() === 'gzip';
    const requestScope = getDashboardRequestScope_(e);
    if (mode === 'dashboard_exclusions') {
      return json_(getSharedDashboardExclusions_());
    }
    // Roster เป็น payload เล็กจาก Google Sheet โดยตรง ไม่ Query BigQuery
    // fresh=1 ใช้กับปุ่ม "อัปเดตรายชื่อ Picker" เพื่อบังคับอ่านชีตใหม่ทันที
    if (mode === 'roster') {
      const forceRoster = String(e && e.parameter && e.parameter.fresh || '') === '1';
      const rosterPayload = buildPickerRosterPayload_(forceRoster);
      rosterPayload.picker_sunday_ot = loadPickerSundayOtCalendar_(forceRoster);
      return json_(rosterPayload);
    }
    // รายการ SKU รายพนักงานมีจำนวนมากกว่าข้อมูลสรุปหลัก จึงโหลดเฉพาะ
    // เมื่อผู้ใช้เปิดรายละเอียดพนักงานคนนั้น เพื่อไม่ให้หน้าแรกต้องแบกทุก SKU
    if (mode === 'picker_items') {
      return json_(buildPickerItemsData_(e, requestScope));
    }
    // Master_Item เป็นฐานรายการสินค้า โหลดแยกหนึ่งครั้ง แล้วหน้าเว็บแมปด้วย Owner + Item
    if (mode === 'item_master') {
      const masterEpoch = getDashboardDataEpoch_();
      const masterRevision = getItemMasterCacheRevision_(masterEpoch);
      try {
        if (wantsGzipEnvelope) {
          const encodedMaster = getCachedEncoded_(masterRevision);
          if (encodedMaster) return gzipEnvelope_(encodedMaster);
        } else {
          const cachedMaster = getCached_(masterRevision);
          if (cachedMaster) return textJson_(cachedMaster);
        }
      } catch (masterCacheReadErr) {
        console.warn('Item master cache read failed: ' + masterCacheReadErr);
      }
      const masterJson = JSON.stringify(buildItemMasterData_(masterEpoch));
      let encodedMasterJson = null;
      try {
        encodedMasterJson = setCached_(masterJson, masterRevision);
      } catch (masterCacheWriteErr) {
        console.warn('Item master cache write failed: ' + masterCacheWriteErr);
      }
      if (wantsGzipEnvelope && encodedMasterJson) return gzipEnvelope_(encodedMasterJson);
      return textJson_(masterJson);
    }
    // Item cube มีจำนวนแถวมากที่สุด จึงแยกโหลดเฉพาะเมื่อเปิดหน้าสินค้าหรือรายละเอียด Zone
    // เพื่อลด payload หน้าแรกและหลีกเลี่ยง timeout ระหว่าง Apps Script -> browser
    if (mode === 'item_cube') {
      const itemEpoch = getDashboardDataEpoch_();
      const itemRevision = getItemCubeCacheRevision_(e, itemEpoch);
      try {
        if (wantsGzipEnvelope) {
          const encodedItems = getCachedEncoded_(itemRevision);
          if (encodedItems) return gzipEnvelope_(encodedItems);
        } else {
          const cachedItems = getCached_(itemRevision);
          if (cachedItems) return textJson_(cachedItems);
        }
      } catch (itemCacheReadErr) {
        console.warn('Item cube cache read failed: ' + itemCacheReadErr);
      }
      const itemJson = JSON.stringify(buildItemCubeData_(e, itemEpoch));
      let encodedItemJson = null;
      try {
        encodedItemJson = setCached_(itemJson, itemRevision);
      } catch (itemCacheWriteErr) {
        console.warn('Item cube cache write failed: ' + itemCacheWriteErr);
      }
      if (wantsGzipEnvelope && encodedItemJson) return gzipEnvelope_(encodedItemJson);
      return textJson_(itemJson);
    }
    // Time-slot cube แยกจาก payload หลักเช่นเดียวกับ Item เพื่อให้หน้าแรกและหน้าพนักงาน
    // ตอบกลับได้เร็วแม้ Script Cache หมดอายุ
    if (mode === 'slot_cube') {
      const slotEpoch = getDashboardDataEpoch_();
      const slotRevision = getSlotCubeCacheRevision_(e, requestScope, slotEpoch);
      try {
        if (wantsGzipEnvelope) {
          const encodedSlots = getCachedEncoded_(slotRevision);
          if (encodedSlots) return gzipEnvelope_(encodedSlots);
        } else {
          const cachedSlots = getCached_(slotRevision);
          if (cachedSlots) return textJson_(cachedSlots);
        }
      } catch (slotCacheReadErr) {
        console.warn('Slot cube cache read failed: ' + slotCacheReadErr);
      }
      const slotJson = JSON.stringify(buildSlotCubeData_(e, requestScope, slotEpoch));
      let encodedSlotJson = null;
      try {
        encodedSlotJson = setCached_(slotJson, slotRevision);
      } catch (slotCacheWriteErr) {
        console.warn('Slot cube cache write failed: ' + slotCacheWriteErr);
      }
      if (wantsGzipEnvelope && encodedSlotJson) return gzipEnvelope_(encodedSlotJson);
      return textJson_(slotJson);
    }
    const revision = getDashboardRevisionToken_(getDataRevision_(), requestScope.key);
    if (mode === 'revision') {
      const bounds = getOrLoadDashboardBounds_();
      return json_({
        schema_version: DASHBOARD_SCHEMA_VERSION,
        revision: revision,
        min_date: bounds.minDate,
        max_date: bounds.maxDate
      });
    }

    // fresh=1 ข้ามเฉพาะ Script Cache; BigQuery query cache ปลอดภัยเพราะ
    // BigQuery จะยกเลิกผล cache เองเมื่อตารางต้นทางเปลี่ยน
    const fresh = !!(e && e.parameter && e.parameter.fresh === '1');
    if (!fresh) {
      try {
        if (wantsGzipEnvelope) {
          const encodedDashboard = getCachedEncoded_(revision);
          if (encodedDashboard) return gzipEnvelope_(encodedDashboard);
        } else {
          const cached = getCached_(revision);
          if (cached) return textJson_(cached);
        }
      } catch (cacheReadErr) {
        console.warn('Dashboard cache read failed: ' + cacheReadErr);
      }
    }
    // กัน cache miss พร้อมกันหลายหน้าต่างยิง query หลายแสนแถวซ้ำกัน
    // ผู้รอจะตรวจ cache ซ้ำหลังคำขอแรกสร้างเสร็จ (double-checked cache)
    const dashboardBuildLock = LockService.getScriptLock();
    let dashboardBuildLocked = false;
    try {
      dashboardBuildLocked = dashboardBuildLock.tryLock(90000);
      if (!dashboardBuildLocked) {
        throw uploadError_('DASHBOARD_UPDATE_BUSY', 'ระบบกำลังเตรียมข้อมูล Dashboard กรุณาลองอีกครั้งในอีกสักครู่');
      }
      if (getDashboardRevisionToken_(getDataRevision_(), requestScope.key) !== revision) {
        throw uploadError_('DATA_EPOCH_CHANGED', 'ข้อมูล BigQuery เปลี่ยนระหว่างโหลด กรุณาลองใหม่อีกครั้ง');
      }
      if (!fresh) {
        try {
          if (wantsGzipEnvelope) {
            const encodedAfterWait = getCachedEncoded_(revision);
            if (encodedAfterWait) return gzipEnvelope_(encodedAfterWait);
          } else {
            const cachedAfterWait = getCached_(revision);
            if (cachedAfterWait) return textJson_(cachedAfterWait);
          }
        } catch (cacheReadAfterWaitErr) {
          console.warn('Dashboard cache read after wait failed: ' + cacheReadAfterWaitErr);
        }
      }

      const dataObj = buildDashboardData_(false, requestScope);
      dataObj.meta.data_revision = revision;
      const json = JSON.stringify(dataObj);
      let encodedJson = null;
      try {
        // กัน GET เก่าที่เริ่มก่อน upload เขียน cache ทับข้อมูลรุ่นใหม่
        if (getDashboardRevisionToken_(getDataRevision_(), requestScope.key) === revision) {
          encodedJson = setCached_(json, revision);
        }
      } catch (cacheWriteErr) {
        console.warn('Dashboard cache write failed: ' + cacheWriteErr);
      }
      if (wantsGzipEnvelope && encodedJson) return gzipEnvelope_(encodedJson);
      return textJson_(json);
    } finally {
      if (dashboardBuildLocked) dashboardBuildLock.releaseLock();
    }
  } catch (err) {
    return json_({ error: String(err && err.message || err), code: String(err && err.code || '') });
  }
}

function getDataRevision_() {
  return PropertiesService.getScriptProperties().getProperty(CACHE_REVISION_PROPERTY) || '0';
}

function getSharedDashboardExclusions_() {
  const raw = PropertiesService.getScriptProperties().getProperty(SHARED_EXCLUSIONS_PROPERTY);
  if (!raw) return { status: 'success', version: 1, initialized: false, items: [], zones: [], updated_at: '' };
  try {
    const parsed = JSON.parse(raw);
    return {
      status: 'success',
      version: 1,
      initialized: true,
      items: Array.isArray(parsed.items) ? parsed.items : [],
      zones: Array.isArray(parsed.zones) ? parsed.zones : [],
      updated_at: String(parsed.updated_at || '')
    };
  } catch (_) {
    return { status: 'success', version: 1, initialized: false, items: [], zones: [], updated_at: '' };
  }
}

function saveSharedDashboardExclusions_(postData) {
  const scope = getDashboardRequestScope_({
    parameter: { excluded_items: JSON.stringify(Array.isArray(postData.items) ? postData.items : []) }
  });
  const seenZones = {};
  const zones = (Array.isArray(postData.zones) ? postData.zones : []).slice(0, 200).map(function(value) {
    return String(value == null ? '' : value).replace(/\u00a0/g, ' ').trim().toUpperCase();
  }).filter(function(value) {
    if (!value || value.length > 40 || seenZones[value]) return false;
    seenZones[value] = true;
    return true;
  }).sort();
  const payload = {
    version: 1,
    initialized: true,
    items: scope.excludedItems,
    zones: zones,
    updated_at: new Date().toISOString()
  };
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    PropertiesService.getScriptProperties().setProperty(SHARED_EXCLUSIONS_PROPERTY, JSON.stringify(payload));
  } finally {
    lock.releaseLock();
  }
  return Object.assign({ status: 'success' }, payload);
}

function getDashboardRefreshBucket_() {
  return Math.floor(Date.now() / (MASTER_CACHE_TTL * 1000));
}

function getDashboardRevisionToken_(dataRevision, requestScopeKey) {
  // Uploads bump dataRevision immediately. The time bucket also detects data
  // changed outside this endpoint (BigQuery or master Sheets) within 15 minutes.
  return getDashboardDataEpoch_(dataRevision) + ':' + String(requestScopeKey || 'all');
}

function getDashboardDataEpoch_(dataRevision) {
  return DASHBOARD_CACHE_FORMAT_VERSION + ':' + String(dataRevision == null ? getDataRevision_() : dataRevision) + ':' + getDashboardRefreshBucket_();
}

function assertDashboardDataEpochStable_(expectedEpoch) {
  // Read-only payload builders do not need to acquire ScriptLock here.
  // Upload/merge paths already own their own lock and bump data revision after commit.
  // Removing this extra LockService round-trip also avoids intermittent Apps Script
  // internal "We're sorry, a server error occurred" failures after a successful BigQuery read.
  if (getDashboardDataEpoch_() !== String(expectedEpoch || '')) {
    throw uploadError_('DATA_EPOCH_CHANGED', 'ข้อมูล BigQuery เปลี่ยนระหว่างโหลด กรุณาลองใหม่อีกครั้ง');
  }
}

function getDashboardRequestScope_(e) {
  const params = e && e.parameter || {};
  let requestedItems = [];
  let legacySkus = [];
  try {
    const parsed = JSON.parse(String(params.excluded_items || '[]'));
    if (Array.isArray(parsed)) requestedItems = parsed;
  } catch (_) {}
  try {
    const parsedLegacy = JSON.parse(String(params.excluded_skus || '[]'));
    if (Array.isArray(parsedLegacy)) legacySkus = parsedLegacy;
  } catch (_) {}

  const seen = {};
  const excludedItems = [];
  const addItem = function(ownerValue, itemValue) {
    const owner = String(ownerValue == null ? '' : ownerValue).replace(/\u00a0/g, ' ').trim().toUpperCase();
    let item = String(itemValue == null ? '' : itemValue).replace(/\u00a0/g, ' ').trim();
    if (/^\d+\.0+$/.test(item)) item = item.slice(0, item.indexOf('.'));
    if (!owner || !item || owner.length > 80 || item.length > 80) return;
    const composite = owner + '\u0001' + item;
    if (seen[composite]) return;
    seen[composite] = true;
    excludedItems.push({ owner: owner, item: item });
  };

  requestedItems.slice(0, 500).forEach(function(value) {
    if (value && typeof value === 'object') {
      addItem(value.owner, value.item == null ? value.sku : value.item);
      return;
    }
    const raw = String(value == null ? '' : value);
    const separator = raw.indexOf('\u0001') >= 0 ? '\u0001' : '|';
    const pos = raw.indexOf(separator);
    if (pos > 0) addItem(raw.slice(0, pos), raw.slice(pos + separator.length));
  });
  // รายการยกเว้นรุ่นเก่าใช้เฉพาะ SKU: เก็บเป็น Owner=* เพื่อให้ยังทำงานได้ทุก Owner
  legacySkus.slice(0, 500).forEach(function(value) { addItem('*', value); });

  excludedItems.sort(function(a, b) {
    return a.owner.localeCompare(b.owner) || a.item.localeCompare(b.item);
  });
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(excludedItems),
    Utilities.Charset.UTF_8
  );
  const key = Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '').slice(0, 16);
  return { excludedItems: excludedItems, excludedSkus: [], key: key };
}

function sqlStringLiteral_(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "''") + "'";
}

function pickerSundayOtCacheKey_() {
  return 'picker_sunday_ot_calendar_v1';
}

function parsePickerSundayOtDate_(value, year, month) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{1,2})[-\/]([A-Za-z]{3}|\d{1,2})(?:[-\/](\d{2,4}))?$/);
  if (!match) return '';
  const day = Number(match[1]);
  let parsedMonth = Number(match[2]);
  if (!Number.isFinite(parsedMonth)) {
    const names = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };
    parsedMonth = names[String(match[2]).toUpperCase()] || month;
  }
  let parsedYear = match[3] ? Number(match[3]) : year;
  if (parsedYear < 100) parsedYear += 2000;
  if (!day || !parsedMonth || !parsedYear) return '';
  return Utilities.formatString('%04d-%02d-%02d', parsedYear, parsedMonth, day);
}

function parsePickerOtHours_(value) {
  const text = String(value == null ? '' : value).replace(/,/g, '').trim();
  if (!text || text === '-' || /^sun(day)?$/i.test(text)) return 0;
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

// Sunday OT calendar เก็บไว้เป็น roster/planning metadata เท่านั้น
// ปฏิทิน Sunday OT ใช้เป็น metadata เท่านั้น; วันที่ Dashboard ใช้ Calendar Date หลัง Normalize เสมอ
function loadPickerSundayOtCalendar_(forceRefresh) {
  const cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    try {
      const cached = cache.get(pickerSundayOtCacheKey_());
      if (cached) return JSON.parse(cached);
    } catch (_) {}
  }
  const result = { status:{}, sources:[], loadedAt:new Date().toISOString() };
  try {
    const ss = SpreadsheetApp.openById(PICKER_NAME_SHEET_ID);
    ss.getSheets().forEach(function(sheet) {
      const title = String(sheet.getName() || '').trim();
      const match = title.match(/^OT_([A-Za-z]{3})(\d{4})$/i);
      if (!match) return;
      const months = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };
      const month = months[String(match[1]).toUpperCase()];
      const year = Number(match[2]);
      if (!month || !year) return;
      const values = sheet.getDataRange().getDisplayValues();
      if (!values.length) return;
      let dateRow = -1, pickerRow = -1, bestDateCount = 0;
      for (let r = 0; r < values.length; r++) {
        const dateCount = values[r].reduce(function(count, cell) {
          return count + (parsePickerSundayOtDate_(cell, year, month) ? 1 : 0);
        }, 0);
        if (dateCount > bestDateCount) {
          bestDateCount = dateCount;
          dateRow = r;
        }
        if (pickerRow < 0 && values[r].some(function(cell) { return String(cell || '').trim().toUpperCase() === 'PICKER'; })) pickerRow = r;
      }
      if (dateRow < 0 || pickerRow < 0 || bestDateCount < 2) return;
      const dates = values[dateRow];
      const picker = values[pickerRow];
      for (let c = 0; c < Math.min(dates.length, picker.length); c++) {
        const date = parsePickerSundayOtDate_(dates[c], year, month);
        if (!date) continue;
        const parsed = new Date(date + 'T00:00:00+07:00');
        if (parsed.getDay() !== 0) continue;
        result.status[date] = parsePickerOtHours_(picker[c]) > 0;
      }
      result.sources.push(title);
    });
  } catch (err) {
    console.warn('loadPickerSundayOtCalendar_ failed: ' + err);
  }
  try { cache.put(pickerSundayOtCacheKey_(), JSON.stringify(result), PICKER_ROSTER_CACHE_TTL); } catch (_) {}
  return result;
}

// Calendar Date หลัง Normalize:
// PTT ถูกลบ 7 ชั่วโมงตั้งแต่ v_pick_clean, BPS ใช้เวลาเดิม
// 00:00–06:59 ยังคงเป็นวันที่ปฏิทินนั้น ไม่ย้อนกลับไปวันก่อน
function dashboardShiftDateSql_(pickDateExpression, tminExpression) {
  return String(pickDateExpression || 'pick_date');
}

// กะคลัง 24 ชม. ต้องตัดจาก normalized timestamp เท่านั้น
// A = 07:00–18:59, B = 19:00–06:59; ห้ามใช้ Team roster มา override ผลงานจริง
function dashboardShiftCodeSql_(tminExpression) {
  const t = String(tminExpression || 'tmin');
  return "IF(" + t + " >= 420 AND " + t + " < 1140, 'M', 'N')";
}


function dashboardExclusionSql_(scope, ownerExpression, itemExpression) {
  const items = scope && Array.isArray(scope.excludedItems) ? scope.excludedItems : [];
  if (!items.length) return '';
  const wildcardItems = [];
  const exact = [];
  items.forEach(function(entry) {
    const owner = String(entry && entry.owner || '').trim().toUpperCase();
    const item = String(entry && entry.item || '').trim();
    if (!owner || !item) return;
    if (owner === '*') wildcardItems.push(item);
    else exact.push('(' + ownerExpression + ' = ' + sqlStringLiteral_(owner) +
      ' AND ' + itemExpression + ' = ' + sqlStringLiteral_(item) + ')');
  });
  const conditions = [];
  if (wildcardItems.length) {
    conditions.push(itemExpression + ' NOT IN (' + wildcardItems.map(sqlStringLiteral_).join(',') + ')');
  }
  if (exact.length) conditions.push('NOT (' + exact.join(' OR ') + ')');
  return conditions.length ? 'AND ' + conditions.join(' AND ') : '';
}

function getItemMasterCacheRevision_(dataEpoch) {
  const epoch = String(dataEpoch || getDashboardDataEpoch_()).replace(/:/g, '_');
  return 'item_master_' + epoch;
}

function getItemCubeCacheRevision_(e, dataEpoch) {
  const params = e && e.parameter || {};
  const requestScope = getDashboardRequestScope_(e);
  const scope = [
    String(params.system || '').toUpperCase(),
    String(params.from || ''),
    String(params.to || ''),
    String(params.shift || 'all').toLowerCase(),
    String(requestScope && requestScope.key || 'all')
  ];
  const epoch = String(dataEpoch || getDashboardDataEpoch_()).replace(/:/g, '_');
  return 'item_' + epoch + '_' +
    sha256Hex_(JSON.stringify(scope)).slice(0, 24);
}

function getSlotCubeCacheRevision_(e, requestScope, dataEpoch) {
  const params = e && e.parameter || {};
  const scope = [
    String(params.system || '').toUpperCase(),
    String(params.from || ''),
    String(params.to || ''),
    String(params.shift || 'all').toLowerCase(),
    String(requestScope && requestScope.key || 'all')
  ];
  const epoch = String(dataEpoch || getDashboardDataEpoch_()).replace(/:/g, '_');
  return 'slot_' + epoch + '_' +
    sha256Hex_(JSON.stringify(scope)).slice(0, 24);
}

function buildItemMasterData_(dataEpoch) {
  const expectedEpoch = String(dataEpoch || getDashboardDataEpoch_());
  if (getDashboardDataEpoch_() !== expectedEpoch) {
    throw uploadError_('DATA_EPOCH_CHANGED', 'ข้อมูล Master เปลี่ยนก่อนเริ่มโหลด กรุณาลองใหม่อีกครั้ง');
  }
  // หน้า Items ใช้ Google Sheet เป็นรายการตั้งต้นโดยตรง เพื่อให้สินค้าที่ไม่เคยมี
  // Pick Detail ยังแสดงเป็นยอด 0 ได้ ส่วนยอด pcs/pick_qty จะ LEFT JOIN ใน browser
  // จาก Item Cube ของ BigQuery ภายหลัง การคำนวณ UOM ใน BigQuery ไม่ถูกแก้ไขตรงนี้
  const itemSs = SpreadsheetApp.openById(MASTER_ITEM_SHEET_ID);
  const itemSheet = itemSs.getSheetByName(MASTER_ITEM_TAB);
  if (!itemSheet) throw uploadError_('MASTER_ITEM_TAB_NOT_FOUND', 'ไม่พบ Sheet ' + MASTER_ITEM_TAB + ' ใน Master_Item');
  const lastRow = itemSheet.getLastRow();
  const rows = [];
  if (lastRow >= MASTER_ITEM_FIRST_DATA_ROW) {
    const count = lastRow - MASTER_ITEM_FIRST_DATA_ROW + 1;
    const base = itemSheet.getRange(MASTER_ITEM_FIRST_DATA_ROW, 2, count, 4).getDisplayValues();
    const pickTypes = itemSheet.getRange(MASTER_ITEM_FIRST_DATA_ROW, 272, count, 1).getDisplayValues();
    const seen = Object.create(null);
    base.forEach(function(r, index) {
      const owner = String(r[0] || '').trim().toUpperCase();
      const item = String(r[1] || '').trim().replace(/\.0+$/, '');
      if (!owner || !item) return;
      if (owner !== 'DM02' && owner !== 'DP02' && owner !== 'DG02' && owner !== 'DCWN') return;
      const key = owner + '|' + item;
      if (seen[key]) return;
      seen[key] = true;
      rows.push(
        owner, item, String(r[2] || item).trim(),
        String(pickTypes[index] && pickTypes[index][0] || '').trim(),
        String(r[3] || '').trim(), null, null, null, 'SHEET_MASTER'
      );
    });
  }
  assertDashboardDataEpochStable_(expectedEpoch);
  return {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    data_epoch: expectedEpoch,
    row_width: 9,
    rows: rows,
    generated: new Date().toISOString()
  };
}

function buildItemCubeData_(e, dataEpoch) {
  const params = e && e.parameter || {};
  const system = String(params.system || '').toUpperCase();
  const from = String(params.from || '').trim();
  const to = String(params.to || '').trim();
  const shift = String(params.shift || 'all').toLowerCase();
  const expectedEpoch = String(dataEpoch || getDashboardDataEpoch_());
  if (system !== 'PTT' && system !== 'BPS') throw new Error('ระบบที่ขอไม่ถูกต้อง');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw new Error('ช่วงวันที่ไม่ถูกต้อง');
  }
  if (shift !== 'all' && shift !== 'morning' && shift !== 'night' && shift !== 'not_found') throw new Error('กะไม่ถูกต้อง');
  if (getDashboardDataEpoch_() !== expectedEpoch) {
    throw uploadError_('DATA_EPOCH_CHANGED', 'ข้อมูล BigQuery เปลี่ยนก่อนเริ่มโหลด กรุณาลองใหม่อีกครั้ง');
  }

  const scope = getDashboardRequestScope_(e);
  const ownerExpr = "UPPER(COALESCE(owner, '-'))";
  const skuExpr = "REGEXP_REPLACE(COALESCE(CAST(sku AS STRING), '(none)'), r'\\.0+$', '')";
  const excludedSql = dashboardExclusionSql_(scope, ownerExpr, skuExpr);

  // ถ้าเลือกทุกกะ ไม่ต้องโหลด Picker roster/สร้าง CASE team ใน SQL เลย
  // ช่วยให้หน้า Items ตอบเร็วขึ้นมาก โดยเฉพาะช่วงวันที่ยาว
  let shiftSql = '';
  if (shift !== 'all') {
    const teamCode = shift === 'morning' ? 'A' : (shift === 'night' ? 'B' : 'X');
    shiftSql = '    AND ' + pickerRosterTeamCodeSql_('picker_id') + ' = ' + sqlStringLiteral_(teamCode);
  }

  // Item Cube:
  // 1) partition prune ด้วย pick_date
  // 2) cluster prune ด้วย category + owner
  // 3) aggregate ที่ BigQuery ก่อนส่ง Browser (ทุก Owner ใน Master_Item)
  const sql = [
    'SELECT',
    "  COALESCE(location, zone, '??') AS location_key,",
    "  COALESCE(zone, '??') AS zone_key,",
    '  ' + ownerExpr + ' AS owner_key,',
    '  ' + skuExpr + ' AS sku_key,',
    '  SUM(pcs) AS total_pcs,',
    '  SUM(pick_qty) AS total_pick_qty,',
    '  COUNT(*) AS total_lines',
    'FROM `' + BQ_PROJECT + '.' + BQ_DATASET + '.' + DASHBOARD_TABLE + '`',
    'WHERE UPPER(category) = ' + sqlStringLiteral_(system),
    '  AND pick_date BETWEEN DATE ' + sqlStringLiteral_(from) + ' AND DATE ' + sqlStringLiteral_(to),
    '  AND (COALESCE(pcs, 0) != 0 OR COALESCE(pick_qty, 0) != 0)',
    shiftSql,
    '  ' + excludedSql,
    'GROUP BY 1, 2, 3, 4',
    'ORDER BY owner_key, sku_key, zone_key, location_key'
  ].filter(function(line) { return String(line || '').trim() !== ''; }).join('\n');

  const rows = [];
  bqQueryEach_(sql, function(r) {
    rows.push(
      String(r[0] || '??'), String(r[1] || '??'), String(r[2] || '-'), String(r[3] || '(none)'),
      Number(r[4]) || 0, Number(r[5]) || 0, Number(r[6]) || 0
    );
  }, JOB_DEADLINE_MS, true);
  assertDashboardDataEpochStable_(expectedEpoch);

  return {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    data_epoch: expectedEpoch,
    system: system,
    from: from,
    to: to,
    shift: shift,
    row_width: 7,
    rows: rows,
    generated: new Date().toISOString()
  };
}

function buildSlotCubeData_(e, requestScope, dataEpoch) {
  const params = e && e.parameter || {};
  const system = String(params.system || '').toUpperCase();
  const from = String(params.from || '').trim();
  const to = String(params.to || '').trim();
  const shift = String(params.shift || 'all').toLowerCase();
  const expectedEpoch = String(dataEpoch || getDashboardDataEpoch_());
  if (system !== 'PTT' && system !== 'BPS') throw new Error('ระบบที่ขอไม่ถูกต้อง');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw new Error('ช่วงวันที่ไม่ถูกต้อง');
  }
  if (shift !== 'all' && shift !== 'morning' && shift !== 'night' && shift !== 'not_found') throw new Error('กะไม่ถูกต้อง');

  if (getDashboardDataEpoch_() !== expectedEpoch) {
    throw uploadError_('DATA_EPOCH_CHANGED', 'ข้อมูล BigQuery เปลี่ยนก่อนเริ่มโหลด กรุณาลองใหม่อีกครั้ง');
  }
  const scope = requestScope || { excludedItems: [] };
  const excludedSql = dashboardExclusionSql_(scope, 'owner_key', 'sku_key');
  const shiftSql = shift === 'morning'
    ? "AND report_team = 'A'"
    : (shift === 'night' ? "AND report_team = 'B'" : (shift === 'not_found' ? "AND report_team = 'X'" : ''));
  const sql = [
    'WITH base AS (',
    '  SELECT',
    '    ' + dashboardShiftDateSql_('pick_date', 'tmin') + ' AS shift_date,',
    '    ' + pickerRosterTeamCodeSql_('picker_id') + ' AS report_team,',
    "    UPPER(COALESCE(owner, '-')) AS owner_key,",
    "    REGEXP_REPLACE(COALESCE(CAST(sku AS STRING), '(none)'), r'\\.0+$', '') AS sku_key,",
    '    CAST(DIV(tmin, 60) AS INT64) AS hour_of_day,',
    '    pcs, pick_qty',
    '  FROM `' + BQ_PROJECT + '.' + BQ_DATASET + '.' + DASHBOARD_TABLE + '`',
    '  WHERE UPPER(category) = ' + sqlStringLiteral_(system),
    "    AND pick_date >= DATE_SUB(CURRENT_DATE('Asia/Bangkok'), INTERVAL " + RECENT_DAYS + ' DAY)',
    '    AND pick_date BETWEEN DATE ' + sqlStringLiteral_(from) + ' AND DATE ' + sqlStringLiteral_(to),
    '),',
    'filtered AS (',
    '  SELECT * FROM base',
    '  WHERE shift_date BETWEEN DATE ' + sqlStringLiteral_(from) + ' AND DATE ' + sqlStringLiteral_(to),
    '    ' + shiftSql,
    '    ' + excludedSql,
    ')',
    "SELECT FORMAT_DATE('%Y-%m-%d', shift_date), report_team, hour_of_day,",
    '       SUM(pcs), SUM(pick_qty), COUNT(*)',
    'FROM filtered',
    'GROUP BY shift_date, report_team, hour_of_day',
    'ORDER BY shift_date, report_team, hour_of_day'
  ].join('\n');

  const rows = [];
  bqQueryEach_(sql, function(r) {
    rows.push(
      String(r[0] || ''), r[1] === 'X' ? 2 : (r[1] === 'B' ? 1 : 0),
      Number(r[2]) || 0, Number(r[3]) || 0,
      Number(r[4]) || 0, Number(r[5]) || 0
    );
  }, JOB_DEADLINE_MS, true);
  assertDashboardDataEpochStable_(expectedEpoch);

  return {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    data_epoch: expectedEpoch,
    system: system,
    from: from,
    to: to,
    shift: shift,
    row_width: 6,
    rows: rows,
    generated: new Date().toISOString()
  };
}

function buildPickerItemsData_(e, requestScope) {
  const params = e && e.parameter || {};
  const system = String(params.system || '').toUpperCase();
  const picker = String(params.picker || '').replace(/\u00a0/g, ' ').trim();
  const from = String(params.from || '').trim();
  const to = String(params.to || '').trim();
  const shift = String(params.shift || 'all').toLowerCase();
  if (system !== 'PTT' && system !== 'BPS') throw new Error('ระบบที่ขอไม่ถูกต้อง');
  if (!picker || picker.length > 80) throw new Error('รหัสพนักงานไม่ถูกต้อง');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw new Error('ช่วงวันที่ไม่ถูกต้อง');
  }
  if (shift !== 'all' && shift !== 'morning' && shift !== 'night' && shift !== 'not_found') throw new Error('กะไม่ถูกต้อง');

  const scope = requestScope || { excludedItems: [] };
  const excludedSql = dashboardExclusionSql_(scope, 'owner_key', 'sku_key');
  // This endpoint is already scoped to one picker. Team filtering is performed
  // from picker_roster_teams in the client; keep all time bands for work/OT detail.
  const shiftSql = '';
  const sql = [
    'WITH base AS (',
    '  SELECT',
    '    ' + dashboardShiftDateSql_('pick_date', 'tmin') + ' AS shift_date,',
    '    ' + dashboardShiftCodeSql_('tmin') + ' AS shift_code,',
    "    COALESCE(zone, '??') AS zone,",
    "    UPPER(COALESCE(owner, '-')) AS owner_key,",
    "    COALESCE(CAST(sku AS STRING), '(none)') AS sku,",
    "    REGEXP_REPLACE(COALESCE(CAST(sku AS STRING), '(none)'), r'\\.0+$', '') AS sku_key,",
    '    pcs, pick_qty',
    '  FROM `' + BQ_PROJECT + '.' + BQ_DATASET + '.' + DASHBOARD_TABLE + '`',
    '  WHERE UPPER(category) = ' + sqlStringLiteral_(system),
    "    AND pick_date >= DATE_SUB(CURRENT_DATE('Asia/Bangkok'), INTERVAL " + RECENT_DAYS + ' DAY)',
    // Calendar Date อ่านเฉพาะช่วง [from,to] เท่านั้น ไม่ดึงวันถัดไปมาปน
    '    AND pick_date BETWEEN DATE ' + sqlStringLiteral_(from) + ' AND DATE ' + sqlStringLiteral_(to),
    '    AND COALESCE(CAST(picker_id AS STRING), \'(none)\') = ' + sqlStringLiteral_(picker),
    '),',
    'filtered AS (',
    '  SELECT * FROM base',
    '  WHERE shift_date BETWEEN DATE ' + sqlStringLiteral_(from) + ' AND DATE ' + sqlStringLiteral_(to),
    '    ' + shiftSql,
    '    ' + excludedSql,
    ')',
    "SELECT FORMAT_DATE('%Y-%m-%d', shift_date), shift_code, zone, owner_key, sku,",
    '       SUM(pcs), SUM(pick_qty), COUNT(*)',
    'FROM filtered',
    'GROUP BY shift_date, shift_code, zone, owner_key, sku',
    'ORDER BY shift_date, zone, owner_key, sku'
  ].join('\n');

  const rows = [];
  bqQueryEach_(sql, function(r) {
    rows.push(
      String(r[0] || ''), r[1] === 'N' ? 1 : 0,
      String(r[2] || '??'), String(r[3] || '-'), String(r[4] || '(none)'),
      Number(r[5]) || 0, Number(r[6]) || 0, Number(r[7]) || 0
    );
  }, JOB_DEADLINE_MS, true);

  return {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    picker: picker,
    system: system,
    row_width: 8,
    rows: rows,
    excluded_items: scope.excludedItems || [],
    generated: new Date().toISOString()
  };
}

function bumpDataRevision_() {
  PropertiesService.getScriptProperties().setProperty(
    CACHE_REVISION_PROPERTY,
    String(Date.now())
  );
}

function getDashboardBounds_() {
  const properties = PropertiesService.getScriptProperties();
  return {
    minDate: properties.getProperty(DASHBOARD_MIN_DATE_PROPERTY) || '',
    maxDate: properties.getProperty(DASHBOARD_MAX_DATE_PROPERTY) || ''
  };
}

function getOrLoadDashboardBounds_() {
  const existing = getDashboardBounds_();
  if (existing.minDate && existing.maxDate) return existing;

  try {
    const rows = bqQueryAll_(dashboardBoundsSql_(), 60000);
    if (rows.length && rows[0].length >= 2) {
      setDashboardBounds_(rows[0][0], rows[0][1]);
      return getDashboardBounds_();
    }
  } catch (boundsErr) {
    console.warn('Dashboard bounds lookup failed: ' + boundsErr);
  }
  return existing;
}

function dashboardBoundsSql_() {
  return [
    "SELECT FORMAT_DATE('%Y-%m-%d', MIN(shift_date)),",
    "       FORMAT_DATE('%Y-%m-%d', MAX(shift_date))",
    'FROM (',
    '  SELECT ' + dashboardShiftDateSql_('pick_date', 'tmin') + ' AS shift_date',
    '  FROM `' + BQ_PROJECT + '.' + BQ_DATASET + '.' + DASHBOARD_TABLE + '`',
    "  WHERE pick_date >= DATE_SUB(CURRENT_DATE('Asia/Bangkok'), INTERVAL " + RECENT_DAYS + ' DAY)',
    "    AND UPPER(category) IN ('PTT','BPS')",
    ')'
  ].join('\n');
}

function setDashboardBounds_(minDate, maxDate) {
  const minValue = String(minDate || '');
  const maxValue = String(maxDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(minValue) || !/^\d{4}-\d{2}-\d{2}$/.test(maxValue)) return;
  PropertiesService.getScriptProperties().setProperties({
    [DASHBOARD_MIN_DATE_PROPERTY]: minValue,
    [DASHBOARD_MAX_DATE_PROPERTY]: maxValue
  }, false);
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
      const cnt = parseInt(n, 10), keys = [prefix + 'n', prefix + 'codec'];
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
    if (postData.action === 'set_dashboard_exclusions') {
      return json_(saveSharedDashboardExclusions_(postData));
    }
    // รุ่นใหม่: Browser อ่าน XLSX แล้วส่งเฉพาะ 11 คอลัมน์เป็น CSV UTF-8
    if (postData.action === 'upload_chunk_csv' && typeof postData.csv === 'string') {
      const chunkResult = uploadChunkToBigQuery_(postData);
      return json_(Object.assign({ status: 'success' }, chunkResult));
    }
    // รองรับหน้าเว็บรุ่นเดิมที่ยังส่ง Array/JSON
    if (postData.action === 'upload_chunk' && Array.isArray(postData.rows)) {
      const chunkResult = uploadChunkToBigQuery_(postData);
      return json_(Object.assign({ status: 'success' }, chunkResult));
    }
    if (postData.action === 'upload_commit') {
      const commitResult = commitUploadChunks_(postData);
      return json_(Object.assign({ status: 'success' }, commitResult));
    }
    if (postData.action === 'upload_rows' && Array.isArray(postData.rows)) {
      const result = uploadToBigQuery_(postData.rows, postData.fmt, postData.meta || {});
      return json_(Object.assign({ status: 'success' }, result));
    }
    return json_({ status: 'error', code: 'INVALID_ACTION', message: 'คำสั่งหรือข้อมูลแถวไม่ถูกต้อง' });
  } catch (err) {
    const details = err && err.uploadDetails ? err.uploadDetails : null;
    const code = err && err.code ? err.code : 'UPLOAD_FAILED';
    const rawMsg = String(err && (err.message || err) || 'เกิดข้อผิดพลาดในการนำเข้า BigQuery');
    return json_({
      status: 'error',
      code: code,
      message: rawMsg,
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
    // อัปเดตเฉพาะ PickDetailKey ที่มากับไฟล์นี้ เพื่อให้ประวัติวันเก่าไม่ถูกคำนวณใหม่
    // เมื่อมีไฟล์วันถัดไปเข้าระบบ (ยกเว้น key เดิมถูกแก้ไขจริงในไฟล์ใหม่)
    refreshPickDashboardRowsFromStage_(stageTable);
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

// อัปโหลดไฟล์ใหญ่แบบหลายคำขอ: แต่ละ chunk เขียนลงตารางชั่วคราวของตัวเองด้วย
// WRITE_TRUNCATE จึงส่งซ้ำได้อย่างปลอดภัยโดยไม่เพิ่มข้อมูลซ้ำ จากนั้น commit จึง Merge ครั้งเดียว
function uploadChunkToBigQuery_(request) {
  ensureUploadService_();
  validateUploadMeta_(request.meta || {});
  const envelope = validateUploadChunkEnvelope_(request);
  const isCsv = request.action === 'upload_chunk_csv';
  const rows = isCsv
    ? parseUploadCsvRows_(request.csv, request.rowCount, request.format)
    : (request.rows || []);

  if (!rows.length) throw uploadError_('EMPTY_CHUNK', 'ชุดข้อมูลที่ส่งมาว่างเปล่า');
  if (rows.length > MAX_UPLOAD_CHUNK_ROWS) {
    throw uploadError_(
      'CHUNK_TOO_LARGE',
      'ชุดข้อมูลมี ' + rows.length.toLocaleString() + ' แถว เกินขีดจำกัด ' +
        MAX_UPLOAD_CHUNK_ROWS.toLocaleString() + ' แถวต่อชุด'
    );
  }

  // CSV ที่ Browser ส่งมามีลำดับ 11 คอลัมน์เดียวกับ Array รุ่นเดิม
  const normalized = normalizeUploadRows_(rows, isCsv ? 'array' : request.fmt);
  if (normalized.errors.length > 0) {
    const err = uploadError_(
      'VALIDATION_FAILED',
      'ชุดที่ ' + (envelope.chunkIndex + 1) + ' พบข้อมูลไม่ถูกต้อง ' +
        normalized.errors.length.toLocaleString() + ' จุด'
    );
    err.uploadDetails = {
      chunkIndex: envelope.chunkIndex,
      counts: normalized.counts,
      errors: normalized.errors.slice(0, 100)
    };
    throw err;
  }

  const stageTable = uploadChunkTable_(envelope.sessionId, envelope.chunkIndex);
  let blob;
  let loadJob;
  if (isCsv) {
    // หลังตรวจซ้ำฝั่ง Server แล้ว สร้าง CSV มาตรฐานและให้ BigQuery โหลด CSV โดยตรง
    const normalizedCsv = normalized.rows.map(uploadNormalizedRowToCsvLine_).join('\n');
    blob = Utilities.newBlob(normalizedCsv, 'text/csv;charset=utf-8', stageTable + '.csv');
  } else {
    // เส้นทางสำรองสำหรับหน้าเว็บรุ่นเดิม
    const ndjson = normalized.rows.map(function(row) { return JSON.stringify(row); }).join('\n');
    blob = Utilities.newBlob(ndjson, 'application/octet-stream', stageTable + '.ndjson');
  }

  const normalizedBytes = blob.getBytes().length;
  if (normalizedBytes > MAX_POST_BYTES) {
    throw uploadError_(
      'NORMALIZED_CHUNK_TOO_LARGE',
      'ชุดที่ ' + (envelope.chunkIndex + 1) + ' ใหญ่เกินไปหลังตรวจสอบ กรุณารีเฟรชหน้าเว็บแล้วลองใหม่'
    );
  }

  const jobId = 'pick_chunk_' + envelope.sessionId.substring(0, 20) + '_' +
    envelope.chunkIndex + '_' + Utilities.getUuid().replace(/-/g, '').substring(0, 12);
  loadJob = isCsv
    ? startCsvLoadJob_(stageTable, jobId, blob, 'WRITE_TRUNCATE')
    : startLoadJob_(stageTable, jobId, blob, 'WRITE_TRUNCATE');

  const stagedRows = Number(
    loadJob && loadJob.statistics && loadJob.statistics.load &&
    loadJob.statistics.load.outputRows || 0
  );
  if (stagedRows !== normalized.rows.length) {
    throw uploadError_(
      'LOAD_ROW_COUNT_MISMATCH',
      'ชุดที่ ' + (envelope.chunkIndex + 1) + ' โหลดไม่ครบ (' +
        stagedRows + '/' + normalized.rows.length + ' แถว)'
    );
  }
  const integrity = getUploadChunkIntegrity_(stageTable);
  if (integrity.stagedRows !== stagedRows) {
    throw uploadError_(
      'CHUNK_VERIFY_FAILED',
      'จำนวนแถวชุดที่ ' + (envelope.chunkIndex + 1) + ' เปลี่ยนไประหว่างการตรวจสอบ กรุณาส่งชุดเดิมซ้ำอีกครั้ง'
    );
  }
  const chunkManifest = {
    schema: 'pick-upload-chunk-v1',
    transport: isCsv ? 'csv-v1' : 'array-json-v1',
    sessionId: envelope.sessionId,
    chunkIndex: envelope.chunkIndex,
    totalChunks: envelope.totalChunks,
    totalRows: envelope.totalRows,
    inputRows: rows.length,
    stagedRows: stagedRows,
    exactDuplicates: Number(normalized.counts.exactDuplicates || 0),
    contentHash: integrity.contentHash
  };
  setUploadChunkManifest_(stageTable, chunkManifest);

  return {
    message: 'โหลด' + (isCsv ? ' CSV' : '') + ' ชุดที่ ' +
      (envelope.chunkIndex + 1) + '/' + envelope.totalChunks + ' สำเร็จ',
    sessionId: envelope.sessionId,
    chunkIndex: envelope.chunkIndex,
    totalChunks: envelope.totalChunks,
    rowsProcessed: stagedRows,
    normalizedBytes: normalizedBytes,
    contentHash: chunkManifest.contentHash,
    counts: normalized.counts,
    loadJobId: jobId
  };
}

function commitUploadChunks_(request) {
  ensureUploadService_();
  validateUploadMeta_(request.meta || {});
  const envelope = validateUploadChunkEnvelope_(request, true);
  const existingReceipt = getUploadReceipt_(envelope.sessionId);
  if (existingReceipt) return existingReceipt;

  let lock = null;
  let consolidated = null;
  let completed = false;
  try {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(120000)) {
      throw uploadError_('UPLOAD_BUSY', 'มีไฟล์อื่นกำลัง Merge อยู่ กรุณารอสักครู่แล้วกดลองอีกครั้ง');
    }

    // ตรวจ receipt ซ้ำหลังได้ lock ป้องกันสองคำขอ commit พร้อมกัน
    const lockedReceipt = getUploadReceipt_(envelope.sessionId);
    if (lockedReceipt) return lockedReceipt;

    consolidated = consolidateUploadChunks_(
      envelope.sessionId,
      envelope.totalChunks,
      envelope.totalRows
    );
    if (consolidated.uniqueRows <= 0) {
      throw uploadError_('NO_VALID_ROWS', 'ไม่พบข้อมูลที่พร้อม Merge เข้า BigQuery');
    }
    if (consolidated.uniqueRows > MAX_UPLOAD_ROWS) {
      throw uploadError_(
        'TOO_MANY_ROWS',
        'ข้อมูลรวมมี ' + consolidated.uniqueRows.toLocaleString() + ' แถว เกินขีดจำกัด ' +
          MAX_UPLOAD_ROWS.toLocaleString() + ' แถวต่อไฟล์'
      );
    }

    const mergeCounts = mergeStage_(consolidated.finalTable);
    // ถ้าอัปเดต Dashboard ไม่สำเร็จ ห้ามเปลี่ยน revision และห้ามลบ stage
    // อัปเดตเฉพาะ key ของไฟล์นี้ ไม่ rebuild ประวัติทั้งตาราง
    refreshPickDashboardRowsFromStage_(consolidated.finalTable);
    const previousRevision = getDashboardRevisionToken_(getDataRevision_());
    bumpDataRevision_();
    clearCache_(previousRevision);

    const result = {
      message: 'โหลดครบทุกชุดและ Merge เข้า BigQuery สำเร็จ',
      uploadId: envelope.sessionId,
      sessionId: envelope.sessionId,
      filename: String(request.meta && request.meta.filename || ''),
      rowsProcessed: consolidated.uniqueRows,
      dashboardRevision: getDashboardRevisionToken_(getDataRevision_()),
      dashboardBounds: getDashboardBounds_(),
      counts: Object.assign({
        received: consolidated.inputRows,
        valid: consolidated.uniqueRows,
        duplicates: consolidated.duplicateRows
      }, mergeCounts)
    };
    // ต้องเขียน receipt แบบถาวรก่อนลบ stage เพื่อให้ retry หลัง response หลุด
    // คืนผลเดิมได้เสมอ แม้ Script Cache ถูกล้างหรือเต็ม
    persistUploadReceipt_(envelope.sessionId, result);
    completed = true;
    return result;
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
    if (completed && consolidated) {
      cleanupUploadTables_(consolidated.chunkTables.concat([consolidated.finalTable]));
    }
  }
}

function ensureUploadService_() {
  if (typeof BigQuery === 'undefined' || !BigQuery.Jobs || !BigQuery.Tables) {
    throw uploadError_('BIGQUERY_SERVICE_DISABLED', 'BigQuery API ยังไม่ได้ถูก Enable ใน Apps Script');
  }
}

function validateUploadChunkEnvelope_(request, isCommit) {
  const sessionId = String(request && request.sessionId || '').trim().toLowerCase();
  const totalChunks = Number(request && request.totalChunks);
  const chunkIndex = isCommit ? 0 : Number(request && request.chunkIndex);
  const totalRows = Number(request && request.totalRows || 0);
  if (!/^[a-f0-9]{24,48}$/.test(sessionId)) {
    throw uploadError_('INVALID_SESSION', 'รหัสรอบอัปโหลดไม่ถูกต้อง กรุณาเลือกไฟล์แล้วลองใหม่');
  }
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_UPLOAD_CHUNKS) {
    throw uploadError_('INVALID_CHUNK_COUNT', 'จำนวนชุดอัปโหลดไม่ถูกต้อง');
  }
  if (!isCommit && (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks)) {
    throw uploadError_('INVALID_CHUNK_INDEX', 'ลำดับชุดอัปโหลดไม่ถูกต้อง');
  }
  if (!Number.isInteger(totalRows) || totalRows < 1 || totalRows > MAX_UPLOAD_ROWS) {
    throw uploadError_('TOO_MANY_ROWS', 'จำนวนแถวรวมของไฟล์ไม่ถูกต้องหรือเกินขีดจำกัด');
  }
  return { sessionId: sessionId, totalChunks: totalChunks, chunkIndex: chunkIndex, totalRows: totalRows };
}

function uploadChunkTable_(sessionId, chunkIndex) {
  return 'pick_stage_' + sessionId.substring(0, 24) + '_c' + String(chunkIndex).padStart(3, '0');
}

function uploadChunkCanonicalRowSql_() {
  return 'TO_JSON_STRING(STRUCT(' +
    'pickdetailkey, lpn, qty, sku, owner, uom_qty, category, picker_id, location, ' +
    'pick_ts_source, source_row_number))';
}

function getUploadChunkIntegrity_(stageTable) {
  const canonical = uploadChunkCanonicalRowSql_();
  const rows = bqQueryAll_([
    'SELECT COUNT(*) AS staged_rows,',
    "  LOWER(TO_HEX(SHA256(STRING_AGG(" + canonical + ", '\\n' ORDER BY pickdetailkey, source_row_number, " + canonical + ')))) AS content_hash',
    'FROM `' + BQ_PROJECT + '.' + BQ_DATASET + '.' + stageTable + '`'
  ].join('\n'), JOB_DEADLINE_MS);
  const stagedRows = Number(rows && rows[0] && rows[0][0] || 0);
  const contentHash = String(rows && rows[0] && rows[0][1] || '').toLowerCase();
  return {
    stagedRows: stagedRows,
    contentHash: contentHash || '0000000000000000000000000000000000000000000000000000000000000000'
  };
}

function consolidateUploadChunks_(sessionId, totalChunks, expectedTotalRows) {
  const chunkTables = [];
  const manifests = [];
  const missing = [];
  for (let i = 0; i < totalChunks; i++) {
    const table = uploadChunkTable_(sessionId, i);
    try {
      const tableResource = BigQuery.Tables.get(BQ_PROJECT, BQ_DATASET, table);
      const manifest = parseUploadChunkManifest_(tableResource && tableResource.description);
      if (!manifest || manifest.sessionId !== sessionId || manifest.chunkIndex !== i ||
          manifest.totalChunks !== totalChunks || manifest.totalRows !== expectedTotalRows ||
          !Number.isInteger(manifest.inputRows) || manifest.inputRows < 1 ||
          !Number.isInteger(manifest.stagedRows) || manifest.stagedRows < 1 ||
          Number(tableResource.numRows || 0) !== manifest.stagedRows ||
          !/^[a-f0-9]{64}$/.test(String(manifest.contentHash || ''))) {
        throw uploadError_(
          'CHUNK_MANIFEST_MISMATCH',
          'ข้อมูลกำกับชุดที่ ' + (i + 1) + ' ไม่ครบหรือไม่ตรงกับไฟล์ กรุณาเลือกไฟล์แล้วลองใหม่'
        );
      }
      chunkTables.push(table);
      manifests.push(manifest);
    } catch (chunkErr) {
      if (chunkErr && chunkErr.code === 'CHUNK_MANIFEST_MISMATCH') throw chunkErr;
      missing.push(i + 1);
    }
  }
  if (missing.length) {
    const err = uploadError_(
      'MISSING_CHUNKS',
      'BigQuery ยังได้รับข้อมูลไม่ครบ ขาดชุดที่ ' + missing.slice(0, 20).join(', ')
    );
    err.uploadDetails = { missingChunks: missing };
    throw err;
  }

  const inputRows = manifests.reduce(function(sum, manifest) {
    return sum + manifest.inputRows;
  }, 0);
  if (inputRows !== expectedTotalRows) {
    throw uploadError_(
      'CHUNK_ROW_COUNT_MISMATCH',
      'จำนวนแถวที่ BigQuery รับจากทุกชุดไม่ตรงกับไฟล์ (' +
        inputRows + '/' + expectedTotalRows + ' แถว) กรุณาเลือกไฟล์แล้วลองใหม่'
    );
  }

  const verificationUnion = chunkTables.map(function(table, index) {
    return 'SELECT ' + index + ' AS chunk_index, pickdetailkey, lpn, qty, sku, owner, uom_qty, ' +
      'category, picker_id, location, pick_ts_source, source_row_number FROM `' +
      BQ_PROJECT + '.' + BQ_DATASET + '.' + table + '`';
  }).join('\nUNION ALL\n');
  const canonical = uploadChunkCanonicalRowSql_();
  const verificationRows = bqQueryAll_([
    'SELECT chunk_index, COUNT(*) AS staged_rows,',
    "       LOWER(TO_HEX(SHA256(STRING_AGG(" + canonical + ", '\\n' ORDER BY pickdetailkey, source_row_number, " + canonical + ')))) AS content_hash',
    'FROM (' + verificationUnion + ')',
    'GROUP BY chunk_index',
    'ORDER BY chunk_index'
  ].join('\n'), JOB_DEADLINE_MS);
  const verified = {};
  verificationRows.forEach(function(row) {
    verified[Number(row[0])] = {
      stagedRows: Number(row[1] || 0),
      contentHash: String(row[2] || '').toLowerCase()
    };
  });
  for (let i = 0; i < manifests.length; i++) {
    const actual = verified[i];
    const expected = manifests[i];
    if (!actual || actual.stagedRows !== expected.stagedRows || actual.contentHash !== expected.contentHash) {
      const err = uploadError_(
        'CHUNK_HASH_MISMATCH',
        'ชุดข้อมูลที่ ' + (i + 1) + ' ไม่ครบหลังโหลดเข้า BigQuery กรุณาเลือกไฟล์แล้วลองใหม่'
      );
      err.uploadDetails = {
        chunkIndex: i,
        expectedRows: expected.stagedRows,
        actualRows: actual && actual.stagedRows
      };
      throw err;
    }
  }

  const unionSql = chunkTables.map(function(table) {
    return 'SELECT * FROM `' + BQ_PROJECT + '.' + BQ_DATASET + '.' + table + '`';
  }).join('\nUNION ALL\n');
  const fingerprint = 'TO_JSON_STRING(STRUCT(lpn, qty, sku, owner, uom_qty, category, picker_id, location, pick_ts_source))';
  const groupedCte = [
    'WITH raw AS (' + unionSql + '),',
    'grouped AS (',
    '  SELECT pickdetailkey, COUNT(*) AS copies,',
    '    COUNT(DISTINCT ' + fingerprint + ') AS variants',
    '  FROM raw GROUP BY pickdetailkey',
    ')'
  ].join('\n');
  const stats = bqQueryAll_(
    groupedCte + '\nSELECT (SELECT COUNT(*) FROM raw), COUNT(*), ' +
      'SUM(copies - 1), COUNTIF(variants > 1) FROM grouped',
    JOB_DEADLINE_MS
  );
  if (!stats.length || stats[0].length < 4) {
    throw uploadError_('CHUNK_VERIFY_FAILED', 'ไม่สามารถตรวจสอบจำนวนแถวรวมก่อน Merge ได้');
  }
  const rawRows = Number(stats[0][0] || 0);
  const uniqueRows = Number(stats[0][1] || 0);
  const duplicateRows = Math.max(inputRows - uniqueRows, 0);
  const conflictKeys = Number(stats[0][3] || 0);
  if (conflictKeys > 0) {
    const samples = bqQueryAll_(
      groupedCte + '\nSELECT pickdetailkey FROM grouped WHERE variants > 1 LIMIT 10',
      JOB_DEADLINE_MS
    ).map(function(row) { return String(row[0] || ''); }).filter(Boolean);
    const err = uploadError_(
      'DUPLICATE_KEY_CONFLICT',
      'พบ Pick Detail # ซ้ำแต่ข้อมูลไม่เหมือนกัน ' + conflictKeys.toLocaleString() + ' รายการ'
    );
    err.uploadDetails = { conflictingKeys: samples };
    throw err;
  }

  const finalTable = 'pick_stage_' + sessionId.substring(0, 24) + '_final';
  const finalRef = '`' + BQ_PROJECT + '.' + BQ_DATASET + '.' + finalTable + '`';
  const createSql = [
    'CREATE OR REPLACE TABLE ' + finalRef,
    'OPTIONS(expiration_timestamp=TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)) AS',
    'SELECT * EXCEPT(_row_number) FROM (',
    '  SELECT raw.*, ROW_NUMBER() OVER (PARTITION BY pickdetailkey ORDER BY source_row_number) AS _row_number',
    '  FROM (' + unionSql + ') raw',
    ') WHERE _row_number = 1'
  ].join('\n');
  bqQueryAll_(createSql, JOB_DEADLINE_MS);
  return {
    finalTable: finalTable,
    chunkTables: chunkTables,
    inputRows: inputRows,
    rawRows: rawRows,
    uniqueRows: uniqueRows,
    duplicateRows: duplicateRows
  };
}

function cleanupUploadTables_(tables) {
  (tables || []).forEach(function(table) {
    try {
      BigQuery.Tables.remove(BQ_PROJECT, BQ_DATASET, table);
    } catch (cleanupErr) {
      console.warn('Temporary upload table cleanup failed (' + table + '): ' + cleanupErr);
    }
  });
}

function uploadReceiptKey_(sessionId) {
  return UPLOAD_RECEIPT_PREFIX + String(sessionId || '');
}

function getUploadReceipt_(sessionId) {
  const key = uploadReceiptKey_(sessionId);
  try {
    const cached = CacheService.getScriptCache().get(key);
    if (cached) return JSON.parse(cached);
  } catch (_) {}

  try {
    const properties = PropertiesService.getScriptProperties();
    const raw = properties.getProperty(key);
    if (raw) {
      const stored = JSON.parse(raw);
      const completedAt = Number(stored && stored.completedAt || 0);
      if (stored && stored.result && completedAt && Date.now() - completedAt <= UPLOAD_RECEIPT_TTL_MS) {
        try {
          CacheService.getScriptCache().put(key, JSON.stringify(stored.result), 21600);
        } catch (_) {}
        return stored.result;
      }
      properties.deleteProperty(key);
    }
  } catch (receiptReadErr) {
    console.warn('Upload receipt read failed: ' + receiptReadErr);
  }

  const durable = getUploadReceiptFromBigQuery_(sessionId);
  if (!durable) return null;
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(durable), 21600);
  } catch (_) {}
  try {
    PropertiesService.getScriptProperties().setProperty(
      key,
      JSON.stringify({ completedAt: Date.now(), result: durable })
    );
  } catch (_) {}
  return durable;
}

function persistUploadReceipt_(sessionId, result) {
  const key = uploadReceiptKey_(sessionId);
  const payload = JSON.stringify({ completedAt: Date.now(), result: result });
  try {
    persistUploadReceiptToBigQuery_(sessionId, result);
  } catch (durableReceiptErr) {
    throw uploadError_(
      'RECEIPT_PERSIST_FAILED',
      'BigQuery Merge สำเร็จ แต่ยังบันทึกสถานะยืนยันไม่ได้ กรุณากดลองอีกครั้งเพื่อยืนยันผลเดิม'
    );
  }
  try {
    PropertiesService.getScriptProperties().setProperty(key, payload);
  } catch (receiptWriteErr) {
    console.warn('Script Properties receipt cache failed; BigQuery receipt is durable: ' + receiptWriteErr);
  }
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(result), 21600);
  } catch (_) {}
  pruneUploadReceipts_(key);
}

function getUploadReceiptFromBigQuery_(sessionId) {
  try {
    const rows = bqQueryAll_([
      'SELECT result_b64',
      'FROM `' + BQ_PROJECT + '.' + BQ_DATASET + '.' + UPLOAD_RECEIPT_TABLE + '`',
      'WHERE session_id = ' + sqlStringLiteral_(sessionId),
      '  AND completed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)',
      'ORDER BY completed_at DESC LIMIT 1'
    ].join('\n'), 60000);
    if (!rows.length || !rows[0][0]) return null;
    const json = Utilities.newBlob(
      Utilities.base64DecodeWebSafe(String(rows[0][0]))
    ).getDataAsString('UTF-8');
    return JSON.parse(json);
  } catch (err) {
    console.warn('BigQuery upload receipt read failed: ' + err);
    return null;
  }
}

function persistUploadReceiptToBigQuery_(sessionId, result) {
  const table = '`' + BQ_PROJECT + '.' + BQ_DATASET + '.' + UPLOAD_RECEIPT_TABLE + '`';
  const resultB64 = Utilities.base64EncodeWebSafe(
    JSON.stringify(result),
    Utilities.Charset.UTF_8
  );
  const sql = [
    'CREATE TABLE IF NOT EXISTS ' + table + ' (',
    '  session_id STRING, result_b64 STRING, completed_at TIMESTAMP',
    ') PARTITION BY DATE(completed_at) CLUSTER BY session_id;',
    'DELETE FROM ' + table,
    'WHERE completed_at < TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY);',
    'MERGE ' + table + ' T',
    'USING (SELECT ' + sqlStringLiteral_(sessionId) + ' AS session_id, ' +
      sqlStringLiteral_(resultB64) + ' AS result_b64, CURRENT_TIMESTAMP() AS completed_at) S',
    'ON T.session_id = S.session_id',
    'WHEN MATCHED THEN UPDATE SET result_b64 = S.result_b64, completed_at = S.completed_at',
    'WHEN NOT MATCHED THEN INSERT (session_id, result_b64, completed_at)',
    'VALUES (S.session_id, S.result_b64, S.completed_at);'
  ].join('\n');
  bqQueryAll_(sql, JOB_DEADLINE_MS);
}

function pruneUploadReceipts_(keepKey) {
  try {
    const properties = PropertiesService.getScriptProperties();
    const all = properties.getProperties();
    Object.keys(all).forEach(function(key) {
      if (key === keepKey || key.indexOf(UPLOAD_RECEIPT_PREFIX) !== 0) return;
      try {
        const parsed = JSON.parse(all[key]);
        const completedAt = Number(parsed && parsed.completedAt || 0);
        if (!completedAt || Date.now() - completedAt > UPLOAD_RECEIPT_TTL_MS) {
          properties.deleteProperty(key);
        }
      } catch (_) {
        properties.deleteProperty(key);
      }
    });
  } catch (receiptPruneErr) {
    console.warn('Upload receipt cleanup failed: ' + receiptPruneErr);
  }
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

function parseUploadCsvRows_(csvText, expectedRowCount, format) {
  if (String(format || '') !== 'csv-v1') {
    throw uploadError_('CSV_FORMAT_MISMATCH', 'รูปแบบ CSV ที่ส่งมาไม่ตรงกับระบบ กรุณารีเฟรชหน้าเว็บแล้วลองใหม่');
  }
  const text = String(csvText == null ? '' : csvText).replace(/^\uFEFF/, '');
  if (!text.trim()) throw uploadError_('EMPTY_CHUNK', 'CSV ชุดที่ส่งมาว่างเปล่า');

  let rows;
  try {
    rows = Utilities.parseCsv(text, ',');
  } catch (err) {
    throw uploadError_('CSV_PARSE_FAILED', 'ไม่สามารถอ่าน CSV ชุดที่ส่งมาได้: ' + String(err && err.message || err));
  }
  while (rows.length && rows[rows.length - 1].every(function(value) { return String(value || '') === ''; })) {
    rows.pop();
  }
  const expected = Number(expectedRowCount || 0);
  if (expected && rows.length !== expected) {
    throw uploadError_(
      'CSV_ROW_COUNT_MISMATCH',
      'จำนวนแถว CSV ไม่ตรงกับข้อมูลกำกับ (' + rows.length + '/' + expected + ' แถว)'
    );
  }
  for (let i = 0; i < rows.length; i++) {
    if (!Array.isArray(rows[i]) || rows[i].length !== 11) {
      throw uploadError_(
        'CSV_COLUMN_COUNT_MISMATCH',
        'CSV แถวที่ ' + (i + 1) + ' มี ' + (rows[i] && rows[i].length || 0) +
          ' คอลัมน์ แต่ระบบต้องการ 11 คอลัมน์'
      );
    }
  }
  return rows;
}

function uploadCsvField_(value) {
  const text = String(value == null ? '' : value);
  return /[",\r\n]/.test(text)
    ? '"' + text.replace(/"/g, '""') + '"'
    : text;
}

function uploadCsvStringField_(value) {
  const text = String(value == null ? '' : value);
  return '"' + text.replace(/"/g, '""') + '"';
}

function uploadNormalizedRowToCsvLine_(row) {
  // บังคับ quote คอลัมน์ STRING เพื่อรักษาเลข 0 นำหน้าและค่าว่างให้เหมือนข้อมูลเดิม
  return [
    uploadCsvStringField_(row.pickdetailkey),
    uploadCsvStringField_(row.lpn),
    String(row.qty),
    uploadCsvStringField_(row.sku),
    uploadCsvStringField_(row.owner),
    String(row.uom_qty),
    uploadCsvStringField_(row.category),
    uploadCsvStringField_(row.picker_id),
    uploadCsvStringField_(row.location),
    uploadCsvStringField_(row.pick_ts_source),
    String(row.source_row_number)
  ].join(',');
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

function startLoadJob_(stageTable, jobId, blob, writeDisposition) {
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
        writeDisposition: writeDisposition || 'WRITE_EMPTY',
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

function startCsvLoadJob_(stageTable, jobId, blob, writeDisposition) {
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
        sourceFormat: 'CSV',
        encoding: 'UTF-8',
        fieldDelimiter: ',',
        quote: '"',
        nullMarker: '\\N',
        skipLeadingRows: 0,
        allowQuotedNewlines: true,
        allowJaggedRows: false,
        createDisposition: 'CREATE_IF_NEEDED',
        writeDisposition: writeDisposition || 'WRITE_EMPTY',
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
      throw uploadError_('LOAD_TIMEOUT', 'BigQuery ใช้เวลาโหลด CSV นานเกินกำหนด กรุณาลองนำเข้าไฟล์เดิมอีกครั้ง');
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

function setUploadChunkManifest_(stageTable, manifest) {
  const description = 'pick-upload-manifest-v1:' + JSON.stringify(manifest);
  try {
    BigQuery.Tables.patch(
      {
        expirationTime: String(Date.now() + 24 * 60 * 60 * 1000),
        description: description
      },
      BQ_PROJECT,
      BQ_DATASET,
      stageTable
    );
  } catch (manifestErr) {
    throw uploadError_(
      'CHUNK_MANIFEST_WRITE_FAILED',
      'โหลดข้อมูลเข้า BigQuery แล้ว แต่บันทึกข้อมูลกำกับชุดไม่สำเร็จ กรุณาลองส่งไฟล์เดิมอีกครั้ง'
    );
  }
}

function parseUploadChunkManifest_(description) {
  const prefix = 'pick-upload-manifest-v1:';
  const value = String(description || '');
  if (value.indexOf(prefix) !== 0) return null;
  try {
    const manifest = JSON.parse(value.substring(prefix.length));
    return manifest && manifest.schema === 'pick-upload-chunk-v1' ? manifest : null;
  } catch (_) {
    return null;
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

// เก็บ/อ่าน JSON ก้อนใหญ่ใน Script Cache แบบ gzip + base64 แล้วแบ่งชิ้น
// payload เดิม ~646 KB เหลือ ~277 KB หลัง encode ทำให้ CacheService ไม่หลุดบาง chunk ง่าย
function getCached_(revision) {
  const encoded = getCachedEncoded_(revision);
  if (!encoded) return null;
  const compressed = Utilities.base64Decode(encoded);
  return Utilities.ungzip(Utilities.newBlob(compressed)).getDataAsString('UTF-8');
}
function getCachedEncoded_(revision) {
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
  const joined = parts.join('');
  const codec = c.get(prefix + 'codec');
  return codec === CACHE_CODEC ? joined : null;
}
function setCached_(str, revision) {
  const c = CacheService.getScriptCache();
  const prefix = cachePrefix_(revision);
  const compressed = Utilities.gzip(
    Utilities.newBlob(String(str || ''), 'application/json', 'dashboard.json')
  ).getBytes();
  const encoded = Utilities.base64Encode(compressed);
  const cnt = Math.ceil(encoded.length / CACHE_CHUNK_CHARS), obj = {};
  for (let i = 0; i < cnt; i++) {
    obj[prefix + i] = encoded.substring(i * CACHE_CHUNK_CHARS, (i + 1) * CACHE_CHUNK_CHARS);
  }
  c.putAll(obj, CACHE_TTL);
  c.put(prefix + 'codec', CACHE_CODEC, CACHE_TTL);
  // เขียน n หลังทุก chunk สำเร็จ เพื่อไม่ให้ผู้อ่านเห็น cache ที่ยังไม่ครบ
  c.put(prefix + 'n', String(cnt), CACHE_TTL);
  return encoded;
}

function gzipEnvelope_(encoded) {
  return json_({ encoding: CACHE_CODEC, data: encoded });
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

function pickerDirectoryCacheKey_() {
  return 'picker_directory_' + DASHBOARD_SCHEMA_VERSION + '_v4_workforce_planner';
}

function readPickerDirectoryCache_() {
  try {
    const raw = CacheService.getScriptCache().get(pickerDirectoryCacheKey_());
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function writePickerDirectoryCache_(directory) {
  try {
    CacheService.getScriptCache().put(
      pickerDirectoryCacheKey_(),
      JSON.stringify(directory),
      PICKER_ROSTER_CACHE_TTL
    );
  } catch (_) {}
}

function clearPickerDirectoryCache_() {
  try { CacheService.getScriptCache().remove(pickerDirectoryCacheKey_()); } catch (_) {}
}

function loadPickerDirectory_(forceRefresh) {
  if (!forceRefresh) {
    const cached = readPickerDirectoryCache_();
    if (cached && cached.names && cached.affiliations && cached.shiftTeams &&
        cached.rosterTeams && cached.responsibilities && cached.rosterZones) return cached;
  } else {
    clearPickerDirectoryCache_();
  }

  const empty = { names:{}, affiliations:{}, shiftTeams:{}, rosterTeams:{}, responsibilities:{}, rosterZones:{}, loadedAt:'' };
  try {
    const ss = SpreadsheetApp.openById(PICKER_NAME_SHEET_ID);
    const sh = ss.getSheetByName(PICKER_NAME_TAB);
    if (!sh) return empty;
    const lastRow = sh.getLastRow();
    if (lastRow < PICKER_NAME_START_ROW) return empty;

    // B:I = รหัสพนักงาน, ชื่อ, ชื่อเล่น, สังกัด, หน้าที่รับผิดชอบ, โซน, Start Date, Team
    const values = sh.getRange(PICKER_NAME_START_ROW, 2, lastRow - PICKER_NAME_START_ROW + 1, 8).getDisplayValues();
    const directory = { names:{}, affiliations:{}, shiftTeams:{}, rosterTeams:{}, responsibilities:{}, rosterZones:{}, loadedAt:new Date().toISOString() };
    values.forEach(row => {
      const id = String(row[0] || '').trim();
      if (!id) return;
      const name = String(row[1] || '').trim();
      const affiliation = String(row[3] || '').trim();
      const responsibility = String(row[4] || '').trim();
      const rosterZone = String(row[5] || '').trim();
      const team = String(row[7] || '').trim().toUpperCase();
      if (name && !directory.names[id]) directory.names[id] = name;
      if (affiliation && !directory.affiliations[id]) directory.affiliations[id] = affiliation;
      if (responsibility && !directory.responsibilities[id]) directory.responsibilities[id] = responsibility;
      if (rosterZone && !directory.rosterZones[id]) directory.rosterZones[id] = rosterZone;
      if (team && !directory.rosterTeams[id]) directory.rosterTeams[id] = team;
      if ((team === 'A' || team === 'B') && !directory.shiftTeams[id]) directory.shiftTeams[id] = team;
    });
    writePickerDirectoryCache_(directory);
    return directory;
  } catch (err) {
    console.warn('loadPickerDirectory_ failed: ' + err);
    return empty;
  }
}

function buildPickerRosterPayload_(forceRefresh) {
  const directory = loadPickerDirectory_(!!forceRefresh);
  let total = 0, countA = 0, countB = 0, countFlex = 0;
  const roles = directory.responsibilities || {};
  const teams = directory.rosterTeams || {};
  Object.keys(roles).forEach(function(id) {
    if (String(roles[id] || '').trim().toUpperCase() !== 'PICKER') return;
    total++;
    const team = String(teams[id] || '').trim().toUpperCase();
    if (team === 'A') countA++;
    else if (team === 'B') countB++;
    else countFlex++;
  });
  return {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    generated: directory.loadedAt || new Date().toISOString(),
    cache_ttl_seconds: PICKER_ROSTER_CACHE_TTL,
    source: PICKER_NAME_SHEET_ID + '/' + PICKER_NAME_TAB + '!B:I',
    picker_names: directory.names || {},
    picker_affiliations: directory.affiliations || {},
    picker_shift_teams: directory.shiftTeams || {},
    picker_roster_teams: directory.rosterTeams || {},
    picker_responsibilities: directory.responsibilities || {},
    picker_roster_zones: directory.rosterZones || {},
    summary: { total:total, countA:countA, countB:countB, countFlex:countFlex }
  };
}

function pickerRosterShiftCodeSql_(pickerExpr, tminExpr) {
  const directory = loadPickerDirectory_();
  const teams = directory.shiftTeams || {};
  const aIds = [];
  const bIds = [];
  const addVariants = function(target, rawId) {
    const id = String(rawId || '').trim();
    if (!id) return;
    target.push(id);
    if (/^\d+$/.test(id)) {
      const noZero = id.replace(/^0+(?=\d)/, '');
      if (noZero && noZero !== id) target.push(noZero);
    }
  };
  Object.keys(teams).forEach(function(id) {
    const team = String(teams[id] || '').trim().toUpperCase();
    if (team === 'A') addVariants(aIds, id);
    else if (team === 'B') addVariants(bIds, id);
  });
  const unique = function(list) { return Array.from(new Set(list)); };
  const pickerSql = 'CAST(' + pickerExpr + ' AS STRING)';
  const fallback = "IF(" + tminExpr + " >= 420 AND " + tminExpr + " < 1140, 'M', 'N')";
  const parts = ['CASE'];
  const a = unique(aIds);
  const b = unique(bIds);
  if (a.length) parts.push('WHEN ' + pickerSql + ' IN (' + a.map(sqlStringLiteral_).join(',') + ") THEN 'M'");
  if (b.length) parts.push('WHEN ' + pickerSql + ' IN (' + b.map(sqlStringLiteral_).join(',') + ") THEN 'N'");
  parts.push('ELSE ' + fallback, 'END');
  return parts.join(' ');
}

// Report grouping is owned by the employee roster, never inferred from pick time.
// X is retained so unmapped employee IDs remain visible and auditable.
function pickerRosterTeamCodeSql_(pickerExpr) {
  const directory = loadPickerDirectory_();
  const teams = directory.rosterTeams || {};
  const aIds = [];
  const bIds = [];
  const addVariants = function(target, rawId) {
    const id = String(rawId || '').trim();
    if (!id) return;
    target.push(id);
    if (/^\d+$/.test(id)) {
      const noZero = id.replace(/^0+(?=\d)/, '');
      if (noZero && noZero !== id) target.push(noZero);
    }
  };
  Object.keys(teams).forEach(function(id) {
    const team = String(teams[id] || '').trim().toUpperCase();
    if (team === 'A') addVariants(aIds, id);
    else if (team === 'B') addVariants(bIds, id);
  });
  const unique = function(list) { return Array.from(new Set(list)); };
  const pickerSql = 'CAST(' + pickerExpr + ' AS STRING)';
  const parts = ['CASE'];
  const a = unique(aIds);
  const b = unique(bIds);
  if (a.length) parts.push('WHEN ' + pickerSql + ' IN (' + a.map(sqlStringLiteral_).join(',') + ") THEN 'A'");
  if (b.length) parts.push('WHEN ' + pickerSql + ' IN (' + b.map(sqlStringLiteral_).join(',') + ") THEN 'B'");
  parts.push("ELSE 'X'", 'END');
  return parts.join(' ');
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
    // ห้าม rebuild t_pick_dashboard อัตโนมัติเมื่อ Master เปลี่ยน:
    // ค่า Pick Units ของประวัติที่ปิดวันแล้วต้องคงเดิม ส่วนไฟล์ใหม่จะใช้ Master ล่าสุด
    // หากต้องการ recalculation ย้อนหลังจริง ๆ ให้เรียก refreshDashboardTableNow() ด้วยตนเอง
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

function buildDashboardData_(useQueryCache, requestScope) {
  const currentDate = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  const scope = requestScope || { excludedItems: [], key: 'all' };
  const pickerDirectory = loadPickerDirectory_();
  const pickerNames = pickerDirectory.names;
  const pickerAffiliations = pickerDirectory.affiliations;
  const pickerShiftTeams = pickerDirectory.shiftTeams || {};
  const pickerRosterTeams = pickerDirectory.rosterTeams || {};
  const pickerResponsibilities = pickerDirectory.responsibilities || {};
  const pickerRosterZones = pickerDirectory.rosterZones || {};
  const zoneMaster = loadZoneMasterMap_();
  const excludedSql = dashboardExclusionSql_(scope, 'owner_key', 'sku_key');

  // Payload หลักส่ง W = วัน/กะ/Zone/Picker + Active Hour Mask สำหรับ Productivity แบบ Results Master V2
  // มิติ Item และ Time-slot แยกเป็น mode=item_cube / mode=slot_cube และโหลดเป็นรายวันเมื่อเปิดหน้า
  // ทำให้ cache miss ยังตอบ payload หลักได้ทันและข้อมูลพนักงานไม่หายเมื่อข้อมูลโตขึ้น
  const sql = [
    'WITH base AS (',
    '  SELECT',
    '    UPPER(category) AS category,',
    '    ' + dashboardShiftDateSql_('pick_date', 'tmin') + ' AS shift_date,',
    '    ' + dashboardShiftCodeSql_('tmin') + ' AS shift_code,',
    '    COALESCE(zone, \'??\') AS zone,',
    '    COALESCE(picker_id, \'(none)\') AS picker,',
    "    UPPER(COALESCE(owner, '-')) AS owner_key,",
    "    REGEXP_REPLACE(COALESCE(CAST(sku AS STRING), '(none)'), r'\\.0+$', '') AS sku_key,",
    '    CASE WHEN tmin >= 1140 THEN tmin - 1140 WHEN tmin < 420 THEN tmin + 300 ELSE tmin - 420 END AS shift_minute,',
    '    CAST(DIV(tmin, 60) AS INT64) AS hour_of_day,',
    '    pcs, pick_qty',
    '  FROM `' + BQ_PROJECT + '.' + BQ_DATASET + '.' + DASHBOARD_TABLE + '`',
    "  WHERE pick_date >= DATE_SUB(DATE '" + currentDate + "', INTERVAL " + RECENT_DAYS + ' DAY)',
    "    AND UPPER(category) IN ('PTT','BPS')",
    '),',
    'included AS (',
    '  SELECT * FROM base WHERE TRUE ' + excludedSql,
    ')',
    "SELECT category, FORMAT_DATE('%Y-%m-%d', shift_date), shift_code, zone, picker,",
    '       SUM(pcs), SUM(pick_qty), COUNT(*), MIN(shift_minute), MAX(shift_minute),',
    '       SUM(DISTINCT CAST(POW(2, hour_of_day) AS INT64)) AS active_hour_mask',
    'FROM included',
    'GROUP BY category, shift_date, shift_code, zone, picker',
    'ORDER BY category, shift_date, zone, picker'
  ].join('\n');

  const mk = () => ({
    _d:{}, _p:{}, _s:{}, dates:[], pickers:[], skus:[],
    rows:[], item_rows:[], slot_rows:[], input_lines:0
  });
  const sysd = { PTT: mk(), BPS: mk() };
  const idx = (map, arr, key) => { if (!(key in map)) { map[key] = arr.length; arr.push(key); } return map[key]; };

  let total = 0;
  bqQueryEach_(sql, function(r) {
    const cat = r[0];
    const S = sysd[cat];
    if (!S) return;
    const d = r[1];
    const shiftCode = r[2] === 'N' ? 1 : 0;
    const zone = r[3] || '??';
    const picker = r[4] || '(none)';
    const pcs = Number(r[5]) || 0;
    const pickQty = Number(r[6]) || 0;
    const lines = Number(r[7]) || 0;
    const minSm = Number(r[8]) || 0;
    const maxSm = Number(r[9]) || 0;
    const hourMask = Number(r[10]) || 0;
    const di = idx(S._d, S.dates, d);
    const pi = idx(S._p, S.pickers, picker);
    S.rows.push(di, shiftCode, zone, pi, pcs, pickQty, lines, minSm, maxSm, hourMask);
    S.input_lines += lines;
    total++;
  }, JOB_DEADLINE_MS, useQueryCache !== false);
  ['PTT','BPS'].forEach(c => sortDates_(sysd[c]));
  const compact = function(S) {
    return {
      row_width: 10, item_row_width: 8, slot_row_width: 8,
      dates: S.dates, pickers: S.pickers, skus: S.skus,
      rows: S.rows, item_rows: S.item_rows, slot_rows: S.slot_rows
    };
  };
  const inputLines = sysd.PTT.input_lines + sysd.BPS.input_lines;

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
            picker_shift_teams: pickerShiftTeams,
            picker_roster_teams: pickerRosterTeams,
            picker_responsibilities: pickerResponsibilities,
            picker_roster_zones: pickerRosterZones,
            picker_roster_generated: pickerDirectory.loadedAt || '',
            picker_roster_cache_ttl_seconds: PICKER_ROSTER_CACHE_TTL,
            picker_sunday_ot: loadPickerSundayOtCalendar_(false),
            picker_shift_source: PICKER_NAME_SHEET_ID + '/' + PICKER_NAME_TAB + '!I:I',
            picker_role_source: PICKER_NAME_SHEET_ID + '/' + PICKER_NAME_TAB + '!F:F',
            zone_master: zoneMaster,
            zone_master_source: ZONE_MASTER_SHEET_ID + '/' + ZONE_MASTER_TAB,
            excluded_items: scope.excludedItems,
            recent_days: RECENT_DAYS, rows: total, input_lines: inputLines },
    PTT: compact(sysd.PTT),
    BPS: compact(sysd.BPS)
  };
}

// -----------------------------------------------------------------------------
// Stable-history dashboard refresh
//
// t_pick_dashboard เก็บ pick_qty แบบ materialized ตามวันที่ที่ข้อมูลถูกนำเข้าแล้ว
// Upload ใหม่จึงอัปเดตเฉพาะ PickDetailKey ที่อยู่ใน stage เท่านั้น เพื่อป้องกัน
// Master/current view รุ่นใหม่ย้อนกลับไปเปลี่ยน Productivity ของวันเก่าที่ปิดไปแล้ว
// -----------------------------------------------------------------------------
function dashboardHasPickDetailKey_() {
  try {
    const rows = bqQueryAll_([
      'SELECT COUNTIF(column_name = \'pickdetailkey\')',
      'FROM `' + BQ_PROJECT + '.' + BQ_DATASET + '.INFORMATION_SCHEMA.COLUMNS`',
      'WHERE table_name = ' + sqlStringLiteral_(DASHBOARD_TABLE)
    ].join('\n'), 60000);
    return !!(rows.length && Number(rows[0][0] || 0) === 1);
  } catch (_) {
    return false;
  }
}

function refreshPickDashboardRowsFromStage_(stageTable) {
  const stage = '`' + BQ_PROJECT + '.' + BQ_DATASET + '.' + stageTable + '`';
  const target = '`' + BQ_PROJECT + '.' + BQ_DATASET + '.' + DASHBOARD_TABLE + '`';
  const enriched = '`' + BQ_PROJECT + '.' + BQ_DATASET + '.v_pick_enriched`';

  // รุ่นเก่าของ t_pick_dashboard ยังไม่มี pickdetailkey จึงต้อง migrate เต็มตารางเพียงครั้งเดียว
  // หลังจากนั้นทุก upload จะเข้าทาง MERGE เฉพาะ key และไม่แตะวันอื่นอีก
  if (!dashboardHasPickDetailKey_()) {
    console.warn('t_pick_dashboard has no pickdetailkey; running one-time stable-history migration.');
    refreshPickDashboardTable_();
  }

  // ถ้า key เดิมถูกส่งซ้ำโดยข้อมูลธุรกิจไม่เปลี่ยน ห้าม UPDATE เพียงเพราะ Master ล่าสุด
  // ทำให้ Pick Units ของวันเก่าคงค่าเดิมอย่างแท้จริงแม้ไฟล์ใหม่เป็น export แบบ overlap/cumulative
  const businessDifferent = [
    'T.category IS DISTINCT FROM S.category',
    'T.pick_date IS DISTINCT FROM S.pick_date',
    'T.location IS DISTINCT FROM S.location',
    'T.zone IS DISTINCT FROM S.zone',
    'T.picker_id IS DISTINCT FROM S.picker_id',
    'T.owner IS DISTINCT FROM S.owner',
    'T.sku IS DISTINCT FROM S.sku',
    'T.tmin IS DISTINCT FROM S.tmin',
    'T.pcs IS DISTINCT FROM S.pcs'
  ].join(' OR ');

  const sql = [
    'MERGE ' + target + ' T',
    'USING (',
    '  SELECT',
    '    S.pickdetailkey,',
    '    UPPER(V.category) AS category,',
    '    DATE(V.pick_ts_local) AS pick_date,',
    "    COALESCE(V.location, V.zone, '??') AS location,",
    "    COALESCE(V.zone, '??') AS zone,",
    '    V.picker_id,',
    "    UPPER(COALESCE(V.owner, '-')) AS owner,",
    '    V.sku,',
    '    CAST(EXTRACT(HOUR FROM V.pick_ts_local)*60 + EXTRACT(MINUTE FROM V.pick_ts_local) AS INT64) AS tmin,',
    '    V.qty AS pcs,',
    '    V.pick_qty,',
    '    V.pickdetailkey IS NOT NULL AND V.pick_ts_local IS NOT NULL',
    "      AND UPPER(V.category) IN ('PTT','BPS') AS is_visible",
    '  FROM ' + stage + ' S',
    '  LEFT JOIN ' + enriched + ' V ON V.pickdetailkey = S.pickdetailkey',
    ') S',
    'ON T.pickdetailkey = S.pickdetailkey',
    'WHEN MATCHED AND S.is_visible AND (' + businessDifferent + ') THEN UPDATE SET',
    '  category=S.category, pick_date=S.pick_date, location=S.location, zone=S.zone,',
    '  picker_id=S.picker_id, owner=S.owner, sku=S.sku, tmin=S.tmin, pcs=S.pcs, pick_qty=S.pick_qty',
    'WHEN MATCHED AND NOT S.is_visible THEN DELETE',
    'WHEN NOT MATCHED AND S.is_visible THEN INSERT',
    '  (pickdetailkey, category, pick_date, location, zone, picker_id, owner, sku, tmin, pcs, pick_qty)',
    'VALUES',
    '  (S.pickdetailkey, S.category, S.pick_date, S.location, S.zone, S.picker_id, S.owner, S.sku, S.tmin, S.pcs, S.pick_qty);'
  ].join('\n');
  bqQueryAll_(sql, JOB_DEADLINE_MS);

  const bounds = bqQueryAll_(dashboardBoundsSql_(), JOB_DEADLINE_MS);
  if (bounds.length && bounds[0].length >= 2) setDashboardBounds_(bounds[0][0], bounds[0][1]);
  console.log('t_pick_dashboard incrementally refreshed from ' + stageTable + ' (stable history)');
}

// -----------------------------------------------------------------------------
// Full rebuild ใช้เฉพาะการ migrate ครั้งแรก / ซ่อมข้อมูล / สั่ง recalculation ย้อนหลังด้วยตนเอง
// Upload ปกติและ Daily Master Sync ห้ามเรียกฟังก์ชันนี้
// -----------------------------------------------------------------------------
function refreshPickDashboardTable_() {
  const target = '`' + BQ_PROJECT + '.' + BQ_DATASET + '.' + DASHBOARD_TABLE + '`';
  const selectSql =
    'SELECT ' +
    '  pickdetailkey, ' +
    '  UPPER(category) AS category, ' +
    '  DATE(pick_ts_local) AS pick_date, ' +
    "  COALESCE(location, zone, '??') AS location, " +
    "  COALESCE(zone, '??') AS zone, " +
    '  picker_id, ' +
    "  UPPER(COALESCE(owner, '-')) AS owner, " +
    '  sku, ' +
    '  CAST(EXTRACT(HOUR FROM pick_ts_local)*60 + EXTRACT(MINUTE FROM pick_ts_local) AS INT64) AS tmin, ' +
    '  qty AS pcs, ' +
    '  pick_qty ' +
    'FROM `' + BQ_PROJECT + '.' + BQ_DATASET + '.v_pick_enriched` ' +
    'WHERE pick_ts_local IS NOT NULL AND UPPER(category) IN (\'PTT\',\'BPS\')';

  const createSql =
    'CREATE OR REPLACE TABLE ' + target + ' ' +
    'PARTITION BY pick_date CLUSTER BY category, owner, picker_id, sku AS ' + selectSql;

  try {
    bqQueryAll_(createSql, JOB_DEADLINE_MS);
  } catch (err) {
    const msg = String(err && (err.message || err) || '');
    const specChanged = /different partitioning spec|cannot replace a table with a different partitioning spec/i.test(msg);
    if (!specChanged) throw err;

    // BigQuery ไม่อนุญาต CREATE OR REPLACE เมื่อเปลี่ยน partition/clustering spec
    // เช่นรุ่นเก่า cluster(category,picker_id) -> รุ่นใหม่ cluster(category,owner,picker_id,sku); location/zone เก็บเป็นคอลัมน์ปกติ
    // t_pick_dashboard เป็น derived table จึงสร้างสำเนาใหม่ให้สำเร็จก่อน แล้วค่อยสลับตารางจริง
    console.warn('Dashboard schema/clustering changed; running one-time safe rebuild with stable pickdetailkey.');
    const rebuildId = DASHBOARD_TABLE + '_rebuild_' + String(Date.now());
    const rebuild = '`' + BQ_PROJECT + '.' + BQ_DATASET + '.' + rebuildId + '`';
    let rebuildCreated = false;
    try {
      const rebuildSql =
        'CREATE TABLE ' + rebuild + ' ' +
        'PARTITION BY pick_date CLUSTER BY category, owner, picker_id, sku AS ' + selectSql;
      bqQueryAll_(rebuildSql, JOB_DEADLINE_MS);
      rebuildCreated = true;

      const verify = bqQueryAll_(
        'SELECT COUNT(*) AS row_count, COUNTIF(owner IS NULL) AS null_owner_count FROM ' + rebuild,
        JOB_DEADLINE_MS
      );
      if (!verify.length) throw new Error('ตรวจตาราง Dashboard ที่สร้างใหม่ไม่สำเร็จ');

      // ตาราง rebuild สร้างผ่านแล้ว จึงค่อยลบตารางรุ่นเก่าและสร้าง target ด้วย spec ใหม่
      bqQueryAll_('DROP TABLE IF EXISTS ' + target, JOB_DEADLINE_MS);
      bqQueryAll_(
        'CREATE TABLE ' + target + ' ' +
        'PARTITION BY pick_date CLUSTER BY category, owner, picker_id, sku AS ' +
        'SELECT * FROM ' + rebuild,
        JOB_DEADLINE_MS
      );
      console.log('One-time Dashboard clustering migration completed: rows=' + String(verify[0][0] || 0));
    } finally {
      if (rebuildCreated) {
        try { bqQueryAll_('DROP TABLE IF EXISTS ' + rebuild, JOB_DEADLINE_MS); }
        catch (cleanupErr) { console.warn('Dashboard rebuild cleanup failed: ' + cleanupErr); }
      }
    }
  }

  const bounds = bqQueryAll_(dashboardBoundsSql_(), JOB_DEADLINE_MS);
  if (bounds.length && bounds[0].length >= 2) setDashboardBounds_(bounds[0][0], bounds[0][1]);
  console.log('t_pick_dashboard full rebuild completed with stable pickdetailkey');
}

// เรียกจาก Editor เพื่อทำ one-time migration เป็น Stable History หรือสั่ง full recalculation ด้วยตนเอง
function refreshDashboardTableNow() {
  refreshPickDashboardTable_();
  clearCache_(getDataRevision_());
  bumpDataRevision_();
  return { status: 'success', table: DASHBOARD_TABLE, stable_history: dashboardHasPickDetailKey_() };
}

// เรียงวันที่ให้ต่อเนื่อง แล้ว remap index ของ rows ตามลำดับใหม่
function sortDates_(S) {
  const order = S.dates.map((d, i) => [d, i]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const remap = {}; order.forEach((o, ni) => remap[o[1]] = ni);
  [[S.rows, 10], [S.item_rows, 8], [S.slot_rows, 8]].forEach(function(entry) {
    const rows = entry[0], width = entry[1];
    for (let i = 0; i < rows.length; i += width) rows[i] = remap[rows[i]];
  });
  S.dates = order.map(o => o[0]);
}

// อ่านผลลัพธ์ BigQuery ทีละหน้า เพื่อลด peak memory ของ Apps Script
function bqQueryEach_(sql, onRow, deadlineMs, useQueryCache) {
  const deadline = Number(deadlineMs || JOB_DEADLINE_MS);
  const started = Date.now();
  // ทดสอบจริงกับ Cube: 30k/หน้าเร็วกว่า 50k และไม่เกิด out of memory แบบ 100k
  // การขอหน้าที่ใหญ่ขึ้นลด network round-trip ของ Apps Script ลงมาก โดยยังอ่านแบบทีละหน้า
  const pageSize = BQ_RESULT_PAGE_ROWS;
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
  const results = [];
  let dashboardTestData = null;
  const pass = function(name, detail) {
    const line = '✅ PASS: ' + name + (detail ? ' — ' + detail : '');
    results.push(line); Logger.log(line);
  };
  const fail = function(name, err) {
    const line = '❌ FAIL: ' + name + ' — ' + String(err && (err.message || err) || err);
    results.push(line); Logger.log(line);
  };

  try {
    if (typeof BigQuery === 'undefined' || !BigQuery.Jobs || !BigQuery.Tables) {
      throw new Error('BigQuery API ยังไม่ได้ Enable');
    }
    pass('BigQuery API');
  } catch (err) { fail('BigQuery API', err); throw err; }

  try {
    const csv = '"KEY001","LPN001",24,"000123","OWNER A",1,"PTT","P001","AA01","2026-08-07 08:00:00",3';
    const parsed = parseUploadCsvRows_(csv, 1, 'csv-v1');
    if (parsed.length !== 1 || parsed[0].length !== 11 || parsed[0][3] !== '000123') {
      throw new Error('CSV parser ไม่รักษา 11 คอลัมน์หรือเลขศูนย์นำหน้า');
    }
    pass('CSV parser', '11 คอลัมน์และรหัส 000123 ถูกต้อง');
  } catch (err) { fail('CSV parser', err); throw err; }

  try {
    const sharedExclusions = getSharedDashboardExclusions_();
    if (!Array.isArray(sharedExclusions.items) || !Array.isArray(sharedExclusions.zones)) {
      throw new Error('Shared exclusions payload ไม่ถูกต้อง');
    }
    pass('Shared exclusions', sharedExclusions.items.length + ' สินค้า · ' + sharedExclusions.zones.length + ' Zone');
  } catch (err) { fail('Shared exclusions', err); throw err; }

  try {
    const shiftCases = bqQueryAll_([
      'WITH cases AS (',
      "  SELECT 'PTT' AS category, DATETIME '2026-08-08 13:59:00' AS raw_ts, DATE '2026-08-08' AS expected_date, 'N' AS expected_shift UNION ALL",
      "  SELECT 'PTT', DATETIME '2026-08-08 14:00:00', DATE '2026-08-08', 'M' UNION ALL",
      "  SELECT 'PTT', DATETIME '2026-08-08 07:00:00', DATE '2026-08-08', 'N' UNION ALL",
      "  SELECT 'BPS', DATETIME '2026-08-08 06:59:00', DATE '2026-08-08', 'N' UNION ALL",
      "  SELECT 'BPS', DATETIME '2026-08-08 07:00:00', DATE '2026-08-08', 'M' UNION ALL",
      "  SELECT 'BPS', DATETIME '2026-08-08 18:59:00', DATE '2026-08-08', 'M' UNION ALL",
      "  SELECT 'BPS', DATETIME '2026-08-08 19:00:00', DATE '2026-08-08', 'N'",
      '), normalized AS (',
      "  SELECT *, IF(category = 'PTT', DATETIME_SUB(raw_ts, INTERVAL 7 HOUR), raw_ts) AS ts FROM cases",
      ')',
      'SELECT COUNTIF(',
      '  DATE(ts) != expected_date',
      "  OR IF(EXTRACT(HOUR FROM ts) >= 7 AND EXTRACT(HOUR FROM ts) < 19, 'M', 'N') != expected_shift",
      ') AS failed_cases FROM normalized'
    ].join('\n'), 60000);
    if (!shiftCases.length || Number(shiftCases[0][0] || 0) !== 0) {
      throw new Error('PTT/BPS normalization หรือขอบเขตเวลา A/B 07:00 ไม่ถูกต้อง');
    }
    pass('Calendar date + time bands', 'PTT -7 ชม., BPS เวลาเดิม, ไม่ย้อนวันหลังเที่ยงคืน; time band 07:00–18:59 / 19:00–06:59 ใช้คำนวณเวลาและ OT');
  } catch (err) { fail('24-hour shift boundaries', err); throw err; }

  try {
    const sundayOt = loadPickerSundayOtCalendar_(true);
    const sundayDates = Object.keys((sundayOt && sundayOt.status) || {});
    const invalidSundayDates = sundayDates.filter(function(date) {
      const value = sundayOt.status[date];
      const parsed = new Date(date + 'T00:00:00+07:00');
      return isNaN(parsed.getTime()) || parsed.getDay() !== 0 || typeof value !== 'boolean';
    });
    if (!sundayDates.length || invalidSundayDates.length) {
      throw new Error('ไม่พบปฏิทินวันอาทิตย์ของ Picker หรือรูปแบบสถานะ OT ไม่ถูกต้อง');
    }
    const openCount = sundayDates.filter(function(date) { return sundayOt.status[date]; }).length;
    pass('Picker Sunday OT calendar',
      sundayDates.length + ' วันอาทิตย์; เปิด OT=' + openCount + ', ปิด=' + (sundayDates.length - openCount));
  } catch (err) { fail('Picker Sunday OT calendar', err); throw err; }

  try {
    const schemaCheck = bqQueryAll_([
      'SELECT',
      '  COUNTIF(column_name = \'pickdetailkey\') AS key_col,',
      '  COUNTIF(column_name = \'owner\') AS owner_col,',
      '  COUNTIF(column_name = \'location\') AS location_col,',
      '  COUNTIF(column_name = \'zone\') AS zone_col',
      'FROM `' + BQ_PROJECT + '.' + BQ_DATASET + '.INFORMATION_SCHEMA.COLUMNS`',
      'WHERE table_name = ' + sqlStringLiteral_(DASHBOARD_TABLE)
    ].join('\n'), 60000);
    if (!schemaCheck.length || Number(schemaCheck[0][0] || 0) !== 1 ||
        Number(schemaCheck[0][1] || 0) !== 1 || Number(schemaCheck[0][2] || 0) !== 1 ||
        Number(schemaCheck[0][3] || 0) !== 1) {
      throw new Error('t_pick_dashboard ต้องมี pickdetailkey + owner + location + zone — ให้รัน refreshDashboardTableNow ก่อน');
    }
    pass('Dashboard schema', 'พบ stable pickdetailkey + owner + location + zone');
  } catch (err) { fail('Dashboard schema', err); throw err; }

  try {
    const stableKeyCheck = bqQueryAll_([
      'SELECT COUNT(*) AS rows_count, COUNT(DISTINCT pickdetailkey) AS unique_keys,',
      '       COUNTIF(pickdetailkey IS NULL OR pickdetailkey = \'\') AS missing_keys',
      'FROM `' + BQ_PROJECT + '.' + BQ_DATASET + '.' + DASHBOARD_TABLE + '`'
    ].join('\n'), 60000);
    if (!stableKeyCheck.length || Number(stableKeyCheck[0][0] || 0) !== Number(stableKeyCheck[0][1] || 0) ||
        Number(stableKeyCheck[0][2] || 0) !== 0) {
      throw new Error('pickdetailkey ใน t_pick_dashboard ต้อง unique และห้ามว่าง');
    }
    pass('Stable-history key', Number(stableKeyCheck[0][0] || 0).toLocaleString() + ' แถว unique ครบ');
  } catch (err) { fail('Stable-history key', err); throw err; }

  try {
    const epoch = getDashboardDataEpoch_();
    const master = buildItemMasterData_(epoch);
    if (master.row_width !== 9 || master.rows.length % 9 !== 0 || master.rows.length === 0) {
      throw new Error('Master_Item payload ว่างหรือรูปแบบไม่ถูกต้อง');
    }
    pass('Master_Item', (master.rows.length / 9).toLocaleString() + ' รายการ · ครบทุก Owner จาก Google Sheet');
  } catch (err) { fail('Master_Item', err); throw err; }

  try {
    const directory = loadPickerDirectory_();
    const responsibilities = directory.responsibilities || {};
    const rosterTeams = directory.rosterTeams || {};
    let aCount = 0, bCount = 0, flexCount = 0, totalPickers = 0;
    Object.keys(responsibilities).forEach(function(id) {
      if (String(responsibilities[id] || '').trim().toUpperCase() !== 'PICKER') return;
      totalPickers++;
      const team = String(rosterTeams[id] || '').trim().toUpperCase();
      if (team === 'A') aCount++;
      else if (team === 'B') bCount++;
      else flexCount++;
    });
    if (totalPickers < 1 || aCount < 1 || bCount < 1) throw new Error('ไม่พบ roster ที่หน้าที่รับผิดชอบ = Picker ครบทั้ง Team A/B');
    pass('Picker roster สำหรับ Planner', 'รวม=' + totalPickers.toLocaleString() + ' คน, กะ A=' + aCount.toLocaleString() + ', กะ B=' + bCount.toLocaleString() + ', Flex=' + flexCount.toLocaleString());
  } catch (err) { fail('Picker roster สำหรับ Planner', err); throw err; }

  try {
    const rosterPayload = buildPickerRosterPayload_(false);
    if (!rosterPayload || rosterPayload.cache_ttl_seconds !== PICKER_ROSTER_CACHE_TTL ||
        !rosterPayload.picker_responsibilities || !rosterPayload.picker_roster_teams) {
      throw new Error('Roster endpoint payload ไม่ครบ');
    }
    pass('Roster refresh endpoint', 'Google Sheet cache ' + Math.round(PICKER_ROSTER_CACHE_TTL / 60) + ' นาที และรองรับ fresh=1');
  } catch (err) { fail('Roster refresh endpoint', err); throw err; }

  try {
    dashboardTestData = buildDashboardData_(false, { excludedItems: [], key: 'test' });
    if (dashboardTestData.PTT.row_width !== 10 || dashboardTestData.PTT.rows.length % 10 !== 0 ||
        dashboardTestData.BPS.row_width !== 10 || dashboardTestData.BPS.rows.length % 10 !== 0) {
      throw new Error('Work cube v22 ต้องมี 10 ช่องและ Active Hour Mask');
    }
    pass('Dashboard query', 'PTT=' + dashboardTestData.PTT.dates.length + ' วัน, BPS=' + dashboardTestData.BPS.dates.length + ' วัน · Work cube มี Active Hour Mask');
  } catch (err) { fail('Dashboard query', err); throw err; }

  try {
    if (!dashboardTestData || !dashboardTestData.PTT) throw new Error('ยังไม่มี Dashboard payload สำหรับตรวจยอด PTT');
    const ptt = dashboardTestData.PTT;
    const testDate = ptt.dates && ptt.dates.length ? ptt.dates[ptt.dates.length - 1] : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(testDate)) throw new Error('ไม่พบวันที่ล่าสุดของ PTT ใน payload');
    const dateIdx = ptt.dates.indexOf(testDate);
    let payloadPcs = 0, payloadUnits = 0, payloadLines = 0;
    for (let i = 0; i < ptt.rows.length; i += 10) {
      if (Number(ptt.rows[i]) !== dateIdx) continue;
      payloadPcs += Number(ptt.rows[i + 4]) || 0;
      payloadUnits += Number(ptt.rows[i + 5]) || 0;
      payloadLines += Number(ptt.rows[i + 6]) || 0;
    }

    // Calendar Date ต้องตรงกับ partition วันนั้นโดยตรง ไม่มีการดึงเช้ามืดของวันถัดไปกลับมา
    const direct = bqQueryAll_([
      'SELECT COUNT(*) AS records, SUM(pcs) AS total_pcs, SUM(pick_qty) AS total_pick_units',
      'FROM `' + BQ_PROJECT + '.' + BQ_DATASET + '.' + DASHBOARD_TABLE + '`',
      "WHERE UPPER(category) = 'PTT'",
      '  AND pick_date = DATE ' + sqlStringLiteral_(testDate)
    ].join('\n'), 60000);
    if (!direct.length) throw new Error('BigQuery ไม่ส่งผลตรวจยอด PTT');
    const bqLines = Number(direct[0][0]) || 0;
    const bqPcs = Number(direct[0][1]) || 0;
    const bqUnits = Number(direct[0][2]) || 0;
    const near = function(a, b) { return Math.abs(Number(a || 0) - Number(b || 0)) < 0.000001; };
    if (!near(payloadPcs, bqPcs) || !near(payloadUnits, bqUnits) || payloadLines !== bqLines) {
      throw new Error(
        'ยอด PTT ไม่ตรงกัน วันที่ ' + testDate +
        ' | Payload pcs=' + payloadPcs + ', units=' + payloadUnits + ', rows=' + payloadLines +
        ' | BigQuery pcs=' + bqPcs + ', units=' + bqUnits + ', rows=' + bqLines
      );
    }
    pass('PTT Calendar-date reconciliation',
      testDate + ' → ' + Number(payloadUnits).toLocaleString() + ' หน่วยหยิบ, ' +
      Number(payloadPcs).toLocaleString() + ' ชิ้น, ' + Number(payloadLines).toLocaleString() + ' records ตรง BigQuery');
  } catch (err) { fail('PTT Calendar-date reconciliation', err); throw err; }

  try {
    const bounds = getOrLoadDashboardBounds_();
    const testDate = bounds.maxDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(testDate)) throw new Error('ไม่พบวันที่ล่าสุด');
    const fakeEvent = { parameter: {
      system: 'PTT', from: testDate, to: testDate, shift: 'all', excluded_items: '[]'
    }};
    const itemCube = buildItemCubeData_(fakeEvent, getDashboardDataEpoch_());
    if (itemCube.row_width !== 7 || itemCube.rows.length % 7 !== 0) {
      throw new Error('Fast Item cube ต้องมี 7 ช่อง: Location, Zone, Owner, Item, Pcs, Units, Lines');
    }
    pass('Owner + Item + Location/Zone mapping', (itemCube.rows.length / 7).toLocaleString() + ' กลุ่มในวันที่ ' + testDate + ' · ครบทุก Owner');
  } catch (err) { fail('Owner + Item mapping', err); throw err; }

  const summary = '🎉 TEST RUN PASSED — Calendar Date + PTT totals ถูกต้อง พร้อม Deploy\n' + results.join('\n');
  Logger.log(summary);
  return { status: 'success', message: 'TEST RUN PASSED', checks: results };
}
