import { createClient } from "@libsql/client";
import Stripe from "stripe";
import "dotenv/config";
import { cancelarEnvioEnvia } from "../../../../../lib/envia-shipping.js";
import { generarEtiquetaDevolucionEnvia } from "../../../../../lib/envia-shipping.js";
import { verifySessionToken, SESSION_COOKIE } from "../../../../../lib/session.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

let schemaInitPromise = null;

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY
);

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

function isOrderCancelable(estadoPedido, estadoPago) {
  const pedido = String(estadoPedido || "").toLowerCase();
  const pago = String(estadoPago || "").toLowerCase();

  const blockedPedidoStates = new Set(["cancelado", "enviado", "entregado", "devolucion_solicitada"]);
  const blockedPagoStates = new Set(["reembolsado", "reembolso_completo"]);

  if (blockedPedidoStates.has(pedido)) return false;
  if (blockedPagoStates.has(pago)) return false;
  return true;
}

const RETURN_WINDOW_DAYS = 15;

function isWithinReturnWindow(fechaPedido) {
  const base = new Date(String(fechaPedido || ""));
  if (Number.isNaN(base.getTime())) return false;
  const elapsed = (Date.now() - base.getTime()) / (1000 * 60 * 60 * 24);
  return elapsed <= RETURN_WINDOW_DAYS;
}

function isEligibleDeliveredReturn(estadoPedido, fechaEntrega, fechaPedido) {
  if (String(estadoPedido || "").toLowerCase() !== "entregado") return false;
  // Fallback to purchase date when delivery date is missing in older records.
  const base = new Date(String(fechaEntrega || fechaPedido || ""));
  if (Number.isNaN(base.getTime())) return false;
  const elapsed = (Date.now() - base.getTime()) / (1000 * 60 * 60 * 24);
  return elapsed <= RETURN_WINDOW_DAYS;
}

async function ensurePaymentSchema() {
  return true;
}

