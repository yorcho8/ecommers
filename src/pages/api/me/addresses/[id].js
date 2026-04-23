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

export async function PUT({ params, cookies, request }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  const id = Number(params?.id);
  if (!Number.isFinite(id) || id <= 0) return json({ success: false, error: "ID invalido" }, 400);

  try {
    const owns = await db.execute({
      sql: "SELECT Id_Direccion FROM Direccion WHERE Id_Direccion = ? AND Id_Usuario = ? LIMIT 1",
      args: [id, sessionUser.userId],
    });
    if (!owns.rows.length) return json({ success: false, error: "Direccion no encontrada" }, 404);

    const body = await request.json().catch(() => ({}));
    const nombre = String(body?.nombre || "").trim();
    const numeroCasa = Number(body?.numeroCasa);
    const calle = String(body?.calle || "").trim();
    const codigoPostal = Number(body?.codigoPostal);
    const ciudad = String(body?.ciudad || "").trim();
    const provincia = String(body?.provincia || "").trim();
    const pais = String(body?.pais || "Mexico").trim();

    if (
      !calle || !ciudad || !provincia || !pais ||
      !Number.isFinite(numeroCasa) || numeroCasa <= 0 ||
      !Number.isFinite(codigoPostal) || codigoPostal <= 0
    ) {
      return json({ success: false, error: "Direccion incompleta o invalida" }, 400);
    }

    await db.execute({
      sql: `UPDATE Direccion
            SET Nombre_Direccion = ?, Numero_casa = ?, Calle = ?, Codigo_Postal = ?, Ciudad = ?, Provincia = ?, Pais = ?
            WHERE Id_Direccion = ? AND Id_Usuario = ?`,
      args: [nombre || null, numeroCasa, calle, codigoPostal, ciudad, provincia, pais, id, sessionUser.userId],
    });

    return json({ success: true, message: "Direccion actualizada" });
  } catch (error) {
    console.error("[PUT /api/me/addresses/:id]", error);
    return json({ success: false, error: "Error actualizando direccion" }, 500);
  }
}

export async function DELETE({ params, cookies }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  const id = Number(params?.id);
  if (!Number.isFinite(id) || id <= 0) return json({ success: false, error: "ID invalido" }, 400);

  try {
    const owns = await db.execute({
      sql: "SELECT Id_Direccion FROM Direccion WHERE Id_Direccion = ? AND Id_Usuario = ? LIMIT 1",
      args: [id, sessionUser.userId],
    });
    if (!owns.rows.length) return json({ success: false, error: "Direccion no encontrada" }, 404);

    await db.execute({
      sql: "DELETE FROM Direccion WHERE Id_Direccion = ? AND Id_Usuario = ?",
      args: [id, sessionUser.userId],
    });

    return json({ success: true, message: "Direccion eliminada" });
  } catch (error) {
    console.error("[DELETE /api/me/addresses/:id]", error);
    return json({ success: false, error: "Error eliminando direccion" }, 500);
  }
}
