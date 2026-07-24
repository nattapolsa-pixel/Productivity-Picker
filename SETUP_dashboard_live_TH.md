# คู่มือ: ต่อ Dashboard ให้ดึงข้อมูลสดจาก BigQuery (ตั้งครั้งเดียว)

เป้าหมาย: เปิดเว็บครั้งไหนก็เห็นข้อมูลล่าสุดทุกวันโดยอัตโนมัติ ไม่ต้องแก้ไฟล์/push อีก

**วิธีการ:** เว็บ (GitHub Pages) เป็น static ต่อ BigQuery ตรงๆ ไม่ได้ เลยใช้ **Apps Script Web App** เป็นสะพาน

- อ่าน Dashboard: เว็บ → Apps Script → `v_pick_enriched` → JSON
- นำเข้าไฟล์: เว็บตรวจไฟล์ → Apps Script ตรวจซ้ำ → BigQuery batch load → MERGE → ตรวจจำนวนแถว → เว็บรีเฟรชอัตโนมัติ

ไฟล์ที่เกี่ยวข้อง: `bigquery_to_json.gs` (โค้ด Web App) และ `app.js` (ช่อง `DATA_URL`)

---

## ขั้นที่ 1 — สร้าง Apps Script project

1. ไปที่ https://script.google.com → **New project**
2. ลบโค้ดเดิมทิ้ง แล้ววางเนื้อหาไฟล์ **`bigquery_to_json.gs`** ลงไปทั้งหมด
3. ตั้งชื่อโปรเจกต์ (เช่น "Pick Dashboard API")

> จะรวมกับ Apps Script ตัวเดิม (drive_to_gcs) หรือแยกโปรเจกต์ใหม่ก็ได้ แนะนำแยกใหม่เพื่อความชัดเจน

---

## ขั้นที่ 2 — เปิดใช้ BigQuery API ใน Apps Script

1. เมนูซ้าย ข้าง **Services** กด **+**
2. เลื่อนหา **BigQuery API** → **Add**
3. โค้ดใช้ `BigQuery.Jobs.query`, `BigQuery.Jobs.insert` และ `BigQuery.Tables` ต้องมีบริการนี้ ไม่งั้นจะ error

บัญชีที่ Deploy ต้องมีสิทธิ์สร้าง BigQuery job, สร้าง/แก้ไข/ลบ temporary table และเขียนข้อมูลใน dataset `pick_analytics`

---

## ขั้นที่ 3 — ทดสอบก่อน deploy

1. เลือกฟังก์ชัน **`testRun`** ด้านบน → กด **Run**
2. ครั้งแรกจะขออนุญาต (Authorize) → เลือกบัญชีที่เข้าถึง BigQuery `productivity-pick` ได้ → Allow
3. ดูที่ **Execution log** ควรขึ้นประมาณ:
   `rows=xxxxx  PTT dates=[...]  BPS dates=[...]`
   - ถ้าขึ้นวันที่ล่าสุด (รวม 21) = ใช้ได้ ✅
   - ถ้า error เรื่องสิทธิ์/ตาราง ให้เช็คว่า `BQ_PROJECT`/`BQ_DATASET` ในโค้ดตรงกับของจริง

---

## ขั้นที่ 4 — Deploy เป็น Web App

1. มุมขวาบน **Deploy → New deployment**
2. ไอคอนเฟือง ⚙️ ข้าง "Select type" → เลือก **Web app**
3. ตั้งค่า:
   - **Description**: pick dashboard api
   - **Execute as**: **Me** (บัญชีคุณ)
   - **Who has access**: **Anyone**  ← สำคัญ ต้องเป็น Anyone เว็บถึงจะเรียกได้
4. **Deploy** → อนุญาตสิทธิ์ถ้าถาม
5. ก็อป **Web app URL** (ลงท้ายด้วย `/exec`) เก็บไว้

> ทดสอบ URL: เอาไปเปิดในเบราว์เซอร์ ควรเห็นข้อความ JSON ยาวๆ ขึ้นต้นด้วย `{"meta":...`

---

## ขั้นที่ 5 — วาง URL ลงในเว็บ แล้ว push

1. เปิดไฟล์ **`app.js`** บรรทัดบนสุด หาบรรทัด:
   ```js
   const DATA_URL = '';
   ```
