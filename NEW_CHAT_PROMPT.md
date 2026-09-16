# Prompt ตั้งต้นสำหรับแชทใหม่ — Pick Productivity V2

> คัดลอกทั้งหมดตั้งแต่เส้นคั่นด้านล่างไปวางในแชทใหม่ แล้วเติมงานที่ต้องการในหัวข้อ "งานที่อยากให้ทำรอบนี้"
> อัปเดตไฟล์นี้เมื่อสถานะโปรเจกต์เปลี่ยน เพื่อให้แชทถัดไปตั้งต้นได้แม่นเสมอ
> สร้างเมื่อ 2026-09-16

---

## งานที่อยากให้ทำรอบนี้

<!-- เติมตรงนี้ -->

---

## โครงสร้างระบบ

- **โฟลเดอร์หลัก (ใช้ตัวนี้เป็นหลัก)**: `D:\UserProfile\Desktop\งาน\Pick-Productivity-main_V2`
  มี `CLAUDE.md` เป็นคู่มือสถาปัตยกรรม + กฎการแก้ไข **อ่านก่อนแก้โค้ดทุกครั้ง** และมีเช็กลิสต์ §10 ที่ต้องทำตาม
- **โฟลเดอร์ที่เชื่อมกัน (V1)**: `D:\UserProfile\Desktop\งาน\Pick-Productivity-main\Pick-Productivity-main`
  Dashboard รุ่นเก่า (ไฟล์เดียว: index.html + script.js + styles.css + apps-script-api.gs) **ยังใช้งานจริงอยู่** ที่
  https://nattapolsa-pixel.github.io/Pick-Productivity/ — repo: https://github.com/nattapolsa-pixel/Pick-Productivity
- **Data ต้นทาง (Google Sheet)**: https://docs.google.com/spreadsheets/d/1PMnlyYHswnV0nE73Alxh-ocIFtTipB9LMzACdNM9GFs/edit
  ชีตที่ระบบใช้: `Results Master` (KPI หลัก), `2ND` (trainee/roster), `Update name`, `Zone_V2`, `Resigned`
- **ที่เก็บข้อมูลและตัวคำนวณหลัก (BigQuery)**: project `productivity-pick` / dataset `pick_analytics` / location `asia-southeast1`
  สายข้อมูล: `pick_detail` → `v_pick_clean` → `v_pick_enriched` → **`t_pick_dashboard`**
  Dashboard อ่าน `t_pick_dashboard` เท่านั้น — แก้ view แล้วหน้าเว็บไม่เปลี่ยน

---

## ⚠️ เรื่องที่ต้องรู้ก่อนแตะไฟล์ .gs (ตรวจยืนยันจากโค้ดจริงแล้ว)

**V1 และ V2 ยิงไปที่ Apps Script deployment ตัวเดียวกัน**

```
V1 script.js  RESULTS_API_URL  ┐
                              ├→ .../AKfycbyby7nOGMZe.../exec   (Sheet KPI)
V2 app.js     SHEET_API_URL    ┘
V2 app.js     DATA_URL          → .../AKfycbyM0IVjD6Eo.../exec   (BigQuery)
```

ไฟล์ `apps-script-api.gs` มีอยู่ **ทั้งสองโฟลเดอร์ และแตกกันไปแล้ว 187 บรรทัด** ในขณะที่เป็น source ของ script ตัวเดียว:

| | CACHE_VERSION | สถานะ |
|---|---|---|
| V1 | `v49-ajak-half-rack` | มีการย้าย Zone AJ-AK ไป Half Rack |
| V2 | `v49-sheet-2nd-roster` | มีฟีเจอร์ 2ND roster ที่ V1 ไม่มี |

**ห้าม deploy `apps-script-api.gs` จากโฟลเดอร์ V1** — จะทับฟีเจอร์ 2ND roster ที่ V2 ใช้อยู่
ถ้าต้องแก้ฝั่ง server ให้แก้ **ก็อปปี้ของ V2** แล้ว deploy ตัวนั้น (Manage deployments → Edit → New version, ห้าม New deployment ไม่งั้น URL เปลี่ยน)
ยังมีเรื่องค้างที่ต้องตัดสินใจ: จะให้ก็อปปี้ไหนเป็นตัวจริงถาวร