async function ensureSchemasReady() {
  if (!schemaInitPromise) {
    schemaInitPromise = ensurePaymentSchema().catch((error) => {
      schemaInitPromise = null;
      throw error;
    });
  }
  return schemaInitPromise;
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

async function tryStripeRefund(codigoTransaccion, amount) {
  const paymentIntentId = String(codigoTransaccion || "").trim();
  if (!paymentIntentId || !paymentIntentId.startsWith("pi_")) {
    return {
      attempted: false,
      automatic: false,
      success: false,
      reason: "payment_intent_invalido",
      message: "No hay PaymentIntent valido para refund automatico",
    };
  }

  try {
    const refundPayload = {
      payment_intent: paymentIntentId,
      reason: "requested_by_customer",
      metadata: {
        source: "cancelacion_mi_cuenta",
      },
    };

    const safeAmount = Number(amount || 0);
    if (Number.isFinite(safeAmount) && safeAmount > 0) {
      refundPayload.amount = Math.round(safeAmount * 100);
    }

    const refund = await stripe.refunds.create(refundPayload);

    return {
      attempted: true,
      automatic: true,
      success: true,
      refundId: String(refund.id || ""),
      refundStatus: String(refund.status || "pending"),
      paymentIntentId,
    };
  } catch (error) {
    return {
      attempted: true,
      automatic: true,
      success: false,
      reason: "stripe_refund_error",
      message: String(error?.message || "Error creando refund"),
      paymentIntentId,
    };
  }
}

async function tryEnviaCancel(carrier, trackingNumber, folio) {
  const guide = String(trackingNumber || "").trim();
  if (!guide || guide.toUpperCase() === "PENDIENTE") {
    return {
      attempted: false,
      automatic: false,
      success: false,
      reason: "sin_guia",
      message: "No existe guia real para cancelar",
    };
  }

  const safeCarrier = String(carrier || "").trim().toLowerCase();
  if (!safeCarrier) {
    return {
      attempted: false,
      automatic: false,
      success: false,
      reason: "carrier_desconocido",
      message: "No hay carrier guardado; requiere cancelacion manual en Envia",
      trackingNumber: guide,
    };
  }

  const result = await cancelarEnvioEnvia(safeCarrier, guide, folio);
  if (!result.success) {
    return {
      attempted: true,
      automatic: true,
      success: false,
      reason: "envia_cancel_error",
      message: result.error || "No se pudo cancelar la guia en Envia",
      trackingNumber: guide,
      carrier: safeCarrier,
    };
  }

  return {
    attempted: true,
    automatic: true,
    success: true,
    trackingNumber: guide,
    carrier: safeCarrier,
    response: result.data || null,
  };
}

export async function POST({ params, cookies }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) {
    return json({ success: false, error: "No autenticado" }, 401);
  }

  const orderId = Number(params?.id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return json({ success: false, error: "Pedido invalido" }, 400);
  }

  try {
    await ensureSchemasReady();

    const orderResult = await db.execute({
      sql: `
        SELECT
          p.Id_Pedido,
          p.Numero_Pedido,
          p.Id_Usuario,
          p.Estado,
          p.Fecha_pedido,
          p.Id_Direccion,
          pg.Id_Pago,
          pg.Estado_Pago,
          pg.Monto,
          pg.Codigo_Transaccion,
          (
            SELECT e.Fecha_Entrega
            FROM Envio e
            WHERE e.Id_pedido = p.Id_Pedido
            ORDER BY e.Id_Envio DESC
            LIMIT 1
          ) AS Fecha_Entrega_Real
        FROM Pedido p
        LEFT JOIN Pago pg ON pg.Id_Pedido = p.Id_Pedido
        WHERE p.Id_Pedido = ?
        LIMIT 1
      `,
      args: [orderId],
    });

    if (!orderResult.rows.length) {
      return json({ success: false, error: "Pedido no encontrado" }, 404);
    }

    const orderRow = orderResult.rows[0];
    if (Number(orderRow.Id_Usuario) !== Number(sessionUser.userId)) {
      return json({ success: false, error: "No autorizado para este pedido" }, 403);
    }

    if (!isWithinReturnWindow(orderRow.Fecha_pedido)) {
      return json({ success: false, error: `Solo puedes cancelar o devolver dentro de ${RETURN_WINDOW_DAYS} dias desde la compra` }, 400);
    }

    const deliveredReturnFlow = isEligibleDeliveredReturn(
      orderRow.Estado,
      orderRow.Fecha_Entrega_Real,
      orderRow.Fecha_pedido
    );
    if (!deliveredReturnFlow && !isOrderCancelable(orderRow.Estado, orderRow.Estado_Pago)) {
      return json({ success: false, error: "Este pedido ya no se puede cancelar" }, 400);
    }

    const details = await db.execute({
      sql: `
        SELECT
          dp.Id_Producto,
          dp.Cantidad,
          dp.Precio_Unitario,
          COALESCE(p.Peso, 0.5) AS Peso
        FROM DetallePedido dp
        JOIN Producto p ON p.Id_Producto = dp.Id_Producto
        WHERE dp.Id_Pedido = ?
      `,
      args: [orderId],
    });

    const direccionResult = await db.execute({
      sql: `
        SELECT Calle, Numero_casa, Codigo_Postal, Ciudad, Provincia
        FROM Direccion
        WHERE Id_Direccion = ?
        LIMIT 1
      `,
      args: [Number(orderRow.Id_Direccion || 0)],
    });

    const envioResult = await db.execute({
      sql: `
        SELECT Id_Envio, Numero_Guia, Estado_envio, Carrier, Service
        FROM Envio
        WHERE Id_pedido = ?
        ORDER BY Id_Envio DESC
        LIMIT 1
      `,
      args: [orderId],
    });

    let refundResult = {
      attempted: false,
      automatic: false,
      success: true,
      reason: "no_aplica",
      message: "El pago no requiere refund",
    };

    let devolucionResult = {
      attempted: false,
      automatic: false,
      success: true,
      message: null,
      labelUrl: null,
      trackingNumber: null,
      carrier: null,
      service: null,
      trackUrl: null,
    };
    let shouldInsertDevolucion = false;

    const pagoEstado = String(orderRow.Estado_Pago || "").toLowerCase();
    const needsRefund = ["aprobado", "pagado", "capturado"].includes(pagoEstado);

    if (deliveredReturnFlow) {
      const existingReturn = await db.execute({
        sql: `
          SELECT Id_Devolucion, Carrier, Service, Numero_Guia, Label_URL, Track_URL
          FROM DevolucionPedido
          WHERE Id_Pedido = ?
            AND Estado IN ('solicitada', 'en_transito', 'recibida')
          ORDER BY Id_Devolucion DESC
          LIMIT 1
        `,
        args: [orderId],
      });

      if (existingReturn.rows.length) {
        const r = existingReturn.rows[0];
        devolucionResult = {
          attempted: true,
          automatic: true,
          success: true,
          message: "Ya existe una devolucion activa para este pedido",
          labelUrl: r.Label_URL ? String(r.Label_URL) : null,
          trackingNumber: r.Numero_Guia ? String(r.Numero_Guia) : null,
          carrier: r.Carrier ? String(r.Carrier) : "estafeta",
          service: r.Service ? String(r.Service) : "ground",
          trackUrl: r.Track_URL ? String(r.Track_URL) : null,
        };
      }

      if (!existingReturn.rows.length) {
        if (!direccionResult.rows.length) {
          return json({ success: false, error: "No se encontro direccion del pedido para generar devolucion" }, 400);
        }

        const d = direccionResult.rows[0];
        const returnItems = details.rows.map((row) => {
          const qty = Number(row.Cantidad || 0);
          const price = Number(row.Precio_Unitario || 0);
          return {
            cantidad: qty,
            subtotal: Number((qty * price).toFixed(2)),
            peso: Number(row.Peso || 0.5),
          };
        });

        const retorno = await generarEtiquetaDevolucionEnvia(
        {
          calle: String(d.Calle || ""),
          numero: d.Numero_casa != null ? String(d.Numero_casa) : "S/N",
          ciudad: String(d.Ciudad || ""),
          estado: String(d.Provincia || ""),
          cp: String(d.Codigo_Postal || ""),
          pais: "MX",
          nombre: String(sessionUser.nombre || "Cliente"),
        },
        returnItems,
        "ground"
      );

        if (!retorno.success) {
          return json({
            success: false,
            error: retorno.error || "No se pudo generar la guia de devolucion con Estafeta",
          }, 502);
        }

        devolucionResult = {
          attempted: true,
          automatic: true,
          success: true,
          message: "Guia de devolucion generada",
          labelUrl: retorno.data?.labelUrl || null,
          trackingNumber: retorno.data?.trackingNumber || null,
          carrier: retorno.data?.carrier || "estafeta",
          service: retorno.data?.service || "ground",
          trackUrl: retorno.data?.trackUrl || null,
        };
        shouldInsertDevolucion = true;
      }
    } else {
      refundResult = needsRefund
        ? await tryStripeRefund(orderRow.Codigo_Transaccion, Number(orderRow.Monto || 0))
        : refundResult;
    }

    const envioRow = envioResult.rows[0] || null;
    const envioCancelResult = envioRow
      ? await tryEnviaCancel(envioRow.Carrier, envioRow.Numero_Guia, String(orderRow.Numero_Pedido || ""))
      : {
          attempted: false,
          automatic: false,
          success: true,
          reason: "sin_envio",
          message: "No existe envio para este pedido",
        };

    // Si el refund era requerido pero fallo, no bloqueamos la cancelacion del pedido;
    // dejamos trazabilidad para seguimiento manual.

    const statements = [];

    if (!deliveredReturnFlow) {
      for (const row of details.rows) {
        const productId = Number(row.Id_Producto);
        const quantity = Number(row.Cantidad || 0);
        if (!Number.isInteger(productId) || productId <= 0 || quantity <= 0) continue;

        statements.push({
          sql: `
            UPDATE Producto
            SET StockDisponible = COALESCE(StockDisponible, 0) + ?
            WHERE Id_Producto = ?
          `,
          args: [quantity, productId],
        });
      }
    }

    statements.push({
      sql: `UPDATE Pedido SET Estado = ? WHERE Id_Pedido = ?`,
      args: [deliveredReturnFlow ? "devolucion_solicitada" : "cancelado", orderId],
    });

    const refundMap = mapRefundStatus(refundResult.refundStatus);
    const estadoPagoFinal = deliveredReturnFlow
      ? "reembolso_pendiente"
      : needsRefund
      ? refundResult.success
        ? refundMap.estadoPago
        : "reembolso_pendiente"
      : String(orderRow.Estado_Pago || "");
    const estadoReembolsoFinal = deliveredReturnFlow
      ? "pendiente_devolucion"
      : needsRefund
      ? refundResult.success
        ? refundMap.estadoReembolso
        : "pendiente"
      : "no_aplica";

    statements.push({
      sql: `
        UPDATE Pago
        SET
          Estado_Pago = ?,
          Estado_Reembolso = ?,
          Stripe_Refund_Id = ?,
          Fecha_Reembolso = ?
        WHERE Id_Pedido = ?
      `,
      args: [
        estadoPagoFinal,
        estadoReembolsoFinal,
        refundResult.refundId || null,
        refundResult.success ? new Date().toISOString() : null,
        orderId,
      ],
    });

    if (envioRow && envioCancelResult.attempted && envioCancelResult.success) {
      statements.push({
        sql: `UPDATE Envio SET Estado_envio = ? WHERE Id_Envio = ?`,
        args: ["cancelado", Number(envioRow.Id_Envio)],
      });
    }

    if (deliveredReturnFlow && devolucionResult.success && shouldInsertDevolucion) {
      const baseDate = new Date(String(orderRow.Fecha_Entrega_Real || new Date().toISOString()));
      const limitDate = new Date(baseDate.getTime() + RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const now = new Date().toISOString();

      statements.push({
        sql: `
          INSERT INTO DevolucionPedido (
            Id_Pedido, Estado, Carrier, Service, Numero_Guia, Label_URL, Track_URL,
            Fecha_Limite, Fecha_Creacion, Fecha_Actualizacion
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          orderId,
          "solicitada",
          devolucionResult.carrier,
          devolucionResult.service,
          devolucionResult.trackingNumber,
          devolucionResult.labelUrl,
          devolucionResult.trackUrl,
          limitDate,
          now,
          now,
        ],
      });
    }

    await db.batch(statements, "write");

    return json({
      success: true,
      message: "Pedido cancelado correctamente",
      pedido: {
        idPedido: Number(orderRow.Id_Pedido),
        numeroPedido: Number(orderRow.Numero_Pedido || 0),
        estado: deliveredReturnFlow ? "devolucion_solicitada" : "cancelado",
      },
      cancelacionAutomatica: {
        stripe: {
          attempted: Boolean(refundResult.attempted),
          automatic: Boolean(refundResult.automatic),
          success: Boolean(refundResult.success),
          refundId: refundResult.refundId || null,
          refundStatus: refundResult.refundStatus || null,
          message: refundResult.message || null,
        },
        envia: {
          attempted: Boolean(envioCancelResult.attempted),
          automatic: Boolean(envioCancelResult.automatic),
          success: Boolean(envioCancelResult.success),
          trackingNumber: envioCancelResult.trackingNumber || null,
          carrier: envioCancelResult.carrier || null,
          message: envioCancelResult.message || null,
        },
      },
      devolucion: {
        attempted: Boolean(devolucionResult.attempted),
        automatic: Boolean(devolucionResult.automatic),
        success: Boolean(devolucionResult.success),
        carrier: devolucionResult.carrier,
        trackingNumber: devolucionResult.trackingNumber,
        labelUrl: devolucionResult.labelUrl,
        trackUrl: devolucionResult.trackUrl,
        message: devolucionResult.message,
        windowDays: RETURN_WINDOW_DAYS,
      },
    });
  } catch (error) {
    console.error("[POST /api/me/pedidos/:id/cancelar] Error:", error);
    const detailed = String(error?.message || "").trim();
    return json(
      {
        success: false,
        error: detailed || "No se pudo cancelar el pedido",
      },
      500
    );
  }
}
