import { createClient } from "@libsql/client";
import "dotenv/config";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

let schemaInitPromise = null;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

import { verifySessionToken, SESSION_COOKIE } from "../../../lib/session.js";

/** Uses the signed, HttpOnly go_session cookie — not the forgeable authSession. */
function getSessionUser(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
  } catch {
    return null;
  }
}

const RETURN_WINDOW_DAYS = 15;

function daysDiffFromNow(isoDate) {
  const d = new Date(String(isoDate || ""));
  if (Number.isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}

function isWithinReturnWindow(fechaPedido) {
  const elapsedDays = daysDiffFromNow(fechaPedido);
  if (elapsedDays == null) return false;
  return elapsedDays <= RETURN_WINDOW_DAYS;
}

function isOrderCancelable(estadoPedido, estadoPago, fechaPedido, fechaEntrega) {
  const pedido = String(estadoPedido || "").toLowerCase();
  const pago = String(estadoPago || "").toLowerCase();

  const blockedPedidoStates = new Set(["cancelado", "devuelto", "devolucion_completada", "devolucion_solicitada"]);
  const blockedPagoStates = new Set(["reembolsado", "reembolso_completo"]);

  if (blockedPedidoStates.has(pedido)) return false;
  if (blockedPagoStates.has(pago)) return false;

  if (!isWithinReturnWindow(fechaPedido)) return false;

  if (pedido === "entregado") {
    // Some legacy orders may not have delivery timestamp; fallback to purchase date.
    const elapsedDays = daysDiffFromNow(fechaEntrega || fechaPedido);
    if (elapsedDays == null) return false;
    return elapsedDays <= RETURN_WINDOW_DAYS;
  }

  if (pedido === "enviado") return false;
  return true;
}

async function ensurePaymentSchema() {
  return true;
}

async function ensureReturnSchema() {
  return true;
}

async function ensureSchemasReady() {
  if (!schemaInitPromise) {
    schemaInitPromise = (async () => {
      await ensurePaymentSchema();
      await ensureReturnSchema();
    })().catch((error) => {
      schemaInitPromise = null;
      throw error;
    });
  }
  return schemaInitPromise;
}

export async function GET({ cookies }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) {
    return json({ success: false, error: "No autenticado" }, 401);
  }

  try {
    await ensureSchemasReady();

    const result = await db.execute({
      sql: `
        SELECT
          p.Id_Pedido,
          p.Numero_Pedido,
          p.Fecha_pedido,
          p.Estado,
          p.Total,
          p.Costo_Envio,

          (
            SELECT dpr.Estado
            FROM DevolucionPedido dpr
            WHERE dpr.Id_Pedido = p.Id_Pedido
            ORDER BY dpr.Id_Devolucion DESC
            LIMIT 1
          ) AS Devolucion_Estado,
          (
            SELECT dpr.Numero_Guia
            FROM DevolucionPedido dpr
            WHERE dpr.Id_Pedido = p.Id_Pedido
            ORDER BY dpr.Id_Devolucion DESC
            LIMIT 1
          ) AS Devolucion_Guia,
          (
            SELECT dpr.Label_URL
            FROM DevolucionPedido dpr
            WHERE dpr.Id_Pedido = p.Id_Pedido
            ORDER BY dpr.Id_Devolucion DESC
            LIMIT 1
          ) AS Devolucion_Label_URL,
          (
            SELECT dpr.Track_URL
            FROM DevolucionPedido dpr
            WHERE dpr.Id_Pedido = p.Id_Pedido
            ORDER BY dpr.Id_Devolucion DESC
            LIMIT 1
          ) AS Devolucion_Track_URL,

          (
            SELECT e.Fecha_Entrega
            FROM Envio e
            WHERE e.Id_pedido = p.Id_Pedido
            ORDER BY e.Id_Envio DESC
            LIMIT 1
          ) AS Fecha_Entrega_Real,

          d.Numero_casa,
          d.Calle,
          d.Codigo_Postal,
          d.Ciudad,
          d.Provincia,

          pg.Metodo_Pago,
          pg.Estado_Pago,
          pg.Monto,
          pg.Fecha_Pago,
          pg.Marca_Tarjeta,
          pg.Tipo_Financiamiento,
          pg.Ultimos4,

          COALESCE((
            SELECT SUM(dp.Cantidad)
            FROM DetallePedido dp
            WHERE dp.Id_Pedido = p.Id_Pedido
          ), 0) AS Cantidad_Total,

          COALESCE((
            SELECT GROUP_CONCAT(pr.Nombre || ' x' || dp.Cantidad, ' | ')
            FROM DetallePedido dp
            JOIN Producto pr ON pr.Id_Producto = dp.Id_Producto
            WHERE dp.Id_Pedido = p.Id_Pedido
          ), '') AS Resumen_Items

        FROM Pedido p
        LEFT JOIN Direccion d ON d.Id_Direccion = p.Id_Direccion
        LEFT JOIN Pago pg ON pg.Id_Pedido = p.Id_Pedido
        WHERE p.Id_Usuario = ?
        ORDER BY p.Fecha_pedido DESC, p.Id_Pedido DESC
      `,
      args: [sessionUser.userId],
    });

    const pedidos = result.rows.map((row) => {
      const direccion = [
        row.Calle ? `Calle ${row.Calle}` : "",
        row.Numero_casa != null ? `No. ${row.Numero_casa}` : "",
        row.Ciudad ? String(row.Ciudad) : "",
        row.Provincia ? String(row.Provincia) : "",
        row.Codigo_Postal != null ? `CP ${row.Codigo_Postal}` : "",
      ]
        .filter(Boolean)
        .join(", ");

      return {
        idPedido: Number(row.Id_Pedido),
        numeroPedido: Number(row.Numero_Pedido || 0),
        fechaPedido: row.Fecha_pedido,
        fechaEntregaReal: row.Fecha_Entrega_Real || null,
        estadoPedido: String(row.Estado || "").toLowerCase(),
        puedeCancelar: isOrderCancelable(row.Estado, row.Estado_Pago, row.Fecha_pedido, row.Fecha_Entrega_Real),
        devolucion: {
          estado: row.Devolucion_Estado ? String(row.Devolucion_Estado).toLowerCase() : null,
          guia: row.Devolucion_Guia ? String(row.Devolucion_Guia) : null,
          labelUrl: row.Devolucion_Label_URL ? String(row.Devolucion_Label_URL) : null,
          trackUrl: row.Devolucion_Track_URL ? String(row.Devolucion_Track_URL) : null,
        },

        direccion: {
          completa: direccion || "Sin direccion",
        },

        pago: {
          metodo: String(row.Metodo_Pago || "").toLowerCase(),
          estado: String(row.Estado_Pago || "").toLowerCase(),
          monto: Number(row.Monto || row.Total || 0),
          fechaPago: row.Fecha_Pago || null,
          marcaTarjeta: String(row.Marca_Tarjeta || "").toLowerCase(),
          tipoFinanciamiento: String(row.Tipo_Financiamiento || "no_definido").toLowerCase(),
          ultimos4: String(row.Ultimos4 || ""),
        },

        cantidadTotal: Number(row.Cantidad_Total || 0),
        resumenItems: String(row.Resumen_Items || ""),
        totalPedido: Number(row.Total || 0),
        costoEnvio: Number(row.Costo_Envio || 0),
      };
    });

    return json({ success: true, pedidos });
  } catch (error) {
    console.error("[GET /api/me/pedidos] Error:", error);
    return json({ success: false, error: "Error obteniendo pedidos" }, 500);
  }
}
