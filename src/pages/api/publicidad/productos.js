import { createClient } from "@libsql/client";
import "dotenv/config";
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
    const user = getUserFromSession(cookies);
    if (!user?.userId) {
      return jsonResponse(401, { success: false, error: "No autenticado" });
    }

    const role = String(user.rol || "").toLowerCase();
    const isSuperAdmin = role === "superusuario";
    const empresaId = isSuperAdmin ? null : await getUserCompanyId(user.userId);

    if (!isSuperAdmin && !empresaId) {
      return jsonResponse(200, { success: true, products: [] });
    }

    const result = await db.execute({
      sql: isSuperAdmin
        ? `
            SELECT p.Id_Producto, p.Nombre, p.Precio, COALESCE(ip.Url, '/images/logo/logo.png') AS Imagen
            FROM Producto p
            LEFT JOIN Imagen_Producto ip ON ip.Id_Producto = p.Id_Producto
            WHERE COALESCE(p.Activo, 1) = 1
            GROUP BY p.Id_Producto
            ORDER BY p.Fecha_Creacion DESC
            LIMIT 200
          `
        : `
            SELECT p.Id_Producto, p.Nombre, p.Precio, COALESCE(ip.Url, '/images/logo/logo.png') AS Imagen
            FROM Producto p
            LEFT JOIN Imagen_Producto ip ON ip.Id_Producto = p.Id_Producto
            WHERE COALESCE(p.Activo, 1) = 1
              AND p.Id_Empresa = ?
            GROUP BY p.Id_Producto
            ORDER BY p.Fecha_Creacion DESC
            LIMIT 200
          `,
      args: isSuperAdmin ? [] : [Number(empresaId)],
    });

    const products = result.rows.map((row) => ({
      id: Number(row.Id_Producto),
      nombre: String(row.Nombre || "Producto"),
      precio: row.Precio == null ? null : Number(row.Precio),
      imagen: String(row.Imagen || "/images/logo/logo.png"),
    }));

    return jsonResponse(200, { success: true, products });
  } catch (error) {
    console.error("[GET /api/publicidad/productos]", error);
    return jsonResponse(500, { success: false, error: error?.message || "Error interno" });
  }
}
