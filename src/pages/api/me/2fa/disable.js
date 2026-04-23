// src/pages/api/me/2fa/disable.js
// POST /api/me/2fa/disable — Disable TOTP after verifying a current code (or backup code)
import { createClient } from "@libsql/client";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../../../lib/session.js";
import { verifyTotpCode, hashBackupCode } from "../../../../lib/totp.js";
import { ensureTotpSchema } from "../../../../lib/auth-schema.js";
import { checkRateLimit, getClientIp } from "../../../../lib/rate-limit.js";
import { sendTotpDisabled } from "../../../../lib/mail.js";
import { createHash, timingSafeEqual } from "node:crypto";

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

function timingSafeStringEqual(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export async function POST({ cookies, request }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  const ip = getClientIp(request);
  const rl = checkRateLimit("2fa-disable", ip, {
    maxRequests: 5,
    windowMs: 15 * 60 * 1000,
    blockMs: 30 * 60 * 1000,
  });
  if (rl.limited) return json({ success: false, error: "Demasiados intentos" }, 429);

  const body = await request.json().catch(() => ({}));
  const code = String(body?.code || "").replace(/\s/g, "");

  if (!code) return json({ success: false, error: "Se requiere el código de autenticador o código de respaldo" }, 400);

  await ensureTotpSchema(db);

  const row = await db.execute({
    sql: `SELECT Id, Secret, Enabled FROM UsuarioTOTP WHERE Id_Usuario = ? LIMIT 1`,
    args: [sessionUser.userId],
  });

  if (!row.rows.length || Number(row.rows[0].Enabled) !== 1) {
    return json({ success: false, error: "TOTP no está activo en esta cuenta" }, 400);
  }

  const secret = String(row.rows[0].Secret);

  // Check if it's a 6-digit TOTP code
  let verified = false;
  if (/^\d{6}$/.test(code)) {
    verified = verifyTotpCode(secret, code);
  }

  // If not a TOTP code, try backup codes (format: XXXXXX-XXXXXX)
  if (!verified && /^[A-F0-9]{6}-[A-F0-9]{6}$/i.test(code)) {
    const codeHash = hashBackupCode(code.toUpperCase());
    const bkp = await db.execute({
      sql: `SELECT Id FROM UsuarioTOTPBackup
            WHERE Id_Usuario = ? AND Used = 0
            LIMIT 50`,
      args: [sessionUser.userId],
    });
    // Check each unused backup code using timing-safe comparison
    const backupRows = await db.execute({
      sql: `SELECT Id, Code_Hash FROM UsuarioTOTPBackup
            WHERE Id_Usuario = ? AND Used = 0`,
      args: [sessionUser.userId],
    });
    for (const bRow of backupRows.rows) {
      if (timingSafeStringEqual(String(bRow.Code_Hash), codeHash)) {
        // Mark as used
        await db.execute({
          sql: `UPDATE UsuarioTOTPBackup SET Used = 1, Used_At = ? WHERE Id = ?`,
          args: [new Date().toISOString(), bRow.Id],
        });
        verified = true;
        break;
      }
    }
    void bkp; // was only used to avoid timing differences
  }

  if (!verified) {
    return json({ success: false, error: "Código incorrecto" }, 400);
  }

  const now = new Date().toISOString();

  // Disable TOTP and invalidate all backup codes
  await db.execute({
    sql: `UPDATE UsuarioTOTP SET Enabled = 0, Updated_At = ? WHERE Id_Usuario = ?`,
    args: [now, sessionUser.userId],
  });
  await db.execute({
    sql: `UPDATE UsuarioTOTPBackup SET Used = 1, Used_At = ? WHERE Id_Usuario = ? AND Used = 0`,
    args: [now, sessionUser.userId],
  });

  // Security notification email (fire-and-forget)
  const userRow = await db.execute({
    sql: `SELECT Correo, Nombre FROM Usuario WHERE Id = ? LIMIT 1`,
    args: [sessionUser.userId],
  });
  if (userRow.rows.length) {
    sendTotpDisabled({
      to: String(userRow.rows[0].Correo || ""),
      name: String(userRow.rows[0].Nombre || ""),
    }).catch(() => {});
  }

  return json({ success: true, message: "Autenticación TOTP desactivada." });
}
