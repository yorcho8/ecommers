import { createClient } from "@libsql/client";
import "dotenv/config";
import {
  hashPassword,
  validatePassword,
  isValidEmail,
  validateRFC,
} from "../../lib/auth-utils.js";
import { ensureEmpresaRegistrationSchema } from "../../lib/empresa-schema.js";
import { sendNewEmpresaRegistradaAlert } from "../../lib/mail.js";
import { verifySessionToken, SESSION_COOKIE } from "../../lib/session.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

const SUPER_KEY = process.env.SUPER_ADMIN_KEY || "GOSUPER2026";
const ALLOW_PUBLIC = String(process.env.ALLOW_PUBLIC_COMPANY_REGISTRATION || "0") === "1";

const REGIMENES_VALIDOS = new Set([
  "601",
  "603",
  "607",
  "620",
  "621",
  "622",
  "623",
  "624",
  "626",
]);

const TIPOS_DOCUMENTO = new Set([
  "ACTA_CONSTITUTIVA",
  "INE_REPRESENTANTE",
  "CONSTANCIA_FISCAL",
]);

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Uses the signed, HttpOnly go_session cookie — not the forgeable authSession. */
function getSessionUser(cookies) {
  try {
    const token = cookies?.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
  } catch {
    return null;
  }
}

function canRegisterCompany(request, cookies) {
  if (ALLOW_PUBLIC) return true;

  const key = request.headers.get("x-admin-key");
  if (key && key === SUPER_KEY) return true;

  const session = getSessionUser(cookies);
  const role = String(session?.rol || "").toLowerCase();
  return role === "admin" || role === "superusuario";
}

function asText(value, max = 255) {
  if (value == null) return "";
  return String(value).trim().slice(0, max);
}

function normalizePayload(body) {
  const repRaw = body?.representante || {};
  const empRaw = body?.empresa || {};
  const dirRaw = body?.domicilio_fiscal || {};
  const sucRaw = body?.sucursal_principal || {};

  return {
    representante: {
      nombre: asText(repRaw.nombre ?? body?.admin_nombre, 120),
      apellidoPaterno: asText(repRaw.apellido_paterno ?? body?.admin_apellido, 120),
      apellidoMaterno: asText(repRaw.apellido_materno ?? body?.admin_apellido_materno, 120),
      correo: asText(repRaw.correo ?? body?.admin_correo, 180).toLowerCase(),
      contrasena: String(repRaw.contrasena ?? body?.contrasena ?? ""),
      telefono: asText(repRaw.telefono ?? body?.admin_telefono, 40),
    },
    empresa: {
      razonSocial: asText(empRaw.razon_social ?? body?.nombre_empresa, 200),
      nombreComercial: asText(empRaw.nombre_comercial ?? body?.nombre_comercial, 200),
      rfc: asText(empRaw.rfc ?? body?.rfc, 20).toUpperCase(),
      regimenFiscal: asText(empRaw.regimen_fiscal ?? body?.regimen_fiscal, 10),
      giro: asText(empRaw.giro ?? body?.giro, 180),
      descripcion: asText(empRaw.descripcion ?? body?.descripcion, 800),
      sitioWeb: asText(empRaw.sitio_web ?? body?.sitio_web, 250),
      logoUrl: asText(empRaw.logo_url ?? body?.logo_url, 500),
    },
    domicilioFiscal: {
      numeroCasa: Number(dirRaw.numero_casa ?? body?.numero_casa),
      calle: asText(dirRaw.calle ?? body?.calle, 220),
      codigoPostal: Number(dirRaw.codigo_postal ?? body?.codigo_postal),
      ciudad: asText(dirRaw.ciudad ?? body?.ciudad, 120),
      provincia: asText(dirRaw.provincia ?? body?.provincia, 120),
      pais: asText((dirRaw.pais ?? body?.pais) || "Mexico", 80),
      nombreDireccion: asText((dirRaw.nombre_direccion ?? body?.nombre_direccion) || "Fiscal", 120),
    },
    sucursalPrincipal: {
      nombreSucursal: asText((sucRaw.nombre_sucursal ?? body?.nombre_sucursal) || "Principal", 160),
      telefono: asText(sucRaw.telefono ?? body?.telefono_sucursal, 40),
    },
    documentos: Array.isArray(body?.documentos) ? body.documentos : [],
  };
}

