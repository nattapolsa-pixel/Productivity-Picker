-- LEGACY ONLY — ไม่ใช้กับ Flow ปัจจุบัน
-- ระบบปัจจุบันใช้หน้าเว็บ -> Apps Script batch load -> BigQuery MERGE
-- ห้ามนำ Scheduled Query ของไฟล์นี้กลับมาเปิด เพราะจะอ่านข้อมูลเก่าจาก GCS ซ้ำ

-- =============================================================================
--  PIPELINE: Drive -> GCS -> BigQuery  (ต่อเนื่อง + กันข้อมูลเบิ้ล)
--  ใช้คู่กับ pick_analytics_bigquery.sql (ตาราง pick_detail + views วิเคราะห์)
--
--  ⚠️ แก้ก่อนรัน: เปลี่ยน  pick-raw-productivity-pick  ให้เป็นชื่อ GCS bucket จริง
--     (ต้องเป็นชื่อเดียวกับที่ตั้งใน Apps Script drive_to_gcs.gs และ unique ทั่วโลก)
--     bucket ต้องอยู่ region asia-southeast1 ให้ตรงกับ dataset
--
--  ภาพรวม: อ่านไฟล์ CSV ทุกไฟล์ในโฟลเดอร์ GCS ด้วย wildcard (ไม่สนชื่อไฟล์)
--          แล้ว MERGE เข้า pick_detail โดยกันเบิ้ลด้วย PICKDETAILKEY
--          รันซ้ำได้ตลอด/กี่รอบก็ได้ ยอดไม่มีทางเบิ้ล
-- =============================================================================


-- =============================================================================
-- 1) EXTERNAL TABLE — ชี้ไฟล์ CSV ทุกไฟล์ในโฟลเดอร์ GCS (wildcard)
--    header ของไฟล์มี 2 แถว (แถว1 ชื่อฟิลด์, แถว2 label) -> skip_leading_rows = 2
--    ทุกคอลัมน์อ่านมาเป็น STRING ก่อน แล้วค่อยแปลงชนิดตอน MERGE
-- =============================================================================
CREATE OR REPLACE EXTERNAL TABLE `productivity-pick.pick_analytics.pick_ext`
(
  `descriptor` STRING,
  `PICKDETAILKEY` STRING,
  `BATCHCARTONID` STRING,
  `CARTONGROUP` STRING,
  `CARTONTYPE` STRING,
  `CASEID` STRING,
  `CROSSDOCKED` STRING,
  `DOCARTONIZE` STRING,
  `DOOR` STRING,
  `DROPID` STRING,
  `EFFECTIVEDATE` STRING,
  `FREIGHTCHARGES` STRING,
  `ID` STRING,
  `INTERMODALVEHICLE` STRING,
  `ISCLOSED` STRING,
  `LOADID` STRING,
  `LOC` STRING,
  `LOT` STRING,
  `ORDERKEY` STRING,
  `ORDERLINENUMBER` STRING,
  `PACKKEY` STRING,
  `PDUDF1` STRING,
  `PDUDF2` STRING,
  `PDUDF3` STRING,
  `PICKHEADERKEY` STRING,
  `PICKNOTES` STRING,
  `QCREQUIRED` STRING,
  `QCSTATUS` STRING,
  `QTY` STRING,
  `RECEIPTKEY` STRING,
  `ROUTE` STRING,
  `SKU` STRING,
  `SORTATIONLOCATION` STRING,
  `SORTATIONSTATION` STRING,
  `STATUS` STRING,
  `STOP` STRING,
  `STORERKEY` STRING,
  `TOLOC` STRING,
  `TRACKINGID` STRING,
  `UOM` STRING,
  `UOMQTY` STRING,
  `WAVEKEY` STRING,
  `ASSIGNMENTNUMBER` STRING,
  `EQUIPMENTTYPE` STRING,
  `EQUIPMENTID` STRING,
  `ADDDATE` STRING,
  `ADDWHO` STRING,
  `EDITDATE` STRING,
  `EDITWHO` STRING,
  `EXT_UDF_STR1` STRING,
  `EXT_UDF_STR2` STRING,
  `EXT_UDF_STR3` STRING,
  `EXT_UDF_STR4` STRING,
  `EXT_UDF_STR5` STRING,
  `EXT_UDF_STR6` STRING,
  `EXT_UDF_STR7` STRING,
  `EXT_UDF_STR8` STRING,
  `EXT_UDF_STR9` STRING,
  `EXT_UDF_STR10` STRING,
  `EXT_UDF_STR11` STRING,
  `EXT_UDF_STR12` STRING,
  `EXT_UDF_STR13` STRING,
  `EXT_UDF_STR14` STRING,
  `EXT_UDF_STR15` STRING,
  `EXT_UDF_STR16` STRING,
  `EXT_UDF_STR17` STRING,
  `EXT_UDF_DATE1` STRING,
  `EXT_UDF_DATE2` STRING,
  `EXT_UDF_DATE3` STRING,
  `EXT_UDF_DATE4` STRING,
  `EXT_UDF_DATE5` STRING,
  `EXT_UDF_FLOAT1` STRING,
  `EXT_UDF_FLOAT2` STRING,
  `EXT_UDF_FLOAT3` STRING,
  `EXT_UDF_FLOAT4` STRING,
  `EXT_UDF_FLOAT5` STRING,
  `EXT_UDF_LKUP1` STRING,
  `EXT_UDF_LKUP2` STRING,
  `EXT_UDF_LKUP3` STRING,
  `EXT_UDF_LKUP4` STRING,
  `EXT_UDF_LKUP5` STRING,
  `EXT_UDF_LKUP6` STRING,
  `EXT_UDF_LKUP7` STRING,
  `EXT_UDF_LKUP8` STRING,
  `EXT_UDF_LKUP9` STRING,
  `EXT_UDF_LKUP10` STRING,
  `PICKEDWGT` STRING,
  `MERGESORT` STRING,
  `MERGECOUNTER` STRING,
  `FINALMERGECARTONTYPE` STRING,
  `MERGEKEY` STRING,
  `SELECTEDCARTONID` STRING,
  `PICKEDTOID` STRING,
  `GROSSWGT` STRING,
  `NETWGT` STRING,
  `TAREWGT` STRING
)
OPTIONS (
  format = 'CSV',
  uris = ['gs://pick-raw-productivity-pick/pick_raw/*.csv'],
  skip_leading_rows = 2,
  field_delimiter = ',',
  allow_quoted_newlines = TRUE,
  allow_jagged_rows = TRUE,
  max_bad_records = 100
);


