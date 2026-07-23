-- =============================================================================
--  PICK ANALYTICS – BigQuery SQL  (Master_Pick Details)
--  ผู้ช่วย: Operation / Data Analyst – ธุรกิจคลังสินค้า
--  อัปเดตล่าสุด: 2026-07-16
-- =============================================================================
--  ไฟล์นี้ครอบคลุม:
--    1) สร้าง dataset + ตารางหลัก (schema สะอาด)
--    2) โหลดข้อมูล + กันข้อมูลเบิ้ล (MERGE บน PICKDETAILKEY)  <-- หัวใจกันยอดผิด
--    3) View ทำความสะอาด/แปลง: เวลา PTT -7ชม., Zone, Time Slot
--    4) View วิเคราะห์ Productivity (หยิบ/ชม.) ตามกติกาที่ตกลง
--    5) View สรุปสำหรับ Dashboard (daily / weekly / monthly / zone / picker / item)
--
--  วิธีใช้: แก้ค่า `productivity-pick` และ `pick_analytics` (ชื่อ dataset) ให้เป็นของนาย
--          แล้วรันทีละบล็อกใน BigQuery Console
--
--  ⚠️ ข้อสมมติที่ต้องช่วยยืนยัน (ผิดแก้ได้):
--    - "ยอดหยิบ" ในสูตร Productivity = ผลรวมจำนวนชิ้น SUM(qty) จากคอลัมน์ AC (QTY)
--    - "ชั่วโมงการทำงาน" = ช่วงเวลาจากหยิบชิ้นแรกถึงชิ้นสุดท้ายของคนนั้นในวันนั้น
--      (เพราะไฟล์มีแต่เวลา pick ไม่มีเวลาตอกบัตร) — ถ้ามีชั่วโมงจริงจากระบบ HR บอกได้
--    - Picker = คอลัมน์ BE (รหัสตัวเลข) รอ map รหัส->ชื่อ จากนาย
-- =============================================================================


-- =============================================================================
-- 1) สร้าง DATASET + ตารางหลัก
-- =============================================================================
-- ⚠️ สร้าง dataset ผ่านหน้า UI ก่อน (ไม่ใช้ CREATE SCHEMA ที่นี่ เพื่อเลี่ยง error เรื่อง region ไม่ตรง)
--    Explorer > productivity-pick > ⋮ (More) > Create dataset
--    Dataset ID = pick_analytics , Location type = Region > asia-southeast1
--    (ต้องเป็น asia-southeast1 ให้ตรงกับ bucket ไม่งั้น External Table อ่านไม่ได้)

