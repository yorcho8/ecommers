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

async function ensureDatoFiscalTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS DatoFiscal (
      Id_DatoFiscal   INTEGER PRIMARY KEY AUTOINCREMENT,
      Id_Usuario      INTEGER NOT NULL,
      Alias           TEXT,
      RFC             TEXT NOT NULL,
      Nombre          TEXT NOT NULL,
      Uso_CFDI        TEXT NOT NULL DEFAULT 'G03',
      Regimen_Fiscal  TEXT NOT NULL DEFAULT '616',
      CP_Fiscal       TEXT NOT NULL,
      Predeterminado  INTEGER NOT NULL DEFAULT 0,
      Fecha_Creacion  TEXT NOT NULL
    )
  `);
}

// ──────────────────── GET ────────────────────
export async function GET({ cookies }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  try {
    await ensureDatoFiscalTable();

    const result = await db.execute({
      sql: `SELECT Id_DatoFiscal, Alias, RFC, Nombre, Uso_CFDI, Regimen_Fiscal, CP_Fiscal, Predeterminado, Fecha_Creacion
            FROM DatoFiscal
            WHERE Id_Usuario = ?
            ORDER BY Predeterminado DESC, Id_DatoFiscal DESC`,
      args: [sessionUser.userId],
    });

    const datosFiscales = result.rows.map((r) => ({
      id: r.Id_DatoFiscal,
      alias: r.Alias || "",
      rfc: r.RFC,
      nombre: r.Nombre,
      usoCfdi: r.Uso_CFDI,
      regimenFiscal: r.Regimen_Fiscal,
      cpFiscal: r.CP_Fiscal,
      predeterminado: Boolean(r.Predeterminado),
      fechaCreacion: r.Fecha_Creacion,
    }));

    return json({ success: true, datosFiscales });
  } catch (error) {
    console.error("[GET /api/me/datos-fiscales]", error);
    return json({ success: false, error: "Error obteniendo datos fiscales" }, 500);
  }
}

// ──────────────────── POST ────────────────────
export async function POST({ cookies, request }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  try {
    await ensureDatoFiscalTable();

    const body = await request.json().catch(() => ({}));
    const alias = String(body?.alias || "").trim();
    const rfc = String(body?.rfc || "").trim().toUpperCase().replace(/\s+/g, "");
    const nombre = String(body?.nombre || "").trim();
    const usoCfdi = String(body?.usoCfdi || "G03").trim();
    const regimenFiscal = String(body?.regimenFiscal || "616").trim();
    const cpFiscal = String(body?.cpFiscal || "").trim();
    const predeterminado = Boolean(body?.predeterminado);

    if (rfc.length < 12 || rfc.length > 13) {
      return json({ success: false, error: "RFC debe tener 12 caracteres (moral) o 13 (física)" }, 400);
    }
    if (!nombre || nombre.length < 3) {
      return json({ success: false, error: "Nombre o razón social inválido (mínimo 3 caracteres)" }, 400);
    }
    if (!cpFiscal || !/^\d{4,5}$/.test(cpFiscal)) {
      return json({ success: false, error: "Código postal fiscal inválido" }, 400);
    }

    const now = new Date().toISOString();

    // Use a transaction to atomically clear previous default and insert the new entry
    if (predeterminado) {
      await db.execute({
        sql: "UPDATE DatoFiscal SET Predeterminado = 0 WHERE Id_Usuario = ?",
        args: [sessionUser.userId],
      });
    }

    const insertResult = await db.execute({
      sql: `INSERT INTO DatoFiscal (Id_Usuario, Alias, RFC, Nombre, Uso_CFDI, Regimen_Fiscal, CP_Fiscal, Predeterminado, Fecha_Creacion)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        sessionUser.userId,
        alias || null,
        rfc,
        nombre.toUpperCase(),
        usoCfdi,
        regimenFiscal,
        cpFiscal,
        predeterminado ? 1 : 0,
        now,
      ],
    });

    return json({ success: true, message: "Dato fiscal guardado", id: Number(insertResult.lastInsertRowid) }, 201);
  } catch (error) {
    console.error("[POST /api/me/datos-fiscales]", error);
    return json({ success: false, error: "Error guardando dato fiscal" }, 500);
  }
}
