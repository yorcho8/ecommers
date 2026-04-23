import { createClient } from "@libsql/client";
import "dotenv/config";
import { ensureProductVisibilitySchema } from "../../lib/product-visibility.js";
import { getActiveDiscountMap, resolveEffectiveUnitPrice } from "../../lib/pricing.js";
import { verifySessionToken, SESSION_COOKIE } from "../../lib/session.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN,
});

// Migración: añadir columna Ultima_Actividad al carrito si no existe
async function ensureCartSchema() {
  return true;
}

async function touchCartActivity(cartId) {
  await db.execute({
    sql: "UPDATE Carrito SET Ultima_Actividad = ? WHERE Id_Carrito = ?",
    args: [new Date().toISOString(), cartId],
  });
}

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

function generateGuestId() {
  return "guest_" + crypto.randomUUID();
}

function resolveIdentity(cookies) {
  const user = getUserFromSession(cookies);
  if (user?.userId) {
    return { userId: user.userId, guestId: null, isGuest: false };
  }
  const guestId = cookies.get("guestCartId")?.value || null;
  return { userId: null, guestId, isGuest: true };
}

function attachGuestCookie(response, guestId, isNewGuest) {
  if (!isNewGuest) return response;
  response.headers.append(
    "Set-Cookie",
    `guestCartId=${guestId}; Path=/; Max-Age=2592000; SameSite=Lax`
  );
  return response;
}

async function getOrCreateCartId({ userId, guestId }) {
  if (userId) {
    const cart = await db.execute({
      sql: `SELECT Id_Carrito FROM Carrito WHERE Id_Usuario = ? LIMIT 1`,
      args: [userId],
    });
    if (cart.rows.length) return Number(cart.rows[0].Id_Carrito);

    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO Carrito (Id_Usuario, Fecha_Creacion) VALUES (?, ?)`,
      args: [userId, now],
    });
    const created = await db.execute({
      sql: `SELECT Id_Carrito FROM Carrito WHERE Id_Usuario = ? ORDER BY Id_Carrito DESC LIMIT 1`,
      args: [userId],
    });
    return Number(created.rows[0].Id_Carrito);
  }

  const cart = await db.execute({
    sql: `SELECT Id_Carrito FROM Carrito WHERE Guest_Id = ? LIMIT 1`,
    args: [guestId],
  });
  if (cart.rows.length) return Number(cart.rows[0].Id_Carrito);

  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO Carrito (Guest_Id, Fecha_Creacion) VALUES (?, ?)`,
    args: [guestId, now],
  });
  const created = await db.execute({
    sql: `SELECT Id_Carrito FROM Carrito WHERE Guest_Id = ? ORDER BY Id_Carrito DESC LIMIT 1`,
    args: [guestId],
  });
  return Number(created.rows[0].Id_Carrito);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — obtener carrito
// ─────────────────────────────────────────────────────────────────────────────