-- ตารางหลัก: เก็บเฉพาะคอลัมน์ที่ใช้จริง (ขยายเพิ่มได้ภายหลัง)
CREATE TABLE IF NOT EXISTS `productivity-pick.pick_analytics.pick_detail`
(
  pickdetailkey   STRING  NOT NULL,   -- คอลัมน์ B (PICKDETAILKEY) = กุญแจไม่ซ้ำ / กันเบิ้ล
  lpn             STRING,             -- คอลัมน์ M (ID)
  qty             INT64,              -- คอลัมน์ AC (QTY) จำนวนชิ้นหยิบ
  sku             STRING,             -- คอลัมน์ AF (SKU) รหัส Item
  owner           STRING,             -- คอลัมน์ AK (STORERKEY) Owner
  uom_qty         NUMERIC,            -- คอลัมน์ AO (UOMQTY)
  category        STRING,             -- คอลัมน์ BD (EXT_UDF_STR7) = BPS / PTT
  picker_id       STRING,             -- คอลัมน์ BE (EXT_UDF_STR8) รหัส Picker
  location        STRING,             -- คอลัมน์ BM (EXT_UDF_STR16) เช่น AH016A01
  pick_ts_source  STRING,             -- คอลัมน์ BO ข้อความเวลาเดิม เช่น "14/07/2026 14:33" (DD/MM/YYYY 24ชม.)
  loaded_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
PARTITION BY DATE(loaded_at)
CLUSTER BY category, picker_id;


-- =============================================================================
-- 2) โหลดข้อมูล + กันข้อมูลเบิ้ล (MERGE)
-- =============================================================================
-- แนวคิด: โหลดไฟล์ใหม่เข้า "staging" ก่อน แล้ว MERGE เข้าตารางหลัก
--         ถ้า pickdetailkey มีอยู่แล้ว -> ไม่ทำอะไร (ไม่ insert ซ้ำ = ไม่เบิ้ล)
--
-- วิธีเอาข้อมูลเข้า staging เลือกทางใดทางหนึ่ง:
--   (A) ผมจะแปลงไฟล์ export ของนายให้เป็น CSV สะอาด แล้วนาย `bq load` เข้าตารางนี้
--       (CSV จากหัวหน้ามี header 2 แถว: แถว1=ชื่อฟิลด์เทคนิค, แถว2=label, ข้อมูลเริ่มแถว3)
--       bq load --source_format=CSV --skip_leading_rows=2 \
--         productivity-pick:pick_analytics.pick_detail_staging  ./pick_clean.csv  schema.json
--   (B) ทำ External Table ชี้ไปที่ Google Sheet ตรงๆ (ข้อมูลสดทุกชม.)
--       แล้ว SELECT map คอลัมน์เข้ามาแทน (ดูหมายเหตุท้ายไฟล์)

CREATE TABLE IF NOT EXISTS `productivity-pick.pick_analytics.pick_detail_staging`
LIKE `productivity-pick.pick_analytics.pick_detail`;

-- ---- รัน MERGE นี้ทุกครั้งหลังโหลดข้อมูลใหม่เข้า staging ----
MERGE `productivity-pick.pick_analytics.pick_detail` T
USING (
  -- กันกรณีในไฟล์เดียวกันมี key ซ้ำ: เก็บแถวเดียวต่อ 1 key
  SELECT * EXCEPT(rn) FROM (
    SELECT s.*, ROW_NUMBER() OVER (
             PARTITION BY pickdetailkey ORDER BY pick_ts_source DESC
           ) AS rn
    FROM `productivity-pick.pick_analytics.pick_detail_staging` s
  ) WHERE rn = 1
) S
ON T.pickdetailkey = S.pickdetailkey
WHEN NOT MATCHED THEN
  INSERT (pickdetailkey, lpn, qty, sku, owner, uom_qty, category,
          picker_id, location, pick_ts_source, loaded_at)
  VALUES (S.pickdetailkey, S.lpn, S.qty, S.sku, S.owner, S.uom_qty, S.category,
          S.picker_id, S.location, S.pick_ts_source, CURRENT_TIMESTAMP());
-- (ทางเลือก) ถ้าต้องการให้ข้อมูลเก่าถูกอัปเดตเมื่อมีการแก้ไข ให้เพิ่ม:
-- WHEN MATCHED THEN UPDATE SET qty = S.qty, location = S.location, ...

-- ล้าง staging หลัง merge เสร็จ (พร้อมรับไฟล์รอบถัดไป)
TRUNCATE TABLE `productivity-pick.pick_analytics.pick_detail_staging`;


