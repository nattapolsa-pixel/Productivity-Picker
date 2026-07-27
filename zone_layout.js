/*
 * Physical warehouse layout from Google Sheet:
 * https://docs.google.com/spreadsheets/d/1-9_mm6nWY3kvG7WO9q-QZkkIqHqyAQgLL2WLF_O0zRo/
 * Sheet: Layout_Zone (gid=434517284)
 * Snapshot: 2026-07-27
 */
(function(root) {
  root.ZONE_LAYOUT = Object.freeze({
    onFloor: Object.freeze(['AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'PF']),
    selectiveTop: Object.freeze(['BG', 'BH', 'BI', 'BJ', 'BK', 'BL', 'BM', 'BN', 'DA', 'DB', 'DC', 'DD', 'DE', 'DF']),
    selectiveBottom: Object.freeze(['AG', 'AH', 'AI', 'AJ', 'AK', 'AL', 'AM', 'AN', 'CA', 'CB', 'CC', 'CD', 'CE', 'CF']),
    microRack: Object.freeze(['EA', 'FA']),
    topBands: Object.freeze([
      Object.freeze({label:'GFA', start:1, span:2, tone:'gfa'}),
      Object.freeze({label:'PUNTHAI', start:3, span:3, tone:'punthai'}),
      Object.freeze({label:'MAX MART', start:6, span:9, tone:'maxmart'})
    ]),
    bottomBands: Object.freeze([
      Object.freeze({label:'MAX MART', start:1, span:1, tone:'maxmart'}),
      Object.freeze({label:'PUNTHAI', start:2, span:4, tone:'punthai'}),
      Object.freeze({label:'MAX MART', start:6, span:8, tone:'maxmart'}),
      Object.freeze({label:'LUBE', start:14, span:1, tone:'lube'})
    ])
  });
})(typeof window !== 'undefined' ? window : globalThis);
