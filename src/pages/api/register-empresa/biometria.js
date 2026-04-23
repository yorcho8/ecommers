import { createClient } from "@libsql/client";
import "dotenv/config";
import { CSRF_COOKIE, CSRF_HEADER, validateCsrfToken } from "../../../lib/csrf.js";
import {
  ensureEmpresaBiometriaSchema,
  upsertSolicitudBiometria,
} from "../../../lib/empresa-biometria.js";
import {
  appendSolicitudKycEvent,
  ensureEmpresaKycSchema,
  upsertSolicitudKyc,
} from "../../../lib/empresa-kyc.js";

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

function getCookieValue(cookieHeader, key) {
  if (!cookieHeader || !key) return "";
  const parts = String(cookieHeader).split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    if (trimmed.slice(0, idx).trim() !== key) continue;
    return decodeURIComponent(trimmed.slice(idx + 1).trim() || "");
  }
  return "";
}

function hasValidCsrf(request) {
  const cookieToken = getCookieValue(request.headers.get("cookie") || "", CSRF_COOKIE);
  const headerToken = String(request.headers.get(CSRF_HEADER) || "").trim();
  return validateCsrfToken(cookieToken, headerToken);
}

function isPublicCompanyRequest(request) {
  return request.headers.get("x-public-company-request") === "1";
}

function normalizeImageMime(mime) {
  const raw = String(mime || "").toLowerCase().trim();
  if (raw === "image/jpg" || raw === "image/pjpeg") return "image/jpeg";
  if (raw === "image/x-png") return "image/png";
  return raw;
}

// Magic-bytes signatures for allowed image types.
// Validates actual file content, not just the client-reported MIME type.
const IMAGE_MAGIC = [
  { mime: 'image/jpeg', sig: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png',  sig: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/webp', sig: [0x52, 0x49, 0x46, 0x46], offset4: [0x57, 0x45, 0x42, 0x50] },
];

function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  for (const { mime, sig, offset4 } of IMAGE_MAGIC) {
    const match = sig.every((byte, i) => buffer[i] === byte);
    if (match) {
      if (offset4) {
        // WEBP: first 4 bytes = RIFF, bytes 8-11 = WEBP
        const webp = offset4.every((byte, i) => buffer[8 + i] === byte);
        if (!webp) continue;
      }
      return mime;
    }
  }
  return null;
}

