/**
 * GET /api/productos/relacionados?productoId=&limit=6
 *
 * Devuelve productos de la misma categoría, excluyendo el producto actual.
 * Respeta visibilidad por usuario y estado activo.
 * Incluye calificación promedio y descuentos activos.
 */
import { createClient } from "@libsql/client";
import "dotenv/config";
import { getSessionUserId, ensureProductVisibilitySchema } from "../../../lib/product-visibility.js";
import { getActiveDiscountMap, resolveEffectiveUnitPrice } from "../../../lib/pricing.js";

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

export async function GET({ url, cookies }) {
  try {
    await ensureProductVisibilitySchema(db);

    const productoId = Number(url.searchParams.get("productoId") || 0);
    const limit      = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") || 6)));
    const userId     = getSessionUserId(cookies);

    if (!Number.isFinite(productoId) || productoId <= 0) {
      return json({ success: false, error: "productoId inválido" }, 400);
    }

    // Get categories of the base product
    const catResult = await db.execute({
      sql: `SELECT Id_Categoria FROM ProductoCategoria WHERE Id_Producto = ?`,
      args: [productoId],
    });

    if (!catResult.rows.length) {
      return json({ success: true, productos: [] });
    }

    const categoriaIds = catResult.rows.map((r) => Number(r.Id_Categoria));
    const placeholders = categoriaIds.map(() => "?").join(",");

    const visibilityClause = userId
      ? `AND NOT EXISTS (
           SELECT 1 FROM ProductoVisibilidadUsuario pvu
           WHERE pvu.Id_Producto = p.Id_Producto
             AND pvu.Id_Usuario = ?
             AND pvu.Visible = 0
         )`
      : "";

    const args = [...categoriaIds, productoId];
    if (userId) args.push(userId);
    args.push(limit);

    const result = await db.execute({
      sql: `
        SELECT DISTINCT
          p.Id_Producto,
          p.Nombre,
          p.Descripcion,
          p.Precio,
          p.StockDisponible,
          p.Division,
          p.Unidad_Venta,
          (
            SELECT ip.Url FROM Imagen_Producto ip
            WHERE ip.Id_Producto = p.Id_Producto
            ORDER BY ip.Id_Imagen LIMIT 1
          ) AS ImagenUrl,
          (
            SELECT c.Nombre FROM Categoria c
            JOIN ProductoCategoria pc ON pc.Id_Categoria = c.Id_Categoria
            WHERE pc.Id_Producto = p.Id_Producto LIMIT 1
          ) AS CategoriaNombre,
          COALESCE((
            SELECT ROUND(AVG(r.Calificacion), 1) FROM Resena r
            WHERE r.Id_Producto = p.Id_Producto AND r.Estado = 'activo'
          ), 0) AS CalificacionPromedio,
          COALESCE((
            SELECT COUNT(*) FROM Resena r
            WHERE r.Id_Producto = p.Id_Producto AND r.Estado = 'activo'
          ), 0) AS TotalResenas
        FROM Producto p
        JOIN ProductoCategoria pc3 ON pc3.Id_Producto = p.Id_Producto
        WHERE pc3.Id_Categoria IN (${placeholders})
          AND p.Id_Producto != ?
          AND COALESCE(p.Activo, 1) = 1
          ${visibilityClause}
        ORDER BY CalificacionPromedio DESC, p.Fecha_Creacion DESC
        LIMIT ?
      `,
      args,
    });

    const ids = result.rows.map((r) => Number(r.Id_Producto));
    const discountMap = ids.length ? await getActiveDiscountMap(db, ids) : new Map();

    const productos = result.rows.map((row) => {
      const pid      = Number(row.Id_Producto);
      const precio   = Number(row.Precio || 0);
      const precioFinal = resolveEffectiveUnitPrice(precio, pid, discountMap);
      const descuento = discountMap.get(pid) || null;

      return {
        id:                   pid,
        nombre:               String(row.Nombre || ""),
        descripcion:          row.Descripcion ? String(row.Descripcion) : null,
        precio,
        precioFinal,
        descuento:            descuento ? { tipo: descuento.tipo, valor: descuento.valor } : null,
        stock:                row.StockDisponible != null ? Number(row.StockDisponible) : null,
        imagen:               row.ImagenUrl ? String(row.ImagenUrl) : null,
        categoria:            row.CategoriaNombre ? String(row.CategoriaNombre) : null,
        division:             row.Division ? String(row.Division) : null,
        unidadVenta:          row.Unidad_Venta ? String(row.Unidad_Venta) : null,
        calificacionPromedio: Number(row.CalificacionPromedio || 0),
        totalResenas:         Number(row.TotalResenas || 0),
      };
    });

    return json({ success: true, productos });
  } catch (error) {
    console.error("[GET /api/productos/relacionados]", error);
    return json({ success: false, error: "Error obteniendo productos relacionados" }, 500);
  }
}
