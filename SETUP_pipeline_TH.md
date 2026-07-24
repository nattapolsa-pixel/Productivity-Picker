# ⚠️ Legacy — ไม่ใช้กับ Flow ปัจจุบัน

เอกสารนี้เก็บไว้เพื่ออ้างอิงระบบเดิม Google Drive → GCS เท่านั้น ระบบปัจจุบันให้นำไฟล์ Pick Detail ผ่านหน้าเว็บ แล้ว Apps Script ใช้ BigQuery batch load และ MERGE โดยตรง ตาม `SETUP_dashboard_live_TH.md`

ห้ามเปิด `copyNewToGcs` trigger หรือ Scheduled Query จากเอกสารนี้กลับมา เพราะข้อมูลเก่าจาก GCS อาจถูกนำเข้าซ้ำ

---

# คู่มือวางระบบเก็บข้อมูล Pick ต่อเนื่อง (Drive → GCS → BigQuery)

เป้าหมาย: หัวหน้าอัปไฟล์ทับของเก่าใน Drive → ระบบเก็บทุกเวอร์ชันอัตโนมัติ → รวมเข้า BigQuery แบบ **กันข้อมูลเบิ้ล + สะสมประวัติ ไม่มีตกหล่น**

ไฟล์ที่เกี่ยวข้อง (อยู่ในโฟลเดอร์นี้):
- `drive_to_gcs.gs` — Apps Script ก็อปไฟล์ Drive → GCS
- `pipeline_gcs_to_bigquery.sql` — External Table + MERGE
- `pick_analytics_bigquery.sql` — ตาราง `pick_detail` + views วิเคราะห์

> ค่าที่ใช้ร่วมกัน: project = `productivity-pick`, dataset = `pick_analytics`, bucket = `pick-raw-productivity-pick`, region = `asia-southeast1`
> ⚠️ ชื่อ bucket ต้อง **unique ทั่วโลก** ถ้าซ้ำให้เปลี่ยน แล้วแก้ให้ตรงกันทั้งใน `.gs` และ `.sql`

---

## ขั้นที่ 1 — สร้างถัง (Bucket) ใน Cloud Storage
1. เปิด BigQuery/Cloud Console → เมนู **Cloud Storage → Buckets → Create**
2. ตั้งชื่อ `pick-raw-productivity-pick`
3. Location type = **Region** → เลือก **asia-southeast1 (Singapore)** ← ต้องตรงกับ dataset
4. ที่เหลือ default → Create

---

## ขั้นที่ 2 — วาง Apps Script (ตัวก็อป Drive → GCS)
1. ไปที่ https://script.google.com → **New project**
2. วางเนื้อหาไฟล์ `drive_to_gcs.gs` ลงไป
3. เมนูซ้าย **Project Settings** → ติ๊ก **"Show appsscript.json"**
4. เปิดไฟล์ `appsscript.json` แล้ววางทับด้วย:

```json
{
  "timeZone": "Asia/Bangkok",
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/devstorage.read_write",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/script.scriptapp"
  ]
}
```

5. **Project Settings → Google Cloud Platform (GCP) Project → Change project** → ใส่ Project number `312654375769` (productivity-pick) เพื่อให้สิทธิ์/บิลตรงกัน
6. กลับมาหน้าโค้ด เลือกฟังก์ชัน **`copyNewToGcs`** กด **Run** → อนุญาตสิทธิ์ (Authorize) ครั้งแรก
   - รอบนี้จะก็อป "ไฟล์ปัจจุบัน" ขึ้น GCS 1 เวอร์ชัน (backfill) — เช็คใน bucket ว่ามีไฟล์ `pick_raw/pick_....csv`
7. เลือกฟังก์ชัน **`setupTrigger`** กด **Run** 1 ครั้ง → ระบบจะก็อปอัตโนมัติทุก 30 นาที
   - ถ้าหัวหน้าอัปถี่กว่านั้น แก้ `everyMinutes(30)` เป็น `15` ในโค้ด

> **สำคัญเรื่อง "เก็บให้ทัน":** ตั้งให้ก็อปถี่กว่ารอบที่หัวหน้าเขียนทับ ระบบจะเก็บทุกเวอร์ชันเป็นไฟล์แยกใน GCS ไม่ทับกัน จึงไม่มีทางตกหล่น

---

## ขั้นที่ 3 — สร้างตาราง + views ใน BigQuery
1. เปิด **BigQuery** ใน project `productivity-pick`
2. รันไฟล์ `pick_analytics_bigquery.sql` **ทีละบล็อก** ตั้งแต่ข้อ 1 (สร้าง dataset + `pick_detail`) ถึงข้อ 5 (views)
   - ข้าม "ข้อ 2 (staging + MERGE)" ได้ เพราะเราจะใช้ MERGE จาก External Table แทน (ขั้นที่ 4)

---

## ขั้นที่ 4 — เชื่อม GCS เข้า BigQuery + ตั้งรวมข้อมูลอัตโนมัติ
1. เปิดไฟล์ `pipeline_gcs_to_bigquery.sql`
2. รัน **ข้อ 1** (สร้าง `pick_ext` — External Table ที่อ่านไฟล์ทุกไฟล์ใน bucket ด้วย `*.csv`)
3. รัน **ข้อ 2** (MERGE) หนึ่งครั้ง เพื่อโหลดข้อมูลก้อนแรกเข้า `pick_detail`
4. ตั้งให้รันเองทุกชั่วโมง: คัดลอก SQL ของ **ข้อ 2 (MERGE)** → กด **Schedule → Create new scheduled query**
   - Repeats = Hourly → Save
   - ตั้งแต่นี้ทุกชั่วโมง BigQuery จะดึงไฟล์ใหม่จาก GCS มา MERGE ให้เอง (key ซ้ำถูกข้าม = ไม่เบิ้ล)

---

## ขั้นที่ 5 (แนะนำ) — ตั้งลบไฟล์เก่าใน GCS อัตโนมัติ (คุมค่าใช้จ่าย)
ข้อมูลถูกสะสมถาวรใน `pick_detail` แล้ว ไฟล์ดิบใน GCS เก็บไว้แค่กันพลาดพอ
- Cloud Storage → bucket → **Lifecycle → Add rule** → Delete object → Age **3 days**

---

## ขั้นที่ 6 — ตรวจสอบ
รันใน BigQuery:
```sql
SELECT COUNT(*) AS total_rows,
       COUNT(DISTINCT pickdetailkey) AS distinct_keys
FROM `productivity-pick.pick_analytics.pick_detail`;
```
- `total_rows` ต้อง **เท่ากับ** `distinct_keys` เสมอ → ยืนยันว่าไม่มีข้อมูลเบิ้ล
- ลองดูผลวิเคราะห์: `SELECT * FROM \`productivity-pick.pick_analytics.v_dash_daily\` ORDER BY pick_date;`

---

## สรุปการไหลของข้อมูล
```
หัวหน้าอัป CSV (ทับไฟล์เดิมใน Drive)
        │  (Apps Script ก็อปทุก 30 นาที, ชื่อไม่ซ้ำ)
        ▼
GCS: gs://pick-raw-productivity-pick/pick_raw/pick_<เวลา>.csv   ← เก็บทุกเวอร์ชัน
        │  (External Table อ่านทั้งโฟลเดอร์ *.csv)
        ▼
BigQuery MERGE (ทุกชั่วโมง, กันเบิ้ลด้วย PICKDETAILKEY)
        ▼
ตาราง pick_detail (สะสมถาวร) → views วิเคราะห์ → Dashboard
```
