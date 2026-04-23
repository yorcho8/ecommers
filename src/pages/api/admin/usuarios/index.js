import { createClient } from "@libsql/client";
import "dotenv/config";
import { hashPassword } from "../../../../lib/auth-utils.js";
import { sendUserAccountCredentials } from "../../../../lib/mail.js";
import crypto from "crypto";
import { verifySessionToken, SESSION_COOKIE } from "../../../../lib/session.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Signed go_session — not the forgeable plain-JSON authSession cookie. */
function getPrivilegedUser(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const user = verifySessionToken(token);
    const role = String(user?.rol || "").toLowerCase();
    if (role === "admin" || role === "superusuario") return user;
    return null;
  } catch {
    return null;
  }
}

async function ensurePasswordChangeSchema() {
  return true;
}

function generateTemporaryPassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const syms = "@#$!%*?";
  const pick = (chars, n) => Array.from({ length: n }, () => chars[crypto.randomInt(0, chars.length)]).join("");
  const raw = pick(upper, 3) + pick(digits, 4) + pick(lower, 3) + pick(syms, 1);
  return raw.split("").sort(() => crypto.randomInt(0, 3) - 1).join("");
}

export async function GET({ cookies }) {
  const user = getPrivilegedUser(cookies);
  if (!user) return json({ success: false, error: "Acceso denegado" }, 403);

  try {
    const result = await db.execute(`
      SELECT
        u.Id,
        u.Nombre,
        u.Apellido_Paterno,
        u.Apellido_Materno,
        u.Correo,
        u.Rol,
        u.Telefono,
        u.Fecha_Creacion,
        (
          SELECT d.Numero_casa
          FROM Direccion d
          WHERE d.Id_Usuario = u.Id
          ORDER BY d.Id_Direccion DESC
          LIMIT 1
        ) AS NumeroCasa,
        (
          SELECT d.Calle
          FROM Direccion d
          WHERE d.Id_Usuario = u.Id
          ORDER BY d.Id_Direccion DESC
          LIMIT 1
        ) AS Calle,
        (
          SELECT d.Codigo_Postal
          FROM Direccion d
          WHERE d.Id_Usuario = u.Id
          ORDER BY d.Id_Direccion DESC
          LIMIT 1
        ) AS CodigoPostal,
        (
          SELECT d.Ciudad
          FROM Direccion d
          WHERE d.Id_Usuario = u.Id
          ORDER BY d.Id_Direccion DESC
          LIMIT 1
        ) AS Ciudad,
        (
          SELECT d.Provincia
          FROM Direccion d
          WHERE d.Id_Usuario = u.Id
          ORDER BY d.Id_Direccion DESC
          LIMIT 1
        ) AS Provincia,
        (
          SELECT d.Pais
          FROM Direccion d
          WHERE d.Id_Usuario = u.Id
          ORDER BY d.Id_Direccion DESC
          LIMIT 1
        ) AS Pais
      FROM Usuario u
      ORDER BY u.Fecha_Creacion DESC, u.Id DESC
    `);

    const usuarios = result.rows.map((row) => ({
      id: row.Id,
      nombre: row.Nombre,
      apellidoPaterno: row.Apellido_Paterno,
      apellidoMaterno: row.Apellido_Materno,
      correo: row.Correo,
      rol: row.Rol,
      telefono: row.Telefono,
      fechaCreacion: row.Fecha_Creacion,
      numeroCasa: row.NumeroCasa,
      calle: row.Calle,
      codigoPostal: row.CodigoPostal,
      ciudad: row.Ciudad,
      provincia: row.Provincia,
      pais: row.Pais || 'Mexico',
    }));

    return json({ success: true, usuarios });
  } catch (error) {
    console.error("[GET /api/admin/usuarios] Error:", error);
    return json({ success: false, error: "Error obteniendo usuarios" }, 500);
  }
}

