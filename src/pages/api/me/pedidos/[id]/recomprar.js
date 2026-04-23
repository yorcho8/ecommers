/**
 * POST /api/me/pedidos/:id/recomprar
 *
 * Agrega todos los productos de un pedido anterior al carrito actual.
 * Solo funciona para pedidos del usuario autenticado.
 *
 * Respuesta:
 *   { success, itemsAgregados, itemsSinStock[], total }
 */
import { createClient } from "@libsql/client";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../../../../lib/session.js";

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

async function getOrCreateCartId(userId) {
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

export async function POST({ params, cookies }) {
  const user = getSessionUser(cookies);
  if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);

  const pedidoId = Number(params.id || 0);
  if (!pedidoId) return json({ success: false, error: "ID de pedido inválido" }, 400);

  try {
    // Verify order ownership
    const pedidoRes = await db.execute({
      sql: `SELECT Id_Pedido FROM Pedido WHERE Id_Pedido = ? AND Id_Usuario = ? LIMIT 1`,
      args: [pedidoId, user.userId],
    });
    if (!pedidoRes.rows.length) {
      return json({ success: false, error: "Pedido no encontrado" }, 404);
    }

    // Get order items with current stock and price
    const detalles = await db.execute({
      sql: `
        SELECT
          dp.Id_Producto,
          dp.Id_Variante,
          dp.Cantidad,
          dp.Precio_Unitario,
          p.StockDisponible,
          p.Nombre,
          COALESCE(p.Activo, 1) AS Activo
        FROM DetallePedido dp
        JOIN Producto p ON p.Id_Producto = dp.Id_Producto
        WHERE dp.Id_Pedido = ?
      `,
      args: [pedidoId],
    });

    if (!detalles.rows.length) {
      return json({ success: false, error: "El pedido no tiene productos" }, 400);
    }

    const cartId = await getOrCreateCartId(user.userId);
    const now = new Date().toISOString();

    const itemsAgregados = [];
    const itemsSinStock = [];

    for (const row of detalles.rows) {
      if (Number(row.Activo || 0) === 0) {
        itemsSinStock.push({ nombre: String(row.Nombre || ""), razon: "Producto inactivo" });
        continue;
      }

      const stockActual = row.StockDisponible == null ? Infinity : Number(row.StockDisponible);
      const cantidadDeseada = Number(row.Cantidad || 1);
      const cantidadValida = Math.min(cantidadDeseada, stockActual);

      if (cantidadValida <= 0) {
        itemsSinStock.push({ nombre: String(row.Nombre || ""), razon: "Sin stock" });
        continue;
      }

      // Upsert into cart (add to existing quantity, capped at stock)
      const existing = await db.execute({
        sql: `
          SELECT id_Item_Carrito, Cantidad
          FROM ItemCarrito
          WHERE Id_Carrito = ? AND Id_Producto = ?
            AND (Id_Variante IS ? OR (Id_Variante IS NULL AND ? IS NULL))
          LIMIT 1
        `,
        args: [cartId, Number(row.Id_Producto), row.Id_Variante ?? null, row.Id_Variante ?? null],
      });

      if (existing.rows.length) {
        const existingQty   = Number(existing.rows[0].Cantidad || 0);
        const nuevoQty      = Math.min(existingQty + cantidadValida, stockActual);
        await db.execute({
          sql: `UPDATE ItemCarrito SET Cantidad = ? WHERE id_Item_Carrito = ?`,
          args: [nuevoQty, Number(existing.rows[0].id_Item_Carrito)],
        });
      } else {
        await db.execute({
          sql: `
            INSERT INTO ItemCarrito (Id_Carrito, Id_Producto, Id_Variante, Cantidad, Precio_Unitario, Fecha_Agregado)
            VALUES (?, ?, ?, ?, ?, ?)
          `,
          args: [
            cartId,
            Number(row.Id_Producto),
            row.Id_Variante ?? null,
            cantidadValida,
            Number(row.Precio_Unitario || 0),
            now,
          ],
        });
      }

      itemsAgregados.push({
        productoId: Number(row.Id_Producto),
        nombre:     String(row.Nombre || ""),
        cantidad:   cantidadValida,
      });
    }

    return json({
      success:       true,
      message:       `${itemsAgregados.length} producto(s) agregado(s) al carrito`,
      itemsAgregados,
      itemsSinStock,
      total:         itemsAgregados.length + itemsSinStock.length,
    });
  } catch (error) {
    console.error("[POST /api/me/pedidos/:id/recomprar]", error);
    return json({ success: false, error: "Error al procesar la solicitud" }, 500);
  }
}
