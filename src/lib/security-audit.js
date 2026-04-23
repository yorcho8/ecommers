import { createHash } from "node:crypto";

const DEFAULT_RETENTION_DAYS = 30;

function isAuditEnabled() {
  const value = String(
    process.env.SECURITY_AUDIT_ENABLED || import.meta.env?.SECURITY_AUDIT_ENABLED || "true",
  ).trim().toLowerCase();
  return value !== "0" && value !== "false";
}

export function shortHash(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export async function ensureSecurityAuditSchema(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS SecurityAuditLog (
      Id INTEGER PRIMARY KEY AUTOINCREMENT,
      Event_Type TEXT NOT NULL,
      Severity TEXT NOT NULL,
      Id_Usuario INTEGER,
      IP TEXT,
      User_Agent TEXT,
      Route TEXT,
      Method TEXT,
      Status_Code INTEGER,
      Meta_JSON TEXT,
      Created_At TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_securityaudit_created
    ON SecurityAuditLog (Created_At DESC)
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_securityaudit_event
    ON SecurityAuditLog (Event_Type, Created_At DESC)
  `);

  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_securityaudit_ip
    ON SecurityAuditLog (IP, Created_At DESC)
  `);
}

export async function logSecurityEvent(db, {
  eventType,
  severity = "info",
  userId = null,
  ip = "",
  userAgent = "",
  route = "",
  method = "",
  statusCode = null,
  meta = null,
}) {
  if (!isAuditEnabled()) return;
  if (!eventType) return;

  try {
    await ensureSecurityAuditSchema(db);
    await db.execute({
      sql: `INSERT INTO SecurityAuditLog
            (Event_Type, Severity, Id_Usuario, IP, User_Agent, Route, Method, Status_Code, Meta_JSON, Created_At)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        String(eventType).slice(0, 80),
        String(severity || "info").slice(0, 20),
        userId == null ? null : Number(userId),
        String(ip || "").slice(0, 100),
        String(userAgent || "").slice(0, 500),
        String(route || "").slice(0, 255),
        String(method || "").slice(0, 10).toUpperCase(),
        statusCode == null ? null : Number(statusCode),
        meta ? JSON.stringify(meta).slice(0, 2000) : null,
        new Date().toISOString(),
      ],
    });
  } catch (err) {
    // Never break business flow because of observability.
    console.error("[security-audit] logSecurityEvent error:", err?.message);
  }
}

export async function purgeSecurityAuditLogs(db) {
  if (!isAuditEnabled()) return { deleted: 0, retentionDays: null };

  const retentionDays = Math.max(
    1,
    Number(
      process.env.SECURITY_AUDIT_RETENTION_DAYS ||
      import.meta.env?.SECURITY_AUDIT_RETENTION_DAYS ||
      DEFAULT_RETENTION_DAYS,
    ) || DEFAULT_RETENTION_DAYS,
  );

  try {
    await ensureSecurityAuditSchema(db);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const res = await db.execute({
      sql: `DELETE FROM SecurityAuditLog WHERE Created_At < ?`,
      args: [cutoff],
    });

    return { deleted: Number(res?.rowsAffected || 0), retentionDays };
  } catch (err) {
    console.error("[security-audit] purgeSecurityAuditLogs error:", err?.message);
    return { deleted: 0, retentionDays };
  }
}
