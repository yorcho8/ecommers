import crypto from "crypto";
import { createClient } from "@libsql/client";
import "dotenv/config";
import {
  appendSolicitudKycEvent,
  ensureEmpresaKycSchema,
  getSolicitudKyc,
  normalizeKycEstado,
  parseBool,
  parseNumber,
  upsertSolicitudKyc,
} from "../../../lib/empresa-kyc.js";
import { CSRF_COOKIE, CSRF_HEADER, validateCsrfToken } from "../../../lib/csrf.js";

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

function asText(value, max = 255) {
  if (value == null) return "";
  return String(value).trim().slice(0, max);
}

function isPublicCompanyRequest(request) {
  return request.headers.get("x-public-company-request") === "1";
}

function getCookieValue(cookieHeader, key) {
  if (!cookieHeader || !key) return "";
  const parts = String(cookieHeader).split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const k = trimmed.slice(0, idx).trim();
    if (k !== key) continue;
    return decodeURIComponent(trimmed.slice(idx + 1).trim() || "");
  }
  return "";
}

function hasValidCsrf(request) {
  const cookieToken = getCookieValue(request.headers.get("cookie") || "", CSRF_COOKIE);
  const headerToken = String(request.headers.get(CSRF_HEADER) || "").trim();
  return validateCsrfToken(cookieToken, headerToken);
}

async function getSolicitudById(id) {
  const found = await db.execute({
    sql: `
      SELECT Id_Solicitud, Estado, Admin_Correo
      FROM EmpresaSolicitud
      WHERE Id_Solicitud = ?
      LIMIT 1
    `,
    args: [Number(id)],
  });

  if (!found.rows.length) return null;
  return {
    idSolicitud: Number(found.rows[0].Id_Solicitud),
    estadoSolicitud: String(found.rows[0].Estado || "pendiente").toLowerCase(),
    adminCorreo: String(found.rows[0].Admin_Correo || "").trim().toLowerCase(),
  };
}

function buildKycResponse(kyc) {
  if (!kyc) {
    return {
      estado: "pendiente",
      proveedor: "mock",
      biometriaValida: null,
      documentoValido: null,
      fraudeSospecha: null,
      scoreComparacion: null,
      livenessScore: null,
      fechaVerificacion: null,
      intentos: 0,
      motivoRechazo: null,
    };
  }

  return {
    estado: kyc.estado,
    proveedor: kyc.proveedor,
    biometriaValida: kyc.biometriaValida,
    documentoValido: kyc.documentoValido,
    fraudeSospecha: kyc.fraudeSospecha,
    scoreComparacion: kyc.scoreComparacion,
    livenessScore: kyc.livenessScore,
    fechaVerificacion: kyc.fechaVerificacion,
    intentos: kyc.intentos,
    motivoRechazo: kyc.motivoRechazo,
  };
}

function validateOwnership(solicitud, correoInput) {
  const correo = asText(correoInput, 180).toLowerCase();
  if (!correo) return false;
  return correo === solicitud.adminCorreo;
}

export async function POST({ request }) {
  if (!isPublicCompanyRequest(request)) {
    return json({ success: false, error: "Acceso denegado" }, 403);
  }
  if (!hasValidCsrf(request)) {
    return json({ success: false, error: "Token CSRF invalido" }, 403);
  }

  await ensureEmpresaKycSchema(db);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "JSON inválido" }, 400);
  }

  const solicitudId = Number(body?.solicitudId || 0);
  if (!solicitudId) {
    return json({ success: false, error: "solicitudId requerido" }, 400);
  }

  const solicitud = await getSolicitudById(solicitudId);
  if (!solicitud) return json({ success: false, error: "Solicitud no encontrada" }, 404);

  if (!validateOwnership(solicitud, body?.correo)) {
    return json({ success: false, error: "El correo no coincide con la solicitud" }, 403);
  }
  if (["aprobada", "rechazada"].includes(solicitud.estadoSolicitud)) {
    return json({ success: false, error: "La solicitud ya no permite cambios de KYC" }, 409);
  }

  const provider = asText(body?.proveedor, 50).toLowerCase() || "mock_local";
  const sesionExternaId = asText(body?.sesionExternaId, 120) || crypto.randomUUID();
  const urlVerificacion = null;

  const updated = await upsertSolicitudKyc(db, solicitudId, {
    proveedor: provider,
    estado: "en_proceso",
    sesionExternaId,
    urlVerificacion,
    payloadProveedor: body?.payloadProveedor || null,
  });

  await appendSolicitudKycEvent(db, {
    solicitudId,
    idKyc: updated?.idKyc || null,
    tipoEvento: "public_session_started",
    estadoNuevo: "en_proceso",
    detalle: `Sesion KYC iniciada por solicitante (${provider})`,
    payload: {
      sesionExternaId,
      proveedor: provider,
    },
    creadoPor: null,
  });

  return json({
    success: true,
    message: "KYC iniciado",
    solicitudId,
    kyc: buildKycResponse(updated),
  });
}

