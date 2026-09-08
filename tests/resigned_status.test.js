const assert = require('assert');

function parseSheetCsv(csvText) {
  const lines = [];
  let row = [];
  let inQuotes = false;
  let cur = '';
  for (let i = 0; i < csvText.length; i++) {
    const c = csvText[i];
    const next = csvText[i + 1];
    if (c === '"') {
      if (inQuotes && next === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      row.push(cur);
      cur = '';
    } else if ((c === '\r' || c === '\n') && !inQuotes) {
      if (c === '\r' && next === '\n') i++;
      row.push(cur);
      cur = '';
      if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
        lines.push(row);
      }
      row = [];
    } else {
      cur += c;
    }
  }
  if (cur || row.length) {
    row.push(cur);
    lines.push(row);
  }
  return lines;
}

function normalizePersonName(name) {
  return String(name || '')
    .replace(/^(นาย|นางสาว|นาง|น\.ส\.|ด\.ช\.|ด\.ญ\.|mr\.|ms\.|mrs\.)\s*/i, '')
    .replace(/[\s\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .toLowerCase();
}

function buildResignedMaps(rows) {
  const idMap = new Map();
  const numIdMap = new Map();
  const nameMap = new Map();
  const list = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rawId = String(r[0] || '').trim();
    const rawName = String(r[1] || '').trim();
    const nickname = String(r[2] || '').trim();
    const affiliation = String(r[3] || '').trim();
    const role = String(r[4] || '').trim();
    const zone = String(r[5] || '').trim();
    const team = String(r[6] || '').trim();
    const dischargeDate = String(r[7] || '').trim();

    if (!rawId && !rawName) continue;

    const info = {
      id: rawId,
      name: rawName,
      nickname,
      affiliation,
      role,
      zone,
      team,
      date: dischargeDate
    };
    list.push(info);

    if (rawId) {
      const upId = rawId.toUpperCase();
      idMap.set(upId, info);
      const numOnly = upId.replace(/^0+/, '');
      if (numOnly) numIdMap.set(numOnly, info);
    }
    const normName = normalizePersonName(rawName);
    if (normName) {
      nameMap.set(normName, info);
    }
  }

  return { idMap, numIdMap, nameMap, list };
}

function getPickerResignedInfo(pickerId, pickerName, maps) {
  if (!maps) return null;
  const pId = String(pickerId || '').trim().toUpperCase();
  if (pId) {
    if (maps.idMap.has(pId)) return maps.idMap.get(pId);
    const numOnly = pId.replace(/^0+/, '');
    if (numOnly && maps.numIdMap.has(numOnly)) return maps.numIdMap.get(numOnly);
  }
  const normName = normalizePersonName(pickerName);
  if (normName && maps.nameMap.has(normName)) {
    return maps.nameMap.get(normName);
  }
  return null;
}

// ================= TEST SUITE =================

// 1. CSV Parsing test
const csv = `"รหัสพนักงาน","ชื่อ-นามสกุล (ไทย)","ชื่อเล่น","สังกัด","หน้าที่รับผิดชอบ","โซน","Team","พ้นสภาพ",""
"25067","นางสาวสุธิดา ธูปสะอาด","นุ่น","40HRS","Picker","","A","1/2/2026",""
"MPPTG0546","สุพัตร์ทรา สาระบัว","","Man Power","Picker","","C","8/17/2026",""
"025124","น.ส.สุชาดา ลิ้มเจริญ","","40HRS","Picker","","B","8/17/2026",""`;

const parsedRows = parseSheetCsv(csv);
assert.strictEqual(parsedRows.length, 4, 'Should parse 4 rows (1 header + 3 data)');
assert.strictEqual(parsedRows[0][0], 'รหัสพนักงาน');
assert.strictEqual(parsedRows[1][7], '1/2/2026');

// 2. Map building & resolution
const maps = buildResignedMaps(parsedRows);
assert.strictEqual(maps.list.length, 3);

// Test exact ID match
const r1 = getPickerResignedInfo('25067', '', maps);
assert(r1, 'Should find 25067');
assert.strictEqual(r1.date, '1/2/2026');
assert.strictEqual(r1.role, 'Picker');
assert.strictEqual(r1.affiliation, '40HRS');

// Test alphanumeric MPPTG ID
const r2 = getPickerResignedInfo('MPPTG0546', '', maps);
assert(r2, 'Should find MPPTG0546');
assert.strictEqual(r2.date, '8/17/2026');

// Test stripped leading zero ID (search 25124 when sheet has 025124)
const r3 = getPickerResignedInfo('25124', '', maps);
assert(r3, 'Should find 25124 even if sheet has 025124');
assert.strictEqual(r3.date, '8/17/2026');

// Test normalized name matching
const r4 = getPickerResignedInfo('', 'สุธิดา ธูปสะอาด', maps);
assert(r4, 'Should find by normalized name without prefix');
assert.strictEqual(r4.id, '25067');

const r5 = getPickerResignedInfo('', 'นางสาวสุชาดา ลิ้มเจริญ', maps);
assert(r5, 'Should find by normalized name with น.ส. vs นางสาว');
assert.strictEqual(r5.id, '025124');

// Non-existent picker
const rNone = getPickerResignedInfo('UNKNOWN999', 'สมศรี ทดสอบ', maps);
assert.strictEqual(rNone, null, 'Should return null for non-resigned picker');

// 3. Pick Volume Retention Guarantee Test
const mockPickers = [
  { picker: '25067', name: 'สุธิดา ธูปสะอาด', qty: 1500, pcs: 1800, ot: 2.0, avg_prod: 180 },
  { picker: 'MPPTG0546', name: 'สุพัตร์ทรา สาระบัว', qty: 850, pcs: 920, ot: 0, avg_prod: 140 },
  { picker: '99999', name: 'พนักงาน ยังอยู่', qty: 2200, pcs: 2500, ot: 1.5, avg_prod: 210 }
];

mockPickers.forEach(p => {
  p.resignedInfo = getPickerResignedInfo(p.picker, p.name, maps);
  p.isResigned = Boolean(p.resignedInfo);
});

// Resigned status must NOT alter or drop volume
assert.strictEqual(mockPickers[0].isResigned, true);
assert.strictEqual(mockPickers[0].qty, 1500, 'Pick volume MUST remain intact');
assert.strictEqual(mockPickers[0].pcs, 1800, 'Pcs MUST remain intact');
assert.strictEqual(mockPickers[0].ot, 2.0, 'OT MUST remain intact');
assert.strictEqual(mockPickers[0].avg_prod, 180, 'Productivity MUST remain intact');

assert.strictEqual(mockPickers[1].isResigned, true);
assert.strictEqual(mockPickers[2].isResigned, false);

// Filter count
const resignedList = mockPickers.filter(p => p.isResigned);
assert.strictEqual(resignedList.length, 2, 'Should find exactly 2 resigned pickers');

console.log('All Resigned status unit tests passed successfully!');
