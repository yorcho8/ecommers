import { createClient } from "@libsql/client";
import "dotenv/config";
import {
  ensureProductModerationSchema,
  ensureProductVisibilitySchema,
  normalizeRole,
} from "../../../../lib/product-visibility.js";
import { sendProductReviewDecision } from "../../../../lib/mail.js";
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

function getSessionUser(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
  } catch {
    return null;
  }
}

function isSuperUser(user) {
  const role = normalizeRole(user?.rol);
  return role === "superusuario";
}

export async function GET({ cookies }) {
  const user = getSessionUser(cookies);
  if (!isSuperUser(user)) {
    return json({ success: false, error: "Solo superusuario puede revisar productos." }, 403);
  }

  try {
    await ensureProductVisibilitySchema(db);
    await ensureProductModerationSchema(db);

    const result = await db.execute({
      sql: `SELECT
              p.Id_Producto,
              p.Nombre,
              p.Descripcion,
              p.Precio,
              p.StockDisponible,
              p.Division,
              p.Unidad_Venta,
              p.Fecha_Creacion,
              p.Id_Empresa,
              pm.Estado,
              pm.Fecha_Solicitud,
              pm.Solicitado_Por,
              u.Nombre AS SolicitanteNombre,
              u.Correo AS SolicitanteCorreo,
              e.Nombre_Empresa,
              c.Nombre AS CategoriaNombre,
               p.SKU,
               p.CodigoReferencia,
              (
                SELECT ip.Url
                FROM Imagen_Producto ip
                WHERE ip.Id_Producto = p.Id_Producto
                ORDER BY ip.Id_Imagen ASC
                LIMIT 1
              ) AS ImagenPrincipal
            FROM ProductoModeracion pm
            JOIN Producto p ON p.Id_Producto = pm.Id_Producto
            LEFT JOIN Usuario u ON u.Id = pm.Solicitado_Por
            LEFT JOIN Empresa e ON e.Id_Empresa = p.Id_Empresa
            LEFT JOIN ProductoCategoria pc ON pc.Id_Producto = p.Id_Producto
            LEFT JOIN Categoria c ON c.Id_Categoria = pc.Id_Categoria
            WHERE pm.Estado = 'pendiente'
            ORDER BY pm.Fecha_Solicitud ASC`,
      args: [],
    });

    const productos = result.rows.map((row) => ({
      id: Number(row.Id_Producto),
      nombre: String(row.Nombre || ""),
      descripcion: String(row.Descripcion || ""),
      precio: row.Precio == null ? null : Number(row.Precio),
      stock: row.StockDisponible == null ? 0 : Number(row.StockDisponible),
      division: row.Division ? String(row.Division) : null,
      unidadVenta: row.Unidad_Venta ? String(row.Unidad_Venta) : null,
      categoria: row.CategoriaNombre ? String(row.CategoriaNombre) : null,
      fechaCreacion: row.Fecha_Creacion ? String(row.Fecha_Creacion) : null,
      fechaSolicitud: row.Fecha_Solicitud ? String(row.Fecha_Solicitud) : null,
      imagen: row.ImagenPrincipal ? String(row.ImagenPrincipal) : null,
      empresaId: row.Id_Empresa == null ? null : Number(row.Id_Empresa),
      empresaNombre: row.Nombre_Empresa ? String(row.Nombre_Empresa) : null,
      solicitanteId: row.Solicitado_Por == null ? null : Number(row.Solicitado_Por),
      solicitanteNombre: row.SolicitanteNombre ? String(row.SolicitanteNombre) : null,
      solicitanteCorreo: row.SolicitanteCorreo ? String(row.SolicitanteCorreo) : null,
      estado: String(row.Estado || "pendiente"),
       sku: row.SKU ? String(row.SKU) : null,
       codigoReferencia: row.CodigoReferencia ? String(row.CodigoReferencia) : null,
    }));

    return json({ success: true, productos });
  } catch (error) {
    console.error("[GET /api/admin/productos/aprobaciones]", error);
    return json({ success: false, error: "No se pudieron cargar productos pendientes." }, 500);
  }
}

