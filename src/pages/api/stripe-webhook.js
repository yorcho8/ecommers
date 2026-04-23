/**
 * POST /api/stripe-webhook
 *
 * Stripe webhook handler. Verifica la firma del evento y procesa
 * los eventos relevantes del ciclo de vida del pago.
 *
 * Para activar en producción:
 *   1. Agrega STRIPE_WEBHOOK_SECRET en tu archivo .env
 *   2. Registra esta URL en el dashboard de Stripe:
 *      Developers → Webhooks → Add endpoint → https://tu-dominio.com/api/stripe-webhook
 *   3. Selecciona los eventos: payment_intent.succeeded,
 *      payment_intent.payment_failed, charge.refunded
 *
 * IMPORTANTE: Esta ruta NO lee JSON — Stripe requiere el body crudo
 * para verificar la firma. No uses request.json() aquí.
 */
import Stripe from "stripe";
import "dotenv/config";
import { createClient } from "@libsql/client";
import { logSecurityEvent, shortHash } from "../../lib/security-audit.js";

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY || ""
);

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

// TODO: Configura STRIPE_WEBHOOK_SECRET en .env cuando despliegues a producción.
// Obtenlo en: https://dashboard.stripe.com/webhooks → tu endpoint → "Signing secret"
const WEBHOOK_SECRET =
  process.env.STRIPE_WEBHOOK_SECRET ||
  import.meta.env.STRIPE_WEBHOOK_SECRET ||
  "";

async function ensureStripeWebhookSchema() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS StripeWebhookEvent (
      Event_Id TEXT PRIMARY KEY,
      Event_Type TEXT,
      Received_At TEXT NOT NULL,
      Processed_At TEXT,
      Status TEXT NOT NULL,
      Error TEXT
    )
  `);
}

async function markEventReceived(eventId, eventType) {
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO StripeWebhookEvent (Event_Id, Event_Type, Received_At, Status)
          VALUES (?, ?, ?, ?)` ,
    args: [eventId, eventType, now, "received"],
  });
}

async function markEventProcessed(eventId) {
  await db.execute({
    sql: `UPDATE StripeWebhookEvent
          SET Processed_At = ?, Status = ?, Error = NULL
          WHERE Event_Id = ?`,
    args: [new Date().toISOString(), "processed", eventId],
  });
}

