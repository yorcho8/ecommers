// src/pages/api/me/2fa/backup-codes.js
// GET  /api/me/2fa/backup-codes — Return count of unused backup codes
// POST /api/me/2fa/backup-codes — Regenerate backup codes (requires current TOTP code)
import { createClient } from "@libsql/client";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../../../lib/session.js";
import {
  verifyTotpCode,
  generateBackupCodes,
  hashBackupCode,
} from "../../../../lib/totp.js";
import { ensureTotpSchema } from "../../../../lib/auth-schema.js";
import { checkRateLimit, getClientIp } from "../../../../lib/rate-limit.js";

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

// GET — how many backup codes remain unused
export async function GET({ cookies }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  await ensureTotpSchema(db);

  const row = await db.execute({
    sql: `SELECT Enabled FROM UsuarioTOTP WHERE Id_Usuario = ? LIMIT 1`,
    args: [sessionUser.userId],
  });

  if (!row.rows.length || Number(row.rows[0].Enabled) !== 1) {
    return json({ success: false, error: "TOTP no está activo" }, 400);
  }

  const cnt = await db.execute({
    sql: `SELECT COUNT(*) AS cnt FROM UsuarioTOTPBackup WHERE Id_Usuario = ? AND Used = 0`,
    args: [sessionUser.userId],
  });

  return json({
    success: true,
    backupCodesRemaining: Number(cnt.rows[0]?.cnt ?? 0),
  });
}

// POST { code } — verify TOTP then issue fresh backup codes (invalidates old ones)
export async function POST({ cookies, request }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  const ip = getClientIp(request);
  const rl = checkRateLimit("2fa-backup-regen", ip, {
    maxRequests: 3,
    windowMs: 60 * 60 * 1000, // 1 hour
    blockMs: 60 * 60 * 1000,
  });
  if (rl.limited) return json({ success: false, error: "Demasiados intentos. Intenta en 1 hora." }, 429);

  const body = await request.json().catch(() => ({}));
  const code = String(body?.code || "").replace(/\s/g, "");

  if (!code || !/^\d{6}$/.test(code)) {
    return json({ success: false, error: "Se requiere el código de 6 dígitos del autenticador" }, 400);
  }

  await ensureTotpSchema(db);

  const row = await db.execute({
    sql: `SELECT Secret, Enabled FROM UsuarioTOTP WHERE Id_Usuario = ? LIMIT 1`,
    args: [sessionUser.userId],
  });

  if (!row.rows.length || Number(row.rows[0].Enabled) !== 1) {
    return json({ success: false, error: "TOTP no está activo" }, 400);
  }

  if (!verifyTotpCode(String(row.rows[0].Secret), code)) {
    return json({ success: false, error: "Código incorrecto" }, 400);
  }

  const now = new Date().toISOString();

  // Invalidate all existing backup codes
  await db.execute({
    sql: `UPDATE UsuarioTOTPBackup SET Used = 1, Used_At = ? WHERE Id_Usuario = ? AND Used = 0`,
    args: [now, sessionUser.userId],
  });

  // Generate and store fresh backup codes
  const backupCodes = generateBackupCodes(10);
  for (const bc of backupCodes) {
    await db.execute({
      sql: `INSERT INTO UsuarioTOTPBackup (Id_Usuario, Code_Hash, Used, Created_At) VALUES (?, ?, 0, ?)`,
      args: [sessionUser.userId, hashBackupCode(bc), now],
    });
  }

  return json({
    success: true,
    message: "Códigos de respaldo regenerados. Guárdalos en un lugar seguro.",
    backupCodes, // shown ONCE
  });
}