---

## สถานะล่าสุด

- **test V2 ผ่านหมด 14/14 ไฟล์** รันข้าม timezone แล้ว (Asia/Bangkok, UTC, America/New_York) — รันด้วย `node tests/xxx.test.js` ไม่มี framework ไม่มี package.json
- **V1 แก้ไป 2 อย่างและ push ขึ้น GitHub แล้ว** (2026-09-15/16):
  1. เปลี่ยนปุ่ม "กลับค่าเริ่มต้น" ในหน้าตั้งค่า Target → ปุ่ม "ยกเลิก" (คนเผลอกดแล้ว Target หาย) + ใส่ตัวแปลง key เก่าใน `readStoredTargets()` กันค่าที่ผู้ใช้ตั้งไว้หาย
  2. ย้าย Zone AJ-AK จากกลุ่ม Full Rack → Half Rack (key `fullRackAjAk` → `halfRackAjAk`, Target คงไว้ 170 ตามที่เจ้าของงานเลือก) ใส่ `legacySource` fallback ฝั่ง client ไว้ **ทำให้ไม่ต้อง deploy .gs**
- **V2 ย้าย Zone AJ-AK → Half Rack แล้ว** (2026-09-16, ยังไม่ได้ push — รอผู้ใช้กด `sync-to-github.bat`):
  1. `zone_master_fallback.js`: AJ/AK `typePick` เปลี่ยนจาก `'Full Rack'` → `'Half Rack'`
  2. `app.js` `prepareZoneMaster()`: เพิ่ม **forced override** บังคับ AJ/AK เป็น Half Rack เสมอ หลัง merge ทั้ง fallback และ live payload (`DATA.meta.zone_master`) — เพราะ payload สดจาก Sheet `Zone_V2` ชนะ fallback ตามปกติ (§3.10) และ **ไม่มีเครื่องมือแก้ Google Sheet `Zone_V2` โดยตรงในรอบนี้** ถ้าใครไปแก้ค่าใน Sheet ให้ตรงกันแล้วจริง ๆ ค่อยลบ override นี้ทิ้งได้ (มีคอมเมนต์กำกับไว้ในโค้ด)
  3. **ตรวจแล้วไม่ต้องแก้ `apps-script-api.gs`**: ยิง `<DATA_URL>?mode=dashboard_targets` จริงพบว่า zone-level target override ของ `AJ-AK` ถูกตั้งไว้แล้วที่ **150** (ชนะทุก type-target อยู่แล้วตาม §3.5) และตามรอยโค้ดพบว่า `zp.sheetTarget`/`bp.sheetTarget` (มาจาก `ZONE_GROUPS` ใน apps-script-api.gs) **ไม่ถูกใช้แสดง Target จริงบนหน้า Zone/Efficiency เลย** (ของจริงมาจาก `getTargetForZoneOrType` เท่านั้น) — เปลี่ยน `ZONE_GROUPS` ฝั่ง .gs รอบนี้จะไม่มีผลที่มองเห็นได้ แต่ต้อง deploy ใหม่ (เสี่ยงกับ V1 ที่ใช้ deployment เดียวกัน) จึงข้ามไปก่อน ถ้าจะทำให้ label ตรงกัน 100% (ไม่ใช่แค่ผลลัพธ์) ยังเป็นงานค้างอยู่ (ดู §งานค้างที่ต้องตัดสินใจ)
  4. bump cache-buster เป็น `app.js?v=20260916-ajak-half-rack-v99` + แก้ `performance_contract.test.js:11` ให้ตรง แล้วรัน test ทั้ง 14 ไฟล์ผ่านครบทั้ง 3 timezone
  5. สร้าง `sync-to-github.bat` / `sync-to-github.ps1` ให้โฟลเดอร์ V2 แล้ว (ตาม pattern เดียวกับ V1) ชี้ไปที่ repo แยกของ V2: `https://github.com/nattapolsa-pixel/Productivity-Picker` — เพิ่ม `.gitignore` กันสองไฟล์นี้ (+ `.sync-branch`) ไม่ให้หลุดเข้า repo
  6. โฟลเดอร์นี้ยังไม่มี `.git` มาก่อน — รอบแรกที่กด `sync-to-github.bat` จะ `git init` + connect ไป repo ข้างบนให้เอง (ดูรายละเอียดใน skill `pick-productivity-github-sync`)
