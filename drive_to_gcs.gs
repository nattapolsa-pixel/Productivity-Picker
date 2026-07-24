/**********************************************************************
 * LEGACY ONLY — ไม่ใช้กับ Flow ปัจจุบัน
 * ระบบปัจจุบันอัปโหลด Pick Detail จากหน้าเว็บเข้า BigQuery แบบ batch
 * ห้ามสร้าง time trigger ของไฟล์นี้กลับมาโดยไม่วางแผน migration ใหม่
 **********************************************************************/

/*************************************************************
 *  Drive -> GCS : เก็บ (archive) ทุกเวอร์ชันของไฟล์ CSV
 *
 *  บริบท: หัวหน้าใช้ "ไฟล์เดียว" เวลาอัปข้อมูลใหม่จะเขียนทับของเก่า
 *         สคริปต์นี้จะคอยดูโฟลเดอร์ Drive แล้ว "ก็อปทุกครั้งที่ไฟล์เปลี่ยน"
 *         ไปเก็บใน Google Cloud Storage (GCS) เป็นชื่อไม่ซ้ำ (ตามเวลาแก้ไข)
 *         => เวอร์ชันเก่าไม่มีทางหาย แม้ Drive จะถูกทับ
 *
 *  ตั้ง trigger ให้รัน "ถี่กว่า" รอบที่หัวหน้าอัป (default = ทุก 30 นาที)
 *
 *  ต้องตั้ง OAuth scopes ใน appsscript.json (ดูคู่มือ SETUP ข้อ 2):
 *    drive.readonly, devstorage.read_write, script.external_request, script.scriptapp
 *************************************************************/

// ============ แก้ค่าตรงนี้ ============
const DRIVE_FOLDER_ID = '1cL6ED1vIRfoBgkC0aTkYQ-zUgRzUz0wR';        // โฟลเดอร์ Drive ที่หัวหน้าวางไฟล์
const GCS_BUCKET      = 'pick-raw-productivity-pick';               // ต้องตรงกับใน pipeline_gcs_to_bigquery.sql
const GCS_PREFIX      = 'pick_raw/';                                // โฟลเดอร์ย่อยในถัง (ตรงกับ uris ใน SQL)
// =====================================

/**
 * ฟังก์ชันหลัก — ให้ trigger เรียกทุก 30 นาที
 * ก็อปเฉพาะไฟล์ที่ "แก้ไขใหม่กว่าครั้งก่อน" (กันก็อปซ้ำ)
 */
function copyNewToGcs() {
  const props  = PropertiesService.getScriptProperties();
  const lastTs = Number(props.getProperty('LAST_TS') || '0');
  const token  = ScriptApp.getOAuthToken();
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const files  = folder.getFiles();

  let maxTs = lastTs, copied = 0;
  while (files.hasNext()) {
    const f = files.next();
    if (!f.getName().toLowerCase().endsWith('.csv')) continue;   // เอาเฉพาะ .csv

    const t = f.getLastUpdated().getTime();
    if (t <= lastTs) continue;                                   // เวอร์ชันนี้ก็อปไปแล้ว ข้าม

    // ตั้งชื่อ object ใน GCS ให้ไม่ซ้ำต่อ 1 เวอร์ชัน (เวลาแก้ไข + millis)
    const stamp  = Utilities.formatDate(f.getLastUpdated(), 'Asia/Bangkok', 'yyyyMMdd_HHmmss');
    const object = GCS_PREFIX + 'pick_' + stamp + '_' + t + '.csv';

    const url = 'https://storage.googleapis.com/upload/storage/v1/b/' +
                encodeURIComponent(GCS_BUCKET) +
                '/o?uploadType=media&name=' + encodeURIComponent(object);

    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'text/csv',
      payload: f.getBlob().getBytes(),          // ก็อปไฟล์ทั้งก้อน (16MB อยู่ในลิมิต UrlFetch 50MB)
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });

    if (res.getResponseCode() === 200) {
      copied++;
      if (t > maxTs) maxTs = t;
      Logger.log('OK  -> gs://' + GCS_BUCKET + '/' + object);
    } else {
      Logger.log('FAIL ' + f.getName() + ' : ' + res.getResponseCode() + ' ' + res.getContentText());
    }
  }

  props.setProperty('LAST_TS', String(maxTs));
  Logger.log('เสร็จ: ก็อปใหม่ ' + copied + ' เวอร์ชัน');
}

/**
 * รัน "ครั้งเดียว" เพื่อสร้าง trigger อัตโนมัติทุก 30 นาที
 * (ถ้าหัวหน้าอัปถี่กว่านั้น ให้เปลี่ยน everyMinutes เป็น 15)
 */
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'copyNewToGcs') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('copyNewToGcs').timeBased().everyMinutes(30).create();
  Logger.log('ตั้ง trigger ก็อปทุก 30 นาที เรียบร้อย');
}

/**
 * (ทางเลือก) ล้างสถานะ — บังคับให้ก็อปไฟล์ปัจจุบันใหม่อีกครั้ง
 */
function resetState() {
  PropertiesService.getScriptProperties().deleteProperty('LAST_TS');
  Logger.log('reset LAST_TS แล้ว (รอบหน้าจะก็อปไฟล์ปัจจุบันใหม่)');
}
