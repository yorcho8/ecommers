import crypto from "crypto";
import { ensureDbSchemaOnce } from "./schema-once.js";

const ESTADOS_KYC = new Set([
  "pendiente",
  "en_proceso",
  "aprobado",
  "rechazado",
  "expirado",
]);

function toSafeText(value, max = 255) {
  if (value == null) return "";
  return String(value).trim().slice(0, max);
}

function toNullableIso(value) {
  if (!value) return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

async function executeSafe(db, sql) {
  try {
    await db.execute({ sql, args: [] });
  } catch (error) {
    const msg = String(error?.message || "").toLowerCase();
    const ignorable =
      msg.includes("already exists") ||
      msg.includes("duplicate") ||
      msg.includes("duplicate column");
    if (!ignorable) throw error;
  }
}

export async function ensureEmpresaKycSchema(db) {
  void db;
  return true;
}

export function normalizeKycEstado(value, fallback = "pendiente") {
  const v = String(value || "").toLowerCase();
  return ESTADOS_KYC.has(v) ? v : fallback;
}

export function boolToInt(value, fallback = null) {
  if (value == null) return fallback;
  return value ? 1 : 0;
}

export function parseBool(value) {
  if (value == null) return null;
  if (typeof value === "boolean") return value;
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "si", "sí", "yes", "y"].includes(v)) return true;
  if (["0", "false", "no", "n"].includes(v)) return false;
  return null;
}

export function parseNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function ensureInitialKycForSolicitud(db, solicitudId, provider = "mock") {
  const now = new Date().toISOString();
  await db.execute({
    sql: `
      INSERT INTO EmpresaSolicitudKYC (
        Id_Solicitud, Proveedor, Estado, Fecha_Creacion, Fecha_Actualizacion
      ) VALUES (?, ?, 'pendiente', ?, ?)
      ON CONFLICT(Id_Solicitud) DO NOTHING
    `,
    args: [Number(solicitudId), toSafeText(provider, 50) || "mock", now, now],
  });
}

export async function getSolicitudKyc(db, solicitudId) {
  const found = await db.execute({
    sql: `
      SELECT *
      FROM EmpresaSolicitudKYC
      WHERE Id_Solicitud = ?
      LIMIT 1
    `,
    args: [Number(solicitudId)],
  });

  if (!found.rows.length) return null;
  const row = found.rows[0];
  return {
    idKyc: Number(row.Id_KYC),
    idSolicitud: Number(row.Id_Solicitud),
    proveedor: String(row.Proveedor || "mock"),
    estado: normalizeKycEstado(row.Estado),
    nivelValidacion: String(row.Nivel_Validacion || "representante"),
    sesionExternaId: row.Sesion_Externa_ID ? String(row.Sesion_Externa_ID) : null,
    urlVerificacion: row.URL_Verificacion ? String(row.URL_Verificacion) : null,
    scoreComparacion: row.Score_Comparacion == null ? null : Number(row.Score_Comparacion),
    livenessScore: row.Liveness_Score == null ? null : Number(row.Liveness_Score),
    documentoValido: row.Documento_Valido == null ? null : Number(row.Documento_Valido) === 1,
    biometriaValida: row.Biometria_Valida == null ? null : Number(row.Biometria_Valida) === 1,
    fraudeSospecha: row.Fraude_Sospecha == null ? null : Number(row.Fraude_Sospecha) === 1,
    payloadProveedor: row.Payload_Proveedor_JSON ? String(row.Payload_Proveedor_JSON) : null,
    motivoRechazo: row.Motivo_Rechazo ? String(row.Motivo_Rechazo) : null,
    intentos: Number(row.Intentos || 0),
    fechaCreacion: String(row.Fecha_Creacion || ""),
    fechaActualizacion: String(row.Fecha_Actualizacion || ""),
    fechaVerificacion: row.Fecha_Verificacion ? String(row.Fecha_Verificacion) : null,
  };
}