-- =============================================================================
-- 3) VIEW ทำความสะอาด/แปลง: เวลา (PTT -7ชม.), Zone
-- =============================================================================
CREATE OR REPLACE VIEW `productivity-pick.pick_analytics.v_pick_clean` AS
SELECT
  pickdetailkey,
  lpn,
  qty,
  sku,
  owner,
  uom_qty,
  -- คำนวณจำนวนหน่วยหยิบจริง (Pick Units: ชิ้น สำหรับ BPS / กล่องสำหรับ PTT)
  SAFE_DIVIDE(qty, COALESCE(NULLIF(uom_qty, 0), 1)) AS pick_qty,
  UPPER(category) AS category,
  picker_id,
  location,
  SUBSTR(location, 1, 2) AS zone,                       -- Zone = 2 ตัวหน้าของ Location
  pick_ts_source,
  -- เวลาที่ parse จากข้อความ (ยังไม่ปรับ timezone)
  SAFE.PARSE_DATETIME('%d/%m/%Y %H:%M', pick_ts_source) AS pick_ts,
  -- กติกา: PTT -> ลบ 7 ชั่วโมง, BPS -> เท่าเดิม
  CASE
    WHEN UPPER(category) = 'PTT'
      THEN DATETIME_SUB(SAFE.PARSE_DATETIME('%d/%m/%Y %H:%M', pick_ts_source), INTERVAL 7 HOUR)
    ELSE SAFE.PARSE_DATETIME('%d/%m/%Y %H:%M', pick_ts_source)
  END AS pick_ts_local
FROM `productivity-pick.pick_analytics.pick_detail`;


-- VIEW เสริม: เพิ่ม วันที่ / ชั่วโมง / Time Slot / สัปดาห์ / เดือน
CREATE OR REPLACE VIEW `productivity-pick.pick_analytics.v_pick_enriched` AS
SELECT
  *,
  DATE(pick_ts_local)                                   AS pick_date,
  EXTRACT(HOUR FROM pick_ts_local)                      AS pick_hour,
  FORMAT('%02d:00-%02d:59',
         EXTRACT(HOUR FROM pick_ts_local),
         EXTRACT(HOUR FROM pick_ts_local))              AS time_slot,   -- Time Slot รายชั่วโมง
  DATE_TRUNC(DATE(pick_ts_local), WEEK(MONDAY))         AS week_start,
  DATE_TRUNC(DATE(pick_ts_local), MONTH)                AS month_start
FROM `productivity-pick.pick_analytics.v_pick_clean`
WHERE pick_ts_local IS NOT NULL;


-- =============================================================================
-- 4) VIEW วิเคราะห์ PRODUCTIVITY  (หยิบ/ชั่วโมง)
-- =============================================================================
--  กติกา:
--   - Productivity = ยอดหยิบ (SUM pick_qty) / ชั่วโมงทำงาน   [ต่อ Picker ต่อวัน]
--   - ถ้า ชั่วโมงทำงาน > 3  และ  Productivity > 1000  ->  ให้ = 0 (กันเคสหยิบชิ้นเล็กจำนวนมาก)
--   - ตอนหา Average ให้ตัดค่า 0 ทิ้ง (ดูตัวอย่าง query ด้านล่าง)
CREATE OR REPLACE VIEW `productivity-pick.pick_analytics.v_productivity_daily` AS
WITH base AS (
  SELECT
    picker_id,
    DATE(pick_ts_local) AS pick_date,
    SUM(pick_qty)       AS total_qty,       -- ยอดหยิบ (หน่วยหยิบจริง)
    COUNT(*)            AS pick_lines,      -- จำนวนบรรทัดที่หยิบ
    MIN(pick_ts_local)  AS first_pick,
    MAX(pick_ts_local)  AS last_pick
  FROM `productivity-pick.pick_analytics.v_pick_clean`
  WHERE pick_ts_local IS NOT NULL AND picker_id IS NOT NULL
  GROUP BY picker_id, pick_date
),
calc AS (
  SELECT
    *,
    DATETIME_DIFF(last_pick, first_pick, SECOND) / 3600.0 AS work_hours
  FROM base
)
SELECT
  picker_id,
  pick_date,
  total_qty,
  pick_lines,
  first_pick,
  last_pick,
  ROUND(work_hours, 2) AS work_hours,
  ROUND(SAFE_DIVIDE(total_qty, work_hours), 2) AS raw_productivity,   -- ก่อนใช้กติกา
  -- Productivity หลังใช้กติกา
  CASE
    WHEN work_hours > 3 AND SAFE_DIVIDE(total_qty, work_hours) > 1000 THEN 0
    ELSE ROUND(SAFE_DIVIDE(total_qty, work_hours), 2)
  END AS productivity