function parseDataUrlImage(dataUrl) {
  const raw = String(dataUrl || "");
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (!match) return null;

  const claimedMime = normalizeImageMime(match[1]);
  const base64 = String(match[2] || "").replace(/\s+/g, "");
  const buffer = Buffer.from(base64, "base64");

  // Validate real content via magic bytes, not just the claimed MIME
  const realMime = detectImageMime(buffer);
  if (!realMime) return null;
  // Claimed MIME must match detected MIME (defense-in-depth)
  if (claimedMime && realMime !== claimedMime) return null;

  return { mimeType: realMime, buffer };
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

async function getLatestPendingSolicitudByCorreo(correo) {
  const correoNorm = asText(correo, 180).toLowerCase();
  if (!correoNorm) return null;
  const found = await db.execute({
    sql: `
      SELECT Id_Solicitud, Estado, Admin_Correo
      FROM EmpresaSolicitud
      WHERE LOWER(Admin_Correo) = ? AND Estado = 'pendiente'
      ORDER BY Fecha_Solicitud DESC, Id_Solicitud DESC
      LIMIT 1
    `,
    args: [correoNorm],
  });
  if (!found.rows.length) return null;
  return {
    idSolicitud: Number(found.rows[0].Id_Solicitud),
    estadoSolicitud: String(found.rows[0].Estado || "pendiente").toLowerCase(),
    adminCorreo: String(found.rows[0].Admin_Correo || "").trim().toLowerCase(),
  };
}

function validateOwnership(solicitud, correoInput) {
  const correo = asText(correoInput, 180).toLowerCase();
  return !!correo && correo === solicitud.adminCorreo;
}

export async function POST({ request }) {
  if (!hasValidCsrf(request)) {
    return json({ success: false, error: "Token CSRF invalido" }, 403);
  }

  // ── Body size guard: reject payloads > 5 MB before parsing JSON ────────────────
  const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return json({ success: false, error: "Cuerpo de la solicitud demasiado grande (máx 5 MB)" }, 413);
  }

  await ensureEmpresaBiometriaSchema(db);
  await ensureEmpresaKycSchema(db);

  let body;
  let rawBody = "";
  try {
    rawBody = await request.text();
  } catch {
    return json({ success: false, error: "No se pudo leer el cuerpo de la solicitud" }, 400);
  }

  if (!String(rawBody || "").trim()) {
    return json({ success: false, error: "Cuerpo de solicitud vacio" }, 400);
  }

  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ success: false, error: "JSON invalido" }, 400);
  }

  const solicitudId = Number(body?.solicitudId || 0);
  let solicitud = null;
  if (solicitudId > 0) {
    solicitud = await getSolicitudById(solicitudId);
  }
  // Public prereg flow fallback: allow resolving the latest pending solicitud by correo
  // if solicitudId was not provided or is invalid/stale in frontend state.
  if (!solicitud && isPublicCompanyRequest(request)) {
    solicitud = await getLatestPendingSolicitudByCorreo(body?.correo);
  }
  if (!solicitud) return json({ success: false, error: "Solicitud no encontrada" }, 404);
  if (!validateOwnership(solicitud, body?.correo)) {
    return json({ success: false, error: "El correo no coincide con la solicitud" }, 403);
  }
  if (["aprobada", "rechazada"].includes(solicitud.estadoSolicitud)) {
    return json({ success: false, error: "La solicitud ya no permite cambios biometricos" }, 409);
  }

  const consentimientoAceptado = body?.consentimientoAceptado === true;
  if (!consentimientoAceptado) {
    return json({ success: false, error: "Debes aceptar consentimiento biometrico" }, 400);
  }

  const parsed = parseDataUrlImage(body?.selfieDataUrl);
  if (!parsed) {
    return json({ success: false, error: "selfieDataUrl invalido" }, 400);
  }

  if (!["image/jpeg", "image/png", "image/webp"].includes(parsed.mimeType)) {
    return json({ success: false, error: "Formato de selfie no permitido" }, 400);
  }

  if (parsed.buffer.length < 30 * 1024) {
    return json({ success: false, error: "Selfie demasiado pequena" }, 400);
  }
  if (parsed.buffer.length > 4 * 1024 * 1024) {
    return json({ success: false, error: "Selfie excede 4MB" }, 400);
  }

  const consentimientoTexto = asText(
    body?.consentimientoTexto ||
      "Acepto tratamiento de biometria para validacion de identidad de representante legal.",
    600
  );

  const saved = await upsertSolicitudBiometria(db, solicitudId, {
    mimeType: parsed.mimeType,
    selfieBuffer: parsed.buffer,
    consentimientoTexto,
    consentimientoAceptado: true,
    retentionDays: Number(body?.retentionDays || 90),
  });

  await upsertSolicitudKyc(db, solicitudId, {
    proveedor: "manual_superusuario",
    estado: "en_proceso",
    biometriaValida: null,
    documentoValido: null,
    fraudeSospecha: null,
    payloadProveedor: {
      mode: "secure_private_biometric_storage",
      hashSha256: saved.hash,
      retentionDate: saved.retentionDate,
    },
  });

  await appendSolicitudKycEvent(db, {
    solicitudId,
    tipoEvento: "biometric_evidence_uploaded",
    estadoNuevo: "en_proceso",
    detalle: "Evidencia biometrica privada cargada para revision de superusuario",
    payload: {
      retentionDate: saved.retentionDate,
      hashSha256_prefix: String(saved.hash || "").slice(0, 12),
    },
    creadoPor: null,
  });

  return json({
    success: true,
    message: "Biometria cargada de forma segura",
    solicitudId,
    retentionDate: saved.retentionDate,
  });
}
