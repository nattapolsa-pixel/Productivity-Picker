/* Pack Size based pick-unit calculation shared by every dashboard aggregate. */
(function(root) {
  const EPSILON = 1e-9;

  function packSizesForSku(sku) {
    const master = root.PACK_SIZE_MASTER;
    if (!master) throw new Error('ไม่พบ Pack Size master กรุณารีเฟรชหน้าเว็บ');
    const sizes = master[String(sku || '').trim()];
    return Array.isArray(sizes) ? sizes : null;
  }

  function calculateDetail(pieces, sku, fallbackPickQty) {
    const qty = Number(pieces);
    if (!Number.isFinite(qty) || qty <= 0) {
      return { units: 0, packSize: null, source: 'invalid-pieces' };
    }

    const sizes = packSizesForSku(sku);
    if (!sizes || sizes.length === 0) {
      const fallback = Number(fallbackPickQty);
      return {
        units: Number.isFinite(fallback) && fallback > 0 ? fallback : qty,
        packSize: null,
        source: 'missing-pack-size'
      };
    }

    for (const rawSize of sizes) {
      const size = Number(rawSize);
      if (!Number.isFinite(size) || size <= 0 || size > qty + EPSILON) continue;
      const quotient = qty / size;
      const rounded = Math.round(quotient);
      if (Math.abs(quotient - rounded) <= EPSILON) {
        return { units: rounded, packSize: size, source: 'pack-size' };
      }
    }

    return { units: qty, packSize: 1, source: 'base-unit-fallback' };
  }

  root.PickUnits = Object.freeze({
    calculate: function(pieces, sku, fallbackPickQty) {
      return calculateDetail(pieces, sku, fallbackPickQty).units;
    },
    detail: calculateDetail,
    packSizesForSku: packSizesForSku
  });
})(globalThis);