export async function POST({ request, cookies }) {
  const user = getPrivilegedUser(cookies);
  if (!user) return json({ success: false, error: "Acceso denegado" }, 403);

  try {
    await ensurePasswordChangeSchema();

    const body = await request.json().catch(() => ({}));
    const nombre = String(body?.nombre || "").trim();
    const apellidoPaterno = String(body?.apellidoPaterno || "").trim();
    const apellidoMaterno = String(body?.apellidoMaterno || "").trim();
    const correo = String(body?.correo || "").trim().toLowerCase();
    const rol = String(body?.rol || "usuario").trim().toLowerCase();
    const telefono = String(body?.telefono || "").trim();
    const contrasenaInput = String(body?.contrasena || "").trim();
    const numeroCasa = Number(body?.numeroCasa);
    const calle = String(body?.calle || "").trim();
    const codigoPostal = Number(body?.codigoPostal);
    const ciudad = String(body?.ciudad || "").trim();
    const provincia = String(body?.provincia || "").trim();
    const pais = String(body?.pais || "Mexico").trim();

    const rolesValidos = ["usuario", "admin", "superusuario"];

    if (!nombre || !apellidoPaterno || !correo) {
      return json({ success: false, error: "Nombre, apellido paterno y correo son obligatorios" }, 400);
    }

    if (!rolesValidos.includes(rol)) {
      return json({ success: false, error: "Rol invalido" }, 400);
    }

    if (!Number.isFinite(numeroCasa) || numeroCasa < 0 || !calle || !Number.isFinite(codigoPostal) || codigoPostal <= 0 || !ciudad || !provincia || !pais) {
      return json({ success: false, error: "Direccion incompleta o invalida" }, 400);
    }

    const existing = await db.execute({
      sql: "SELECT Id FROM Usuario WHERE LOWER(Correo) = LOWER(?) LIMIT 1",
      args: [correo],
    });

    if (existing.rows.length) {
      return json({ success: false, error: "El correo ya existe" }, 409);
    }

    const plainPassword = contrasenaInput || generateTemporaryPassword();
    const { hash, salt } = hashPassword(plainPassword);
    const contrasenaHash = `${hash}:${salt}`;

    await db.execute({
      sql: `INSERT INTO Usuario
            (Nombre, Apellido_Paterno, Apellido_Materno, Correo, Contrasena, Rol, Telefono, Fecha_Creacion, Requires_Password_Change)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      args: [
        nombre,
        apellidoPaterno,
        apellidoMaterno || null,
        correo,
        contrasenaHash,
        rol,
        telefono || null,
        new Date().toISOString(),
      ],
    });

    const created = await db.execute({
      sql: "SELECT Id FROM Usuario WHERE LOWER(Correo) = LOWER(?) LIMIT 1",
      args: [correo],
    });

    if (!created.rows.length) {
      return json({ success: false, error: "No se pudo recuperar usuario creado" }, 500);
    }

    const userId = created.rows[0].Id;

    try {
      await db.execute({
        sql: `INSERT INTO Direccion
              (Id_Usuario, Numero_casa, Calle, Codigo_Postal, Ciudad, Provincia, Pais)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [userId, numeroCasa, calle, codigoPostal, ciudad, provincia, pais],
      });
    } catch (addressError) {
      await db.execute({ sql: "DELETE FROM Usuario WHERE Id = ?", args: [userId] });
      throw addressError;
    }

    const loginUrl = `${process.env.APP_URL || "http://localhost:4321"}/es/login`;
    const mailResult = await sendUserAccountCredentials({
      to: correo,
      nombre: `${nombre} ${apellidoPaterno}`.trim(),
      correo,
      password: plainPassword,
      rol,
      loginUrl,
    }).catch((error) => ({ sent: false, reason: "MAIL_EXCEPTION", detail: String(error?.message || error) }));

    return json({
      success: true,
      message: "Usuario creado",
      mail: {
        sent: Boolean(mailResult?.sent),
        reason: mailResult?.reason || null,
      },
    }, 201);
  } catch (error) {
    console.error("[POST /api/admin/usuarios] Error:", error);
    return json({ success: false, error: "Error creando usuario" }, 500);
  }
}
