import { createClient } from "@libsql/client";
import bcrypt from "bcryptjs";
import "dotenv/config";
import { hashPassword } from "../../../lib/auth-utils.js";
import { sendPasswordResetCode } from "../../../lib/mail.js";
import { maskPhone, sendSmsVerificationCode } from "../../../lib/sms.js";
import { verifySessionToken, createSessionToken, SESSION_COOKIE, DEFAULT_MAX_AGE } from "../../../lib/session.js";
import { getClientIp, checkRateLimitDistributed } from "../../../lib/rate-limit.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

const CODE_EXP_MINUTES = 15;
const MAX_ATTEMPTS = 5;

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

function maskEmail(email) {
  const value = String(email || "").trim();
  if (!value.includes("@")) return value;
  const [user, domain] = value.split("@");
  const start = user.slice(0, 2);
  const hidden = "*".repeat(Math.max(1, user.length - 2));
  return `${start}${hidden}@${domain}`;
}

async function ensureSecuritySchema() {
  return true;
}

async function getCurrentUser(userId) {
  await ensureSecuritySchema();
  const result = await db.execute({
    sql: `SELECT Id, Nombre, Correo, Telefono, COALESCE(TwoFactor_Enabled, 0) AS TwoFactor_Enabled, COALESCE(TwoFactor_Channel, 'email') AS TwoFactor_Channel
          FROM Usuario
          WHERE Id = ?
          LIMIT 1`,
    args: [userId],
  });

  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    id: Number(row.Id),
    nombre: String(row.Nombre || "Usuario"),
    correo: String(row.Correo || "").trim().toLowerCase(),
    telefono: String(row.Telefono || "").trim(),
    twoFactorEnabled: Number(row.TwoFactor_Enabled || 0) === 1,
    twoFactorChannel: String(row.TwoFactor_Channel || "email").toLowerCase() === "sms" ? "sms" : "email",
  };
}

