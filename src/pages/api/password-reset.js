import { createClient } from "@libsql/client";
import bcrypt from "bcryptjs";
import { hashPassword } from "../../lib/auth-utils.js";
import { sendPasswordResetCode } from "../../lib/mail.js";

const db = createClient({
  url:       process.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN,
});

async function sendResetEmail({ to, nombre, code }) {
  const result = await sendPasswordResetCode({ to, code, name: nombre });
  if (!result?.sent) {
    const reason = result?.reason || "MAIL_SEND_FAILED";
    const detail = result?.detail || "No se pudo enviar el correo de recuperacion";
    throw new Error(`${reason}: ${detail}`);
  }
}

async function ensurePasswordChangeSchema() {
  return true;
}

// ── Handler principal ─────────────────────────────────────────
export async function POST({ request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body inválido.' }, 400);
  }

  const { action } = body;

  if (action === 'request')  return handleRequest(body);
  if (action === 'verify')   return handleVerify(body);
  if (action === 'confirm')  return handleConfirm(body);

  return json({ error: 'Acción no válida.' }, 400);
}

// ── STEP 1: request — envía el código ────────────────────────
async function handleRequest({ correo }) {
  if (!correo) return json({ error: 'Correo requerido.' }, 400);

  const ok = { success: true, message: 'Si el correo existe recibirás un código.' };

  try {
    const res = await db.execute({
      sql:  'SELECT Id, Nombre, Correo FROM Usuario WHERE Correo = ?',
      args: [correo.toLowerCase().trim()],
    });

    // Siempre responde igual para no revelar si existe el correo
    if (res.rows.length === 0) return json(ok);

    const user  = res.rows[0];
    const code  = String(Math.floor(100000 + Math.random() * 900000));
    // Guarda nuevo código con bcrypt solo para el código de verificación
    const codeHash = await bcrypt.hash(code, 10);
    const expira = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const ahora  = new Date().toISOString();

    // Invalida códigos anteriores
    await db.execute({
      sql:  'UPDATE PasswordResetCode SET Usado = 1 WHERE Id_Usuario = ? AND Usado = 0',
      args: [user.Id],
    });

    // Guarda nuevo código
    await db.execute({
      sql:  `INSERT INTO PasswordResetCode
               (Id_Usuario, Correo, CodigoHash, Expira_En, Usado, Intentos, Fecha_Creacion)
             VALUES (?, ?, ?, ?, 0, 0, ?)`,
      args: [user.Id, user.Correo, codeHash, expira, ahora],
    });

    await sendResetEmail({ to: user.Correo, nombre: user.Nombre, code });

    return json(ok);
  } catch (e) {
    console.error('reset/request error:', e);
    return json({ error: 'Error interno.' }, 500);
  }
}

// ── STEP 2: verify — valida el código ────────────────────────
async function handleVerify({ correo, codigo }) {
  if (!correo || !codigo) return json({ error: 'Datos incompletos.' }, 400);

  try {
    const res = await db.execute({
      sql:  `SELECT * FROM PasswordResetCode
             WHERE Correo = ? AND Usado = 0
             ORDER BY Fecha_Creacion DESC LIMIT 1`,
      args: [correo.toLowerCase().trim()],
    });

    if (res.rows.length === 0)
      return json({ error: 'Código inválido o expirado.' }, 400);

    const reset = res.rows[0];

    if (new Date() > new Date(reset.Expira_En)) {
      await db.execute({
        sql:  'UPDATE PasswordResetCode SET Usado = 1 WHERE Id_Reset = ?',
        args: [reset.Id_Reset],
      });
      return json({ error: 'El código expiró. Solicita uno nuevo.' }, 400);
    }

    if (reset.Intentos >= 5)
      return json({ error: 'Demasiados intentos. Solicita un nuevo código.' }, 429);

    const match = await bcrypt.compare(String(codigo), reset.CodigoHash);

    if (!match) {
      await db.execute({
        sql:  'UPDATE PasswordResetCode SET Intentos = Intentos + 1 WHERE Id_Reset = ?',
        args: [reset.Id_Reset],
      });
      return json({ error: 'Código incorrecto.' }, 400);
    }

    // Código válido — NO lo marcamos como usado aún, se usa en confirm
    return json({ success: true });
  } catch (e) {
    console.error('reset/verify error:', e);
    return json({ error: 'Error interno.' }, 500);
  }
}

// ── STEP 3: confirm — cambia la contraseña ───────────────────
async function handleConfirm({ correo, codigo, nuevaContrasena }) {
  if (!correo || !codigo || !nuevaContrasena)
    return json({ error: 'Datos incompletos.' }, 400);

  if (nuevaContrasena.length < 8)
    return json({ error: 'La contraseña debe tener al menos 8 caracteres.' }, 400);

  try {
    await ensurePasswordChangeSchema();

    const res = await db.execute({
      sql:  `SELECT * FROM PasswordResetCode
             WHERE Correo = ? AND Usado = 0
             ORDER BY Fecha_Creacion DESC LIMIT 1`,
      args: [correo.toLowerCase().trim()],
    });

    if (res.rows.length === 0)
      return json({ error: 'Código inválido o expirado.' }, 400);

    const reset = res.rows[0];

    if (new Date() > new Date(reset.Expira_En))
      return json({ error: 'El código expiró. Solicita uno nuevo.' }, 400);

    const match = await bcrypt.compare(String(codigo), reset.CodigoHash);
    if (!match) return json({ error: 'Código inválido.' }, 400);

    // Actualiza contraseña con el mismo sistema que usa el login (PBKDF2 hash:salt:iterations)
    const { hash: newHash, salt, iterations } = hashPassword(nuevaContrasena);
    await db.execute({
      sql:  'UPDATE Usuario SET Contrasena = ?, Requires_Password_Change = 0 WHERE Id = ?',
      args: [`${newHash}:${salt}:${iterations}`, reset.Id_Usuario],
    });

    // Marca el código como usado
    await db.execute({
      sql:  'UPDATE PasswordResetCode SET Usado = 1 WHERE Id_Reset = ?',
      args: [reset.Id_Reset],
    });

    return json({ success: true, message: 'Contraseña actualizada correctamente.' });
  } catch (e) {
    console.error('reset/confirm error:', e);
    return json({ error: 'Error interno.' }, 500);
  }
}

// ── Helper ────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}