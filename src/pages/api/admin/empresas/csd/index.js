// src/pages/api/admin/empresas/csd/index.js
// Registra o actualiza el CSD de una empresa en Facturama Multiemisor
// El admin sube el .cer y .key; este endpoint los manda a Facturama
// y guarda el taxpayerId resultante en EmpresaCSD.

import { createClient } from "@libsql/client";
import "dotenv/config";
import crypto from "crypto";
import { getSessionFromCookies, normalizeRole } from "../../../../../lib/session.js";

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

function getSession(cookies) {
  return getSessionFromCookies(cookies);
}

function isAdmin(session) {
  const rol = normalizeRole(session?.rol);
  return rol === "superusuario" || rol === "admin";
}

function getEnv(key) {
  return String(process.env[key] ?? import.meta.env?.[key] ?? "").trim();
}

function facturamaAuth() {
  const user = getEnv("FACTURAMA_USER");
  const pass = getEnv("FACTURAMA_PASSWORD");
  if (!user || !pass) throw new Error("Faltan FACTURAMA_USER / FACTURAMA_PASSWORD");
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

function facturamaBase() {
  return getEnv("FACTURAMA_BASE_URL") || "https://apisandbox.facturama.mx";
}

// Cifrado simple de la contraseña del CSD antes de guardar en BD
// En producción usa KMS o similar. Aquí usamos AES-256-CBC con una clave de env.
function encryptCsdPassword(plain) {
  const key = Buffer.from(
    (getEnv("CSD_ENCRYPT_KEY") || "go2026-fallback-key-32bytespadded!").slice(0, 32).padEnd(32, "0"),
    "utf8"
  );
  const iv  = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + enc.toString("hex");
}

// ── POST /api/admin/empresas/csd ──────────────────────────────────────────
// Body: multipart/form-data
//   empresaId : number
//   cerFile   : .cer file
//   keyFile   : .key file
//   csdPass   : string (contraseña del .key)

export async function POST({ request, cookies }) {
  const session = getSession(cookies);
  if (!session || !isAdmin(session))
    return json({ success: false, error: "Acceso denegado" }, 403);

  let form;
  try { form = await request.formData(); }
  catch { return json({ success: false, error: "FormData inválido" }, 400); }

  const empresaId = Number(form.get("empresaId") || 0);
  const csdPass   = String(form.get("csdPass") || "").trim();
  const cerFile   = form.get("cerFile");
  const keyFile   = form.get("keyFile");

  if (!empresaId)       return json({ success: false, error: "empresaId requerido" }, 400);
  if (!csdPass)         return json({ success: false, error: "Contraseña del CSD requerida" }, 400);
  if (!(cerFile instanceof File)) return json({ success: false, error: "Archivo .cer requerido" }, 400);
  if (!(keyFile instanceof File)) return json({ success: false, error: "Archivo .key requerido" }, 400);

  // Validar empresa
  const empRes = await db.execute({
    sql: `SELECT Id_Empresa, RFC, Razon_Social, Regimen_Fiscal, Codigo_Postal_Fiscal
          FROM Empresa WHERE Id_Empresa = ? LIMIT 1`,
    args: [empresaId],
  });
  if (!empRes.rows.length) return json({ success: false, error: "Empresa no encontrada" }, 404);
  const emp = empRes.rows[0];

  if (!emp.RFC)
    return json({ success: false, error: "La empresa no tiene RFC. Actualiza los datos fiscales primero." }, 422);
  if (!emp.Razon_Social)
    return json({ success: false, error: "La empresa no tiene razón social registrada." }, 422);
  if (!emp.Codigo_Postal_Fiscal)
    return json({ success: false, error: "La empresa no tiene CP fiscal registrado." }, 422);

  // Leer archivos como base64
  const cerBase64 = Buffer.from(await cerFile.arrayBuffer()).toString("base64");
  const keyBase64 = Buffer.from(await keyFile.arrayBuffer()).toString("base64");

  // Payload para Facturama Multiemisor
  // POST /multi-issuer  →  registra el contribuyente
  const payload = {
    Rfc:              String(emp.RFC).trim().toUpperCase(),
    RazonSocial:      String(emp.Razon_Social).trim().toUpperCase(),
    RegimenFiscal:    String(emp.Regimen_Fiscal || "601"),
    CodigoPostalFiscal: String(emp.Codigo_Postal_Fiscal),
    SelladoDigital: {
      // Facturama espera los archivos en base64
      Cer:      cerBase64,
      Key:      keyBase64,
      Password: csdPass,
    },
  };

  let taxpayerId = null;
  try {
    const res = await fetch(`${facturamaBase()}/multi-issuer`, {
      method: "POST",
      headers: {
        Authorization: facturamaAuth(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!res.ok) {
      const errMsg = data?.Message || data?.ModelState
        ? Object.values(data.ModelState || {}).flat().join(" | ")
        : JSON.stringify(data);
      return json({ success: false, error: "Facturama rechazó el CSD: " + errMsg }, 422);
    }

    // Facturama devuelve el RFC como ID del taxpayer en multiemisor
    taxpayerId = data?.Rfc || data?.rfc || String(emp.RFC).trim().toUpperCase();

  } catch (fetchErr) {
    return json({ success: false, error: "Error conectando con Facturama: " + fetchErr.message }, 502);
  }

  // Marcar anteriores CSD de esta empresa como inactivos
  await db.execute({
    sql: `UPDATE EmpresaCSD SET Estado = 'vencido', Facturama_Status = 'vencido'
          WHERE Id_Empresa = ? AND Estado = 'activo'`,
    args: [empresaId],
  });

  const now = new Date().toISOString();

  // Guardar nuevo CSD — NO guardamos los archivos en BD, solo referencia
  // Los archivos binarios ya están en Facturama, no necesitamos re-guardarlos
  await db.execute({
    sql: `INSERT INTO EmpresaCSD
            (Id_Empresa, CER_URL, CER_Public_ID, KEY_URL, KEY_Public_ID,
             CSD_Password_Enc, RFC_Certificado,
             Facturama_TaxpayerId, Facturama_Status,
             Estado, Fecha_Carga, Fecha_Validacion, Subido_Por)
          VALUES (?,?,?,?,?, ?,?, ?,?, ?,?,?,?)`,
    args: [
      empresaId,
      "facturama://stored",   // los archivos viven en Facturama, no en Cloudinary
      null,
      "facturama://stored",
      null,
      encryptCsdPassword(csdPass),
      String(emp.RFC).trim().toUpperCase(),
      taxpayerId,
      "activo",
      "activo",
      now,
      now,
      session.userId,
    ],
  });

  // Activar facturación en la empresa
  await db.execute({
    sql: `UPDATE Empresa SET Facturacion_Activa = 1 WHERE Id_Empresa = ?`,
    args: [empresaId],
  });

  return json({
    success: true,
    message: "CSD registrado en Facturama correctamente. La empresa ya puede emitir facturas.",
    taxpayerId,
  }, 201);
}

// ── GET /api/admin/empresas/csd?empresaId=N ───────────────────────────────
// Devuelve el estado del CSD de una empresa

export async function GET({ request, cookies }) {
  const session = getSession(cookies);
  if (!session || !isAdmin(session))
    return json({ success: false, error: "Acceso denegado" }, 403);

  const url = new URL(request.url);
  const empresaId = Number(url.searchParams.get("empresaId") || 0);
  if (!empresaId) return json({ success: false, error: "empresaId requerido" }, 400);

  const res = await db.execute({
    sql: `SELECT Id_CSD, RFC_Certificado, Facturama_TaxpayerId, Facturama_Status,
                 Estado, Vigencia_Inicio, Vigencia_Fin, Fecha_Carga, Fecha_Validacion
          FROM EmpresaCSD
          WHERE Id_Empresa = ?
          ORDER BY Id_CSD DESC LIMIT 1`,
    args: [empresaId],
  });

  if (!res.rows.length)
    return json({ success: true, csd: null, message: "Sin CSD registrado" });

  const row = res.rows[0];
  return json({
    success: true,
    csd: {
      id:              Number(row.Id_CSD),
      rfc:             String(row.RFC_Certificado || ""),
      taxpayerId:      String(row.Facturama_TaxpayerId || ""),
      facturamaStatus: String(row.Facturama_Status || ""),
      estado:          String(row.Estado || ""),
      fechaCarga:      String(row.Fecha_Carga || ""),
      fechaValidacion: row.Fecha_Validacion ? String(row.Fecha_Validacion) : null,
    },
  });
}