function validateInput(payload) {
  const errors = [];
  const { representante, empresa, domicilioFiscal, documentos } = payload;

  if (!representante.nombre) errors.push("Nombre del representante es requerido");
  if (!representante.apellidoPaterno) errors.push("Apellido paterno del representante es requerido");
  if (!representante.correo) {
    errors.push("Correo del representante es requerido");
  } else if (!isValidEmail(representante.correo)) {
    errors.push("Correo del representante no es valido");
  }

  const passValidation = validatePassword(representante.contrasena || "");
  if (!passValidation.isValid) errors.push(passValidation.message);

  if (!empresa.razonSocial) errors.push("Razon social es requerida");

  const rfcValidation = validateRFC(empresa.rfc);
  if (!rfcValidation.valid) {
    errors.push(rfcValidation.error || "RFC invalido");
  } else {
    empresa.rfc = rfcValidation.clean;
  }

  if (!REGIMENES_VALIDOS.has(empresa.regimenFiscal)) {
    errors.push("Regimen fiscal no valido. Usa catalogo SAT");
  }

  if (!Number.isFinite(domicilioFiscal.numeroCasa) || domicilioFiscal.numeroCasa <= 0) {
    errors.push("Numero de casa invalido");
  }
  if (!domicilioFiscal.calle) errors.push("Calle es requerida");
  if (!Number.isFinite(domicilioFiscal.codigoPostal) || domicilioFiscal.codigoPostal <= 0) {
    errors.push("Codigo postal invalido");
  }
  if (!domicilioFiscal.ciudad) errors.push("Ciudad es requerida");
  if (!domicilioFiscal.provincia) errors.push("Provincia es requerida");

  const byType = {};
  for (const doc of documentos) {
    const tipo = asText(doc?.tipo || "", 40).toUpperCase();
    const url = asText(doc?.url || "", 500);
    if (!tipo || !TIPOS_DOCUMENTO.has(tipo)) {
      errors.push(`Tipo de documento invalido: ${tipo || "(vacio)"}`);
      continue;
    }
    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      errors.push(`URL de documento invalida para ${tipo}`);
      continue;
    }
    byType[tipo] = (byType[tipo] || 0) + 1;
  }

  for (const tipo of TIPOS_DOCUMENTO) {
    if (!byType[tipo]) {
      errors.push(`Falta documento requerido: ${tipo}`);
    }
  }

  return errors;
}

