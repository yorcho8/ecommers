/**
 * /webhook — Endpoint para notificaciones de Envia.com (sandbox y producción).
 *
 * Envia.com llama a esta URL cuando el estado de un envío cambia.
 * El ngrok expone este endpoint públicamente para pruebas locales:
 *   https://semiarticulately-untextual-melodie.ngrok-free.app/webhook
 *
 * Eventos manejados: label_created, picked_up, in_transit,
 *   out_for_delivery, delivered, exception, returned.
 *
 * Seguridad: si defines ENVIA_WEBHOOK_SECRET en .env, solo acepta
 * requests con el header X-Envia-Signature correcto.
 */

import { createClient } from "@libsql/client";
import { createHmac, timingSafeEqual } from "node:crypto";
import "dotenv/config";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env?.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env?.ECOMERS_AUTH_TOKEN,
});

const WEBHOOK_SECRET =
  process.env.ENVIA_WEBHOOK_SECRET || import.meta.env?.ENVIA_WEBHOOK_SECRET || "";

const REPLAY_WINDOW_SECONDS = Math.max(
  30,
  Number(process.env.ENVIA_WEBHOOK_WINDOW_SECONDS || import.meta.env?.ENVIA_WEBHOOK_WINDOW_SECONDS || 300) || 300,
);

function normalizeSignature(signature) {
  const raw = String(signature || "").trim();
  if (!raw) return "";
  return raw.replace(/^sha256=/i, "");
}

function verifyEnviaSignature({ bodyText, timestamp, signature }) {
  const sigHex = normalizeSignature(signature);
  if (!sigHex || !timestamp || !WEBHOOK_SECRET) return false;

  const signedPayload = `${timestamp}.${bodyText}`;
  const expected = createHmac("sha256", WEBHOOK_SECRET)
    .update(signedPayload)
    .digest("hex");

  const sigBuf = Buffer.from(sigHex, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (!sigBuf.length || sigBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(sigBuf, expectedBuf);
}

function isTimestampInWindow(timestampValue) {
  const ts = Number(timestampValue || 0);
  if (!Number.isFinite(ts) || ts <= 0) return false;

  const tsSeconds = ts > 1_000_000_000_000 ? Math.floor(ts / 1000) : Math.floor(ts);
  const nowSeconds = Math.floor(Date.now() / 1000);
  return Math.abs(nowSeconds - tsSeconds) <= REPLAY_WINDOW_SECONDS;
}

// Mapeo de estados Envia → estados internos
const STATUS_MAP = {
  label_created:        { envio: "creado",       pedido: null },
  created:              { envio: "creado",       pedido: null },
  picked_up:            { envio: "en_transito",  pedido: "en_transito" },
  in_transit:           { envio: "en_transito",  pedido: "en_transito" },
  in_transit_to_pickup: { envio: "en_transito",  pedido: "en_transito" },
  out_for_delivery:     { envio: "en_camino",    pedido: "en_camino" },
  delivered:            { envio: "entregado",    pedido: "entregado" },
  exception:            { envio: "incidencia",   pedido: "incidencia" },
  failed_delivery:      { envio: "incidencia",   pedido: "incidencia" },
  undelivered:          { envio: "incidencia",   pedido: "incidencia" },
  returned:             { envio: "devuelto",     pedido: "devuelto" },
  return_to_sender:     { envio: "devuelto",     pedido: "devuelto" },
};

// ── GET: verificación de URL (algunos sistemas lo usan al registrar el webhook) ──
export async function GET() {
  return new Response(
    JSON.stringify({ ok: true, service: "envia-webhook" }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

// ── POST: evento real de Envia.com ────────────────────────────────────────────
export async function POST({ request }) {
  try {
    const bodyText = await request.text();

    // Verificación de firma HMAC con timestamp anti-replay.
    if (WEBHOOK_SECRET) {
      const sig =
        request.headers.get("x-envia-signature") ||
        request.headers.get("x-webhook-signature") ||
        "";
      const timestamp =
        request.headers.get("x-envia-timestamp") ||
        request.headers.get("x-webhook-timestamp") ||
        "";

      if (!isTimestampInWindow(timestamp)) {
        return new Response(
          JSON.stringify({ error: "Timestamp fuera de ventana" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }

      if (!verifyEnviaSignature({ bodyText, timestamp, signature: sig })) {
        return new Response(
          JSON.stringify({ error: "Firma inválida" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return new Response(
        JSON.stringify({ error: "JSON inválido" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Extraer campos del payload — Envia.com puede enviar snake_case o camelCase
    const trackingNumber =
      payload?.data?.trackingNumber ||
      payload?.data?.tracking_number ||
      payload?.trackingNumber ||
      payload?.tracking_number ||
      null;

    const rawStatus = String(
      payload?.data?.status ||
      payload?.status ||
      ""
    )
      .toLowerCase()
      .trim()
      .replace(/[\s-]+/g, "_");

    const estimatedDelivery =
      payload?.data?.estimatedDelivery ||
      payload?.data?.estimated_delivery_date ||
      payload?.estimatedDelivery ||
      null;

    const event = payload?.event || "unknown";

    console.log(`[webhook/envia] evento="${event}" tracking="${trackingNumber}" status="${rawStatus}"`);

    // Si no hay datos útiles, responder 200 para que Envia no reintente
    if (!trackingNumber || !rawStatus) {
      return new Response(
        JSON.stringify({ received: true, skipped: "faltan campos requeridos" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Buscar el registro Envio por número de guía
    const envioResult = await db.execute({
      sql: `SELECT Id_Envio, Id_pedido FROM Envio WHERE Numero_Guia = ? LIMIT 1`,
      args: [trackingNumber],
    });

    if (!envioResult.rows.length) {
      console.warn(`[webhook/envia] Guía "${trackingNumber}" no encontrada en BD`);
      return new Response(
        JSON.stringify({ received: true, skipped: "guía no encontrada" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const envio = envioResult.rows[0];
    const envioId = Number(envio.Id_Envio);
    const pedidoId = Number(envio.Id_pedido);
    const mapped = STATUS_MAP[rawStatus] || { envio: rawStatus, pedido: null };
    const now = new Date().toISOString();

    // Actualizar Envio
    if (rawStatus === "delivered") {
      await db.execute({
        sql: `UPDATE Envio SET Estado_envio = ?, Fecha_Entrega = ? WHERE Id_Envio = ?`,
        args: [mapped.envio, estimatedDelivery || now, envioId],
      });
    } else {
      await db.execute({
        sql: `UPDATE Envio SET Estado_envio = ? WHERE Id_Envio = ?`,
        args: [mapped.envio, envioId],
      });
    }

    // Actualizar Pedido si el estado tiene un equivalente
    if (mapped.pedido) {
      await db.execute({
        sql: `UPDATE Pedido SET Estado = ? WHERE Id_Pedido = ?`,
        args: [mapped.pedido, pedidoId],
      });
    }

    console.log(
      `[webhook/envia] Actualizado: guía=${trackingNumber} → envio="${mapped.envio}" pedido=${pedidoId}` +
      (mapped.pedido ? ` pedido_estado="${mapped.pedido}"` : "")
    );

    return new Response(
      JSON.stringify({
        received: true,
        tracking: trackingNumber,
        estadoEnvio: mapped.envio,
        estadoPedido: mapped.pedido,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[webhook/envia] Error interno:", err);
    // Siempre responder 200 para que Envia.com no reintente indefinidamente
    return new Response(
      JSON.stringify({ received: true, error: "error interno" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
}
