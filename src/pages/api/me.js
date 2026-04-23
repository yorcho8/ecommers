import { createClient } from "@libsql/client";
import "dotenv/config";
import { verifySessionToken, createSessionToken, SESSION_COOKIE, DEFAULT_MAX_AGE } from "../../lib/session.js";
import { getClientIp } from "../../lib/rate-limit.js";

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
  try {
    const sessionUser = getSessionUser(cookies);
    if (!sessionUser?.userId) {
      return json({ success: false, error: "No autenticado" }, 401);
    }

    const result = await db.execute({
      sql: `SELECT Id, Nombre, Correo, Rol, Telefono
            FROM Usuario
            WHERE Id = ?
            LIMIT 1`,
      args: [sessionUser.userId],
    });

    if (!result.rows.length) {
      return json({ success: false, error: "Usuario no encontrado" }, 404);
    }

    const row = result.rows[0];
    const addressResult = await db.execute({
      sql: `SELECT Numero_casa, Calle, Codigo_Postal, Ciudad, Provincia
            FROM Direccion
            WHERE Id_Usuario = ?
            ORDER BY Id_Direccion DESC
            LIMIT 1`,
      args: [sessionUser.userId],
    });

    const addressRow = addressResult.rows[0] || null;
    const direccionPartes = [
      addressRow?.Calle ? `Calle ${addressRow.Calle}` : "",
      addressRow?.Numero_casa != null ? `#${addressRow.Numero_casa}` : "",
      addressRow?.Ciudad ? String(addressRow.Ciudad) : "",
      addressRow?.Provincia ? String(addressRow.Provincia) : "",
      addressRow?.Codigo_Postal != null ? `CP ${addressRow.Codigo_Postal}` : "",
    ].filter(Boolean);

    return json({
      success: true,
      user: {
        id: row.Id,
        nombre: row.Nombre,
        correo: row.Correo,
        rol: row.Rol,
        telefono: row.Telefono || "",
        direccion: {
          numeroCasa: addressRow?.Numero_casa ?? "",
          calle: addressRow?.Calle || "",
          codigoPostal: addressRow?.Codigo_Postal ?? "",
          ciudad: addressRow?.Ciudad || "",
          provincia: addressRow?.Provincia || "",
          completa: direccionPartes.join(", ") || "Sin direccion registrada",
        },
      },
    });
  } catch (error) {
    console.error("Error in GET /api/me:", error);
    return json({ success: false, error: "Error obteniendo datos del usuario" }, 500);
  }
}

export async function PUT({ cookies, request }) {
  try {
    const sessionUser = getSessionUser(cookies);
    if (!sessionUser?.userId) {
      return json({ success: false, error: "No autenticado" }, 401);
    }

    const body = await request.json().catch(() => ({}));
    const correo = String(body?.correo || "").trim().toLowerCase();
    const telefono = String(body?.telefono || "").trim();
    const numeroCasaRaw = String(body?.numeroCasa || "").trim();
    const calle = String(body?.calle || "").trim();
    const codigoPostalRaw = String(body?.codigoPostal || "").trim();
    const ciudad = String(body?.ciudad || "").trim();
    const provincia = String(body?.provincia || "").trim();
    const hasAddressData =
      numeroCasaRaw !== "" ||
      calle !== "" ||
      codigoPostalRaw !== "" ||
      ciudad !== "" ||
      provincia !== "";

    if (!correo) {
      return json({ success: false, error: "El correo es obligatorio" }, 400);
    }

    let numeroCasa = null;
    let codigoPostal = null;

    if (hasAddressData) {
      numeroCasa = Number(numeroCasaRaw);
      codigoPostal = Number(codigoPostalRaw);

      if (
        !Number.isFinite(numeroCasa) ||
        numeroCasa <= 0 ||
        !calle ||
        !Number.isFinite(codigoPostal) ||
        codigoPostal <= 0 ||
        !ciudad ||
        !provincia
      ) {
        return json({ success: false, error: "Direccion incompleta o invalida" }, 400);
      }
    }

    const existing = await db.execute({
      sql: `SELECT Id FROM Usuario WHERE LOWER(Correo) = LOWER(?) AND Id != ? LIMIT 1`,
      args: [correo, sessionUser.userId],
    });

    if (existing.rows.length) {
      return json({ success: false, error: "Este correo ya esta en uso" }, 409);
    }

    await db.execute({
      sql: `UPDATE Usuario
            SET Correo = ?, Telefono = ?
            WHERE Id = ?`,
      args: [correo, telefono || null, sessionUser.userId],
    });

    if (hasAddressData) {
      const direccion = await db.execute({
        sql: "SELECT Id_Direccion FROM Direccion WHERE Id_Usuario = ? ORDER BY Id_Direccion DESC LIMIT 1",
        args: [sessionUser.userId],
      });

      if (direccion.rows.length) {
        await db.execute({
          sql: `UPDATE Direccion
                SET Numero_casa = ?, Calle = ?, Codigo_Postal = ?, Ciudad = ?, Provincia = ?
                WHERE Id_Direccion = ?`,
          args: [numeroCasa, calle, codigoPostal, ciudad, provincia, direccion.rows[0].Id_Direccion],
        });
      } else {
        await db.execute({
          sql: `INSERT INTO Direccion
                (Id_Usuario, Numero_casa, Calle, Codigo_Postal, Ciudad, Provincia)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [sessionUser.userId, numeroCasa, calle, codigoPostal, ciudad, provincia],
        });
      }
    }

    const direccionCompleta = hasAddressData
      ? [`Calle ${calle}`, `#${numeroCasa}`, ciudad, provincia, `CP ${codigoPostal}`].filter(Boolean).join(", ")
      : sessionUser?.direccion?.completa || "Sin direccion registrada";

    const ip = getClientIp(request);
    const newToken = createSessionToken(
      {
        userId: sessionUser.userId,
        correo,
        nombre: sessionUser.nombre || "Usuario",
        apellidoPaterno: sessionUser.apellidoPaterno || "",
        rol: sessionUser.rol,
        mustChangePassword: Boolean(sessionUser.mustChangePassword),
      },
      DEFAULT_MAX_AGE,
      ip,
    );

    const isProd = import.meta.env?.PROD || process.env.NODE_ENV === "production";
    const secureCookie = `${SESSION_COOKIE}=${encodeURIComponent(newToken)}; Path=/; Max-Age=${DEFAULT_MAX_AGE}; HttpOnly; SameSite=Lax${isProd ? "; Secure" : ""}`;
    const publicSessionData = JSON.stringify({
      userId: sessionUser.userId,
      correo,
      nombre: sessionUser.nombre || "Usuario",
      rol: sessionUser.rol || "usuario",
      mustChangePassword: Boolean(sessionUser.mustChangePassword),
      timestamp: Date.now(),
    });
    const publicCookie = `authSession=${encodeURIComponent(publicSessionData)}; Path=/; Max-Age=${DEFAULT_MAX_AGE}; SameSite=Lax${isProd ? "; Secure" : ""}`;

    const headers = new Headers();
    headers.append("Content-Type", "application/json");
    headers.append("Set-Cookie", secureCookie);
    headers.append("Set-Cookie", publicCookie);

    return new Response(JSON.stringify({ success: true, message: "Perfil actualizado" }), {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error("Error in PUT /api/me:", error);
    return json({ success: false, error: "Error actualizando perfil" }, 500);
  }
}
