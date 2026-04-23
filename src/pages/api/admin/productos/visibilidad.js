import { createClient } from "@libsql/client";
import "dotenv/config";
import { ensureProductVisibilitySchema } from "../../../../lib/product-visibility.js";
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

/** Signed go_session — not the forgeable plain-JSON authSession cookie. */
function getAdminUser(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const user = verifySessionToken(token);
    const role = String(user?.rol || "").toLowerCase();
    return role === "admin" || role === "superusuario" ? user : null;
  } catch {
    return null;
  }
}

export async function GET({ cookies, url }) {
  const admin = getAdminUser(cookies);
  if (!admin) return json({ success: false, error: "Acceso denegado" }, 403);

  try {
    await ensureProductVisibilitySchema(db);
    const userId = Number(url.searchParams.get("userId") || 0);
    const productoId = Number(url.searchParams.get("productoId") || 0);

    let sql = `
      SELECT Id_Producto, Id_Usuario, Visible, Fecha_Actualizacion
      FROM ProductoVisibilidadUsuario
      WHERE 1 = 1
    `;
    const args = [];

    if (Number.isFinite(userId) && userId > 0) {
      sql += " AND Id_Usuario = ?";
      args.push(userId);
    }
    if (Number.isFinite(productoId) && productoId > 0) {
      sql += " AND Id_Producto = ?";
      args.push(productoId);
    }

    sql += " ORDER BY Fecha_Actualizacion DESC";

    const result = await db.execute({ sql, args });
    const reglas = result.rows.map((row) => ({
      productoId: Number(row.Id_Producto),
      userId: Number(row.Id_Usuario),
      visible: Number(row.Visible || 0) === 1,
      updatedAt: String(row.Fecha_Actualizacion || ""),
    }));

    return json({ success: true, reglas });
  } catch (error) {
    console.error("[GET /api/admin/productos/visibilidad] Error:", error);
    return json({ success: false, error: "Error consultando visibilidad" }, 500);
  }
}

export async function PUT({ cookies, request }) {
  const admin = getAdminUser(cookies);
  if (!admin) return json({ success: false, error: "Acceso denegado" }, 403);

  try {
    await ensureProductVisibilitySchema(db);
    const body = await request.json().catch(() => ({}));
    const userId = Number(body?.userId);
    const productoId = Number(body?.productoId);
    const visible = Number(body?.visible ?? 1) === 0 ? 0 : 1;

    if (!Number.isFinite(userId) || userId <= 0 || !Number.isFinite(productoId) || productoId <= 0) {
      return json({ success: false, error: "userId y productoId son obligatorios" }, 400);
    }

    const now = new Date().toISOString();
    await db.execute({
      sql: `
        INSERT INTO ProductoVisibilidadUsuario (Id_Producto, Id_Usuario, Visible, Fecha_Actualizacion)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(Id_Producto, Id_Usuario)
        DO UPDATE SET Visible = excluded.Visible, Fecha_Actualizacion = excluded.Fecha_Actualizacion
      `,
      args: [productoId, userId, visible, now],
    });

    return json({ success: true, message: "Regla de visibilidad guardada", visible: visible === 1 });
  } catch (error) {
    console.error("[PUT /api/admin/productos/visibilidad] Error:", error);
    return json({ success: false, error: "Error guardando visibilidad" }, 500);
  }
}

export async function DELETE({ cookies, request }) {
  const admin = getAdminUser(cookies);
  if (!admin) return json({ success: false, error: "Acceso denegado" }, 403);

  try {
    await ensureProductVisibilitySchema(db);
    const body = await request.json().catch(() => ({}));
    const userId = Number(body?.userId);
    const productoId = Number(body?.productoId);

    if (!Number.isFinite(userId) || userId <= 0 || !Number.isFinite(productoId) || productoId <= 0) {
      return json({ success: false, error: "userId y productoId son obligatorios" }, 400);
    }

    await db.execute({
      sql: "DELETE FROM ProductoVisibilidadUsuario WHERE Id_Producto = ? AND Id_Usuario = ?",
      args: [productoId, userId],
    });

    return json({ success: true, message: "Regla eliminada" });
  } catch (error) {
    console.error("[DELETE /api/admin/productos/visibilidad] Error:", error);
    return json({ success: false, error: "Error eliminando visibilidad" }, 500);
  }
}
