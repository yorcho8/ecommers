// src/pages/api/resend-verification.js
// POST /api/resend-verification
// Body (JSON): { correo: string }
// Rate-limited to prevent email flooding.
import { createClient } from "@libsql/client";
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { ensureEmailVerificationSchema } from "../../lib/auth-schema.js";
import { sendEmailVerification } from "../../lib/mail.js";
import { checkRateLimitDistributed, getClientIp } from "../../lib/rate-limit.js";
import { cleanEmail } from "../../lib/sanitize.js";
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

// Anti-enumeration: always return the same response regardless of whether the email exists
const SAFE_RESPONSE = {
  success: true,
  message: "Si existe una cuenta pendiente de verificación, recibirás un correo en breve.",
};

export async function POST({ request }) {
  const ip = getClientIp(request);
  const userAgent = request.headers.get("user-agent") || "";
  const route = new URL(request.url).pathname;

  // Max 3 resends per IP per hour
  const rl = await checkRateLimitDistributed("resend-verification", ip, {
    maxRequests: 3,
    windowMs: 60 * 60 * 1000,
    blockMs: 60 * 60 * 1000,
  });
  if (rl.limited) {
    await logSecurityEvent(db, {
      eventType: "verification_resend_rate_limited",
      severity: "warning",
      ip,
      userAgent,
      route,
      method: request.method,
      statusCode: 429,
      meta: { scope: "ip" },
    });
    return json(
      { error: `Demasiadas solicitudes. Intenta en ${Math.ceil(rl.retryAfter / 60)} minutos.` },
      429,
    );
  }

  const body = await request.json().catch(() => ({}));
  const correo = cleanEmail(String(body?.correo || ""));
  const emailHash = shortHash(correo);

  if (!correo || !correo.includes("@")) {
    return json(SAFE_RESPONSE); // don't reveal format errors
  }

  // Extra throttling by email and by ip+email to reduce abuse via IP rotation.
  const rlByEmail = await checkRateLimitDistributed("resend-verification-email", correo, {
    maxRequests: 3,
    windowMs: 60 * 60 * 1000,
    blockMs: 60 * 60 * 1000,
  });
  if (rlByEmail.limited) {
    await logSecurityEvent(db, {
      eventType: "verification_resend_rate_limited",
      severity: "warning",
      ip,
      userAgent,
      route,
      method: request.method,
      statusCode: 200,
      meta: { scope: "email", emailHash },
    });
    return json(SAFE_RESPONSE);
  }

  const rlByIpAndEmail = await checkRateLimitDistributed("resend-verification-ip-email", `${ip}:${correo}`, {
    maxRequests: 2,
    windowMs: 30 * 60 * 1000,
    blockMs: 30 * 60 * 1000,
  });
  if (rlByIpAndEmail.limited) {
    await logSecurityEvent(db, {
      eventType: "verification_resend_rate_limited",
      severity: "warning",
      ip,
      userAgent,
      route,
      method: request.method,
      statusCode: 200,
      meta: { scope: "ip_email", emailHash },
    });
    return json(SAFE_RESPONSE);
  }

  await ensureEmailVerificationSchema(db);

  const result = await db.execute({
    sql: `SELECT u.Id, u.Nombre, COALESCE(e.Email_Verified, 1) AS Email_Verified
          FROM Usuario u
          LEFT JOIN UsuarioEmailAuth e ON e.Id_Usuario = u.Id
          WHERE LOWER(u.Correo) = LOWER(?)
          LIMIT 1`,
    args: [correo],
  });

  // Always return the same response (anti-enumeration)
  if (!result.rows.length || Number(result.rows[0].Email_Verified) === 1) {
    await logSecurityEvent(db, {
      eventType: "verification_resend_safe_response",
      severity: "info",
      ip,
      userAgent,
      route,
      method: request.method,
      statusCode: 200,
      meta: { reason: "not_pending_or_not_found", emailHash },
    });
    return json(SAFE_RESPONSE);
  }

  const user = result.rows[0];
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h

  await db.execute({
    sql: `INSERT INTO UsuarioEmailAuth
          (Id_Usuario, Email_Verified, Email_Verification_Token, Email_Verification_Expires, Updated_At)
          VALUES (?, 0, ?, ?, ?)
          ON CONFLICT(Id_Usuario)
          DO UPDATE SET
            Email_Verification_Token = excluded.Email_Verification_Token,
            Email_Verification_Expires = excluded.Email_Verification_Expires,
            Updated_At = excluded.Updated_At`,
    args: [Number(user.Id), token, expires, new Date().toISOString()],
  });

  await logSecurityEvent(db, {
    eventType: "verification_token_rotated",
    severity: "info",
    userId: Number(user.Id),
    ip,
    userAgent,
    route,
    method: request.method,
    statusCode: 200,
    meta: { emailHash, expires },
  });

  const siteUrl =
    process.env.SITE_URL ||
    import.meta.env?.SITE_URL ||
    "http://localhost:4321";

  const verifyUrl = `${siteUrl}/api/verify-email?token=${token}`;

  sendEmailVerification({
    to: correo,
    name: String(user.Nombre || ""),
    verifyUrl,
  }).catch((err) => console.error("[resend-verification] mail error:", err?.message));

  return json(SAFE_RESPONSE);
}
