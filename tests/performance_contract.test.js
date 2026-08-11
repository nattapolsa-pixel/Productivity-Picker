const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'bigquery_to_json.gs'), 'utf8');

assert(!html.includes('xlsx.full.min.js'), 'XLSX must not block the initial page load');
assert(html.includes('app.js?v=20260811-instant-item-exclusion-v54'), 'HTML must cache-bust the instant item exclusion release');
assert(html.includes('data-page="history"') && html.includes('id="historyPage"'), 'Historical V1 page must be reachable from the dashboard');
assert(app.includes("endDate: '2026-07-19'") && app.includes("v2StartDate: '2026-07-20'"),
  'Historical V1 totals must stop before the first reliable V2 shift date');
assert(app.includes('ไม่ถูกนำไปปนกับ Pick Units/UOM'),
  'Historical V1 page must explain that legacy totals are isolated from V2 calculations');
assert(app.includes('productivity: 137.6') && app.includes('ค่าเฉลี่ย Column AF เฉพาะแถวที่ AF &gt; 0'),
  'Historical V1 page must preserve and explain the original AF productivity formula');
assert(app.includes('HISTORICAL_V1_DAILY') && app.includes('id="historyMonthSelect"') && app.includes('id="historyTrend"'),
  'Historical V1 page must provide selectable monthly daily charts');
assert(app.includes('display: context => context.datasetIndex === 1') && app.includes("formatter: value => Number(value).toFixed(1)"),
  'Historical V1 chart must show productivity values on the line points');
assert(app.includes("page === 'history' ? 'none' : 'flex'"), 'V2-only filters must be hidden on the historical page');
assert(app.includes("bar.querySelectorAll('.preset-range-group button').forEach(b => b.onclick"),
  'Date preset handler must remain scoped to All/Weekly/Monthly');
assert(!app.includes('btnCalendarDropdown') && !app.includes('calPopover') && !app.includes('เลือกหลายวัน'),
  'The daily calendar dropdown must be removed from the overview controls');
assert(app.includes("mode === 'day' && datePresetMode === 'all' && latestMonth") &&
  app.includes("daily.filter(d => String(d.date || '').startsWith(latestMonth))"),
  'Overview daily trend must default to the latest data month without changing weekly/monthly trends');
const historicalDailyMatch = app.match(/const HISTORICAL_V1_DAILY = '([^']+)'/);
assert(historicalDailyMatch, 'Historical V1 daily snapshot is missing');
const historicalDaily = historicalDailyMatch[1].split(';').map(value => {
  const [date, total, productivity, productiveRows] = value.split('|');
  return { date, total: Number(total), productivity: Number(productivity), productiveRows: Number(productiveRows) };
});
assert.strictEqual(historicalDaily.length, 184, 'Historical V1 must contain all 184 active days');
assert.strictEqual(historicalDaily.reduce((sum, row) => sum + row.total, 0), 17475482,
  'Historical V1 daily totals must reconcile to the published historical total');
assert.strictEqual(historicalDaily[historicalDaily.length - 1].date, '2026-07-19',
  'Historical V1 daily data must stop before V2 starts');
assert(historicalDaily.every(row => row.productivity > 0 && row.productiveRows > 0),
  'Every historical active day must include V1 productivity evidence');
assert(app.includes('function ensureXlsxLoaded()'), 'XLSX must be lazy-loaded by the upload flow');
assert(app.includes('IndexedDB cache: แสดงข้อมูลรอบล่าสุดทันที'), 'Dashboard IndexedDB cache is missing');
assert(app.includes("'mode=revision&' + dashboardScopeQuery()"), 'Frontend scoped revision probe is missing');
assert(app.includes('parsePickRowsFromWorksheet'), 'Direct-column worksheet parser is missing');
const uploadParserStart = app.indexOf('function parsePickRowsFromWorksheet');
const uploadParserEnd = app.indexOf('function numericValue', uploadParserStart);
assert(uploadParserStart > 0 && !app.slice(uploadParserStart, uploadParserEnd).includes('XLSX.utils.sheet_to_json'),
  'Pick Detail upload parser must not materialize the full worksheet');
assert(app.includes('const pendingLoad = activeLoadPromise;'), 'Post-upload refresh must wait for any pre-MERGE request');
assert(app.includes('const result = await loadData(true);'), 'Post-upload refresh must force one post-MERGE request');
assert(app.includes('retry.onclick = () => loadData(false)'), 'Retry after timeout must reuse a completed server cache');
assert(app.includes('30 * 24 * 60 * 60 * 1000'), 'Last-known-good dashboard cache must survive normal gaps between visits');
assert(app.includes("DASHBOARD_SCHEMA_VERSION = 'pick-units-v13-24h-shift-cutoff'"), 'Frontend must use the 24-hour shift payload');
assert(app.includes('packedItemRowData') && app.includes('packedSlotRowData'), 'Frontend cube readers are missing');
assert(app.includes("'mode=picker_items'"), 'Picker SKU detail must load lazily instead of bloating the initial payload');
assert(app.includes('loadPickerItemsForDrilldown'), 'Picker SKU lazy loader is missing');
assert(app.includes("'mode=item_cube'"), 'Item detail must load lazily instead of bloating the initial payload');
assert(app.includes('loadCurrentItemCube'), 'Item cube lazy loader is missing');
assert(html.includes('id="itemLoadStatus"') && app.includes('const itemCubeReady = hasCurrentItemCube();'),
  'Items page must guard rendering while a new scoped item cube is loading');
