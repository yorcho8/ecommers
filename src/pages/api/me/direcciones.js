import { createClient } from "@libsql/client";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../../lib/session.js";
import { ensureDireccionSchema } from "../../../lib/direccion-utils.js";

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

function parseDireccion(body) {
  const nombreDireccion = String(body?.nombreDireccion || "Casa").trim();
  const numeroCasa = Number(body?.numeroCasa);
  const calle = String(body?.calle || "").trim();
  const codigoPostal = Number(body?.codigoPostal);
  const ciudad = String(body?.ciudad || "").trim();
  const provincia = String(body?.provincia || "").trim();

  return {
    nombreDireccion: nombreDireccion || "Casa",
    numeroCasa,
    calle,
    codigoPostal,
    ciudad,
    provincia,
  };
}

function validateDireccion(address) {
  if (!address.nombreDireccion) return "El nombre de la direccion es obligatorio";
  if (!Number.isFinite(address.numeroCasa) || address.numeroCasa <= 0) return "Numero de casa invalido";
  if (!address.calle) return "La calle es obligatoria";
  if (!Number.isFinite(address.codigoPostal) || address.codigoPostal <= 0) return "Codigo postal invalido";
  if (!address.ciudad) return "La ciudad es obligatoria";
  if (!address.provincia) return "La provincia es obligatoria";
  return "";
}

export async function GET({ cookies }) {
  try {
    const user = getSessionUser(cookies);
    if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);

    await ensureDireccionSchema(db);

    const result = await db.execute({
      sql: `SELECT Id_Direccion, Nombre_Direccion, Numero_casa, Calle, Codigo_Postal, Ciudad, Provincia
            FROM Direccion
            WHERE Id_Usuario = ?
            ORDER BY Id_Direccion DESC`,
      args: [user.userId],
    });

    const direcciones = result.rows.map((row) => ({
      id: Number(row.Id_Direccion),
      nombreDireccion: String(row.Nombre_Direccion || "Casa"),
      numeroCasa: Number(row.Numero_casa),
      calle: String(row.Calle || ""),
      codigoPostal: Number(row.Codigo_Postal),
      ciudad: String(row.Ciudad || ""),
      provincia: String(row.Provincia || ""),
    }));

    return json({ success: true, direcciones });
  } catch (error) {
    console.error("[GET /api/me/direcciones] Error:", error);
    return json({ success: false, error: "Error obteniendo direcciones" }, 500);
  }
}

export async function POST({ cookies, request }) {
  try {
    const user = getSessionUser(cookies);
    if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);

    await ensureDireccionSchema(db);

    const body = await request.json().catch(() => ({}));
    const address = parseDireccion(body);
    const validationError = validateDireccion(address);
    if (validationError) return json({ success: false, error: validationError }, 400);

    await db.execute({
      sql: `INSERT INTO Direccion
            (Id_Usuario, Nombre_Direccion, Numero_casa, Calle, Codigo_Postal, Ciudad, Provincia)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [user.userId, address.nombreDireccion, address.numeroCasa, address.calle, address.codigoPostal, address.ciudad, address.provincia],
    });

    return json({ success: true, message: "Direccion guardada" }, 201);
  } catch (error) {
    console.error("[POST /api/me/direcciones] Error:", error);
    return json({ success: false, error: "Error guardando direccion" }, 500);
  }
}

export async function PUT({ cookies, request }) {
  try {
    const user = getSessionUser(cookies);
    if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);

    await ensureDireccionSchema(db);

    const body = await request.json().catch(() => ({}));
    const id = Number(body?.id);
    if (!Number.isFinite(id) || id <= 0) return json({ success: false, error: "Direccion invalida" }, 400);

    const address = parseDireccion(body);
    const validationError = validateDireccion(address);
    if (validationError) return json({ success: false, error: validationError }, 400);

    const exists = await db.execute({
      sql: "SELECT Id_Direccion FROM Direccion WHERE Id_Direccion = ? AND Id_Usuario = ? LIMIT 1",
      args: [id, user.userId],
    });

    if (!exists.rows.length) return json({ success: false, error: "Direccion no encontrada" }, 404);

    await db.execute({
      sql: `UPDATE Direccion
            SET Nombre_Direccion = ?, Numero_casa = ?, Calle = ?, Codigo_Postal = ?, Ciudad = ?, Provincia = ?
            WHERE Id_Direccion = ? AND Id_Usuario = ?`,
      args: [address.nombreDireccion, address.numeroCasa, address.calle, address.codigoPostal, address.ciudad, address.provincia, id, user.userId],
    });

    return json({ success: true, message: "Direccion actualizada" });
  } catch (error) {
    console.error("[PUT /api/me/direcciones] Error:", error);
    return json({ success: false, error: "Error actualizando direccion" }, 500);
  }
}

export async function DELETE({ cookies, request }) {
  try {
    const user = getSessionUser(cookies);
    if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);

    const body = await request.json().catch(() => ({}));
    const id = Number(body?.id);
    if (!Number.isFinite(id) || id <= 0) return json({ success: false, error: "Direccion invalida" }, 400);

    const exists = await db.execute({
      sql: "SELECT Id_Direccion FROM Direccion WHERE Id_Direccion = ? AND Id_Usuario = ? LIMIT 1",
      args: [id, user.userId],
    });

    if (!exists.rows.length) return json({ success: false, error: "Direccion no encontrada" }, 404);

    await db.execute({
      sql: "DELETE FROM Direccion WHERE Id_Direccion = ? AND Id_Usuario = ?",
      args: [id, user.userId],
    });

    return json({ success: true, message: "Direccion eliminada" });
  } catch (error) {
    console.error("[DELETE /api/me/direcciones] Error:", error);
    return json({ success: false, error: "Error eliminando direccion" }, 500);
  }
}
