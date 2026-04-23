import { createClient } from "@libsql/client";
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { 
  hashPassword, 
  validatePassword, 
  validateUserData 
} from '../../lib/auth-utils.js';
import { getClientIp, checkRateLimit } from '../../lib/rate-limit.js';
import { checkPwnedPassword } from '../../lib/pwned.js';
import { ensureEmailVerificationSchema } from '../../lib/auth-schema.js';
import { sendEmailVerification } from '../../lib/mail.js';

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN
});

function suggestEmailDomainFix(correo) {
  const value = String(correo || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at >= value.length - 1) return null;

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const commonTypos = {
    'gmal.com': 'gmail.com',
    'gmial.com': 'gmail.com',
    'gmai.com': 'gmail.com',
    'hotnail.com': 'hotmail.com',
    'hotmai.com': 'hotmail.com',
    'outlok.com': 'outlook.com',
    'outllok.com': 'outlook.com',
    'outloook.com': 'outlook.com',
    'outloo.com': 'outlook.com',
    'icloud.con': 'icloud.com',
    'yaho.com': 'yahoo.com',
  };

  const fixed = commonTypos[domain];
  if (!fixed) return null;
  return `${local}@${fixed}`;
}


export async function POST({ request }) {
  try {
    if (request.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Método no permitido' }),
        { status: 405, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── Rate limiting: max 5 registros por IP cada 15 min ─────────────────────
    const ip = getClientIp(request);
    const rl = checkRateLimit('register', ip, { maxRequests: 5, windowMs: 15 * 60 * 1000, blockMs: 30 * 60 * 1000 });
    if (rl.limited) {
      return new Response(
        JSON.stringify({ error: `Demasiados intentos de registro. Intenta en ${Math.ceil(rl.retryAfter / 60)} minutos.` }),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(rl.retryAfter) } }
      );
    }

    const formData = await request.formData();
    const userData = {
      nombre: formData.get('nombre'),
      apellido_paterno: formData.get('apellido_paterno'),
      apellido_materno: formData.get('apellido_materno') || null,
      correo: formData.get('correo'),
      contrasena: formData.get('contrasena'),
      telefono: formData.get('telefono') || null,
      numero_casa: formData.get('numero_casa'),
      calle: formData.get('calle'),
      codigo_postal: formData.get('codigo_postal'),
      ciudad: formData.get('ciudad'),
      provincia: formData.get('provincia'),
      pais: formData.get('pais') || 'Mexico'
    };

    const suggestedEmail = suggestEmailDomainFix(userData.correo);
    if (suggestedEmail) {
      return new Response(
        JSON.stringify({
          error: `El correo parece tener un typo. ¿Quisiste escribir ${suggestedEmail}?`,
          suggestedEmail,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const validationResult = validateUserData(userData);
    if (!validationResult.isValid) {
      return new Response(
        JSON.stringify({ 
          error: 'Datos inválidos',
          details: validationResult.errors 
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const passwordValidation = validatePassword(userData.contrasena);
    if (!passwordValidation.isValid) {
      return new Response(
        JSON.stringify({ 
          error: passwordValidation.message 
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // ── HaveIBeenPwned breach check ──
    // Block only very commonly breached passwords. Lower-count leaks are allowed
    // so users are not blocked aggressively while we still discourage weak choices.
    const minPwnedBlockCount = Math.max(
      1,
      Number(process.env.PWNED_PASSWORD_MIN_COUNT_BLOCK || import.meta.env?.PWNED_PASSWORD_MIN_COUNT_BLOCK || 100000)
    );
    const pwnedResult = await checkPwnedPassword(userData.contrasena);
    if (pwnedResult.pwned && Number(pwnedResult.count || 0) >= minPwnedBlockCount) {
      return new Response(
        JSON.stringify({
          error: `Esta contraseña ha aparecido en ${pwnedResult.count.toLocaleString()} filtraciones de datos conocidas. Elige una contraseña diferente.`,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (pwnedResult.pwned) {
      console.warn('[register] Password found in breach corpus but below enforcement threshold:', {
        count: Number(pwnedResult.count || 0),
        threshold: minPwnedBlockCount,
      });
    }

    const { hash, salt, iterations } = hashPassword(userData.contrasena);
    const contrasenactasalted = `${hash}:${salt}:${iterations}`;

    const fechaCreacion = new Date().toISOString();
    const rol = 'usuario';

    // Prepare email verification token
    await ensureEmailVerificationSchema(db);
    const verificationToken = randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    try {
      await db.execute({
        sql: `INSERT INTO Usuario 
              (Nombre, Apellido_Paterno, Apellido_Materno, Correo, Contrasena, Rol, Telefono, Fecha_Creacion)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          userData.nombre.trim(),
          userData.apellido_paterno.trim(),
          userData.apellido_materno ? userData.apellido_materno.trim() : null,
          userData.correo.toLowerCase().trim(),
          contrasenactasalted,
          rol,
          userData.telefono ? userData.telefono.trim() : null,
          fechaCreacion,
        ]
      });

      const createdUser = await db.execute({
        sql: `SELECT Id FROM Usuario WHERE LOWER(Correo) = LOWER(?) LIMIT 1`,
        args: [userData.correo.toLowerCase().trim()]
      });

      if (!createdUser.rows?.length) {
        throw new Error('No se pudo obtener el usuario creado');
      }

      const userId = createdUser.rows[0].Id;

      await db.execute({
        sql: `INSERT INTO UsuarioEmailAuth
              (Id_Usuario, Email_Verified, Email_Verification_Token, Email_Verification_Expires, Updated_At)
              VALUES (?, 0, ?, ?, ?)
              ON CONFLICT(Id_Usuario)
              DO UPDATE SET
                Email_Verified = excluded.Email_Verified,
                Email_Verification_Token = excluded.Email_Verification_Token,
                Email_Verification_Expires = excluded.Email_Verification_Expires,
                Updated_At = excluded.Updated_At`,
        args: [Number(userId), verificationToken, verificationExpires, new Date().toISOString()],
      });

      try {
        await db.execute({
          sql: `INSERT INTO Direccion
                (Id_Usuario, Nombre_Direccion, Numero_casa, Calle, Codigo_Postal, Ciudad, Provincia, Pais)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            userId,
            'Principal',
            Number(userData.numero_casa),
            userData.calle.trim(),
            Number(userData.codigo_postal),
            userData.ciudad.trim(),
            userData.provincia.trim(),
            userData.pais ? userData.pais.trim() : 'Mexico'
          ]
        });
      } catch (addressError) {
        await db.execute({
          sql: `DELETE FROM Usuario WHERE Id = ?`,
          args: [userId]
        });
        throw addressError;
      }

      // Send verification email (fire-and-forget — never block registration)
      const reqUrl = new URL(request.url);
      const siteUrl =
        process.env.SITE_URL ||
        import.meta.env?.SITE_URL ||
        request.headers.get('origin') ||
        `${reqUrl.protocol}//${reqUrl.host}` ||
        'http://localhost:4321';
      const verifyUrl = `${siteUrl}/api/verify-email?token=${verificationToken}`;
      const emailResult = await sendEmailVerification({
        to: userData.correo.toLowerCase().trim(),
        name: userData.nombre.trim(),
        verifyUrl,
      }).catch((err) => {
        console.error('[register] mail error:', err?.message);
        return { sent: false, reason: 'MAIL_EXCEPTION', detail: err?.message };
      });

      if (!emailResult?.sent) {
        console.error('[register] verification email failed:', {
          reason: emailResult?.reason,
          detail: emailResult?.detail,
        });
        return new Response(
          JSON.stringify({
            success: true,
            requiresEmailVerification: true,
            emailSent: false,
            message: 'Cuenta creada, pero no se pudo enviar el correo de verificación. Usa "Reenviar verificación" para intentarlo de nuevo.',
          }),
          {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      return new Response(
        JSON.stringify({ 
          success: true,
          requiresEmailVerification: true,
          emailSent: true,
          message: 'Registro exitoso. Revisa tu correo para verificar tu cuenta antes de iniciar sesión.',
        }),
        { 
          status: 201, 
          headers: { 'Content-Type': 'application/json' } 
        }
      );

    } catch (dbError) {
      console.error('Database error:', dbError);

      if (dbError.message && dbError.message.includes('UNIQUE constraint failed')) {
        return new Response(
          JSON.stringify({ 
            error: 'Este correo ya está registrado' 
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({ 
          error: 'Error al registrar usuario. Por favor, intenta más tarde' 
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

  } catch (error) {
    console.error('Register endpoint error:', error);
    
    return new Response(
      JSON.stringify({ 
        error: 'Error interno del servidor' 
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