- **V2 ตัดระบบ Weighted Productivity ออกทั้งหมดแล้ว** (2026-09-16, คนละรอบกับ AJ-AK ข้างบน — ยังไม่ได้ push):
  1. ลบ `PRODUCTIVITY_WEIGHT_CONFIG`, `calculateWeightedProductivity`, `calculateCrossSystemWeightedProductivity` (dead code เดิม — แก้ drift #4 ไปในตัว), `resolveProductivityWeightBucket`, `normalizeProductivityWeightZone`
  2. ลบ `prodCalcMode` state ทั้งหมด (ไม่มี toggle raw/weighted อีก) — `aggregate().kpis.avg_prod` เป็น Raw V2 เสมอ, ลบ `weighted_avg_prod`/`kpi_weighted_avg_prod`/`weight_coverage`/`productivity_weighting` ออกจาก payload ที่ `aggregate()` คืน
  3. ลบ UI: ปุ่ม `.prodmodetog` ใน `.sysbar`, แท็บย่อย "สูตรถ่วงน้ำหนัก (Weighted KPI)" + panel `#prodTabPanel-weighted` ในหน้า Productivity, banner `#weightedProductivityBanner`, ข้อความ `Overall = (37%×Full Rack)+(48%×Half Rack)+(15%×EA)` ใน index.html
  4. ลบโหมดกราฟ `rack` (FullRack/HalfRack/EA รายวัน) ใน `renderAnalyticsChart` — เปลี่ยน default ของ `prodAnalyticsMode` จาก `'rack'` เป็น `'target'` (โหมด Target vs Actual เดิม) ทั้งใน state และปุ่ม toggle `#prodChartModeTog` ใน index.html
  5. อัปเดต `tests/cube_aggregation.test.js` (ลบ assertion ที่ทดสอบ prodCalcMode/productivity_weighting) และ `tests/table_columns.test.js` (ลบ `renderWeightedKpiView` ออกจาก list renderer ที่ทดสอบ) — รัน test ทั้ง 14 ไฟล์ผ่านครบ 3 timezone
  6. bump cache-buster เป็น `app.js?v=20260916-remove-weighted-kpi-v100` + แก้ `performance_contract.test.js:11`
  7. อัปเดต CLAUDE.md §3.4 (ลบรายละเอียดสูตร weighted ทิ้ง เหลือ note ว่าตัดออกแล้ว) + checklist §10 + drift #4 ให้ตรงกับสถานะใหม่
  8. **Target ต่อโซน/ประเภท (§3.5, `zoneTargets`/`getTargetForZoneOrType`) ไม่ถูกแตะเลย** — อันนี้เป็นระบบ Target แยกจาก Weighted Productivity คนละเรื่องกัน ยังทำงานตามปกติ

---

## CLAUDE.md แม่นเรื่องสถาปัตยกรรม แต่เลขบรรทัดคลาด — ใช้ตารางนี้แทน

`app.js` ปัจจุบัน **12,887 บรรทัด** (เอกสารเขียน 12,611), `index.html` 3,000 บรรทัด
offset ไม่สม่ำเสมอ: ต้นไฟล์ 0 → +298 → +523 → **+1,378 ท้ายไฟล์**

| สิ่งของ | เอกสารบอก | ของจริง |
|---|---|---|
| marker `// init` | app.js:10696 | **app.js:12052-12053** |
| `app.js?v=` (§9) | index.html:2809 | **index.html:2997** |
| `#targetBadgeVal` (170) | index.html:2161 | **index.html:2330** |
| ข้อความสูตร weighted | index.html:2186 | **index.html:2355** |
| `UPLOAD_SCHEMA_VERSION` + ค่าคง upload | app.js:10735-10744 | **app.js:12093-12102** |
| `DEFAULT_PROD_TARGETS` | app.js:759 | **app.js:768** |
| `renderEfficiencyPage` | app.js:7970 | **app.js:9347** |
| `renderCycleTimePage` | app.js:8314 | **app.js:9687** |
| `renderIncentivePage` | app.js:8642 | **app.js:10006** |
| `renderUnmappedTeamBanner` | app.js:3863 | **app.js:4377** |
| Sheet>BQ override block (§3.11) | app.js:3204-3330 / 3544-3553 | **app.js:3720-3853 / 4059-4076** |
| `dashboardShiftDateSql_` / `ShiftCodeSql_` | bq:457 / 465 | **bq:536 / 544** |
| `DASHBOARD_CACHE_FORMAT_VERSION` | bq:43 | **bq:49** |
| comment "15 นาที" ที่ผิด | bq:302 | **bq:381** (+ SETUP:84) |
| เพดานแถวใน SETUP ที่ผิด | SETUP:100 | **SETUP:101** |

เลขที่ **ถูกต้องอยู่แล้ว**: `DASHBOARD_SCHEMA_VERSION` app.js:438, KPI constants 451-457, `PRODUCTIVITY_WEIGHT_CONFIG` 492, `aggregate` 3224, `renderTargetZoneInputs` 1043, api ทั้งไฟล์ (`TARGETS` 29, `ZONE_GROUPS` 71, `ALL_VALID_ZONES` 2067, `isUsableDashboardPayload_` 2130)

### ข้อเท็จจริงในเอกสารที่คลาด (ตรวจแล้ว)

- `isZoneExcluded` ถูกเช็ค **14 จุด ไม่ใช่ 6**
- `bootstrapDashboard` มี **6 ขั้น ไม่ใช่ 5** — `fetchSharedTargets()` แทรกอยู่ และ await network ทุก cold boot
- `buildTrendPeriods` **ไม่ได้ bucket จาก `A.daily` แล้ว** ใช้ `dailySeriesForRange(sys, DMIN, DMAX, shiftF)` (app.js:6506)
- `shiftRegularHours` / `otHours` / `productivityHours` / `shiftWorkHoursBetween` **ตายสนิท ไม่มี caller เลย** (ไม่ใช่ "ใช้ใน Workforce Planning") — ตัว constant `SHIFT_A/B_REGULAR_HOURS` ยังใช้จริงที่ 8986, 9072, 9094
- revision bucket **6 ชั่วโมงยืนยันแล้ว** (`MASTER_CACHE_TTL 21600 × 1000`) และ `performance_contract.test.js:216` ล็อกพฤติกรรมนี้ไว้ — เปลี่ยนต้องแก้ test
- drift #5 (Cycle Time `|| z.pcs`), #14 (CRLF), #16 (ตัวกรองกะกับ Sheet picker) **แก้จริงแล้ว** ตามที่เอกสารระบุ
- drift #6 (Incentive) **ยังอยู่ และแย่กว่าที่เขียน**: `isEligible` (app.js:10034) คำนวณและแปะใส่ row แต่ **ไม่มีใครอ่านเลย** ทุกการ์ด/ตาราง/CSV ใช้ `reward > 0` — เป็น dead code ลบทิ้งเสี่ยงน้อยสุด

---

## ของที่เจอเพิ่ม ยังไม่อยู่ใน CLAUDE.md

1. **Zone AJ-AK ถูกจัดประเภทขัดกันเอง 4 ที่ใน V2** — `zone_master_fallback.js:20` = Full Rack, `apps-script-api.gs` ZONE_GROUPS = กลุ่ม fullRack, `listTargetZones()`/Modal = หมวด Full Rack แต่ **`PRODUCTIVITY_WEIGHT_CONFIG` (app.js:504) = HALF_RACK น้ำหนัก 30%** → ตัวเลข Overall ที่เป็นพาดหัวนับเป็น Half Rack อยู่แล้ว ขณะที่ Target/ตารางยังเป็น Full Rack
2. **น้ำหนักที่หายไปในสูตร weighted (กฎคือ "ไม่ normalize ใหม่" จึงกดค่า Overall ลงเงียบๆ)** — `BE` อยู่ใต้ FULL_RACK 50% ทั้งที่ทุกที่อื่นคือ Pick to Sort · `CD-CE` เป็น Half Rack แต่ไม่มีน้ำหนักเลย → 0 · `AA-AF` และ `AG` ไม่มีน้ำหนัก → 0 · `YA` มีน้ำหนัก 5% ใน EA แต่ไม่มีอยู่ใน zone master หรือ `ALL_VALID_ZONES` เลย
3. **`sqlStringLiteral_` (bq:450) escape แค่ single quote ไม่ escape backslash** — GoogleSQL ตีความ `\` ใน literal ปกติ ค่าที่มี backslash จึงปิด literal ก่อนกำหนดได้ ช่องที่ผู้ใช้ป้อนได้และวิ่งเข้า SQL ผ่านตัวนี้: `picker` (จำกัดแค่ยาว 80 ไม่จำกัดชุดอักขระ) และ `item`/`owner` ใน exclusion · รวมกับที่ Web App เปิด "Anyone" และ POST ไม่มี auth · แก้ด้วย `.replace(/\\/g,'\\\\')` ก่อน replace quote (วิเคราะห์จากโค้ด ไม่ได้ยิงทดสอบ endpoint จริง)
4. **`normalizeTimestamp_` (bq:1813) สลับวัน/เดือนระหว่าง branch** — `3/4/2026` = 3 เม.ย. แต่ `3/4/26` = 4 มี.ค. ถ้า WMS export ปีสองหลักวันจะเพี้ยน
5. **`chartDailyCache` (app.js:3015) ไม่ถูกล้างใน 3 เส้นทาง** — key ไม่มี roster และ `applyPlannerRosterPayload` / `saveTargetSettingsFromModal` / `applySharedTargets` เรียกแค่ `aggregateCache.clear()` → roster เปลี่ยนแล้วกราฟรายกะค้างขณะตารางอัปเดต
6. **`kpis.target`/`gap`/`status` เซ็ตเฉพาะใน branch ที่ Sheet average > 0** (app.js:3734) — ถ้า Sheet ไม่มีค่า `kpis.target` เป็น `undefined` ไม่ใช่ fallback 170 ตามที่ตาราง §3.11 ทำให้เข้าใจ
7. **`app.js` พึ่ง global scope ของ classic script** — มี 16 ชื่อถูกเรียกจาก inline `onclick=` แต่ประกาศ `window.*` ชัดเจนแค่ 5 ตัว อีก 11 ตัวรอดเพราะ top-level `function` ผูกกับ `window` เอง → **ห่อไฟล์ด้วย IIFE หรือแปลงเป็น module = ปุ่มพวกนี้ตายเงียบตอนคลิก ไม่มี error ตอนโหลด**
8. **`destroyCharts()` ไม่ครบ** — มี 6 canvas ถาวรใน HTML ที่ไม่ได้ลงทะเบียน (รอดเพราะแต่ละจุดสร้างกราฟเรียก `Chart.getChart(id).destroy()` เอง) และมี `'typepickRadar'` ค้างใน list ทั้งที่ไม่มี canvas นี้แล้ว
9. **เพดาน chunk ฝั่ง server = 8,000 แถว** (`MAX_UPLOAD_CHUNK_ROWS` bq:26) เอกสารบอกแค่ฝั่ง client 3,000 — ดันเกิน 8,000 จะได้ `CHUNK_TOO_LARGE`
10. **`refreshPickDashboardRowsFromStage_` ลบแถวใน `t_pick_dashboard` ได้** (`WHEN MATCHED AND NOT S.is_visible THEN DELETE`) — กฎ "upload ไม่เคยลบ" จริงเฉพาะกับ `pick_detail`
11. **SETUP_dashboard_live_TH.md ผิดมากกว่า 2 จุด** — บรรทัด 7 บอก dashboard อ่าน `v_pick_enriched` (จริงคือ `t_pick_dashboard`), บรรทัด 83/104 บอก IndexedDB cache 24 ชม. (จริงคือ 30 วัน), บรรทัด 121 ยังโชว์ `pick-units-v3`

---

## กฎการทำงาน / สภาพเครื่อง

- แก้ `app.js` → bump `app.js?v=` ที่ **index.html:2997** + แก้ `performance_contract.test.js:11` ให้ตรง + รัน test ทั้ง 14 ไฟล์
- ทำตามเช็กลิสต์ §10 ของ CLAUDE.md ทุกครั้ง (แต่ใช้เลขบรรทัดจากตารางด้านบนแทนของในเอกสาร)
- แก้ `.gs` → ต้อง New deployment **version** ไม่ใช่ New deployment
- **การ push**: Claude push ตรงจาก sandbox ไม่ได้ (เข้า github.com ไม่ได้ + GitHub connector ยังไม่ได้รับอนุมัติจากแอดมิน org "PTG Energy" สถานะเป็น "Not added")
  V1 ใช้วิธี **ดับเบิลคลิก `sync-to-github.bat`** ในโฟลเดอร์ ถ้า V2 ต้องใช้ให้สร้างสคริปต์แบบเดียวกัน
  ⚠️ **เขียน `.ps1` เป็น ASCII ล้วน** — Windows PowerShell 5.1 อ่านไฟล์ `.ps1` ที่มีภาษาไทยเพี้ยน จะไม่รันแต่พ่น source code ออกมาแทน (`$ตัวแปร` หายเป็นช่องว่าง) เคยเจอมาแล้ว
- เครื่อง: Windows 11 Pro, Windows PowerShell 5.1 (ไม่ใช่ PowerShell 7), Git 2.55.0 ติดตั้งแล้ว, Node 22

---

## งานค้างที่ต้องตัดสินใจ

1. ~~จะย้าย AJ-AK ไป Half Rack ใน V2 ด้วยไหม~~ ✅ **ทำแล้ว 2026-09-16** — `zone_master_fallback.js` + forced override ใน `prepareZoneMaster()` (app.js) ดู §สถานะล่าสุด
   - **ยังค้างต่อ (ย่อยจากข้อนี้)**: จะแก้ `ZONE_GROUPS` ใน `apps-script-api.gs` ให้ label AJ-AK ตรงกันด้วยไหม (ตอนนี้ยังอยู่กลุ่ม `fullRack`/key `fullRackAjAk`) — พบว่าไม่มีผลต่อ Target ที่แสดงจริง (zone override 150 ชนะอยู่แล้ว + `sheetTarget` เป็น dead field) แต่ยังไม่ตรง label 100% ถ้าจะแก้ต้อง deploy .gs เวอร์ชันใหม่ (กระทบ V1 ที่ใช้ deployment เดียวกัน) — ควรตัดสินใจพร้อมกับข้อ 5
   - **ยังค้างต่อ**: Google Sheet `Zone_V2` (ต้นทางจริงของ `DATA.meta.zone_master`) ยังไม่ได้แก้ Position ของ AJ/AK ให้เป็น Half Rack — ตอนนี้ฝั่งเว็บบังคับด้วย code override ไปก่อน ถ้าแก้ Sheet ให้ตรงแล้วค่อยลบ override ทิ้งได้
2. จะ **อัปเดต CLAUDE.md** แก้เลขบรรทัด + ข้อเท็จจริงที่คลาด + เพิ่มของที่เจอใหม่เข้า §11 + เพิ่มหัวข้อความสัมพันธ์ V1↔V2 ไหม
3. น้ำหนักที่หายไป (**CD-CE, AA-AF, AG**) และ **BE ที่อยู่ใต้ FULL_RACK** — ตั้งใจหรือพลาด ต้องให้เจ้าของ KPI ยืนยัน
4. จะแก้ **`sqlStringLiteral_`** ให้ escape backslash ไหม
5. จะให้ **ก็อปปี้ `apps-script-api.gs` ของโฟลเดอร์ไหนเป็นตัวจริง** ถาวร
6. drift #6 — จะลบ `isEligible` ที่ตายแล้ว หรือเลือกใช้เป็นนิยามเดียว
