import { createClient } from "@libsql/client";
import "dotenv/config";
import { getSessionUser, getSessionUserId } from "../../../../lib/product-visibility.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseDateToMs(value) {
  if (!value) return NaN;
  const normalized = String(value).trim().replace(" ", "T");
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : NaN;
}

async function ensureDiscountSchema() {
  return true;
}

function hasAdminRole(session) {
  const role = String(session?.rol || "").toLowerCase();
  return role === "admin" || role === "superusuario";
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
    args: [userId],
  });
  if (!result.rows.length) return null;
  return Number(result.rows[0].Id_Empresa);
}

async function ensureProductBelongsToCompany(productId, empresaId) {
  const result = await db.execute({
    sql: `
      SELECT Id_Producto
      FROM Producto
      WHERE Id_Producto = ?
        AND COALESCE(Activo, 1) = 1
        AND Id_Empresa = ?
      LIMIT 1
    `,
    args: [productId, empresaId],
  });
  return result.rows.length > 0;
}

export async function GET({ cookies }) {
  const session = getSessionUser(cookies);
  const userId = getSessionUserId(cookies);

  if (!hasAdminRole(session) || !userId) {
    return json({ success: false, error: "Sin permisos" }, 403);
  }

  try {
    await ensureDiscountSchema();

    const empresaId = await getUserCompanyId(userId);
    if (!empresaId) {
      return json({ success: true, productos: [], empresaId: null });
    }

    const result = await db.execute({
      sql: `
        SELECT
          p.Id_Producto,
          p.Nombre,
          p.Precio,
          p.Id_Empresa,
          (
            SELECT ip.Url
            FROM Imagen_Producto ip
            WHERE ip.Id_Producto = p.Id_Producto
            ORDER BY ip.Id_Imagen ASC
            LIMIT 1
          ) AS Imagen,
          (
            SELECT d.Id_Descuento
            FROM Descuento d
            JOIN DescuentoProducto dp ON dp.Id_Descuento = d.Id_Descuento
            WHERE dp.Id_Producto = p.Id_Producto
            ORDER BY d.Fecha_Creacion DESC, d.Id_Descuento DESC
            LIMIT 1
          ) AS Descuento_Id,
          (
            SELECT d.Nombre
            FROM Descuento d
            JOIN DescuentoProducto dp ON dp.Id_Descuento = d.Id_Descuento
            WHERE dp.Id_Producto = p.Id_Producto
            ORDER BY d.Fecha_Creacion DESC, d.Id_Descuento DESC
            LIMIT 1
          ) AS Descuento_Nombre,
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
        WHERE COALESCE(p.Activo, 1) = 1
          AND p.Id_Empresa = ?
        ORDER BY p.Nombre ASC
      `,
      args: [empresaId],
    });

    const nowMs = Date.now();

    const productos = result.rows.map((row) => {
      const precio = Number(row.Precio || 0);
      const valor = row.Descuento_Valor != null ? Number(row.Descuento_Valor) : null;
      const fechaInicio = row.Descuento_Fecha_Inicio ? String(row.Descuento_Fecha_Inicio) : null;
      const fechaFin = row.Descuento_Fecha_Fin ? String(row.Descuento_Fecha_Fin) : null;
      const activo = Number(row.Descuento_Activo || 0) === 1;

      let descuento = null;
      if (valor != null && fechaInicio && fechaFin) {
        const inicioMs = parseDateToMs(fechaInicio);
        const finMs = parseDateToMs(fechaFin);
        const vigente =
          activo &&
          Number.isFinite(inicioMs) &&
          Number.isFinite(finMs) &&
          nowMs >= inicioMs &&
          nowMs <= finMs;

        descuento = {
          id: Number(row.Descuento_Id),
          nombre: String(row.Descuento_Nombre || "Descuento"),
          tipo: String(row.Descuento_Tipo || "porcentaje"),
          valor,
          fechaInicio,
          fechaFin,
          activo,
          vigente,
          precioFinal:
            String(row.Descuento_Tipo || "porcentaje") === "porcentaje"
              ? +(precio * (1 - valor / 100)).toFixed(2)
              : Math.max(0, +(precio - valor).toFixed(2)),
        };
      }

      return {
        id: Number(row.Id_Producto),
        nombre: String(row.Nombre || "Producto"),
        precio,
        empresaId: Number(row.Id_Empresa),
        imagen: row.Imagen ? String(row.Imagen) : null,
        descuento,
      };
    });

    return json({ success: true, productos, empresaId });
  } catch (error) {
    console.error("[GET /api/admin/descuentos] Error:", error);
    return json({ success: false, error: "Error al obtener descuentos" }, 500);
  }
}

