import { createClient } from "@libsql/client";
import "dotenv/config";
import { hashPassword } from "../../../../lib/auth-utils.js";
import { ensureEmpresaRegistrationSchema } from "../../../../lib/empresa-schema.js";
import {
  ensureEmpresaKycSchema,
  ensureInitialKycForSolicitud,
  getSolicitudKyc,
} from "../../../../lib/empresa-kyc.js";
import {
  ensureEmpresaBiometriaSchema,
  getSolicitudBiometriaMeta,
} from "../../../../lib/empresa-biometria.js";
import {
  sendCompanyApprovalCredentials,
  sendNewEmpresaSolicitudAlert,
} from "../../../../lib/mail.js";
import { getSessionFromCookies, normalizeRole } from "../../../../lib/session.js";
import crypto from "crypto";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

let schemaInitPromise = null;

const SUPER_KEY = process.env.SUPER_ADMIN_KEY || "GOSUPER2026";
const REQUIRED_DOC_TYPES = ["ACTA_CONSTITUTIVA", "INE_REPRESENTANTE", "CONSTANCIA_FISCAL"];

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function checkAuth(request, cookies) {
  const key = request.headers.get("x-admin-key");
  if (key === SUPER_KEY) return true;
  const session = getSessionFromCookies(cookies);
  return normalizeRole(session?.rol) === "superusuario";
}

function getSessionUser(cookies) {
  return getSessionFromCookies(cookies);
}

function generatePassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const syms = "@#$!%*?";
  const pick = (str, n) =>
    Array.from({ length: n }, () => str[crypto.randomInt(0, str.length)]).join("");
  const raw = pick(upper, 3) + pick(digits, 4) + pick(lower, 3) + pick(syms, 1);
  return raw.split("").sort(() => crypto.randomInt(0, 3) - 1).join("");
}

function asText(value, max = 255) {
  if (value == null) return "";
  return String(value).trim().slice(0, max);
}

function asPositiveInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

async function ensureSchema() {
  return true;
}

async function ensureSchemaReady() {
  if (!schemaInitPromise) {
    schemaInitPromise = ensureSchema().catch((error) => {
      schemaInitPromise = null;
      throw error;
    });
  }
  return schemaInitPromise;
}

function validateRequestBody(body) {
  const errors = [];

  if (!asText(body?.nombre_empresa)) errors.push("Nombre de empresa requerido");
  if (!asText(body?.admin_nombre))   errors.push("Nombre del administrador requerido");
  if (!asText(body?.admin_apellido)) errors.push("Apellido del administrador requerido");
  if (!asText(body?.admin_correo))   errors.push("Correo del administrador requerido");

  // Datos fiscales
  if (!asText(body?.razon_social))         errors.push("Razón social requerida");
  if (!asText(body?.regimen_fiscal))        errors.push("Régimen fiscal requerido");
  const cp = asText(body?.codigo_postal_fiscal);
  if (!cp || !/^\d{5}$/.test(cp))          errors.push("Código postal fiscal inválido (5 dígitos)");

  // Dirección
  if (!asPositiveInt(body?.numero_casa))   errors.push("Número de casa requerido");
  if (!asText(body?.calle, 220))           errors.push("Calle requerida");
  if (!asPositiveInt(body?.codigo_postal)) errors.push("Código postal requerido");
  if (!asText(body?.ciudad, 120))          errors.push("Ciudad requerida");
  if (!asText(body?.provincia, 120))       errors.push("Provincia requerida");

  // Documentos
  const docs = Array.isArray(body?.documentos) ? body.documentos : [];
  const map = new Map();
  for (const doc of docs) {
    const tipo = asText(doc?.tipo).toUpperCase();
    const url  = asText(doc?.url);
    if (tipo && url) map.set(tipo, doc);
  }
  for (const tipo of REQUIRED_DOC_TYPES) {
    if (!map.has(tipo)) errors.push("Documento faltante: " + tipo);
  }

  return { errors, docsByType: map };
}

