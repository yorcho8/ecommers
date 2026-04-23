// src/pages/api/auth/verify-2fa.js
// POST /api/auth/verify-2fa
// Second step of login: verify TOTP code (or backup code) against a temp session token.
//
// Request body (JSON):
//   { tempToken: string, code: string }
//
// tempToken is the short-lived signed JWT returned by /api/login when TOTP is required.
// On success: issues full session cookies identical to a normal login response.
import { createClient } from "@libsql/client";
import "dotenv/config";
import {
  verifySessionToken,
  createSessionToken,
  SESSION_COOKIE,
  DEFAULT_MAX_AGE,
} from "../../../lib/session.js";
import { verifyTotpCode, hashBackupCode } from "../../../lib/totp.js";
import { ensureTotpSchema, logLoginActivity } from "../../../lib/auth-schema.js";
import { checkRateLimitDistributed, getClientIp, clearAttemptsDistributed } from "../../../lib/rate-limit.js";
import { timingSafeEqual } from "node:crypto";
import { cleanInput } from "../../../lib/sanitize.js";

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

function buildCookieHeader(name, value, options) {
  const parts = [name + "=" + encodeURIComponent(value)];
  if (options.path)     parts.push("Path=" + options.path);
  if (options.maxAge != null) parts.push("Max-Age=" + options.maxAge);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure)   parts.push("Secure");
  if (options.sameSite) parts.push("SameSite=" + options.sameSite);
  return parts.join("; ");
}

function timingSafeStringEqual(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export async function POST({ request }) {
  const ip = getClientIp(request);
  // Tight rate-limit: 5 attempts per 15 min per IP
  const rl = await checkRateLimitDistributed("verify-2fa", ip, {
    maxRequests: 5,
    windowMs: 15 * 60 * 1000,
    blockMs: 30 * 60 * 1000,
  });
  if (rl.limited) {
    return json(
      { error: `Demasiados intentos. Intenta en ${Math.ceil(rl.retryAfter / 60)} minutos.` },
      429,
    );
  }

  const body = await request.json().catch(() => ({}));
  const rawTempToken = String(body?.tempToken || "").trim();
  const code = String(body?.code || "").replace(/\s/g, "");

  if (!rawTempToken || !code) {
    return json({ error: "tempToken y code son requeridos" }, 400);
  }

  // Verify the temp token
  const tempPayload = verifySessionToken(rawTempToken);
  if (!tempPayload || tempPayload.type !== "2fa_pending") {
    return json({ error: "Token temporal inválido o expirado. Inicia sesión de nuevo." }, 401);
  }

  const userId = tempPayload.userId;
  const userAgent = request.headers.get("user-agent") || "";

  await ensureTotpSchema(db);

  // Load TOTP row
  const totpRow = await db.execute({
    sql: `SELECT Secret, Enabled FROM UsuarioTOTP WHERE Id_Usuario = ? LIMIT 1`,
    args: [userId],
  });

  if (!totpRow.rows.length || Number(totpRow.rows[0].Enabled) !== 1) {
    await logLoginActivity(db, { userId, ip, userAgent, success: false, reason: "totp_not_configured" });
    return json({ error: "TOTP no está configurado en esta cuenta" }, 400);
  }

  const secret = String(totpRow.rows[0].Secret);
  let verified = false;

  // Try TOTP code (6 digits)
  if (/^\d{6}$/.test(code)) {
    verified = verifyTotpCode(secret, code);
  }

  // Try backup code (format: XXXXXX-XXXXXX)
  if (!verified && /^[A-F0-9]{6}-[A-F0-9]{6}$/i.test(code)) {
    const codeHash = hashBackupCode(code.toUpperCase());
    const backupRows = await db.execute({
      sql: `SELECT Id, Code_Hash FROM UsuarioTOTPBackup WHERE Id_Usuario = ? AND Used = 0`,
      args: [userId],
    });
    for (const bRow of backupRows.rows) {
      if (timingSafeStringEqual(String(bRow.Code_Hash), codeHash)) {
        await db.execute({
          sql: `UPDATE UsuarioTOTPBackup SET Used = 1, Used_At = ? WHERE Id = ?`,
          args: [new Date().toISOString(), bRow.Id],
        });
        verified = true;
        break;
      }
    }
  }

  if (!verified) {
    await logLoginActivity(db, { userId, ip, userAgent, success: false, reason: "invalid_totp_code" });
    return json({ error: "Código incorrecto" }, 400);
  }

  // Load fresh user data to build the session
  const userRow = await db.execute({
    sql: `SELECT Id, Nombre, Apellido_Paterno, Correo, Rol, COALESCE(Requires_Password_Change, 0) AS Requires_Password_Change
          FROM Usuario WHERE Id = ? LIMIT 1`,
    args: [userId],
  });
  if (!userRow.rows.length) {
    return json({ error: "Usuario no encontrado" }, 404);
  }
  const u = userRow.rows[0];

  // Clear failed-login rate-limit counter
  await clearAttemptsDistributed("login-fail", ip);

  // Issue FULL session token (new token — session fixation protection)
  const token = createSessionToken(
    {
      userId: u.Id,
      correo: u.Correo,
      nombre: u.Nombre,
      apellidoPaterno: u.Apellido_Paterno,
      rol: u.Rol,
      mustChangePassword: Number(u.Requires_Password_Change || 0) === 1,
    },
    DEFAULT_MAX_AGE,
    ip,
  );

  await logLoginActivity(db, { userId, ip, userAgent, success: true });

  const isProd = import.meta.env.PROD;

  const secureCookie = buildCookieHeader(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "Lax",
    path: "/",
    maxAge: DEFAULT_MAX_AGE,
  });

  // Legacy public cookie for frontend compatibility
  const publicCookie = buildCookieHeader(
    "authSession",
    JSON.stringify({
      userId: u.Id,
      correo: cleanInput(u.Correo || ""),
      nombre: cleanInput(u.Nombre || ""),
      rol: cleanInput(u.Rol || ""),
      mustChangePassword: Number(u.Requires_Password_Change || 0) === 1,
      timestamp: Date.now(),
    }),
    {
      httpOnly: false,
      secure: isProd,
      sameSite: "Lax",
      path: "/",
      maxAge: DEFAULT_MAX_AGE,
    },
  );

  const headers = new Headers();
  headers.append("Content-Type", "application/json");
  headers.append("Set-Cookie", secureCookie);
  headers.append("Set-Cookie", publicCookie);

  return new Response(
    JSON.stringify({
      success: true,
      redirectTo:
        Number(u.Requires_Password_Change || 0) === 1
          ? "/es/mi-cuenta?tab=seguridad&forcePassword=1"
          : "/es/",
      user: {
        id: u.Id,
        nombre: cleanInput(u.Nombre || ""),
        correo: cleanInput(u.Correo || ""),
        rol: cleanInput(u.Rol || ""),
      },
    }),
    { status: 200, headers },
  );
}