FROM calc;


-- ตัวอย่าง: Average Productivity รายวัน (ตัดค่า 0 ทิ้งตามกติกา)
-- SELECT pick_date,
--        ROUND(AVG(IF(productivity > 0, productivity, NULL)), 2) AS avg_productivity,
--        COUNT(DISTINCT picker_id) AS pickers
-- FROM `productivity-pick.pick_analytics.v_productivity_daily`
-- GROUP BY pick_date ORDER BY pick_date;


-- =============================================================================
-- 5) VIEWS สรุปสำหรับ DASHBOARD
-- =============================================================================

-- 5.1 สรุปรายวัน (Month-to-date / Daily)
--     แยกนับ volume กับ productivity คนละชั้น เพื่อไม่ให้ค่าเฉลี่ยถูกถ่วงน้ำหนักด้วยจำนวนบรรทัด
CREATE OR REPLACE VIEW `productivity-pick.pick_analytics.v_dash_daily` AS
WITH vol AS (
  SELECT
    pick_date,
    COUNT(*)                    AS pick_lines,
    SUM(pick_qty)               AS total_qty,
    COUNT(DISTINCT picker_id)   AS active_pickers,
    COUNT(DISTINCT zone)        AS zones_used
  FROM `productivity-pick.pick_analytics.v_pick_enriched`
  GROUP BY pick_date
),
prod AS (
  SELECT
    pick_date,
    ROUND(AVG(IF(productivity > 0, productivity, NULL)), 2) AS avg_productivity
  FROM `productivity-pick.pick_analytics.v_productivity_daily`
  GROUP BY pick_date
)
SELECT v.pick_date, v.pick_lines, v.total_qty, v.active_pickers, v.zones_used,
       p.avg_productivity
FROM vol v
LEFT JOIN prod p USING (pick_date)
ORDER BY v.pick_date;

-- 5.2 สรุปรายสัปดาห์
CREATE OR REPLACE VIEW `productivity-pick.pick_analytics.v_dash_weekly` AS
SELECT week_start,
       COUNT(*) AS pick_lines,
       SUM(pick_qty) AS total_qty,
       COUNT(DISTINCT picker_id) AS active_pickers
FROM `productivity-pick.pick_analytics.v_pick_enriched`
GROUP BY week_start;

-- 5.3 สรุปรายเดือน
CREATE OR REPLACE VIEW `productivity-pick.pick_analytics.v_dash_monthly` AS
SELECT month_start,
       COUNT(*) AS pick_lines,
       SUM(pick_qty) AS total_qty,
       COUNT(DISTINCT picker_id) AS active_pickers
FROM `productivity-pick.pick_analytics.v_pick_enriched`
GROUP BY month_start;

-- 5.4 สรุปตาม Zone (+ Owner ที่เจอในโซนนั้น)
CREATE OR REPLACE VIEW `productivity-pick.pick_analytics.v_dash_by_zone` AS
SELECT zone,
       ARRAY_AGG(DISTINCT owner IGNORE NULLS) AS owners_in_zone,
       COUNT(*)  AS pick_lines,
       SUM(pick_qty)  AS total_qty,
       COUNT(DISTINCT picker_id) AS pickers
FROM `productivity-pick.pick_analytics.v_pick_enriched`
GROUP BY zone ORDER BY total_qty DESC;

