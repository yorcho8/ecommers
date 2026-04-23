import { createClient } from "@libsql/client";

export const AD_POSITION_PLANS = {
  hero: { key: "hero", label: "Hero", pricePerDay: 120, defaultPriority: 6 },
  top1: { key: "top1", label: "Top 1", pricePerDay: 70, defaultPriority: 4 },
  grid: { key: "grid", label: "Grid", pricePerDay: 20, defaultPriority: 2 },
};

const VALID_POSITIONS = Object.keys(AD_POSITION_PLANS);

function getDbClient() {
  return createClient({
    url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
    authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
  });
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

export function getPublicidadPlan(position) {
  const key = String(position || "grid").toLowerCase();
  return AD_POSITION_PLANS[key] || AD_POSITION_PLANS.grid;
}

export function calculateCampaignQuote({ position = "grid", days = 1 }) {
  const plan = getPublicidadPlan(position);
  const safeDays = Math.max(1, Math.min(30, Number(days) || 1));
  const subtotal = round2(plan.pricePerDay * safeDays);

  let discountAmount = 0;
  let discountLabel = "";

  // Regla comercial solicitada: 3 dias en grid = 50 MXN (20 * 2.5)
  if (safeDays === 3) {
    const bundled = round2(plan.pricePerDay * 2.5);
    discountAmount = round2(subtotal - bundled);
    discountLabel = "Bundle 3 dias";
  } else if (safeDays >= 7) {
    discountAmount = round2(subtotal * 0.25);
    discountLabel = "Descuento 25%";
  } else if (safeDays >= 5) {
    discountAmount = round2(subtotal * 0.15);
    discountLabel = "Descuento 15%";
  } else if (safeDays >= 4) {
    discountAmount = round2(subtotal * 0.1);
    discountLabel = "Descuento 10%";
  }

  const total = round2(Math.max(0, subtotal - discountAmount));

  return {
    position: plan.key,
    positionLabel: plan.label,
    days: safeDays,
    pricePerDay: plan.pricePerDay,
    subtotal,
    discountAmount,
    discountLabel,
    total,
    defaultPriority: plan.defaultPriority,
  };
}

export function getPublicidadPlansWithExamples() {
  return VALID_POSITIONS.map((key) => {
    const plan = AD_POSITION_PLANS[key];
    return {
      ...plan,
      quote1Day: calculateCampaignQuote({ position: key, days: 1 }),
      quote3Days: calculateCampaignQuote({ position: key, days: 3 }),
      quote7Days: calculateCampaignQuote({ position: key, days: 7 }),
    };
  });
}

export async function ensurePublicidadSchema(db = null) {
  void db;
  return true;
}

export async function expirePublicidadCampaigns(db = null) {
  const client = db || getDbClient();
  const nowIso = new Date().toISOString();
  await client.execute({
    sql: `
      UPDATE PublicidadCampana
      SET Estado = 'vencida', Fecha_Actualizacion = ?
      WHERE Estado = 'activa'
        AND Fecha_Fin IS NOT NULL
        AND Fecha_Fin <= ?
    `,
    args: [nowIso, nowIso],
  });
}

function normalizeSponsoredRow(row) {
  const precioBase = row.Precio == null ? null : Number(row.Precio);
  const descuentoTipo = row.Descuento_Tipo ? String(row.Descuento_Tipo) : null;
  const descuentoValor = row.Descuento_Valor == null ? null : Number(row.Descuento_Valor);
  let descuento = null;

  if (precioBase != null && descuentoTipo && Number.isFinite(descuentoValor) && descuentoValor > 0) {
    const precioFinal =
      descuentoTipo === "porcentaje"
        ? Math.max(0, round2(precioBase * (1 - descuentoValor / 100)))
        : Math.max(0, round2(precioBase - descuentoValor));

    descuento = {
      tipo: descuentoTipo,
      valor: descuentoValor,
      vigente: true,
      precioFinal,
    };
  }

  return {
    campaignId: Number(row.Id_Publicidad),
    id: Number(row.Id_Producto),
    nombre: String(row.Nombre || "Producto patrocinado"),
    descripcion: row.Descripcion ? String(row.Descripcion) : "",
    precio: precioBase,
    montoPagado: Number(row.Monto || 0),
    stock: row.StockDisponible == null ? null : Number(row.StockDisponible),
    imagen: String(row.Imagen || "/images/logo/logo.png"),
    empresaNombre: row.Nombre_Empresa ? String(row.Nombre_Empresa) : "",
    descuento,
    fechaCreacion: row.Fecha_Creacion ? String(row.Fecha_Creacion) : null,
    fechaInicio: row.Fecha_Inicio ? String(row.Fecha_Inicio) : null,
    fechaFin: row.Fecha_Fin ? String(row.Fecha_Fin) : null,
    posicion: String(row.Posicion || "grid"),
    prioridad: Number(row.Prioridad || 1),
  };
}

function toTs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function sortSponsoredByPriority(items) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => {
    const ma = Number(a?.montoPagado || 0);
    const mb = Number(b?.montoPagado || 0);
    if (mb !== ma) return mb - ma;
    const pa = Number(a?.prioridad || 0);
    const pb = Number(b?.prioridad || 0);
    if (pb !== pa) return pb - pa;
    const ca = toTs(a?.fechaCreacion);
    const cb = toTs(b?.fechaCreacion);
    if (cb !== ca) return cb - ca;
    return Number(b?.campaignId || 0) - Number(a?.campaignId || 0);
  });
}

