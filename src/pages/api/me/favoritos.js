/**
 * GET  /api/me/favoritos  — Listar favoritos del usuario
 * POST /api/me/favoritos  — Agregar producto a favoritos
 * DELETE /api/me/favoritos?productoId=X  — Quitar de favoritos
 */
import { createClient } from "@libsql/client";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../../lib/session.js";

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

async function ensureSchema() {
  return true;
}

// GET — listar favoritos
export async function GET({ cookies }) {
  const user = getSessionUser(cookies);
  if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);

  try {
    await ensureSchema();

    const result = await db.execute({
      sql: `
        SELECT
          f.Id_Favorito,
          f.Id_Producto,
          f.Fecha_Creacion,
          p.Nombre,
          p.Precio,
          p.StockDisponible,
          COALESCE(p.Activo, 1) AS Activo,
          (
            SELECT ip.Url
            FROM Imagen_Producto ip
            WHERE ip.Id_Producto = p.Id_Producto
            ORDER BY ip.Id_Imagen ASC
            LIMIT 1
          ) AS Imagen
        FROM Favorito f
        JOIN Producto p ON p.Id_Producto = f.Id_Producto
        WHERE f.Id_Usuario = ?
        ORDER BY f.Fecha_Creacion DESC
      `,
      args: [user.userId],
    });

    const favoritos = result.rows.map((row) => ({
      id:             Number(row.Id_Favorito),
      productoId:     Number(row.Id_Producto),
      nombre:         String(row.Nombre || ""),
      precio:         Number(row.Precio || 0),
      stockDisponible: row.StockDisponible == null ? null : Number(row.StockDisponible),
      activo:         Number(row.Activo) === 1,
      imagen:         row.Imagen ? String(row.Imagen) : null,
      fechaAgregado:  String(row.Fecha_Creacion || ""),
    }));

    return json({ success: true, favoritos, total: favoritos.length });
  } catch (error) {
    console.error("[GET /api/me/favoritos] Error:", error);
    return json({ success: false, error: "Error obteniendo favoritos" }, 500);
  }
}

// POST — agregar a favoritos
export async function POST({ request, cookies }) {
  const user = getSessionUser(cookies);
  if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "JSON inválido" }, 400);
  }

  const productoId = Number(body?.productoId);
  if (!Number.isFinite(productoId) || productoId <= 0)
    return json({ success: false, error: "productoId inválido" }, 400);

  try {
    await ensureSchema();

    // Verificar que el producto existe y está activo
    const prodRes = await db.execute({
      sql: `SELECT Id_Producto FROM Producto WHERE Id_Producto = ? AND COALESCE(Activo, 1) = 1 LIMIT 1`,
      args: [productoId],
    });
    if (!prodRes.rows.length)
      return json({ success: false, error: "Producto no encontrado o no disponible" }, 404);

    const now = new Date().toISOString();

    // INSERT OR IGNORE para idempotencia
    await db.execute({
      sql: `INSERT OR IGNORE INTO Favorito (Id_Usuario, Id_Producto, Fecha_Creacion) VALUES (?, ?, ?)`,
      args: [user.userId, productoId, now],
    });

    // Obtener el favorito (existente o recién creado)
    const favRes = await db.execute({
      sql: `SELECT Id_Favorito FROM Favorito WHERE Id_Usuario = ? AND Id_Producto = ? LIMIT 1`,
      args: [user.userId, productoId],
    });

    return json({
      success: true,
      message: "Producto agregado a favoritos",
      favorito: { id: Number(favRes.rows[0]?.Id_Favorito || 0), productoId },
    });
  } catch (error) {
    console.error("[POST /api/me/favoritos] Error:", error);
    return json({ success: false, error: "Error agregando a favoritos" }, 500);
  }
}

// DELETE — quitar de favoritos (por productoId en query string)
export async function DELETE({ request, cookies }) {
  const user = getSessionUser(cookies);
  if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);

  let productoId;
  try {
    const url = new URL(request.url);
    productoId = Number(url.searchParams.get("productoId") || "");
    if (!Number.isFinite(productoId) || productoId <= 0) throw new Error("invalid");
  } catch {
    return json({ success: false, error: "productoId requerido como parámetro de URL" }, 400);
  }

  try {
    await ensureSchema();

    await db.execute({
      sql: `DELETE FROM Favorito WHERE Id_Usuario = ? AND Id_Producto = ?`,
      args: [user.userId, productoId],
    });

    return json({ success: true, message: "Producto eliminado de favoritos" });
  } catch (error) {
    console.error("[DELETE /api/me/favoritos] Error:", error);
    return json({ success: false, error: "Error eliminando de favoritos" }, 500);
  }
}
