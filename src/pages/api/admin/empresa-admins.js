import { createClient } from "@libsql/client";
import "dotenv/config";
import { hashPassword } from "../../../lib/auth-utils.js";
import { sendCompanyApprovalCredentials } from "../../../lib/mail.js";
import { verifySessionToken, SESSION_COOKIE } from "../../../lib/session.js";

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

/** Uses the signed, HttpOnly go_session cookie — not the forgeable authSession. */
function getSessionUser(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
  } catch {
    return null;
  }
}

function normalizeRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (role === "superadmin" || role === "superuser") return "superusuario";
  return role;
}

async function ensurePasswordChangeSchema() {
  return true;
}

async function getCompanyIdForUser(userId) {
  const result = await db.execute({
    sql: `
      SELECT Id_Empresa
      FROM UsuarioEmpresa
      WHERE Id_Usuario = ? AND Activo = 1
      ORDER BY Id_UsuarioEmpresa DESC
      LIMIT 1
    `,
    args: [userId],
  });

  if (!result.rows.length) return null;
  const empresaId = Number(result.rows[0].Id_Empresa || 0);
  return Number.isFinite(empresaId) && empresaId > 0 ? empresaId : null;
}

async function resolveTargetCompanyId(session, requestUrl) {
  const role = normalizeRole(session?.rol);
  const userId = Number(session?.userId || 0);
  if (!userId || (role !== "admin" && role !== "superusuario")) return null;

  if (role === "superusuario") {
    const requested = Number(new URL(requestUrl).searchParams.get("empresaId") || 0);
    if (Number.isFinite(requested) && requested > 0) return requested;
  }

  return getCompanyIdForUser(userId);
}

export async function GET({ cookies, request }) {
  const session = getSessionUser(cookies);
  const role = normalizeRole(session?.rol);
  if (role !== "admin" && role !== "superusuario") {
    return json({ success: false, error: "Acceso denegado" }, 403);
  }

  try {
    const empresaId = await resolveTargetCompanyId(session, request.url);
    if (!empresaId) {
      return json({ success: true, empresa: null, admins: [] });
    }

    const empresaRes = await db.execute({
      sql: `SELECT Id_Empresa, Nombre_Empresa FROM Empresa WHERE Id_Empresa = ? LIMIT 1`,
      args: [empresaId],
    });

    const adminsRes = await db.execute({
      sql: `
        SELECT
          u.Id,
          u.Nombre,
          u.Apellido_Paterno,
          u.Apellido_Materno,
          u.Correo,
          u.Telefono,
          u.Rol,
          u.Fecha_Creacion,
          ue.Rol_Empresa,
          ue.Activo,
          ue.Fecha_Asignacion
        FROM UsuarioEmpresa ue
        JOIN Usuario u ON u.Id = ue.Id_Usuario
        WHERE ue.Id_Empresa = ?
          AND ue.Activo = 1
        ORDER BY ue.Id_UsuarioEmpresa DESC
      `,
      args: [empresaId],
    });

    const admins = adminsRes.rows.map((row) => ({
      id: Number(row.Id),
      nombre: String(row.Nombre || ""),
      apellidoPaterno: String(row.Apellido_Paterno || ""),
      apellidoMaterno: String(row.Apellido_Materno || ""),
      correo: String(row.Correo || ""),
      telefono: row.Telefono ? String(row.Telefono) : null,
      rolSistema: String(row.Rol || ""),
      rolEmpresa: String(row.Rol_Empresa || "Admin"),
      fechaAsignacion: row.Fecha_Asignacion ? String(row.Fecha_Asignacion) : null,
      fechaCreacion: row.Fecha_Creacion ? String(row.Fecha_Creacion) : null,
      activo: Number(row.Activo || 0) === 1,
    }));

    const empresa = empresaRes.rows.length
      ? {
          id: Number(empresaRes.rows[0].Id_Empresa),
          nombre: String(empresaRes.rows[0].Nombre_Empresa || "Empresa"),
        }
      : null;

    return json({ success: true, empresa, admins });
  } catch (error) {
    console.error("[GET /api/admin/empresa-admins] Error:", error);
    return json({ success: false, error: "Error obteniendo admins de empresa" }, 500);
  }
}

