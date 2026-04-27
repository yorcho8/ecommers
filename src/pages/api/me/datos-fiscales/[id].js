import { createClient } from "@libsql/client";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../../../lib/session.js";

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

// ──────────────────── PUT (update) ────────────────────
export async function PUT({ params, cookies, request }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  const id = Number(params?.id);
  if (!Number.isFinite(id) || id <= 0) return json({ success: false, error: "ID inválido" }, 400);

  try {
    const owns = await db.execute({
      sql: "SELECT Id_DatoFiscal FROM DatoFiscal WHERE Id_DatoFiscal = ? AND Id_Usuario = ? LIMIT 1",
      args: [id, sessionUser.userId],
    });
    if (!owns.rows.length) return json({ success: false, error: "Dato fiscal no encontrado" }, 404);

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

    if (predeterminado) {
      await db.execute({
        sql: "UPDATE DatoFiscal SET Predeterminado = 0 WHERE Id_Usuario = ? AND Id_DatoFiscal != ?",
        args: [sessionUser.userId, id],
      });
    }

    await db.execute({
      sql: `UPDATE DatoFiscal
            SET Alias = ?, RFC = ?, Nombre = ?, Uso_CFDI = ?, Regimen_Fiscal = ?, CP_Fiscal = ?, Predeterminado = ?
            WHERE Id_DatoFiscal = ? AND Id_Usuario = ?`,
      args: [
        alias || null,
        rfc,
        nombre.toUpperCase(),
        usoCfdi,
        regimenFiscal,
        cpFiscal,
        predeterminado ? 1 : 0,
        id,
        sessionUser.userId,
      ],
    });

    return json({ success: true, message: "Dato fiscal actualizado" });
  } catch (error) {
    console.error("[PUT /api/me/datos-fiscales/:id]", error);
    return json({ success: false, error: "Error actualizando dato fiscal" }, 500);
  }
}

// ──────────────────── PATCH (set default) ────────────────────
export async function PATCH({ params, cookies }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  const id = Number(params?.id);
  if (!Number.isFinite(id) || id <= 0) return json({ success: false, error: "ID inválido" }, 400);

  try {
    const owns = await db.execute({
      sql: "SELECT Id_DatoFiscal FROM DatoFiscal WHERE Id_DatoFiscal = ? AND Id_Usuario = ? LIMIT 1",
      args: [id, sessionUser.userId],
    });
    if (!owns.rows.length) return json({ success: false, error: "Dato fiscal no encontrado" }, 404);

    await db.execute({
      sql: `UPDATE DatoFiscal
            SET Predeterminado = CASE WHEN Id_DatoFiscal = ? THEN 1 ELSE 0 END
            WHERE Id_Usuario = ?`,
      args: [id, sessionUser.userId],
    });

    return json({ success: true, message: "Dato fiscal establecido como predeterminado" });
  } catch (error) {
    console.error("[PATCH /api/me/datos-fiscales/:id]", error);
    return json({ success: false, error: "Error actualizando dato fiscal" }, 500);
  }
}

// ──────────────────── DELETE ────────────────────
export async function DELETE({ params, cookies }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  const id = Number(params?.id);
  if (!Number.isFinite(id) || id <= 0) return json({ success: false, error: "ID inválido" }, 400);

  try {
    const owns = await db.execute({
      sql: "SELECT Id_DatoFiscal FROM DatoFiscal WHERE Id_DatoFiscal = ? AND Id_Usuario = ? LIMIT 1",
      args: [id, sessionUser.userId],
    });
    if (!owns.rows.length) return json({ success: false, error: "Dato fiscal no encontrado" }, 404);

    await db.execute({
      sql: "DELETE FROM DatoFiscal WHERE Id_DatoFiscal = ? AND Id_Usuario = ?",
      args: [id, sessionUser.userId],
    });

    return json({ success: true, message: "Dato fiscal eliminado" });
  } catch (error) {
    console.error("[DELETE /api/me/datos-fiscales/:id]", error);
    return json({ success: false, error: "Error eliminando dato fiscal" }, 500);
  }
}
