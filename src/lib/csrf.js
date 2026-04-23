// src/lib/csrf.js
// ─── Protección CSRF con double-submit cookie ───
// El middleware genera un token random y lo pone en una cookie legible.
// El frontend lo lee y lo manda como header en POST/PUT/DELETE.
// El middleware valida que coincidan.

import { randomBytes, timingSafeEqual } from 'node:crypto';

export var CSRF_COOKIE = 'go_csrf';
export var CSRF_HEADER = 'x-csrf-token';

/**
 * Genera un token CSRF aleatorio.
 * @returns {string}
 */
export function generateCsrfToken() {
  return randomBytes(32).toString('hex');
}

/**
 * Valida que el token del header coincida con el de la cookie.
 * Usa timingSafeEqual para evitar ataques de tiempo (timing attacks).
 * @param {string|null} cookieToken
 * @param {string|null} headerToken
 * @returns {boolean}
 */
export function validateCsrfToken(cookieToken, headerToken) {
  if (!cookieToken || !headerToken) return false;
  const a = String(cookieToken);
  const b = String(headerToken);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Construye el header Set-Cookie para el CSRF token.
 * @param {string} token
 * @param {boolean} isProd
 * @returns {string}
 */
export function buildCsrfCookie(token, isProd) {
  var parts = [
    CSRF_COOKIE + '=' + token,
    'Path=/',
    'SameSite=Lax',
    'Max-Age=86400',  // 24 horas
  ];
  if (isProd) parts.push('Secure');
  // NO httpOnly — el frontend necesita leerlo
  return parts.join('; ');
}