async function markEventFailed(eventId, error) {
  await db.execute({
    sql: `UPDATE StripeWebhookEvent
          SET Processed_At = ?, Status = ?, Error = ?
          WHERE Event_Id = ?`,
    args: [new Date().toISOString(), "failed", String(error?.message || error || "Unknown error").slice(0, 1000), eventId],
  });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Handlers por tipo de evento ───────────────────────────────────────────────

async function handlePaymentIntentSucceeded(paymentIntent) {
  var paymentIntentId = String(paymentIntent?.id || "").trim();
  if (!paymentIntentId) return;

  var amount = Number(paymentIntent?.amount_received || paymentIntent?.amount || 0) / 100;
  var currency = String(paymentIntent?.currency || "mxn").toLowerCase();
  var now = new Date().toISOString();

  const pagoRes = await db.execute({
    sql: `SELECT Id_Pago, Id_Pedido, Estado_Pago
          FROM Pago
          WHERE Codigo_Transaccion = ?
          ORDER BY Id_Pago DESC
          LIMIT 1`,
    args: [paymentIntentId],
  });

  if (pagoRes.rows.length) {
    const pago = pagoRes.rows[0];
    const orderId = Number(pago.Id_Pedido || 0);
    await db.batch([
      {
        sql: `UPDATE Pago
              SET Estado_Pago = ?, Fecha_Pago = ?, Monto = COALESCE(Monto, ?)
              WHERE Id_Pago = ?`,
        args: ["aprobado", now, amount, Number(pago.Id_Pago)],
      },
      {
        sql: `UPDATE Pedido
              SET Estado = ?
              WHERE Id_Pedido = ? AND LOWER(COALESCE(Estado, '')) NOT IN ('cancelado', 'devolucion_completada')`,
        args: ["pagado", orderId],
      },
    ], "write");
    return;
  }

  const metadataOrderNumber = Number(paymentIntent?.metadata?.orderNumber || 0);
  if (!metadataOrderNumber) return;

  const orderRes = await db.execute({
    sql: `SELECT Id_Pedido, Estado
          FROM Pedido
          WHERE Numero_Pedido = ?
          LIMIT 1`,
    args: [metadataOrderNumber],
  });

  if (!orderRes.rows.length) return;
  const orderId = Number(orderRes.rows[0].Id_Pedido || 0);
  if (!orderId) return;

  await db.batch([
    {
      sql: `INSERT INTO Pago (Id_Pedido, Metodo_Pago, Estado_Pago, Monto, Codigo_Transaccion, Fecha_Pago)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [orderId, "tarjeta", "aprobado", amount, paymentIntentId, now],
    },
    {
      sql: `UPDATE Pedido
            SET Estado = ?
            WHERE Id_Pedido = ? AND LOWER(COALESCE(Estado, '')) NOT IN ('cancelado', 'devolucion_completada')`,
      args: ["pagado", orderId],
    },
  ], "write");

  console.log(`[stripe-webhook] payment_intent.succeeded procesado. orderId=${orderId} pi=${paymentIntentId} currency=${currency}`);
}

async function handlePaymentIntentFailed(paymentIntent) {
  var paymentIntentId = String(paymentIntent?.id || "").trim();
  if (!paymentIntentId) return;

  const pagoRes = await db.execute({
    sql: `SELECT Id_Pago, Id_Pedido
          FROM Pago
          WHERE Codigo_Transaccion = ?
          ORDER BY Id_Pago DESC
          LIMIT 1`,
    args: [paymentIntentId],
  });

  if (!pagoRes.rows.length) {
    console.log("[stripe-webhook] payment_intent.payment_failed sin pago local:", paymentIntentId);
    return;
  }

  const pago = pagoRes.rows[0];
  await db.batch([
    {
      sql: `UPDATE Pago SET Estado_Pago = ? WHERE Id_Pago = ?`,
      args: ["fallido", Number(pago.Id_Pago)],
    },
    {
      sql: `UPDATE Pedido
            SET Estado = ?
            WHERE Id_Pedido = ?
              AND LOWER(COALESCE(Estado, '')) IN ('pendiente', 'pendiente_pago', 'pago_pendiente')`,
      args: ["pago_fallido", Number(pago.Id_Pedido)],
    },
  ], "write");
}

async function handleChargeRefunded(charge) {
  const amountRefunded = Number(charge?.amount_refunded || 0);
  const amountCharged = Number(charge?.amount || 0);
  const paymentIntent = String(charge?.payment_intent || "").trim();
  const refundId = String(charge?.refunds?.data?.[0]?.id || "").trim();
  if (!paymentIntent) return;

  const pagoRes = await db.execute({
    sql: `SELECT Id_Pago, Id_Pedido, Estado_Pago
          FROM Pago
          WHERE Codigo_Transaccion = ?
          ORDER BY Id_Pago DESC
          LIMIT 1`,
    args: [paymentIntent],
  });

  if (!pagoRes.rows.length) return;
  const pago = pagoRes.rows[0];
  const orderId = Number(pago.Id_Pedido || 0);
  const now = new Date().toISOString();

  await db.execute({
    sql: `UPDATE Pago
          SET Estado_Pago = ?, Fecha_Pago = COALESCE(Fecha_Pago, ?)
          WHERE Id_Pago = ?`,
    args: ["reembolsado", now, Number(pago.Id_Pago)],
  });

  await db.execute({
    sql: `UPDATE Pedido
          SET Estado = ?
          WHERE Id_Pedido = ?`,
    args: ["devolucion_completada", orderId],
  });

  const isFullRefund = amountCharged > 0 && amountRefunded >= amountCharged;
  if (!isFullRefund || !orderId) {
    console.log(`[stripe-webhook] charge.refunded parcial. pi=${paymentIntent} amount=${amountRefunded / 100}`);
    return;
  }

  const itemsRes = await db.execute({
    sql: `SELECT Id_Producto, Id_Variante, COALESCE(Cantidad, 0) AS Cantidad
          FROM DetallePedido
          WHERE Id_Pedido = ?`,
    args: [orderId],
  });

  if (!itemsRes.rows.length) return;

  const statements = [];
  for (const row of itemsRes.rows) {
    const qty = Number(row.Cantidad || 0);
    const productId = Number(row.Id_Producto || 0);
    const variantId = row.Id_Variante == null ? null : Number(row.Id_Variante);
    if (!qty || !productId) continue;

    statements.push({
      sql: `UPDATE Producto
            SET StockDisponible = COALESCE(StockDisponible, 0) + ?
            WHERE Id_Producto = ?`,
      args: [qty, productId],
    });

    if (variantId) {
      statements.push({
        sql: `UPDATE ProductoVariante
              SET Stock = COALESCE(Stock, 0) + ?
              WHERE Id_Variante = ?`,
        args: [qty, variantId],
      });
    }
  }

  if (statements.length) {
    await db.batch(statements, "write");
  }

  console.log(`[stripe-webhook] charge.refunded total. orderId=${orderId} pi=${paymentIntent} refund=${refundId || 'n/a'}`);
}

// ── Handler principal ─────────────────────────────────────────────────────────

export async function POST({ request }) {
  const route = new URL(request.url).pathname;
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    "127.0.0.1";
  const userAgent = request.headers.get("user-agent") || "";

  if (!WEBHOOK_SECRET) {
    // Fail-closed in all environments: never accept unsigned webhook events.
    console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET no configurado. Rechazando solicitud.");
    await logSecurityEvent(db, {
      eventType: "stripe_webhook_secret_missing",
      severity: "critical",
      ip,
      userAgent,
      route,
      method: request.method,
      statusCode: 500,
    });
    return json({ error: "Webhook no configurado" }, 500);
  }

  // Read raw body for signature verification
  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    return json({ error: "No se pudo leer el cuerpo de la solicitud" }, 400);
  }

  const sig = request.headers.get("stripe-signature") || "";
  if (!sig) {
    await logSecurityEvent(db, {
      eventType: "stripe_webhook_missing_signature",
      severity: "warning",
      ip,
      userAgent,
      route,
      method: request.method,
      statusCode: 400,
    });
    return json({ error: "Falta la cabecera stripe-signature" }, 400);
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error("[stripe-webhook] Firma inválida:", err.message);
    await logSecurityEvent(db, {
      eventType: "stripe_webhook_invalid_signature",
      severity: "warning",
      ip,
      userAgent,
      route,
      method: request.method,
      statusCode: 400,
      meta: { signatureHash: shortHash(sig) },
    });
    return json({ error: `Firma Stripe inválida: ${err.message}` }, 400);
  }

  try {
    await ensureStripeWebhookSchema();
  } catch (err) {
    console.error("[stripe-webhook] No se pudo preparar schema de idempotencia:", err);
    return json({ error: "Error interno" }, 500);
  }

  try {
    await markEventReceived(String(event.id || ""), String(event.type || ""));
  } catch (err) {
    // Primary key conflict means Stripe retried an event we already accepted.
    if (String(err?.message || "").toLowerCase().includes("unique")) {
      await logSecurityEvent(db, {
        eventType: "stripe_webhook_duplicate_event",
        severity: "info",
        ip,
        userAgent,
        route,
        method: request.method,
        statusCode: 200,
        meta: { eventId: String(event.id || ""), eventType: String(event.type || "") },
      });
      return json({ received: true, duplicate: true });
    }
    console.error("[stripe-webhook] Error registrando evento:", err);
    return json({ error: "Error interno" }, 500);
  }

  try {
    await dispatch(event.type, event.data.object);
    await markEventProcessed(String(event.id || ""));
    await logSecurityEvent(db, {
      eventType: "stripe_webhook_processed",
      severity: "info",
      ip,
      userAgent,
      route,
      method: request.method,
      statusCode: 200,
      meta: { eventId: String(event.id || ""), eventType: String(event.type || "") },
    });
  } catch (err) {
    await markEventFailed(String(event.id || ""), err).catch(() => {});
    console.error(`[stripe-webhook] Error procesando evento ${event.type}:`, err);
    await logSecurityEvent(db, {
      eventType: "stripe_webhook_processing_failed",
      severity: "error",
      ip,
      userAgent,
      route,
      method: request.method,
      statusCode: 200,
      meta: {
        eventId: String(event.id || ""),
        eventType: String(event.type || ""),
        error: String(err?.message || "unknown"),
      },
    });
    // Respond 200 to prevent Stripe from retrying on application errors
    return json({ received: true, warning: "Evento recibido pero con error interno" });
  }

  return json({ received: true });
}

async function dispatch(type, data) {
  switch (type) {
    case "payment_intent.succeeded":
      await handlePaymentIntentSucceeded(data);
      break;
    case "payment_intent.payment_failed":
      await handlePaymentIntentFailed(data);
      break;
    case "charge.refunded":
      await handleChargeRefunded(data);
      break;
    default:
      // Silently ignore unhandled event types
      break;
  }
}