export async function POST({ request, cookies }) {
  if (!canRegisterCompany(request, cookies)) {
    return json(403, {
      success: false,
      error: "No autorizado para registrar empresas",
      hint: "Usa x-admin-key o inicia sesion como admin/superusuario",
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { success: false, error: "JSON invalido" });
  }

  const payload = normalizePayload(body);
  const validationErrors = validateInput(payload);
  if (validationErrors.length) {
    return json(400, {
      success: false,
      error: "Datos invalidos",
      details: validationErrors,
    });
  }

  await ensureEmpresaRegistrationSchema(db);

  const rep = payload.representante;
  const emp = payload.empresa;
  const dir = payload.domicilioFiscal;
  const suc = payload.sucursalPrincipal;
  const docs = payload.documentos;
  const now = new Date().toISOString();

  try {
    const existingEmail = await db.execute({
      sql: "SELECT Id FROM Usuario WHERE LOWER(Correo) = ? LIMIT 1",
      args: [rep.correo],
    });
    if (existingEmail.rows.length) {
      return json(409, { success: false, error: "Ya existe un usuario con ese correo" });
    }

    const existingRfc = await db.execute({
      sql: "SELECT Id_Empresa FROM Empresa WHERE UPPER(RFC) = ? LIMIT 1",
      args: [emp.rfc],
    });
    if (existingRfc.rows.length) {
      return json(409, { success: false, error: "Ya existe una empresa con ese RFC" });
    }

    const { hash, salt } = hashPassword(rep.contrasena);
    const passwordHash = `${hash}:${salt}`;

    await db.execute({ sql: "BEGIN", args: [] });

    const userResult = await db.execute({
      sql: `INSERT INTO Usuario
            (Nombre, Apellido_Paterno, Apellido_Materno, Correo, Contrasena, Rol, Telefono, Fecha_Creacion)
            VALUES (?, ?, ?, ?, ?, 'Admin', ?, ?)`,
      args: [
        rep.nombre,
        rep.apellidoPaterno,
        rep.apellidoMaterno || null,
        rep.correo,
        passwordHash,
        rep.telefono || null,
        now,
      ],
    });
    const userId = Number(userResult.lastInsertRowid);

    const empresaResult = await db.execute({
      sql: `INSERT INTO Empresa
            (Id_Usuario, Nombre_Empresa, Nombre_Comercial, RFC, Regimen_Fiscal, Giro, Descripcion, Logo_URL, Sitio_Web, Estado, Fecha_Creacion, Estatus_Documentacion)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'activo', ?, 'pendiente')`,
      args: [
        userId,
        emp.razonSocial,
        emp.nombreComercial || null,
        emp.rfc,
        emp.regimenFiscal,
        emp.giro || null,
        emp.descripcion || null,
        emp.logoUrl || null,
        emp.sitioWeb || null,
        now,
      ],
    });
    const empresaId = Number(empresaResult.lastInsertRowid);

    await db.execute({
      sql: `INSERT INTO UsuarioEmpresa (Id_Usuario, Id_Empresa, Rol_Empresa, Activo, Fecha_Asignacion)
            VALUES (?, ?, 'Admin', 1, ?)`,
      args: [userId, empresaId, now],
    });

    const direccionResult = await db.execute({
      sql: `INSERT INTO Direccion
            (Id_Usuario, Id_Empresa, Numero_casa, Calle, Codigo_Postal, Ciudad, Provincia, Nombre_Direccion, Pais)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        userId,
        empresaId,
        dir.numeroCasa,
        dir.calle,
        dir.codigoPostal,
        dir.ciudad,
        dir.provincia,
        dir.nombreDireccion || "Fiscal",
        dir.pais || "Mexico",
      ],
    });
    const direccionId = Number(direccionResult.lastInsertRowid);

    const sucursalResult = await db.execute({
      sql: `INSERT INTO SucursalEmpresa
            (Id_Empresa, Id_Direccion, Nombre_Sucursal, Telefono, Es_Principal, Activo)
            VALUES (?, ?, ?, ?, 1, 1)`,
      args: [
        empresaId,
        direccionId,
        suc.nombreSucursal || "Principal",
        suc.telefono || rep.telefono || null,
      ],
    });
    const sucursalId = Number(sucursalResult.lastInsertRowid);

    for (const doc of docs) {
      const tipo = asText(doc?.tipo || "", 40).toUpperCase();
      if (!TIPOS_DOCUMENTO.has(tipo)) continue;

      await db.execute({
        sql: `INSERT INTO EmpresaDocumento
              (Id_Empresa, Tipo_Documento, URL_Archivo, Public_ID, Mime_Type, Nombre_Archivo, Size_Bytes, SHA256, Estado_Revision, Version, Fecha_Carga, Subido_Por)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', 1, ?, ?)`,
        args: [
          empresaId,
          tipo,
          asText(doc?.url || "", 500),
          asText(doc?.public_id || "", 255) || null,
          asText(doc?.mime_type || "", 120) || null,
          asText(doc?.nombre_archivo || "", 255) || null,
          Number.isFinite(Number(doc?.size_bytes)) ? Number(doc.size_bytes) : null,
          asText(doc?.sha256 || "", 128) || null,
          now,
          userId,
        ],
      });
    }

    await db.execute({ sql: "COMMIT", args: [] });

    // Notify all superusuarios about the new registered empresa (non-blocking)
    try {
      const superRes = await db.execute({
        sql: `SELECT Nombre, Correo FROM Usuario WHERE LOWER(Rol) = 'superusuario'`,
        args: [],
      });
      for (const row of superRes.rows) {
        const correoSup = String(row.Correo || "").trim().toLowerCase();
        if (!correoSup) continue;
        await sendNewEmpresaRegistradaAlert({
          to:            correoSup,
          reviewerName:  String(row.Nombre || "Superusuario"),
          empresaNombre: emp.razonSocial,
          adminNombre:   `${rep.nombre} ${rep.apellidoPaterno}`.trim(),
          adminCorreo:   rep.correo,
          empresaId,
        }).catch((e) => console.error("[register-empresa] email notif:", e));
      }
    } catch (mailErr) {
      console.error("[register-empresa] Error notificando superusuarios:", mailErr);
    }

    return json(201, {
      success: true,
      message: "Empresa registrada correctamente",
      data: {
        usuarioId: userId,
        empresaId,
        direccionId,
        sucursalId,
      },
    });
  } catch (error) {
    try {
      await db.execute({ sql: "ROLLBACK", args: [] });
    } catch {}

    console.error("[POST /api/register-empresa]", error);
    return json(500, {
      success: false,
      error: "No se pudo registrar la empresa",
      detail: String(error?.message || error),
    });
  }
}