assert(app.includes('กำลังอัปเดตข้อมูลหลังเปลี่ยนรายการยกเว้น') && app.includes('if (itemChartBox) itemChartBox.style.display = \'none\''),
  'Items page must not show zero charts or zero master rows during exclusion refresh');
assert(app.includes('function scheduleExclusionBackgroundRefresh()') && app.includes('}, 700);'),
  'Exclusion changes must debounce the background BigQuery refresh');
assert(app.includes('// Item Cube เก็บข้อมูลเต็มและกรอง Exclude ใน Browser') &&
  !app.includes("dashboardResponseEncodingQuery(),\n        dashboardScopeQuery(),\n        't=' + Date.now()"),
  'Item Cube must be exclusion-independent so item clicks can render instantly');
assert(app.includes('render();\n  // รวมหลายคลิกติดกันเป็นการ Sync BigQuery เพียงรอบเดียว'),
  'Item exclusion must render locally before background synchronization');
assert(app.includes('const masterPromise = loadItemMaster(false);') && app.includes('masterPromise\n      ]'),
  'Item Master and Item Cube must load concurrently');
assert(app.includes('void Promise.all([\n    loadItemMaster(force),\n    loadCurrentItemCube(force, sys)'),
  'Current-system item preload must start immediately after the main dashboard is ready');
assert(app.includes('canonicalCubeScope') && app.includes('writeDashboardCubeCache'), 'Full-range item/time cubes must persist across reloads');
assert(app.includes("'mode=slot_cube'"), 'Time-slot detail must load lazily instead of bloating the initial payload');
assert(app.includes('loadCurrentSlotCube') && app.includes('fetchDailySlotCube'), 'Time-slot daily lazy loader is missing');
assert(app.includes('fetchWithTransientRetry'), 'Transient Apps Script failures must retry automatically');
assert(app.includes('fetchDashboardCubeJson') && app.includes('DATA_EPOCH_CHANGED') && app.includes('DASHBOARD_UPDATE_BUSY'),
  'Transient atomic-bundle conflicts must retry automatically');
assert(app.includes("return await loadDataOnce(force, transientAttempt + 1)"),
  'A changed data epoch must restart the complete atomic bundle automatically');
assert(app.includes('ensureDashboardBundleReady') && app.includes('earlyCubePromise = Promise.all'), 'Main, Item and Time cubes must become ready atomically');
assert(app.includes("String(payload.data_epoch || '') === String(expectedEpoch || '')"), 'Item and Time cubes must match the main dashboard data epoch');
assert(app.includes("String(j && j.meta && j.meta.data_revision || '') !== requestedRevision"), 'Main payload must match the revision that started the atomic load');
assert(app.includes('if (!itemPayload || !slotPayload)') && app.includes('const nextSystem = b.dataset.sys'), 'System switch must not expose a partial bundle');
assert(app.includes("action: 'upload_chunk_csv'") && app.includes("action: 'upload_commit'"), 'Large files must use retry-safe chunk upload');
assert(app.includes('UPLOAD_CHUNK_CONCURRENCY = 2'), 'Upload concurrency must stay bounded');
assert(app.includes("payload.encoding === 'gzip-base64-v1'"), 'Browser must decode compact cached dashboard responses');

