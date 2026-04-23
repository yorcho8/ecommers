import { createClient } from "@libsql/client";
import "dotenv/config";
import { purgeSecurityAuditLogs } from "../../../lib/security-audit.js";

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

function isAuthorized(request) {
  const cronSecret = process.env.CRON_SECRET || import.meta.env?.CRON_SECRET || "";
  if (!cronSecret) return true;
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  return token && token === cronSecret;
}

async function purgeExpiredVerificationTokens() {
  const nowIso = new Date().toISOString();
  const result = await db.execute({
    sql: `UPDATE UsuarioEmailAuth
          SET Email_Verification_Token = NULL,
              Email_Verification_Expires = NULL,
              Updated_At = ?
          WHERE Email_Verified = 0
            AND Email_Verification_Token IS NOT NULL
            AND Email_Verification_Expires IS NOT NULL
            AND Email_Verification_Expires < ?`,
    args: [nowIso, nowIso],
  });
  return Number(result?.rowsAffected || 0);
}

async function cleanupOldStripeEvents() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS StripeWebhookEvent (
      Event_Id TEXT PRIMARY KEY,
      Event_Type TEXT,
      Received_At TEXT NOT NULL,
      Processed_At TEXT,
      Status TEXT NOT NULL,
      Error TEXT
    )
  `);

  const retentionDays = Math.max(
    1,
    Number(
      process.env.STRIPE_WEBHOOK_EVENT_RETENTION_DAYS ||
      import.meta.env?.STRIPE_WEBHOOK_EVENT_RETENTION_DAYS ||
      30,
    ) || 30,
  );

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await db.execute({
    sql: `DELETE FROM StripeWebhookEvent WHERE Received_At < ?`,
    args: [cutoff],
  });

  return {
    deleted: Number(result?.rowsAffected || 0),
    retentionDays,
  };
}

async function cleanupSecurityCodes() {
  const cutoffIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const usedCodes = await db.execute({
    sql: `DELETE FROM UserSecurityCode
          WHERE Usado = 1
             OR Expira_En < ?
             OR Fecha_Creacion < ?`,
    args: [new Date().toISOString(), cutoffIso],
  }).catch(() => ({ rowsAffected: 0 }));

  const loginRows = await db.execute({
    sql: `DELETE FROM LoginActivity
          WHERE Created_At < ?`,
    args: [cutoffIso],
  }).catch(() => ({ rowsAffected: 0 }));

  return {
    securityCodesDeleted: Number(usedCodes?.rowsAffected || 0),
    loginActivityDeleted: Number(loginRows?.rowsAffected || 0),
  };
}

export async function GET({ request }) {
  if (!isAuthorized(request)) {
    return json({ success: false, error: "No autorizado" }, 401);
  }

  try {
    const audit = await purgeSecurityAuditLogs(db);
    const expiredTokensDeleted = await purgeExpiredVerificationTokens();
    const stripe = await cleanupOldStripeEvents();
    const generic = await cleanupSecurityCodes();

    return json({
      success: true,
      maintenance: {
        securityAudit: audit,
        verificationTokensDeleted: expiredTokensDeleted,
        stripeEvents: stripe,
        generic,
      },
      executedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[cron/maintenance] error:", error);
    return json({ success: false, error: error?.message || "Error de mantenimiento" }, 500);
  }
}
