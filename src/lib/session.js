// src/lib/session.js
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

var IS_PROD = (import.meta.env?.PROD === true) || process.env.NODE_ENV === 'production';

function resolveSecret() {
  var secret = process.env.SESSION_SECRET || import.meta.env.SESSION_SECRET || '';
  if (secret && secret.length >= 32) return secret;
  if (IS_PROD) {
    throw new Error('[session] SESSION_SECRET es obligatorio en producción y debe tener al menos 32 caracteres.');
  }
  console.warn('[session] SESSION_SECRET no definido. Usando fallback de desarrollo.');
  return 'dev-fallback-secret-change-me-in-production-please-32chars';
}

var SESSION_SECRET = resolveSecret();

function sign(payload) {
  var header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  var body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  var signature = createHmac('sha256', SESSION_SECRET).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + signature;
}

function verify(token) {
  try {
    var parts = token.split('.');
    if (parts.length !== 3) return null;
    var header = parts[0], body = parts[1], sig = parts[2];
    var expected = createHmac('sha256', SESSION_SECRET).update(header + '.' + body).digest('base64url');
    var sigBuf = Buffer.from(sig, 'base64url');
    var expBuf = Buffer.from(expected, 'base64url');
    if (sigBuf.length !== expBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expBuf)) return null;
    var payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Genera un hash corto de la IP para guardar en el token.
 * No se guarda la IP completa por privacidad, solo un hash para comparar.
 * @param {string} ip
 * @returns {string}
 */
export function hashIp(ip) {
  return createHash('sha256').update(ip || '').digest('hex').slice(0, 16);
}

/**
 * Crea un token de sesión firmado.
 * @param {object} user - Datos del usuario
 * @param {number} maxAgeSec - Duración en segundos
 * @param {string} ip - IP del cliente (se guarda como hash)
 * @returns {string}
 */
export function createSessionToken(user, maxAgeSec, ip) {
  var now = Date.now();
  var payload = {
    ...user,
    iat: now,
    exp: now + (maxAgeSec || 86400) * 1000,
    iph: ip ? hashIp(ip) : null,
  };
  return sign(payload);
}

/**
 * Verifica y decodifica un token de sesión.
 * @param {string} token
 * @returns {object|null}
 */
export function verifySessionToken(token) {
  return verify(token);
}

export function normalizeRole(value) {
  var raw = String(value || '').trim().toLowerCase();
  var compact = raw.replace(/[\s_-]/g, '');
  if (compact === 'superusuario' || compact === 'superuser' || compact === 'superadmin') return 'superusuario';
  if (compact === 'admin') return 'admin';
  return raw;
}

export function getSessionFromCookies(cookies) {
  try {
    var token = cookies?.get?.(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
  } catch {
    return null;
  }
}

export var SESSION_COOKIE = 'go_session';
export var DEFAULT_MAX_AGE = 24 * 60 * 60;