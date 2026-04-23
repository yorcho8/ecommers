import { createClient } from "@libsql/client";
import { verifyPassword, hashPassword } from '../../lib/auth-utils.js';
import { decryptPassword } from '../../lib/crypto';
import { cleanEmail, cleanInput } from '../../lib/sanitize';
import {
  getClientIp,
  isBlockedDistributed,
  recordFailedAttemptDistributed,
  clearAttemptsDistributed,
  getAttemptCountDistributed,
} from '../../lib/rate-limit';
import {
  createSessionToken,
  SESSION_COOKIE,
  DEFAULT_MAX_AGE,
} from '../../lib/session';
import { validateCaptcha } from '../../lib/captcha.js';
import { ensureTotpSchema, ensureEmailVerificationSchema, logLoginActivity } from '../../lib/auth-schema.js';

var db = createClient({
  url: import.meta.env.ECOMERS_DATABASE_URL || process.env.ECOMERS_DATABASE_URL,
  authToken: import.meta.env.ECOMERS_AUTH_TOKEN || process.env.ECOMERS_AUTH_TOKEN,
});

async function ensurePasswordChangeSchema() {
  return true;
}

function buildCookieHeader(name, value, options) {
  var parts = [name + '=' + encodeURIComponent(value)];
  if (options.path)     parts.push('Path=' + options.path);
  if (options.maxAge)   parts.push('Max-Age=' + options.maxAge);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure)   parts.push('Secure');
  if (options.sameSite) parts.push('SameSite=' + options.sameSite);
  return parts.join('; ');
}

function isHtmlNavigationRequest(request) {
  var mode = String(request.headers.get('sec-fetch-mode') || '').toLowerCase();
  if (mode === 'navigate') return true;
  var accept = String(request.headers.get('accept') || '').toLowerCase();
  return accept.includes('text/html');
}

function resolveLoginPath(request) {
  try {
    var ref = request.headers.get('referer');
    if (ref) {
      var url = new URL(ref);
      if (/\/login\/?$/i.test(url.pathname)) {
        return url.pathname.replace(/\/$/, '') || '/es/login';
      }
      var lang = (url.pathname.split('/')[1] || 'es').toLowerCase();
      return '/' + (lang || 'es') + '/login';
    }
  } catch (_) {}
  return '/es/login';
}

function redirectResponse(location, options) {
  var headers = new Headers();
  headers.set('Location', location);
  if (options?.retryAfter) headers.set('Retry-After', String(options.retryAfter));
  var cookies = options?.setCookies || [];
  cookies.forEach(function(cookie) { headers.append('Set-Cookie', cookie); });
  return new Response(null, { status: 303, headers: headers });
}

