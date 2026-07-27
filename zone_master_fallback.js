/*
 * Zone master fallback from:
 * https://docs.google.com/spreadsheets/d/1PMnlyYHswnV0nE73Alxh-ocIFtTipB9LMzACdNM9GFs/
 * Sheet: Zone_V2 (gid=375021866)
 * Snapshot: 2026-07-27
 *
 * The Apps Script payload can override these records through meta.zone_master.
 */
(function(root) {
  root.ZONE_MASTER_FALLBACK = Object.freeze({
    AA: { zone: 'AA-AF', typePick: 'Full Rack', owner: 'Max Mart' },
    AB: { zone: 'AA-AF', typePick: 'Full Rack', owner: 'Max Mart' },
    AC: { zone: 'AA-AF', typePick: 'Full Rack', owner: 'Max Mart' },
    AD: { zone: 'AA-AF', typePick: 'Full Rack', owner: 'Max Mart' },
    AE: { zone: 'AA-AF', typePick: 'Full Rack', owner: 'Max Mart' },
    AF: { zone: 'AA-AF', typePick: 'Full Rack', owner: 'Max Mart' },
    AG: { zone: 'AG', typePick: 'Full Rack', owner: 'Punthai' },
    AH: { zone: 'AH-AI', typePick: 'Full Rack', owner: 'Punthai' },
    AI: { zone: 'AH-AI', typePick: 'Full Rack', owner: 'Punthai' },
    AJ: { zone: 'AJ-AK', typePick: 'Full Rack', owner: 'Punthai' },
    AK: { zone: 'AJ-AK', typePick: 'Full Rack', owner: 'Punthai' },
    AL: { zone: 'AL-BL-BM-AM', typePick: 'Full Rack', owner: 'Max Mart' },
    AM: { zone: 'AL-BL-BM-AM', typePick: 'Full Rack', owner: 'Max Mart' },
    AN: { zone: 'AN-CA', typePick: 'Half Rack', owner: 'Max Mart' },
    BE: { zone: 'BE', typePick: 'Pick to Sort', owner: 'Punthai' },
    BG: { zone: 'BG-BH', typePick: 'Half Rack', owner: 'GFA' },
    BH: { zone: 'BG-BH', typePick: 'Half Rack', owner: 'GFA' },
    BI: { zone: 'BI-BK', typePick: 'Half Rack', owner: 'Punthai' },
    BJ: { zone: 'BI-BK', typePick: 'Half Rack', owner: 'Punthai' },
    BK: { zone: 'BI-BK', typePick: 'Half Rack', owner: 'Punthai' },
    BL: { zone: 'AL-BL-BM-AM', typePick: 'Full Rack', owner: 'Max Mart' },
    BM: { zone: 'AL-BL-BM-AM', typePick: 'Full Rack', owner: 'Max Mart' },
    BN: { zone: 'BN-DA', typePick: 'Half Rack', owner: 'Max Mart' },
    CA: { zone: 'AN-CA', typePick: 'Half Rack', owner: 'Max Mart' },
    CB: { zone: 'CB-DB-DC-CC', typePick: 'Half Rack', owner: 'Max Mart' },
    CC: { zone: 'CB-DB-DC-CC', typePick: 'Half Rack', owner: 'Max Mart' },
    CD: { zone: 'CD-CE', typePick: 'Half Rack', owner: 'Max Mart' },
    CE: { zone: 'CD-CE', typePick: 'Half Rack', owner: 'Max Mart' },
    CF: { zone: 'CF-DF', typePick: 'Half Rack', owner: 'Max Mart' },
    DA: { zone: 'BN-DA', typePick: 'Half Rack', owner: 'Max Mart' },
    DB: { zone: 'CB-DB-DC-CC', typePick: 'Half Rack', owner: 'Max Mart' },
    DC: { zone: 'CB-DB-DC-CC', typePick: 'Half Rack', owner: 'Max Mart' },
    DD: { zone: 'DD-DE', typePick: 'Half Rack', owner: 'Max Mart' },
    DE: { zone: 'DD-DE', typePick: 'Half Rack', owner: 'Max Mart' },
    DF: { zone: 'CF-DF', typePick: 'Half Rack', owner: 'Max Mart' },
    EA: { zone: 'EA', typePick: 'Micro Rack', owner: 'Max Mart' },
    FA: { zone: 'FA', typePick: 'Micro Rack', owner: 'Max Mart' },
    HB: { zone: 'HB', typePick: 'Mezzanine', owner: 'Punthai' }
  });
})(typeof window !== 'undefined' ? window : globalThis);
