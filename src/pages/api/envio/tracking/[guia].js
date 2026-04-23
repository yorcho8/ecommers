/**
 * GET /api/envio/tracking/:guia
 *
 * Tracking público de guía. Devuelve el estado del envío
 * consultando la API del carrier correspondiente.
 *
 * Carriers soportados:
 *   - envia.com  (FedEx, DHL, Estafeta, etc.)
 *   - paquetexpress
 *
 * Respuesta estandarizada:
 *   { success, guia, carrier, estado, eventos[], trackUrl }
 */
import "dotenv/config";
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

// Envia.com
const ENVIA_ENV = process.env.ENVIA_ENV || import.meta.env?.ENVIA_ENV || "sandbox";
const ENVIA_BASE =
  ENVIA_ENV === "production"
    ? "https://api.envia.com"
    : "https://api-test.envia.com";
const ENVIA_TOKEN =
  process.env.ENVIA_API_TOKEN || import.meta.env?.ENVIA_API_TOKEN || "";

// PaquetExpress
const PX_ENV   = process.env.PAQUETEXPRESS_ENV || import.meta.env?.PAQUETEXPRESS_ENV || "sandbox";
const PX_BASE  = PX_ENV === "production"
  ? "https://cc.paquetexpress.com.mx/WsQuotation"
  : "https://cc-test.paquetexpress.com.mx/WsQuotation";
const PX_USER  = process.env.PAQUETEXPRESS_USER || import.meta.env?.PAQUETEXPRESS_USER || "";
const PX_PASS  = process.env.PAQUETEXPRESS_PASSWORD || import.meta.env?.PAQUETEXPRESS_PASSWORD || "";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function trackEnvia(guia) {
  const url = `${ENVIA_BASE}/ship/track`;
  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${ENVIA_TOKEN}`,
    },
    body: JSON.stringify({ trackingNumber: guia }),
  });

  if (!res.ok) {
    throw new Error(`Envia API error: ${res.status}`);
  }

  const data = await res.json();

  // Normalize Envia tracking response
  const events = Array.isArray(data?.data?.events || data?.events)
    ? (data?.data?.events || data?.events).map((e) => ({
        fecha:       String(e.date || e.registered_at || ""),
        descripcion: String(e.description || e.status || ""),
        ubicacion:   String(e.location || e.city || ""),
      }))
    : [];

  const lastEvent = events[0] || null;
  return {
    estado:   lastEvent?.descripcion || String(data?.data?.status || data?.status || "En tránsito"),
    eventos:  events,
    trackUrl: data?.data?.trackUrl || data?.trackUrl || `https://www.envia.com/rastreo/${guia}`,
  };
}

async function trackPaquetExpress(guia) {
  if (!PX_USER || !PX_PASS) {
    throw new Error("Credenciales de PaquetExpress no configuradas");
  }

  // PaquetExpress tracking endpoint (SOAP-based fallback for now)
  const res = await fetch(`${PX_BASE}/tracking?guia=${encodeURIComponent(guia)}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${PX_USER}:${PX_PASS}`).toString("base64")}`,
    },
  });

  if (!res.ok) {
    throw new Error(`PaquetExpress API error: ${res.status}`);
  }

  const data = await res.json().catch(() => ({}));

  const events = Array.isArray(data?.eventos || data?.events)
    ? (data.eventos || data.events).map((e) => ({
        fecha:       String(e.fecha || e.date || ""),
        descripcion: String(e.descripcion || e.description || e.status || ""),
        ubicacion:   String(e.ubicacion || e.location || ""),
      }))
    : [];

  return {
    estado:   events[0]?.descripcion || String(data?.estado || data?.status || "En tránsito"),
    eventos:  events,
    trackUrl: `https://www.paquetexpress.com.mx/rastreo?guia=${encodeURIComponent(guia)}`,
  };
}

export async function GET({ params }) {
  const guia = String(params.guia || "").trim();
  if (!guia || guia === "PENDIENTE") {
    return json({ success: false, error: "Guía inválida o pendiente de generación" }, 400);
  }

  try {
    // Look up the carrier from the database
    const envioRes = await db.execute({
      sql: `
        SELECT e.Carrier, e.Estado_envio, e.Carrier AS CarrierNombre
        FROM Envio e
        WHERE e.Numero_Guia = ?
        LIMIT 1
      `,
      args: [guia],
    });

    const carrier = envioRes.rows.length
      ? String(envioRes.rows[0].Carrier || "envia").toLowerCase()
      : "envia";

    let trackData;
    if (carrier === "paquetexpress") {
      trackData = await trackPaquetExpress(guia);
    } else {
      trackData = await trackEnvia(guia);
    }

    return json({
      success:  true,
      guia,
      carrier,
      estado:   trackData.estado,
      eventos:  trackData.eventos,
      trackUrl: trackData.trackUrl,
    });
  } catch (error) {
    console.error("[GET /api/envio/tracking/:guia]", error);
    return json({
      success: false,
      error:   "No se pudo obtener el estado del envío",
      detail:  String(error?.message || error),
    }, 502);
  }
}