assert(backend.includes("if (mode === 'revision')"), 'Backend revision endpoint is missing');
assert(backend.includes('getOrLoadDashboardBounds_()'), 'Revision endpoint must recover missing dashboard date bounds');
assert(backend.includes('dashboardBoundsSql_()') && backend.includes('MIN(shift_date)') && backend.includes('RECENT_DAYS'), 'Dashboard bounds must match the recent shifted-date window');
assert(backend.includes('dataObj.meta.data_revision = revision'), 'Dashboard revision metadata is missing');
assert(backend.includes('function getDashboardRevisionToken_'), 'Revision must detect external data changes');
assert(backend.includes('MASTER_CACHE_TTL * 1000'), 'External-data revision must rotate with the master cache window');
assert(backend.includes('function masterCacheKey_'), 'Master data cache must rotate with the revision window');
assert(backend.includes('const BQ_RESULT_PAGE_ROWS = 30000'), 'BigQuery cube paging must use the fastest memory-safe page size from the live benchmark');
assert(backend.includes('const pageSize = BQ_RESULT_PAGE_ROWS'), 'Dashboard query must use the optimized BigQuery page size');
assert(backend.includes('const cachedAfterWait = getCached_(revision)'), 'Concurrent cache misses must share the first completed dashboard build');
assert(backend.includes('dashboardBuildLock.tryLock(90000)'), 'Dashboard build must prevent a BigQuery thundering herd');
assert(!backend.includes("SELECT 'W' AS cube_type") && !backend.includes("SELECT 'I'") && !backend.includes("SELECT 'S'"), 'Initial backend payload must contain only the work cube');
assert(backend.includes("if (mode === 'picker_items')") && backend.includes('buildPickerItemsData_'), 'Backend picker SKU detail endpoint is missing');
assert(backend.includes("if (mode === 'item_cube')") && backend.includes('buildItemCubeData_'), 'Backend item cube lazy endpoint is missing');
assert(backend.includes("if (mode === 'slot_cube')") && backend.includes('buildSlotCubeData_'), 'Backend time-slot cube lazy endpoint is missing');
assert(backend.includes("DASHBOARD_SCHEMA_VERSION = 'pick-units-v13-24h-shift-cutoff'"), 'Backend must publish the 24-hour shift schema');
assert(backend.includes('const CACHE_CODEC = \'gzip-base64-v1\'') && backend.includes('Utilities.gzip('), 'Dashboard cache must be compressed before chunking');
assert(backend.includes('getCachedEncoded_') && backend.includes('gzipEnvelope_'), 'Backend must serve cached cubes without inflating them first');
assert(backend.includes("DASHBOARD_CACHE_FORMAT_VERSION = 'speed-v9-24h-shift-cutoff'"), '24-hour shift payloads must rotate the backend cache format');
assert(backend.includes('buildItemCubeData_(e, itemEpoch)') && backend.includes('buildSlotCubeData_(e, requestScope, slotEpoch)'),
  'Cube epoch must be captured before the BigQuery query starts');
assert(backend.includes('function assertDashboardDataEpochStable_') &&
  backend.includes('getDashboardRevisionToken_(getDataRevision_(), requestScope.key) !== revision'),
  'Dashboard queries must reject data that changes while a bundle is loading');
assert((backend.match(/assertDashboardDataEpochStable_\(expectedEpoch\);/g) || []).length >= 2,
  'Lazy cube queries must verify the data epoch after querying');
assert(backend.includes("AND pick_date BETWEEN DATE '") && backend.includes('DATE_ADD(DATE '), 'Daily cube queries must prune BigQuery partitions');
assert(backend.includes('SET (source_rows, inserted_rows, updated_rows)'), 'MERGE stats must use one pre-merge scan');
assert(backend.includes("postData.action === 'upload_chunk'") && backend.includes("postData.action === 'upload_commit'"), 'Backend chunk upload actions are missing');
assert(backend.includes("writeDisposition: writeDisposition || 'WRITE_EMPTY'"), 'Chunk retry must safely overwrite only its own stage table');
assert(backend.includes('consolidateUploadChunks_') && backend.includes('DUPLICATE_KEY_CONFLICT'), 'Commit must verify all chunks before one Merge');
assert(backend.includes('setUploadChunkManifest_') && backend.includes('CHUNK_HASH_MISMATCH') &&
  backend.includes('uploadChunkCanonicalRowSql_') && backend.includes('contentHash'),
  'Commit must verify every chunk count and full-row content hash');
assert(backend.includes('persistUploadReceipt_') && backend.includes('PropertiesService.getScriptProperties().setProperty'), 'Successful commit receipt must survive CacheService eviction');
assert(backend.includes('persistUploadReceiptToBigQuery_') && backend.includes('UPLOAD_RECEIPT_TABLE'),
  'Successful commits must keep a durable BigQuery receipt for exactly-once acknowledgement');
assert(app.includes("'QUERY_FAILED'") && app.includes("'LOAD_TIMEOUT'") &&
  app.includes("'LOAD_JOB_FAILED'") && app.includes("'MERGE_RESULT_MISSING'"),
  'Retry-safe transient BigQuery upload failures must retry automatically');
assert(!backend.includes('Dashboard table refresh after upload failed (non-fatal)'), 'Revision must not advance when dashboard refresh fails');
assert(!backend.includes("compression: 'GZIP'"), 'NDJSON must remain parallel-loadable');
assert(!backend.includes('upload_rows_gzip'), 'Public POST endpoint must not accept compressed browser payloads');
assert(!/included AS \([\s\S]*?SELECT \* FROM base WHERE TRUE[\s\S]*?'\),',\s*"SELECT category/.test(backend),
  'Dashboard summary query must not leave a trailing comma after the final CTE');

console.log('Performance contract tests passed');
