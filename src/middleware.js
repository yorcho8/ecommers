// src/middleware.js
import { defineMiddleware } from 'astro:middleware';
import { randomBytes } from 'node:crypto';
import { verifySessionToken, SESSION_COOKIE, hashIp } from './lib/session';
import { CSRF_COOKIE, CSRF_HEADER, generateCsrfToken, validateCsrfToken, buildCsrfCookie } from './lib/csrf';
import { getClientIp } from './lib/rate-limit';

// ─────────────────────────────────────────────────────────────────────────────
// Rutas que SÍ requieren login.
// Todo lo demás es público por defecto (modelo e-commerce).
// ─────────────────────────────────────────────────────────────────────────────
var PROTECTED_ROUTES = [
  // Cuenta del usuario
  '/es/cuenta',
  '/api/me',
  '/api/direcciones',
  '/api/tarjetas',

  // Finalizar compra y pedidos
  '/es/checkout',
  '/api/pago',
  '/api/pedidos',

  // Admin — cualquier subruta queda bloqueada
  '/es/admin',
  '/api/admin',
];

// ─────────────────────────────────────────────────────────────────────────────
// Rutas donde NO se valida CSRF.
// IMPORTANT: solo endpoints públicos de lectura o flujos sin sesión.
// Pago, tarjetas, admin y cuenta siguen protegidos por CSRF.
// ─────────────────────────────────────────────────────────────────────────────
var CSRF_EXEMPT = [
  '/api/public-key',
  '/api/logout',
  '/api/login',
  '/api/register',
  '/api/forgot-password',
  '/api/password-reset',
  '/api/feedback',
  '/api/resenas',
  '/api/resenas/eliminar',
  '/api/publicidad',
  '/api/carrito',       // añadir/quitar del carrito es público
  '/api/envio/cotizar',
  '/api/productos',
  '/api/locations',
  '/api/analytics',
  '/api/chat',
  '/api/recruitment',
  '/api/register-empresa/kyc',
  '/api/register-empresa/biometria',
  '/api/register-empresa',
  '/api/verify-email',
  '/api/resend-verification',
  '/api/auth/verify-2fa',
  '/api/stripe-webhook', // Stripe sends POST without CSRF token
  '/webhook', // Envia webhook endpoint (HMAC-signed, no browser CSRF context)
];

var STATIC_PREFIXES = ['/images/', '/fonts/', '/favicon', '/_astro/'];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function isStatic(pathname) {
  return STATIC_PREFIXES.some(function (p) { return pathname.startsWith(p); });
}

function isProtected(pathname) {
  var clean = pathname.replace(/\/$/, '') || '/';
  return PROTECTED_ROUTES.some(function (r) {
    return clean === r || clean.startsWith(r + '/');
  });
}

function isPublicCompanyRoute(pathname) {
  var clean = pathname.replace(/\/$/, '') || '/';
  // These routes handle their own ownership/CSRF validation internally.
  // Auth bypass is based solely on the route path — never on a client-supplied header.
  if (clean === '/api/admin/empresas') return true;
  if (clean === '/api/admin/empresas/documentos/upload') return true;
  if (clean === '/api/register-empresa/kyc') return true;
  if (clean === '/api/register-empresa/biometria') return true;
  return false;
}

function isCsrfExempt(pathname) {
  var clean = pathname.replace(/\/$/, '') || '/';
  return CSRF_EXEMPT.some(function (r) {
    return clean === r || clean.startsWith(r + '/');
  });
}

function isAllowedWhileForcePassword(pathname, safeLang) {
  var clean = pathname.replace(/\/$/, '') || '/';
  if (clean === '/' + safeLang + '/mi-cuenta') return true;
  if (clean === '/api/me/security') return true;
  if (clean === '/api/me/force-password-change') return true;
  if (clean === '/api/logout') return true;
  if (clean === '/' + safeLang + '/login') return true;
  return false;
}

function toMutableResponse(response) {
  // Some framework responses expose immutable Headers (e.g. redirects).
  // Clone into a new Response so security headers and cookies can be appended safely.
  return new Response(response.body, response);
}

function addSecurityHeaders(response, cspNonce, options) {
  response = toMutableResponse(response);
  var allowUnsafeInlineScript = options?.allowUnsafeInlineScript !== false;
  // For non-admin pages we rely on 'unsafe-inline' only.
  // In CSP Level 3, having a nonce alongside 'unsafe-inline' causes browsers to
  // IGNORE 'unsafe-inline', blocking all inline scripts that don't carry the nonce.
  // Admin pages use nonce-only (no 'unsafe-inline') for strict CSP.
  var nonceSource = (!allowUnsafeInlineScript && cspNonce) ? " 'nonce-" + cspNonce + "'" : '';
  var scriptSource = "script-src 'self'" + nonceSource + (allowUnsafeInlineScript ? " 'unsafe-inline'" : '') + " https://js.stripe.com https://cdn.jsdelivr.net https://challenges.cloudflare.com";
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), interest-cohort=()');
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  response.headers.set('Content-Security-Policy', [
    "default-src 'self'",
    scriptSource,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "img-src 'self' data: https: blob:",
    "connect-src 'self' https://api.countrystatecity.in https://*.turso.io https://api.stripe.com https://challenges.cloudflare.com",
    "frame-src https://js.stripe.com https://hooks.stripe.com https://challenges.cloudflare.com",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "worker-src 'self' blob:",
    "upgrade-insecure-requests",
  ].join('; '));
  return response;
}