export async function getSponsoredProducts({ gridLimit = 4, db = null } = {}) {
  const client = db || getDbClient();
  await ensurePublicidadSchema(client);
  await expirePublicidadCampaigns(client);

  const safeGridLimit = Math.max(1, Math.min(8, Number(gridLimit) || 4));

  const result = await client.execute({
    sql: `
      SELECT
        pc.Id_Publicidad,
        pc.Id_Producto,
        pc.Monto,
        pc.Fecha_Creacion,
        pc.Fecha_Inicio,
        pc.Fecha_Fin,
        pc.Posicion,
        pc.Prioridad,
        p.Nombre,
        p.Descripcion,
        p.Precio,
        p.StockDisponible,
        (
          SELECT d.Tipo
          FROM Descuento d
          JOIN DescuentoProducto dp ON dp.Id_Descuento = d.Id_Descuento
          WHERE dp.Id_Producto = p.Id_Producto
            AND COALESCE(d.Activo, 1) = 1
            AND d.Fecha_Inicio <= ?
            AND d.Fecha_Fin >= ?
          ORDER BY d.Fecha_Creacion DESC, d.Id_Descuento DESC
          LIMIT 1
        ) AS Descuento_Tipo,
        (
          SELECT d.Valor
          FROM Descuento d
          JOIN DescuentoProducto dp ON dp.Id_Descuento = d.Id_Descuento
          WHERE dp.Id_Producto = p.Id_Producto
            AND COALESCE(d.Activo, 1) = 1
            AND d.Fecha_Inicio <= ?
            AND d.Fecha_Fin >= ?
          ORDER BY d.Fecha_Creacion DESC, d.Id_Descuento DESC
          LIMIT 1
        ) AS Descuento_Valor,
        COALESCE(ip.Url, '/images/logo/logo.png') AS Imagen,
        e.Nombre_Empresa
      FROM PublicidadCampana pc
      JOIN Producto p ON p.Id_Producto = pc.Id_Producto
      LEFT JOIN Empresa e ON e.Id_Empresa = p.Id_Empresa
      LEFT JOIN Imagen_Producto ip ON ip.Id_Producto = p.Id_Producto
      WHERE pc.Estado = 'activa'
        AND COALESCE(p.Activo, 1) = 1
        AND (pc.Fecha_Inicio IS NULL OR pc.Fecha_Inicio <= ?)
        AND (pc.Fecha_Fin IS NULL OR pc.Fecha_Fin > ?)
      GROUP BY pc.Id_Publicidad
      ORDER BY pc.Prioridad DESC, pc.Fecha_Creacion DESC
    `,
    args: [
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  });

  const all = result.rows.map(normalizeSponsoredRow);
  const byPosition = {
    hero: sortSponsoredByPriority(all.filter((item) => item.posicion === "hero")),
    top1: sortSponsoredByPriority(all.filter((item) => item.posicion === "top1")),
    grid: sortSponsoredByPriority(all.filter((item) => item.posicion === "grid")),
  };
  const allSorted = sortSponsoredByPriority(all);

  const hero = byPosition.hero[0] || null;
  const top1 = byPosition.top1[0] || null;
  const grid = byPosition.grid.slice(0, safeGridLimit);

  return {
    hero,
    top1,
    grid,
    all: allSorted,
    allCampaignIds: [hero?.campaignId, top1?.campaignId, ...grid.map((item) => item.campaignId)]
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0),
  };
}

export async function trackPublicidadEvent({ campaignId, tipo, posicion = null, metadata = null, db = null }) {
  const client = db || getDbClient();
  await ensurePublicidadSchema(client);

  const safeCampaignId = Number(campaignId);
  const safeTipo = String(tipo || "").toLowerCase();
  const safePosicion = posicion ? String(posicion).toLowerCase() : null;

  if (!Number.isFinite(safeCampaignId) || safeCampaignId <= 0) return false;
  if (safeTipo !== "impresion" && safeTipo !== "click") return false;
  if (safePosicion && !VALID_POSITIONS.includes(safePosicion)) return false;

  await client.execute({
    sql: `
      INSERT INTO PublicidadEvento (Id_Publicidad, Tipo, Posicion, Metadata, Fecha_Creacion)
      VALUES (?, ?, ?, ?, ?)
    `,
    args: [
      safeCampaignId,
      safeTipo,
      safePosicion,
      metadata ? JSON.stringify(metadata) : null,
      new Date().toISOString(),
    ],
  });

  return true;
}