export async function POST({ cookies, request }) {
  const user = getSessionUser(cookies);
  if (!isSuperUser(user)) {
    return json({ success: false, error: "Solo superusuario puede aprobar o rechazar." }, 403);
  }

  try {
    await ensureProductVisibilitySchema(db);
    await ensureProductModerationSchema(db);

    const body = await request.json().catch(() => ({}));
    const productId = Number(body?.productId || 0);
    const action = String(body?.action || "").toLowerCase().trim();
    const motivo = String(body?.motivo || "").trim();

    if (!Number.isFinite(productId) || productId <= 0) {
      return json({ success: false, error: "ID de producto invalido." }, 400);
    }
    if (action !== "approve" && action !== "reject") {
      return json({ success: false, error: "Accion invalida." }, 400);
    }
    if (action === "reject" && !motivo) {
      return json({ success: false, error: "Debes indicar motivo de rechazo." }, 400);
    }

    const exists = await db.execute({
      sql: `SELECT p.Id_Producto, p.Nombre, pm.Estado,
                   u.Correo AS SolicitanteCorreo,
                   u.Nombre AS SolicitanteNombre
            FROM Producto p
            LEFT JOIN ProductoModeracion pm ON pm.Id_Producto = p.Id_Producto
            LEFT JOIN Usuario u ON u.Id = pm.Solicitado_Por
            WHERE p.Id_Producto = ?
            LIMIT 1`,
      args: [productId],
    });

    if (!exists.rows.length) {
      return json({ success: false, error: "Producto no encontrado." }, 404);
    }

    const currentStatus = String(exists.rows[0].Estado || "").toLowerCase();
    if (currentStatus && currentStatus !== "pendiente") {
      return json({ success: false, error: `Este producto ya fue ${currentStatus}.` }, 409);
    }

    const reviewerId = Number(user?.userId || 0) || null;
    const now = new Date().toISOString();
    const approved = action === "approve";

    await db.execute({
      sql: `INSERT OR REPLACE INTO ProductoModeracion
            (Id_Producto, Estado, Motivo_Rechazo, Solicitado_Por, Revisado_Por, Fecha_Solicitud, Fecha_Revision)
            VALUES (
              ?,
              ?,
              ?,
              COALESCE((SELECT Solicitado_Por FROM ProductoModeracion WHERE Id_Producto = ?), NULL),
              ?,
              COALESCE((SELECT Fecha_Solicitud FROM ProductoModeracion WHERE Id_Producto = ?), ?),
              ?
            )`,
      args: [
        productId,
        approved ? "aprobado" : "rechazado",
        approved ? null : motivo,
        productId,
        reviewerId,
        productId,
        now,
        now,
      ],
    });

    await db.execute({
      sql: `UPDATE Producto SET Activo = ? WHERE Id_Producto = ?`,
      args: [approved ? 1 : 0, productId],
    });

    try {
      await sendProductReviewDecision({
        to: String(exists.rows[0].SolicitanteCorreo || ""),
        requesterName: String(exists.rows[0].SolicitanteNombre || "Administrador"),
        productName: String(exists.rows[0].Nombre || "Producto"),
        approved,
        motivo,
      });
    } catch (mailError) {
      console.error("[POST /api/admin/productos/aprobaciones] notify requester error", mailError);
    }

    return json({
      success: true,
      message: approved ? "Producto aprobado y publicado." : "Producto rechazado y bloqueado.",
      estado: approved ? "aprobado" : "rechazado",
    });
  } catch (error) {
    console.error("[POST /api/admin/productos/aprobaciones]", error);
    return json({ success: false, error: "No se pudo completar la revision." }, 500);
  }
}
