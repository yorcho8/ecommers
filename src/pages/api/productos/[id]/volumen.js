/**
 * GET /api/productos/[id]/volumen  — Obtiene los tiers de precio por volumen de un producto (público)
 */
import { createClient } from "@libsql/client";
import "dotenv/config";
import { getVolumeTiersForProduct, ensureVolumePricingSchema } from "../../../../lib/pricing.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

export async function GET({ params }) {
  const productoId = Number(params.id || "");
  if (!productoId) {
    return new Response(JSON.stringify({ success: false, error: "ID inválido" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  try {
    await ensureVolumePricingSchema(db);
    const tiers = await getVolumeTiersForProduct(db, productoId);
    return new Response(JSON.stringify({ success: true, tiers }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e?.message || "Error" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}
