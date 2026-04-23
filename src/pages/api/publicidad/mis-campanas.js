import { createClient } from "@libsql/client";
import "dotenv/config";
import { ensurePublicidadSchema, expirePublicidadCampaigns } from "../../../lib/publicidad.js";
import { verifySessionToken, SESSION_COOKIE } from "../../../lib/session.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Signed go_session — not the forgeable plain-JSON authSession cookie. */
function getUserFromSession(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
  } catch {
    return null;
  }
}

async function getUserCompanyId(userId) {
  if (!userId) return null;
  const result = await db.execute({
    sql: `
      SELECT Id_Empresa
      FROM UsuarioEmpresa
      WHERE Id_Usuario = ? AND Activo = 1
      ORDER BY Id_UsuarioEmpresa DESC
      LIMIT 1
    `,
    args: [Number(userId)],
  });
  if (!result.rows.length) return null;
  return Number(result.rows[0].Id_Empresa);
}

export async function GET({ cookies }) {
  try {
    await ensurePublicidadSchema(db);
    await expirePublicidadCampaigns(db);

    const user = getUserFromSession(cookies);
    if (!user?.userId) {
      return jsonResponse(401, { success: false, error: "No autenticado" });
    }

    const role = String(user.rol || "").toLowerCase();
    const isSuperAdmin = role === "superusuario";
    const empresaId = isSuperAdmin ? null : await getUserCompanyId(user.userId);

    if (!isSuperAdmin && !empresaId) {
      return jsonResponse(200, { success: true, campaigns: [] });
    }

    const result = await db.execute({
      sql: `
        SELECT
          pc.Id_Publicidad,
          pc.Id_Producto,
          pc.Monto,
          pc.Monto_Bruto,
          pc.Descuento_MXN,
          pc.Posicion,
          pc.Prioridad,
          pc.Moneda,
          pc.Duracion_Dias,
          pc.Fecha_Inicio,
          pc.Fecha_Fin,
          pc.Estado,
          pc.Payment_Intent_Id,
          pc.Fecha_Creacion,
          p.Nombre AS Producto_Nombre,
          COALESCE(ip.Url, '/images/logo/logo.png') AS Imagen,
          (
            SELECT COUNT(1)
            FROM PublicidadEvento pe
            WHERE pe.Id_Publicidad = pc.Id_Publicidad
              AND pe.Tipo = 'impresion'
          ) AS Impresiones,
          (
            SELECT COUNT(1)
            FROM PublicidadEvento pe
            WHERE pe.Id_Publicidad = pc.Id_Publicidad
              AND pe.Tipo = 'click'
          ) AS Clicks
        FROM PublicidadCampana pc
        JOIN Producto p ON p.Id_Producto = pc.Id_Producto
        LEFT JOIN Imagen_Producto ip ON ip.Id_Producto = p.Id_Producto
        WHERE (? = 1 OR pc.Id_Empresa = ?)
        GROUP BY pc.Id_Publicidad
        ORDER BY pc.Fecha_Creacion DESC
      `,
      args: [isSuperAdmin ? 1 : 0, Number(empresaId || 0)],
    });

    const campaigns = result.rows.map((row) => ({
      impresiones: Number(row.Impresiones || 0),
      clicks: Number(row.Clicks || 0),
      ctr:
        Number(row.Impresiones || 0) > 0
          ? Number(((Number(row.Clicks || 0) / Number(row.Impresiones || 1)) * 100).toFixed(2))
          : 0,
      id: Number(row.Id_Publicidad),
      productoId: Number(row.Id_Producto),
      productoNombre: String(row.Producto_Nombre || "Producto"),
      imagen: String(row.Imagen || "/images/logo/logo.png"),
      monto: Number(row.Monto || 0),
      montoBruto: Number(row.Monto_Bruto || row.Monto || 0),
      descuento: Number(row.Descuento_MXN || 0),
      moneda: String(row.Moneda || "MXN"),
      posicion: String(row.Posicion || "grid"),
      prioridad: Number(row.Prioridad || 1),
      duracionDias: Number(row.Duracion_Dias || 1),
      fechaInicio: row.Fecha_Inicio ? String(row.Fecha_Inicio) : null,
      fechaFin: row.Fecha_Fin ? String(row.Fecha_Fin) : null,
      estado: String(row.Estado || "pendiente"),
      paymentIntentId: row.Payment_Intent_Id ? String(row.Payment_Intent_Id) : null,
      fechaCreacion: String(row.Fecha_Creacion || ""),
    }));

    return jsonResponse(200, { success: true, campaigns });
  } catch (error) {
    console.error("[GET /api/publicidad/mis-campanas]", error);
    return jsonResponse(500, { success: false, error: error?.message || "Error interno" });
  }
}