export async function PUT({ request }) {
  if (!isPublicCompanyRequest(request)) {
    return json({ success: false, error: "Acceso denegado" }, 403);
  }
  if (!hasValidCsrf(request)) {
    return json({ success: false, error: "Token CSRF invalido" }, 403);
  }

  await ensureEmpresaKycSchema(db);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "JSON inválido" }, 400);
  }

  const solicitudId = Number(body?.solicitudId || 0);
  if (!solicitudId) {
    return json({ success: false, error: "solicitudId requerido" }, 400);
  }

  const solicitud = await getSolicitudById(solicitudId);
  if (!solicitud) return json({ success: false, error: "Solicitud no encontrada" }, 404);

  if (!validateOwnership(solicitud, body?.correo)) {
    return json({ success: false, error: "El correo no coincide con la solicitud" }, 403);
  }
  if (["aprobada", "rechazada"].includes(solicitud.estadoSolicitud)) {
    return json({ success: false, error: "La solicitud ya no permite cambios de KYC" }, 409);
  }

  const biometriaValida = parseBool(body?.biometriaValida);
  const documentoValido = parseBool(body?.documentoValido);
  const fraudeSospecha = parseBool(body?.fraudeSospecha);

  const estadoFinal =
    biometriaValida === true &&
    documentoValido === true &&
    fraudeSospecha !== true
      ? "aprobado"
      : normalizeKycEstado(body?.estado, "rechazado");

  const updated = await upsertSolicitudKyc(db, solicitudId, {
    proveedor: asText(body?.proveedor, 50) || "mock_local",
    estado: estadoFinal,
    scoreComparacion: parseNumber(body?.scoreComparacion),
    livenessScore: parseNumber(body?.livenessScore),
    biometriaValida,
    documentoValido,
    fraudeSospecha,
    motivoRechazo: asText(body?.motivoRechazo, 600) || null,
    payloadProveedor: body?.payloadProveedor || null,
    fechaVerificacion: new Date().toISOString(),
  });

  await appendSolicitudKycEvent(db, {
    solicitudId,
    idKyc: updated?.idKyc || null,
    tipoEvento: "public_session_completed",
    estadoNuevo: estadoFinal,
    detalle: estadoFinal === "aprobado"
      ? "KYC de solicitante aprobado"
      : "KYC de solicitante no aprobado",
    payload: {
      scoreComparacion: updated?.scoreComparacion,
      livenessScore: updated?.livenessScore,
      biometriaValida: updated?.biometriaValida,
      documentoValido: updated?.documentoValido,
      fraudeSospecha: updated?.fraudeSospecha,
    },
    creadoPor: null,
  });

  return json({
    success: true,
    message: "KYC actualizado",
    solicitudId,
    kyc: buildKycResponse(updated),
  });
}

export async function GET({ request, url }) {
  if (!isPublicCompanyRequest(request)) {
    return json({ success: false, error: "Acceso denegado" }, 403);
  }

  await ensureEmpresaKycSchema(db);

  const solicitudId = Number(url.searchParams.get("solicitudId") || 0);
  const correo = asText(url.searchParams.get("correo"), 180).toLowerCase();
  if (!solicitudId) {
    return json({ success: false, error: "solicitudId requerido" }, 400);
  }

  const solicitud = await getSolicitudById(solicitudId);
  if (!solicitud) return json({ success: false, error: "Solicitud no encontrada" }, 404);
  if (!validateOwnership(solicitud, correo)) {
    return json({ success: false, error: "El correo no coincide con la solicitud" }, 403);
  }

  const kyc = await getSolicitudKyc(db, solicitudId);
  return json({
    success: true,
    solicitudId,
    estadoSolicitud: solicitud.estadoSolicitud,
    kyc: buildKycResponse(kyc),
  });
}