export async function POST({ cookies, request }) {
  const session = getSessionUser(cookies);
  const role = normalizeRole(session?.rol);
  if (role !== "admin" && role !== "superusuario") {
    return json({ success: false, error: "Acceso denegado" }, 403);
  }

  try {
    await ensurePasswordChangeSchema();

    const empresaId = await resolveTargetCompanyId(session, request.url);
    if (!empresaId) {
      return json({ success: false, error: "No se encontro empresa asociada" }, 400);
    }

    const empresaRes = await db.execute({
      sql: "SELECT Nombre_Empresa FROM Empresa WHERE Id_Empresa = ? LIMIT 1",
      args: [empresaId],
    });
    const empresaNombre = empresaRes.rows.length
      ? String(empresaRes.rows[0].Nombre_Empresa || "Tu empresa")
      : "Tu empresa";

    const body = await request.json().catch(() => ({}));
    const nombre = String(body?.nombre || "").trim();
    const apellidoPaterno = String(body?.apellidoPaterno || "").trim();
    const apellidoMaterno = String(body?.apellidoMaterno || "").trim();
    const correo = String(body?.correo || "").trim().toLowerCase();
    const telefono = String(body?.telefono || "").trim();
    const contrasena = String(body?.contrasena || "");
    const rolEmpresa = String(body?.rolEmpresa || "Admin").trim() || "Admin";

    if (!nombre || !apellidoPaterno || !correo || !contrasena) {
      return json({
        success: false,
        error: "Nombre, apellido paterno, correo y contrasena son obligatorios",
      }, 400);
    }

    if (contrasena.length < 8) {
      return json({ success: false, error: "La contrasena debe tener al menos 8 caracteres" }, 400);
    }

    const existing = await db.execute({
      sql: "SELECT Id FROM Usuario WHERE LOWER(Correo) = LOWER(?) LIMIT 1",
      args: [correo],
    });

    if (existing.rows.length) {
      return json({ success: false, error: "Ya existe un usuario con ese correo" }, 409);
    }

    const { hash, salt } = hashPassword(contrasena);
    const passwordHash = `${hash}:${salt}`;
    const nowIso = new Date().toISOString();

    const created = await db.execute({
      sql: `
        INSERT INTO Usuario
        (Nombre, Apellido_Paterno, Apellido_Materno, Correo, Contrasena, Rol, Telefono, Fecha_Creacion, Requires_Password_Change)
        VALUES (?, ?, ?, ?, ?, 'admin', ?, ?, 1)
      `,
      args: [
        nombre,
        apellidoPaterno,
        apellidoMaterno || null,
        correo,
        passwordHash,
        telefono || null,
        nowIso,
      ],
    });

    const newUserId = Number(created.lastInsertRowid || 0);
    if (!newUserId) {
      return json({ success: false, error: "No se pudo crear el admin" }, 500);
    }

    await db.execute({
      sql: `
        INSERT INTO UsuarioEmpresa
        (Id_Usuario, Id_Empresa, Rol_Empresa, Activo, Fecha_Asignacion)
        VALUES (?, ?, ?, 1, ?)
      `,
      args: [newUserId, empresaId, rolEmpresa, nowIso],
    });

    // Reutiliza la logica de correo existente para envío de credenciales.
    const loginUrl = `${process.env.APP_URL || "http://localhost:4321"}/es/login`;
    const mailResult = await sendCompanyApprovalCredentials({
      to: correo,
      empresa: empresaNombre,
      nombre: [nombre, apellidoPaterno].filter(Boolean).join(" "),
      correo,
      password: contrasena,
      loginUrl,
    }).catch((error) => ({ sent: false, reason: "MAIL_EXCEPTION", detail: String(error?.message || error) }));

    return json({
      success: true,
      message: "Admin de empresa creado",
      mail: {
        sent: Boolean(mailResult?.sent),
        reason: mailResult?.reason || null,
      },
      admin: {
        id: newUserId,
        nombre,
        apellidoPaterno,
        apellidoMaterno: apellidoMaterno || null,
        correo,
        telefono: telefono || null,
        rolSistema: "admin",
        rolEmpresa,
      },
    }, 201);
  } catch (error) {
    console.error("[POST /api/admin/empresa-admins] Error:", error);
    return json({ success: false, error: "Error creando admin de empresa" }, 500);
  }
}