export async function POST({ request, cookies }) {
  const session = getSessionUser(cookies);
  const userId = getSessionUserId(cookies);

  if (!hasAdminRole(session) || !userId) {
    return json({ success: false, error: "Sin permisos" }, 403);
  }

  try {
    await ensureDiscountSchema();

    const empresaId = await getUserCompanyId(userId);
    if (!empresaId) {
      return json({ success: false, error: "No se encontro empresa asociada al usuario" }, 400);
    }

    const body = await request.json().catch(() => ({}));
    const idProducto = Number(body?.id_producto || 0);
    const nombre = String(body?.nombre || "").trim() || "Descuento";
    const tipoRaw = String(body?.tipo || "porcentaje").toLowerCase();
    const tipo = tipoRaw === "monto" ? "monto" : "porcentaje";
    const valor = Number(body?.valor);
    const fechaInicioInput = body?.fecha_inicio ? String(body.fecha_inicio) : new Date().toISOString();
    const fechaFinInput = body?.fecha_fin ? String(body.fecha_fin) : "";

    if (!idProducto || !Number.isFinite(valor) || valor <= 0) {
      return json({ success: false, error: "Datos invalidos" }, 400);
    }

    if (tipo === "porcentaje" && (valor <= 0 || valor >= 100)) {
      return json({ success: false, error: "El porcentaje debe ser mayor a 0 y menor a 100" }, 400);
    }

    if (!fechaFinInput) {
      return json({ success: false, error: "La fecha de fin es obligatoria" }, 400);
    }

    const fechaInicio = new Date(fechaInicioInput);
    const fechaFin = new Date(fechaFinInput);

    if (Number.isNaN(fechaInicio.getTime()) || Number.isNaN(fechaFin.getTime())) {
      return json({ success: false, error: "Fechas invalidas" }, 400);
    }

    if (fechaFin < fechaInicio) {
      return json({ success: false, error: "La fecha de fin debe ser mayor o igual a la fecha de inicio" }, 400);
    }

    const belongs = await ensureProductBelongsToCompany(idProducto, empresaId);
    if (!belongs) {
      return json({ success: false, error: "El producto no pertenece a tu empresa" }, 403);
    }

    await db.execute({
      sql: `
        UPDATE Descuento
        SET Activo = 0
        WHERE Id_Descuento IN (
          SELECT dp.Id_Descuento
          FROM DescuentoProducto dp
          JOIN Descuento d ON d.Id_Descuento = dp.Id_Descuento
          WHERE dp.Id_Producto = ?
            AND COALESCE(d.Activo, 1) = 1
        )
      `,
      args: [idProducto],
    });

    const fechaCreacion = new Date().toISOString();
    const insertDiscount = await db.execute({
      sql: `
        INSERT INTO Descuento (Nombre, Tipo, Valor, Fecha_Inicio, Fecha_Fin, Activo, Aplica_A, Fecha_Creacion)
        VALUES (?, ?, ?, ?, ?, 1, 'producto', ?)
      `,
      args: [nombre, tipo, valor, fechaInicio.toISOString(), fechaFin.toISOString(), fechaCreacion],
    });

    const discountId = Number(insertDiscount.lastInsertRowid || 0);

    if (!discountId) {
      return json({ success: false, error: "No se pudo crear el descuento" }, 500);
    }

    await db.execute({
      sql: `INSERT INTO DescuentoProducto (Id_Descuento, Id_Producto) VALUES (?, ?)`,
      args: [discountId, idProducto],
    });

    return json({ success: true, idDescuento: discountId });
  } catch (error) {
    console.error("[POST /api/admin/descuentos] Error:", error);
    return json({ success: false, error: "Error al guardar descuento" }, 500);
  }
}

export async function DELETE({ request, cookies }) {
  const session = getSessionUser(cookies);
  const userId = getSessionUserId(cookies);

  if (!hasAdminRole(session) || !userId) {
    return json({ success: false, error: "Sin permisos" }, 403);
  }

  try {
    await ensureDiscountSchema();

    const empresaId = await getUserCompanyId(userId);
    if (!empresaId) {
      return json({ success: false, error: "No se encontro empresa asociada al usuario" }, 400);
    }

    const body = await request.json().catch(() => ({}));
    const idProducto = Number(body?.id_producto || 0);

    if (!idProducto) {
      return json({ success: false, error: "id_producto es obligatorio" }, 400);
    }

    const belongs = await ensureProductBelongsToCompany(idProducto, empresaId);
    if (!belongs) {
      return json({ success: false, error: "El producto no pertenece a tu empresa" }, 403);
    }

    await db.execute({
      sql: `
        UPDATE Descuento
        SET Activo = 0
        WHERE Id_Descuento IN (
          SELECT dp.Id_Descuento
          FROM DescuentoProducto dp
          WHERE dp.Id_Producto = ?
        )
      `,
      args: [idProducto],
    });

    return json({ success: true });
  } catch (error) {
    console.error("[DELETE /api/admin/descuentos] Error:", error);
    return json({ success: false, error: "Error al eliminar descuento" }, 500);
  }
}
