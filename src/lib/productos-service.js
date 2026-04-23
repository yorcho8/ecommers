import { createClient } from "@libsql/client";
import "dotenv/config";
import { ensureProductVisibilitySchema } from "./product-visibility.js";

function getDb() {
  return createClient({
    url: process.env.ECOMERS_DATABASE_URL,
    authToken: process.env.ECOMERS_AUTH_TOKEN,
  });
}

function parseDateToMs(value) {
  if (!value) return NaN;
  const normalized = String(value).trim().replace(" ", "T");
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : NaN;
}

function buildDiscountFromRow(row, precioBase, nowMs) {
  const valor = row?.Descuento_Valor != null ? Number(row.Descuento_Valor) : null;
  const tipo = String(row?.Descuento_Tipo || "porcentaje").toLowerCase();
  const fechaInicio = row?.Descuento_Fecha_Inicio ? String(row.Descuento_Fecha_Inicio) : "";
  const fechaFin = row?.Descuento_Fecha_Fin ? String(row.Descuento_Fecha_Fin) : "";
  const activo = Number(row?.Descuento_Activo || 0) === 1;

  if (!activo || valor == null || !Number.isFinite(valor) || valor <= 0) return null;

  const inicioMs = parseDateToMs(fechaInicio);
  const finMs = parseDateToMs(fechaFin);
  if (Number.isNaN(inicioMs) || Number.isNaN(finMs) || nowMs < inicioMs || nowMs > finMs) {
    return null;
  }

  let precioFinal = Number(precioBase || 0);
  let porcentaje = 0;

  if (tipo === "monto") {
    precioFinal = Math.max(0, +(precioFinal - valor).toFixed(2));
    porcentaje = precioBase > 0 ? Math.round(((precioBase - precioFinal) / precioBase) * 100) : 0;
  } else {
    porcentaje = Math.round(valor);
    if (!Number.isFinite(porcentaje) || porcentaje <= 0 || porcentaje >= 100) return null;
    precioFinal = +(precioBase * (1 - porcentaje / 100)).toFixed(2);
  }

  if (!(precioFinal < precioBase)) return null;

  return {
    tipo,
    valor,
    porcentaje,
    precioFinal,
  };
}