async function createSolicitud(body) {
  const now              = new Date().toISOString();
  const numeroCasa       = asPositiveInt(body?.numero_casa);
  const codigoPostal     = asPositiveInt(body?.codigo_postal);
  const calle            = asText(body?.calle, 220);
  const ciudad           = asText(body?.ciudad, 120);
  const provincia        = asText(body?.provincia, 120);
  const pais             = asText(body?.pais || "México", 80) || "México";
  const nombreDireccion  = asText(body?.nombre_direccion || "Domicilio principal de recolección", 120);
  const nombreSucursal   = asText(body?.nombre_sucursal  || "Sucursal principal", 160);
  const telefonoSucursal = asText(body?.telefono_sucursal, 40);
  const razonSocial      = asText(body?.razon_social, 255).toUpperCase();
  const regimenFiscal    = asText(body?.regimen_fiscal, 10);
  const cpFiscal         = asText(body?.codigo_postal_fiscal, 5);

  const insertRes = await db.execute({
    sql: `INSERT INTO EmpresaSolicitud
          (Nombre_Empresa, RFC, Descripcion, Logo_URL, Sitio_Web,
           Razon_Social, Regimen_Fiscal, Codigo_Postal_Fiscal,
           Domicilio_Numero_Casa, Domicilio_Calle, Domicilio_Codigo_Postal,
           Domicilio_Ciudad, Domicilio_Provincia, Domicilio_Pais, Domicilio_Nombre,
           Sucursal_Nombre, Sucursal_Telefono,
           Admin_Nombre, Admin_Apellido, Admin_Apellido_Materno,
           Admin_Correo, Admin_Telefono,
           Documentos_JSON, Estado, Fecha_Solicitud)
          VALUES (?,?,?,?,?, ?,?,?, ?,?,?,?,?,?,?, ?,?, ?,?,?,?,?, ?,?,?)`,
    args: [
      asText(body.nombre_empresa),
      asText(body.rfc) || null,
      asText(body.descripcion) || null,
      asText(body.logo_url) || null,
      asText(body.sitio_web) || null,
      razonSocial || null,
      regimenFiscal || null,
      cpFiscal || null,
      numeroCasa,
      calle,
      codigoPostal,
      ciudad,
      provincia,
      pais,
      nombreDireccion,
      nombreSucursal,
      telefonoSucursal || null,
      asText(body.admin_nombre),
      asText(body.admin_apellido),
      asText(body.admin_apellido_materno) || null,
      asText(body.admin_correo).toLowerCase(),
      asText(body.admin_telefono) || null,
      JSON.stringify(Array.isArray(body.documentos) ? body.documentos : []),
      "pendiente",
      now,
    ],
  });

  const solicitudId = Number(insertRes.lastInsertRowid);
  await ensureInitialKycForSolicitud(db, solicitudId, "mock");

  return solicitudId;
}

async function updateSolicitudPendiente(solicitudId, body) {
  const now              = new Date().toISOString();
  const numeroCasa       = asPositiveInt(body?.numero_casa);
  const codigoPostal     = asPositiveInt(body?.codigo_postal);
  const calle            = asText(body?.calle, 220);
  const ciudad           = asText(body?.ciudad, 120);
  const provincia        = asText(body?.provincia, 120);
  const pais             = asText(body?.pais || "México", 80) || "México";
  const nombreDireccion  = asText(body?.nombre_direccion || "Domicilio principal de recolección", 120);
  const nombreSucursal   = asText(body?.nombre_sucursal  || "Sucursal principal", 160);
  const telefonoSucursal = asText(body?.telefono_sucursal, 40);
  const razonSocial      = asText(body?.razon_social, 255).toUpperCase();
  const regimenFiscal    = asText(body?.regimen_fiscal, 10);
  const cpFiscal         = asText(body?.codigo_postal_fiscal, 5);

  await db.execute({
    sql: `UPDATE EmpresaSolicitud
          SET Nombre_Empresa = ?, RFC = ?, Descripcion = ?, Logo_URL = ?, Sitio_Web = ?,
              Razon_Social = ?, Regimen_Fiscal = ?, Codigo_Postal_Fiscal = ?,
              Domicilio_Numero_Casa = ?, Domicilio_Calle = ?, Domicilio_Codigo_Postal = ?,
              Domicilio_Ciudad = ?, Domicilio_Provincia = ?, Domicilio_Pais = ?, Domicilio_Nombre = ?,
              Sucursal_Nombre = ?, Sucursal_Telefono = ?,
              Admin_Nombre = ?, Admin_Apellido = ?, Admin_Apellido_Materno = ?,
              Admin_Correo = ?, Admin_Telefono = ?,
              Documentos_JSON = ?, Estado = 'pendiente', Motivo_Rechazo = NULL,
              Fecha_Resolucion = NULL, Resuelto_Por = NULL
          WHERE Id_Solicitud = ?`,
    args: [
      asText(body.nombre_empresa),
      asText(body.rfc) || null,
      asText(body.descripcion) || null,
      asText(body.logo_url) || null,
      asText(body.sitio_web) || null,
      razonSocial || null,
      regimenFiscal || null,
      cpFiscal || null,
      numeroCasa,
      calle,
      codigoPostal,
      ciudad,
      provincia,
      pais,
      nombreDireccion,
      nombreSucursal,
      telefonoSucursal || null,
      asText(body.admin_nombre),
      asText(body.admin_apellido),
      asText(body.admin_apellido_materno) || null,
      asText(body.admin_correo).toLowerCase(),
      asText(body.admin_telefono) || null,
      JSON.stringify(Array.isArray(body.documentos) ? body.documentos : []),
      Number(solicitudId),
    ],
  });

  return Number(solicitudId);
}

