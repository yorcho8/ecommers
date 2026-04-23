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

export async function GET({ cookies }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  try {
    const result = await db.execute({
      sql: `SELECT Id_Direccion, Nombre_Direccion, Numero_casa, Calle, Codigo_Postal, Ciudad, Provincia, Pais
            FROM Direccion
            WHERE Id_Usuario = ?
            ORDER BY Id_Direccion DESC`,
      args: [sessionUser.userId],
    });

    const direcciones = result.rows.map((r) => ({
      id: r.Id_Direccion,
      nombre: r.Nombre_Direccion || "",
      numeroCasa: r.Numero_casa,
      calle: r.Calle,
      codigoPostal: r.Codigo_Postal,
      ciudad: r.Ciudad,
      provincia: r.Provincia,
      pais: r.Pais || "Mexico",
    }));

    return json({ success: true, direcciones });
  } catch (error) {
    console.error("[GET /api/me/addresses]", error);
    return json({ success: false, error: "Error obteniendo direcciones" }, 500);
  }
}

export async function POST({ cookies, request }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  try {
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
      sql: `INSERT INTO Direccion (Id_Usuario, Nombre_Direccion, Numero_casa, Calle, Codigo_Postal, Ciudad, Provincia, Pais)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [sessionUser.userId, nombre || null, numeroCasa, calle, codigoPostal, ciudad, provincia, pais],
    });

    return json({ success: true, message: "Direccion agregada" }, 201);
  } catch (error) {
    console.error("[POST /api/me/addresses]", error);
    return json({ success: false, error: "Error guardando direccion" }, 500);
  }
}
