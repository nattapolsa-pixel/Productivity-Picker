const SPREADSHEET_ID = "1PMnlyYHswnV0nE73Alxh-ocIFtTipB9LMzACdNM9GFs";
const RESULTS_SHEET_NAME = "Results Master";
const UPDATE_NAME_SHEET_NAME = "2ND";
const FALLBACK_UPDATE_NAME_SHEET_NAME = "Update name";

const CACHE_SECONDS = 300;
const CACHE_VERSION = "v49-sheet-2nd-roster";
const PICK_TO_SORT_START_DATE_KEY = "2026-06-08";

const SHEET_COLUMN = {
  DATE: 3,        // C
  USER_ID: 4,     // D
  NAME: 2,        // B = Name
  TOTAL_PICK: 5,  // E = Total Pick (fallback ถ้าหา Header ไม่เจอ)
  AVERAGE_AF: 32, // AF
  SHIFT: 33,      // AG
  POSITION: 34,   // AH
  AFFILIATION: 35, // AI
  BU: 36,         // AJ
  PICK_TYPE: 37,  // AK
};

const UPDATE_NAME_COLUMN = {
  USER_ID: 2,       // B
  START_DATE: 7,    // G = วันที่เริ่มทำงาน (ชีต 2ND)
  END_DATE: 9,      // I = วันที่จบ Training / สถานะ Training (ชีต 2ND)
};

const TARGETS = {
  overall: 170,
  fullRack: 170,
  halfRack: 200,
  ea: 170,
  pickToSort: 170,
  mezzanine: 170,
  training: 100,
};

const PICK_TYPE_DETAILS = [
  {
    key: "fullRack",
    title: "Picking Productivity - Full Rack (หยิบ)",
    label: "Full Rack",
    target: TARGETS.fullRack,
  },
  {
    key: "halfRack",
    title: "Picking Productivity - Half Rack (หยิบ)",
    label: "Half Rack",
    target: TARGETS.halfRack,
  },
  {
    key: "ea",
    title: "Picking Productivity - Micro Rack (หยิบ)",
    label: "Micro Rack",
    target: TARGETS.ea,
  },
  {
    key: "pickToSort",
    title: "Picking Productivity - Pick to Sort",
    label: "Pick to Sort",
    target: TARGETS.pickToSort,
  },
  {
    key: "mezzanine",
    title: "Picking Productivity - Mezzanine",
    label: "Mezzanine",
    target: TARGETS.mezzanine,
  },
];
const ZONE_GROUPS = [
  {
    key: "fullRack",
    title: "Picking Productivity - Full Rack (หยิบ)",
    target: TARGETS.fullRack,
    zones: [
      { key: "fullRackAaAf", title: "Picking Productivity - Zone AA-AF", label: "AA-AF", codes: ["AA", "AB", "AC", "AD", "AE", "AF"] },
      { key: "fullRackAg", title: "Picking Productivity - Zone AG", label: "AG", codes: ["AG"] },
      { key: "fullRackAhAi", title: "Picking Productivity - Zone AH-AI", label: "AH-AI", codes: ["AH", "AI"] },
      { key: "fullRackAjAk", title: "Picking Productivity - Zone AJ-AK", label: "AJ-AK", codes: ["AJ", "AK"] },
      { key: "fullRackAlBlBmAm", title: "Picking Productivity - Zone AL-BL-BM-AM", label: "AL-BL-BM-AM", codes: ["AL", "BL", "BM", "AM"] },
    ],
  },
  {
    key: "halfRack",
    title: "Picking Productivity - Half Rack (หยิบ)",
    target: TARGETS.halfRack,
    zones: [
      { key: "halfRackAnCa", title: "Picking Productivity - Zone AN-CA", label: "AN-CA", codes: ["AN", "CA"] },
      { key: "halfRackBnDa", title: "Picking Productivity - Zone BN-DA", label: "BN-DA", codes: ["BN", "DA"] },
      { key: "halfRackBgBh", title: "Picking Productivity - Zone BG-BH", label: "BG-BH", codes: ["BG", "BH"] },
      { key: "halfRackBiBk", title: "Picking Productivity - Zone BI-BK", label: "BI-BK", codes: ["BI", "BJ", "BK"] },
      { key: "halfRackCbDbDcCc", title: "Picking Productivity - Zone CB-DB-DC-CC", label: "CB-DB-DC-CC", codes: ["CB", "DB", "DC", "CC"] },
      { key: "halfRackCdCe", title: "Picking Productivity - Zone CD-CE", label: "CD-CE", codes: ["CD", "CE"] },
      { key: "halfRackDdDe", title: "Picking Productivity - Zone DD-DE", label: "DD-DE", codes: ["DD", "DE"] },
      { key: "halfRackCfDf", title: "Picking Productivity - Zone CF-DF", label: "CF-DF", codes: ["CF", "DF"] },
    ],
  },
  {
    key: "ea",
    title: "Picking Productivity - Micro Rack (หยิบ)",
    target: TARGETS.ea,
    zones: [
      { key: "microEa", title: "Picking Productivity - Zone EA", label: "EA", codes: ["EA"] },
      { key: "microFa", title: "Picking Productivity - Zone FA", label: "FA", codes: ["FA"] },
    ],
  },
  {
    key: "pickToSort",
    title: "Picking Productivity - Pick to Sort",
    target: TARGETS.pickToSort,
    zones: [
      { key: "pickToSortBe", title: "Picking Productivity - Zone BE", label: "BE", codes: ["BE"] },
    ],
  },
  {
    key: "mezzanine",
    title: "Picking Productivity - Mezzanine",
    target: TARGETS.overall,
    zones: [
      { key: "mezzanineHb", title: "Picking Productivity - Zone HB", label: "HB", codes: ["HB"] },
    ],
  },
];

const BU_GROUPS = [
  {
    key: "punthai",
    title: "BU - Punthai",
    label: "Punthai",
    match: ["punthai", "pun thai"],
    focus: true,
    pickMix: {
      fullRack: 51,
      halfRack: 49,
      ea: 0,
    },
  },
  {
    key: "mart",
    title: "BU - Mart",
    label: "Mart",
    match: ["mart"],
    focus: true,
    pickMix: {
      fullRack: 40,
      halfRack: 50,
      ea: 10,
    },
  },
  {
    key: "other",
    title: "Other BU",
    label: "Other BU",
    match: [],
    focus: false,
  },
];
var rosterResolutionCache = {};
var zoneMatchCache = {};

function doGet(e) {
  rosterResolutionCache = {};
  zoneMatchCache = {};
  const params = e && e.parameter ? e.parameter : {};

  try {
    const payload = getDashboardFast_(params);
    return jsonOutput_(payload, params.callback);
  } catch (error) {
    return jsonOutput_({
      ok: false,
      error: error.message || String(error),
    }, params.callback);
  }
}

function getDashboardFast_(params) {
  const mode = String(params.mode || "").toLowerCase();

  // โหมดนี้ใช้สร้างดัชนีรายวันแบบย่อ โหลดครั้งเดียวแล้วให้หน้าเว็บ Filter ในเครื่องทันที
  if (mode === "dailyindex") {
    return getDailyIndexFast_(params);
  }

  const startDate = params.startDate || params.startDateDMY || "";
  const endDate = params.endDate || params.endDateDMY || "";
  const forceRefresh = isTrue_(params.refresh) || isTrue_(params.force);
  const cacheKey = getCacheKey_(startDate, endDate);
  const cache = CacheService.getScriptCache();

  if (!forceRefresh) {
    const memoryCached = cache.get(cacheKey);

    if (memoryCached) {
      const payload = JSON.parse(memoryCached);

      if (isUsableDashboardPayload_(payload)) {
        payload.cacheStatus = "memory-cache";
        payload.cacheAgeSeconds = getCacheAgeSeconds_(payload.generatedAt);
        return payload;
      }
    }
  }

  const lock = LockService.getScriptLock();
  let hasLock = false;

  try {
    hasLock = lock.tryLock(1200);
  } catch (lockError) {
    hasLock = false;
  }

  try {
    // ถ้าระหว่างรอ lock มี request อื่นสร้าง cache เสร็จแล้ว ให้ใช้ cache ทันที
    if (!forceRefresh) {
      const cachedAfterLock = cache.get(cacheKey);

      if (cachedAfterLock) {
        const payload = JSON.parse(cachedAfterLock);

        if (isUsableDashboardPayload_(payload)) {
          payload.cacheStatus = "memory-cache";
          payload.cacheAgeSeconds = getCacheAgeSeconds_(payload.generatedAt);
          return payload;
        }
      }
    }

    const payload = buildDashboardPayload_(startDate, endDate);
    saveDashboardPayload_(cacheKey, payload);
    return payload;
  } finally {
    if (hasLock) {
      lock.releaseLock();
    }
  }
}

function getDailyIndexFast_(params) {
  const forceRefresh = isTrue_(params.refresh) || isTrue_(params.force);
  const cacheKey = `pick_dashboard_daily_index_${CACHE_VERSION}`;
  const cache = CacheService.getScriptCache();

  if (!forceRefresh) {
    const memoryCached = cache.get(cacheKey);

    if (memoryCached) {
      const payload = JSON.parse(memoryCached);
      payload.cacheStatus = "memory-cache";
      payload.cacheAgeSeconds = getCacheAgeSeconds_(payload.generatedAt);
      return payload;
    }

  }

  const lock = LockService.getScriptLock();
  const hasLock = lock.tryLock(1500);

  if (!hasLock) {
    const cachedWhileLocked = cache.get(cacheKey);

    if (cachedWhileLocked) {
      const payload = JSON.parse(cachedWhileLocked);
      payload.cacheStatus = "memory-cache";
      payload.cacheAgeSeconds = getCacheAgeSeconds_(payload.generatedAt);
      return payload;
    }
  }

  try {
    const payload = buildDailyIndexPayload_();
    saveDailyIndexPayload_(cacheKey, payload);
    return payload;
  } finally {
    if (hasLock) {
      lock.releaseLock();
    }
  }
}


function findHeaderColumn_(sheet, matchers, fallbackColumn) {
  try {
    const lastColumn = Math.max(sheet.getLastColumn(), SHEET_COLUMN.PICK_TYPE);
    const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] || [];

    for (let index = 0; index < headers.length; index += 1) {
      const header = String(headers[index] || "")
        .toLowerCase()
        .replace(/[\s_\-()]+/g, "")
        .trim();

      if (!header) {
        continue;
      }

      const matched = matchers.some((matcher) => {
        const normalizedMatcher = String(matcher || "")
          .toLowerCase()
          .replace(/[\s_\-()]+/g, "")
          .trim();
        return normalizedMatcher && header.includes(normalizedMatcher);
      });

      if (matched) {
        return index + 1;
      }
    }
  } catch (error) {
    console.warn("findHeaderColumn_ failed", error);
  }

  return fallbackColumn;
}