// ── Merge carrito guest → usuario ────────────────────────────────────────────
async function mergeGuestCart(userId, guestId) {
  if (!guestId) return;

  try {
    // Buscar carrito del guest
    const guestCart = await db.execute({
      sql: `SELECT Id_Carrito FROM Carrito WHERE Guest_Id = ? LIMIT 1`,
      args: [guestId],
    });
    if (!guestCart.rows.length) return;
    const guestCartId = Number(guestCart.rows[0].Id_Carrito);

    // Obtener items del guest
    const guestItems = await db.execute({
      sql: `SELECT Id_Producto, Id_Variante, Cantidad, Precio_Unitario FROM ItemCarrito WHERE Id_Carrito = ?`,
      args: [guestCartId],
    });
    if (!guestItems.rows.length) return;

    // Obtener o crear carrito del usuario
    let userCartId;
    const userCart = await db.execute({
      sql: `SELECT Id_Carrito FROM Carrito WHERE Id_Usuario = ? LIMIT 1`,
      args: [userId],
    });
    if (userCart.rows.length) {
      userCartId = Number(userCart.rows[0].Id_Carrito);
    } else {
      await db.execute({
        sql: `INSERT INTO Carrito (Id_Usuario, Fecha_Creacion) VALUES (?, ?)`,
        args: [userId, new Date().toISOString()],
      });
      const created = await db.execute({
        sql: `SELECT Id_Carrito FROM Carrito WHERE Id_Usuario = ? ORDER BY Id_Carrito DESC LIMIT 1`,
        args: [userId],
      });
      userCartId = Number(created.rows[0].Id_Carrito);
    }

    // Fusionar cada item del guest en el carrito del usuario
    const now = new Date().toISOString();
    for (const item of guestItems.rows) {
      const prodId     = Number(item.Id_Producto);
      const varId      = item.Id_Variante ? Number(item.Id_Variante) : null;
      const cantidad   = Number(item.Cantidad);
      const precio     = Number(item.Precio_Unitario);

      // ¿Ya existe ese producto+variante en el carrito del usuario?
      const existing = await db.execute({
        sql: `SELECT id_Item_Carrito, Cantidad FROM ItemCarrito
              WHERE Id_Carrito = ? AND Id_Producto = ?
                AND (Id_Variante IS ? OR Id_Variante = ?)
              LIMIT 1`,
        args: [userCartId, prodId, varId, varId],
      });

      if (existing.rows.length) {
        // Sumar cantidades
        const newQty = Number(existing.rows[0].Cantidad) + cantidad;
        await db.execute({
          sql: `UPDATE ItemCarrito SET Cantidad = ?, Fecha = ? WHERE id_Item_Carrito = ?`,
          args: [newQty, now, existing.rows[0].id_Item_Carrito],
        });
      } else {
        // Insertar nuevo item
        await db.execute({
          sql: `INSERT INTO ItemCarrito (Id_Carrito, Id_Producto, Id_Variante, Cantidad, Precio_Unitario, Fecha)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [userCartId, prodId, varId, cantidad, precio, now],
        });
      }
    }

    // Eliminar carrito guest (ya no se necesita)
    await db.execute({
      sql: `DELETE FROM Carrito WHERE Id_Carrito = ?`,
      args: [guestCartId],
    });

    console.log(`[login] Carrito guest ${guestId} fusionado con usuario ${userId}`);
  } catch (err) {
    // No romper el login si el merge falla
    console.error('[login] Error al fusionar carrito guest:', err);
  }
}

export async function POST({ request }) {
  var ip = getClientIp(request);
  var userAgent = request.headers.get('user-agent') || '';
  var loginNamespace = 'login-fail';
  var loginWindowMs = 10 * 60 * 1000;
  var loginBlockMs = 15 * 60 * 1000;
  var loginMaxAttempts = 6;
  var htmlNavigation = isHtmlNavigationRequest(request);
  var loginPath = resolveLoginPath(request);

  try {
    // ── Hard block (too many failures) ──
    var blockCheck = await isBlockedDistributed(loginNamespace, ip, { blockMs: loginBlockMs });
    if (blockCheck.blocked) {
      if (htmlNavigation) {
        return redirectResponse(loginPath + '?loginError=blocked', { retryAfter: blockCheck.retryAfter });
      }
      return new Response(
        JSON.stringify({
          error: 'Demasiados intentos fallidos. Intenta de nuevo en ' + Math.ceil(blockCheck.retryAfter / 60) + ' minutos.',
          requiresCaptcha: true,
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(blockCheck.retryAfter),
          },
        }
      );
    }

    var formData = await request.formData();
    var correoRaw = formData.get('correo');
    var contrasenaRaw = formData.get('contrasena');
    var correo = cleanEmail(correoRaw || '');

    // ── CAPTCHA check — required after 3 failed attempts ──
    var CAPTCHA_THRESHOLD = 3;
    var attemptCount = await getAttemptCountDistributed(loginNamespace, ip, { windowMs: loginWindowMs });
    if (attemptCount >= CAPTCHA_THRESHOLD) {
      var captchaToken = String(formData.get('captchaToken') || '');
      var captchaResult = await validateCaptcha(captchaToken, ip);
      if (!captchaResult.valid) {
        if (htmlNavigation) {
          return redirectResponse(loginPath + '?loginError=blocked');
        }
        return new Response(
          JSON.stringify({
            error: 'Por favor completa la verificación de seguridad.',
            requiresCaptcha: true,
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // Leer cookie guestCartId del request
    var cookieHeader = request.headers.get('cookie') || '';
    var guestIdMatch = cookieHeader.match(/guestCartId=([^;]+)/);
    var guestId = guestIdMatch ? decodeURIComponent(guestIdMatch[1]) : null;

    if (!correo || !contrasenaRaw) {
      if (htmlNavigation) {
        return redirectResponse(loginPath + '?loginError=missing');
      }
      return new Response(
        JSON.stringify({ error: 'Correo y contraseña son requeridos' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Desencriptar contraseña RSA (con fallback)
    var contrasena;
    try {
      contrasena = decryptPassword(contrasenaRaw);
    } catch (err) {
      contrasena = contrasenaRaw;
    }

    await ensurePasswordChangeSchema();
    await ensureEmailVerificationSchema(db);

    // Buscar usuario
    var usuario = null;
    try {
      var result = await db.execute({
        sql: `SELECT u.Id, u.Nombre, u.Apellido_Paterno, u.Apellido_Materno, u.Correo, u.Contrasena, u.Rol, u.Telefono, u.Fecha_Creacion,
                     COALESCE(u.Requires_Password_Change, 0) AS Requires_Password_Change,
                     COALESCE(e.Email_Verified, 1) AS Email_Verified
              FROM Usuario u
              LEFT JOIN UsuarioEmailAuth e ON e.Id_Usuario = u.Id
              WHERE LOWER(u.Correo) = LOWER(?)`,
        args: [correo.trim()]
      });
      if (result.rows && result.rows.length > 0) {
        usuario = result.rows[0];
      }
    } catch (dbError) {
      console.error('[api/login] Database error:', dbError);
      if (htmlNavigation) {
        return redirectResponse(loginPath + '?loginError=server');
      }
      return new Response(
        JSON.stringify({ error: 'Error al verificar credenciales' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!usuario) {
      await recordFailedAttemptDistributed(loginNamespace, ip, {
        maxAttempts: loginMaxAttempts,
        windowMs: loginWindowMs,
        blockMs: loginBlockMs,
      });
      var attemptsAfterMiss = await getAttemptCountDistributed(loginNamespace, ip, { windowMs: loginWindowMs });
      await logLoginActivity(db, { userId: null, ip, userAgent, success: false, reason: 'user_not_found' });
      if (htmlNavigation) {
        return redirectResponse(loginPath + '?loginError=invalid');
      }
      return new Response(
        JSON.stringify({
          error: 'Correo o contraseña incorrectos',
          requiresCaptcha: attemptsAfterMiss >= CAPTCHA_THRESHOLD,
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Verificar contraseña
    // Formato almacenado: "{hash}:{salt}" (legado, 1000 iter) o "{hash}:{salt}:{iterations}" (nuevo)
    var hashedPassword = usuario.Contrasena;
    var splitParts = hashedPassword.split(':');
    var hash = splitParts[0];
    var salt = splitParts[1];
    var storedIterations = splitParts[2] ? parseInt(splitParts[2], 10) : 1000;

    if (!hash || !salt) {
      if (htmlNavigation) {
        return redirectResponse(loginPath + '?loginError=server');
      }
      return new Response(
        JSON.stringify({ error: 'Error al verificar credenciales' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    var isPasswordValid = verifyPassword(contrasena, hash, salt, storedIterations);

    if (!isPasswordValid) {
      await recordFailedAttemptDistributed(loginNamespace, ip, {
        maxAttempts: loginMaxAttempts,
        windowMs: loginWindowMs,
        blockMs: loginBlockMs,
      });
      var attemptsAfterWrongPassword = await getAttemptCountDistributed(loginNamespace, ip, { windowMs: loginWindowMs });
      await logLoginActivity(db, { userId: usuario.Id, ip, userAgent, success: false, reason: 'wrong_password' });
      if (htmlNavigation) {
        return redirectResponse(loginPath + '?loginError=invalid');
      }
      return new Response(
        JSON.stringify({
          error: 'Correo o contraseña incorrectos',
          requiresCaptcha: attemptsAfterWrongPassword >= CAPTCHA_THRESHOLD,
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── Upgrade hash silencioso: re-hash contraseñas antiguas (1000 iter) a 100k ──
    if (storedIterations < 100000) {
      try {
        var rehash = hashPassword(contrasena);
        await db.execute({
          sql: `UPDATE Usuario SET Contrasena = ? WHERE Id = ?`,
          args: [`${rehash.hash}:${rehash.salt}:${rehash.iterations}`, usuario.Id],
        });
      } catch (rehashErr) {
        // Non-critical: log but don't block login
        console.warn('[login] No se pudo actualizar el hash de contraseña:', rehashErr);
      }
    }

    // ── Email verification check ──
    if (Number(usuario.Email_Verified ?? 1) === 0) {
      await logLoginActivity(db, { userId: usuario.Id, ip, userAgent, success: false, reason: 'email_not_verified' });
      if (htmlNavigation) {
        return redirectResponse(loginPath + '?loginError=verify-email');
      }
      return new Response(
        JSON.stringify({
          error: 'Verifica tu correo electrónico antes de iniciar sesión.',
          requiresEmailVerification: true,
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── TOTP 2FA check ──
    await ensureTotpSchema(db);
    var totpRow = await db.execute({
      sql: `SELECT Enabled FROM UsuarioTOTP WHERE Id_Usuario = ? LIMIT 1`,
      args: [usuario.Id],
    });
    if (totpRow.rows.length && Number(totpRow.rows[0].Enabled) === 1) {
      // Issue a short-lived temp token — client must complete verify-2fa
      var tempToken = createSessionToken(
        {
          userId: usuario.Id,
          type: '2fa_pending',
          correo: usuario.Correo,
          nombre: usuario.Nombre,
          apellidoPaterno: usuario.Apellido_Paterno,
          rol: usuario.Rol,
        },
        5 * 60, // 5 minutes
        ip,
      );
      await logLoginActivity(db, { userId: usuario.Id, ip, userAgent, success: false, reason: '2fa_pending' });
      if (htmlNavigation) {
        return redirectResponse(loginPath + '?loginError=2fa');
      }
      return new Response(
        JSON.stringify({ requires2fa: true, tempToken }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── Login exitoso ──
    await clearAttemptsDistributed(loginNamespace, ip);

    // Log successful login
    await logLoginActivity(db, { userId: usuario.Id, ip, userAgent, success: true });

    // Fusionar carrito guest → usuario (si existe)
    await mergeGuestCart(Number(usuario.Id), guestId);

    var token = createSessionToken(
      {
        userId: usuario.Id,
        correo: usuario.Correo,
        nombre: usuario.Nombre,
        apellidoPaterno: usuario.Apellido_Paterno,
        rol: usuario.Rol,
        mustChangePassword: Number(usuario.Requires_Password_Change || 0) === 1,
      },
      DEFAULT_MAX_AGE,
      ip,
    );

    var isProd = import.meta.env.PROD;

    var secureCookie = buildCookieHeader(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'Lax',
      path: '/',
      maxAge: DEFAULT_MAX_AGE,
    });

    var publicSessionData = JSON.stringify({
      userId: usuario.Id,
      correo: cleanInput(usuario.Correo || ''),
      nombre: cleanInput(usuario.Nombre || ''),
      rol: cleanInput(usuario.Rol || ''),
      mustChangePassword: Number(usuario.Requires_Password_Change || 0) === 1,
      timestamp: Date.now(),
    });

    var publicCookie = buildCookieHeader('authSession', publicSessionData, {
      httpOnly: false,
      secure: isProd,
      sameSite: 'Lax',
      path: '/',
      maxAge: DEFAULT_MAX_AGE,
    });

    // Expirar la cookie guestCartId (ya no se necesita)
    var expireGuestCookie = buildCookieHeader('guestCartId', '', {
      path: '/',
      maxAge: 0,
      sameSite: 'Lax',
    });

    var headers = new Headers();
    headers.append('Content-Type', 'application/json');
    headers.append('Set-Cookie', secureCookie);
    headers.append('Set-Cookie', publicCookie);
    headers.append('Set-Cookie', expireGuestCookie);

    if (htmlNavigation) {
      var nextLocation = Number(usuario.Requires_Password_Change || 0) === 1
        ? '/es/mi-cuenta?tab=seguridad&forcePassword=1'
        : '/es/';
      return redirectResponse(nextLocation, {
        setCookies: [secureCookie, publicCookie, expireGuestCookie],
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Inicio de sesión exitoso',
        mustChangePassword: Number(usuario.Requires_Password_Change || 0) === 1,
        redirectTo: Number(usuario.Requires_Password_Change || 0) === 1 ? '/es/mi-cuenta?tab=seguridad&forcePassword=1' : '/es/',
        user: {
          id: usuario.Id,
          nombre: cleanInput(usuario.Nombre || ''),
          apellidoPaterno: cleanInput(usuario.Apellido_Paterno || ''),
          correo: cleanInput(usuario.Correo || ''),
          rol: cleanInput(usuario.Rol || ''),
        },
      }),
      { status: 200, headers: headers }
    );

  } catch (error) {
    console.error('[api/login] Error:', error);
    if (htmlNavigation) {
      return redirectResponse(loginPath + '?loginError=server');
    }
    return new Response(
      JSON.stringify({ error: 'Error interno del servidor' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}