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
} from "../../../../lib/empresa-kyc.js";
import {
  ensureEmpresaBiometriaSchema,
  getSolicitudBiometriaMeta,
} from "../../../../lib/empresa-biometria.js";
import { getSessionFromCookies, normalizeRole } from "../../../../lib/session.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

const SUPER_KEY = process.env.SUPER_ADMIN_KEY || "GOSUPER2026";

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

function getSessionUser(cookies) {
  return getSessionFromCookies(cookies);
}

function checkAuth(request, cookies) {
  const key = request.headers.get("x-admin-key");
  if (key === SUPER_KEY) return true;
  const session = getSessionUser(cookies);
  return normalizeRole(session?.rol) === "superusuario";
}

async function ensureSolicitudExists(solicitudId) {
  const found = await db.execute({
    sql: "SELECT Id_Solicitud, Estado FROM EmpresaSolicitud WHERE Id_Solicitud = ? LIMIT 1",
    args: [Number(solicitudId)],
  });
  if (!found.rows.length) return null;
  return {
    idSolicitud: Number(found.rows[0].Id_Solicitud),
    estadoSolicitud: String(found.rows[0].Estado || "pendiente").toLowerCase(),
  };
}

async function hasIneRepresentanteDocumento(solicitudId) {
  const found = await db.execute({
    sql: "SELECT Documentos_JSON FROM EmpresaSolicitud WHERE Id_Solicitud = ? LIMIT 1",
    args: [Number(solicitudId)],
  });
  if (!found.rows.length) return false;

  let docs = [];
  try {
    const parsed = JSON.parse(String(found.rows[0].Documentos_JSON || "[]"));
    docs = Array.isArray(parsed) ? parsed : [];
  } catch {
    docs = [];
  }

  return docs.some((doc) => {
    const tipo = String(doc?.tipo || "").toUpperCase();
    const url = String(doc?.url || "").trim();
    return tipo === "INE_REPRESENTANTE" && !!url;
  });
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

export async function GET({ request, cookies, url }) {
  if (!checkAuth(request, cookies)) {
    return json({ success: false, error: "Acceso denegado" }, 403);
  }

  await ensureEmpresaKycSchema(db);
  await ensureEmpresaBiometriaSchema(db);

  const id = Number(url.searchParams.get("id") || 0);
  if (!id) return json({ success: false, error: "ID de solicitud requerido" }, 400);

  const solicitud = await ensureSolicitudExists(id);
  if (!solicitud) return json({ success: false, error: "Solicitud no encontrada" }, 404);

  const kyc = await getSolicitudKyc(db, id);
  return json({
    success: true,
    solicitudId: id,
    estadoSolicitud: solicitud.estadoSolicitud,
    kyc: buildKycResponse(kyc),
  });
}

export async function POST({ request, cookies }) {
  if (!checkAuth(request, cookies)) {
    return json({ success: false, error: "Acceso denegado" }, 403);
  }

  await ensureEmpresaKycSchema(db);
  await ensureEmpresaBiometriaSchema(db);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "JSON inválido" }, 400);
  }

  const id = Number(body?.id || 0);
  if (!id) return json({ success: false, error: "ID de solicitud requerido" }, 400);

  const solicitud = await ensureSolicitudExists(id);
  if (!solicitud) return json({ success: false, error: "Solicitud no encontrada" }, 404);

  const provider = asText(body?.proveedor, 50).toLowerCase() || "mock";
  const externalSessionId = asText(body?.sesionExternaId, 120) || crypto.randomUUID();
  const verificationUrl = null;

  const updated = await upsertSolicitudKyc(db, id, {
    proveedor: provider,
    estado: "en_proceso",
    sesionExternaId: externalSessionId,
    urlVerificacion: verificationUrl,
    payloadProveedor: body?.payloadProveedor || null,
  });

  await appendSolicitudKycEvent(db, {
    solicitudId: id,
    idKyc: updated?.idKyc || null,
    tipoEvento: "session_started",
    estadoNuevo: "en_proceso",
    detalle: `Sesion KYC iniciada con proveedor ${provider}`,
    payload: {
      sesionExternaId: externalSessionId,
      proveedor: provider,
    },
    creadoPor: Number(getSessionUser(cookies)?.userId || 0) || null,
  });

  return json({
    success: true,
    message: "Sesion KYC iniciada",
    solicitudId: id,
    kyc: buildKycResponse(updated),
  });
}

export async function PUT({ request, cookies }) {
  if (!checkAuth(request, cookies)) {
    return json({ success: false, error: "Acceso denegado" }, 403);
  }

  await ensureEmpresaKycSchema(db);
  await ensureEmpresaBiometriaSchema(db);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "JSON inválido" }, 400);
  }

  const id = Number(body?.id || 0);
  if (!id) return json({ success: false, error: "ID de solicitud requerido" }, 400);

  const solicitud = await ensureSolicitudExists(id);
  if (!solicitud) return json({ success: false, error: "Solicitud no encontrada" }, 404);

  const estado = normalizeKycEstado(body?.estado, "pendiente");

  if (estado === "aprobado") {
    const [bioMeta, hasIne] = await Promise.all([
      getSolicitudBiometriaMeta(db, id),
      hasIneRepresentanteDocumento(id),
    ]);

    if (!hasIne) {
      return json(
        { success: false, error: "No se puede aprobar KYC: falta documento INE del representante." },
        409,
      );
    }

    if (!bioMeta) {
      return json(
        { success: false, error: "No se puede aprobar KYC: no existe selfie biometrica privada para comparar." },
        409,
      );
    }

    if (!bioMeta.consentimientoAceptado) {
      return json(
        { success: false, error: "No se puede aprobar KYC: falta consentimiento biometrico valido." },
        409,
      );
    }
  }

  const patch = {
    proveedor: asText(body?.proveedor, 50) || "mock",
    estado,
    scoreComparacion: parseNumber(body?.scoreComparacion),
    livenessScore: parseNumber(body?.livenessScore),
    documentoValido: parseBool(body?.documentoValido),
    biometriaValida: parseBool(body?.biometriaValida),
    fraudeSospecha: parseBool(body?.fraudeSospecha),
    sesionExternaId: asText(body?.sesionExternaId, 120) || null,
    urlVerificacion: asText(body?.urlVerificacion, 1000) || null,
    motivoRechazo: asText(body?.motivoRechazo, 600) || null,
    payloadProveedor: body?.payloadProveedor || null,
    fechaVerificacion: body?.fechaVerificacion || null,
  };

  const updated = await upsertSolicitudKyc(db, id, patch);

  await appendSolicitudKycEvent(db, {
    solicitudId: id,
    idKyc: updated?.idKyc || null,
    tipoEvento: "status_updated",
    estadoNuevo: estado,
    detalle: patch.motivoRechazo || `KYC actualizado a ${estado}`,
    payload: {
      scoreComparacion: patch.scoreComparacion,
      livenessScore: patch.livenessScore,
      documentoValido: patch.documentoValido,
      biometriaValida: patch.biometriaValida,
      fraudeSospecha: patch.fraudeSospecha,
      proveedor: patch.proveedor,
    },
    creadoPor: Number(getSessionUser(cookies)?.userId || 0) || null,
  });

  return json({
    success: true,
    message: "KYC actualizado",
    solicitudId: id,
    estadoSolicitud: solicitud.estadoSolicitud,
    kyc: buildKycResponse(updated),
  });
}