export async function upsertSolicitudKyc(db, solicitudId, patch = {}) {
  const now = new Date().toISOString();
  const provider = toSafeText(patch.proveedor, 50) || "mock";
  const estado = normalizeKycEstado(patch.estado, "pendiente");
  const nivel = toSafeText(patch.nivelValidacion, 80) || "representante";
  const sesionExternaId = toSafeText(patch.sesionExternaId, 120) || null;
  const urlVerificacion = toSafeText(patch.urlVerificacion, 1000) || null;
  const scoreComparacion = parseNumber(patch.scoreComparacion);
  const livenessScore = parseNumber(patch.livenessScore);
  const documentoValido = boolToInt(parseBool(patch.documentoValido));
  const biometriaValida = boolToInt(parseBool(patch.biometriaValida));
  const fraudeSospecha = boolToInt(parseBool(patch.fraudeSospecha));
  const payloadProveedor = patch.payloadProveedor == null
    ? null
    : JSON.stringify(patch.payloadProveedor);
  const motivoRechazo = toSafeText(patch.motivoRechazo, 600) || null;
  const fechaVerificacion = toNullableIso(patch.fechaVerificacion) || (
    ["aprobado", "rechazado", "expirado"].includes(estado) ? now : null
  );

  await db.execute({
    sql: `
      INSERT INTO EmpresaSolicitudKYC (
        Id_Solicitud, Proveedor, Estado, Nivel_Validacion, Sesion_Externa_ID,
        URL_Verificacion, Score_Comparacion, Liveness_Score, Documento_Valido,
        Biometria_Valida, Fraude_Sospecha, Payload_Proveedor_JSON, Motivo_Rechazo,
        Intentos, Fecha_Creacion, Fecha_Actualizacion, Fecha_Verificacion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(Id_Solicitud)
      DO UPDATE SET
        Proveedor = excluded.Proveedor,
        Estado = excluded.Estado,
        Nivel_Validacion = excluded.Nivel_Validacion,
        Sesion_Externa_ID = COALESCE(excluded.Sesion_Externa_ID, EmpresaSolicitudKYC.Sesion_Externa_ID),
        URL_Verificacion = COALESCE(excluded.URL_Verificacion, EmpresaSolicitudKYC.URL_Verificacion),
        Score_Comparacion = COALESCE(excluded.Score_Comparacion, EmpresaSolicitudKYC.Score_Comparacion),
        Liveness_Score = COALESCE(excluded.Liveness_Score, EmpresaSolicitudKYC.Liveness_Score),
        Documento_Valido = COALESCE(excluded.Documento_Valido, EmpresaSolicitudKYC.Documento_Valido),
        Biometria_Valida = COALESCE(excluded.Biometria_Valida, EmpresaSolicitudKYC.Biometria_Valida),
        Fraude_Sospecha = COALESCE(excluded.Fraude_Sospecha, EmpresaSolicitudKYC.Fraude_Sospecha),
        Payload_Proveedor_JSON = COALESCE(excluded.Payload_Proveedor_JSON, EmpresaSolicitudKYC.Payload_Proveedor_JSON),
        Motivo_Rechazo = COALESCE(excluded.Motivo_Rechazo, EmpresaSolicitudKYC.Motivo_Rechazo),
        Intentos = CASE
          WHEN excluded.Estado = 'en_proceso' THEN EmpresaSolicitudKYC.Intentos + 1
          ELSE EmpresaSolicitudKYC.Intentos
        END,
        Fecha_Actualizacion = excluded.Fecha_Actualizacion,
        Fecha_Verificacion = COALESCE(excluded.Fecha_Verificacion, EmpresaSolicitudKYC.Fecha_Verificacion)
    `,
    args: [
      Number(solicitudId),
      provider,
      estado,
      nivel,
      sesionExternaId,
      urlVerificacion,
      scoreComparacion,
      livenessScore,
      documentoValido,
      biometriaValida,
      fraudeSospecha,
      payloadProveedor,
      motivoRechazo,
      estado === "en_proceso" ? 1 : 0,
      now,
      now,
      fechaVerificacion,
    ],
  });

  return getSolicitudKyc(db, solicitudId);
}

export async function appendSolicitudKycEvent(db, {
  solicitudId,
  idKyc = null,
  tipoEvento,
  estadoNuevo = null,
  detalle = null,
  payload = null,
  creadoPor = null,
}) {
  await db.execute({
    sql: `
      INSERT INTO EmpresaSolicitudKYCEvento (
        Id_Solicitud, Id_KYC, Tipo_Evento, Estado_Nuevo, Detalle,
        Payload_JSON, Creado_Por, Fecha_Creacion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      Number(solicitudId),
      idKyc == null ? null : Number(idKyc),
      toSafeText(tipoEvento, 80) || "evento",
      estadoNuevo ? normalizeKycEstado(estadoNuevo) : null,
      toSafeText(detalle, 600) || null,
      payload == null ? null : JSON.stringify(payload),
      creadoPor == null ? null : Number(creadoPor),
      new Date().toISOString(),
    ],
  });
}

export function buildMockKycVerificationUrl({ solicitudId, sessionId }) {
  return null;
}
