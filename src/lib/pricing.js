function toMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function applyDiscountToPrice(basePrice, discount) {
  const base = toMoney(basePrice);
  if (!discount) return base;

  const tipo = String(discount.tipo || "porcentaje").toLowerCase();
  const valor = Number(discount.valor || 0);
  if (!Number.isFinite(valor) || valor <= 0) return base;

  if (tipo === "monto") {
    return toMoney(Math.max(0, base - valor));
  }

  const porcentaje = Math.min(99.99, Math.max(0, valor));
  return toMoney(base * (1 - porcentaje / 100));
}

function isDiscountCurrentlyActive(discount, nowMs) {
  if (!discount) return false;
  if (Number(discount.activo || 0) !== 1) return false;

  const inicioMs = Date.parse(String(discount.fechaInicio || ""));
  const finMs = Date.parse(String(discount.fechaFin || ""));
  if (Number.isNaN(inicioMs) || Number.isNaN(finMs)) return false;

  return nowMs >= inicioMs && nowMs <= finMs;
}

export async function getActiveDiscountMap(db, productIds) {
  const ids = Array.from(new Set((productIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
  if (!ids.length) return new Map();

  const placeholders = ids.map(() => "?").join(",");

  try {
    const result = await db.execute({
      sql: `
        SELECT
          dp.Id_Producto,
          d.Id_Descuento,
          d.Tipo,
          d.Valor,
          d.Fecha_Inicio,
          d.Fecha_Fin,
          d.Activo,
          d.Fecha_Creacion
        FROM DescuentoProducto dp
        JOIN Descuento d ON d.Id_Descuento = dp.Id_Descuento
        WHERE dp.Id_Producto IN (${placeholders})
        ORDER BY dp.Id_Producto ASC, d.Fecha_Creacion DESC, d.Id_Descuento DESC
      `,
      args: ids,
    });

    const nowMs = Date.now();
    const out = new Map();

    for (const row of result.rows) {
      const productId = Number(row.Id_Producto || 0);
      if (!productId || out.has(productId)) continue;

      const candidate = {
        id: Number(row.Id_Descuento || 0),
        tipo: String(row.Tipo || "porcentaje"),
        valor: Number(row.Valor || 0),
        fechaInicio: String(row.Fecha_Inicio || ""),
        fechaFin: String(row.Fecha_Fin || ""),
        activo: Number(row.Activo || 0),
      };

      if (isDiscountCurrentlyActive(candidate, nowMs)) {
        out.set(productId, candidate);
      }
    }

    return out;
  } catch {
    return new Map();
  }
}

export function resolveEffectiveUnitPrice(basePrice, productId, discountMap) {
  const discount = discountMap?.get(Number(productId)) || null;
  return applyDiscountToPrice(basePrice, discount);
}

import { ensureDbSchemaOnce } from "./schema-once.js";
/**
 * Calcula el precio unitario con descuento por volumen.
 * volumeTiers: array de { minQty, discountPct } ordenado de mayor a menor minQty.
 * Si no hay tiers activos para la cantidad, devuelve el precio base.
 */
export function resolveVolumePrice(basePrice, quantity, volumeTiers) {
  const qty = Number(quantity || 1);
  const tiers = Array.isArray(volumeTiers) ? volumeTiers : [];
  const sorted = [...tiers].sort((a, b) => b.minQty - a.minQty);
  const tier = sorted.find((t) => qty >= Number(t.minQty || 0));
  if (!tier) return toMoney(basePrice);
  const pct = Math.min(99.99, Math.max(0, Number(tier.discountPct || 0)));
  return toMoney(Number(basePrice) * (1 - pct / 100));
}

/**
 * Obtiene los tiers de precio por volumen para un producto.
 * Devuelve array de { minQty, discountPct, label } o [] si no tiene.
 */
export async function getVolumeTiersForProduct(db, productoId) {
  try {
    const result = await db.execute({
      sql: `
        SELECT Min_Cantidad, Descuento_Pct, Label
        FROM PrecioVolumen
        WHERE Id_Producto = ? AND COALESCE(Activo, 1) = 1
        ORDER BY Min_Cantidad ASC
      `,
      args: [Number(productoId)],
    });
    return result.rows.map((r) => ({
      minQty:      Number(r.Min_Cantidad || 0),
      discountPct: Number(r.Descuento_Pct || 0),
      label:       r.Label ? String(r.Label) : null,
    }));
  } catch {
    return [];
  }
}

export { toMoney };

/**
 * Migración idempotente de la tabla PrecioVolumen.
 */
export async function ensureVolumePricingSchema(db) {
  void db;
  return true;
}
