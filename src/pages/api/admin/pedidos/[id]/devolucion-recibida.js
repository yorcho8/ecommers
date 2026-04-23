import { createClient } from "@libsql/client";
import Stripe from "stripe";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../../../../lib/session.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY
);

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getPrivilegedUser(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const user = verifySessionToken(token);
    const role = String(user?.rol || "").toLowerCase();
    if (role === "admin" || role === "superusuario") return user;
    return null;
  } catch {
    return null;
  }
}

async function ensureSchema() {
  return true;
}

function mapRefundStatus(refundStatus) {
  const status = String(refundStatus || "").toLowerCase();
  if (status === "succeeded") {
    return { estadoPago: "reembolsado", estadoReembolso: "completado" };
  }
  if (status === "failed" || status === "canceled") {
    return { estadoPago: "reembolso_fallido", estadoReembolso: "fallido" };
  }
  return { estadoPago: "reembolso_pendiente", estadoReembolso: "pendiente" };
}

async function tryStripeRefund(codigoTransaccion, amount, orderId) {
  const paymentIntentId = String(codigoTransaccion || "").trim();
  if (!paymentIntentId || !paymentIntentId.startsWith("pi_")) {
    return {
      attempted: false,
      success: false,
      reason: "payment_intent_invalido",
      message: "No hay PaymentIntent valido para refund automatico",
    };
  }

  const payload = {
    payment_intent: paymentIntentId,
    reason: "requested_by_customer",
    metadata: {
      source: "admin_devolucion_recibida",
      pedido_id: String(orderId),
    },
  };

  const safeAmount = Number(amount || 0);
  if (Number.isFinite(safeAmount) && safeAmount > 0) {
    payload.amount = Math.round(safeAmount * 100);
  }

  const refund = await stripe.refunds.create(payload);
  return {
    attempted: true,
    success: true,
    refundId: String(refund.id || ""),
    refundStatus: String(refund.status || "pending"),
  };
}

