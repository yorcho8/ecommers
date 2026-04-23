// src/pages/api/me/2fa/setup.js
// GET  /api/me/2fa/setup — Return TOTP status; generate+store pending secret if not enabled
// POST /api/me/2fa/setup — Confirm first TOTP code, enable 2FA, return backup codes
import { createClient } from "@libsql/client";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../../../lib/session.js";
import {
  generateTotpSecret,
  getTotpUri,
  verifyTotpCode,
  encryptTotpSecret,
  generateBackupCodes,
  hashBackupCode,
} from "../../../../lib/totp.js";
import { ensureTotpSchema } from "../../../../lib/auth-schema.js";
import { checkRateLimit, getClientIp } from "../../../../lib/rate-limit.js";
import { sendTotpEnabled } from "../../../../lib/mail.js";

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

// GET — returns current TOTP status + pending secret/URI if not yet enabled
export async function GET({ cookies }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  await ensureTotpSchema(db);

  const existing = await db.execute({
    sql: `SELECT Enabled FROM UsuarioTOTP WHERE Id_Usuario = ? LIMIT 1`,
    args: [sessionUser.userId],
  });

  if (existing.rows.length && Number(existing.rows[0].Enabled) === 1) {
    // Count remaining backup codes
    const bkp = await db.execute({
      sql: `SELECT COUNT(*) AS cnt FROM UsuarioTOTPBackup WHERE Id_Usuario = ? AND Used = 0`,
      args: [sessionUser.userId],
    });
    return json({
      success: true,
      totpEnabled: true,
      backupCodesRemaining: Number(bkp.rows[0]?.cnt ?? 0),
    });
  }

  // Generate a new secret and upsert it as disabled (pending confirmation)
  const rawSecret = generateTotpSecret();
  const encSecret = encryptTotpSecret(rawSecret);
  const now = new Date().toISOString();

  await db.execute({
    sql: `INSERT INTO UsuarioTOTP (Id_Usuario, Secret, Enabled, Created_At, Updated_At)
          VALUES (?, ?, 0, ?, ?)
          ON CONFLICT(Id_Usuario) DO UPDATE
            SET Secret = excluded.Secret,
                Enabled = 0,
                Updated_At = excluded.Updated_At`,
    args: [sessionUser.userId, encSecret, now, now],
  });

  const uri = getTotpUri(
    rawSecret,
    String(sessionUser.correo || sessionUser.userId),
    "NEXUS",
  );

  return json({ success: true, totpEnabled: false, secret: rawSecret, uri });
}

// POST — verify first code and activate TOTP, return one-time backup codes
export async function POST({ cookies, request }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  const ip = getClientIp(request);
  const rl = checkRateLimit("2fa-setup", ip, {
    maxRequests: 10,
    windowMs: 15 * 60 * 1000,
    blockMs: 30 * 60 * 1000,
  });
  if (rl.limited) return json({ success: false, error: "Demasiados intentos" }, 429);

  const body = await request.json().catch(() => ({}));
  const code = String(body?.code || "").replace(/\s/g, "");

  if (!code || !/^\d{6}$/.test(code)) {
    return json({ success: false, error: "El código debe ser de 6 dígitos" }, 400);
  }

  await ensureTotpSchema(db);

  const row = await db.execute({
    sql: `SELECT Id, Secret, Enabled FROM UsuarioTOTP WHERE Id_Usuario = ? LIMIT 1`,
    args: [sessionUser.userId],
  });

  if (!row.rows.length) {
    return json({ success: false, error: "Primero solicita la configuración (GET /api/me/2fa/setup)" }, 400);
  }
  if (Number(row.rows[0].Enabled) === 1) {
    return json({ success: false, error: "TOTP ya está activo en esta cuenta" }, 400);
  }

  if (!verifyTotpCode(String(row.rows[0].Secret), code)) {
    return json({ success: false, error: "Código incorrecto. Verifica que la hora de tu dispositivo sea correcta." }, 400);
  }

  const now = new Date().toISOString();

  // Enable TOTP
  await db.execute({
    sql: `UPDATE UsuarioTOTP SET Enabled = 1, Updated_At = ? WHERE Id_Usuario = ?`,
    args: [now, sessionUser.userId],
  });

  // Invalidate old backup codes and generate fresh ones
  await db.execute({
    sql: `DELETE FROM UsuarioTOTPBackup WHERE Id_Usuario = ?`,
    args: [sessionUser.userId],
  });

  const backupCodes = generateBackupCodes(10);
  for (const bc of backupCodes) {
    await db.execute({
      sql: `INSERT INTO UsuarioTOTPBackup (Id_Usuario, Code_Hash, Used, Created_At)
            VALUES (?, ?, 0, ?)`,
      args: [sessionUser.userId, hashBackupCode(bc), now],
    });
  }

  // Send security notification email (fire-and-forget)
  const userRow = await db.execute({
    sql: `SELECT Correo, Nombre FROM Usuario WHERE Id = ? LIMIT 1`,
    args: [sessionUser.userId],
  });
  if (userRow.rows.length) {
    sendTotpEnabled({
      to: String(userRow.rows[0].Correo || ""),
      name: String(userRow.rows[0].Nombre || ""),
    }).catch(() => {});
  }

  return json({
    success: true,
    message: "Autenticación de dos factores activada.",
    backupCodes, // shown ONCE — user must save these
  });
}