async function saveSecurityCode({ userId, channel, destination, code, purpose = "password_change" }) {
  const now = new Date().toISOString();
  const expira = new Date(Date.now() + CODE_EXP_MINUTES * 60 * 1000).toISOString();
  const codeHash = await bcrypt.hash(String(code), 10);

  await db.execute({
    sql: `UPDATE UserSecurityCode
          SET Usado = 1
          WHERE Id_Usuario = ? AND Proposito = ? AND Usado = 0`,
    args: [userId, purpose],
  });

  await db.execute({
    sql: `INSERT INTO UserSecurityCode
          (Id_Usuario, Proposito, Canal, Destino, CodigoHash, Expira_En, Usado, Intentos, Fecha_Creacion)
          VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    args: [userId, purpose, channel, destination, codeHash, expira, now],
  });
}

async function getLatestCode(userId, purpose = "password_change") {
  const result = await db.execute({
    sql: `SELECT *
          FROM UserSecurityCode
          WHERE Id_Usuario = ? AND Proposito = ? AND Usado = 0
          ORDER BY Id_Code DESC
          LIMIT 1`,
    args: [userId, purpose],
  });

  return result.rows[0] || null;
}

export async function GET({ cookies }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);

  try {
    const user = await getCurrentUser(sessionUser.userId);
    if (!user) return json({ success: false, error: "Usuario no encontrado" }, 404);

    return json({
      success: true,
      security: {
        twoFactorEnabled: user.twoFactorEnabled,
        twoFactorChannel: user.twoFactorChannel,
        hasPhone: Boolean(user.telefono),
        maskedEmail: maskEmail(user.correo),
        maskedPhone: maskPhone(user.telefono),
      },
    });
  } catch (error) {
    console.error("[security/get] error:", error);
    return json({ success: false, error: "No se pudo cargar seguridad" }, 500);
  }
}

export async function POST({ cookies, request }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) return json({ success: false, error: "No autenticado" }, 401);
  const ip = getClientIp(request);

  const body = await request.json().catch(() => ({}));
  const action = String(body?.action || "").trim();

  try {
    const user = await getCurrentUser(sessionUser.userId);
    if (!user) return json({ success: false, error: "Usuario no encontrado" }, 404);

    if (action === "request-code") {
      const rlIp = await checkRateLimitDistributed("me-security-request-code-ip", ip, {
        maxRequests: 5,
        windowMs: 60 * 60 * 1000,
        blockMs: 60 * 60 * 1000,
      });
      if (rlIp.limited) {
        return json({ success: false, error: "Demasiadas solicitudes de código. Intenta más tarde." }, 429);
      }

      const rlUser = await checkRateLimitDistributed("me-security-request-code-user", String(user.id), {
        maxRequests: 6,
        windowMs: 60 * 60 * 1000,
        blockMs: 60 * 60 * 1000,
      });
      if (rlUser.limited) {
        return json({ success: false, error: "Demasiadas solicitudes de código para esta cuenta." }, 429);
      }

      const requested = String(body?.channel || "").toLowerCase();
      const channel = requested === "sms" ? "sms" : "email";
      const code = String(Math.floor(100000 + Math.random() * 900000));

      if (channel === "sms" && !user.telefono) {
        return json({ success: false, error: "No tienes telefono registrado para SMS." }, 400);
      }

      let sendResult;
      let destination;
      if (channel === "sms") {
        destination = user.telefono;
        sendResult = await sendSmsVerificationCode({ to: user.telefono, code, appName: "Grupo Ortiz" });
      } else {
        destination = user.correo;
        sendResult = await sendPasswordResetCode({ to: user.correo, code, name: user.nombre });
      }

      await saveSecurityCode({ userId: user.id, channel, destination, code });

      const maskedDestination = channel === "sms" ? maskPhone(destination) : maskEmail(destination);
      const payload = {
        success: true,
        message: `Codigo enviado por ${channel === "sms" ? "SMS" : "correo"}.`,
        channel,
        destination: maskedDestination,
      };

      if (!sendResult?.sent) {
        payload.warning = "No se pudo enviar con proveedor externo. Usa el codigo temporal.";
        if (process.env.NODE_ENV !== "production") payload.devCode = code;
      }

      return json(payload);
    }

    if (action === "confirm-password") {
      const rlIp = await checkRateLimitDistributed("me-security-confirm-password-ip", ip, {
        maxRequests: 10,
        windowMs: 60 * 60 * 1000,
        blockMs: 60 * 60 * 1000,
      });
      if (rlIp.limited) {
        return json({ success: false, error: "Demasiados intentos. Intenta más tarde." }, 429);
      }

      const rlUser = await checkRateLimitDistributed("me-security-confirm-password-user", String(user.id), {
        maxRequests: 10,
        windowMs: 60 * 60 * 1000,
        blockMs: 60 * 60 * 1000,
      });
      if (rlUser.limited) {
        return json({ success: false, error: "Demasiados intentos en tu cuenta. Intenta más tarde." }, 429);
      }

      const codigo = String(body?.codigo || "").trim();
      const nuevaContrasena = String(body?.nuevaContrasena || "");

      if (!codigo || !nuevaContrasena) {
        return json({ success: false, error: "Codigo y nueva contrasena son obligatorios." }, 400);
      }

      if (nuevaContrasena.length < 8) {
        return json({ success: false, error: "La contrasena debe tener al menos 8 caracteres." }, 400);
      }

      const latest = await getLatestCode(user.id);
      if (!latest) return json({ success: false, error: "No hay codigo activo. Solicita uno nuevo." }, 400);

      if (new Date() > new Date(latest.Expira_En)) {
        await db.execute({ sql: "UPDATE UserSecurityCode SET Usado = 1 WHERE Id_Code = ?", args: [latest.Id_Code] });
        return json({ success: false, error: "El codigo expiro. Solicita uno nuevo." }, 400);
      }

      if (Number(latest.Intentos || 0) >= MAX_ATTEMPTS) {
        return json({ success: false, error: "Demasiados intentos. Solicita un nuevo codigo." }, 429);
      }

      const isValid = await bcrypt.compare(codigo, String(latest.CodigoHash || ""));
      if (!isValid) {
        await db.execute({
          sql: "UPDATE UserSecurityCode SET Intentos = Intentos + 1 WHERE Id_Code = ?",
          args: [latest.Id_Code],
        });
        return json({ success: false, error: "Codigo incorrecto." }, 400);
      }

      const { hash, salt, iterations } = hashPassword(nuevaContrasena);
      await db.execute({
        sql: "UPDATE Usuario SET Contrasena = ?, Requires_Password_Change = 0 WHERE Id = ?",
        args: [`${hash}:${salt}:${iterations}`, user.id],
      });

      await db.execute({
        sql: "UPDATE UserSecurityCode SET Usado = 1 WHERE Id_Code = ?",
        args: [latest.Id_Code],
      });

      // Session fixation protection: rotate session token after password change
      const ip = getClientIp(request);
      const newToken = createSessionToken(
        {
          userId: user.id,
          correo: user.correo,
          nombre: user.nombre,
          apellidoPaterno: user.apellidoPaterno || '',
          rol: user.rol,
          mustChangePassword: false,
        },
        DEFAULT_MAX_AGE,
        ip,
      );
      const isProd = import.meta.env?.PROD || process.env.NODE_ENV === 'production';
      const newCookie = `${SESSION_COOKIE}=${encodeURIComponent(newToken)}; Path=/; Max-Age=${DEFAULT_MAX_AGE}; HttpOnly; SameSite=Lax${isProd ? '; Secure' : ''}`;

      return new Response(
        JSON.stringify({ success: true, message: "Contrasena actualizada correctamente." }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': newCookie,
          },
        },
      );
    }

    if (action === "update-2fa") {
      const enabled = Boolean(body?.enabled);
      const channel = String(body?.channel || "email").toLowerCase() === "sms" ? "sms" : "email";

      if (enabled && channel === "sms" && !user.telefono) {
        return json({ success: false, error: "Para 2 pasos por SMS necesitas registrar telefono." }, 400);
      }

      await db.execute({
        sql: "UPDATE Usuario SET TwoFactor_Enabled = ?, TwoFactor_Channel = ? WHERE Id = ?",
        args: [enabled ? 1 : 0, channel, user.id],
      });

      return json({
        success: true,
        message: enabled ? "Verificacion de 2 pasos activada." : "Verificacion de 2 pasos desactivada.",
      });
    }

    return json({ success: false, error: "Accion no valida." }, 400);
  } catch (error) {
    console.error("[security/post] error:", error);
    return json({ success: false, error: "Error interno de seguridad" }, 500);
  }
}
