/**
 * GET /api/envio/debug
 *
 * Endpoint de diagnóstico — solo funciona en modo sandbox/desarrollo.
 * Llama directamente a Envia.com con datos fijos y devuelve la respuesta
 * completa para ver qué está fallando.
 *
 * Visita: http://localhost:4321/api/envio/debug
 */

import "dotenv/config";
import { createClient } from "@libsql/client";
import { logSecurityEvent } from "../../../lib/security-audit.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

const ENVIA_ENV = process.env.ENVIA_ENV || import.meta.env?.ENVIA_ENV || "sandbox";
const BASE_URL = ENVIA_ENV === "production"
  ? "https://api.envia.com"
  : "https://api-test.envia.com";
const TOKEN = process.env.ENVIA_API_TOKEN || import.meta.env?.ENVIA_API_TOKEN || "";
const DEBUG_SECRET =
  process.env.DEBUG_API_SECRET ||
  import.meta.env?.DEBUG_API_SECRET ||
  process.env.CRON_SECRET ||
  import.meta.env?.CRON_SECRET ||
  "";

export async function GET({ request }) {
  const route = new URL(request.url).pathname;
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    "127.0.0.1";
  const userAgent = request.headers.get("user-agent") || "";

  if (ENVIA_ENV === "production") {
    await logSecurityEvent(db, {
      eventType: "envio_debug_blocked_production",
      severity: "warning",
      ip,
      userAgent,
      route,
      method: request.method,
      statusCode: 403,
    });
    return new Response(JSON.stringify({ error: "debug solo disponible en sandbox" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!DEBUG_SECRET) {
    await logSecurityEvent(db, {
      eventType: "envio_debug_not_configured",
      severity: "warning",
      ip,
      userAgent,
      route,
      method: request.method,
      statusCode: 500,
    });
    return new Response(JSON.stringify({ error: "debug no configurado" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const authHeader = request.headers.get("Authorization") || "";
  const provided = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (provided !== DEBUG_SECRET) {
    await logSecurityEvent(db, {
      eventType: "envio_debug_unauthorized",
      severity: "warning",
      ip,
      userAgent,
      route,
      method: request.method,
      statusCode: 401,
    });
    return new Response(JSON.stringify({ error: "No autorizado" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const origin = {
    name: "Almacén GO",
    company: "GO Ecomers",
    phone: "+52 3312345678",
    street: "Av. Industria Textil 100",
    city: "Guadalajara",
    state: "JA",
    country: "MX",
    postalCode: "44940",
  };

  const destination = {
    name: "Cliente Test",
    phone: "+52 5550001234",
    street: "Insurgentes Sur 1234",
    city: "Ciudad de México",
    state: "CMX",
    country: "MX",
    postalCode: "03100",
  };

  const packages = [
    {
      type: "box",
      content: "Producto test",
      amount: 1,
      declaredValue: 500,
      lengthUnit: "CM",
      weightUnit: "KG",
      weight: 1,
      dimensions: { length: 30, width: 25, height: 15 },
    },
  ];

  const carriers = ["fedex", "dhl", "estafeta"];
  const results = {};

  for (const carrier of carriers) {
    const body = {
      origin,
      destination,
      packages,
      shipment: { type: 1, carrier },
    };

    try {
      const res = await fetch(`${BASE_URL}/ship/rate/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const text = await res.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }

      results[carrier] = {
        httpStatus: res.status,
        response: parsed,
      };
    } catch (err) {
      results[carrier] = { error: String(err.message || err) };
    }
  }

  return new Response(
    JSON.stringify({
      config: {
        env: ENVIA_ENV,
        baseUrl: BASE_URL,
        tokenSet: Boolean(TOKEN),
      },
      testRequest: { origin, destination, packages },
      results,
    }, null, 2),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}
