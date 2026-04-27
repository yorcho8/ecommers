import { createClient } from "@libsql/client";
import 'dotenv/config';
import { ensureProductVisibilitySchema, getSessionUser, getSessionUserId, isPrivileged, normalizeRole } from "../../../lib/product-visibility.js";
import { ensureProductVariantExtendedSchema } from "../../../lib/product-variant-schema.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

export async function GET({ cookies, url }) {
  try {
    await ensureProductVisibilitySchema(db);
    await ensureProductVariantExtendedSchema(db);

    const session = getSessionUser(cookies);
    const sessionUserId = getSessionUserId(cookies);
    const canSeeInactive = isPrivileged(session) && url.searchParams.get("includeInactive") === "1";

    // Pagination
    const page        = Math.max(1, Number(url.searchParams.get("page") || 1));
    const limit       = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50)));
    const offset      = (page - 1) * limit;

    // Filters
    const q           = String(url.searchParams.get("q") || "").trim();
    const categoriaId = Number(url.searchParams.get("categoriaId") || 0);

    const rol = normalizeRole(session?.rol);
    const esSuperAdmin = rol === "superusuario";

    let empresaId = null;
    if (sessionUserId && !esSuperAdmin) {
      try {
        const empresaRes = await db.execute({
          sql: `SELECT Id_Empresa FROM UsuarioEmpresa WHERE Id_Usuario = ? AND Activo = 1 LIMIT 1`,
          args: [sessionUserId],
        });
        if (empresaRes.rows.length) {
          empresaId = Number(empresaRes.rows[0].Id_Empresa);
        }
      } catch (empresaErr) {
        console.warn("[GET /api/productos] No se pudo resolver la empresa del usuario:", empresaErr?.message || empresaErr);
      }
    }

    if (sessionUserId && isPrivileged(session) && !esSuperAdmin && !empresaId) {
      return new Response(
        JSON.stringify({
          success: true,
          productos: [],
          pagination: {
            page,
            limit,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const searchClause = q
      ? `AND (p.Nombre LIKE ? OR p.Descripcion LIKE ? OR p.Division LIKE ?)`
      : "";
    const catClause = categoriaId
      ? `AND EXISTS (SELECT 1 FROM ProductoCategoria pc2 WHERE pc2.Id_Producto = p.Id_Producto AND pc2.Id_Categoria = ?)`
      : "";

    const baseArgs = [
      canSeeInactive ? 1 : 0,
      sessionUserId ? 1 : 0,
      sessionUserId || 0,
      empresaId ? 1 : 0,
      empresaId || 0,
    ];
    if (q) baseArgs.push(`%${q}%`, `%${q}%`, `%${q}%`);
    if (categoriaId) baseArgs.push(categoriaId);

    // Count total for pagination
    const countResult = await db.execute({
      sql: `
        SELECT COUNT(*) AS total
        FROM Producto p
        WHERE (? = 1 OR COALESCE(p.Activo, 1) = 1)
          AND (
            ? = 0 OR NOT EXISTS (
              SELECT 1 FROM ProductoVisibilidadUsuario pvu
              WHERE pvu.Id_Producto = p.Id_Producto
                AND pvu.Id_Usuario = ?
                AND pvu.Visible = 0
            )
          )
          AND (? = 0 OR p.Id_Empresa = ?)
          ${searchClause}
          ${catClause}
      `,
      args: [...baseArgs],
    });
    const totalProductos = Number(countResult.rows[0]?.total || 0);

    const result = await db.execute({
      sql: `
      SELECT
        p.Id_Producto,
        p.Nombre,
        p.Descripcion,
        p.Precio,
        p.StockDisponible,
        p.SKU,
        p.CodigoReferencia,
        COALESCE(p.Activo, 1) AS Activo,
        p.Fecha_Creacion,
        p.Id_Empresa,
        p.Division,
        p.Unidad_Venta,
        p.Especificaciones,
        (
          SELECT ip.Url
          FROM Imagen_Producto ip
          WHERE ip.Id_Producto = p.Id_Producto
          ORDER BY ip.Id_Imagen
          LIMIT 1
        ) AS ImagenUrl,
        (
          SELECT GROUP_CONCAT(img.Url, '\n')
          FROM (
            SELECT ip.Url
            FROM Imagen_Producto ip
            WHERE ip.Id_Producto = p.Id_Producto
            ORDER BY ip.Id_Imagen
          ) img
        ) AS ImagenesUrls,
        (
          SELECT c.Nombre
          FROM Categoria c
          JOIN ProductoCategoria pc ON pc.Id_Categoria = c.Id_Categoria
          WHERE pc.Id_Producto = p.Id_Producto
          LIMIT 1
        ) AS CategoriaNombre,
        (
          SELECT c.Id_Categoria
          FROM Categoria c
          JOIN ProductoCategoria pc ON pc.Id_Categoria = c.Id_Categoria
          WHERE pc.Id_Producto = p.Id_Producto
          LIMIT 1
        ) AS CategoriaId,
        COALESCE((
          SELECT ROUND(AVG(r.Calificacion), 1)
          FROM Resena r
          WHERE r.Id_Producto = p.Id_Producto AND r.Estado = 'activo'
        ), 0) AS CalificacionPromedio,
        COALESCE((
          SELECT COUNT(*)
          FROM Resena r
          WHERE r.Id_Producto = p.Id_Producto AND r.Estado = 'activo'
        ), 0) AS TotalResenas
      FROM Producto p
      WHERE (? = 1 OR COALESCE(p.Activo, 1) = 1)
        AND (
          ? = 0 OR NOT EXISTS (
            SELECT 1
            FROM ProductoVisibilidadUsuario pvu
            WHERE pvu.Id_Producto = p.Id_Producto
              AND pvu.Id_Usuario = ?
              AND pvu.Visible = 0
          )
        )
        AND (? = 0 OR p.Id_Empresa = ?)
        ${searchClause}
        ${catClause}
      ORDER BY p.Fecha_Creacion DESC
      LIMIT ? OFFSET ?
      `,
      args: [...baseArgs, limit, offset],
    });

    // Traer variantes de todos los productos en batch
    const productoIds = result.rows.map((r) => Number(r.Id_Producto));
    let variantesMap = {};
    if (productoIds.length > 0) {
      const placeholders = productoIds.map(() => "?").join(",");
      const variantesResult = await db.execute({
        sql: `SELECT Id_Producto, Descripcion, Precio, Stock, Peso, Especificaciones
              FROM ProductoVariante
              WHERE Id_Producto IN (${placeholders})
              ORDER BY Id_Variante ASC`,
        args: productoIds,
      });
      for (const v of variantesResult.rows) {
        const pid = Number(v.Id_Producto);
        if (!variantesMap[pid]) variantesMap[pid] = [];
        variantesMap[pid].push({
          descripcion: String(v.Descripcion ?? ""),
          precio: v.Precio != null ? Number(v.Precio) : null,
          stock: v.Stock != null ? Number(v.Stock) : null,
          peso: v.Peso != null ? Number(v.Peso) : null,
          especificaciones: v.Especificaciones ? String(v.Especificaciones) : null,
        });
      }
    }

    const productos = result.rows.map((row) => {
      const imagenes = String(row.ImagenesUrls || "")
        .split("\n")
        .map((url) => String(url || "").trim())
        .filter(Boolean);

      const pid = Number(row.Id_Producto);
      return {
        id: pid,
        nombre: row.Nombre,
        descripcion: row.Descripcion,
        sku: row.SKU ? String(row.SKU) : null,
        codigoReferencia: row.CodigoReferencia ? String(row.CodigoReferencia) : null,
        precio: row.Precio,
        stock: row.StockDisponible,
        activo: Number(row.Activo || 0) === 1,
        fechaCreacion: row.Fecha_Creacion,
        empresaId: row.Id_Empresa ?? null,
        imagen: imagenes[0] || row.ImagenUrl || null,
        imagenes,
        categoria: row.CategoriaNombre ?? null,
        categoriaId: row.CategoriaId ?? null,
        division: row.Division ? String(row.Division) : null,
        unidadVenta: row.Unidad_Venta ? String(row.Unidad_Venta) : null,
        especificaciones: row.Especificaciones ? String(row.Especificaciones) : null,
        variantes: variantesMap[pid] ?? [],
        calificacionPromedio: Number(row.CalificacionPromedio || 0),
        totalResenas:         Number(row.TotalResenas || 0),
      };
    });

    const totalPages = Math.ceil(totalProductos / limit);
    return new Response(
      JSON.stringify({
        success: true,
        productos,
        pagination: {
          page,
          limit,
          total:      totalProductos,
          totalPages,
          hasNext:    page < totalPages,
          hasPrev:    page > 1,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[GET /api/productos] Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: 'Error al obtener productos' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}