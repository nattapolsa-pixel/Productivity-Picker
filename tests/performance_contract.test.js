const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'bigquery_to_json.gs'), 'utf8');

assert(!html.includes('xlsx.full.min.js'), 'XLSX must not block the initial page load');
assert(app.includes('function ensureXlsxLoaded()'), 'XLSX must be lazy-loaded by the upload flow');
assert(app.includes('IndexedDB cache: แสดงข้อมูลรอบล่าสุดทันที'), 'Dashboard IndexedDB cache is missing');
assert(app.includes('mode=revision&t='), 'Frontend revision probe is missing');
assert(app.includes('parsePickRowsFromWorksheet'), 'Direct-column worksheet parser is missing');
assert(!app.includes('XLSX.utils.sheet_to_json'), 'Upload parser must not materialize the full worksheet');
assert(app.includes('const pendingLoad = activeLoadPromise;'), 'Post-upload refresh must wait for any pre-MERGE request');
assert(app.includes('const result = await loadData(true);'), 'Post-upload refresh must force one post-MERGE request');

assert(backend.includes("if (mode === 'revision')"), 'Backend revision endpoint is missing');
assert(backend.includes('dataObj.meta.data_revision = revision'), 'Dashboard revision metadata is missing');
assert(backend.includes('function getDashboardRevisionToken_'), 'Revision must detect external data changes');
assert(backend.includes('MASTER_CACHE_TTL * 1000'), 'External-data revision must rotate with the master cache window');
assert(backend.includes('function masterCacheKey_'), 'Master data cache must rotate with the revision window');
assert(backend.includes('SET (source_rows, inserted_rows, updated_rows)'), 'MERGE stats must use one pre-merge scan');
assert(!backend.includes("compression: 'GZIP'"), 'NDJSON must remain parallel-loadable');
assert(!backend.includes('Utilities.gzip('), 'Do not gzip NDJSON; BigQuery cannot parallel-read compressed JSON');
assert(!backend.includes('upload_rows_gzip'), 'Public POST endpoint must not accept compressed browser payloads');

console.log('Performance contract tests passed');