export async function getProductosParaCarrusel(options = {}) {
  const userId = Number(options?.userId || 0);
  const hasUser = Number.isFinite(userId) && userId > 0;
  const db = getDb();
  await ensureProductVisibilitySchema(db);
  const result = await db.execute(`
    SELECT
      c.Id_Categoria,
      c.Nombre AS CategoriaNombre,
      c.Descripcion AS CategoriaDescripcion,
      c.Imagen_URL AS CategoriaImagenUrl,
      (
        SELECT ip.Url
        FROM ProductoCategoria pc2
        JOIN Imagen_Producto ip ON ip.Id_Producto = pc2.Id_Producto
        JOIN Producto p2 ON p2.Id_Producto = pc2.Id_Producto
        WHERE pc2.Id_Categoria = c.Id_Categoria
          AND COALESCE(p2.Activo, 1) = 1
          AND (${hasUser ? 1 : 0} = 0 OR NOT EXISTS (
            SELECT 1
            FROM ProductoVisibilidadUsuario pvu2
            WHERE pvu2.Id_Producto = p2.Id_Producto
              AND pvu2.Id_Usuario = ${hasUser ? userId : 0}
              AND pvu2.Visible = 0
          ))
        ORDER BY ip.Id_Imagen ASC
        LIMIT 1
      ) AS FallbackImagenUrl,
      (
        SELECT p3.Id_Producto
        FROM ProductoCategoria pc3
        JOIN Producto p3 ON p3.Id_Producto = pc3.Id_Producto
        WHERE pc3.Id_Categoria = c.Id_Categoria
          AND COALESCE(p3.Activo, 1) = 1
          AND (${hasUser ? 1 : 0} = 0 OR NOT EXISTS (
            SELECT 1
            FROM ProductoVisibilidadUsuario pvu3
            WHERE pvu3.Id_Producto = p3.Id_Producto
              AND pvu3.Id_Usuario = ${hasUser ? userId : 0}
              AND pvu3.Visible = 0
          ))
        ORDER BY p3.Id_Producto ASC
        LIMIT 1
      ) AS FallbackProductoId,
      (
        SELECT p5.Division
        FROM ProductoCategoria pc5
        JOIN Producto p5 ON p5.Id_Producto = pc5.Id_Producto
        WHERE pc5.Id_Categoria = c.Id_Categoria
          AND COALESCE(p5.Activo, 1) = 1
        ORDER BY p5.Id_Producto ASC
        LIMIT 1
      ) AS Division,
      (
        SELECT p6.Unidad_Venta
        FROM ProductoCategoria pc6
        JOIN Producto p6 ON p6.Id_Producto = pc6.Id_Producto
        WHERE pc6.Id_Categoria = c.Id_Categoria
          AND COALESCE(p6.Activo, 1) = 1
        ORDER BY p6.Id_Producto ASC
        LIMIT 1
      ) AS UnidadVenta,
      (
        SELECT p7.Especificaciones
        FROM ProductoCategoria pc7
        JOIN Producto p7 ON p7.Id_Producto = pc7.Id_Producto
        WHERE pc7.Id_Categoria = c.Id_Categoria
          AND COALESCE(p7.Activo, 1) = 1
        ORDER BY p7.Id_Producto ASC
        LIMIT 1
      ) AS Especificaciones
    FROM Categoria c
    WHERE EXISTS (
      SELECT 1
      FROM ProductoCategoria pc4
      JOIN Producto p4 ON p4.Id_Producto = pc4.Id_Producto
      WHERE pc4.Id_Categoria = c.Id_Categoria
        AND COALESCE(p4.Activo, 1) = 1
        AND (${hasUser ? 1 : 0} = 0 OR NOT EXISTS (
          SELECT 1
          FROM ProductoVisibilidadUsuario pvu4
          WHERE pvu4.Id_Producto = p4.Id_Producto
            AND pvu4.Id_Usuario = ${hasUser ? userId : 0}
            AND pvu4.Visible = 0
        ))
    )
    ORDER BY c.Nombre ASC
  `);

  const rows = result.rows;
  const productoIds = rows
    .map((r) => r.FallbackProductoId)
    .filter(Boolean)
    .map(Number);

  let variantesMap = {};
  if (productoIds.length > 0) {
    const placeholders = productoIds.map(() => "?").join(",");
    const variantesResult = await db.execute({
      sql: `SELECT Id_Producto, Descripcion, Precio, Stock
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
      });
    }
  }

  return rows.map((row) => {
    const productoId = row.FallbackProductoId ? Number(row.FallbackProductoId) : null;
    return {
      id: productoId ?? Number(row.Id_Categoria),
      nombre: String(row.CategoriaNombre ?? ""),
      descripcion: String(row.CategoriaDescripcion ?? ""),
      imagen: row.CategoriaImagenUrl
        ? String(row.CategoriaImagenUrl)
        : row.FallbackImagenUrl
          ? String(row.FallbackImagenUrl)
          : null,
      categoria: String(row.CategoriaNombre ?? ""),
      categoriaId: row.Id_Categoria ? Number(row.Id_Categoria) : null,
      division: row.Division ? String(row.Division) : null,
      unidadVenta: row.UnidadVenta ? String(row.UnidadVenta) : null,
      especificaciones: row.Especificaciones ? String(row.Especificaciones) : null,
      variantes: productoId ? (variantesMap[productoId] ?? []) : [],
    };
  });
}

export async function getCategoriasParaRutas() {
  const db = getDb();
  const result = await db.execute(`
    SELECT Id_Categoria
    FROM Categoria
    ORDER BY Id_Categoria ASC
  `);

  return result.rows
    .map((row) => Number(row.Id_Categoria))
    .filter((id) => Number.isFinite(id));
}

export async function getProductosPorCategoria(categoriaId, options = {}) {
  const userId = Number(options?.userId || 0);
  const hasUser = Number.isFinite(userId) && userId > 0;
  const db = getDb();
  await ensureProductVisibilitySchema(db);

  const categoriaResult = await db.execute({
    sql: `
      SELECT Id_Categoria, Nombre, Descripcion, Imagen_URL
      FROM Categoria
      WHERE Id_Categoria = ?
      LIMIT 1
    `,
    args: [categoriaId],
  });

  if (!categoriaResult.rows.length) {
    return { categoria: null, productos: [] };
  }

  const productosResult = await db.execute({
    sql: `
      SELECT
        p.Id_Producto,
        p.Nombre,
        p.Descripcion,
        p.Precio,
        p.StockDisponible,
        (
          SELECT ip.Url
          FROM Imagen_Producto ip
          WHERE ip.Id_Producto = p.Id_Producto
          ORDER BY ip.Id_Imagen ASC
          LIMIT 1
        ) AS ImagenUrl
      FROM Producto p
      INNER JOIN ProductoCategoria pc ON pc.Id_Producto = p.Id_Producto
      WHERE pc.Id_Categoria = ?
        AND COALESCE(p.Activo, 1) = 1
        AND (
          ? = 0 OR NOT EXISTS (
            SELECT 1
            FROM ProductoVisibilidadUsuario pvu
            WHERE pvu.Id_Producto = p.Id_Producto
              AND pvu.Id_Usuario = ?
              AND pvu.Visible = 0
          )
        )
      ORDER BY p.Fecha_Creacion DESC, p.Id_Producto DESC
    `,
    args: [categoriaId, hasUser ? 1 : 0, hasUser ? userId : 0],
  });

  const categoriaRow = categoriaResult.rows[0];
  const categoria = {
    id: Number(categoriaRow.Id_Categoria),
    nombre: String(categoriaRow.Nombre ?? ""),
    descripcion: String(categoriaRow.Descripcion ?? ""),
    imagen: categoriaRow.Imagen_URL ? String(categoriaRow.Imagen_URL) : null,
  };

  const productos = productosResult.rows.map((row) => ({
    id: Number(row.Id_Producto),
    nombre: String(row.Nombre ?? ""),
    descripcion: String(row.Descripcion ?? ""),
    precio: row.Precio != null ? Number(row.Precio) : null,
    stockDisponible: row.StockDisponible != null ? Number(row.StockDisponible) : null,
    imagen: row.ImagenUrl ? String(row.ImagenUrl) : null,
  }));

  return { categoria, productos };
}

// ── MODIFICADA: ahora incluye Peso, Division, Unidad_Venta, Especificaciones y variantes ──
export async function getProductoDetalleById(productId, options = {}) {
  const userId = Number(options?.userId || 0);
  const hasUser = Number.isFinite(userId) && userId > 0;
  const db = getDb();
  await ensureProductVisibilitySchema(db);

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
        e.Nombre_Empresa,
        e.Nombre_Comercial,
        (
          SELECT d.Id_Descuento
          FROM Descuento d
          JOIN DescuentoProducto dp ON dp.Id_Descuento = d.Id_Descuento
          WHERE dp.Id_Producto = p.Id_Producto
          ORDER BY d.Fecha_Creacion DESC, d.Id_Descuento DESC
          LIMIT 1
        ) AS Descuento_Id,
        (
          SELECT d.Tipo
          FROM Descuento d
          JOIN DescuentoProducto dp ON dp.Id_Descuento = d.Id_Descuento
          WHERE dp.Id_Producto = p.Id_Producto
          ORDER BY d.Fecha_Creacion DESC, d.Id_Descuento DESC
          LIMIT 1
        ) AS Descuento_Tipo,
        (
          SELECT d.Valor
          FROM Descuento d
          JOIN DescuentoProducto dp ON dp.Id_Descuento = d.Id_Descuento
          WHERE dp.Id_Producto = p.Id_Producto
          ORDER BY d.Fecha_Creacion DESC, d.Id_Descuento DESC
          LIMIT 1
        ) AS Descuento_Valor,
        (
          SELECT d.Fecha_Inicio
          FROM Descuento d
          JOIN DescuentoProducto dp ON dp.Id_Descuento = d.Id_Descuento
          WHERE dp.Id_Producto = p.Id_Producto
          ORDER BY d.Fecha_Creacion DESC, d.Id_Descuento DESC
          LIMIT 1
        ) AS Descuento_Fecha_Inicio,
        (
          SELECT d.Fecha_Fin
          FROM Descuento d
          JOIN DescuentoProducto dp ON dp.Id_Descuento = d.Id_Descuento
          WHERE dp.Id_Producto = p.Id_Producto
          ORDER BY d.Fecha_Creacion DESC, d.Id_Descuento DESC
          LIMIT 1
        ) AS Descuento_Fecha_Fin,
        (
          SELECT d.Activo
          FROM Descuento d
          JOIN DescuentoProducto dp ON dp.Id_Descuento = d.Id_Descuento
          WHERE dp.Id_Producto = p.Id_Producto
          ORDER BY d.Fecha_Creacion DESC, d.Id_Descuento DESC
          LIMIT 1
        ) AS Descuento_Activo,
        c.Nombre       AS CategoriaNombre,
        c.Id_Categoria AS CategoriaId
      FROM Producto p
      LEFT JOIN ProductoCategoria pc ON pc.Id_Producto = p.Id_Producto
      LEFT JOIN Categoria c ON c.Id_Categoria = pc.Id_Categoria
      LEFT JOIN Empresa e ON e.Id_Empresa = p.Id_Empresa
      WHERE p.Id_Producto = ?
        AND COALESCE(p.Activo, 1) = 1
        AND (
          ? = 0 OR NOT EXISTS (
            SELECT 1
            FROM ProductoVisibilidadUsuario pvu
            WHERE pvu.Id_Producto = p.Id_Producto
              AND pvu.Id_Usuario = ?
              AND pvu.Visible = 0
          )
        )
      LIMIT 1
    `,
    args: [productId, hasUser ? 1 : 0, hasUser ? userId : 0],
  });

  if (!result.rows.length) return null;

  const imagesResult = await db.execute({
    sql: `SELECT Url FROM Imagen_Producto WHERE Id_Producto = ? ORDER BY Id_Imagen ASC`,
    args: [productId],
  });

  const variantesResult = await db.execute({
    sql: `
      SELECT Id_Variante, Descripcion, Precio, Stock
      FROM ProductoVariante
      WHERE Id_Producto = ?
      ORDER BY Id_Variante ASC
    `,
    args: [productId],
  });

  const row      = result.rows[0];
  const precioBase = row.Precio != null ? Number(row.Precio) : 0;
  const nowMs = Date.now();
  const descuento = buildDiscountFromRow(row, precioBase, nowMs);
  const imagenes = imagesResult.rows
    .map((r) => String(r.Url || "").trim())
    .filter(Boolean);

  const variantes = variantesResult.rows.map((v) => ({
    id:          Number(v.Id_Variante),
    descripcion: String(v.Descripcion ?? ""),
    precio:      v.Precio != null ? Number(v.Precio) : null,
    stock:       v.Stock  != null ? Number(v.Stock)  : null,
  }));

  return {
    id:               Number(row.Id_Producto),
    nombre:           String(row.Nombre       || ""),
    descripcion:      String(row.Descripcion  || ""),
    precio:           descuento ? Number(descuento.precioFinal) : precioBase,
    precioOriginal:   descuento ? precioBase : null,
    descuento,
    stock:            row.StockDisponible != null ? Number(row.StockDisponible) : 0,
    peso:             row.Peso            != null ? Number(row.Peso)            : null,
    division:         row.Division        ? String(row.Division)        : null,
    unidad_venta:     row.Unidad_Venta    ? String(row.Unidad_Venta)    : null,
    especificaciones: row.Especificaciones ? String(row.Especificaciones) : null,
    categoria:        String(row.CategoriaNombre || "Sin categoria"),
    categoriaId:      row.CategoriaId != null ? Number(row.CategoriaId) : null,
    empresaId:        row.Id_Empresa   != null ? Number(row.Id_Empresa)   : null,
    empresaNombre:    row.Id_Empresa   != null
                        ? String(row.Nombre_Comercial || row.Nombre_Empresa || "")
                        : null,
    imagenes,
    variantes,
  };
}

export async function getTodosLosProductos(options = {}) {
  const userId = Number(options?.userId || 0);
  const hasUser = Number.isFinite(userId) && userId > 0;
  const includeInactive = Boolean(options?.includeInactive);
  const db = getDb();
  await ensureProductVisibilitySchema(db);

  const result = await db.execute({
    sql: `
    SELECT
      p.Id_Producto,
      p.Nombre,
      p.Descripcion,
      p.Precio,
      p.StockDisponible,
      p.Id_Empresa,
      COALESCE(p.Activo, 1) AS Activo,
      p.Fecha_Creacion,
      (
        SELECT ip.Url
        FROM Imagen_Producto ip
        WHERE ip.Id_Producto = p.Id_Producto
        ORDER BY ip.Id_Imagen ASC
        LIMIT 1
      ) AS ImagenUrl,
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
      (
        SELECT d.Id_Descuento
        FROM Descuento d
        JOIN DescuentoProducto dp ON dp.Id_Descuento = d.Id_Descuento
        WHERE dp.Id_Producto = p.Id_Producto
        ORDER BY d.Fecha_Creacion DESC, d.Id_Descuento DESC
        LIMIT 1
      ) AS Descuento_Id,
      (
        SELECT d.Tipo
        FROM Descuento d
        JOIN DescuentoProducto dp ON dp.Id_Descuento = d.Id_Descuento
        WHERE dp.Id_Producto = p.Id_Producto
        ORDER BY d.Fecha_Creacion DESC, d.Id_Descuento DESC
        LIMIT 1
      ) AS Descuento_Tipo,
      (
        SELECT d.Valor
        FROM Descuento d
        JOIN DescuentoProducto dp ON dp.Id_Descuento = d.Id_Descuento
        WHERE dp.Id_Producto = p.Id_Producto
        ORDER BY d.Fecha_Creacion DESC, d.Id_Descuento DESC
        LIMIT 1
      ) AS Descuento_Valor,
      (
        SELECT d.Fecha_Inicio
        FROM Descuento d
        JOIN DescuentoProducto dp ON dp.Id_Descuento = d.Id_Descuento
        WHERE dp.Id_Producto = p.Id_Producto
        ORDER BY d.Fecha_Creacion DESC, d.Id_Descuento DESC
        LIMIT 1
      ) AS Descuento_Fecha_Inicio,
      (
        SELECT d.Fecha_Fin
        FROM Descuento d
        JOIN DescuentoProducto dp ON dp.Id_Descuento = d.Id_Descuento
        WHERE dp.Id_Producto = p.Id_Producto
        ORDER BY d.Fecha_Creacion DESC, d.Id_Descuento DESC
        LIMIT 1
      ) AS Descuento_Fecha_Fin,
      (
        SELECT d.Activo
        FROM Descuento d
        JOIN DescuentoProducto dp ON dp.Id_Descuento = d.Id_Descuento
        WHERE dp.Id_Producto = p.Id_Producto
        ORDER BY d.Fecha_Creacion DESC, d.Id_Descuento DESC
        LIMIT 1
      ) AS Descuento_Activo
    FROM Producto p
    WHERE (
      ? = 1 OR COALESCE(p.Activo, 1) = 1
    )
      AND (
        ? = 0 OR NOT EXISTS (
          SELECT 1
          FROM ProductoVisibilidadUsuario pvu
          WHERE pvu.Id_Producto = p.Id_Producto
            AND pvu.Id_Usuario = ?
            AND pvu.Visible = 0
        )
      )
    ORDER BY p.Fecha_Creacion DESC, p.Id_Producto DESC
  `,
    args: [includeInactive ? 1 : 0, hasUser ? 1 : 0, hasUser ? userId : 0],
  });

  const nowMs = Date.now();

  return result.rows.map((row) => {
    const precioBase = row.Precio != null ? Number(row.Precio) : 0;
    const descuento = buildDiscountFromRow(row, precioBase, nowMs);

    return {
      id: Number(row.Id_Producto),
      nombre: String(row.Nombre ?? ""),
      descripcion: String(row.Descripcion ?? ""),
      precio: descuento ? Number(descuento.precioFinal) : precioBase,
      precioOriginal: descuento ? precioBase : null,
      descuento,
      stock: row.StockDisponible != null ? Number(row.StockDisponible) : 0,
      activo: Number(row.Activo || 0) === 1,
      fechaCreacion: row.Fecha_Creacion,
      imagen: row.ImagenUrl ? String(row.ImagenUrl) : null,
      categoria: row.CategoriaNombre ? String(row.CategoriaNombre) : "Sin categoria",
      categoriaId: row.CategoriaId != null ? Number(row.CategoriaId) : null,
      empresaId: row.Id_Empresa != null ? Number(row.Id_Empresa) : null,
    };
  });
}