function ensureCsrfCookie(request, response, isProd) {
  var existing = request.headers.get('cookie') || '';
  if (existing.includes(CSRF_COOKIE + '=')) return response;
  response = toMutableResponse(response);
  var token = generateCsrfToken();
  response.headers.append('Set-Cookie', buildCsrfCookie(token, isProd));
  return response;
}

function getCsrfFromCookies(request) {
  var cookies = request.headers.get('cookie') || '';
  var match = cookies.match(new RegExp(CSRF_COOKIE + '=([^;]+)'));
  return match ? match[1] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Middleware principal
// ─────────────────────────────────────────────────────────────────────────────
export var onRequest = defineMiddleware(async function (context, next) {
  var pathname = context.url.pathname;
  var request = context.request;
  var method = request.method.toUpperCase();
  var isProd = import.meta.env.PROD;
  var isAdminPage = pathname.startsWith('/es/admin');
  var cspNonce = randomBytes(16).toString('base64');
  context.locals.cspNonce = cspNonce;

  // Archivos estáticos: pasar directo, sin lógica
  if (isStatic(pathname)) return next();

  try {
    // ── CSRF: validar en POST / PUT / DELETE no exentos ───────────────────
    if (
      (method === 'POST' || method === 'PUT' || method === 'DELETE') &&
      !isCsrfExempt(pathname)
    ) {
      var csrfCookie = getCsrfFromCookies(request);
      var csrfHeader = request.headers.get(CSRF_HEADER);

      if (!validateCsrfToken(csrfCookie, csrfHeader)) {
        console.warn('[middleware] CSRF inválido en', method, pathname);
        return new Response(
          JSON.stringify({ error: 'Token de seguridad inválido. Recarga la página e intenta de nuevo.' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // ── Sesión ────────────────────────────────────────────────────────────
    var token = context.cookies.get(SESSION_COOKIE)?.value || null;
    var session = token ? verifySessionToken(token) : null;

    // ── Validar IP si hay sesión activa ───────────────────────────────────
    if (session && session.iph) {
      var currentIp = getClientIp(request);
      var currentIpHash = hashIp(currentIp);

      if (session.iph !== currentIpHash) {
        console.warn('[middleware] IP cambió para sesión de', session.correo, '- sesión invalidada');
        var lang = pathname.split('/')[1] || 'es';
        var validLangs = ['es'];
        var safeLang = validLangs.includes(lang) ? lang : 'es';

        return new Response(null, {
          status: 302,
          headers: [
            ['Location', '/' + safeLang + '/login'],
            ['Set-Cookie', SESSION_COOKIE + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'],
            ['Set-Cookie', 'authSession=; Path=/; Max-Age=0; SameSite=Lax'],
          ],
        });
      }
    }

    // Exponer sesión a todas las páginas (null si no está loggeado)
    context.locals.user = session;
    context.locals.isAuthenticated = !!session;

    var lang = pathname.split('/')[1] || 'es';
    var validLangs = ['es'];
    var safeLang = validLangs.includes(lang) ? lang : 'es';

    // ── Sesión con cambio de contraseña obligatorio ───────────────────────
    if (session && session.mustChangePassword) {
      if (!isAllowedWhileForcePassword(pathname, safeLang)) {
        return context.redirect('/' + safeLang + '/mi-cuenta?tab=seguridad&forcePassword=1');
      }
    }

    // ── Si ya está loggeado, redirigir fuera de login/register ────────────
    if (session && (pathname.includes('/login') || pathname.includes('/register'))) {
      if (session.mustChangePassword) {
        return context.redirect('/' + safeLang + '/mi-cuenta?tab=seguridad&forcePassword=1');
      }
      return context.redirect('/' + safeLang + '/');
    }

    // ── Ruta protegida sin sesión → redirigir a login ─────────────────────
    // bypassProtectedForPublicCompany: rutas de registro de empresa son accesibles
    // sin sesión porque son flujos públicos de onboarding.
    // La seguridad se delega al propio endpoint (CSRF + ownership check).
    var bypassProtectedForPublicCompany = isPublicCompanyRoute(pathname);

    if (!session && isProtected(pathname) && !bypassProtectedForPublicCompany) {
      return context.redirect('/' + safeLang + '/login');
    }

    // ── Continuar y aplicar cabeceras de seguridad ────────────────────────
    var response = await next();
    response = addSecurityHeaders(response, cspNonce, { allowUnsafeInlineScript: !isAdminPage });
    response = ensureCsrfCookie(request, response, isProd);
    return response;

  } catch (error) {
    console.error('[middleware] Error:', error);
    context.locals.user = null;
    context.locals.isAuthenticated = false;
    var response = await next();
    response = addSecurityHeaders(response, cspNonce, { allowUnsafeInlineScript: !isAdminPage });
    return response;
  }
});