export async function POST({ params, cookies }) {
  const user = getPrivilegedUser(cookies);
  if (!user) return json({ success: false, error: "Acceso denegado" }, 403);

  const pedidoId = Number(params?.id || 0);
  if (!Number.isFinite(pedidoId) || pedidoId <= 0) {
    return json({ success: false, error: "ID de pedido invalido" }, 400);
  }

  try {
    await ensureSchema();

    const orderRes = await db.execute({
      sql: `
        SELECT
          p.Id_Pedido,
          p.Numero_Pedido,
          p.Estado,
          pg.Id_Pago,
          pg.Monto,
          pg.Estado_Pago,
          pg.Codigo_Transaccion,
          pg.Estado_Reembolso
        FROM Pedido p
        LEFT JOIN Pago pg ON pg.Id_Pedido = p.Id_Pedido
        WHERE p.Id_Pedido = ?
        LIMIT 1
      `,
      args: [pedidoId],
    });

    if (!orderRes.rows.length) {
      return json({ success: false, error: "Pedido no encontrado" }, 404);
    }

    const returnRes = await db.execute({
      sql: `
        SELECT
          Id_Devolucion,
          Estado,
          Numero_Guia,
          Label_URL,
          Track_URL,
          Carrier,
          Service
        FROM DevolucionPedido
        WHERE Id_Pedido = ?
        ORDER BY Id_Devolucion DESC
        LIMIT 1
      `,
      args: [pedidoId],
    });

    if (!returnRes.rows.length) {
      return json({ success: false, error: "Este pedido no tiene devolucion registrada" }, 404);
    }

    const devolucion = returnRes.rows[0];
    const estadoDevolucion = String(devolucion.Estado || "").toLowerCase();
    if (estadoDevolucion === "completada") {
      return json({ success: false, error: "La devolucion ya fue completada" }, 409);
    }

    const order = orderRes.rows[0];
    const pagoEstado = String(order.Estado_Pago || "").toLowerCase();
    const needsRefund = ["aprobado", "pagado", "capturado", "reembolso_pendiente"].includes(pagoEstado);

    let refundResult = {
      attempted: false,
      success: true,
      reason: "no_aplica",
      message: "El pago no requiere refund",
      refundStatus: null,
      refundId: null,
    };

    if (needsRefund) {
      try {
        refundResult = await tryStripeRefund(order.Codigo_Transaccion, Number(order.Monto || 0), pedidoId);
      } catch (refundError) {
        refundResult = {
          attempted: true,
          success: false,
          reason: "stripe_refund_error",
          message: String(refundError?.message || "Error creando refund en Stripe"),
          refundStatus: null,
          refundId: null,
        };
      }
    }

    await db.execute({ sql: "BEGIN", args: [] });

    try {
      // Reingresar stock cuando la devolucion fisica se recibe.
      const details = await db.execute({
        sql: `
          SELECT Id_Producto, Cantidad
          FROM DetallePedido
          WHERE Id_Pedido = ?
        `,
        args: [pedidoId],
      });

      for (const row of details.rows) {
        const productId = Number(row.Id_Producto || 0);
        const qty = Number(row.Cantidad || 0);
        if (!Number.isFinite(productId) || productId <= 0 || !Number.isFinite(qty) || qty <= 0) continue;
        await db.execute({
          sql: `UPDATE Producto SET StockDisponible = COALESCE(StockDisponible, 0) + ? WHERE Id_Producto = ?`,
          args: [qty, productId],
        });
      }

      const now = new Date().toISOString();
      await db.execute({
        sql: `
          UPDATE DevolucionPedido
          SET Estado = 'completada', Fecha_Actualizacion = ?
          WHERE Id_Devolucion = ?
        `,
        args: [now, Number(devolucion.Id_Devolucion)],
      });

      if (needsRefund) {
        const refundMap = mapRefundStatus(refundResult.refundStatus);
        await db.execute({
          sql: `
            UPDATE Pago
            SET Estado_Pago = ?, Estado_Reembolso = ?, Stripe_Refund_Id = ?, Fecha_Reembolso = ?
            WHERE Id_Pago = ?
          `,
          args: [
            refundResult.success ? refundMap.estadoPago : "reembolso_pendiente",
            refundResult.success ? refundMap.estadoReembolso : "pendiente",
            refundResult.refundId || null,
            refundResult.success ? now : null,
            Number(order.Id_Pago || 0),
          ],
        });
      }

      await db.execute({
        sql: `UPDATE Pedido SET Estado = ? WHERE Id_Pedido = ?`,
        args: [refundResult.success ? "devolucion_completada" : "devolucion_solicitada", pedidoId],
      });

      await db.execute({ sql: "COMMIT", args: [] });
    } catch (txError) {
      await db.execute({ sql: "ROLLBACK", args: [] });
      throw txError;
    }

    return json({
      success: true,
      message: refundResult.success
        ? "Devolucion recibida y reembolso procesado"
        : "Devolucion recibida. Reembolso pendiente de conciliacion",
      pedido: {
        id: Number(order.Id_Pedido),
        numero: Number(order.Numero_Pedido || 0),
        estado: refundResult.success ? "devolucion_completada" : "devolucion_solicitada",
      },
      devolucion: {
        id: Number(devolucion.Id_Devolucion || 0),
        estado: "completada",
        guia: devolucion.Numero_Guia ? String(devolucion.Numero_Guia) : null,
        labelUrl: devolucion.Label_URL ? String(devolucion.Label_URL) : null,
        trackUrl: devolucion.Track_URL ? String(devolucion.Track_URL) : null,
        carrier: devolucion.Carrier ? String(devolucion.Carrier) : "estafeta",
        service: devolucion.Service ? String(devolucion.Service) : "ground",
      },
      reembolso: {
        attempted: Boolean(refundResult.attempted),
        success: Boolean(refundResult.success),
        refundId: refundResult.refundId || null,
        refundStatus: refundResult.refundStatus || null,
        message: refundResult.message || null,
      },
    });
  } catch (error) {
    console.error("[POST /api/admin/pedidos/:id/devolucion-recibida]", error);
    return json({ success: false, error: "No se pudo confirmar la devolucion recibida" }, 500);
  }
}
