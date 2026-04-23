/**
 * GET  /api/admin/productos/volumen?productoId=X  — Ver tiers de precio por volumen
 * POST /api/admin/productos/volumen               — Crear tier  { productoId, minQty, discountPct, label }
 * DELETE /api/admin/productos/volumen?id=X        — Eliminar tier
 * PUT /api/admin/productos/volumen?id=X           — Activar/desactivar tier { activo }
 *
 * Auth: admin o superusuario
 */
import { createClient } from "@libsql/client";
import "dotenv/config";
import { ensureVolumePricingSchema } from "../../../../lib/pricing.js";
import { verifySessionToken, SESSION_COOKIE } from "../../../../lib/session.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getAdmin(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const u = verifySessionToken(token);
    const role = String(u?.rol || "").toLowerCase();
    return role === "admin" || role === "superusuario" ? u : null;
  } catch {
    return null;
  }
}

export async function GET({ request, cookies }) {
  if (!getAdmin(cookies)) return json({ success: false, error: "Acceso denegado" }, 403);
  const url = new URL(request.url);
  const productoId = Number(url.searchParams.get("productoId") || "");
  if (!productoId) return json({ success: false, error: "productoId requerido" }, 400);

  try {
    await ensureVolumePricingSchema(db);
    const result = await db.execute({
      sql: `SELECT Id_PrecioVolumen, Min_Cantidad, Descuento_Pct, Label, Activo, Fecha_Creacion
            FROM PrecioVolumen WHERE Id_Producto = ? ORDER BY Min_Cantidad ASC`,
      args: [productoId],
    });
    const tiers = result.rows.map((r) => ({
      id:          Number(r.Id_PrecioVolumen),
      minQty:      Number(r.Min_Cantidad),
      discountPct: Number(r.Descuento_Pct),
      label:       r.Label ? String(r.Label) : null,
      activo:      Number(r.Activo) === 1,
      creado:      String(r.Fecha_Creacion || ""),
    }));
    return json({ success: true, tiers });
  } catch (e) {
    return json({ success: false, error: e?.message || "Error" }, 500);
  }
}

export async function POST({ request, cookies }) {
  if (!getAdmin(cookies)) return json({ success: false, error: "Acceso denegado" }, 403);

  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: "JSON inválido" }, 400); }

  const productoId  = Number(body?.productoId);
  const minQty      = Number(body?.minQty);
  const discountPct = Number(body?.discountPct);
  const label       = body?.label ? String(body.label).trim().slice(0, 80) : null;

  if (!productoId || !Number.isFinite(productoId) || productoId <= 0)
    return json({ success: false, error: "productoId inválido" }, 400);
  if (!Number.isFinite(minQty) || minQty < 2)
    return json({ success: false, error: "minQty debe ser ≥ 2" }, 400);
  if (!Number.isFinite(discountPct) || discountPct <= 0 || discountPct >= 100)
    return json({ success: false, error: "discountPct debe estar entre 0.01 y 99.99" }, 400);

  try {
    await ensureVolumePricingSchema(db);
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO PrecioVolumen (Id_Producto, Min_Cantidad, Descuento_Pct, Label, Activo, Fecha_Creacion)
            VALUES (?, ?, ?, ?, 1, ?)`,
      args: [productoId, minQty, discountPct, label, now],
    });
    const lastId = await db.execute({ sql: "SELECT last_insert_rowid() AS id", args: [] });
    return json({ success: true, id: Number(lastId.rows[0]?.id || 0) });
  } catch (e) {
    return json({ success: false, error: e?.message || "Error creando tier" }, 500);
  }
}

export async function PUT({ request, cookies }) {
  if (!getAdmin(cookies)) return json({ success: false, error: "Acceso denegado" }, 403);
  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id") || "");
  if (!id) return json({ success: false, error: "id requerido" }, 400);

  let body;
  try { body = await request.json(); } catch { return json({ success: false, error: "JSON inválido" }, 400); }

  const activo = body?.activo !== undefined ? (body.activo ? 1 : 0) : null;
  if (activo === null) return json({ success: false, error: "activo requerido" }, 400);

  try {
    await ensureVolumePricingSchema(db);
    await db.execute({ sql: "UPDATE PrecioVolumen SET Activo = ? WHERE Id_PrecioVolumen = ?", args: [activo, id] });
    return json({ success: true });
  } catch (e) {
    return json({ success: false, error: e?.message || "Error" }, 500);
  }
}

export async function DELETE({ request, cookies }) {
  if (!getAdmin(cookies)) return json({ success: false, error: "Acceso denegado" }, 403);
  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id") || "");
  if (!id) return json({ success: false, error: "id requerido" }, 400);

  try {
    await ensureVolumePricingSchema(db);
    await db.execute({ sql: "DELETE FROM PrecioVolumen WHERE Id_PrecioVolumen = ?", args: [id] });
    return json({ success: true });
  } catch (e) {
    return json({ success: false, error: e?.message || "Error" }, 500);
  }
}
