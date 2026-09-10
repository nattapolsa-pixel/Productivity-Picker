# Pick Productivity V2 — คู่มือสถาปัตยกรรม & กฎการแก้ไข

> เอกสารนี้คือ "สัญญาร่วม" ระหว่างคนกับ Claude อ่านก่อนแก้โค้ดทุกครั้ง
> อัปเดตเมื่อไหร่ที่ constant / contract / business rule เปลี่ยน

---

## 1. ภาพรวมระบบ (topology)

Static site บน GitHub Pages → ไม่มี backend ของตัวเอง → คุยกับ **Apps Script Web App 2 ตัว**

```
                    ┌─ DATA_URL      → bigquery_to_json.gs → BigQuery productivity-pick.pick_analytics
index.html + app.js ─┤
                    └─ SHEET_API_URL → apps-script-api.gs  → Google Sheet "Results Master" / "2ND"
                    └─ (bypass) gviz CSV → Sheet "Resigned", Sheet "2ND"
```

**ทั้งสอง .gs ไม่มีตัวไหน supersede กัน ใช้งานจริงพร้อมกัน** ห้าม merge เข้าโปรเจกต์เดียว —
มี name collision: `doGet`, `normalizePickType_` (bq คืน `PICK/CASE`, api คืน `fullRack/halfRack/...`)

### สายข้อมูล BigQuery
```
pick_detail (ปลายทาง upload, MERGE key = pickdetailkey)
  └─ v_pick_clean       (view, pick_uom_master_pipeline.sql:120)
       └─ v_pick_enriched (view, ln 180)
            └─ t_pick_dashboard  (ตาราง materialized)   ← Dashboard อ่านตัวนี้เท่านั้น
```
Dashboard **ไม่เคยอ่าน view โดยตรง** view มีหน้าที่ป้อน materialization step เท่านั้น

### ไฟล์ในโปรเจกต์
| ไฟล์ | หน้าที่ |
|---|---|
| `index.html` (2,998) | shell + CSS ทั้งหมด + nav + DOM container + modal 4 ตัว |
| `app.js` (12,611) | logic ทั้งหมดฝั่ง browser — global script ไม่มี module |
| `bigquery_to_json.gs` (3,536) | Web App #1: BigQuery cube + item/slot/roster + upload pipeline |
| `apps-script-api.gs` (2,516) | Web App #2: Google Sheet "Results Master" → KPI (read-only) |
| `pick_uom_master_pipeline.sql` (216) | runbook มือ: preflight → cutover view → post-check |
| `zone_layout.js` / `zone_master_fallback.js` / `picker_names_fallback.js` / `picker_affiliation_fallback.js` | snapshot 2026-07-27 เป็น **พื้น** ไม่ใช่ตัว override |
| `tests/*.test.js` (14) | plain Node ไม่มี framework — `node tests/xxx.test.js` |
| `local_server.ps1` | static server `http://127.0.0.1:8088/` สำหรับทดสอบ local |

---

## 2. Constant ที่ต้องระวัง (ต้องตรงกันข้ามไฟล์)

| Constant | ค่า | อยู่ที่ | กฎ |
|---|---|---|---|
| `DASHBOARD_SCHEMA_VERSION` | `pick-units-v24-sheet-master-all-items` | app.js:438 + bq:22 | **ต้องเปลี่ยนคู่กันเสมอ** + แก้ `performance_contract.test.js` |
| `DASHBOARD_CACHE_FORMAT_VERSION` | `speed-v18-sheet-master-all-items` | bq:43 | เปลี่ยน = ล้าง cache ทั้งระบบ |
| `UPLOAD_SCHEMA_VERSION` | `pick-detail-wms-v1` | app.js:10735 + bq:21 | ไม่ตรง = upload ถูกปฏิเสธ `SCHEMA_VERSION_MISMATCH` |
| `CACHE_VERSION` | `v49-sheet-2nd-roster` | api:7 | เปลี่ยน payload = ต้อง bump + แก้ `isUsableDashboardPayload_` (api:2130) |
| `app.js?v=` | `20260910-monthwide-charts-v98` | index.html (ท้ายไฟล์) | **bump ทุกครั้งที่แก้ app.js** + แก้ `performance_contract.test.js:11` |
| `SHARED_TARGETS_PROPERTY` | `dashboard_shared_targets_v1` | bq | ScriptProperty เก็บ Target ส่วนกลาง (types + zones) |
| `BQ_PROJECT / DATASET / LOCATION` | `productivity-pick` / `pick_analytics` / `asia-southeast1` | bq:17-19 | location ผิด = ทุก job พัง "Not found: Job" |
| `RECENT_DAYS` | 90 | bq:20 | ขอบเขตวันที่ทั้ง dashboard |

### Target เริ่มต้น (app.js:759, api:29)
```
overall 170 | fullRack 170 | halfRack 200 | microRack/ea 170 | pickToSort 170 | mezzanine 170 | training 100
```
`170` ยัง hardcode อยู่ที่ index.html:2161 (`#targetBadgeVal`) และใน test 2 ไฟล์

### KPI / shift constant (app.js:451-457)
```
ACTIVE_HOURS_MIN_EXCLUSIVE = 3     // ต้อง > 3 ชม. จึงนับ productivity
PRODUCTIVITY_MAX_EXCLUSIVE  = 1000 // ต้อง < 1000
SHIFT_A_REGULAR_HOURS = 7.5        SHIFT_B_REGULAR_HOURS = 470/60 (7:50)  // ใช้ใน Workforce Planning เท่านั้น
OT_MAX = 2.5
ALLOWED_ITEM_OWNERS = {DM02, DP02, DG02, DCWN, '-'}   // เพิ่ม owner = แก้บรรทัดนี้
```

### เพดาน upload
| | ค่า | ที่ |
|---|---|---|
| แถวสูงสุด | **100,000** | app.js:10736 + bq:23 (เอกสาร SETUP เขียน 50,000 = ผิด) |
| ไฟล์สูงสุด | 50 MB | app.js |
| POST สูงสุด | 12 MB | bq:24 |
| chunk | 1 MB / 3,000 แถว / **concurrency 1** | app.js:10740-10744 — ห้ามทำขนาน |
| chunk สูงสุด | 100 | bq:25 |

---

## 3. Business logic — กฎที่ต้องยึด

### 3.1 กะทำงาน (ตัดที่ 07:00)
```
420 ≤ tmin < 1140  → กะ A (morning)  shift_date = pick_date       (07:00–18:59)
tmin ≥ 1140        → กะ B (night)    shift_date = pick_date       (19:00–23:59)
tmin < 420         → กะ B (night)    shift_date = pick_date - 1 วัน (00:00–06:59)
shift_minute: A = tmin-420, B(กลางคืน) = tmin-1140, B(เช้ามืด) = tmin+300
```
- คำนวณใน **SQL ที่ JS สร้าง** (`dashboardShiftDateSql_` bq:457, `dashboardShiftCodeSql_` bq:465)
- `v_pick_enriched.shift_date/.shift_code` คำนวณต่างกัน (ไม่เลื่อนวัน) และ **dashboard ไม่ใช้** — แก้ view แล้วหน้าเว็บไม่เปลี่ยน
- Normalize เวลาต้นทาง: `pick_ts_local = pick_ts - 7 ชม.` เมื่อ `category='PTT'`, BPS ใช้ตามเดิม (`pick_uom_master_pipeline.sql:168`) — **บรรทัดสำคัญที่สุดของไฟล์นั้น**
- test ล็อกค่าไว้ครบ 6 เคสใน `tests/shift_logic.test.js`

### 3.2 แยก "กะจริง" vs "Team รายงาน"
| | มาจาก | ใช้ทำอะไร |
|---|---|---|
| `shiftCode` ใน work cube | เวลา pick จริง | ผลงานจริง — **ห้าม override** |
| Team A/B/NOT_FOUND | Sheet roster (`picker_roster_teams`) | ตัวกรอง shift, การจัดกลุ่มรายงาน, OT |