export async function GET({ cookies }) {
  try {
    await ensureProductVisibilitySchema(db);
    await ensureCartSchema();

    let { userId, guestId, isGuest } = resolveIdentity(cookies);
    let isNewGuest = false;

    if (isGuest && !guestId) {
      guestId = generateGuestId();
      isNewGuest = true;
      const res = jsonResponse(200, {
        success: true,
        cartId: null,
        items: [],
        summary: { totalItems: 0, total: 0 },
      });
      return attachGuestCookie(res, guestId, isNewGuest);
    }

    const cartId = await getOrCreateCartId({ userId, guestId });

    const sql = userId
      ? `
        SELECT
          ic.id_Item_Carrito,
          ic.Id_Producto,
          ic.Id_Variante,
          ic.Cantidad,
          ic.Precio_Unitario,
          p.Nombre,
          p.Precio AS Precio_Base,
          p.Descripcion,
          p.StockDisponible,
          pv.Precio AS Precio_Variante,
          pv.Descripcion AS Descripcion_Variante,
          (
            SELECT ip.Url
            FROM Imagen_Producto ip
            WHERE ip.Id_Producto = p.Id_Producto
            ORDER BY ip.Id_Imagen ASC
            LIMIT 1
          ) AS ImagenUrl
        FROM ItemCarrito ic
        JOIN Producto p ON p.Id_Producto = ic.Id_Producto
        LEFT JOIN ProductoVariante pv ON pv.Id_Variante = ic.Id_Variante
        WHERE ic.Id_Carrito = ?
          AND COALESCE(p.Activo, 1) = 1
          AND NOT EXISTS (
            SELECT 1 FROM ProductoVisibilidadUsuario pvu
            WHERE pvu.Id_Producto = p.Id_Producto
              AND pvu.Id_Usuario = ?
              AND pvu.Visible = 0
          )
        ORDER BY ic.id_Item_Carrito DESC
      `
      : `
        SELECT
          ic.id_Item_Carrito,
          ic.Id_Producto,
          ic.Id_Variante,
          ic.Cantidad,
          ic.Precio_Unitario,
          p.Nombre,
          p.Precio AS Precio_Base,
          p.Descripcion,
          p.StockDisponible,
          pv.Precio AS Precio_Variante,
          pv.Descripcion AS Descripcion_Variante,
          (
            SELECT ip.Url
            FROM Imagen_Producto ip
            WHERE ip.Id_Producto = p.Id_Producto
            ORDER BY ip.Id_Imagen ASC
            LIMIT 1
          ) AS ImagenUrl
        FROM ItemCarrito ic
        JOIN Producto p ON p.Id_Producto = ic.Id_Producto
        LEFT JOIN ProductoVariante pv ON pv.Id_Variante = ic.Id_Variante
        WHERE ic.Id_Carrito = ?
          AND COALESCE(p.Activo, 1) = 1
        ORDER BY ic.id_Item_Carrito DESC
      `;

    const result = await db.execute({
      sql,
      args: userId ? [cartId, userId] : [cartId],
    });

    const discountMap = await getActiveDiscountMap(
      db,
      result.rows.map((row) => Number(row.Id_Producto || 0))
    );

    const items = result.rows.map((row) => {
      const cantidad = Number(row.Cantidad || 0);
      const variantPrice = row.Precio_Variante == null ? null : Number(row.Precio_Variante);
      const basePrice = variantPrice == null ? Number(row.Precio_Base || row.Precio_Unitario || 0) : variantPrice;
      const precio = resolveEffectiveUnitPrice(basePrice, Number(row.Id_Producto || 0), discountMap);
      return {
        itemId: Number(row.id_Item_Carrito),
        productoId: Number(row.Id_Producto),
        varianteId: row.Id_Variante ? Number(row.Id_Variante) : null,
        variante: row.Descripcion_Variante ? String(row.Descripcion_Variante) : null,
        nombre: String(row.Nombre || ""),
        descripcion: String(row.Descripcion || ""),
        stockDisponible: row.StockDisponible == null ? null : Number(row.StockDisponible),
        imagen: row.ImagenUrl ? String(row.ImagenUrl) : null,
        cantidad,
        precioUnitario: precio,
        subtotal: Number((cantidad * precio).toFixed(2)),
      };
    });

    const totalItems = items.reduce((acc, i) => acc + i.cantidad, 0);
    const total = Number(items.reduce((acc, i) => acc + i.subtotal, 0).toFixed(2));

    const res = jsonResponse(200, {
      success: true,
      cartId,
      items,
      summary: { totalItems, total },
    });
    return attachGuestCookie(res, guestId, isNewGuest);
  } catch (error) {
    console.error("[GET /api/carrito] Error:", error);
    return jsonResponse(500, { success: false, error: "Error obteniendo carrito" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — añadir producto
// ─────────────────────────────────────────────────────────────────────────────

export async function POST({ request, cookies }) {
  try {
    await ensureProductVisibilitySchema(db);

    let { userId, guestId, isGuest } = resolveIdentity(cookies);
    let isNewGuest = false;

    if (isGuest && !guestId) {
      guestId = generateGuestId();
      isNewGuest = true;
    }

    const { productoId, cantidad, varianteId } = await request.json();
    const productIdNum  = Number(productoId);
    const qtyNum        = Number(cantidad ?? 1);
    const varianteIdNum = varianteId ? Number(varianteId) : null;

    if (!Number.isFinite(productIdNum) || productIdNum <= 0)
      return jsonResponse(400, { success: false, error: "productoId inválido" });
    if (!Number.isFinite(qtyNum) || qtyNum <= 0)
      return jsonResponse(400, { success: false, error: "cantidad inválida" });

    // Si viene varianteId, verificar que pertenece al producto y obtener su precio
    let basePrice;
    if (varianteIdNum) {
      const varianteRes = await db.execute({
        sql: `SELECT Precio, Stock FROM ProductoVariante WHERE Id_Variante = ? AND Id_Producto = ? LIMIT 1`,
        args: [varianteIdNum, productIdNum],
      });
      if (!varianteRes.rows.length)
        return jsonResponse(404, { success: false, error: "Variante no encontrada para este producto" });

      const varianteStock = varianteRes.rows[0].Stock == null ? null : Number(varianteRes.rows[0].Stock);
      if (varianteStock !== null && qtyNum > varianteStock) {
        return jsonResponse(400, {
          success: false,
          error: varianteStock === 0 ? "Esta variante está agotada." : `Stock insuficiente para esta variante. Disponible: ${varianteStock}`,
        });
      }

      basePrice = varianteRes.rows[0].Precio != null
        ? Number(varianteRes.rows[0].Precio)
        : null;

      // Si la variante no tiene precio propio, usar el del producto base
      if (basePrice == null) {
        const prodRes = await db.execute({
          sql: `SELECT Precio FROM Producto WHERE Id_Producto = ? LIMIT 1`,
          args: [productIdNum],
        });
        basePrice = Number(prodRes.rows[0]?.Precio || 0);
      }
    } else {
      // Sin variante — verificar producto y obtener precio base
      const productSql = userId
        ? `
          SELECT Id_Producto, Precio, StockDisponible FROM Producto p
          WHERE p.Id_Producto = ? AND COALESCE(p.Activo, 1) = 1
            AND NOT EXISTS (
              SELECT 1 FROM ProductoVisibilidadUsuario pvu
              WHERE pvu.Id_Producto = p.Id_Producto
                AND pvu.Id_Usuario = ? AND pvu.Visible = 0
            )
          LIMIT 1
        `
        : `
          SELECT Id_Producto, Precio, StockDisponible FROM Producto p
          WHERE p.Id_Producto = ? AND COALESCE(p.Activo, 1) = 1
          LIMIT 1
        `;

      const product = await db.execute({
        sql: productSql,
        args: userId ? [productIdNum, userId] : [productIdNum],
      });
      if (!product.rows.length)
        return jsonResponse(404, { success: false, error: "Producto no encontrado" });

      basePrice = Number(product.rows[0].Precio || 0);

      const stockDisponible = product.rows[0].StockDisponible == null
        ? null : Number(product.rows[0].StockDisponible);

      if (stockDisponible != null && qtyNum > stockDisponible) {
        return jsonResponse(400, {
          success: false,
          error: `Stock insuficiente. Disponible: ${stockDisponible}`,
        });
      }
    }

    const discountMap = await getActiveDiscountMap(db, [productIdNum]);
    const price = resolveEffectiveUnitPrice(basePrice, productIdNum, discountMap);

    const cartId = await getOrCreateCartId({ userId, guestId });

    // Buscar item existente (mismo producto Y misma variante)
    const existing = await db.execute({
      sql: `
        SELECT id_Item_Carrito, Cantidad FROM ItemCarrito
        WHERE Id_Carrito = ?
          AND Id_Producto = ?
          AND (Id_Variante IS ? OR Id_Variante = ?)
        LIMIT 1
      `,
      args: [cartId, productIdNum, varianteIdNum, varianteIdNum],
    });

    if (existing.rows.length) {
      const newQty = Number(existing.rows[0].Cantidad || 0) + qtyNum;
      await db.execute({
        sql: `UPDATE ItemCarrito SET Cantidad = ?, Precio_Unitario = ?, Fecha = ? WHERE id_Item_Carrito = ?`,
        args: [newQty, price, new Date().toISOString(), existing.rows[0].id_Item_Carrito],
      });
    } else {
      await db.execute({
        sql: `INSERT INTO ItemCarrito (Id_Carrito, Id_Producto, Id_Variante, Cantidad, Precio_Unitario, Fecha) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [cartId, productIdNum, varianteIdNum, qtyNum, price, new Date().toISOString()],
      });
    }

    await touchCartActivity(cartId).catch(() => {});
    const res = jsonResponse(200, { success: true, message: "Producto agregado al carrito" });
    return attachGuestCookie(res, guestId, isNewGuest);
  } catch (error) {
    console.error("[POST /api/carrito] Error:", error);
    return jsonResponse(500, { success: false, error: "Error agregando producto al carrito" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT — actualizar cantidad
// ─────────────────────────────────────────────────────────────────────────────

export async function PUT({ request, cookies }) {
  try {
    await ensureProductVisibilitySchema(db);

    const { userId, guestId, isGuest } = resolveIdentity(cookies);
    if (isGuest && !guestId)
      return jsonResponse(400, { success: false, error: "Carrito no encontrado" });

    const { itemId, cantidad } = await request.json();
    const itemIdNum = Number(itemId);
    const qtyNum    = Number(cantidad);

    if (!Number.isFinite(itemIdNum) || itemIdNum <= 0)
      return jsonResponse(400, { success: false, error: "itemId inválido" });
    if (!Number.isFinite(qtyNum) || qtyNum <= 0)
      return jsonResponse(400, { success: false, error: "cantidad inválida" });

    const cartId = await getOrCreateCartId({ userId, guestId });

    const itemSql = userId
      ? `
        SELECT ic.id_Item_Carrito, ic.Id_Producto, ic.Id_Variante, p.StockDisponible, p.Precio AS Precio_Base, pv.Precio AS Precio_Variante
        FROM ItemCarrito ic
        JOIN Producto p ON p.Id_Producto = ic.Id_Producto
        LEFT JOIN ProductoVariante pv ON pv.Id_Variante = ic.Id_Variante
        WHERE ic.id_Item_Carrito = ? AND ic.Id_Carrito = ?
          AND COALESCE(p.Activo, 1) = 1
          AND NOT EXISTS (
            SELECT 1 FROM ProductoVisibilidadUsuario pvu
            WHERE pvu.Id_Producto = p.Id_Producto
              AND pvu.Id_Usuario = ? AND pvu.Visible = 0
          )
        LIMIT 1
      `
      : `
        SELECT ic.id_Item_Carrito, ic.Id_Producto, ic.Id_Variante, p.StockDisponible, p.Precio AS Precio_Base, pv.Precio AS Precio_Variante
        FROM ItemCarrito ic
        JOIN Producto p ON p.Id_Producto = ic.Id_Producto
        LEFT JOIN ProductoVariante pv ON pv.Id_Variante = ic.Id_Variante
        WHERE ic.id_Item_Carrito = ? AND ic.Id_Carrito = ?
          AND COALESCE(p.Activo, 1) = 1
        LIMIT 1
      `;

    const item = await db.execute({
      sql: itemSql,
      args: userId ? [itemIdNum, cartId, userId] : [itemIdNum, cartId],
    });
    if (!item.rows.length)
      return jsonResponse(404, { success: false, error: "Item del carrito no encontrado" });

    const stockDisponible = item.rows[0].StockDisponible == null
      ? null : Number(item.rows[0].StockDisponible);

    if (stockDisponible != null && qtyNum > stockDisponible) {
      return jsonResponse(400, {
        success: false,
        error: `Stock insuficiente. Disponible: ${stockDisponible}`,
      });
    }

    const productId = Number(item.rows[0].Id_Producto || 0);
    const variantPrice = item.rows[0].Precio_Variante == null ? null : Number(item.rows[0].Precio_Variante);
    const basePrice = variantPrice == null ? Number(item.rows[0].Precio_Base || 0) : variantPrice;
    const discountMap = await getActiveDiscountMap(db, [productId]);
    const effectivePrice = resolveEffectiveUnitPrice(basePrice, productId, discountMap);

    await db.execute({
      sql: `UPDATE ItemCarrito SET Cantidad = ?, Precio_Unitario = ?, Fecha = ? WHERE id_Item_Carrito = ?`,
      args: [qtyNum, effectivePrice, new Date().toISOString(), itemIdNum],
    });

    await touchCartActivity(cartId).catch(() => {});
    return jsonResponse(200, { success: true, message: "Cantidad actualizada" });
  } catch (error) {
    console.error("[PUT /api/carrito] Error:", error);
    return jsonResponse(500, { success: false, error: "Error actualizando carrito" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE — eliminar item o vaciar carrito
// ─────────────────────────────────────────────────────────────────────────────

export async function DELETE({ request, cookies }) {
  try {
    const { userId, guestId, isGuest } = resolveIdentity(cookies);
    if (isGuest && !guestId)
      return jsonResponse(400, { success: false, error: "Carrito no encontrado" });

    const body       = await request.json().catch(() => ({}));
    const itemIdNum  = Number(body.itemId);
    const clearAll   = Boolean(body.clearAll);
    const cartId     = await getOrCreateCartId({ userId, guestId });

    if (clearAll) {
      await db.execute({ sql: `DELETE FROM ItemCarrito WHERE Id_Carrito = ?`, args: [cartId] });
      return jsonResponse(200, { success: true, message: "Carrito vaciado" });
    }

    if (!Number.isFinite(itemIdNum) || itemIdNum <= 0)
      return jsonResponse(400, { success: false, error: "itemId inválido" });

    await db.execute({
      sql: `DELETE FROM ItemCarrito WHERE id_Item_Carrito = ? AND Id_Carrito = ?`,
      args: [itemIdNum, cartId],
    });

    return jsonResponse(200, { success: true, message: "Producto eliminado del carrito" });
  } catch (error) {
    console.error("[DELETE /api/carrito] Error:", error);
    return jsonResponse(500, { success: false, error: "Error eliminando item del carrito" });
  }
}