-- 5.5 สรุปตาม Picker (+ โซนที่ทำบ่อยสุด + productivity เฉลี่ยตัดศูนย์)
CREATE OR REPLACE VIEW `productivity-pick.pick_analytics.v_dash_by_picker` AS
WITH vol AS (
  SELECT picker_id, COUNT(*) AS pick_lines, SUM(pick_qty) AS total_qty
  FROM `productivity-pick.pick_analytics.v_pick_enriched`
  GROUP BY picker_id
),
prod AS (
  SELECT picker_id,
         ROUND(AVG(IF(productivity > 0, productivity, NULL)), 2) AS avg_productivity,
         COUNT(DISTINCT pick_date) AS days_worked
  FROM `productivity-pick.pick_analytics.v_productivity_daily`
  GROUP BY picker_id
),
main_zone AS (   -- โซนที่ picker แต่ละคนทำบ่อยที่สุด
  SELECT picker_id, zone AS main_zone FROM (
    SELECT picker_id, zone,
           ROW_NUMBER() OVER (PARTITION BY picker_id ORDER BY COUNT(*) DESC) AS rn
    FROM `productivity-pick.pick_analytics.v_pick_enriched`
    GROUP BY picker_id, zone
  ) WHERE rn = 1
)
SELECT
  v.picker_id,
  mz.main_zone,
  v.pick_lines,
  v.total_qty,
  p.avg_productivity,
  p.days_worked
FROM vol v
LEFT JOIN prod p       USING (picker_id)
LEFT JOIN main_zone mz USING (picker_id)
ORDER BY v.total_qty DESC;

-- 5.6 สรุปตาม Item (Top SKU)
CREATE OR REPLACE VIEW `productivity-pick.pick_analytics.v_dash_by_item` AS
SELECT sku,
       COUNT(*) AS pick_lines,
       SUM(pick_qty) AS total_qty
FROM `productivity-pick.pick_analytics.v_pick_enriched`
GROUP BY sku ORDER BY total_qty DESC;

-- 5.7 สรุปตาม Time Slot (ดูช่วงเวลาที่งานหนัก)
CREATE OR REPLACE VIEW `productivity-pick.pick_analytics.v_dash_by_timeslot` AS
SELECT time_slot, pick_hour,
       COUNT(*) AS pick_lines,
       SUM(pick_qty) AS total_qty
FROM `productivity-pick.pick_analytics.v_pick_enriched`
GROUP BY time_slot, pick_hour ORDER BY pick_hour;

-- 5.8 สรุปตาม Category (BPS vs PTT)
CREATE OR REPLACE VIEW `productivity-pick.pick_analytics.v_dash_by_category` AS
SELECT category,
       COUNT(*) AS pick_lines,
       SUM(pick_qty) AS total_qty,
       COUNT(DISTINCT picker_id) AS pickers
FROM `productivity-pick.pick_analytics.v_pick_enriched`
GROUP BY category;


-- =============================================================================
--  หมายเหตุ: ตารางสำหรับ map ข้อมูลเพิ่ม (นายจะส่งมาให้)
-- =============================================================================
--  เมื่อได้ไฟล์ map แล้ว สร้างตารางเหล่านี้แล้ว JOIN เพื่อโชว์ชื่อจริง:
--    dim_picker(picker_id STRING, picker_name STRING, shift STRING)   -- ชื่อ + กะ A/B/C
--    dim_item(sku STRING, item_name STRING)                           -- ชื่อสินค้า
--    dim_zone_owner(zone STRING, owner STRING)                        -- Zone -> Owner
--  ตัวอย่าง JOIN:
--    SELECT p.*, d.picker_name, d.shift
--    FROM `productivity-pick.pick_analytics.v_dash_by_picker` p
--    LEFT JOIN `productivity-pick.pick_analytics.dim_picker` d USING (picker_id);
--
-- -----------------------------------------------------------------------------
--  ทางเลือก (B): External Table ชี้ Google Sheet ตรงๆ (ข้อมูลสดทุกชม.)
-- -----------------------------------------------------------------------------
--  หมายเหตุ: ชีทมี header 2 แถว + คอลัมน์ A เป็นตัวอธิบาย ให้ตั้ง skip_leading_rows=2
--  แล้ว map คอลัมน์ตามตำแหน่ง (B,M,AC,AF,AK,AO,BD,BE,BM,BO) เข้ามาแทน pick_detail
--  เหมาะกับดูสด แต่ถ้าต้องเก็บ history + กันเบิ้ล แนะนำใช้ตารางจริง + MERGE (ข้อ 2)
-- =============================================================================
