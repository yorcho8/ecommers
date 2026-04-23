// src/pages/api/verify-email.js
// GET /api/verify-email?token=xxx
// Called when user clicks the verification link in the registration email.
import { createClient } from "@libsql/client";
import "dotenv/config";
import { ensureEmailVerificationSchema } from "../../lib/auth-schema.js";
import { checkRateLimitDistributed, getClientIp } from "../../lib/rate-limit.js";
import { logSecurityEvent, shortHash } from "../../lib/security-audit.js";

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

export async function GET({ url, request }) {
  const ip = getClientIp(request);
  const userAgent = request.headers.get("user-agent") || "";
  const route = new URL(request.url).pathname;
  const rl = await checkRateLimitDistributed("verify-email", ip, {
    maxRequests: 20,
    windowMs: 60 * 60 * 1000,
  });
  if (rl.limited) {
    await logSecurityEvent(db, {
      eventType: "verify_email_rate_limited",
      severity: "warning",
      ip,
      userAgent,
      route,
      method: request.method,
      statusCode: 429,
    });
    return json({ error: "Demasiadas solicitudes" }, 429);
  }

  const token = String(url.searchParams.get("token") || "").trim();
  const tokenHash = shortHash(token);

  if (!token || token.length < 32) {
    await logSecurityEvent(db, {
      eventType: "verify_email_invalid_token",
      severity: "warning",
      ip,
      userAgent,
      route,
      method: request.method,
      statusCode: 400,
      meta: { reason: "length", tokenHash },
    });
    return json({ success: false, error: "Token inválido" }, 400);
  }

  // Sanitize: only allow hex chars
  if (!/^[0-9a-f]+$/i.test(token)) {
    await logSecurityEvent(db, {
      eventType: "verify_email_invalid_token",
      severity: "warning",
      ip,
      userAgent,
      route,
      method: request.method,
      statusCode: 400,
      meta: { reason: "format", tokenHash },
    });
    return json({ success: false, error: "Token inválido" }, 400);
  }

  await ensureEmailVerificationSchema(db);

  const result = await db.execute({
    sql: `SELECT e.Id_Usuario AS Id, e.Email_Verified, e.Email_Verification_Expires
          FROM UsuarioEmailAuth e
          WHERE e.Email_Verification_Token = ?
          LIMIT 1`,
    args: [token],
  });

  if (!result.rows.length) {
    await logSecurityEvent(db, {
      eventType: "verify_email_token_not_found",
      severity: "warning",
      ip,
      userAgent,
      route,
      method: request.method,
      statusCode: 404,
      meta: { tokenHash },
    });
    return json({ success: false, error: "Token no encontrado o ya utilizado" }, 404);
  }

  const row = result.rows[0];

  if (Number(row.Email_Verified) === 1) {
    await logSecurityEvent(db, {
      eventType: "verify_email_already_verified",
      severity: "info",
      userId: Number(row.Id),
      ip,
      userAgent,
      route,
      method: request.method,
      statusCode: 200,
      meta: { tokenHash },
    });
    return json({ success: true, message: "Correo ya verificado" });
  }

  // Check expiry
  if (row.Email_Verification_Expires) {
    const expires = new Date(String(row.Email_Verification_Expires));
    if (!isNaN(expires.getTime()) && Date.now() > expires.getTime()) {
      await logSecurityEvent(db, {
        eventType: "verify_email_token_expired",
        severity: "warning",
        userId: Number(row.Id),
        ip,
        userAgent,
        route,
        method: request.method,
        statusCode: 410,
        meta: { tokenHash },
      });
      return json({
        success: false,
        error: "El enlace de verificación ha expirado. Solicita uno nuevo.",
        expired: true,
      }, 410);
    }
  }

  // Mark as verified and clear the token
  await db.execute({
    sql: `UPDATE UsuarioEmailAuth
          SET Email_Verified = 1,
              Email_Verification_Token = NULL,
              Email_Verification_Expires = NULL,
              Updated_At = ?
          WHERE Id_Usuario = ?`,
    args: [new Date().toISOString(), Number(row.Id)],
  });

  await logSecurityEvent(db, {
    eventType: "verify_email_success",
    severity: "info",
    userId: Number(row.Id),
    ip,
    userAgent,
    route,
    method: request.method,
    statusCode: 302,
    meta: { tokenHash },
  });

  // Redirect to login with success message.
  // Prefer request origin to preserve current protocol (https in local dev).
  const reqUrl = new URL(request.url);
  const siteUrl =
    process.env.SITE_URL ||
    import.meta.env?.SITE_URL ||
    request.headers.get("origin") ||
    `${reqUrl.protocol}//${reqUrl.host}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${siteUrl}/es/login?verified=1`,
    },
  });
}