ตัวกรองกะบนหน้าเว็บ (`shiftF`) กรองด้วย **Team จาก roster** ไม่ใช่เวลา (`matchesReportTeam` app.js:1452)
ใครที่ Team ไม่ใช่ A/B → `NOT_FOUND` → มี banner แจ้งเตือน (`renderUnmappedTeamBanner` app.js:3863)

⚠️ **ตัวกรองกะต้องมีผลกับ Picker ที่มาจาก Sheet ด้วย** (แก้ 2026-09-10)
บล็อกผสมข้อมูล Sheet เคยวน `s.pickers.all` ทั้งหมดแล้ว `push` เข้า `by_picker` โดยไม่เช็ค `sf`
→ เลือก "กะ A" แล้วยังเห็นคนกะ B โผล่มา ตอนนี้กรองด้วย `matchesReportTeam(null, userId, sf)` ตัวเดียวกับฝั่ง BigQuery
`kpis.pickers` / `kpis.sheet_pickers` ก็นับหลังกรองแล้ว · `tests/shift_filter_sheet.test.js` ล็อกไว้
**ถ้าเพิ่มบล็อกที่เอาข้อมูลจาก Sheet มาผสมอีก ต้องกรอง `sf` เองทุกครั้ง**

### 3.2.1 ช่วงของ "ตาราง" vs ช่วงของ "กราฟ" — แยกกัน ⚠️ อัปเดต 2026-09-10
ผู้ใช้ต้องการ: เลือกวันที่ 8 วันเดียว → **ตาราง/KPI โชว์แค่วันที่ 8** แต่ **กราฟกางทั้งเดือน** เพื่อเห็นบริบท

```
ตาราง / KPI / การ์ด  → A = aggregate(sys, dfrom, dto, shiftF)     ← ตามตัวกรองเป๊ะ
กราฟเทรนรายวัน       → dailySeriesForRange(sys, chartMonthRange().from, .to, shiftF)
หน้าเทรน (สัปดาห์/เดือน) → dailySeriesForRange(sys, DMIN, DMAX, shiftF)   ← กางทุกงวดที่มี
```

**`dailySeriesForRange(system, from, to, sf)`** — อ่าน **work cube เท่านั้น** (มีครบ 90 วันในเครื่อง = ไม่ยิง BigQuery เพิ่ม)
มี memo แยก `chartDailyCache` และถูกล้างใน `invalidateAggregationCache()`

🚫 **ห้ามเรียก `aggregate()` ด้วยช่วงของกราฟ** — เพราะ item cube / slot cube ถูก fetch ตาม `from|to|shift` เป๊ะๆ
ถ้าเรียกด้วยช่วงที่ไม่ได้โหลด cube ไว้ `by_item`/`by_timeslot` จะว่าง แล้วผลนั้นจะถูกเก็บลง `aggregateCache`
→ พอผู้ใช้เลือกช่วงนั้นจริง หน้า Items / ช่วงเวลา จะว่างเปล่าแบบหาสาเหตุไม่เจอ

⚠️ **`dailySeriesForRange` ต้องผสม Sheet `monthlyTrend` ด้วย** (เหมือน `aggregate` §3.11)
ไม่งั้นกราฟโชว์ยอด BigQuery ขณะที่ตารางโชว์ยอด Sheet = ไม่ตรงกัน
`tests/chart_daily_series.test.js` เทียบ parity กับ `aggregate().daily` ไว้ **ทั้งกรณีมีและไม่มี Sheet**
→ ถ้าแก้สูตร productivity ใน `aggregate` ต้องแก้ที่นี่ด้วย test จะจับให้

**เดือนของกราฟ** — `chartMonth` (`null` = auto ตามเดือนของ `dto`)
`activeChartMonth()` / `chartMonthRange()` / `shiftChartMonth(±1)` / `resetChartMonth()` / `availableChartMonths()`
UI: `chartMonthNavHtml(navId)` + `bindChartMonthNav(navId, onChange)` → ปุ่ม `‹ เดือน ›` + ปุ่ม "↩ กลับเดือนของวันที่เลือก" เมื่อเลื่อนเอง
วางที่ `#overviewChartMonthWrap` (index.html) แสดงเฉพาะ `trendMode === 'day'`

**ไฮไลต์**: กราฟรายวัน แท่งที่อยู่ในช่วง `dfrom..dto` = สีเข้ม วันอื่นในเดือน = สีอ่อน ·
หน้าเทรน งวดที่ครอบวันที่เลือก (`g.inFilter`) = สีเข้ม + ป้าย "ช่วงที่เลือก" ในตาราง

### 3.3 ชั่วโมงทำงาน & OT
- **Active Hours = popcount(hourMask)** = จำนวนชั่วโมงนาฬิกาที่มี Pick > 0 ต่อ picker × วัน
  (`active_hour_mask` = `SUM(DISTINCT POW(2,hour))` 24 bit จาก SQL)
- ไม่หักพักเบรก, OT รวมอยู่ในนี้แล้ว
- OT แยกออกจาก **bit ชั่วโมงเฉพาะ** (`activeOtHoursFromMask` app.js:1118):
  - Team A: ชม.16 → +0.5, ชม.17 → +1, ชม.18 → +1
  - Team B: ชม.4 → +0.5, ชม.5 → +1, ชม.6 → +1
  - เพดาน 2.5 / Team NOT_FOUND ได้ OT = 0
- **ฟังก์ชันตายแล้ว ห้ามไปแก้ให้ "ทำงาน"**: `shiftOf` (ใช้แต่ใน test), `otHours` (1080), `shiftRegularHours` (1085), `productivityHours`/`shiftWorkHoursBetween` (1135-1136 เป็น stub `return 0` โดยเจตนา)

### 3.4 Productivity
**Raw V2 (ตัวหลัก)** — `v2RoundedProductivity` app.js:1103
```
prod = round(totalPick / activeHours)
```
**เงื่อนไขนับ** (`isV2CountableProductivity` app.js:1112) — ต้องครบทั้ง 4:
```
activeHours > 3   AND   prod > 0   AND   prod < 1000   AND   ไม่ใช่ support worker
```
support worker = responsibility มี `ช่วยงานส่วนอื่น` / `support other` / `= support`

**ค่ารวม = ค่าเฉลี่ยเลขคณิตของ prod รายคน×วัน** ไม่ใช่ total/total (app.js:3054)

**กลุ่มลูก (zone / owner / type) ไม่มี productivity ของตัวเอง** — สืบทอดจาก parent picker×วันตรงๆ,
`ot`/`wh` แบ่งตามสัดส่วน qty (`allocateParentHours` app.js:2897) ถ้า parent ไม่ countable → ลูกเป็น 0 ทั้งหมด

**Weighted KPI (สูตร KPI Sheet 22 ส.ค.)** — `PRODUCTIVITY_WEIGHT_CONFIG` app.js:492
```
Overall = 0.37·FullRack + 0.48·HalfRack + 0.15·EA

FULL_RACK : AH-AI 20% | AL-BL-AM-BM 30% | BE 50%
HALF_RACK : AJ-AK 30% | AN-CA 10% | BN-DA 10% | BG-BH 5% | BI-BK 5%
            CB-DB-DC-CC 15% | DD-DE 10% | CF-DF 15%
EA        : EA 60% | FA 35% | YA 5%
```
กฎ: โซนที่ไม่มีข้อมูลนับเป็น **0**, **ไม่ normalize weight ใหม่**, Mezzanine HB ไม่มี weight = ตัดออกทั้งหมด
สูตรนี้พิมพ์ซ้ำอยู่ใน index.html:2186 — **แก้ต้องแก้ทั้งสองที่**
คำนวณ **ในเบราว์เซอร์เท่านั้น** (`calculateWeightedProductivity` app.js:2444)

⚠️ `calculateCrossSystemWeightedProductivity` (app.js:2541) เป็น implementation ขนานที่ hardcode `PTT` และ **ไม่ถูกเรียกจาก `aggregate`** — แก้สูตร weight ต้องแก้ทั้งสองที่ ไม่งั้น drift

