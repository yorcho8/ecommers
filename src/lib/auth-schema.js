// src/lib/auth-schema.js
// Database schema helpers for authentication-related tables.
// Uses the ensureDbSchemaOnce() pattern so migrations run at most once per process.
import { ensureDbSchemaOnce } from './schema-once.js';

/**
 * Create LoginActivity table + indexes if they don't exist.
 * Records every login attempt (success or failure) for auditing.
 */
export async function ensureLoginActivitySchema(db) {
  return ensureDbSchemaOnce(db, 'login_activity_v1', async () => {
    await db.execute({
      sql: `CREATE TABLE IF NOT EXISTS LoginActivity (
        Id          INTEGER PRIMARY KEY AUTOINCREMENT,
        Id_Usuario  INTEGER,
        IP          TEXT NOT NULL,
        User_Agent  TEXT,
        Success     INTEGER NOT NULL DEFAULT 0,
        Fail_Reason TEXT,
        Created_At  TEXT NOT NULL
      )`,
      args: [],
    });
    await db.execute({
      sql: `CREATE INDEX IF NOT EXISTS idx_loginactivity_user
            ON LoginActivity (Id_Usuario, Created_At DESC)`,
      args: [],
    });
    await db.execute({
      sql: `CREATE INDEX IF NOT EXISTS idx_loginactivity_ip
            ON LoginActivity (IP, Created_At DESC)`,
      args: [],
    });
  });
}

/**
 * Create dedicated email-auth table and backfill from legacy Usuario columns.
 * Keeping this data out of Usuario reduces coupling and keeps auth state isolated.
 */
export async function ensureEmailVerificationSchema(db) {
  return ensureDbSchemaOnce(db, 'email_verification_v1', async () => {
    await db.execute({
      sql: `CREATE TABLE IF NOT EXISTS UsuarioEmailAuth (
        Id_Usuario                  INTEGER PRIMARY KEY,
        Email_Verified              INTEGER NOT NULL DEFAULT 1,
        Email_Verification_Token    TEXT,
        Email_Verification_Expires  TEXT,
        Updated_At                  TEXT NOT NULL,
        FOREIGN KEY (Id_Usuario) REFERENCES Usuario(Id) ON DELETE CASCADE
      )`,
      args: [],
    });

    await db.execute({
      sql: `CREATE INDEX IF NOT EXISTS idx_user_emailauth_verified
            ON UsuarioEmailAuth (Email_Verified)` ,
      args: [],
    });

    await db.execute({
      sql: `CREATE INDEX IF NOT EXISTS idx_user_emailauth_token
            ON UsuarioEmailAuth (Email_Verification_Token)` ,
      args: [],
    });

    const now = new Date().toISOString();

    // Backfill from legacy columns when they exist.
    try {
      await db.execute({
        sql: `INSERT INTO UsuarioEmailAuth (
                Id_Usuario,
                Email_Verified,
                Email_Verification_Token,
                Email_Verification_Expires,
                Updated_At
              )
              SELECT
                u.Id,
                COALESCE(u.Email_Verified, 1),
                u.Email_Verification_Token,
                u.Email_Verification_Expires,
                ?
              FROM Usuario u
              LEFT JOIN UsuarioEmailAuth e ON e.Id_Usuario = u.Id
              WHERE e.Id_Usuario IS NULL`,
        args: [now],
      });
      return;
    } catch {
      // Fallback for schemas where legacy columns do not exist.
    }

    await db.execute({
      sql: `INSERT INTO UsuarioEmailAuth (
              Id_Usuario,
              Email_Verified,
              Email_Verification_Token,
              Email_Verification_Expires,
              Updated_At
            )
            SELECT
              u.Id,
              1,
              NULL,
              NULL,
              ?
            FROM Usuario u
            LEFT JOIN UsuarioEmailAuth e ON e.Id_Usuario = u.Id
            WHERE e.Id_Usuario IS NULL`,
      args: [now],
    });
  });
}

/**
 * Create UsuarioTOTP (secrets) and UsuarioTOTPBackup (backup codes) tables.
 */
export async function ensureTotpSchema(db) {
  return ensureDbSchemaOnce(db, 'totp_v1', async () => {
    await db.execute({
      sql: `CREATE TABLE IF NOT EXISTS UsuarioTOTP (
        Id         INTEGER PRIMARY KEY AUTOINCREMENT,
        Id_Usuario INTEGER NOT NULL UNIQUE,
        Secret     TEXT NOT NULL,
        Enabled    INTEGER NOT NULL DEFAULT 0,
        Created_At TEXT NOT NULL,
        Updated_At TEXT NOT NULL
      )`,
      args: [],
    });
    await db.execute({
      sql: `CREATE TABLE IF NOT EXISTS UsuarioTOTPBackup (
        Id         INTEGER PRIMARY KEY AUTOINCREMENT,
        Id_Usuario INTEGER NOT NULL,
        Code_Hash  TEXT NOT NULL,
        Used       INTEGER NOT NULL DEFAULT 0,
        Used_At    TEXT,
        Created_At TEXT NOT NULL
      )`,
      args: [],
    });
    await db.execute({
      sql: `CREATE INDEX IF NOT EXISTS idx_totp_user
            ON UsuarioTOTP (Id_Usuario)`,
      args: [],
    });
    await db.execute({
      sql: `CREATE INDEX IF NOT EXISTS idx_totpbackup_user
            ON UsuarioTOTPBackup (Id_Usuario, Used)`,
      args: [],
    });
  });
}

/**
 * Log a login attempt.  id_usuario may be null for attempts against unknown emails.
 * @param {object} db
 * @param {{ userId?: number|null, ip: string, userAgent?: string, success: boolean, reason?: string }} opts
 */
export async function logLoginActivity(db, { userId, ip, userAgent, success, reason }) {
  try {
    await ensureLoginActivitySchema(db);
    await db.execute({
      sql: `INSERT INTO LoginActivity (Id_Usuario, IP, User_Agent, Success, Fail_Reason, Created_At)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        userId ?? null,
        String(ip || '').slice(0, 100),
        String(userAgent || '').slice(0, 500),
        success ? 1 : 0,
        success ? null : String(reason || 'unknown').slice(0, 100),
        new Date().toISOString(),
      ],
    });
  } catch (err) {
    // Never let logging errors bubble up and break the auth flow
    console.error('[auth-schema] logLoginActivity error:', err?.message);
  }
}
