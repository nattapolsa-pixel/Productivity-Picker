/*
 * Pick UOM is calculated in BigQuery.  This small helper deliberately does
 * not load or inspect a browser-side Pack Size master: every aggregate must
 * use the `pick_qty` supplied in the dashboard payload as the final value.
 */
(function(root) {
  function readBigQueryPickQty(value) {
    const units = Number(value);
    return Number.isFinite(units) ? units : 0;
  }

  function detail(pickQty) {
    return {
      units: readBigQueryPickQty(pickQty),
      source: 'bigquery-pick-qty'
    };
  }

  root.PickUnits = Object.freeze({
    calculate: readBigQueryPickQty,
    detail: detail
  });
})(globalThis);