2. วาง URL ที่ก็อปมา (ในเครื่องหมายคำพูด):
   ```js
   const DATA_URL = 'https://script.google.com/macros/s/AKfycb....../exec';
   ```
3. บันทึก แล้ว push ขึ้น GitHub:
   ```powershell
   git add .
   git commit -m "ต่อ dashboard เข้ากับ BigQuery สด"
   git push
   ```
4. รอ GitHub Pages อัปเดต ~1 นาที แล้วเปิดเว็บใหม่ → จะเห็นสปินเนอร์ "กำลังโหลดข้อมูลจาก BigQuery…" แล้วขึ้นข้อมูลล่าสุด (รวมวันที่ 21) พร้อมข้อความ "ข้อมูล ณ …" และปุ่ม **↻ รีเฟรช**

---

## เสร็จแล้ว — จากนี้เป็นอัตโนมัติ

- เปิดเว็บครั้งไหน = ดึงข้อมูลล่าสุดจาก BigQuery ให้เอง
- กดปุ่ม **↻ รีเฟรช** เพื่อดึงใหม่ระหว่างเปิดอยู่
- ปุ่ม **นำเข้าไฟล์ CSV / Excel** รองรับไฟล์ Pick Detail รูปแบบเดียวกับ `Pick 20.xlsx` โดยชื่อไฟล์จะเป็นชื่ออะไรก็ได้
- ระบบตรวจหัวตาราง 11 จุดและข้อมูลทุกแถวก่อนเขียน BigQuery
- ใช้ batch load ลง `pick_stage_<request-id>` แยกต่อครั้ง จึงไม่ชน streaming buffer และไม่เหยียบไฟล์ที่อัปโหลดพร้อมกัน
- Key เดิมที่ข้อมูลเหมือนกันจะไม่นับซ้ำ; Key เดิมที่ข้อมูลเปลี่ยนจะอัปเดตทุก business field
- หลัง Merge ระบบตรวจจำนวน staged/inserted/updated/unchanged/visible แล้วจึงแจ้งว่าสำเร็จ
- ตัวกรองวันที่จะครอบคลุมทุกวันที่มีใน BigQuery (ย้อนหลังตามค่า `RECENT_DAYS` = 90 วัน ปรับได้ในไฟล์ `.gs`)

## เผื่อมีปัญหา

- **เว็บยังโชว์ 15–16 เหมือนเดิม** → `DATA_URL` ยังว่างหรือวางผิด / ยังไม่ได้ push / ล้างแคชเบราว์เซอร์ (Ctrl+F5)
- **เปิด URL แล้วเจอ error เรื่องสิทธิ์** → deployment ต้อง Execute as = Me, Who has access = Anyone
- **ไฟล์ถูกปฏิเสธก่อนนำเข้า** → อ่านชื่อคอลัมน์และเลขแถวจากข้อความ error แล้วตรวจไฟล์ต้นทาง ระบบจะไม่เขียนข้อมูลบางส่วน
- **โหลดช้า/ข้อมูลเยอะ** → ระบบรองรับไม่เกิน 50,000 แถวและ payload 12 MB ต่อครั้ง; เกินกว่านี้ให้แบ่งไฟล์
- **แก้ไฟล์ `.gs` แล้วเว็บยังใช้โค้ดเก่า** → Deploy → Manage deployments → Edit → Version: New version
- **ค่าใช้จ่าย BigQuery** → คิวรีนี้เล็กมาก (สแกนไม่กี่ MB ต่อครั้ง) ไม่ต้องกังวล
- ถ้าโหลดสดไม่ได้ เว็บจะแสดงสถานะ error และจะไม่แสดง cache หรือ `data.js` เก่า

## หมายเหตุความปลอดภัย

Web App ตั้ง "Anyone" หมายความว่าผู้ที่รู้ URL สามารถเรียกทั้ง GET และ POST ภายใต้สิทธิ์ของผู้ Deploy ได้ การใช้งานจริงควรจำกัด URL ให้อยู่เฉพาะผู้ปฏิบัติงาน หรือย้าย write endpoint ไปยังระบบที่มี authentication; ห้ามฝัง secret ถาวรไว้ใน JavaScript บน GitHub Pages
