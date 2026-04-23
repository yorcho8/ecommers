/**
 * GET /api/productos/buscar?q=texto&categoriaId=&page=1&limit=20
 *
 * Búsqueda de productos por nombre, descripción y categoría.
 * Respeta visibilidad por usuario y estado activo.
 */
import { createClient } from "@libsql/client";
import "dotenv/config";
import { getSessionUser, getSessionUserId, ensureProductVisibilitySchema } from "../../../lib/product-visibility.js";
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

    const session    = getSessionUser(cookies);
    const userId     = getSessionUserId(cookies);
    const q          = String(url.searchParams.get("q") || "").trim();
    const categoriaId = Number(url.searchParams.get("categoriaId") || 0) || null;
    const page       = Math.max(1, Number(url.searchParams.get("page") || 1));
    const limit      = Math.min(60, Math.max(1, Number(url.searchParams.get("limit") || 20)));
    const offset     = (page - 1) * limit;

    if (!q && !categoriaId) {
      return json({ success: false, error: "Proporciona al menos un término de búsqueda o categoría" }, 400);
    }

    // Build WHERE clauses dynamically
    const conditions  = ["COALESCE(p.Activo, 1) = 1"];
    const args        = [];

    if (q) {
      const term = `%${q}%`;
      conditions.push(`(
        p.Nombre LIKE ?
        OR p.Descripcion LIKE ?
        OR p.Division LIKE ?
        OR EXISTS (
          SELECT 1 FROM Categoria c
          JOIN ProductoCategoria pc ON pc.Id_Categoria = c.Id_Categoria
          WHERE pc.Id_Producto = p.Id_Producto AND c.Nombre LIKE ?
        )
      )`);
      args.push(term, term, term, term);
    }

    if (categoriaId) {
      conditions.push(`EXISTS (
        SELECT 1 FROM ProductoCategoria pc2
        WHERE pc2.Id_Producto = p.Id_Producto AND pc2.Id_Categoria = ?
      )`);
      args.push(categoriaId);
    }

    // Visibility filter
    if (userId) {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM ProductoVisibilidadUsuario pvu
        WHERE pvu.Id_Producto = p.Id_Producto
          AND pvu.Id_Usuario = ?
          AND pvu.Visible = 0
      )`);
      args.push(userId);
    }

    const where = conditions.join(" AND ");

    // Count total for pagination
    const countResult = await db.execute({
      sql: `SELECT COUNT(*) AS total FROM Producto p WHERE ${where}`,
      args,
    });
    const total = Number(countResult.rows[0]?.total || 0);

    // Main query
    const result = await db.execute({
      sql: `
        SELECT
          p.Id_Producto,
          p.Nombre,
          p.Descripcion,
          p.Precio,
          p.StockDisponible,
          p.Peso,
          p.Division,
          p.Unidad_Venta,
          p.Especificaciones,
          p.Id_Empresa,
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
          (
            SELECT c.Id_Categoria FROM Categoria c
            JOIN ProductoCategoria pc ON pc.Id_Categoria = c.Id_Categoria
            WHERE pc.Id_Producto = p.Id_Producto LIMIT 1
          ) AS CategoriaId,
          COALESCE((
            SELECT ROUND(AVG(r.Calificacion), 1) FROM Resena r
            WHERE r.Id_Producto = p.Id_Producto AND r.Estado = 'activo'
          ), 0) AS CalificacionPromedio,
          COALESCE((
            SELECT COUNT(*) FROM Resena r
            WHERE r.Id_Producto = p.Id_Producto AND r.Estado = 'activo'
          ), 0) AS TotalResenas
        FROM Producto p
        WHERE ${where}
        ORDER BY
          CASE WHEN p.Nombre LIKE ? THEN 0 ELSE 1 END,
          p.Fecha_Creacion DESC
        LIMIT ? OFFSET ?
      `,
      args: [...args, q ? `%${q}%` : "%", limit, offset],
    });

    const productoIds = result.rows.map((r) => Number(r.Id_Producto));
    const discountMap = productoIds.length
      ? await getActiveDiscountMap(db, productoIds)
      : new Map();

    const productos = result.rows.map((row) => {
      const pid    = Number(row.Id_Producto);
      const precio = Number(row.Precio || 0);
      const precioFinal = resolveEffectiveUnitPrice(precio, pid, discountMap);
      const descuento = discountMap.get(pid) || null;

      return {
        id:                 pid,
        nombre:             String(row.Nombre || ""),
        descripcion:        row.Descripcion ? String(row.Descripcion) : null,
        precio:             precio,
        precioFinal:        precioFinal,
        descuento:          descuento ? { tipo: descuento.tipo, valor: descuento.valor } : null,
        stock:              row.StockDisponible != null ? Number(row.StockDisponible) : null,
        imagen:             row.ImagenUrl ? String(row.ImagenUrl) : null,
        categoria:          row.CategoriaNombre ? String(row.CategoriaNombre) : null,
        categoriaId:        row.CategoriaId ?? null,
        empresaId:          row.Id_Empresa ?? null,
        division:           row.Division ? String(row.Division) : null,
        unidadVenta:        row.Unidad_Venta ? String(row.Unidad_Venta) : null,
        calificacionPromedio: Number(row.CalificacionPromedio || 0),
        totalResenas:       Number(row.TotalResenas || 0),
      };
    });

    return json({
      success: true,
      query:   q || null,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext:    page * limit < total,
        hasPrev:    page > 1,
      },
      productos,
    });
  } catch (error) {
    console.error("[GET /api/productos/buscar]", error);
    return json({ success: false, error: "Error en la búsqueda" }, 500);
  }
}
