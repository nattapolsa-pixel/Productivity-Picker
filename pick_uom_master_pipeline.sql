-- =============================================================================
-- Pick UOM cutover: Master_Item + Master_Pack
-- =============================================================================
-- This file supersedes the retired dim_pack_size / browser Pack Size logic.
--
-- Prerequisite:
--   1. Deploy bigquery_to_json.gs.
--   2. Run syncPickMastersNow() in Apps Script successfully.
--   3. Run the preflight section below and confirm every required check passes.
--
-- IMPORTANT: Do not run the CUTOVER section until the preflight says that the
-- current master is ready.  It intentionally replaces v_pick_clean, but does
-- not alter pick_detail or any source data.
--
-- Calculation rules (already materialized in dim_pick_master_current):
--   Master_Item join key     = Owner + Item (C)
--   Master_Pack lookup       = C first; E only when C has no pack match
--                                (a C-primary Owner+Item mapping wins if an
--                                 E fallback would resolve to the same key)
--   PICK                    = Master_Pack D
--   CASE                    = Master_Pack H
--   Blank Pick Type         = D, otherwise 1
--   UOM                     = QTY / divisor (NUMERIC, no MOD, no rounding)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) PREFLIGHT — read only
-- -----------------------------------------------------------------------------
-- Expected for the currently studied master: 9,351 usable mappings, no
-- duplicate Owner+Item keys, and no missing Master_Pack. Two E-fallback
-- candidates are intentionally skipped because their Owner+Item key already
-- exists as a C-primary mapping; this is reported by the Apps Script sync
-- result and does not silently choose the fallback's Pick Type.
SELECT
  COUNT(*) AS master_rows,
  COUNT(*) - COUNT(DISTINCT CONCAT(owner, '\u0001', item)) AS duplicate_owner_item_keys,
  COUNTIF(pack_source = 'PACK_E_FALLBACK') AS fallback_to_column_e_rows,
  COUNTIF(match_status != 'MATCHED') AS non_matched_master_rows,
  COUNTIF(uom_divisor IS NULL OR uom_divisor <= 0) AS invalid_divisor_rows,
  COUNTIF(rule_code NOT IN ('PICK_D', 'CASE_H', 'BLANK_D', 'BLANK_FALLBACK_1')) AS unexpected_rule_rows,
  COUNTIF(rule_code = 'CASE_H' AND (case_pack_size IS NULL OR case_pack_size <= 0)) AS invalid_case_rows,
  COUNTIF(rule_code IN ('PICK_D', 'BLANK_D') AND (pick_pack_size IS NULL OR pick_pack_size <= 0)) AS invalid_pick_rows,
  COUNT(*) > 0
    AND COUNT(*) = COUNT(DISTINCT CONCAT(owner, '\u0001', item))
    AND COUNTIF(match_status != 'MATCHED') = 0
    AND COUNTIF(uom_divisor IS NULL OR uom_divisor <= 0) = 0
    AND COUNTIF(rule_code NOT IN ('PICK_D', 'CASE_H', 'BLANK_D', 'BLANK_FALLBACK_1')) = 0
    AS ready_for_cutover
FROM `productivity-pick.pick_analytics.dim_pick_master_current`;

-- No row fan-out is allowed when Pick Detail joins the UOM master.
WITH base AS (
  SELECT COUNT(*) AS rows_count
  FROM `productivity-pick.pick_analytics.pick_detail`
),
joined AS (
  SELECT COUNT(*) AS rows_count
  FROM `productivity-pick.pick_analytics.pick_detail` AS d
  LEFT JOIN `productivity-pick.pick_analytics.dim_pick_master_current` AS m
    ON UPPER(TRIM(d.owner)) = m.owner
   AND UPPER(TRIM(d.sku)) = m.item
)
SELECT
  base.rows_count AS pick_detail_rows,
  joined.rows_count AS joined_rows,
  base.rows_count = joined.rows_count AS no_join_fanout
FROM base CROSS JOIN joined;

-- Inspect any C -> E fallback records before cutover. A fallback that collides
-- with C-primary is deliberately not inserted into current; check the
-- Apps Script sync result's fallback_skipped_collision_rows for that audit.
SELECT
  owner, source_item, item AS canonical_item, item_pack, pack_key,
  pick_type, pick_pack_size, case_pack_size, uom_divisor, rule_code,
  master_item_row, master_pack_row
FROM `productivity-pick.pick_analytics.dim_pick_master_current`
WHERE pack_source = 'PACK_E_FALLBACK'
ORDER BY owner, source_item;

-- Sample the calculation by source category and UOM rule.  Values under
-- UNMAPPED/INVALID are deliberately not counted as pick_qty in the candidate
-- view below, so an incomplete master cannot quietly turn into pieces.
WITH joined AS (
  SELECT
    d.qty,
    m.rule_code,
    CASE
      WHEN m.owner IS NULL THEN 'UNMAPPED_OWNER_ITEM'
      WHEN m.match_status != 'MATCHED' THEN m.match_status
      WHEN m.uom_divisor IS NULL OR m.uom_divisor <= 0 THEN 'INVALID_DIVISOR'
      WHEN m.rule_code NOT IN ('PICK_D', 'CASE_H', 'BLANK_D', 'BLANK_FALLBACK_1') THEN 'UNSUPPORTED_RULE'
      ELSE 'CALCULATED'
    END AS pick_uom_status,
    CASE
      WHEN m.owner IS NOT NULL
       AND m.match_status = 'MATCHED'
       AND m.uom_divisor > 0
       AND m.rule_code IN ('PICK_D', 'CASE_H', 'BLANK_D', 'BLANK_FALLBACK_1')
      THEN SAFE_DIVIDE(CAST(d.qty AS NUMERIC), m.uom_divisor)
      ELSE NULL
    END AS pick_qty
  FROM `productivity-pick.pick_analytics.pick_detail` AS d
  LEFT JOIN `productivity-pick.pick_analytics.dim_pick_master_current` AS m
    ON UPPER(TRIM(d.owner)) = m.owner
   AND UPPER(TRIM(d.sku)) = m.item
)
SELECT
  pick_uom_status,
  rule_code,
  COUNT(*) AS pick_detail_rows,
  SUM(qty) AS pcs,
  SUM(pick_qty) AS uom_units
