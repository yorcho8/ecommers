import { createClient } from "@libsql/client";
import "dotenv/config";
import { trackPublicidadEvent } from "../../../lib/publicidad.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST({ request }) {
  try {
    const body = await request.json().catch(() => ({}));
    const campaignId = Number(body?.campaignId);
    const tipo = String(body?.tipo || "").toLowerCase();
    const posicion = body?.posicion ? String(body.posicion).toLowerCase() : null;

    if (!Number.isFinite(campaignId) || campaignId <= 0) {
      return jsonResponse(400, { success: false, error: "campaignId invalido" });
    }

    if (tipo !== "impresion" && tipo !== "click") {
      return jsonResponse(400, { success: false, error: "tipo invalido" });
    }

    const ok = await trackPublicidadEvent({
      campaignId,
      tipo,
      posicion,
      metadata: {
        page: String(body?.page || "home"),
        source: String(body?.source || "nexus"),
        lang: body?.lang ? String(body.lang) : null,
      },
      db,
    });

    if (!ok) {
      return jsonResponse(400, { success: false, error: "Evento invalido" });
    }

    return jsonResponse(200, { success: true });
  } catch (error) {
    console.error("[POST /api/publicidad/track]", error);
    return jsonResponse(500, { success: false, error: error?.message || "Error interno" });
  }
}