-- =============================================================================
-- 2) MERGE — เอาข้อมูลจาก external -> ตารางจริง pick_detail
--    * แปลงชนิดข้อมูล (QTY "100.00000" -> 100)
--    * ดักซ้ำภายในไฟล์: เก็บ 1 แถวต่อ 1 PICKDETAILKEY
--    * WHEN NOT MATCHED = ใส่เฉพาะ key ใหม่ -> ไม่เบิ้ล
--    >> เอา statement นี้ไปตั้งเป็น Scheduled Query รายชั่วโมง (ดูคู่มือข้อ 4) <<
-- =============================================================================
MERGE `productivity-pick.pick_analytics.pick_detail` T
USING (
  SELECT * EXCEPT(rn) FROM (
    SELECT
      `PICKDETAILKEY`                          AS pickdetailkey,
      `ID`                                     AS lpn,
      SAFE_CAST(SAFE_CAST(`QTY` AS NUMERIC) AS INT64) AS qty,
      `SKU`                                    AS sku,
      `STORERKEY`                              AS owner,
      SAFE_CAST(`UOMQTY` AS NUMERIC)           AS uom_qty,
      UPPER(`EXT_UDF_STR7`)                    AS category,
      COALESCE(NULLIF(`EXT_UDF_STR8`, ''), NULLIF(`EXT_UDF_STR10`, '')) AS picker_id,
      `EXT_UDF_STR16`                          AS location,
      `EXT_UDF_DATE1`                          AS pick_ts_source,
      ROW_NUMBER() OVER (PARTITION BY `PICKDETAILKEY` ORDER BY `EXT_UDF_DATE1` DESC) AS rn
    FROM `productivity-pick.pick_analytics.pick_ext`
    WHERE `PICKDETAILKEY` IS NOT NULL AND `PICKDETAILKEY` != ''
  )
  WHERE rn = 1
) S
ON T.pickdetailkey = S.pickdetailkey
WHEN NOT MATCHED THEN
  INSERT (pickdetailkey, lpn, qty, sku, owner, uom_qty, category,
          picker_id, location, pick_ts_source, loaded_at)
  VALUES (S.pickdetailkey, S.lpn, S.qty, S.sku, S.owner, S.uom_qty, S.category,
          S.picker_id, S.location, S.pick_ts_source, CURRENT_TIMESTAMP())
WHEN MATCHED AND (T.pick_ts_source IS NULL AND S.pick_ts_source IS NOT NULL) THEN
  UPDATE SET 
    T.pick_ts_source = S.pick_ts_source,
    T.picker_id = S.picker_id,
    T.loaded_at = CURRENT_TIMESTAMP();


-- =============================================================================
-- 3) ตรวจว่าไม่มีข้อมูลเบิ้ล (total ต้องเท่ากับ distinct keys เสมอ)
-- =============================================================================
-- SELECT COUNT(*) AS total_rows,
--        COUNT(DISTINCT pickdetailkey) AS distinct_keys,
--        MIN(SAFE.PARSE_DATETIME('%d/%m/%Y %H:%M', pick_ts_source)) AS min_ts,
--        MAX(SAFE.PARSE_DATETIME('%d/%m/%Y %H:%M', pick_ts_source)) AS max_ts
-- FROM `productivity-pick.pick_analytics.pick_detail`;
