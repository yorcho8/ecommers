import { createClient } from "@libsql/client";
import "dotenv/config";
import { ensureProductModerationSchema, ensureProductVisibilitySchema, normalizeRole } from "../../../../lib/product-visibility.js";
import { ensureProductVariantExtendedSchema } from "../../../../lib/product-variant-schema.js";
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

function parseSpecs(specValue) {
  if (!specValue) return null;
  try {
    return typeof specValue === "string" ? JSON.parse(specValue) : specValue;
  } catch {
    return null;
  }
}

function validateExactDimensions(specObj) {
  const dims = specObj?.dimensiones;
  if (!dims) return { ok: true };
  const largo = Number(dims.largo);
  const ancho = Number(dims.ancho);
  const grosor = Number(dims.grosor);
  if (!Number.isFinite(largo) || largo <= 0 || !Number.isFinite(ancho) || ancho <= 0 || !Number.isFinite(grosor) || grosor <= 0) {
    return { ok: false, error: "Largo, ancho y grosor deben ser valores exactos mayores a 0." };
  }
  return { ok: true };
}

function validateVariantsDistinctPrices(variantes) {
  if (!Array.isArray(variantes) || variantes.length === 0) return { ok: true };
  const filtered = variantes.filter((v) => String(v?.descripcion || "").trim());
  for (const v of filtered) {
    const n = Number(v?.precio);
    if (v?.precio == null || v?.precio === "" || !Number.isFinite(n) || n <= 0) {
      return { ok: false, error: `La variante "${String(v?.descripcion || "").trim()}" requiere un precio mayor a 0.` };
    }
    const s = Number(v?.stock);
    if (v?.stock == null || v?.stock === "" || !Number.isFinite(s) || s < 0) {
      return { ok: false, error: `La variante "${String(v?.descripcion || "").trim()}" requiere stock (mínimo 0).` };
    }
  }
  return { ok: true };
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

async function getModerationState(productId) {
  const result = await db.execute({
    sql: "SELECT Estado FROM ProductoModeracion WHERE Id_Producto = ? LIMIT 1",
    args: [productId],
  });
  if (!result.rows.length) return null;
  return String(result.rows[0].Estado || "").toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT — actualizar producto completo
// ─────────────────────────────────────────────────────────────────────────────
export async function PUT({ params, request, cookies }) {
  const admin = getAdminUser(cookies);
  if (!admin) return json({ success: false, error: "Acceso denegado" }, 403);

  const id = Number(params?.id);
  if (!Number.isFinite(id) || id <= 0) {
    return json({ success: false, error: "ID de producto inválido" }, 400);
  }

  try {
    await ensureProductVisibilitySchema(db);
    await ensureProductModerationSchema(db);
    await ensureProductVariantExtendedSchema(db);
    const body = await request.json().catch(() => ({}));

    const nombre       = String(body?.nombre || "").trim();
    const codigoReferencia = String(body?.codigoReferencia || "").trim() || null;
    const descripcion  = String(body?.descripcion || "").trim();
    const precio       = Number(body?.precio);
    const stock        = Number(body?.stockDisponible ?? body?.stock ?? 0);
    const pesoRaw      = body?.peso;
    const peso         = pesoRaw != null && pesoRaw !== "" && Number.isFinite(Number(pesoRaw)) ? Number(pesoRaw) : null;
    const categoriaId  = Number(body?.categoriaId);
    const activo       = Number(body?.activo ?? 1) === 0 ? 0 : 1;

    // ── Nuevos campos ──
    const division      = String(body?.division || "").trim() || null;
    const unidadVenta   = String(body?.unidadVenta || "").trim() || null;
    const especificaciones = body?.especificaciones
      ? (typeof body.especificaciones === "string"
          ? body.especificaciones
          : JSON.stringify(body.especificaciones))
      : null;
    const specObj = parseSpecs(especificaciones);

    // Variantes: array de { descripcion, precio, stock }
    const variantes = Array.isArray(body?.variantes) ? body.variantes : [];

    const imagenesUrls = Array.isArray(body?.imagenesUrls)
      ? body.imagenesUrls.map((url) => String(url || "").trim()).filter(Boolean)
      : String(body?.imagenUrl || "").trim()
        ? [String(body?.imagenUrl || "").trim()]
        : [];

    if (!nombre || !Number.isFinite(precio) || !Number.isFinite(categoriaId) || categoriaId <= 0) {
      return json({ success: false, error: "Campos requeridos inválidos" }, 400);
    }
    const dimsValidation = validateExactDimensions(specObj);
    if (!dimsValidation.ok) {
      return json({ success: false, error: dimsValidation.error }, 400);
    }
    const variantsValidation = validateVariantsDistinctPrices(variantes);
    if (!variantsValidation.ok) {
      return json({ success: false, error: variantsValidation.error }, 400);
    }

    const exists = await db.execute({
      sql: "SELECT Id_Producto FROM Producto WHERE Id_Producto = ? LIMIT 1",
      args: [id],
    });
    if (!exists.rows.length) {
      return json({ success: false, error: "Producto no encontrado" }, 404);
    }

    const role = normalizeRole(admin?.rol);
    const moderationState = await getModerationState(id);
    if (role !== "superusuario" && activo === 1 && moderationState && moderationState !== "aprobado") {
      return json({
        success: false,
        error: "Este producto aun no esta aprobado por superusuario. No puede publicarse.",
      }, 403);
    }

    // Actualizar producto con nuevos campos
    await db.execute({
      sql: `UPDATE Producto
            SET Nombre = ?, Descripcion = ?, Precio = ?, StockDisponible = ?,
                Activo = ?, Peso = ?, Division = ?, Unidad_Venta = ?, Especificaciones = ?, CodigoReferencia = ?
            WHERE Id_Producto = ?`,
      args: [nombre, descripcion, precio,
             Number.isFinite(stock) ? stock : 0,
             activo, peso, division, unidadVenta, especificaciones, codigoReferencia, id],
    });

    // Categoría
    await db.execute({
      sql: "DELETE FROM ProductoCategoria WHERE Id_Producto = ?",
      args: [id],
    });
    await db.execute({
      sql: "INSERT INTO ProductoCategoria (Id_Producto, Id_Categoria) VALUES (?, ?)",
      args: [id, categoriaId],
    });

    // Imágenes
    if (imagenesUrls.length > 0) {
      await db.execute({
        sql: "DELETE FROM Imagen_Producto WHERE Id_Producto = ?",
        args: [id],
      });
      for (const url of imagenesUrls) {
        await db.execute({
          sql: "INSERT INTO Imagen_Producto (Id_Producto, Url) VALUES (?, ?)",
          args: [id, url],
        });
      }
    }

    // Variantes — reemplazar todas
    await db.execute({
      sql: "DELETE FROM ProductoVariante WHERE Id_Producto = ?",
      args: [id],
    });
    for (const v of variantes) {
      const vDesc  = String(v?.descripcion || "").trim();
      const vPrecio = v?.precio != null && Number.isFinite(Number(v.precio)) ? Number(v.precio) : null;
      const vStock  = v?.stock != null && Number.isFinite(Number(v.stock)) ? Number(v.stock) : null;
      const vPeso   = v?.peso != null && Number.isFinite(Number(v.peso)) ? Number(v.peso) : null;
      const vSpecsObj = (() => {
        if (v?.especificaciones == null) return null;
        if (typeof v.especificaciones === "string") {
          const trimmed = v.especificaciones.trim();
          return trimmed || null;
        }
        try {
          return JSON.stringify(v.especificaciones);
        } catch {
          return null;
        }
      })();
      if (!vDesc) continue;
      await db.execute({
        sql: "INSERT INTO ProductoVariante (Id_Producto, Descripcion, Precio, Stock, Peso, Especificaciones) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, vDesc, vPrecio, vStock, vPeso, vSpecsObj],
      });
    }

    return json({ success: true, message: "Producto actualizado" });
  } catch (error) {
    console.error("[PUT /api/admin/productos/:id] Error:", error);
    return json({ success: false, error: "Error actualizando producto" }, 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH — activar / desactivar producto
// ─────────────────────────────────────────────────────────────────────────────
export async function PATCH({ params, request, cookies }) {
  const admin = getAdminUser(cookies);
  if (!admin) return json({ success: false, error: "Acceso denegado" }, 403);

  const id = Number(params?.id);
  if (!Number.isFinite(id) || id <= 0) {
    return json({ success: false, error: "ID de producto inválido" }, 400);
  }

  try {
    await ensureProductVisibilitySchema(db);
    await ensureProductModerationSchema(db);
    const body   = await request.json().catch(() => ({}));
    const activo = Number(body?.activo ?? body?.habilitado ?? body?.enabled) === 0 ? 0 : 1;

    const exists = await db.execute({
      sql: "SELECT Id_Producto FROM Producto WHERE Id_Producto = ? LIMIT 1",
      args: [id],
    });
    if (!exists.rows.length) {
      return json({ success: false, error: "Producto no encontrado" }, 404);
    }

    const role = normalizeRole(admin?.rol);
    if (role !== "superusuario" && activo === 1) {
      const moderationState = await getModerationState(id);
      if (moderationState && moderationState !== "aprobado") {
        return json({
          success: false,
          error: "Solo superusuario puede activar productos pendientes o rechazados.",
        }, 403);
      }
    }

    await db.execute({
      sql: "UPDATE Producto SET Activo = ? WHERE Id_Producto = ?",
      args: [activo, id],
    });

    return json({
      success: true,
      message: activo ? "Producto activado" : "Producto desactivado",
      activo: activo === 1,
    });
  } catch (error) {
    console.error("[PATCH /api/admin/productos/:id] Error:", error);
    return json({ success: false, error: "Error actualizando estado del producto" }, 500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE — eliminar producto
// ─────────────────────────────────────────────────────────────────────────────
export async function DELETE({ params, cookies }) {
  const admin = getAdminUser(cookies);
  if (!admin) return json({ success: false, error: "Acceso denegado" }, 403);

  const id = Number(params?.id);
  if (!Number.isFinite(id) || id <= 0) {
    return json({ success: false, error: "ID de producto inválido" }, 400);
  }

  try {
    const exists = await db.execute({
      sql: "SELECT Id_Producto FROM Producto WHERE Id_Producto = ? LIMIT 1",
      args: [id],
    });
    if (!exists.rows.length) {
      return json({ success: false, error: "Producto no encontrado" }, 404);
    }

    const enPedidos = await db.execute({
      sql: "SELECT COUNT(*) as total FROM DetallePedido WHERE Id_Producto = ? LIMIT 1",
      args: [id],
    });
    const tienePedidos = Number(enPedidos.rows[0]?.total || 0) > 0;

    if (tienePedidos) {
      await db.execute({
        sql: "UPDATE Producto SET Activo = 0 WHERE Id_Producto = ?",
        args: [id],
      });
      return json({
        success: true,
        desactivado: true,
        message: "El producto tiene pedidos y fue desactivado.",
      });
    }

    await db.execute({ sql: "DELETE FROM ProductoVariante              WHERE Id_Producto = ?", args: [id] });
    await db.execute({ sql: "DELETE FROM ItemCarrito                   WHERE Id_Producto = ?", args: [id] });
    await db.execute({ sql: "DELETE FROM ProductoVisibilidadUsuario    WHERE Id_Producto = ?", args: [id] });
    await db.execute({ sql: "DELETE FROM Inventario                    WHERE Id_Producto = ?", args: [id] });
    await db.execute({ sql: "DELETE FROM Imagen_Producto               WHERE Id_Producto = ?", args: [id] });
    await db.execute({ sql: "DELETE FROM ProductoCategoria             WHERE Id_Producto = ?", args: [id] });
    await db.execute({ sql: "DELETE FROM Producto                      WHERE Id_Producto = ?", args: [id] });

    return json({ success: true, message: "Producto eliminado correctamente" });
  } catch (error) {
    console.error("[DELETE /api/admin/productos/:id] Error:", error);
    return json({ success: false, error: "Error eliminando producto" }, 500);
  }
}