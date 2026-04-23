import crypto from "crypto";
import { ensureDbSchemaOnce } from "./schema-once.js";

function toSafeText(value, max = 255) {
  if (value == null) return "";
  return String(value).trim().slice(0, max);
}

function getBiometricKey() {
  const raw =
    process.env.BIOMETRIC_AES_KEY ||
    import.meta.env?.BIOMETRIC_AES_KEY ||
    "";

  const safe = String(raw || "").trim();
  if (!safe) return null;

  // Accept either base64-encoded 32-byte key or passphrase.
  try {
    const b = Buffer.from(safe, "base64");
    if (b.length === 32) return b;
  } catch {}

  return crypto.createHash("sha256").update(safe).digest();
}

function encryptBuffer(buffer, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encryptedB64: encrypted.toString("base64"),
    ivB64: iv.toString("base64"),
    tagB64: tag.toString("base64"),
  };
}

function decryptBuffer(encB64, ivB64, tagB64, key) {
  const enc = Buffer.from(String(encB64 || ""), "base64");
  const iv = Buffer.from(String(ivB64 || ""), "base64");
  const tag = Buffer.from(String(tagB64 || ""), "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

export async function ensureEmpresaBiometriaSchema(db) {
  void db;
  return true;
}

export async function upsertSolicitudBiometria(db, solicitudId, {
  mimeType,
  selfieBuffer,
  consentimientoTexto,
  consentimientoAceptado,
  retentionDays = 90,
}) {
  const key = getBiometricKey();
  if (!key) {
    throw new Error("Falta BIOMETRIC_AES_KEY para cifrar biometria");
  }

  const now = new Date().toISOString();
  const retentionDate = new Date(Date.now() + Number(retentionDays || 90) * 24 * 60 * 60 * 1000).toISOString();
  const encrypted = encryptBuffer(selfieBuffer, key);
  const hash = crypto.createHash("sha256").update(selfieBuffer).digest("hex");

  await db.execute({
    sql: `
      INSERT INTO EmpresaSolicitudBiometria (
        Id_Solicitud, Mime_Type, Foto_Enc_B64, Iv_B64, Tag_B64, Hash_SHA256,
        Consentimiento_Texto, Consentimiento_Aceptado, Consentimiento_Fecha,
        Retencion_Hasta, Fecha_Creacion, Fecha_Actualizacion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(Id_Solicitud)
      DO UPDATE SET
        Mime_Type = excluded.Mime_Type,
        Foto_Enc_B64 = excluded.Foto_Enc_B64,
        Iv_B64 = excluded.Iv_B64,
        Tag_B64 = excluded.Tag_B64,
        Hash_SHA256 = excluded.Hash_SHA256,
        Consentimiento_Texto = excluded.Consentimiento_Texto,
        Consentimiento_Aceptado = excluded.Consentimiento_Aceptado,
        Consentimiento_Fecha = excluded.Consentimiento_Fecha,
        Retencion_Hasta = excluded.Retencion_Hasta,
        Fecha_Actualizacion = excluded.Fecha_Actualizacion
    `,
    args: [
      Number(solicitudId),
      toSafeText(mimeType, 80) || "image/jpeg",
      encrypted.encryptedB64,
      encrypted.ivB64,
      encrypted.tagB64,
      hash,
      toSafeText(consentimientoTexto, 600) || null,
      consentimientoAceptado ? 1 : 0,
      consentimientoAceptado ? now : null,
      retentionDate,
      now,
      now,
    ],
  });

  return {
    hash,
    retentionDate,
  };
}

export async function getSolicitudBiometriaMeta(db, solicitudId) {
  const found = await db.execute({
    sql: `
      SELECT
        Id_Biometria,
        Id_Solicitud,
        Mime_Type,
        Hash_SHA256,
        Consentimiento_Aceptado,
        Consentimiento_Fecha,
        Retencion_Hasta,
        Fecha_Creacion,
        Fecha_Actualizacion
      FROM EmpresaSolicitudBiometria
      WHERE Id_Solicitud = ?
      LIMIT 1
    `,
    args: [Number(solicitudId)],
  });

  if (!found.rows.length) return null;
  const row = found.rows[0];

  return {
    idBiometria: Number(row.Id_Biometria),
    idSolicitud: Number(row.Id_Solicitud),
    mimeType: String(row.Mime_Type || "image/jpeg"),
    hashSha256: String(row.Hash_SHA256 || ""),
    consentimientoAceptado: Number(row.Consentimiento_Aceptado || 0) === 1,
    consentimientoFecha: row.Consentimiento_Fecha ? String(row.Consentimiento_Fecha) : null,
    retencionHasta: row.Retencion_Hasta ? String(row.Retencion_Hasta) : null,
    fechaCreacion: String(row.Fecha_Creacion || ""),
    fechaActualizacion: String(row.Fecha_Actualizacion || ""),
  };
}

export async function getSolicitudBiometriaImage(db, solicitudId) {
  const key = getBiometricKey();
  if (!key) {
    throw new Error("Falta BIOMETRIC_AES_KEY para descifrar biometria");
  }

  const found = await db.execute({
    sql: `
      SELECT Mime_Type, Foto_Enc_B64, Iv_B64, Tag_B64
      FROM EmpresaSolicitudBiometria
      WHERE Id_Solicitud = ?
      LIMIT 1
    `,
    args: [Number(solicitudId)],
  });

  if (!found.rows.length) return null;
  const row = found.rows[0];
  const buffer = decryptBuffer(row.Foto_Enc_B64, row.Iv_B64, row.Tag_B64, key);

  return {
    mimeType: String(row.Mime_Type || "image/jpeg"),
    buffer,
  };
}