async function approveSolicitud({ solicitudId, reviewerId }) {
  const found = await db.execute({
    sql: `SELECT * FROM EmpresaSolicitud WHERE Id_Solicitud = ? LIMIT 1`,
    args: [solicitudId],
  });
  if (!found.rows.length) return { ok: false, status: 404, error: "Solicitud no encontrada" };

  const s = found.rows[0];
  if (String(s.Estado || "").toLowerCase() !== "pendiente")
    return { ok: false, status: 409, error: "La solicitud ya fue procesada" };

  const kyc = await getSolicitudKyc(db, solicitudId);
  const kycAprobado =
    kyc &&
    String(kyc.estado || "").toLowerCase() === "aprobado" &&
    kyc.biometriaValida === true &&
    kyc.documentoValido === true &&
    kyc.fraudeSospecha !== true;

  if (!kycAprobado) {
    const estado = String(kyc?.estado || "pendiente");
    return {
      ok: false,
      status: 409,
      error: `No se puede aprobar: KYC del representante no aprobado (estado: ${estado})`,
    };
  }

  const correoNorm = String(s.Admin_Correo || "").trim().toLowerCase();
  const exists = await db.execute({
    sql: "SELECT Id FROM Usuario WHERE LOWER(Correo) = ? LIMIT 1",
    args: [correoNorm],
  });
  if (exists.rows.length)
    return { ok: false, status: 409, error: "Ya existe un usuario con ese correo" };

  const plainPassword = generatePassword();
  const { hash, salt } = hashPassword(plainPassword);
  const hashedPassword  = hash + ":" + salt;
  const now = new Date().toISOString();

  const docs = (() => {
    try { const p = JSON.parse(String(s.Documentos_JSON || "[]")); return Array.isArray(p) ? p : []; }
    catch { return []; }
  })();

  const direccionNumeroCasa  = asPositiveInt(s.Domicilio_Numero_Casa);
  const direccionCodigoPostal= asPositiveInt(s.Domicilio_Codigo_Postal);
  const direccionCalle       = asText(s.Domicilio_Calle, 220);
  const direccionCiudad      = asText(s.Domicilio_Ciudad, 120);
  const direccionProvincia   = asText(s.Domicilio_Provincia, 120);
  const direccionPais        = asText(s.Domicilio_Pais || "México", 80) || "México";
  const direccionNombre      = asText(s.Domicilio_Nombre || "Domicilio principal de recolección", 120);
  const sucursalNombre       = asText(s.Sucursal_Nombre || "Sucursal principal", 160);
  const sucursalTelefono     = asText(s.Sucursal_Telefono, 40) || asText(s.Admin_Telefono, 40) || null;
  // Datos fiscales
  const razonSocial    = asText(s.Razon_Social, 255).toUpperCase() || null;
  const regimenFiscal  = asText(s.Regimen_Fiscal, 10) || null;
  const cpFiscal       = asText(s.Codigo_Postal_Fiscal, 5) || null;

  if (!direccionNumeroCasa || !direccionCalle || !direccionCodigoPostal || !direccionCiudad || !direccionProvincia)
    return { ok: false, status: 409, error: "La solicitud no incluye domicilio válido para recolección." };

  try {
    // 1. Usuario
    const userRes = await db.execute({
      sql: `INSERT INTO Usuario (Nombre, Apellido_Paterno, Apellido_Materno, Correo, Contrasena, Rol, Telefono, Fecha_Creacion, Requires_Password_Change)
        VALUES (?,?,?,?,?,'Admin',?,?,1)`,
      args: [
        asText(s.Admin_Nombre),
        asText(s.Admin_Apellido),
        asText(s.Admin_Apellido_Materno) || null,
        correoNorm,
        hashedPassword,
        asText(s.Admin_Telefono) || null,
        now,
      ],
    });
    const userId = Number(userRes.lastInsertRowid);

    // 2. Empresa — incluyendo datos fiscales
    const empRes = await db.execute({
      sql: `INSERT INTO Empresa
              (Id_Usuario, Nombre_Empresa, RFC, Descripcion, Logo_URL, Sitio_Web,
               Razon_Social, Regimen_Fiscal, Codigo_Postal_Fiscal,
               Estado, Fecha_Creacion)
            VALUES (?,?,?,?,?,?, ?,?,?, 'activo',?)`,
      args: [
        userId,
        asText(s.Nombre_Empresa),
        asText(s.RFC) || null,
        asText(s.Descripcion) || null,
        asText(s.Logo_URL) || null,
        asText(s.Sitio_Web) || null,
        razonSocial,
        regimenFiscal,
        cpFiscal,
        now,
      ],
    });
    const empresaId = Number(empRes.lastInsertRowid);

    // 3. Dirección
    const dirRes = await db.execute({
      sql: `INSERT INTO Direccion
              (Id_Usuario, Id_Empresa, Numero_casa, Calle, Codigo_Postal, Ciudad, Provincia, Nombre_Direccion, Pais)
            VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [userId, empresaId, direccionNumeroCasa, direccionCalle, direccionCodigoPostal, direccionCiudad, direccionProvincia, direccionNombre, direccionPais],
    });
    const direccionId = Number(dirRes.lastInsertRowid);

    // 4. Sucursal
    await db.execute({
      sql: `INSERT INTO SucursalEmpresa (Id_Empresa, Id_Direccion, Nombre_Sucursal, Telefono, Es_Principal, Activo)
            VALUES (?,?,?,?,1,1)`,
      args: [empresaId, direccionId, sucursalNombre, sucursalTelefono],
    });

    // 5. UsuarioEmpresa
    await db.execute({
      sql: `INSERT INTO UsuarioEmpresa (Id_Usuario, Id_Empresa, Rol_Empresa, Activo, Fecha_Asignacion)
            VALUES (?,?,'Admin',1,?)`,
      args: [userId, empresaId, now],
    });

    // 6. Documentos fiscales → EmpresaDocumento
    for (const tipo of REQUIRED_DOC_TYPES) {
      const doc = docs.find((d) => asText(d?.tipo).toUpperCase() === tipo);
      if (!doc) continue;
      await db.execute({
        sql: `INSERT INTO EmpresaDocumento
                (Id_Empresa, Tipo_Documento, URL_Archivo, Public_ID, Mime_Type, Nombre_Archivo,
                 Size_Bytes, SHA256, Estado_Revision, Version, Fecha_Carga, Subido_Por)
              VALUES (?,?,?,?,?,?,?,?,'pendiente',1,?,?)`,
        args: [
          empresaId, tipo,
          String(doc?.url || ""),
          asText(doc?.public_id) || null,
          asText(doc?.mime_type) || null,
          asText(doc?.nombre_archivo) || null,
          Number.isFinite(Number(doc?.size_bytes)) ? Number(doc.size_bytes) : null,
          asText(doc?.sha256) || null,
          now,
          userId,
        ],
      });
    }

    // 7. Marcar solicitud como aprobada
    await db.execute({
      sql: `UPDATE EmpresaSolicitud
            SET Estado = 'aprobada', Fecha_Resolucion = ?, Resuelto_Por = ?, Id_Empresa_Creada = ?
            WHERE Id_Solicitud = ?`,
      args: [now, reviewerId || null, empresaId, solicitudId],
    });

    // 8. Enviar correo con credenciales
    let mailResult = { sent: false, reason: "NOT_ATTEMPTED" };
    try {
      const loginUrl = (process.env.APP_URL || "http://localhost:4321") + "/es/login";
      mailResult = await sendCompanyApprovalCredentials({
        to:       correoNorm,
        empresa:  asText(s.Nombre_Empresa),
        nombre:   asText(s.Admin_Nombre),
        correo:   correoNorm,
        password: plainPassword,
        loginUrl,
      });
    } catch (mailErr) {
      mailResult = { sent: false, reason: "SMTP_SEND_FAILED", detail: String(mailErr?.message || mailErr) };
    }

    return {
      ok: true,
      status: 200,
      data: {
        empresa:      { id: empresaId, nombre: asText(s.Nombre_Empresa) },
        kyc: {
          estado: kyc.estado,
          biometriaValida: kyc.biometriaValida,
          documentoValido: kyc.documentoValido,
          fraudeSospecha: kyc.fraudeSospecha,
        },
        email:        mailResult,
        warning:      mailResult?.sent ? null : "Empresa aprobada pero el correo no se pudo enviar.",
      },
    };
  } catch (error) {
    return { ok: false, status: 500, error: "Error al aprobar solicitud: " + (error?.message || error) };
  }
}

// ── GET ──────────────────────────────────────────────────────
export async function GET({ request, cookies }) {
  if (!checkAuth(request, cookies)) return json({ success: false, error: "Acceso denegado" }, 403);
  await ensureSchemaReady();

  try {
    const result = await db.execute(`
      SELECT
        Id_Solicitud, Nombre_Empresa, RFC,
        Razon_Social, Regimen_Fiscal, Codigo_Postal_Fiscal,
        Descripcion, Sitio_Web, Logo_URL,
        Domicilio_Numero_Casa, Domicilio_Calle, Domicilio_Codigo_Postal,
        Domicilio_Ciudad, Domicilio_Provincia, Domicilio_Pais, Domicilio_Nombre,
        Sucursal_Nombre, Sucursal_Telefono,
        Admin_Nombre, Admin_Apellido, Admin_Apellido_Materno,
        Admin_Correo, Admin_Telefono,
        Domicilio_Numero_Casa, Domicilio_Calle, Domicilio_Codigo_Postal,
        Domicilio_Ciudad, Domicilio_Provincia, Domicilio_Pais, Domicilio_Nombre,
        Sucursal_Nombre, Sucursal_Telefono,
        Documentos_JSON, Estado, Motivo_Rechazo,
        Fecha_Solicitud, Fecha_Resolucion, Id_Empresa_Creada
      FROM EmpresaSolicitud
      ORDER BY Fecha_Solicitud DESC, Id_Solicitud DESC
    `);

    const solicitudes = await Promise.all(result.rows.map(async (row) => {
      let documentos = [];
      try {
        const parsed = JSON.parse(String(row.Documentos_JSON || "[]"));
        documentos = Array.isArray(parsed) ? parsed : [];
      } catch {}

      const kyc = await getSolicitudKyc(db, Number(row.Id_Solicitud));
      const biometria = await getSolicitudBiometriaMeta(db, Number(row.Id_Solicitud));

      return {
        Id_Solicitud:         Number(row.Id_Solicitud),
        Nombre_Empresa:       String(row.Nombre_Empresa || ""),
        RFC:                  row.RFC ? String(row.RFC) : null,
        Razon_Social:         row.Razon_Social ? String(row.Razon_Social) : null,
        Regimen_Fiscal:       row.Regimen_Fiscal ? String(row.Regimen_Fiscal) : null,
        Codigo_Postal_Fiscal: row.Codigo_Postal_Fiscal ? String(row.Codigo_Postal_Fiscal) : null,
        Descripcion:          row.Descripcion ? String(row.Descripcion) : null,
        Sitio_Web:            row.Sitio_Web ? String(row.Sitio_Web) : null,
        Usuario_Nombre:       String(row.Admin_Nombre || ""),
        Usuario_Apellido:     [String(row.Admin_Apellido || ""), String(row.Admin_Apellido_Materno || "")].filter(Boolean).join(" "),
        Usuario_Correo:       String(row.Admin_Correo || ""),
        Usuario_Telefono:     row.Admin_Telefono ? String(row.Admin_Telefono) : null,
        Domicilio_Numero_Casa:   row.Domicilio_Numero_Casa == null ? null : Number(row.Domicilio_Numero_Casa),
        Domicilio_Calle:         row.Domicilio_Calle ? String(row.Domicilio_Calle) : null,
        Domicilio_Codigo_Postal: row.Domicilio_Codigo_Postal == null ? null : Number(row.Domicilio_Codigo_Postal),
        Domicilio_Ciudad:        row.Domicilio_Ciudad ? String(row.Domicilio_Ciudad) : null,
        Domicilio_Provincia:     row.Domicilio_Provincia ? String(row.Domicilio_Provincia) : null,
        Domicilio_Pais:          row.Domicilio_Pais ? String(row.Domicilio_Pais) : null,
        Domicilio_Nombre:        row.Domicilio_Nombre ? String(row.Domicilio_Nombre) : null,
        Sucursal_Nombre:         row.Sucursal_Nombre ? String(row.Sucursal_Nombre) : null,
        Sucursal_Telefono:       row.Sucursal_Telefono ? String(row.Sucursal_Telefono) : null,
        Documentos:           documentos,
        Estado:               String(row.Estado || "pendiente").toLowerCase(),
        Motivo_Rechazo:       row.Motivo_Rechazo ? String(row.Motivo_Rechazo) : null,
        Fecha_Creacion:       String(row.Fecha_Solicitud || ""),
        Fecha_Resolucion:     row.Fecha_Resolucion ? String(row.Fecha_Resolucion) : null,
        Id_Empresa_Creada:    row.Id_Empresa_Creada == null ? null : Number(row.Id_Empresa_Creada),
        KYC: kyc
          ? {
              Estado: kyc.estado,
              Proveedor: kyc.proveedor,
              Biometria_Valida: kyc.biometriaValida,
              Documento_Valido: kyc.documentoValido,
              Fraude_Sospecha: kyc.fraudeSospecha,
              Score_Comparacion: kyc.scoreComparacion,
              Liveness_Score: kyc.livenessScore,
              URL_Verificacion: null,
              Fecha_Verificacion: kyc.fechaVerificacion,
            }
          : {
              Estado: "pendiente",
              Proveedor: "mock",
              Biometria_Valida: null,
              Documento_Valido: null,
              Fraude_Sospecha: null,
              Score_Comparacion: null,
              Liveness_Score: null,
              URL_Verificacion: null,
              Fecha_Verificacion: null,
            },
        Biometria: biometria
          ? {
              Disponible: true,
              Consentimiento_Aceptado: biometria.consentimientoAceptado,
              Consentimiento_Fecha: biometria.consentimientoFecha,
              Retencion_Hasta: biometria.retencionHasta,
              Hash_SHA256_Prefix: String(biometria.hashSha256 || "").slice(0, 12),
            }
          : {
              Disponible: false,
              Consentimiento_Aceptado: false,
              Consentimiento_Fecha: null,
              Retencion_Hasta: null,
              Hash_SHA256_Prefix: null,
            },
      };
    }));

    return json({ success: true, empresas: solicitudes });
  } catch (e) {
    console.error("[GET /api/admin/empresas]", e);
    return json({ success: false, error: "Error al obtener solicitudes" }, 500);
  }
}

// ── POST ─────────────────────────────────────────────────────
export async function POST({ request, cookies }) {
  // Flujo publico: esta ruta tambien acepta solicitudes desde login sin sesion admin.
  // GET/PUT/DELETE siguen protegidos por checkAuth.
  await ensureSchemaReady();

  let body;
  try { body = await request.json(); }
  catch { return json({ success: false, error: "JSON inválido" }, 400); }

  const { errors } = validateRequestBody(body);
  if (errors.length) return json({ success: false, error: errors[0], details: errors }, 400);

  const correoNorm = asText(body.admin_correo).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correoNorm))
    return json({ success: false, error: "Correo no válido" }, 400);

  try {
    const existsUser = await db.execute({
      sql: "SELECT Id FROM Usuario WHERE LOWER(Correo) = ? LIMIT 1",
      args: [correoNorm],
    });
    if (existsUser.rows.length)
      return json({ success: false, error: "Ya existe un usuario con ese correo" }, 409);

    const existsPending = await db.execute({
      sql: "SELECT Id_Solicitud FROM EmpresaSolicitud WHERE LOWER(Admin_Correo) = ? AND Estado = 'pendiente' LIMIT 1",
      args: [correoNorm],
    });

    const solicitudId = existsPending.rows.length
      ? await updateSolicitudPendiente(existsPending.rows[0].Id_Solicitud, { ...body, admin_correo: correoNorm })
      : await createSolicitud({ ...body, admin_correo: correoNorm });

    // Notificar superusuarios (no bloqueante)
    try {
      const superRes = await db.execute({
        sql: "SELECT Nombre, Correo FROM Usuario WHERE LOWER(Rol) = 'superusuario'",
        args: [],
      });
      for (const row of superRes.rows) {
        const correoSup = asText(row.Correo).toLowerCase();
        if (!correoSup) continue;
        sendNewEmpresaSolicitudAlert({
          to:           correoSup,
          reviewerName: asText(row.Nombre) || "Superusuario",
          empresaNombre: asText(body.nombre_empresa),
          adminNombre:  asText(body.admin_nombre) + " " + asText(body.admin_apellido),
          adminCorreo:  correoNorm,
        }).catch((e) => console.error("[POST /api/admin/empresas] email solicitud:", e));
      }
    } catch (mailErr) {
      console.error("[POST /api/admin/empresas] Error notificando superusuarios:", mailErr);
    }

    return json({
      success: true,
      message: existsPending.rows.length
        ? "Ya existía una solicitud pendiente. Se actualizó con los nuevos datos."
        : "Solicitud registrada en estado pendiente",
      solicitudId,
      updated: existsPending.rows.length,
      kyc: {
        estado: "pendiente",
        proveedor: "mock",
      },
    }, existsPending.rows.length ? 200 : 201);
  } catch (e) {
    console.error("[POST /api/admin/empresas]", e);
    return json({ success: false, error: "Error al registrar solicitud: " + (e?.message || e) }, 500);
  }
}

// ── PUT ──────────────────────────────────────────────────────
export async function PUT({ request, cookies }) {
  if (!checkAuth(request, cookies)) return json({ success: false, error: "Acceso denegado" }, 403);
  await ensureSchema();

  let body;
  try { body = await request.json(); }
  catch { return json({ success: false, error: "JSON inválido" }, 400); }

  const action = String(body?.action || "").toLowerCase();
  const id     = Number(body?.id || 0);
  if (!id) return json({ success: false, error: "ID de solicitud requerido" }, 400);

  if (action === "approve") {
    const reviewer = getSessionUser(cookies);
    const result = await approveSolicitud({ solicitudId: id, reviewerId: Number(reviewer?.userId || 0) || null });
    if (!result.ok) return json({ success: false, error: result.error }, result.status);
    return json({ success: true, message: "Solicitud aprobada", ...result.data });
  }

  if (action === "reject") {
    const motivo   = asText(body?.motivo) || null;
    const reviewer = getSessionUser(cookies);
    const now      = new Date().toISOString();

    const found = await db.execute({
      sql: "SELECT Estado FROM EmpresaSolicitud WHERE Id_Solicitud = ? LIMIT 1",
      args: [id],
    });
    if (!found.rows.length) return json({ success: false, error: "Solicitud no encontrada" }, 404);
    if (String(found.rows[0].Estado || "").toLowerCase() !== "pendiente")
      return json({ success: false, error: "La solicitud ya fue procesada" }, 409);

    await db.execute({
      sql: "UPDATE EmpresaSolicitud SET Estado='rechazada', Motivo_Rechazo=?, Fecha_Resolucion=?, Resuelto_Por=? WHERE Id_Solicitud=?",
      args: [motivo, now, Number(reviewer?.userId || 0) || null, id],
    });
    return json({ success: true, message: "Solicitud rechazada" });
  }

  return json({ success: false, error: "Acción no soportada" }, 400);
}

// ── DELETE ───────────────────────────────────────────────────
export async function DELETE({ request, cookies }) {
  if (!checkAuth(request, cookies)) return json({ success: false, error: "Acceso denegado" }, 403);
  await ensureSchemaReady();

  let body;
  try { body = await request.json(); }
  catch { return json({ success: false, error: "JSON inválido" }, 400); }

  const id = Number(body?.id || 0);
  if (!id) return json({ success: false, error: "ID de solicitud requerido" }, 400);

  try {
    await db.execute({ sql: "DELETE FROM EmpresaSolicitud WHERE Id_Solicitud = ?", args: [id] });
    return json({ success: true, message: "Solicitud eliminada" });
  } catch (e) {
    console.error("[DELETE /api/admin/empresas]", e);
    return json({ success: false, error: "Error al eliminar solicitud" }, 500);
  }
}