FROM joined
GROUP BY pick_uom_status, rule_code
ORDER BY pick_uom_status, rule_code;

-- -----------------------------------------------------------------------------
-- 2) CUTOVER — run only after the preflight returns ready_for_cutover = true
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW `productivity-pick.pick_analytics.v_pick_clean` AS
WITH parsed AS (
  SELECT
    d.*,
    COALESCE(
      SAFE.PARSE_DATETIME('%d/%m/%Y %H:%M', d.pick_ts_source),
      SAFE.PARSE_DATETIME('%d/%m/%Y %H:%M:%S', d.pick_ts_source),
      SAFE.PARSE_DATETIME('%m/%d/%y %I:%M %p', d.pick_ts_source),
      SAFE.PARSE_DATETIME('%m/%d/%Y %I:%M %p', d.pick_ts_source),
      SAFE.PARSE_DATETIME('%m/%d/%y %H:%M', d.pick_ts_source),
      SAFE.PARSE_DATETIME('%Y-%m-%d %H:%M:%S', d.pick_ts_source)
    ) AS pick_ts
  FROM `productivity-pick.pick_analytics.pick_detail` AS d
)
SELECT
  d.pickdetailkey,
  d.lpn,
  d.qty,
  d.sku,
  d.owner,
  d.uom_qty,
  -- The final UOM consumed by the dashboard.  It is NUMERIC and intentionally
  -- preserves decimal values; no exact-divisibility test or rounding is used.
  CASE
    WHEN m.owner IS NOT NULL
     AND m.match_status = 'MATCHED'
     AND m.uom_divisor > 0
     AND m.rule_code IN ('PICK_D', 'CASE_H', 'BLANK_D', 'BLANK_FALLBACK_1')
    THEN SAFE_DIVIDE(CAST(d.qty AS NUMERIC), m.uom_divisor)
    ELSE NULL
  END AS pick_qty,
  CASE
    WHEN m.owner IS NULL THEN 'UNMAPPED_OWNER_ITEM'
    WHEN m.match_status != 'MATCHED' THEN m.match_status
    WHEN m.uom_divisor IS NULL OR m.uom_divisor <= 0 THEN 'INVALID_DIVISOR'
    WHEN m.rule_code NOT IN ('PICK_D', 'CASE_H', 'BLANK_D', 'BLANK_FALLBACK_1') THEN 'UNSUPPORTED_RULE'
    ELSE 'CALCULATED'
  END AS pick_uom_status,
  m.pick_type AS master_pick_type,
  m.uom_divisor AS pick_uom_divisor,
  m.rule_code AS pick_uom_rule,
  m.pack_source AS pick_uom_pack_source,
  UPPER(d.category) AS category,
  d.picker_id,
  d.location,
  SUBSTR(d.location, 1, 2) AS zone,
  d.pick_ts_source,
  d.pick_ts,
  -- Normalized timestamp: PTT = raw - 7 hours; BPS = raw unchanged.
  CASE
    WHEN UPPER(d.category) = 'PTT' THEN DATETIME_SUB(d.pick_ts, INTERVAL 7 HOUR)
    ELSE d.pick_ts
  END AS pick_ts_local
FROM parsed AS d
LEFT JOIN `productivity-pick.pick_analytics.dim_pick_master_current` AS m
  ON UPPER(TRIM(d.owner)) = m.owner
 AND UPPER(TRIM(d.sku)) = m.item;

-- All downstream dates/shifts derive from the same normalized timestamp.
-- Reporting date is the normalized calendar date. Team A/B comes from the employee roster.
CREATE OR REPLACE VIEW `productivity-pick.pick_analytics.v_pick_enriched` AS
SELECT
  c.*,
  DATE(c.pick_ts_local) AS pick_date,
  DATE(c.pick_ts_local) AS shift_date,
  IF(
    EXTRACT(HOUR FROM c.pick_ts_local) >= 7
      AND EXTRACT(HOUR FROM c.pick_ts_local) < 19,
    'M',
    'N'
  ) AS shift_code,
  EXTRACT(HOUR FROM c.pick_ts_local) AS pick_hour,
  FORMAT('%02d:00-%02d:59',
    EXTRACT(HOUR FROM c.pick_ts_local),
    EXTRACT(HOUR FROM c.pick_ts_local)
  ) AS time_slot,
  DATE_TRUNC(DATE(c.pick_ts_local), WEEK(MONDAY)) AS week_start,
  DATE_TRUNC(DATE(c.pick_ts_local), MONTH) AS month_start
FROM `productivity-pick.pick_analytics.v_pick_clean` AS c
WHERE c.pick_ts_local IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 3) POST-CUTOVER — read only
-- -----------------------------------------------------------------------------
SELECT
  pick_uom_status,
  pick_uom_rule,
  COUNT(*) AS pick_detail_rows,
  SUM(qty) AS pcs,
  SUM(pick_qty) AS uom_units
FROM `productivity-pick.pick_analytics.v_pick_clean`
GROUP BY pick_uom_status, pick_uom_rule
ORDER BY pick_uom_status, pick_uom_rule;

-- The downstream views already aggregate pick_qty.  Their source table is
-- unchanged, therefore refresh/reopen the dashboard only after this query
-- completes successfully.
