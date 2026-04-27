import { createClient } from "@libsql/client";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../../lib/session.js";

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

function getSessionUser(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
  } catch {
    return null;
  }
}

function normalizeFiscalPayload(body = {}) {
  const rfcFiscal = String(body?.rfcFiscal || "").trim().toUpperCase().replace(/\s+/g, "");
  const razonSocialFiscal = String(body?.razonSocialFiscal || "").trim().toUpperCase();
  const regimenFiscal = String(body?.regimenFiscal || "").trim();
  const codigoPostalFiscal = String(body?.codigoPostalFiscal || "").trim();
  const usoCfdi = String(body?.usoCfdi || "G03").trim().toUpperCase();

  return {
    rfcFiscal,
    razonSocialFiscal,
    regimenFiscal,
    codigoPostalFiscal,
    usoCfdi,
  };
}

function validateFiscalPayload(payload) {
  if (!/^[A-Z&\u00d1]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test(payload.rfcFiscal)) {
    return "RFC fiscal invalido";
  }
  if (payload.razonSocialFiscal.length < 3) {
    return "La razon social o nombre completo es obligatorio";
  }
  if (!payload.regimenFiscal) {
    return "El regimen fiscal es obligatorio";
  }
  if (!/^\d{5}$/.test(payload.codigoPostalFiscal)) {
    return "Codigo postal fiscal invalido";
  }
  if (!/^[A-Z0-9]{3}$/.test(payload.usoCfdi)) {
    return "Uso del CFDI invalido";
  }
  return null;
}

async function ensureUsuarioDatosFiscalesTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS UsuarioDatosFiscales (
      Id_Datos integer PRIMARY KEY AUTOINCREMENT,
      Id_Usuario integer NOT NULL UNIQUE,
      RFC_Fiscal text NOT NULL,
      Razon_Social_Fiscal text NOT NULL,
      Regimen_Fiscal text NOT NULL,
      Codigo_Postal_Fiscal text NOT NULL,
      Uso_CFDI text DEFAULT 'G03' NOT NULL,
      Fecha_Creacion text NOT NULL,
      Fecha_Actualizacion text NOT NULL,
      CONSTRAINT fk_UsuarioDatosFiscales_Id_Usuario_Usuario_Id_fk
        FOREIGN KEY (Id_Usuario) REFERENCES Usuario(Id) ON DELETE CASCADE
    )
  `);

  const cols = await db.execute("PRAGMA table_info(UsuarioDatosFiscales)");
  const hasUsoCfdi = cols.rows.some((row) => String(row.name || "") === "Uso_CFDI");
  if (!hasUsoCfdi) {
    await db.execute("ALTER TABLE UsuarioDatosFiscales ADD COLUMN Uso_CFDI text DEFAULT 'G03' NOT NULL");
  }
}

async function upsertFiscalData(userId, payload) {
  const now = new Date().toISOString();
  await db.execute({
    sql: `
      INSERT INTO UsuarioDatosFiscales
        (Id_Usuario, RFC_Fiscal, Razon_Social_Fiscal, Regimen_Fiscal, Codigo_Postal_Fiscal, Uso_CFDI, Fecha_Creacion, Fecha_Actualizacion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(Id_Usuario) DO UPDATE SET
        RFC_Fiscal = excluded.RFC_Fiscal,
        Razon_Social_Fiscal = excluded.Razon_Social_Fiscal,
        Regimen_Fiscal = excluded.Regimen_Fiscal,
        Codigo_Postal_Fiscal = excluded.Codigo_Postal_Fiscal,
        Uso_CFDI = excluded.Uso_CFDI,
        Fecha_Actualizacion = excluded.Fecha_Actualizacion
    `,
    args: [
      Number(userId),
      payload.rfcFiscal,
      payload.razonSocialFiscal,
      payload.regimenFiscal,
      payload.codigoPostalFiscal,
      payload.usoCfdi,
      now,
      now,
    ],
  });
}

async function getFiscalData(userId) {
  const result = await db.execute({
    sql: `
      SELECT
        Id_Datos,
        RFC_Fiscal,
        Razon_Social_Fiscal,
        Regimen_Fiscal,
        Codigo_Postal_Fiscal,
        Uso_CFDI,
        Fecha_Creacion,
        Fecha_Actualizacion
      FROM UsuarioDatosFiscales
      WHERE Id_Usuario = ?
      LIMIT 1
    `,
    args: [Number(userId)],
  });

  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    idDatos: Number(row.Id_Datos),
    rfcFiscal: String(row.RFC_Fiscal || ""),
    razonSocialFiscal: String(row.Razon_Social_Fiscal || ""),
    regimenFiscal: String(row.Regimen_Fiscal || ""),
    codigoPostalFiscal: String(row.Codigo_Postal_Fiscal || ""),
    usoCfdi: String(row.Uso_CFDI || "G03"),
    fechaCreacion: String(row.Fecha_Creacion || ""),
    fechaActualizacion: String(row.Fecha_Actualizacion || ""),
  };
}

export async function GET({ cookies }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  try {
    await ensureUsuarioDatosFiscalesTable();
    const datosFiscales = await getFiscalData(sessionUser.userId);
    return json({ success: true, datosFiscales });
  } catch (error) {
    console.error("[GET /api/me/datos-fiscales]", error);
    return json({ success: false, error: "Error obteniendo datos fiscales" }, 500);
  }
}

export async function POST({ cookies, request }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  try {
    await ensureUsuarioDatosFiscalesTable();
    const body = await request.json().catch(() => ({}));
    const payload = normalizeFiscalPayload(body);
    const validationError = validateFiscalPayload(payload);
    if (validationError) return json({ success: false, error: validationError }, 400);

    await upsertFiscalData(sessionUser.userId, payload);
    const datosFiscales = await getFiscalData(sessionUser.userId);
    return json({ success: true, message: "Datos fiscales guardados", datosFiscales }, 201);
  } catch (error) {
    console.error("[POST /api/me/datos-fiscales]", error);
    return json({ success: false, error: "Error guardando datos fiscales" }, 500);
  }
}

export async function PUT({ cookies, request }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  try {
    await ensureUsuarioDatosFiscalesTable();
    const body = await request.json().catch(() => ({}));
    const payload = normalizeFiscalPayload(body);
    const validationError = validateFiscalPayload(payload);
    if (validationError) return json({ success: false, error: validationError }, 400);

    await upsertFiscalData(sessionUser.userId, payload);
    const datosFiscales = await getFiscalData(sessionUser.userId);
    return json({ success: true, message: "Datos fiscales actualizados", datosFiscales });
  } catch (error) {
    console.error("[PUT /api/me/datos-fiscales]", error);
    return json({ success: false, error: "Error actualizando datos fiscales" }, 500);
  }
}

export async function DELETE({ cookies }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  try {
    await ensureUsuarioDatosFiscalesTable();
    await db.execute({
      sql: "DELETE FROM UsuarioDatosFiscales WHERE Id_Usuario = ?",
      args: [Number(sessionUser.userId)],
    });
    return json({ success: true, message: "Perfil fiscal eliminado" });
  } catch (error) {
    console.error("[DELETE /api/me/datos-fiscales]", error);
    return json({ success: false, error: "Error eliminando datos fiscales" }, 500);
  }
}
