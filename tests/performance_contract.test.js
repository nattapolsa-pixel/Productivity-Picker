const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'bigquery_to_json.gs'), 'utf8');

assert(!html.includes('xlsx.full.min.js'), 'XLSX must not block the initial page load');
assert(html.includes('app.js?v=20260803-lazy-cubes-v6'), 'HTML must cache-bust the lazy cube frontend release');
assert(app.includes('function ensureXlsxLoaded()'), 'XLSX must be lazy-loaded by the upload flow');
assert(app.includes('IndexedDB cache: แสดงข้อมูลรอบล่าสุดทันที'), 'Dashboard IndexedDB cache is missing');
assert(app.includes("'mode=revision&' + dashboardScopeQuery()"), 'Frontend scoped revision probe is missing');
assert(app.includes('parsePickRowsFromWorksheet'), 'Direct-column worksheet parser is missing');
assert(!app.includes('XLSX.utils.sheet_to_json'), 'Upload parser must not materialize the full worksheet');
assert(app.includes('const pendingLoad = activeLoadPromise;'), 'Post-upload refresh must wait for any pre-MERGE request');
assert(app.includes('const result = await loadData(true);'), 'Post-upload refresh must force one post-MERGE request');
assert(app.includes('retry.onclick = () => loadData(false)'), 'Retry after timeout must reuse a completed server cache');
assert(app.includes('30 * 24 * 60 * 60 * 1000'), 'Last-known-good dashboard cache must survive normal gaps between visits');
assert(app.includes("DASHBOARD_SCHEMA_VERSION = 'pick-units-v6-lazy-cubes'"), 'Frontend must use the lazy compact cube payload');
assert(app.includes('packedItemRowData') && app.includes('packedSlotRowData'), 'Frontend cube readers are missing');
assert(app.includes("'mode=picker_items'"), 'Picker SKU detail must load lazily instead of bloating the initial payload');
assert(app.includes('loadPickerItemsForDrilldown'), 'Picker SKU lazy loader is missing');
assert(app.includes("'mode=item_cube'"), 'Item detail must load lazily instead of bloating the initial payload');
assert(app.includes('loadCurrentItemCube'), 'Item cube lazy loader is missing');
assert(app.includes('fetchWithTransientRetry'), 'Transient Apps Script failures must retry automatically');

assert(backend.includes("if (mode === 'revision')"), 'Backend revision endpoint is missing');
assert(backend.includes('dataObj.meta.data_revision = revision'), 'Dashboard revision metadata is missing');
assert(backend.includes('function getDashboardRevisionToken_'), 'Revision must detect external data changes');
assert(backend.includes('MASTER_CACHE_TTL * 1000'), 'External-data revision must rotate with the master cache window');
assert(backend.includes('function masterCacheKey_'), 'Master data cache must rotate with the revision window');
assert(backend.includes('const BQ_RESULT_PAGE_ROWS = 30000'), 'BigQuery cube paging must use the fastest memory-safe page size from the live benchmark');
assert(backend.includes('const pageSize = BQ_RESULT_PAGE_ROWS'), 'Dashboard query must use the optimized BigQuery page size');
assert(backend.includes('const cachedAfterWait = getCached_(revision)'), 'Concurrent cache misses must share the first completed dashboard build');
assert(backend.includes('dashboardBuildLock.tryLock(90000)'), 'Dashboard build must prevent a BigQuery thundering herd');
assert(backend.includes("SELECT 'W' AS cube_type") && !backend.includes("SELECT 'I'") && backend.includes("SELECT 'S'"), 'Initial backend payload must include only work and time-slot cubes');
assert(backend.includes("if (mode === 'picker_items')") && backend.includes('buildPickerItemsData_'), 'Backend picker SKU detail endpoint is missing');
assert(backend.includes("if (mode === 'item_cube')") && backend.includes('buildItemCubeData_'), 'Backend item cube lazy endpoint is missing');
assert(backend.includes("DASHBOARD_SCHEMA_VERSION = 'pick-units-v6-lazy-cubes'"), 'Backend must publish the lazy compact cube schema');
assert(backend.includes('SET (source_rows, inserted_rows, updated_rows)'), 'MERGE stats must use one pre-merge scan');
assert(!backend.includes("compression: 'GZIP'"), 'NDJSON must remain parallel-loadable');
assert(!backend.includes('Utilities.gzip('), 'Do not gzip NDJSON; BigQuery cannot parallel-read compressed JSON');
assert(!backend.includes('upload_rows_gzip'), 'Public POST endpoint must not accept compressed browser payloads');

console.log('Performance contract tests passed');
