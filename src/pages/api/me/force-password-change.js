import { createClient } from "@libsql/client";
import "dotenv/config";
import { hashPassword, validatePassword } from "../../../lib/auth-utils.js";
import { createSessionToken, verifySessionToken, SESSION_COOKIE, DEFAULT_MAX_AGE } from "../../../lib/session";
import { getClientIp } from "../../../lib/rate-limit";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

function json(payload, status = 200, headers = undefined) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: headers || { "Content-Type": "application/json" },
  });
}

function buildCookieHeader(name, value, options) {
  const parts = [name + "=" + encodeURIComponent(value)];
  if (options.path) parts.push("Path=" + options.path);
  if (options.maxAge != null) parts.push("Max-Age=" + options.maxAge);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push("SameSite=" + options.sameSite);
  return parts.join("; ");
}

function getSessionUser(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    return token ? verifySessionToken(token) : null;
  } catch {
    return null;
  }
}

async function ensurePasswordChangeSchema() {
  return true;
}

export async function POST({ request, cookies }) {
  const session = getSessionUser(cookies);
  const userId = Number(session?.userId || 0);
  if (!userId) {
    return json({ success: false, error: "No autenticado" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "JSON invalido" }, 400);
  }

  const nuevaContrasena = String(body?.nuevaContrasena || "");
  const confirmacion = String(body?.confirmacion || "");

  if (!nuevaContrasena || !confirmacion) {
    return json({ success: false, error: "Nueva contrasena y confirmacion son obligatorias" }, 400);
  }

  if (nuevaContrasena !== confirmacion) {
    return json({ success: false, error: "Las contrasenas no coinciden" }, 400);
  }

  const passValidation = validatePassword(nuevaContrasena);
  if (!passValidation.isValid) {
    return json({ success: false, error: passValidation.message }, 400);
  }

  try {
    await ensurePasswordChangeSchema();

    const userRes = await db.execute({
      sql: `SELECT Id, Nombre, Apellido_Paterno, Correo, Rol, COALESCE(Requires_Password_Change, 0) AS Requires_Password_Change
            FROM Usuario WHERE Id = ? LIMIT 1`,
      args: [userId],
    });

    if (!userRes.rows.length) {
      return json({ success: false, error: "Usuario no encontrado" }, 404);
    }

    const user = userRes.rows[0];
    const { hash, salt } = hashPassword(nuevaContrasena);
    await db.execute({
      sql: "UPDATE Usuario SET Contrasena = ?, Requires_Password_Change = 0 WHERE Id = ?",
      args: [`${hash}:${salt}`, userId],
    });

    const ip = getClientIp(request);
    const token = createSessionToken(
      {
        userId: Number(user.Id),
        correo: String(user.Correo || ""),
        nombre: String(user.Nombre || ""),
        apellidoPaterno: String(user.Apellido_Paterno || ""),
        rol: String(user.Rol || ""),
        mustChangePassword: false,
      },
      DEFAULT_MAX_AGE,
      ip,
    );

    const isProd = import.meta.env.PROD;
    const secureCookie = buildCookieHeader(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: "Lax",
      path: "/",
      maxAge: DEFAULT_MAX_AGE,
    });

    const publicSessionData = JSON.stringify({
      userId: Number(user.Id),
      correo: String(user.Correo || ""),
      nombre: String(user.Nombre || ""),
      rol: String(user.Rol || ""),
      mustChangePassword: false,
      timestamp: Date.now(),
    });

    const publicCookie = buildCookieHeader("authSession", publicSessionData, {
      httpOnly: false,
      secure: isProd,
      sameSite: "Lax",
      path: "/",
      maxAge: DEFAULT_MAX_AGE,
    });

    const headers = new Headers();
    headers.append("Content-Type", "application/json");
    headers.append("Set-Cookie", secureCookie);
    headers.append("Set-Cookie", publicCookie);

    return json({ success: true, message: "Contrasena actualizada correctamente" }, 200, headers);
  } catch (error) {
    console.error("[POST /api/me/force-password-change]", error);
    return json({ success: false, error: "Error al actualizar contrasena" }, 500);
  }
}