function getTotalPickColumn_(sheet) {
  return findHeaderColumn_(
    sheet,
    [
      "total pick",
      "totalpick",
      "actual pick",
      "actualpick",
      "pick qty",
      "pickqty",
      "จำนวน pick",
      "จำนวนหยิบ",
      "ยอด pick",
      "ยอดหยิบ",
      "รวม pick",
      "รวมหยิบ",
    ],
    SHEET_COLUMN.TOTAL_PICK
  );
}

function getTotalPickValue_(rawValue, displayValue) {
  const rawNumber = toNumber_(rawValue);

  if (rawNumber !== 0) {
    return rawNumber;
  }

  return toNumber_(displayValue);
}

function getMonthKey_(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return "";
  }

  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}`;
}

function addMonthlyTrendValue_(monthlyTrend, rowDate, average, totalPick) {
  const dateKey = formatDateISO_(rowDate);

  if (!dateKey) {
    return;
  }

  if (!monthlyTrend[dateKey]) {
    monthlyTrend[dateKey] = {
      sum: 0,
      count: 0,
      totalPick: 0,
    };
  }

  monthlyTrend[dateKey].sum += Number(average || 0);
  monthlyTrend[dateKey].count += 1;
  monthlyTrend[dateKey].totalPick += Number(totalPick || 0);
}

function hasMonthlyTrendData_(monthlyTrend, anchorDate) {
  const monthKey = getMonthKey_(anchorDate);

  if (!monthKey) {
    return false;
  }

  return Object.keys(monthlyTrend || {}).some(function (dateKey) {
    return dateKey.indexOf(monthKey + "-") === 0 && Number(monthlyTrend[dateKey].count || 0) > 0;
  });
}

function chooseMonthlyTrendAnchor_(monthlyTrend, selectedDate, startDate, endDate, latestDate) {
  const requestedDate = selectedDate || startDate || endDate;

  if (requestedDate && hasMonthlyTrendData_(monthlyTrend, requestedDate)) {
    return requestedDate;
  }

  if (latestDate) {
    return latestDate;
  }

  return requestedDate || new Date();
}

function getThaiMonthLabel_(date) {
  const months = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  return `${months[date.getMonth()]} ${date.getFullYear()}`;
}

function finalizeMonthlyTrend_(monthlyTrend, anchorDate) {
  let targetDate = anchorDate;

  if (!(targetDate instanceof Date) || isNaN(targetDate.getTime())) {
    const dateKeys = Object.keys(monthlyTrend || {})
      .filter(function (dateKey) { return Number(monthlyTrend[dateKey].count || 0) > 0; })
      .sort();
    targetDate = dateKeys.length > 0 ? parseInputDate_(dateKeys[dateKeys.length - 1]) : new Date();
  }

  const startDate = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
  const endDate = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0);
  const daysInMonth = endDate.getDate();
  const days = [];
  let previousAverage = null;
  let totalSum = 0;
  let totalCount = 0;
  let totalPick = 0;
  let activeDays = 0;
  let peakDay = null;
  let lowDay = null;

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(targetDate.getFullYear(), targetDate.getMonth(), day);
    const dateKey = formatDateISO_(date);
    const bucket = monthlyTrend && monthlyTrend[dateKey] ? monthlyTrend[dateKey] : {};
    const count = Number(bucket.count || 0);
    const hasData = count > 0;
    const rawAverage = hasData ? Number(bucket.sum || 0) / count : 0;
    const average = hasData ? round1_(rawAverage) : null;
    let change = null;
    let trend = "none";

    if (hasData) {
      activeDays += 1;
      totalSum += Number(bucket.sum || 0);
      totalCount += count;
      totalPick += Number(bucket.totalPick || 0);

      if (previousAverage !== null) {
        change = round1_(rawAverage - previousAverage);
        trend = change > 0 ? "up" : change < 0 ? "down" : "flat";
      }

      previousAverage = rawAverage;

      if (!peakDay || rawAverage > peakDay.rawAverage) {
        peakDay = {
          date: dateKey,
          dateLabel: formatDateDMY_(date),
          productivity: average,
          rawAverage: rawAverage,
        };
      }

      if (!lowDay || rawAverage < lowDay.rawAverage) {
        lowDay = {
          date: dateKey,
          dateLabel: formatDateDMY_(date),
          productivity: average,
          rawAverage: rawAverage,
        };
      }
    }

    days.push({
      date: dateKey,
      dateLabel: formatDateDMY_(date),
      day: day,
      productivity: average,
      count: count,
      totalPick: Math.round(Number(bucket.totalPick || 0)),
      hasData: hasData,
      change: change,
      trend: trend,
    });
  }

  if (peakDay) delete peakDay.rawAverage;
  if (lowDay) delete lowDay.rawAverage;

  return {
    month: getMonthKey_(startDate),
    monthLabel: getThaiMonthLabel_(startDate),
    startDate: formatDateDMY_(startDate),
    endDate: formatDateDMY_(endDate),
    metricLabel: "Avg Pick/Hr",
    sourceColumn: "Results Master!C / AF",
    average: totalCount > 0 ? round1_(totalSum / totalCount) : null,
    activeDays: activeDays,
    totalPick: Math.round(totalPick),
    peakDay: peakDay,
    lowDay: lowDay,
    days: days,
  };
}

function buildDailyIndexPayload_() {
  const startedAt = Date.now();
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(RESULTS_SHEET_NAME);

  if (!sheet) {
    throw new Error(`ไม่พบ Sheet: ${RESULTS_SHEET_NAME}`);
  }

  const trainingRoster = createTrainingRoster_(ss);
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return {
      ok: true,
      mode: "dailyIndex",
      generatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      cacheStatus: "fresh",
      cacheVersion: CACHE_VERSION,
      trainingUserCount: Object.keys(trainingRoster || {}).length,
      trainingRoster: serializeTrainingRoster_(trainingRoster),
      trainingDebug: createTrainingDebugPayload_(trainingRoster, {}, []),
      dateKeys: [],
      dates: {},
      totalRows: 0,
      invalidDateRows: 0,
      emptyDateRows: 0,
    };
  }

  const numRows = lastRow - 1;
  const dataColumnCount = SHEET_COLUMN.PICK_TYPE - SHEET_COLUMN.DATE + 1;
  const dataRange = sheet.getRange(2, SHEET_COLUMN.DATE, numRows, dataColumnCount);
  const dataValues = dataRange.getValues();
  // Name อยู่ Column B ซึ่งอยู่นอกช่วง C:AK จึงอ่านแยก เพื่อให้ Picker แสดงชื่อจริงชัดเจน
  const nameValues = sheet.getRange(2, SHEET_COLUMN.NAME, numRows, 1).getValues();
  const columnOffset = {
    date: SHEET_COLUMN.DATE - SHEET_COLUMN.DATE,
    userId: SHEET_COLUMN.USER_ID - SHEET_COLUMN.DATE,
    totalPick: getTotalPickColumn_(sheet) - SHEET_COLUMN.DATE,
    average: SHEET_COLUMN.AVERAGE_AF - SHEET_COLUMN.DATE,
    shift: SHEET_COLUMN.SHIFT - SHEET_COLUMN.DATE,
    position: SHEET_COLUMN.POSITION - SHEET_COLUMN.DATE,
    affiliation: SHEET_COLUMN.AFFILIATION - SHEET_COLUMN.DATE,
    bu: SHEET_COLUMN.BU - SHEET_COLUMN.DATE,
    pickType: SHEET_COLUMN.PICK_TYPE - SHEET_COLUMN.DATE,
  };

  const dates = {};
  let emptyDateRows = 0;
  let invalidDateRows = 0;

  for (let index = 0; index < numRows; index += 1) {
    const rawDateValue = dataValues[index][columnOffset.date];
    const rowDate = normalizeSheetDate_(rawDateValue, rawDateValue);

    if (!rowDate) {
      const sampleText = String(rawDateValue || "").trim();

      if (sampleText) {
        invalidDateRows += 1;
      } else {
        emptyDateRows += 1;
      }

      continue;
    }

    const dateKey = formatDateISO_(rowDate);

    if (!dates[dateKey]) {
      dates[dateKey] = createDailyRawSummary_();
    }

    const day = dates[dateKey];
    const rawTotalPick = dataValues[index][columnOffset.totalPick];
    const rowTotalPick = getTotalPickValue_(rawTotalPick, rawTotalPick);
    day.filteredRows += 1;
    day.totalPick += rowTotalPick;

    const average = toNumber_(dataValues[index][columnOffset.average]);

    if (average <= 0) {
      day.excludedCount += 1;
      continue;
    }

    const rawUserId = dataValues[index][columnOffset.userId];
    const rawName = nameValues[index] ? nameValues[index][0] : "";

    addTrainingValue_(
      day.training,
      trainingRoster,
      rawUserId,
      rawName,
      rowDate,
      average
    );

    const pickerPickType = normalizePickType_(dataValues[index][columnOffset.pickType]);
    const pickerBuKey = normalizeBu_(dataValues[index][columnOffset.bu]);
    addPickerValue_(
      day.pickers,
      rawUserId,
      nameValues[index][0],
      average,
      {
        shift: dataValues[index][columnOffset.shift],
        affiliation: dataValues[index][columnOffset.affiliation],
        buKey: pickerBuKey,
        pickType: pickerPickType,
        zone: dataValues[index][columnOffset.position],
        totalPick: rowTotalPick,
      }
    );
    addValue_(day.overall, average);

    const pickType = normalizePickType_(dataValues[index][columnOffset.pickType]);
    const shouldCountPickType = shouldCountPickTypeOnDate_(pickType, rowDate);

    if (pickType && shouldCountPickType && day.categories[pickType]) {
      addValue_(day.categories[pickType], average);
    }

    if (pickType === "pickToSort" && shouldCountPickType) {
      addPickToSortValue_(
        day.pickToSortDetails,
        rawUserId,
        nameValues[index][0],
        average,
        {
          shift: dataValues[index][columnOffset.shift],
          affiliation: dataValues[index][columnOffset.affiliation],
          bu: dataValues[index][columnOffset.bu],
          zone: dataValues[index][columnOffset.position],
          totalPick: rowTotalPick,
        }
      );
    }

    const zoneMatch = findZoneMatch_(dataValues[index][columnOffset.position]);

    if (zoneMatch && day.zones[zoneMatch.groupKey] && day.zones[zoneMatch.groupKey][zoneMatch.zoneKey]) {
      addValue_(day.zones[zoneMatch.groupKey][zoneMatch.zoneKey], average);
    }

    addShiftValue_(day.shifts, dataValues[index][columnOffset.shift], dataValues[index][columnOffset.affiliation], average);

    const buKey = normalizeBu_(dataValues[index][columnOffset.bu]);
    addValue_(day.bu[buKey], average);

    if (pickType && shouldCountPickType && day.bu[buKey].details && day.bu[buKey].details[pickType]) {
      addValue_(day.bu[buKey].details[pickType], average);
    }
  }

  const dateKeys = Object.keys(dates).sort();
  const trainingDebugSummary = createTrainingSummary_();
  seedTrainingSummary_(trainingDebugSummary, trainingRoster);

  dateKeys.forEach((dateKey) => {
    const dayTraining = dates[dateKey] && dates[dateKey].training || {};

    Object.keys(dayTraining).forEach((userId) => {
      if (!trainingDebugSummary[userId]) {
        trainingDebugSummary[userId] = {
          userId: userId,
          name: dayTraining[userId].name || `User ID ${userId}`,
          startDate: dayTraining[userId].startDate || null,
          endDate: dayTraining[userId].endDate || null,
          startDateCandidates: dayTraining[userId].startDateCandidates || [],
          endDateCandidates: dayTraining[userId].endDateCandidates || [],
          daily: {},
          matchedFrom: {},
        };
      }

      Object.keys(dayTraining[userId].daily || {}).forEach((dailyKey) => {
        if (!trainingDebugSummary[userId].daily[dailyKey]) {
          trainingDebugSummary[userId].daily[dailyKey] = createBucket_();
        }

        mergeBucket_(trainingDebugSummary[userId].daily[dailyKey], dayTraining[userId].daily[dailyKey]);
      });

      Object.keys(dayTraining[userId].matchedFrom || {}).forEach((sourceUserId) => {
        trainingDebugSummary[userId].matchedFrom[sourceUserId] = true;
      });
    });
  });

  return {
    ok: true,
    mode: "dailyIndex",
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    cacheStatus: "fresh",
    cacheVersion: CACHE_VERSION,
    sourceColumn: "C",
    sourceFormat: "DD/MM/YYYY",
    trainingSource: "2ND!B/G/I + Training row",
    trainingUserCount: Object.keys(trainingRoster || {}).length,
    trainingRoster: serializeTrainingRoster_(trainingRoster),
    trainingDebug: createTrainingDebugPayload_(trainingRoster, trainingDebugSummary, []),
    dateKeys: dateKeys,
    dates: dates,
    totalPick: dateKeys.reduce((sum, dateKey) => sum + (dates[dateKey].totalPick || 0), 0),
    totalRows: dateKeys.reduce((sum, dateKey) => sum + (dates[dateKey].filteredRows || 0), 0),
    invalidDateRows: invalidDateRows,
    emptyDateRows: emptyDateRows,
  };
}

function createDailyRawSummary_() {
  return {
    filteredRows: 0,
    excludedCount: 0,
    totalPick: 0,
    overall: createBucket_(),
    categories: {
      fullRack: createBucket_(),
      halfRack: createBucket_(),
      ea: createBucket_(),
      pickToSort: createBucket_(),
      mezzanine: createBucket_(),
    },
    zones: createZoneSummary_(),
    bu: createBuSummary_(),
    shifts: createShiftSummary_(),
    pickers: createPickerSummary_(),
    pickToSortDetails: createPickToSortSummary_(),
    training: createTrainingSummary_(),
  };
}

function formatDateISO_(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return "";
  }

  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function shouldCountPickTypeOnDate_(pickType, rowDate) {
  if (pickType !== "pickToSort") {
    return true;
  }

  return Boolean(rowDate && formatDateISO_(rowDate) >= PICK_TO_SORT_START_DATE_KEY);
}

function createPickToSortSummary_() {
  return {
    overall: createBucket_(),
    totalPick: 0,
    shifts: createShiftSummary_(),
    bu: createBuSummary_(),
    pickers: createPickerSummary_(),
  };
}

function addPickToSortValue_(summary, userIdValue, nameValue, average, meta) {
  if (!summary) {
    return;
  }

  const buKey = normalizeBu_(meta && meta.bu);
  const totalPick = Number(meta && meta.totalPick || 0);
  addValue_(summary.overall, average);
  summary.totalPick += totalPick;
  addShiftValue_(summary.shifts, meta && meta.shift, meta && meta.affiliation, average);
  addValue_(summary.bu[buKey], average);
  addPickerValue_(summary.pickers, userIdValue, nameValue, average, {
    shift: meta && meta.shift,
    affiliation: meta && meta.affiliation,
    buKey: buKey,
    pickType: "pickToSort",
    zone: meta && meta.zone,
    totalPick: meta && meta.totalPick,
  });
}

function buildDashboardPayload_(startDateText, endDateText) {
  const startedAt = Date.now();
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(RESULTS_SHEET_NAME);

  if (!sheet) {
    throw new Error(`ไม่พบ Sheet: ${RESULTS_SHEET_NAME}`);
  }

  const trainingRoster = createTrainingRoster_(ss);
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return emptyPayload_(startedAt, startDateText, endDateText);
  }

  const numRows = lastRow - 1;
  const startDate = startDateText ? parseInputDate_(startDateText) : null;
  const endDate = endDateText ? parseInputDate_(endDateText) : null;

  if (endDate) {
    endDate.setHours(23, 59, 59, 999);
  }

  // อ่านช่วง C:AK ครั้งเดียว เพื่อลดเวลารอ Google Sheet ตอน Filter
  // C = วันที่, AF = Average Pick/Hr, AG = Shift, AH = Zone, AI = สังกัด, AJ = BU, AK = Pick Type
  const dataColumnCount = SHEET_COLUMN.PICK_TYPE - SHEET_COLUMN.DATE + 1;
  const dataRange = sheet.getRange(2, SHEET_COLUMN.DATE, numRows, dataColumnCount);
  const dataValues = dataRange.getValues();
  // Name อยู่ Column B ซึ่งอยู่นอกช่วง C:AK จึงอ่านแยก เพื่อให้ Picker แสดงชื่อจริงชัดเจน
  const nameValues = sheet.getRange(2, SHEET_COLUMN.NAME, numRows, 1).getValues();
  const shouldFilterByDate = Boolean(startDate || endDate);
  const columnOffset = {
    date: SHEET_COLUMN.DATE - SHEET_COLUMN.DATE,
    userId: SHEET_COLUMN.USER_ID - SHEET_COLUMN.DATE,
    totalPick: getTotalPickColumn_(sheet) - SHEET_COLUMN.DATE,
    average: SHEET_COLUMN.AVERAGE_AF - SHEET_COLUMN.DATE,
    shift: SHEET_COLUMN.SHIFT - SHEET_COLUMN.DATE,
    position: SHEET_COLUMN.POSITION - SHEET_COLUMN.DATE,
    affiliation: SHEET_COLUMN.AFFILIATION - SHEET_COLUMN.DATE,
    bu: SHEET_COLUMN.BU - SHEET_COLUMN.DATE,
    pickType: SHEET_COLUMN.PICK_TYPE - SHEET_COLUMN.DATE,
  };

  const summary = {
    overall: createBucket_(),
    fullRack: createBucket_(),
    halfRack: createBucket_(),
    ea: createBucket_(),
    pickToSort: createBucket_(),
    mezzanine: createBucket_(),
  };
  const zoneSummary = createZoneSummary_();
  const buSummary = createBuSummary_();
  const shiftSummary = createShiftSummary_();
  const pickerSummary = createPickerSummary_();
  const pickToSortDetails = createPickToSortSummary_();
  const trainingSummary = createTrainingSummary_();
  const monthlyTrend = {};
  seedTrainingSummary_(trainingSummary, trainingRoster);

  let filteredRows = 0;
  let excludedCount = 0;
  let totalPick = 0;
  let totalPickStartDate = null;
  let totalPickEndDate = null;
  let latestMonthlyTrendDate = null;
  let selectedMonthlyTrendDate = null;
  const filterDiagnostics = {
    enabled: shouldFilterByDate,
    sourceColumn: "C",
    sourceFormat: "DD/MM/YYYY",
    inputStartDate: startDateText || "",
    inputEndDate: endDateText || "",
    emptyDateRows: 0,
    invalidDateRows: 0,
    beforeStartRows: 0,
    afterEndRows: 0,
    matchedDateRows: 0,
    firstMatchedDate: "",
    lastMatchedDate: "",
    firstInvalidSamples: [],
  };

  for (let index = 0; index < numRows; index += 1) {
    const rawDateValueForTraining = dataValues[index][columnOffset.date];
    const rowDateForTraining = normalizeSheetDate_(rawDateValueForTraining, rawDateValueForTraining);
    const average = toNumber_(dataValues[index][columnOffset.average]);
    const rawTotalPick = dataValues[index][columnOffset.totalPick];
    const rowTotalPick = getTotalPickValue_(rawTotalPick, rawTotalPick);

    const rawUserId = dataValues[index][columnOffset.userId];

    if (average > 0) {
      addTrainingValue_(
        trainingSummary,
        trainingRoster,
        rawUserId,
        nameValues[index] ? nameValues[index][0] : "",
        rowDateForTraining,
        average
      );

      if (rowDateForTraining) {
        addMonthlyTrendValue_(monthlyTrend, rowDateForTraining, average, rowTotalPick);
        if (!latestMonthlyTrendDate || rowDateForTraining > latestMonthlyTrendDate) {
          latestMonthlyTrendDate = rowDateForTraining;
        }
      }
    }

    if (shouldFilterByDate) {
      const rawDateValue = rawDateValueForTraining;
      const rowDate = rowDateForTraining;

      if (!rowDate) {
        const sampleText = String(rawDateValue || "").trim();

        if (sampleText) {
          filterDiagnostics.invalidDateRows += 1;

          if (filterDiagnostics.firstInvalidSamples.length < 5) {
            filterDiagnostics.firstInvalidSamples.push(sampleText);
          }
        } else {
          filterDiagnostics.emptyDateRows += 1;
        }

        continue;
      }

      if (startDate && rowDate < startDate) {
        filterDiagnostics.beforeStartRows += 1;
        continue;
      }

      if (endDate && rowDate > endDate) {
        filterDiagnostics.afterEndRows += 1;
        continue;
      }

      const matchedText = formatDateDMY_(rowDate);
      filterDiagnostics.matchedDateRows += 1;
      filterDiagnostics.firstMatchedDate = filterDiagnostics.firstMatchedDate || matchedText;
      filterDiagnostics.lastMatchedDate = matchedText;
    }

    if (rowDateForTraining && average > 0) {
      if (!selectedMonthlyTrendDate || rowDateForTraining > selectedMonthlyTrendDate) {
        selectedMonthlyTrendDate = rowDateForTraining;
      }
    }

    filteredRows += 1;
    totalPick += rowTotalPick;

    if (rowDateForTraining) {
      const rowDateForRange = new Date(rowDateForTraining.getTime());
      rowDateForRange.setHours(0, 0, 0, 0);

      if (!totalPickStartDate || rowDateForRange < totalPickStartDate) {
        totalPickStartDate = rowDateForRange;
      }

      if (!totalPickEndDate || rowDateForRange > totalPickEndDate) {
        totalPickEndDate = rowDateForRange;
      }
    }

    if (average <= 0) {
      excludedCount += 1;
      continue;
    }

    addValue_(summary.overall, average);

    const pickType = normalizePickType_(dataValues[index][columnOffset.pickType]);
    const shouldCountPickType = shouldCountPickTypeOnDate_(pickType, rowDateForTraining);
    const buKey = normalizeBu_(dataValues[index][columnOffset.bu]);
    addPickerValue_(
      pickerSummary,
      rawUserId,
      nameValues[index][0],
      average,
      {
        shift: dataValues[index][columnOffset.shift],
        affiliation: dataValues[index][columnOffset.affiliation],
        buKey: buKey,
        pickType: pickType,
        zone: dataValues[index][columnOffset.position],
        totalPick: rowTotalPick,
      }
    );

    if (pickType && shouldCountPickType && summary[pickType]) {
      addValue_(summary[pickType], average);
    }

    if (pickType === "pickToSort" && shouldCountPickType) {
      addPickToSortValue_(
        pickToSortDetails,
        rawUserId,
        nameValues[index][0],
        average,
        {
          shift: dataValues[index][columnOffset.shift],
          affiliation: dataValues[index][columnOffset.affiliation],
          bu: dataValues[index][columnOffset.bu],
          zone: dataValues[index][columnOffset.position],
          totalPick: rowTotalPick,
        }
      );
    }

    const zoneMatch = findZoneMatch_(dataValues[index][columnOffset.position]);

    if (zoneMatch && zoneSummary[zoneMatch.groupKey] && zoneSummary[zoneMatch.groupKey][zoneMatch.zoneKey]) {
      addValue_(zoneSummary[zoneMatch.groupKey][zoneMatch.zoneKey], average);
    }

    addShiftValue_(shiftSummary, dataValues[index][columnOffset.shift], dataValues[index][columnOffset.affiliation], average);

    addValue_(buSummary[buKey], average);

    if (pickType && shouldCountPickType && buSummary[buKey].details && buSummary[buKey].details[pickType]) {
      addValue_(buSummary[buKey].details[pickType], average);
    }
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    cacheStatus: "fresh",
    cacheVersion: CACHE_VERSION,
    range: {
      startDate: startDateText || "",
      endDate: endDateText || "",
    },
    overall: finalizeBucket_(summary.overall, TARGETS.overall, filteredRows, excludedCount),
    categories: {
      fullRack: finalizeBucket_(summary.fullRack, TARGETS.fullRack),
      halfRack: finalizeBucket_(summary.halfRack, TARGETS.halfRack),
      ea: finalizeBucket_(summary.ea, TARGETS.ea),
      pickToSort: finalizeBucket_(summary.pickToSort, TARGETS.pickToSort),
      mezzanine: finalizeBucket_(summary.mezzanine, TARGETS.mezzanine),
    },
    zones: finalizeZones_(zoneSummary),
    bu: finalizeBu_(buSummary),
    shifts: finalizeShifts_(shiftSummary),
    pickers: finalizePickerSummary_(pickerSummary, TARGETS.overall),
    pickToSortDetails: finalizePickToSortDetails_(pickToSortDetails),
    training: finalizeTrainingSummary_(trainingSummary),
    monthlyTrend: finalizeMonthlyTrend_(
      monthlyTrend,
      chooseMonthlyTrendAnchor_(monthlyTrend, selectedMonthlyTrendDate, startDate, endDate, latestMonthlyTrendDate)
    ),
    totalPick: totalPick,
    totalPickRange: {
      startDate: totalPickStartDate ? formatDateDMY_(totalPickStartDate) : "",
      endDate: totalPickEndDate ? formatDateDMY_(totalPickEndDate) : "",
      sourceColumn: "C",
    },
    totalRows: filteredRows,
    filteredRows: filteredRows,
    filterDiagnostics: filterDiagnostics,
    trainingSource: "2ND!B/G/I + Training row",
    trainingUserCount: Object.keys(trainingRoster || {}).length,
    trainingDebug: createTrainingDebugPayload_(trainingRoster, trainingSummary, []),
    excludedSamples: [],
  };
}


function normalizePersonName_(name) {
  return String(name || "")
    .replace(/^(นาย|นางสาว|นาง|น\.ส\.|ด\.ช\.|ด\.ญ\.|mr\.|ms\.|mrs\.)\s*/i, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function createTrainingRoster_(ss) {
  const sheet = ss.getSheetByName(UPDATE_NAME_SHEET_NAME) || ss.getSheetByName(FALLBACK_UPDATE_NAME_SHEET_NAME);

  if (!sheet) {
    return {};
  }

  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();

  if (lastRow < 2) {
    return {};
  }

  const is2ND = sheet.getName() === "2ND";
  const cols = is2ND ? {
    USER_ID: 2,
    NAME: 3,
    NICKNAME: 4,
    AFFILIATION: 5,
    ROLE: 6,
    START_DATE: 7,
    STATUS_WORK: 8,
    END_DATE: 9,
    ZONE: 10,
    PICK_TYPE: 11,
    BU: 12,
    SHIFT: 13,
  } : {
    USER_ID: 2,
    NAME: 3,
    START_DATE: 8,
    STATUS_WORK: 14,
    END_DATE: 13,
    ZONE: 7,
    PICK_TYPE: 10,
    BU: 11,
    SHIFT: 9,
  };

  const range = sheet.getRange(2, 1, lastRow - 1, Math.max(lastColumn, cols.END_DATE));
  const values = range.getValues();
  const displayValues = range.getDisplayValues();

  // รอบแรก: เอาเฉพาะแถวที่ระบุว่า Traning / Training แบบยืดหยุ่น
  const keywordRoster = collectTrainingRoster_(values, displayValues, cols, true, is2ND);

  if (Object.keys(keywordRoster).length > 1) {
    return keywordRoster;
  }

  // Fallback: ถ้าเจอแค่ 0-1 คน แปลว่าคำว่า Traning อาจอยู่ในรูปแบบอื่น
  const fallbackRoster = collectTrainingRoster_(values, displayValues, cols, false, is2ND);
  return Object.keys(fallbackRoster).length > Object.keys(keywordRoster).length ? fallbackRoster : keywordRoster;
}

function collectTrainingRoster_(values, displayValues, cols, requireTrainingKeyword, is2ND) {
  const roster = {};

  for (let index = 0; index < values.length; index += 1) {
    const displayRow = displayValues[index] || [];
    const valueRow = values[index] || [];

    const endRaw = valueRow[cols.END_DATE - 1];
    const endDisplay = displayRow[cols.END_DATE - 1];
    const endText = String(endDisplay || endRaw || "").trim().toLowerCase();

    // ในชีต 2ND: แถวที่มีการระบุ "Training" ใน Column I (วันที่จบการ Training)
    const isTraining = isTrainingRow_(displayRow, valueRow) || /train/i.test(endText);

    if (requireTrainingKeyword && !isTraining) {
      continue;
    }

    const rawName = String(displayRow[cols.NAME - 1] || valueRow[cols.NAME - 1] || "").trim();
    let userId = normalizeUserId_(displayRow[cols.USER_ID - 1] || valueRow[cols.USER_ID - 1]);
    const displayId = userId || "-";

    // ถ้าไม่มีรหัสพนักงาน (เช่น Man Power) ให้ใช้ชื่อ Normalize เป็น Key
    if (!userId) {
      if (!rawName) continue;
      userId = "NAME:" + normalizePersonName_(rawName);
    }

    const startRaw = valueRow[cols.START_DATE - 1];
    const startDisplay = displayRow[cols.START_DATE - 1];
    const startDateCandidates = getDateCandidates_(startRaw, startDisplay);
    // ถ้า Col I ระบุว่า Training ให้ถือว่าอยู่ระหว่างฝึกสอน (ยังไม่มีวันสิ้นสุดตายตัว)
    const endDateCandidates = /train/i.test(endText) ? [] : getDateCandidates_(endRaw, endDisplay);
    const startDate = startDateCandidates[0] || null;
    const endDate = endDateCandidates[0] || null;

    if (!startDate) {
      continue;
    }

    mergeTrainingRosterItem_(roster, {
      userId: userId,
      displayId: displayId,
      name: rawName || findTrainingDisplayName_(displayRow, userId),
      rawName: rawName,
      normalizedName: normalizePersonName_(rawName),
      startDate: startDate,
      endDate: endDate,
      startDateCandidates: startDateCandidates,
      endDateCandidates: endDateCandidates,
      startDateRawText: String(startDisplay || startRaw || ""),
      endDateRawText: String(endDisplay || endRaw || ""),
    });
  }

  return roster;
}

function mergeTrainingRosterItem_(roster, item) {
  const current = roster[item.userId];

  if (!current) {
    roster[item.userId] = item;
    return;
  }

  // ถ้า User ID ซ้ำ ให้ใช้วันเริ่มที่เร็วที่สุดและวันจบ Training ที่ไกลที่สุด
  if (item.startDate && (!current.startDate || item.startDate < current.startDate)) {
    current.startDate = item.startDate;
  }

  if (item.endDate && (!current.endDate || item.endDate > current.endDate)) {
    current.endDate = item.endDate;
  }

  current.startDateCandidates = mergeDateCandidateLists_(current.startDateCandidates, item.startDateCandidates);
  current.endDateCandidates = mergeDateCandidateLists_(current.endDateCandidates, item.endDateCandidates);
  current.startDateRawText = current.startDateRawText || item.startDateRawText || "";
  current.endDateRawText = current.endDateRawText || item.endDateRawText || "";

  if ((!current.name || /^User ID/i.test(current.name)) && item.name) {
    current.name = item.name;
  }
}

function isTrainingRow_(displayRow, valueRow) {
  return (displayRow || valueRow || []).some((cell, index) => {
    const valueText = valueRow && valueRow[index] !== undefined ? String(valueRow[index] || "") : "";
    const text = `${cell || ""} ${valueText}`.replace(/\s+/g, "").toLowerCase();

    // รองรับ Traning ที่สะกดผิด, Training, ข้อความยาวเช่น Training-New, และคำไทยที่เกี่ยวกับเทรน/ฝึก
    return /traning|training|trainee|train|เทรน|ฝึก/.test(text);
  });
}

function findTrainingDisplayName_(displayRow, userId) {
  const candidates = [
    displayRow[2], // C มักเป็นชื่อ ถ้ามี
    displayRow[3],
    displayRow[4],
    displayRow[5],
  ];

  for (let index = 0; index < candidates.length; index += 1) {
    const text = normalizeGroupLabel_(candidates[index], "");

    if (text && normalizeUserId_(text) !== userId && !/^training$/i.test(text) && !/^traning$/i.test(text)) {
      return text;
    }
  }

  return `User ID ${userId}`;
}

function normalizeUserId_(value) {
  let text = String(value === null || value === undefined ? "" : value)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^'+|'+$/g, "")
    .replace(/,/g, "")
    .replace(/[\s\u00A0]+/g, "")
    .trim();

  if (!text) {
    return "";
  }

  text = text.replace(/\.0+$/, "");
  return text.toUpperCase();
}

function getUserIdAliasList_(value) {
  const normalized = normalizeUserId_(value);

  if (!normalized) {
    return [];
  }

  const aliases = {};
  aliases[normalized] = true;

  const compact = normalized.replace(/[^0-9A-Z]/g, "");
  if (compact) aliases[compact] = true;

  const digitsOnly = normalized.replace(/\D/g, "");
  if (digitsOnly) {
    aliases[digitsOnly] = true;
    aliases[digitsOnly.replace(/^0+/, "") || "0"] = true;

    // ใช้เลขท้ายเฉพาะกรณียาวพอ เพื่อช่วยเคส ID-123456 / 000123456 แต่ลดโอกาสจับผิดคน
    if (digitsOnly.length >= 5) aliases[digitsOnly.slice(-5)] = true;
    if (digitsOnly.length >= 6) aliases[digitsOnly.slice(-6)] = true;
  }

  return Object.keys(aliases).filter(Boolean);
}

function resolveTrainingRosterKey_(trainingRoster, userIdValue, nameValue) {
  const directKey = normalizeUserId_(userIdValue);

  if (directKey && trainingRoster[directKey]) {
    return directKey;
  }

  if (directKey) {
    const sourceAliases = getUserIdAliasList_(userIdValue);

    if (sourceAliases.length > 0) {
      const sourceAliasMap = sourceAliases.reduce((map, alias) => {
        map[alias] = true;
        return map;
      }, {});

      const matches = [];

      Object.keys(trainingRoster || {}).forEach((rosterKey) => {
        const rosterAliases = getUserIdAliasList_(rosterKey);

        if (rosterAliases.some((alias) => sourceAliasMap[alias])) {
          matches.push(rosterKey);
        }
      });

      if (matches.length === 1) {
        return matches[0];
      }
    }
  }

  // แมปด้วยชื่อพนักงาน (ช่วยกรณี Man Power หรือพนักงานใหม่ที่ยังไม่มีรหัสในตาราง)
  if (nameValue) {
    const normTarget = normalizePersonName_(nameValue);
    if (normTarget) {
      const keys = Object.keys(trainingRoster || {});
      for (let i = 0; i < keys.length; i += 1) {
        const item = trainingRoster[keys[i]];
        if (item && item.normalizedName && item.normalizedName === normTarget) {
          return keys[i];
        }
      }
    }
  }

  return "";
}

function createTrainingSummary_() {
  return {};
}

function seedTrainingSummary_(trainingSummary, trainingRoster) {
  Object.keys(trainingRoster || {}).forEach((userId) => {
    const rosterItem = trainingRoster[userId] || {};

    if (!trainingSummary[userId]) {
      const displayUserId = (rosterItem.displayId && rosterItem.displayId !== "-")
        ? rosterItem.displayId
        : (userId.startsWith("NAME:") ? "-" : userId);

      trainingSummary[userId] = {
        userId: displayUserId,
        name: rosterItem.name || `User ID ${displayUserId}`,
        startDate: rosterItem.startDate || null,
        endDate: rosterItem.endDate || null,
        startDateCandidates: rosterItem.startDateCandidates || (rosterItem.startDate ? [rosterItem.startDate] : []),
        endDateCandidates: rosterItem.endDateCandidates || (rosterItem.endDate ? [rosterItem.endDate] : []),
        daily: {},
        matchedFrom: {},
      };
    }
  });
}

function serializeTrainingRoster_(trainingRoster) {
  return Object.keys(trainingRoster || {}).map((userId) => {
    const item = trainingRoster[userId] || {};
    const displayUserId = (item.displayId && item.displayId !== "-")
      ? item.displayId
      : (userId.startsWith("NAME:") ? "-" : userId);

    return {
      userId: displayUserId,
      name: item.name || `User ID ${displayUserId}`,
      startDate: item.startDate ? formatDateISO_(item.startDate) : "",
      endDate: item.endDate ? formatDateISO_(item.endDate) : "",
      startDateCandidates: (item.startDateCandidates || []).map(formatDateISO_),
      endDateCandidates: (item.endDateCandidates || []).map(formatDateISO_),
    };
  });
}

function addTrainingValue_(trainingSummary, trainingRoster, userIdValue, nameValue, workDate, average) {
  const rosterKey = resolveTrainingRosterKey_(trainingRoster, userIdValue, nameValue);
  const rosterItem = rosterKey ? trainingRoster[rosterKey] : null;

  if (!rosterItem || !(workDate instanceof Date) || isNaN(workDate.getTime())) {
    return;
  }

  if (!trainingSummary[rosterKey]) {
    const displayUserId = (rosterItem.displayId && rosterItem.displayId !== "-")
      ? rosterItem.displayId
      : (rosterKey.startsWith("NAME:") ? "-" : rosterKey);

    trainingSummary[rosterKey] = {
      userId: displayUserId,
      name: rosterItem.name || `User ID ${displayUserId}`,
      startDate: rosterItem.startDate || null,
      endDate: rosterItem.endDate || null,
      daily: {},
      matchedFrom: {},
    };
  }

  const trainee = trainingSummary[rosterKey];
  const dayKey = formatDateISO_(workDate);
  const normalizedSourceUserId = normalizeUserId_(userIdValue);

  if (normalizedSourceUserId) {
    trainee.matchedFrom[normalizedSourceUserId] = true;
  } else if (nameValue) {
    trainee.matchedFrom[String(nameValue).trim()] = true;
  }

  if (!trainee.daily[dayKey]) {
    trainee.daily[dayKey] = createBucket_();
  }

  addValue_(trainee.daily[dayKey], average);
}

function countTrainingDailyRows_(trainee) {
  return Object.keys(trainee && trainee.daily || {}).reduce((sum, dateKey) => {
    const bucket = trainee.daily[dateKey] || {};
    return sum + Number(bucket.count || 0);
  }, 0);
}

function createTrainingDebugPayload_(trainingRoster, trainingSummary, resultUserSamples) {
  const rosterUserIds = Object.keys(trainingRoster || {}).sort((left, right) => left.localeCompare(right, "th"));
  const matchedUserIds = rosterUserIds.filter((userId) => countTrainingDailyRows_(trainingSummary[userId]) > 0);
  const noResultUserIds = rosterUserIds.filter((userId) => countTrainingDailyRows_(trainingSummary[userId]) <= 0);

  return {
    version: CACHE_VERSION,
    trainingUserCount: rosterUserIds.length,
    trainingMatchedCount: matchedUserIds.length,
    trainingNoResultCount: noResultUserIds.length,
    sampleTrainingUsers: rosterUserIds.slice(0, 20).map((userId) => {
      const item = trainingRoster[userId] || {};
      const summary = trainingSummary[userId] || {};
      return {
        userId: userId,
        aliases: getUserIdAliasList_(userId).slice(0, 6),
        name: item.name || summary.name || `User ID ${userId}`,
        startDate: item.startDate ? formatDateDMY_(item.startDate) : "",
        endDate: item.endDate ? formatDateDMY_(item.endDate) : "",
        startCandidates: (item.startDateCandidates || []).slice(0, 4).map(formatDateDMY_),
        endCandidates: (item.endDateCandidates || []).slice(0, 4).map(formatDateDMY_),
        resultRows: countTrainingDailyRows_(summary),
        matchedFrom: Object.keys(summary.matchedFrom || {}).slice(0, 8),
      };
    }),
    sampleMatchedUsers: matchedUserIds.slice(0, 20),
    sampleNoResultUsers: noResultUserIds.slice(0, 20),
    sampleResultUsers: Array.isArray(resultUserSamples) ? resultUserSamples.slice(0, 20) : [],
  };
}

function finalizeTrainingSummary_(trainingSummary) {
  return Object.keys(trainingSummary || {})
    .map((userId) => finalizeTrainingItem_(trainingSummary[userId]))
    .sort((left, right) => {
      const dataDiff = Number(right.count > 0) - Number(left.count > 0);
      const improveDiff = Number(right.improvement || 0) - Number(left.improvement || 0);
      return dataDiff || improveDiff || left.name.localeCompare(right.name, "th");
    })
    .slice(0, 100);
}

function finalizeTrainingItem_(trainee) {
  const startDate = trainee.startDate || null;
  const officialEndDate = trainee.endDate || (startDate ? addMonths_(startDate, 2) : null);
  const officialWindow = createTrainingWindow_(startDate, officialEndDate, "official");
  const officialScore = scoreTrainingWindow_(trainee, officialWindow);
  const smartWindow = chooseSmartTrainingWindow_(trainee, officialWindow, officialScore);
  const selectedScore = scoreTrainingWindow_(trainee, smartWindow);
  const firstAverage = selectedScore.firstPeriod.count > 0 ? selectedScore.firstPeriod.sum / selectedScore.firstPeriod.count : 0;
  const secondAverage = selectedScore.secondPeriod.count > 0 ? selectedScore.secondPeriod.sum / selectedScore.secondPeriod.count : 0;
  const overallAverage = selectedScore.overall.count > 0 ? selectedScore.overall.sum / selectedScore.overall.count : 0;
  const improvement = selectedScore.secondPeriod.count > 0 && selectedScore.firstPeriod.count > 0 ? secondAverage - firstAverage : 0;
  const smartApplied = smartWindow.reason !== "official" && selectedScore.overall.count > officialScore.overall.count;

  return {
    key: Utilities.base64EncodeWebSafe(String(trainee.userId || trainee.name || "")).slice(0, 18),
    userId: (trainee.userId && !trainee.userId.startsWith("NAME:")) ? trainee.userId : (trainee.displayId && trainee.displayId !== "-" ? trainee.displayId : "-"),
    name: trainee.name || `User ID ${trainee.userId || "-"}`,
    startDate: smartWindow.startDate ? formatDateDMY_(smartWindow.startDate) : "-",
    trainingEndDate: smartWindow.endDate ? formatDateDMY_(smartWindow.endDate) : "-",
    originalStartDate: startDate ? formatDateDMY_(startDate) : "-",
    originalTrainingEndDate: officialWindow.endDate ? formatDateDMY_(officialWindow.endDate) : "-",
    activeDays: selectedScore.activeDays,
    count: selectedScore.overall.count,
    average: round1_(overallAverage),
    target: TARGETS.training,
    targetGap: round1_(overallAverage - TARGETS.training),
    targetStatus: overallAverage >= TARGETS.training ? "ผ่าน Target Training" : selectedScore.overall.count > 0 ? "ต่ำกว่า Target Training" : "ไม่มีข้อมูลในช่วง Training",
    first30Average: round1_(firstAverage),
    first30Count: selectedScore.firstPeriod.count,
    second30Average: round1_(secondAverage),
    second30Count: selectedScore.secondPeriod.count,
    improvement: round1_(improvement),
    trend: improvement > 0 ? "ดีขึ้น" : improvement < 0 ? "ลดลง" : "ทรงตัว/ข้อมูลยังไม่พอ",
    matchedFrom: Object.keys(trainee.matchedFrom || {}).slice(0, 8),
    smartApplied: smartApplied,
    smartReason: smartWindow.reason,
    smartNote: smartApplied ? getSmartTrainingNote_(smartWindow.reason) : "",
  };
}

function createTrainingWindow_(startDate, endDate, reason) {
  const safeStartDate = startDate || null;
  const twoMonthEndDate = safeStartDate ? addMonths_(safeStartDate, 2) : endDate || null;
  const finalEndDate = minDate_(endDate || twoMonthEndDate, twoMonthEndDate) || endDate || twoMonthEndDate || null;

  return {
    startDate: safeStartDate,
    endDate: finalEndDate,
    day30EndDate: safeStartDate ? addDays_(safeStartDate, 29) : null,
    reason: reason || "official",
  };
}

function scoreTrainingWindow_(trainee, windowInfo) {
  const overall = createBucket_();
  const firstPeriod = createBucket_();
  const secondPeriod = createBucket_();
  let activeDays = 0;

  Object.keys(trainee.daily || {}).forEach((dateKey) => {
    const date = parseInputDate_(dateKey);

    if (!date || (windowInfo.startDate && date < windowInfo.startDate) || (windowInfo.endDate && date > windowInfo.endDate)) {
      return;
    }

    const bucket = trainee.daily[dateKey];

    if (Number(bucket.count || 0) <= 0) {
      return;
    }

    activeDays += 1;
    mergeBucket_(overall, bucket);

    if (windowInfo.day30EndDate && date <= windowInfo.day30EndDate) {
      mergeBucket_(firstPeriod, bucket);
    } else {
      mergeBucket_(secondPeriod, bucket);
    }
  });

  return {
    overall: overall,
    firstPeriod: firstPeriod,
    secondPeriod: secondPeriod,
    activeDays: activeDays,
  };
}

function chooseSmartTrainingWindow_(trainee, officialWindow, officialScore) {
  let bestWindow = officialWindow;
  let bestScore = officialScore;
  const startCandidates = normalizeDateCandidateList_(trainee.startDateCandidates || (trainee.startDate ? [trainee.startDate] : []));
  const endCandidates = normalizeDateCandidateList_(trainee.endDateCandidates || (trainee.endDate ? [trainee.endDate] : []));
  const candidateStarts = startCandidates.length > 0 ? startCandidates : (trainee.startDate ? [trainee.startDate] : []);
  const candidateEnds = endCandidates.length > 0 ? endCandidates : [null];

  candidateStarts.forEach((candidateStart) => {
    candidateEnds.forEach((candidateEnd) => {
      const windowInfo = createTrainingWindow_(candidateStart, candidateEnd, "date-candidate");
      const score = scoreTrainingWindow_(trainee, windowInfo);

      if (isBetterTrainingWindow_(score, bestScore, windowInfo, bestWindow)) {
        bestWindow = windowInfo;
        bestScore = score;
      }
    });
  });

  const dailyKeys = Object.keys(trainee.daily || {}).sort();

  // ถ้าวันเริ่ม/วันจบจาก Update name ไม่กินข้อมูลเลย แต่ User ID มีข้อมูลจริง
  // ให้ใช้วันแรกที่เจอใน Results Master เป็นหน้าต่าง fallback ชั่วคราว เพื่อไม่ให้การ์ดเป็น 0 โดยไม่รู้สาเหตุ
  if (bestScore.overall.count <= 0 && dailyKeys.length > 0) {
    const firstWorkDate = parseInputDate_(dailyKeys[0]);
    const fallbackWindow = createTrainingWindow_(firstWorkDate, firstWorkDate ? addMonths_(firstWorkDate, 2) : null, "first-result-date");
    const fallbackScore = scoreTrainingWindow_(trainee, fallbackWindow);

    if (fallbackScore.overall.count > bestScore.overall.count) {
      bestWindow = fallbackWindow;
      bestScore = fallbackScore;
    }
  }

  return bestWindow;
}

function isBetterTrainingWindow_(score, bestScore, windowInfo, bestWindow) {
  const countDiff = Number(score.overall.count || 0) - Number(bestScore.overall.count || 0);

  if (countDiff !== 0) {
    return countDiff > 0;
  }

  const dayDiff = Number(score.activeDays || 0) - Number(bestScore.activeDays || 0);

  if (dayDiff !== 0) {
    return dayDiff > 0;
  }

  if (!windowInfo.startDate || !bestWindow.startDate) {
    return false;
  }

  return windowInfo.startDate < bestWindow.startDate;
}

function getSmartTrainingNote_(reason) {
  if (reason === "date-candidate") {
    return "ระบบเลือกช่วงวันที่ที่มีข้อมูลจริงให้ เพราะวันใน Update name อาจสลับ D/M กับ M/D";
  }

  if (reason === "first-result-date") {
    return "ระบบใช้วันแรกที่พบ Productivity ใน Results Master เป็นช่วงอ้างอิงชั่วคราว";
  }

  return "";
}

function mergeBucket_(target, source) {
  target.sum += Number(source && source.sum || 0);
  target.count += Number(source && source.count || 0);
}

function minDate_(left, right) {
  if (!left) return right || null;
  if (!right) return left || null;
  return left < right ? left : right;
}

function addDays_(date, days) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  result.setDate(result.getDate() + days);
  return result;
}

function addMonths_(date, months) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  result.setMonth(result.getMonth() + months);
  return result;
}

function createShiftSummary_() {
  return {};
}

function addShiftValue_(shiftSummary, shiftValue, affiliationValue, average) {
  const shiftName = normalizeGroupLabel_(shiftValue, "ไม่ระบุกะ");
  const affiliationName = normalizeGroupLabel_(affiliationValue, "ไม่ระบุสังกัด");

  if (!shiftSummary[shiftName]) {
    shiftSummary[shiftName] = {
      bucket: createBucket_(),
      affiliations: {},
    };
  }

  addValue_(shiftSummary[shiftName].bucket, average);

  if (!shiftSummary[shiftName].affiliations[affiliationName]) {
    shiftSummary[shiftName].affiliations[affiliationName] = createBucket_();
  }

  addValue_(shiftSummary[shiftName].affiliations[affiliationName], average);
}

function finalizeShifts_(shiftSummary) {
  const shiftNames = Object.keys(shiftSummary).sort((left, right) => left.localeCompare(right, "th"));
  const totalCount = shiftNames.reduce((sum, shiftName) => sum + shiftSummary[shiftName].bucket.count, 0);

  return shiftNames.map((shiftName, index) => {
    const item = shiftSummary[shiftName];
    const affiliationNames = Object.keys(item.affiliations).sort((left, right) => {
      const countDiff = item.affiliations[right].count - item.affiliations[left].count;
      return countDiff || left.localeCompare(right, "th");
    });

    return {
      key: `shift${index + 1}`,
      title: `Shift ${shiftName}`,
      label: shiftName,
      share: totalCount > 0 ? round1_((item.bucket.count / totalCount) * 100) : 0,
      affiliations: affiliationNames.map((affiliationName, affiliationIndex) => ({
        key: `shift${index + 1}_affiliation${affiliationIndex + 1}`,
        title: affiliationName,
        label: affiliationName,
        ...finalizeBucket_(item.affiliations[affiliationName], TARGETS.overall),
      })),
      ...finalizeBucket_(item.bucket, TARGETS.overall),
    };
  });
}


function createPickerSummary_() {
  return {};
}

function normalizePickerKey_(userIdValue, nameValue) {
  const userId = normalizeUserId_(userIdValue);

  if (userId) {
    return userId;
  }

  return String(nameValue || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function findPickerDisplayName_(nameValue, userId) {
  const name = String(nameValue || "").replace(/\s+/g, " ").trim();

  if (name && normalizeUserId_(name) !== userId) {
    return name;
  }

  return userId ? `User ID ${userId}` : "ไม่ระบุชื่อ";
}

function addCount_(summary, key) {
  const label = String(key || "").replace(/\s+/g, " ").trim();

  if (!label) {
    return;
  }

  summary[label] = Number(summary[label] || 0) + 1;
}

function getTopCountLabel_(summary, fallback) {
  const keys = Object.keys(summary || {});

  if (keys.length === 0) {
    return fallback || "-";
  }

  return keys.sort((left, right) => {
    const countDiff = Number(summary[right] || 0) - Number(summary[left] || 0);
    return countDiff || left.localeCompare(right, "th");
  })[0];
}

function getBuLabel_(key) {
  const item = BU_GROUPS.filter((bu) => bu.key === key)[0];
  return item ? item.label : (key || "Other BU");
}

function getPickTypeLabel_(key) {
  const item = PICK_TYPE_DETAILS.filter((detail) => detail.key === key)[0];
  return item ? item.label : (key || "-");
}

function addPickerValue_(pickerSummary, userIdValue, nameValue, average, meta) {
  const userId = normalizeUserId_(userIdValue);
  const name = findPickerDisplayName_(nameValue, userId);
  const key = normalizePickerKey_(userId, name);

  if (!key) {
    return;
  }

  if (!pickerSummary[key]) {
    pickerSummary[key] = {
      userId: userId,
      name: name,
      sum: 0,
      count: 0,
      totalPick: 0,
      shifts: {},
      affiliations: {},
      bu: {},
      pickTypes: {},
      zones: {},
    };
  }

  const picker = pickerSummary[key];
  picker.sum += Number(average || 0);
  picker.count += 1;
  picker.totalPick += Number(meta && meta.totalPick || 0);

  if (name && (!picker.name || /^User ID/i.test(picker.name))) {
    picker.name = name;
  }

  const shift = normalizeGroupLabel_(meta && meta.shift, "ไม่ระบุกะ");
  const affiliation = normalizeGroupLabel_(meta && meta.affiliation, "ไม่ระบุสังกัด");
  const buLabel = getBuLabel_(meta && meta.buKey);
  const pickTypeLabel = getPickTypeLabel_(meta && meta.pickType);
  const zoneLabel = normalizeGroupLabel_(meta && meta.zone, "ไม่ระบุ Zone");

  addCount_(picker.shifts, shift);
  addCount_(picker.affiliations, affiliation);
  addCount_(picker.bu, buLabel);
  addCount_(picker.pickTypes, pickTypeLabel);
  addCount_(picker.zones, zoneLabel);
}

function finalizePickerRows_(pickerSummary, target) {
  return Object.keys(pickerSummary || {})
    .map((key) => {
      const picker = pickerSummary[key] || {};
      const count = Number(picker.count || 0);
      const average = count > 0 ? Number(picker.sum || 0) / count : 0;
      const gap = average - target;

      return {
        key: Utilities.base64EncodeWebSafe(String(key)).slice(0, 18),
        userId: picker.userId || "",
        name: picker.name || (picker.userId ? `User ID ${picker.userId}` : "ไม่ระบุชื่อ"),
        average: round1_(average),
        count: count,
        totalPick: Math.round(Number(picker.totalPick || 0)),
        target: target,
        gap: round1_(gap),
        status: average >= target ? "ผ่าน Target" : "ต่ำกว่า Target",
        mainShift: getTopCountLabel_(picker.shifts, "ไม่ระบุกะ"),
        mainAffiliation: getTopCountLabel_(picker.affiliations, "ไม่ระบุสังกัด"),
        mainBu: getTopCountLabel_(picker.bu, "Other BU"),
        mainPickType: getTopCountLabel_(picker.pickTypes, "-"),
        mainZone: getTopCountLabel_(picker.zones, "ไม่ระบุ Zone"),
      };
    })
    .filter((item) => item.count > 0);
}

function addPickerRanks_(items) {
  return items.map((item, index) => ({
    ...item,
    rank: index + 1,
  }));
}

function finalizePickerSummary_(pickerSummary, target) {
  const rows = finalizePickerRows_(pickerSummary, target);
  const top = rows.slice().sort((left, right) => {
    const averageDiff = Number(right.average || 0) - Number(left.average || 0);
    const countDiff = Number(right.count || 0) - Number(left.count || 0);
    return averageDiff || countDiff || left.name.localeCompare(right.name, "th");
  });
  const bottom = rows.slice().sort((left, right) => {
    const averageDiff = Number(left.average || 0) - Number(right.average || 0);
    const countDiff = Number(right.count || 0) - Number(left.count || 0);
    return averageDiff || countDiff || left.name.localeCompare(right.name, "th");
  });

  return {
    total: rows.length,
    top: addPickerRanks_(top.slice(0, 10)),
    bottom: addPickerRanks_(bottom.slice(0, 10)),
    all: rows,
  };
}
function normalizeGroupLabel_(value, fallback) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function createZoneSummary_() {
  const summary = {};

  ZONE_GROUPS.forEach((group) => {
    summary[group.key] = {};

    group.zones.forEach((zone) => {
      summary[group.key][zone.key] = createBucket_();
    });
  });

  return summary;
}

function finalizeZones_(zoneSummary) {
  return ZONE_GROUPS.map((group) => ({
    key: group.key,
    title: group.title,
    target: group.target,
    zones: group.zones.map((zone) => ({
      key: zone.key,
      title: zone.title,
      label: zone.label,
      mainKpi: typeof zone.mainKpi === "number" ? zone.mainKpi : null,
      ...finalizeBucket_(zoneSummary[group.key][zone.key], group.target),
    })),
  }));
}

function createBuSummary_() {
  return BU_GROUPS.reduce((summary, bu) => {
    const bucket = createBucket_();
    bucket.details = createPickTypeDetailSummary_();
    summary[bu.key] = bucket;
    return summary;
  }, {});
}

function createPickTypeDetailSummary_() {
  return PICK_TYPE_DETAILS.reduce((summary, detail) => {
    summary[detail.key] = createBucket_();
    return summary;
  }, {});
}

function finalizeBu_(buSummary) {
  const totalCount = BU_GROUPS.reduce((sum, bu) => sum + (buSummary[bu.key] ? buSummary[bu.key].count : 0), 0);

  return BU_GROUPS.map((bu) => {
    const bucket = buSummary[bu.key] || createBucket_();
    const result = finalizeBucket_(bucket, TARGETS.overall);

    return {
      key: bu.key,
      title: bu.title,
      label: bu.label,
      focus: bu.focus,
      share: totalCount > 0 ? round1_((bucket.count / totalCount) * 100) : 0,
      details: finalizeBuDetails_(bu, bucket.details || createPickTypeDetailSummary_()),
      ...result,
    };
  });
}

function finalizeBuDetails_(bu, detailSummary) {
  if (!bu.focus) {
    return [];
  }

  const mix = bu.pickMix || {};

  return PICK_TYPE_DETAILS.map((detail) => ({
    key: detail.key,
    title: detail.title,
    label: detail.label,
    mainKpi: typeof mix[detail.key] === "number" ? mix[detail.key] : null,
    ...finalizeBucket_(detailSummary[detail.key] || createBucket_(), detail.target),
  }));
}

function finalizePickToSortBu_(buSummary) {
  const totalCount = BU_GROUPS.reduce((sum, bu) => sum + (buSummary[bu.key] ? buSummary[bu.key].count : 0), 0);

  return BU_GROUPS.map((bu) => {
    const bucket = buSummary[bu.key] || createBucket_();
    return {
      key: bu.key,
      title: bu.title,
      label: bu.label,
      focus: bu.focus,
      share: totalCount > 0 ? round1_((bucket.count / totalCount) * 100) : 0,
      ...finalizeBucket_(bucket, TARGETS.pickToSort),
    };
  });
}

function finalizePickToSortDetails_(summary) {
  const source = summary || createPickToSortSummary_();

  return {
    overall: finalizeBucket_(source.overall || createBucket_(), TARGETS.pickToSort),
    totalPick: Math.round(Number(source.totalPick || 0)),
    shifts: finalizeShifts_(source.shifts || createShiftSummary_()).map((shift) => {
      const result = finalizeBucket_({ sum: Number(shift.average || 0) * Number(shift.count || 0), count: Number(shift.count || 0) }, TARGETS.pickToSort);
      return {
        ...shift,
        ...result,
        affiliations: (shift.affiliations || []).map((affiliation) => ({
          ...affiliation,
          ...finalizeBucket_({ sum: Number(affiliation.average || 0) * Number(affiliation.count || 0), count: Number(affiliation.count || 0) }, TARGETS.pickToSort),
        })),
      };
    }),
    bu: finalizePickToSortBu_(source.bu || createBuSummary_()),
    pickers: finalizePickerSummary_(source.pickers || createPickerSummary_(), TARGETS.pickToSort),
    startDate: "08/06/2026",
    sourceColumn: "AK",
  };
}

function normalizeBu_(value) {
  const text = String(value || "").toLowerCase().replace(/\s+/g, " ").trim();

  if (!text) {
    return "other";
  }

  for (let index = 0; index < BU_GROUPS.length; index += 1) {
    const bu = BU_GROUPS[index];

    if (!bu.match || bu.match.length === 0) {
      continue;
    }

    const isMatched = bu.match.some((keyword) => text.includes(keyword));

    if (isMatched) {
      return bu.key;
    }
  }

  return "other";
}

function findZoneMatch_(position) {
  const text = String(position || "").toUpperCase().trim();

  if (!text) {
    return null;
  }

  if (zoneMatchCache[text] !== undefined) {
    return zoneMatchCache[text];
  }

  const codes = extractPositionCodes_(text);

  if (codes.length === 0) {
    zoneMatchCache[text] = null;
    return null;
  }

  for (let groupIndex = 0; groupIndex < ZONE_GROUPS.length; groupIndex += 1) {
    const group = ZONE_GROUPS[groupIndex];

    for (let zoneIndex = 0; zoneIndex < group.zones.length; zoneIndex += 1) {
      const zone = group.zones[zoneIndex];
      const isMatched = codes.some((code) => zone.codes.indexOf(code) >= 0);

      if (isMatched) {
        const result = {
          groupKey: group.key,
          zoneKey: zone.key,
        };
        zoneMatchCache[text] = result;
        return result;
      }
    }
  }

  zoneMatchCache[text] = null;
  return null;
}

function extractPositionCodes_(position) {
  const text = String(position || "").toUpperCase().trim();

  if (!text) {
    return [];
  }

  const IGNORED_WORDS = ["DAY", "NIGHT", "SHIFT", "DAILY", "ADMIN", "TOTAL", "NONE", "NULL", "N/A"];
  if (IGNORED_WORDS.indexOf(text) >= 0) {
    return [];
  }

  const ALL_VALID_ZONES = [
    "AA", "AB", "AC", "AD", "AE", "AF", "AG", "AH", "AI", "AJ", "AK", "AL", "AM", "AN",
    "BE", "BG", "BH", "BI", "BJ", "BK", "BL", "BM", "BN",
    "CA", "CB", "CC", "CD", "CE", "CF",
    "DA", "DB", "DC", "DD", "DE", "DF",
    "EA", "FA", "HB"
  ];

  const foundCodes = [];
  ALL_VALID_ZONES.forEach((code) => {
    const regex = new RegExp(`(?:^|[^A-Z])${code}(?:$|[^A-Z0-9]|\\d)`, "i");
    if (regex.test(text)) {
      foundCodes.push(code);
    }
  });

  return foundCodes;
}

function saveDailyIndexPayload_(cacheKey, payload) {
  const text = JSON.stringify(payload);

  try {
    CacheService.getScriptCache().put(cacheKey, text, CACHE_SECONDS);
  } catch (error) {
    // Daily index อาจใหญ่เกิน CacheService ได้ ให้ response รอบนี้ยังส่งกลับได้ ไม่ต้องเขียน PropertiesService
  }
}

function saveDashboardPayload_(cacheKey, payload) {
  const text = JSON.stringify(payload);

  try {
    CacheService.getScriptCache().put(cacheKey, text, CACHE_SECONDS);
  } catch (error) {
    // ถ้า payload ใหญ่เกิน cache ให้ข้ามการเขียน cache ไม่โยน error กลับหน้าเว็บ
  }
}

function clearDashboardPropertiesQuota() {
  // ใช้รันครั้งเดียวใน Apps Script เพื่อเคลียร์ property cache เก่าที่เคยทำให้ quota เต็ม
  const properties = PropertiesService.getScriptProperties();
  const all = properties.getProperties();
  const keys = Object.keys(all).filter((key) => (
    key.indexOf("LAST_DASHBOARD_") === 0 ||
    key.indexOf("pick_dashboard") === 0 ||
    key.indexOf("DASHBOARD") >= 0
  ));

  keys.forEach((key) => properties.deleteProperty(key));

  return `ลบ Dashboard properties เก่าแล้ว ${keys.length} รายการ`;
}


function getCacheKey_(startDate, endDate) {
  return [
    `pick_dashboard_${CACHE_VERSION}`,
    startDate || "all",
    endDate || "all",
  ].join("_");
}

function isUsableDashboardPayload_(payload) {
  return Boolean(
    payload
      && payload.cacheVersion === CACHE_VERSION
      && payload.overall
      && payload.categories
      && Array.isArray(payload.zones)
      && Array.isArray(payload.bu)
      && Array.isArray(payload.shifts)
      && payload.pickers
      && Array.isArray(payload.pickers.top)
      && Array.isArray(payload.pickers.bottom)
      && payload.pickToSortDetails
      && Array.isArray(payload.training)
  );
}

function getCacheAgeSeconds_(generatedAt) {
  const generatedTime = new Date(generatedAt || 0).getTime();

  if (!Number.isFinite(generatedTime) || generatedTime <= 0) {
    return 0;
  }

  return Math.max(Math.round((Date.now() - generatedTime) / 1000), 0);
}

function createBucket_() {
  return {
    sum: 0,
    count: 0,
    average: 0,
  };
}

function addValue_(bucket, value) {
  bucket.sum += value;
  bucket.count += 1;
}

function finalizeBucket_(bucket, target, totalRows, excludedCount) {
  const average = bucket.count > 0 ? bucket.sum / bucket.count : 0;
  const gap = average - target;

  return {
    average: round1_(average),
    count: bucket.count,
    validCount: bucket.count,
    totalRows: totalRows || bucket.count,
    excludedCount: excludedCount || 0,
    target: target,
    gap: round1_(gap),
    status: average >= target ? "ผ่าน Target" : "ต่ำกว่า Target",
  };
}

function emptyPayload_(startedAt, startDateText, endDateText) {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    cacheStatus: "fresh",
    cacheVersion: CACHE_VERSION,
    range: {
      startDate: startDateText || "",
      endDate: endDateText || "",
    },
    overall: finalizeBucket_(createBucket_(), TARGETS.overall, 0, 0),
    categories: {
      fullRack: finalizeBucket_(createBucket_(), TARGETS.fullRack),
      halfRack: finalizeBucket_(createBucket_(), TARGETS.halfRack),
      ea: finalizeBucket_(createBucket_(), TARGETS.ea),
      pickToSort: finalizeBucket_(createBucket_(), TARGETS.pickToSort),
      mezzanine: finalizeBucket_(createBucket_(), TARGETS.mezzanine),
    },
    zones: finalizeZones_(createZoneSummary_()),
    bu: finalizeBu_(createBuSummary_()),
    shifts: [],
    pickers: finalizePickerSummary_(createPickerSummary_(), TARGETS.overall),
    pickToSortDetails: finalizePickToSortDetails_(createPickToSortSummary_()),
    training: [],
    monthlyTrend: finalizeMonthlyTrend_({}, null),
    totalPick: 0,
    totalPickRange: { startDate: "", endDate: "", sourceColumn: "C" },
    totalRows: 0,
    filteredRows: 0,
    filterDiagnostics: {
      enabled: Boolean(startDateText || endDateText),
      sourceColumn: "C",
      sourceFormat: "DD/MM/YYYY",
      inputStartDate: startDateText || "",
      inputEndDate: endDateText || "",
      emptyDateRows: 0,
      invalidDateRows: 0,
      beforeStartRows: 0,
      afterEndRows: 0,
      matchedDateRows: 0,
      firstMatchedDate: "",
      lastMatchedDate: "",
      firstInvalidSamples: [],
    },
    excludedSamples: [],
  };
}

function normalizePickType_(value) {
  const text = String(value || "").toLowerCase().trim();

  if (!text) {
    return "";
  }

  if (text.includes("pick to sort") || text.includes("pick-to-sort") || text.includes("picktosort") || text.includes("sort")) {
    return "pickToSort";
  }

  if (text.includes("full")) {
    return "fullRack";
  }

  if (text.includes("half") || text.includes("haft")) {
    return "halfRack";
  }

  // "Micro Rack" (new Zone_V2 name for EA/FA) maps to the EA category
  if (text.includes("micro")) {
    return "ea";
  }

  if (text === "ea" || text.includes("ea")) {
    return "ea";
  }

  if (text.includes("mezz")) {
    return "mezzanine";
  }

  return "";
}

function toNumber_(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const originalText = String(value || "").trim();
  const lowerText = originalText.toLowerCase();

  if (!originalText || lowerText === "not count" || lowerText === "notcount") {
    return 0;
  }

  const cleanedText = originalText
    .replace(/,/g, "")
    .replace(/%/g, "")
    .trim();

  const directNumber = Number(cleanedText);

  if (Number.isFinite(directNumber)) {
    return directNumber;
  }

  // รองรับค่าที่เป็นข้อความ เช่น "1,234 รายการ" หรือ "180 Pick/Hr"
  const numericMatch = cleanedText.match(/-?\d+(?:\.\d+)?/);

  if (!numericMatch) {
    return 0;
  }

  const number = Number(numericMatch[0]);
  return Number.isFinite(number) ? number : 0;
}

function getDateCandidates_(rawValue, displayValue) {
  const candidates = [];
  addDateCandidate_(candidates, normalizeDate_(rawValue, "DMY"));
  addDateCandidate_(candidates, normalizeDate_(displayValue, "DMY"));
  addDateCandidate_(candidates, normalizeDate_(displayValue, "MDY"));
  addDateCandidate_(candidates, normalizeDate_(rawValue, "MDY"));
  return candidates;
}

function addDateCandidate_(target, date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return;
  }

  const key = formatDateISO_(date);
  const exists = target.some((item) => formatDateISO_(item) === key);

  if (!exists) {
    target.push(date);
  }
}

function normalizeDateCandidateList_(items) {
  const result = [];
  (items || []).forEach((item) => addDateCandidate_(result, normalizeSheetDate_(item, item)));
  return result;
}

function mergeDateCandidateLists_(left, right) {
  const result = normalizeDateCandidateList_(left || []);
  (right || []).forEach((item) => addDateCandidate_(result, normalizeSheetDate_(item, item)));
  return result;
}

function normalizeSheetDate_(rawValue, displayValue) {
  // สำคัญ: ให้ยึด raw Date จาก Google Sheet ก่อน เพราะ display บางไฟล์เป็น M/D/YYYY
  // ถ้า parse display เป็น DMY จะทำให้ 01/07/2026 กลายเป็น 1 ก.ค. ทั้งที่ข้อมูลจริงอาจเป็น 7 ม.ค.
  const rawDate = normalizeDate_(rawValue, "DMY");

  if (rawDate) {
    return rawDate;
  }

  return normalizeDate_(displayValue, "DMY");
}

function normalizeDate_(value, preferredFormat) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  if (typeof value === "number" && Number.isFinite(value) && value > 20000) {
    const millis = Math.round((value - 25569) * 86400 * 1000);
    const parsedSerial = new Date(millis);

    if (!isNaN(parsedSerial.getTime())) {
      return new Date(parsedSerial.getFullYear(), parsedSerial.getMonth(), parsedSerial.getDate());
    }
  }

  const text = String(value || "")
    .trim()
    .replace(/[.]/g, "/")
    .replace(/\s+/g, " ");

  if (!text) {
    return null;
  }

  const datePart = text.split(" ")[0];
  const isoMatch = datePart.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);

  if (isoMatch) {
    return createDate_(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const slashMatch = datePart.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);

  if (slashMatch) {
    const first = Number(slashMatch[1]);
    const second = Number(slashMatch[2]);
    const year = Number(slashMatch[3]);

    if (preferredFormat === "DMY") {
      return createDate_(year, second, first);
    }

    if (preferredFormat === "MDY") {
      return createDate_(year, first, second);
    }

    if (first > 12 && second <= 12) {
      return createDate_(year, second, first);
    }

    if (second > 12 && first <= 12) {
      return createDate_(year, first, second);
    }

    return createDate_(year, second, first);
  }

  const parsed = new Date(text);

  if (!isNaN(parsed.getTime())) {
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  }

  return null;
}

function parseInputDate_(value) {
  return normalizeDate_(value, "input");
}

function formatDateDMY_(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    return "";
  }

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function createDate_(year, month, day) {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  let normalizedYear = year;

  if (normalizedYear < 100) {
    normalizedYear += 2000;
  }

  if (normalizedYear > 2400) {
    normalizedYear -= 543;
  }

  const date = new Date(normalizedYear, month - 1, day);

  if (
    date.getFullYear() !== normalizedYear
      || date.getMonth() !== month - 1
      || date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function round1_(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function isTrue_(value) {
  return String(value || "").toLowerCase() === "true";
}

function jsonOutput_(data, callback) {
  const text = JSON.stringify(data);

  if (isSafeCallbackName_(callback)) {
    return ContentService
      .createTextOutput(`${callback}(${text});`)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(text)
    .setMimeType(ContentService.MimeType.JSON);
}

function isSafeCallbackName_(callback) {
  return /^[A-Za-z_$][0-9A-Za-z_$]*(\.[A-Za-z_$][0-9A-Za-z_$]*)*$/.test(String(callback || ""));
}

function installDashboardRefreshTrigger() {
  const triggers = ScriptApp.getProjectTriggers();

  triggers.forEach((trigger) => {
    const handler = trigger.getHandlerFunction();

    if (handler === "warmDashboardCache") {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger("warmDashboardCache")
    .timeBased()
    .everyMinutes(1)
    .create();

  warmDashboardCache();
}

function warmDashboardCache() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(500)) {
    return;
  }

  try {
    const payload = buildDashboardPayload_("", "");
    saveDashboardPayload_(getCacheKey_("", ""), payload);
  } finally {
    lock.releaseLock();
  }
}