### 3.5 Target resolution ⚠️ อัปเดต 2026-09-10
`getTargetForZoneOrType(typePick, zone)` — ลำดับความสำคัญ **3 ชั้น**:
```
1) Target ของ Zone ย่อย   → zoneTargetOverride(zn)  ← ชนะทุกอย่าง ถ้าโซนนั้นถูกตั้งค่าไว้
2) Target ตามประเภท       → full rack → fullRack | half rack → halfRack | micro rack → microRack
                            pick to sort / "bps" → pickToSort | mezzanine/mezz → mezzanine
                            training/train → training
3) overall
```
⚠️ substring `'bps'` ทำให้ zone/type ใดที่มีคำว่า "bps" กลายเป็น pickToSort

**Target ราย Zone ย่อย (17 Zone)**
- `zoneTargets` = `{ NORMALIZED_ZONE_LABEL: number }` เช่น `{'AH-AI':150}`
- `normalizeTargetZoneKey` = uppercase + en/em-dash → `-` + ตัดช่องว่างทั้งหมด
- `resolveTargetZoneLabel(raw)` แปลง location code → ชื่อ Zone รวม (`CA` → `AN-CA`, `AM` → `AL-BL-BM-AM`) ผ่าน `targetZoneLabelMap()` ที่ cache ตาม identity ของ `ZONE_MASTER` (`prepareZoneMaster` สร้าง object ใหม่ทุกครั้ง = cache invalidate เอง)
- `listTargetZones()` คืน 17 โซน เรียงตาม `TARGET_TYPE_ORDER` (Full → Half → Micro → Pick to Sort → Mezzanine) ใช้ทั้ง Modal และหน้า "ไม่ถึงเป้า"
- `getTypeTargetForZone(zone, type)` = Target ตามประเภทเพียวๆ ใช้เป็น placeholder ในช่องกรอก (ปล่อยว่าง = ใช้ค่านี้)
- **เก็บเป็นค่ากลาง**: `mode=dashboard_targets` (GET) / `action=set_dashboard_targets` (POST) — `fetchSharedTargets()` / `saveSharedTargets()` แพตเทิร์นเดียวกับ shared exclusions, poll ทุก ~1 นาที (4 รอบของ 15 วิ)
- `applySharedTargets` และ `saveTargetSettingsFromModal` เรียก **`aggregateCache.clear()`** เพราะ Target ต่อโซนถูกคำนวณภายใน `aggregate` (แก้ known drift #9 บางส่วน)
- Modal: `#targetZoneListHost` ถูกเติมด้วย `renderTargetZoneInputs()` — **ฟังก์ชันนี้อยู่เหนือ marker `// init`** เพราะ test เรียกใช้

`getTypePickForZone` (app.js:1663) ค้น 5 ชั้น: `zObj.typePick` → `ZONE_MASTER[zn]` → สแกนหา entry ที่ `.zone === zn` (รองรับชื่อรวม `AA-AF`, `CF-DF`) → แยกชื่อรวมด้วย `[-_]` ลองทีละส่วน → prefix

**Blended target** (app.js:3486): `Σ(zoneTarget × สัดส่วน qty)` ของโซนที่ picker ทำจริง, fallback `sheetTarget || 170`

**หน้า Efficiency / Cycle Time / Incentive ใช้ `prodTarget` (overall) แบนๆ ไม่ใช้ target ต่อโซน** — ต่างจากตาราง Zone

### 3.6 Efficiency (app.js:7970)
```
efficiencyPct = currentProd / target × 100      isHit = currentProd >= target
Day Hit Rate    = นับวันที่ daily.avg_prod >= target
Picker Hit Rate = นับเฉพาะ picker ที่ prod > 0
```

### 3.7 Cycle Time (app.js:8314)
```
secPerUnit = (Σ hours × 3600) / qty       targetCycleTime = 3600/prodTarget (default 21.2)
badge: ≤ target×0.85 → ⚡ เร็วมาก | ≤ target → ✅ ตามเกณฑ์ | > target → 🐢 ช้ากว่าเป้า
ตาราง picker เร็วสุด: prod>0 && (hours>=3 || qty>50), top 10
```
⚠️ bug app.js:8554 — `pcsProd = z.avg_pcs_prod || z.pcs` fallback ไปเอา "ยอด pcs" มาใช้เป็น "อัตรา"

### 3.8 Incentive (app.js:8642)
```
ach = prod / target × 100
hours < 3            → 0 (ชม.ไม่ถึงเกณฑ์)
prod >= target:  ach>=150 PLATINUM 250 | >=130 GOLD 160 | >=115 SILVER 100 | 100-114 BRONZE 50
prod <  target       → NO_BONUS
โหมด over_unit: reward = round(max(0, vol - hours×target) × 0.80)
```
config อยู่ใน `window._incentiveConfig` — **ไม่ persist** รีโหลดแล้วรีเซ็ต
⚠️ `isEligible` ใช้ `hours>=min && prod>=target` แต่การ์ดสรุปนับ `reward > 0` — สองนิยามไม่ตรงกัน

### 3.9 Picker identity
ลำดับค้นหาเหมือนกันทุกตัว: **payload (`DATA.meta.*`) ก่อน → fallback file** และแต่ละ map ลอง key ตรง แล้วลอง key ที่ตัด 0 นำหน้า
- ชื่อ: `getPickerName` (1378) ไม่เจอ → คืนรหัสเดิม
- สังกัด: `getPickerAffiliation` (1396) ไม่เจอ → `'ไม่พบสังกัด'` (มี 3 ค่า: `PTG` / `40HRS` / `Man Power`)
- **ลาออก (Resigned)**: match ด้วย id → id ตัด 0 → ชื่อที่ normalize แล้ว (`normalizePersonName` ตัด นาย/นางสาว/นาง/น.ส./ด.ช./ด.ญ./Mr./Ms./Mrs. + ช่องว่างทั้งหมด)
  **กฎเหล็ก: คนลาออกยังคงตัวเลขทุกตัวไว้ครบ เติมแค่ป้าย `⛔ ลาออก (วันที่)`** (test ล็อกไว้)

### 3.10 Zone master / ผังคลัง
- `ZONE_MASTER` merge: `ZONE_MASTER_FALLBACK` ก่อน → `DATA.meta.zone_master` ทับ (**payload สดชนะ**, fallback อุดรู)
- `normalizeLocationCode` = **2 ตัวอักษรแรก** ตัวใหญ่ หรือ `'??'`
- ไม่รู้จัก → `typePick: 'ไม่พบใน Zone_V2'`, `owner: '-'`, `known: false`
- **CA/DF ที่ยังไม่ merge** (app.js:1848, ตาราง 6532): ถ้า `CA` มี lines = 0 → ยืมแถวของ **AN**; ถ้า `DF` lines = 0 → ยืมของ **CF**
  ถ้ามีการยิงจริง (lines > 0) → **ห้าม** link (test ล็อก)
- `PF` ที่ไม่รู้จัก → บังคับเป็น `{zone:'PF', typePick:'On Floor', owner:'Max Mart'}`
- `ZONE_LAYOUT` (geometry) **ไม่ถูก override จาก payload เลย** — 7 onFloor + 14 top + 14 bottom + 2 micro = 37 unique, มี `PF`, ไม่มี `BE`/`HB` (อยู่ในกล่อง "นอกผัง")
- **การ exclude โซน ตัดออกจากยอดรวมทุกที่** (`isZoneExcluded` app.js:838 ถูกเช็ค 6 จุด)

### 3.11 ลำดับความสำคัญ Google Sheet > BigQuery ⚠️ สำคัญมาก
เมื่อ `CURRENT_SHEET_DATA.ok` → **Sheet ทับค่า BigQuery** (app.js:3204-3330, 3544-3553):

| ค่า | มาจาก Sheet | BQ เดิมเก็บไว้ที่ |
|---|---|---|
| `kpis.qty` | `sheet.totalPick` (เมื่อ > 0) | — |
| `kpis.avg_prod`, `raw_avg_prod` | `round(sheet.overall.average)` | — |
| `kpis.target` / `gap` / `status` | `sheet.overall.target \|\| 170` | — |
| `kpis.pickers` | `sheet.pickers.all.length` | — |
| `by_picker[].qty` | `sheet.totalPick` | **`rawBqQty`** |
| `by_picker[].avg_prod` | `sheet.average` | **`rawBqProd`** |
| `daily[]` | เพิ่ม/ทับจาก `monthlyTrend.days` ในช่วง | — |
| `by_zone_prod[].avg_prod` | ค่าเฉลี่ยโซนจาก Sheet | — |
| `DMIN/DMAX` | union กับ `monthlyTrend.days` (เกินช่วง BQ ได้) | — |

**BigQuery ยังเป็นเจ้าของ: โซน/location ที่ทำจริง, item, timeslot, hourMask**

> 🔍 ถ้ามีรายงานว่า "เลขบนเว็บไม่ตรงกับ BigQuery" — เกือบทุกครั้งอยู่ที่ block นี้ ไม่ใช่ที่ cube math

### 3.12 Trainee 2ND
`enrichSheetDataWith2NDTrainees` (app.js:276) — ข้ามถ้า `trainingSource` มี `'2ND'` **และ** มี trainee ≥ 5
อ่าน gviz CSV ตรง: `B`=userId `C`=ชื่อ `D`=ชื่อเล่น `E`=สังกัด `G`=วันเริ่ม `J`=โซน, กรอง col 8 ตรง `/train/i`
```
วันจบเทรน = วันเริ่ม + 2 เดือน
แบ่งช่วง first30 / second30 ที่ วันเริ่ม + 30 วัน   improvement = second - first
target 100, ผ่านเมื่อ average >= 100
```
รองรับวันที่ไทย `d-MMM-yy` + `d/m/y`, แปลง พ.ศ. → ค.ศ. เมื่อปี > 2500

### 3.13 UOM / Pick Units (pick_uom_master_pipeline.sql)
```
Master_Item join key = Owner(B) + Item(C)
Master_Pack lookup   = C ก่อน, ใช้ E เฉพาะเมื่อ C ไม่ match  (C-primary ชนะเสมอ)
PICK → Master_Pack D   |   CASE → Master_Pack H   |   Pick Type ว่าง → D, อื่นๆ → 1
pick_qty (UOM) = QTY / divisor   (NUMERIC ไม่ปัด ไม่ MOD)
```
`pick_qty` = **NULL** เมื่อ master ไม่ match / divisor ≤ 0 / rule ไม่อยู่ใน `PICK_D, CASE_H, BLANK_D, BLANK_FALLBACK_1`
→ master ไม่ครบ **ห้าม** กลายเป็น pieces เงียบๆ
Baseline preflight: **9,351 mapping**, duplicate key = 0, E-fallback ที่ข้ามโดยเจตนา = 2 รายการ

---

## 4. Data flow ฝั่ง browser

### 4.1 Boot sequence (`bootstrapDashboard` app.js:10703)
```
1. restoreSheetDataFromStorage()        ← localStorage ต้องคืนค่าแบบ sync ก่อน // init (test ล็อก)
2. fetchSharedExclusions(false)         ← exclusion จาก server ชนะ localStorage
3. restoreDashboardFromCache()          ← IndexedDB → render ทันที
4. loadData(false)
     ├ fetchRevisionOrDashboard  → ถ้า revision ไม่เปลี่ยน = จบ ไม่ดาวน์โหลดก้อนใหญ่
     ├ earlyCubePromise = Promise.all([Sheet, Resigned, ItemMaster, ItemCube, SlotCube])
     ├ dashboardPayloadRowCount() ตรวจ schema เข้ม → ผิด = throw ไม่ degrade
     └ applyDashboardPayload → ensureDashboardBundleReady → writeDashboardResponseCache
5. startSharedExclusionsPolling()       ← 15 วินาที ตอน tab visible
```
**ไม่มี fallback data สังเคราะห์** — error + มี live data เดิม → คงข้อมูลรอบก่อน + badge "ยังแสดงข้อมูลรอบก่อน"; ไม่มีเลย → `showDataState('error')`
Transient: `DATA_EPOCH_CHANGED` / `DASHBOARD_UPDATE_BUSY` retry 3 ครั้ง backoff 1.2s × n

### 4.2 โครงข้อมูลอัดแน่น (packed rows) — ความกว้างต้องตรงเป๊ะ ไม่งั้น throw
```
work cube  width 10 : [dateIdx, shiftCode, zone, pickerIdx, pcs, pickQty, lines, minSm, maxSm, hourMask]
item cube  width 8  : [dateIdx, shiftCode, zone, owner, skuIdx, pcs, pickQty, lines]
slot cube  width 8  : [dateIdx, shiftCode, zone, pickerIdx, hour, pcs, pickQty, lines]
```
แต่ cube ที่โหลดแยกรับได้หลายความกว้าง: **item 7 หรือ 9** (7 = pre-aggregated ไม่มี date/shift), **slot 6 หรือ 8** (6 = รวมเป็นทีม เสีย picker identity → picker drilldown ว่าง)
`readBigQueryPickQty` (1145) — **ห้าม fallback ไป pcs**

เปลี่ยนความกว้างจาก backend = ต้องแก้ `isValid*CubePayload` + `forEach*Row` + `dashboardPayloadRowCount` + `emptyData()` พร้อมกัน

⚠️ `buildAllSystemCube` (1198): ถ้าฝั่งใดว่าง `DATA.ALL` จะ **assign by reference** → mutate `DATA.ALL` = mutate `DATA.PTT/BPS`

### 4.3 State & render
State เป็น `let` global ล้วน ไม่มี store: `DATA, sys, currentPage, dfrom, dto, shiftF, A, unitMode, prodCalcMode, excludedSkus, excludedZones, built{}`

```
render()  → A = aggregate(...) → destroyCharts() → built = {} (ล้าง memo ทุกหน้า) → show(currentPage)
show(page) → builders[page]() เฉพาะเมื่อ !built[page]
```
`aggregateCache` key = `system|from|to|shift|excludedSkuRevision|prodCalcMode`
⚠️ **key ไม่มี `prodTargets`** → เปลี่ยน target แล้ว target ต่อโซน (คำนวณใน `aggregate`) จะค้างจาก cache; สลับ `prodCalcMode` มี `aggregateCache.clear()` แต่เปลี่ยน target ไม่มี

---

## 5. API contract

### 5.1 `bigquery_to_json.gs` (DATA_URL)
| mode | params | คืนอะไร |
|---|---|---|
| *(ไม่ระบุ)* | `fresh`, `encoding=gzip`, `excluded_items` | dashboard เต็ม: `meta` + `PTT`/`BPS` (`item_rows`/`slot_rows`/`skus` **ว่างเสมอ**) |
| `revision` | — | `{schema_version, revision, min_date, max_date}` |
| `roster` | `fresh=1` | `picker_names/affiliations/shift_teams/roster_teams/responsibilities/roster_zones/resigned/summary/sunday_ot` |
| `item_master` | — | `row_width:9` — allowlist owner **DM02/DP02/DG02/DCWN เท่านั้น** |
| `item_cube` | `system, from, to, shift` | `row_width:7` |
| `slot_cube` | `system, from, to, shift` | `row_width:6` |
| `picker_items` | `system, picker, from, to, shift` | `row_width:8` (ไม่ cache) |
| `dashboard_exclusions` | — | `{status, version, initialized, items[], zones[], updated_at}` |

POST actions: `set_dashboard_exclusions` | `upload_chunk_csv` | `upload_chunk` (legacy) | `upload_commit` | `upload_rows` (legacy)

**รูปแบบ error ไม่เหมือนกัน** (ระวังตอนเขียน handler):
- bq doGet: `{error, code}` — **ไม่มี `status`** และคืน HTTP 200
- bq doPost: `{status:'error', code, message, details}`
- api: `{ok:false, error}`

### 5.2 กลไก revision
```
revision token = `${DASHBOARD_CACHE_FORMAT_VERSION}:${dash_data_revision}:${timeBucket}:${scopeKey}`
```
เปลี่ยนเมื่อ: (1) bump format version = deploy, (2) upload MERGE สำเร็จ / master sync / `refreshDashboardTableNow()`, (3) time bucket หมุน, (4) ชุด exclusion เปลี่ยน (SHA-256 16 ตัว)

⚠️ **"หมุนทุก 15 นาที" ในคอมเมนต์ bq:302 และ SETUP:84 ผิด** — ตัวหารคือ `MASTER_CACHE_TTL × 1000` = **6 ชั่วโมง**
การแก้ตรงใน BigQuery/Sheet จึงไม่ถูกมองเห็นได้นานถึง 6 ชม. **อย่าไปแก้คอมเมนต์ให้ตรง — ต้องตัดสินใจก่อนว่าต้องการพฤติกรรมไหน** เพราะ `MASTER_CACHE_TTL` คุม `CACHE_TTL` และ `masterCacheKey_` ด้วย

Cache: gzip → base64 → หั่น 60,000 ตัวอักษร/key, เขียน `n` **ท้ายสุด** เพื่อไม่ให้อ่านเจอชุดไม่ครบ
Lock: `tryLock(90000)` ล้มเหลว = `DASHBOARD_UPDATE_BUSY`; ตรวจ epoch ซ้ำหลังได้ lock และก่อนเขียน cache

### 5.3 `apps-script-api.gs` (SHEET_API_URL)
อ่าน `Results Master` เป็นก้อน `C:AK` จากแถว 2 (+ col B แยก เพราะอยู่นอกช่วง)
```
C=วันที่ | D=userId | B=ชื่อ | E=TotalPick(fallback, มี header search 12 alias)
AF=Average | AG=Shift | AH=Position | AI=สังกัด | AJ=BU | AK=Pick Type
```
เงื่อนไขนับแถว:
- `average (AF) <= 0` → นับใน `totalPick`/`excludedCount` แต่ **ข้ามทุก bucket**
- `pickToSort` นับตั้งแต่ **2026-06-08** ขึ้นไปเท่านั้น
- `toNumber_` แปลง `"not count"` → 0, ตัด `,`/`%`, `"180 Pick/Hr"` → 180
- วันที่ พ.ศ. > 2400 → ลบ 543
- `warmDashboardCache` trigger ทุก **1 นาที** ← ค่าใช้จ่าย/quota หนักที่สุดของไฟล์นี้
- `mode=dailyindex` ปัจจุบัน **ไม่มีใครเรียก**; `dashboard=true` ที่ app.js ส่ง **server ไม่สนใจ**

---

## 6. Upload pipeline

### 6.1 หัวตารางบังคับ 11 คอลัมน์ (ตำแหน่งคงที่, 1-based)
```
1 PICKDETAILKEY  12 ID  28 QTY  31 SKU  36 STORERKEY  40 UOMQTY
55 EXT_UDF_STR7  56 EXT_UDF_STR8  58 EXT_UDF_STR10  64 EXT_UDF_STR16  66 EXT_UDF_DATE1
```
ค้นหัวตารางใน **10 แถวแรกของทุก Worksheet** ไม่เจอ → `"ไม่พบหัวตาราง Pick Detail ใน 10 แถวแรกของทุก Worksheet"`
ชื่อไฟล์เป็นอะไรก็ได้ | SheetJS โหลด **lazy** เท่านั้น (ห้ามใส่ `<script>` ใน head — test ล็อก)

### 6.2 กฎ validate ต่อแถว (มี error = ไม่เขียนอะไรเลย → `VALIDATION_FAILED`)
| field | กฎ |
|---|---|
| `pickdetailkey` | ต้องมี |
| `qty` | จำนวนเต็ม > 0 |
| `sku` | ต้องมี |
| `uom_qty` | ตัวเลข > 0 (ทศนิยมได้) |
| `category` | ต้องเป็น `PTT` หรือ `BPS` เท่านั้น |
| `picker_id` | ต้องมี |
| `location` | ต้องมี |
| `pick_ts_source` | parse ได้ (`D/M/YYYY H:mm` เป็น branch แรก — `3/4/2026` = 3 เม.ย.) |

`lpn` และ `owner` เป็น 2 field เดียวที่ optional
key ซ้ำในไฟล์: ข้อมูลเหมือนกัน → นับ `exactDuplicates` ทิ้งเงียบๆ; ต่างกัน → error

### 6.3 Stage → verify → MERGE
```
upload_chunk_csv → pick_stage_<session>_c<NNN>  (WRITE_TRUNCATE = retry ได้ปลอดภัย)
upload_commit    → pick_stage_<session>_final   (CREATE OR REPLACE, expire 1 วัน)
```
ตรวจ 3 ชั้น: `outputRows` ตรงกับที่ส่ง → SHA-256 hash ของ stage → manifest เก็บใน **table description** (`pick-upload-manifest-v1:<json>`)
commit ตรวจ manifest ทุก chunk, hash ซ้ำ, duplicate ข้าม chunk (`DUPLICATE_KEY_CONFLICT`)

**MERGE เข้า `pick_detail`** — "ต่างกันจริง" = 9 field `IS DISTINCT FROM`:
`lpn, qty, sku, owner, uom_qty, category, picker_id, location, pick_ts_source`
(`source_row_number` **ถูกตัดออกโดยเจตนา** — ไฟล์ที่หัวตารางเลื่อนไม่นับว่าเปลี่ยน)

- **ไม่มี `WHEN NOT MATCHED BY SOURCE` → upload ไม่เคยลบข้อมูลจาก `pick_detail`**
- คืน `{staged, inserted, updated, unchanged, visible}` — `visible` คือเลขกระทบยอด (แถวที่ผ่าน `v_pick_enriched`)
- Receipt idempotent 7 วัน: ScriptCache → ScriptProperties → BigQuery `pick_upload_receipts`

### 6.4 Refresh `t_pick_dashboard` (incremental)
MERGE keyed `pickdetailkey` จาก stage LEFT JOIN `v_pick_enriched`
- `is_visible` = มี key ∧ `pick_ts_local IS NOT NULL` ∧ `category ∈ (PTT,BPS)`
- **`pick_qty` ไม่อยู่ใน predicate "ต่างกัน" แต่อยู่ใน SET** ← การรับประกัน "ประวัติเสถียร":
  UOM master เปลี่ยนเฉยๆ ไม่ทำให้แถวเก่าถูกอัปเดต แต่ถ้า business field เปลี่ยน `pick_qty` จะคำนวณใหม่ด้วย master ปัจจุบัน
- `MATCHED AND NOT is_visible → DELETE`

> **กฎเหล็ก: upload และ master sync ห้าม rebuild `t_pick_dashboard` ทั้งตาราง** — productivity ของวันที่ปิดแล้วต้องไม่ขยับ
> มีแต่ `refreshDashboardTableNow()` เท่านั้นที่คำนวณประวัติใหม่ได้

---

### 3.14 หน่วยที่แสดง — ล็อกเป็น "หน่วยหยิบ" แล้ว ⚠️ อัปเดต 2026-09-10
```
const unitMode = 'units';   // เป็น const แล้ว ห้ามพยายาม assign
```
- ปุ่มสลับ `หน่วยหยิบ / จำนวนชิ้น` (`.unittog`) **ถูกถอดออกจาก `.sysbar`** ตามมติผู้ใช้งาน
- `isPcs` ทุกจุด (20+ แห่ง) จึงเป็น `false` ตลอด — **ไม่ต้องไปแก้ ternary เหล่านั้น**
- คอลัมน์/การ์ด/tooltip ที่โชว์ "ชิ้น" ถูกถอดออกจาก 20+ ตาราง (th และ td คู่กัน + colspan)
- `aggregate` ยังคำนวณ `pcs` / `avg_pcs_prod` ครบ เพื่อใช้ตรวจย้อนหลังและ test ยังล็อกค่าไว้
- selector ตัวเลือกระบบยังเป็น `.systog:not(.shiftog):not(.unittog):not(.prodmodetog) button` — คงไว้เพื่อกันการเพิ่ม `.systog` ใหม่โดยไม่ใส่ modifier
- เพิ่มคอลัมน์ใหม่ในตาราง = ต้องแก้ `<th>` + `<td>` + `colspan` ให้ครบ (มีสคริปต์ตรวจ static ใน §8)

### 3.15 หน้าใหม่ 3 หน้า ⚠️ อัปเดต 2026-09-10

**`belowtarget` — ไม่ถึงเป้า (รายโซน)** `renderBelowTargetPage()`
- ใช้ `pickerTargetInfo(p)` เทียบ `p.avg_prod` กับ Target: **Blended (ถ่วงตามโซนที่ทำจริง จาก Sheet) → Target ของโซนหลัก**
- โซนหลัก = `p.zone` (โซนที่ทำ lines มากที่สุด) ผ่าน `resolveTargetZoneLabel`
- นับเฉพาะคนที่ `avg_prod > 0` (คือผ่านเกณฑ์ countable แล้ว)
- โซนที่ไม่มีคนตกเป้า **ไม่แสดงตาราง**
- canvas: `belowTargetZoneChart` (stacked bar ถึงเป้า/ไม่ถึงเป้า ต่อโซน)

**`trend` — เทรนรายสัปดาห์ / รายเดือน** `renderTrendPage()`
- `trendPeriodMode` = `'week' | 'month'` (แยกจาก `trendMode` ของกราฟหน้าแรก) เก็บใน `localStorage['pickProductivityTrendPeriod']`
- `buildTrendPeriods(mode)` bucket จาก `A.daily`; **สัปดาห์เริ่มวันจันทร์**
- ⚠️ `trendPeriodKey` **ห้ามใช้ `toISOString()`** — จะเลื่อนวันย้อนหลังในโซนเวลา +07:00 (ใช้ getFullYear/getMonth/getDate)
- Productivity ของงวด = เฉลี่ยของ `daily.avg_prod` ที่ > 0 · ปริมาณ = ผลรวมทั้งงวด
- `prodDeltaPct` / `qtyDeltaPct` = % เทียบงวดก่อนหน้า (WoW / MoM), งวดแรก = `null`
- canvas: `trendPeriodChart` (bar ปริมาณ + line prod), `trendChangeChart` (bar % เปลี่ยนแปลง)

**`individual` — ภาพรวมรายบุคคล** `renderIndividualPage()`
- 2 โหมดในหน้าเดียว: `individualPickerId === null` → ตารางเทียบทุกคน / มีค่า → Scorecard
- `openIndividualScorecard(encodedId)` / `closeIndividualScorecard()` เป็น global (หน้า "ไม่ถึงเป้า" เรียกผ่าน `onclick`)
- ตารางเทียบเรียงตาม `% Efficiency`, ค้นหาผ่าน `individualSearchTerm` (`#individualSearch`)
- `individualDailyRows(id)` คำนวณ prod รายวันจาก `A.picker_drilldown[id].byDate` ด้วย `activeHourCount(hourMask)` + `v2RoundedProductivity` + `isV2CountableProductivity` (สูตรเดียวกับ aggregate)
- canvas: `individualCompareChart` (horizontal bar prod vs target 20 อันดับแรก), `individualTrendChart` (bar ปริมาณ + line prod + เส้น Target รายวัน)

Helper ที่ใช้ร่วมกัน: `pickerTargetInfo`, `pickerTeamBadge`, `pickerResignedBadge`, `statCardsHtml`

## 7. UI / HTML contract

### 7.1 สิ่งที่ JS สร้างเอง — ห้ามใส่ใน HTML
`.sysbar` (ตัวกรองทั้งหมด), `#loadov`, `#dash-style`, `#dfrom`, `#dto`, `#refreshBtn`, `#prodTargetInput`,
ทุก `#efficiency*`, `#cycleTime*`, `#incentive*`, `#rpt*`, `#sim*`, `#history*`, banner ทุกตัว

`buildControls()` แทรก `.sysbar` ด้วย `querySelector('.pagehead').insertAdjacentElement('afterend', bar)`
→ **ถ้าลบ/เปลี่ยนชื่อ `.pagehead` ตัวกรองทั้งหมดหายไป**

### 7.2 กฎเพิ่มหน้าใหม่
ต้องเพิ่ม `data-page` ให้ตรงกัน **4 ที่**: `.nav[data-page]` + `section.page[data-page]` + `TITLES` + `builders`
ปัจจุบันมี **17 หน้า** ครบทั้ง 4 ที่ (มีสคริปต์ตรวจใน §8)

### 7.2.1 โครงเมนู 4 หมวด ⚠️ อัปเดต 2026-09-10
```
nav.sidebar
 ├ .brand
 ├ .sidebar-scroll            ← flex:1, overflow-y:auto (เมนูทั้งหมดอยู่ในนี้)
 │   ├ .nav-group  (× 4)  → .nav-group-title > .nav-group-num + .nav ...
 ├ .nav-actions               ← ปุ่ม upload / reset / export (flex-shrink:0)
 └ .sidebadge
```
| หมวด | หน้า |
|---|---|
| 1 ดูก่อน · ภาพรวม | overview, prod, **trend** |
| 2 เจาะหาปัญหา | **belowtarget** (`.nav-alert` สีแดง), **individual**, zones, pickers, typebreak |
| 3 วิเคราะห์ลึก | efficiency, cycletime, time, items |
| 4 จัดการ & อ้างอิง | incentive, training, simulator, report, history |

- `@media(max-width:900px)` คลี่ `.sidebar-scroll` / `.nav-group` / `.nav-actions` เป็นแถวเดียวแนวนอน และซ่อน `.nav-group-title`
- `.sidebadge` เปลี่ยนจาก `margin-top:auto` → `margin-top:10px` เพราะ `.sidebar-scroll` รับ flex:1 ไปแล้ว

### 7.3 กฎเพิ่ม toggle ใหม่
selector ของตัวเลือกระบบคือ `.systog:not(.shiftog):not(.unittog):not(.prodmodetog) button`
→ **กลุ่ม `.systog` ใหม่ต้องมี modifier class ของตัวเอง** ไม่งั้นถูกตีความเป็นตัวเลือก PTT/BPS

### 7.4 กฎเพิ่มกราฟใหม่
canvas ที่อยู่ถาวรใน DOM ต้องเพิ่ม id เข้า `destroyCharts()` (app.js:10051) ไม่งั้น `"Canvas is already in use"`

Library: **Chart.js 4.4.1 + datalabels 2.2.0 จาก cdnjs** (blocking ใน head), font `Prompt`
Convention: **bar เป็นหลัก ไม่มีเส้น ไม่มี grid line** (ยกเว้น combo 4 ที่: overview, V1 history, efficiency trend, cycletime trend)
Headroom กันชนกับ legend: `suggestedMax = ceil(max × 1.35)` + `grace: '25%'`; datalabels `clip:false, clamp:true`, ซ่อนเมื่อค่า = 0

### 7.5 Design token (index.html:14)
```
--indigo #6366f1  --violet #8b5cf6  --teal #14b8a6  --amber #f59e0b
--rose #f43f5e    --sky #0ea5e9     --emerald #10b981
--ink #1e293b     --muted #64748b   --card #fff
```
Gradient ประจำ: nav/seg active `90deg indigo→violet` | ALL `135deg #8b5cf6→#6366f1` | PTT `#0ea5e9→#2563eb` | BPS `#f59e0b→#ea580c` | upload `#059669→#10b981` | export `#7c3aed→#6366f1`
Class หลัก: `.card` (radius 18, shadow `0 10px 30px -14px`), `.kpi`, `.zone-stat`, `.pill`, `.badge-status`, `.chartbox` (300px / `.tall` 380px), `.note` (amber), `.seg`/`.systog` (track `#f1f5f9` + chip ขาว/gradient)
Responsive breakpoint สำคัญ: **900px** — sidebar กลายเป็นแถบเลื่อนแนวนอน, grid เหลือ 1 คอลัมน์, `table { min-width: 760px }`
มี `@media print` เต็มรูปแบบ | **ไม่มี dark mode**

### 7.6 Storage keys
```
localStorage: pick_productivity_sheet_master_cache_v2 (+ '_<from|to>')
              pick_dashboard_excluded_items_v2 | pick_dashboard_excluded_zones_v1
              pick_dashboard_prod_targets_v2 | pick_dashboard_planner_zone_productivity_v1
IndexedDB:    db 'pick_dashboard_cache_v1' store 'responses'  (TTL 30 วัน)
              key = DASHBOARD_SCHEMA_VERSION + ':bq-pick-qty:latest'
```

---

## 8. Tests — ต้องรันก่อน ship

```powershell
cd "C:\Users\somka\Desktop\งาน\Pick Productivity_V2"
Get-ChildItem tests\*.test.js | ForEach-Object { node $_.FullName }
```
ไม่มี package.json / framework — plain Node (**14 ไฟล์**: 12 ไฟล์ imperative assert, 2 ไฟล์ใช้ `node:test`)
ควรรันข้าม timezone ด้วย เพราะมี logic เกี่ยวกับวันที่: `TZ=Asia/Bangkok`, `TZ=UTC`, `TZ=America/New_York`

**สคริปต์ตรวจ static ที่ควรรันหลังแก้ตาราง/หน้าใหม่** (เขียนใหม่ได้ตามต้องการ):
- นับ `<th>` vs `<td>` vs `colspan` ของทุกตารางใน `app.js`
- เทียบ `data-page` ใน nav / `section.page` / `TITLES` / `builders` ให้ครบทั้ง 4 ที่

⚠️ **4 test อ่าน app.js เป็น text แล้ว `vm.runInContext` ตัดที่ marker**:
```js
source.search(/\/\/ init\r?\nloadExcludedSkusFromStorage\(\);/)
```
→ บรรทัด `// init` ตามด้วย `loadExcludedSkusFromStorage();` (app.js:10696-10697) เป็น **load-bearing**
สลับ/เปลี่ยนชื่อ = test 4 ไฟล์พัง | ทุกอย่างที่ test ต้องใช้ต้องอยู่ **เหนือ** marker

### สิ่งที่ test ล็อกไว้ (ห้ามเปลี่ยนโดยไม่แก้ test พร้อมกัน)
| test | ล็อกอะไร |
|---|---|
| `shift_logic` | ขอบ 420/1140 นาที + rollback `+300` ครบ 6 เคส; work-cube shift ชนะ roster team |
| `zone_layout` | 7/14/14/2 = 37 unique, มี `PF`, ไม่มี `BE`/`HB`, `bottomBands` 4 tuple เป๊ะ |
| `zone_master` | **38 keys** + `AA/BG/BE/HB` เป๊ะ |
| `zone_map_linking` | `CA→AN`, `DF→CF` เฉพาะเมื่อ `lines === 0` |
| `picker_affiliation` | **220 keys** + 3 id ตัวอย่าง |
| `cube_aggregation` | `row_width 10/8/8`, exclusion เข้า `by_item_all` ไม่เข้า `by_item`, `avg_prod === 6` |
| `picker_sheet_hybrid` | Sheet ชนะ volume, BQ เก็บใน `rawBqQty` |
| `sheet_master_persistence` | restore แบบ sync ก่อน `// init`, `DMAX` ขยายเกิน BQ ได้ |
| `resigned_status` | คนลาออกต้องไม่เสีย qty/pcs/ot/avg_prod |
| `performance_contract` | 100+ assertion — de-facto spec ทั้งระบบ (รวม Target ราย Zone, การถอด pcs, 3 หน้าใหม่, เมนู 4 หมวด) |
| `new_pages_render` | เรนเดอร์ 3 หน้าใหม่จริงจาก cube ผ่าน DOM stub: zone target ชนะ type target, week bucket เริ่มจันทร์, prod รายวัน 1000÷5=200, Modal 17 zone |
| `chart_daily_series` | `dailySeriesForRange` ให้เลขตรงกับ `aggregate().daily` เป๊ะ 6 ช่วง/3 กะ **ทั้งมีและไม่มี Sheet** · กราฟกางทั้งเดือนขณะตารางเหลือวันเดียว · `‹ ›` เลื่อนเดือนในช่วงข้อมูลจริง · หน้าเทรนกางทุกงวด + รู้งวดที่ครอบวันที่เลือก · exclude โซนมีผลกับกราฟ |
| `table_columns` | เรนเดอร์ 17 renderer/builder ด้วย DOM stub แบบ catch-all แล้วนับ `<th>` vs `<td>` vs `colspan` ให้ตรงกันทุกตาราง (27 ตาราง) + ห้ามมีหัวคอลัมน์ "ชิ้น" กลับมา |

### Performance budget ใน `performance_contract.test.js`
```
UPLOAD_CHUNK_TARGET_BYTES 1 MB | UPLOAD_CHUNK_MAX_ROWS 3000 | UPLOAD_CHUNK_CONCURRENCY 1 (ห้ามขนาน)
BQ_RESULT_PAGE_ROWS 30000 | dashboardBuildLock.tryLock(90000) | cache 30 วัน | exclusion debounce 700ms
HISTORICAL_V1_DAILY: 184 แถว, รวม 17,475,482, จบ 2026-07-19, v2StartDate 2026-07-20
```
**Negative assertion (ต้องไม่กลับมา)**: `xlsx.full.min.js` ใน head, `btnCalendarDropdown`/`calPopover`/`เลือกหลายวัน`, `compression:'GZIP'`, `upload_rows_gzip`, `pickerRosterShiftCodeSql_('picker_id','tmin')`

---

## 9. ขั้นตอน deploy

### แก้ app.js / index.html
1. bump `app.js?v=` ที่ index.html:2809
2. แก้ `performance_contract.test.js:11` ให้ตรง
3. รัน test ทั้งหมด
4. `git add . && git commit && git push` → GitHub Pages ~1 นาที

### แก้ .gs — **ต้องสร้าง deployment version ใหม่ ไม่งั้นเว็บยังใช้โค้ดเก่าเงียบๆ**
1. Apps Script → Deploy → **Manage deployments** → Edit
2. Version → **New version** → Deploy (URL `/exec` เดิม)
3. Smoke test: `<exec>?mode=revision` ควรได้ `{"schema_version":"pick-units-v24-...","revision":"..."}`
4. รัน `testRun()` ในเอดิเตอร์ (13 เช็ค — แต่ **ยิง BigQuery จริง มีค่าใช้จ่าย**)

ตั้งค่า Web App: **Execute as = Me**, **Who has access = Anyone**, เปิด BigQuery advanced service, timezone = Asia/Bangkok

### แก้ payload shape
bump `DASHBOARD_SCHEMA_VERSION` (app.js + .gs พร้อมกัน) หรือ `DASHBOARD_CACHE_FORMAT_VERSION`
ไม่ bump = เสิร์ฟ JSON รูปเก่านานถึง 6 ชม.
ฝั่ง api: bump `CACHE_VERSION` + เพิ่ม field เข้า `isUsableDashboardPayload_` ไม่งั้น cache ไม่ hit เลย

---

## 9.1 ⚠️ ต้อง deploy .gs ใหม่หลังอัปเดต 2026-09-10

รอบนี้แก้ `bigquery_to_json.gs` (เพิ่ม `mode=dashboard_targets` + `action=set_dashboard_targets`)
**ถ้าไม่ deploy version ใหม่** Target ราย Zone จะบันทึกลง localStorage ได้แต่ **ส่งเป็นค่ากลางไม่ได้** (Modal จะขึ้นข้อความสีเหลืองแจ้ง)
Smoke test หลัง deploy:
```text
<exec>?mode=dashboard_targets
→ {"status":"success","version":1,"initialized":false,"types":{},"zones":{},"updated_at":""}
```

---

## 10. เช็กลิสต์ก่อนแก้ (ห้ามพลาด)

- [ ] แก้ `app.js` → bump cache-buster ที่ `<script src="app.js?v=...">` + แก้ `performance_contract.test.js:11`
- [ ] แก้สูตร weighted KPI → แก้ **3 ที่**: `PRODUCTIVITY_WEIGHT_CONFIG` (492), `calculateCrossSystemWeightedProductivity` (2541), ข้อความใน index.html:2186
- [ ] เพิ่ม owner สินค้า → `ALLOWED_ITEM_OWNERS` (app.js:457) **และ** allowlist ใน `buildItemMasterData_` (bq:548)
- [ ] เพิ่มโซนใหม่ → `ZONE_GROUPS` (api:71) + `ALL_VALID_ZONES` (api:2067) + `zone_master_fallback.js` + `zone_layout.js` + test
- [ ] เปลี่ยน payload width → `isValid*CubePayload` + `forEach*Row` + `dashboardPayloadRowCount` + `emptyData()`
- [ ] เพิ่ม canvas ถาวร → `destroyCharts()`
- [ ] เพิ่มหน้า → `data-page` 4 ที่ + เพิ่ม nav ลงใน `.nav-group` หมวดที่เหมาะสม
- [ ] เพิ่ม/ลบคอลัมน์ตาราง → แก้ `<th>` + `<td>` + `colspan` ให้ครบ แล้วรันสคริปต์ตรวจ th/td
- [ ] เพิ่ม Target ชนิดใหม่ → `DEFAULT_PROD_TARGETS` (app.js) + `SHARED_TARGET_TYPE_KEYS` (bq) + `TARGETS` (api) + input ใน modal
- [ ] เพิ่มฟังก์ชันที่ test ต้องเรียก → ต้องอยู่ **เหนือ** marker `// init`
- [ ] เพิ่มค่าที่ user ควบคุมลง SQL → `sqlStringLiteral_` + allowlist ของตัวเอง (SQL ต่อ string ล้วน ไม่มี parameterization)
- [ ] แก้ .gs → New deployment version
- [ ] รัน `tests/` ทั้ง 10 ไฟล์

---

## 11. Known drift / ของที่รู้อยู่แล้วว่าเพี้ยน

| # | เรื่อง | สถานะ |
|---|---|---|
| 1 | revision bucket จริง **6 ชม.** ไม่ใช่ 15 นาที (bq:302, SETUP:84 เขียนผิด) | ต้องตัดสินใจว่าจะเอาพฤติกรรมไหน อย่าแก้แค่คอมเมนต์ |
| 2 | เพดานแถว: SETUP:100 เขียน 50,000 / โค้ดจริง 100,000 | แก้เอกสาร |
| 3 | `item_cube` ไม่มี `RECENT_DAYS` floor และกรอง `pick_date` ไม่ใช่ `shift_date` (ต่างจาก query อื่นทั้งหมด) | ตั้งใจหรือเปล่ายังไม่ยืนยัน |
| 4 | `calculateCrossSystemWeightedProductivity` hardcode `PTT` และไม่ถูกเรียก | drift risk |
| 5 | ~~Cycle Time `z.avg_pcs_prod \|\| z.pcs` — เอายอดมาใช้เป็นอัตรา~~ | ✅ **แก้แล้ว 2026-09-10** (คอลัมน์ Cycle Time ต่อชิ้น ถูกถอดออกพร้อมหน่วยชิ้น) |
| 6 | Incentive: `isEligible` vs การ์ดสรุปนับ `reward>0` ไม่ตรงกัน | ต้องเลือกนิยามเดียว (ยังไม่แก้) |
| 7 | `prodTarget` กับ `prodTargets.overall` เก็บค่าเดียวกันสองตัวแปร | เขียนผ่าน `saveProdTargetsToStorage` เท่านั้น |
| 8 | `r1` / `mean` ประกาศซ้ำใน `aggregate` (2948-2949) ต่างจาก global (468-469) | ห้ามเปลี่ยนชื่อ/ลบ |
| 9 | `aggregateCache` key ไม่มี `prodTargets`/`zoneTargets` → target ต่อโซนค้าง cache | 🟡 บรรเทาแล้ว: ทุกจุดที่บันทึก Target เรียก `aggregateCache.clear()` แต่ key ยังไม่รวม target |
| 10 | dead code: `pickerRosterShiftCodeSql_` (bq:2233), `mode=dailyindex` (api:182), `dashboard=true` param, `v_pick_enriched.shift_date/.shift_code/.time_slot/.week_start/.month_start` | อย่าไปพยายามทำให้ทำงาน |
| 11 | `item_row_width`/`slot_row_width`/`skus`/`item_rows`/`slot_rows` ใน payload หลักว่างเสมอ | vestigial |
| 12 | `warmDashboardCache` trigger ทุก 1 นาที | ต้นทุน quota สูงสุด |
| 13 | slot cube width 6 เสีย picker identity → picker drilldown timeslot ว่างเงียบๆ | รู้ไว้ |
| 14 | `app.js` เคยเป็น CRLF ในเครื่องแต่ LF ใน repo → `git diff` เป็นทั้งไฟล์ และ assertion ที่เทียบ string มี `\n` กลายเป็นจริงตลอด | ✅ **แก้แล้ว 2026-09-10** — normalize `app.js` เป็น LF แล้ว **อย่าเขียนกลับเป็น CRLF** และเลิกใช้ literal `\n` ใน assertion (ใช้ index/slice แทน) |
| 15 | `fetchDailyItemCube` ส่ง `dashboardScopeQuery()` ต่างจาก `loadCurrentItemCube` ที่ไม่ส่ง | ตั้งใจหรือเปล่ายังไม่ยืนยัน — test บังคับเฉพาะ `loadCurrentItemCube` |
| 16 | Picker จาก Sheet ถูก push เข้า `by_picker` โดยไม่เช็คตัวกรองกะ | ✅ **แก้แล้ว 2026-09-10** — `tests/shift_filter_sheet.test.js` ล็อกไว้ |
| 17 | **ยังเหลือ**: `kpis.qty` (`s.totalPick`), `kpis.avg_prod` (`s.overall.average`) และ `daily[]` (`s.monthlyTrend.days`) ยังเป็นค่า **รวมทุกกะ** ถึงจะเลือกกะ A/B อยู่ | ยังไม่แก้ — เป็นค่าที่ CLAUDE.md §3.11 ระบุว่า Sheet เป็นเจ้าของ ถ้าจะให้กรองตามกะต้องรวมจาก `sheetPickers` เอง **ต้องให้ผู้ใช้ตัดสินใจก่อน** เพราะเลขพาดหัวจะไม่ตรงกับยอดใน Sheet อีก |

---

## 12. ความปลอดภัย (รู้ไว้ อย่าทำให้แย่ลง)

- Web App ทั้งสองตัวตั้ง **Anyone** และรันด้วยสิทธิ์ผู้ deploy → **POST upload / เขียน shared exclusion ไม่มี authentication เลย** ใครรู้ URL ก็ยิงได้
- `saveSharedDashboardExclusions_` ไม่มี caller identity → ใครก็เปลี่ยน exclusion ของผู้ใช้ทุกคนได้
- SQL ทั้งหมดต่อ string ตัวกันเดียวคือ `sqlStringLiteral_` (`'` → `''`) + allowlist สำหรับ `system`/`shift` + regex `^\d{4}-\d{2}-\d{2}$` สำหรับ `from`/`to`
- `apps-script-api.gs` รองรับ JSONP `?callback=` ซึ่งอนุญาต dotted path (`window.foo`)
- **ห้ามฝัง secret ใน JavaScript บน GitHub Pages**
- HTML ฝั่ง client inject ด้วย template string เกือบทั้งหมด มี escaper แค่ `escapeZoneHtml` (1749) — ข้อความ dynamic ใหม่ต้องตามแบบเดิม
