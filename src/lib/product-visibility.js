import { verifySessionToken, SESSION_COOKIE } from './session.js';

export async function ensureProductVisibilitySchema(db) {
  void db;
  return true;
}

export async function ensureProductModerationSchema(db) {
  void db;
  return true;
}

/**
 * Reads the signed go_session token (HttpOnly, server-verified) instead of the
 * plain-JSON authSession cookie that the client can forge.
 */
export function getSessionUser(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
  } catch {
    return null;
  }
}

export function getSessionUserId(cookies) {
  const session = getSessionUser(cookies);
  const userId = Number(session?.userId || 0);
  return Number.isFinite(userId) && userId > 0 ? userId : null;
}

export function isPrivileged(session) {
  const role = normalizeRole(session?.rol);
  return role === "admin" || role === "superusuario";
}

export function normalizeRole(value) {
  const role = String(value || "").toLowerCase().trim();
  if (role === "superuser" || role === "superadmin") return "superusuario";
  return role;
}
