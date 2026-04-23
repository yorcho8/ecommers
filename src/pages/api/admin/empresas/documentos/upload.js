import crypto from "crypto";
import { createClient } from "@libsql/client";
import "dotenv/config";
import { getSessionFromCookies, normalizeRole } from "../../../../../lib/session.js";
import { ensureEmpresaRegistrationSchema } from "../../../../../lib/empresa-schema.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

const SUPER_KEY = process.env.SUPER_ADMIN_KEY || "GOSUPER2026";
const TIPOS_DOCUMENTO = new Set([
  "ACTA_CONSTITUTIVA",
  "INE_REPRESENTANTE",
  "CONSTANCIA_FISCAL",
]);
const MIME_PERMITIDOS = new Set([
  "application/pdf",
  "application/x-pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);
const MAX_BYTES = 8 * 1024 * 1024;

function getEnvValue(key) {
  const fromProcess = process.env[key];
  const fromMeta = import.meta.env?.[key];
  const raw = fromProcess ?? fromMeta ?? "";
  return String(raw || "").trim();
}

function parseCloudinaryUrl(url) {
  try {
    // Format: cloudinary://<api_key>:<api_secret>@<cloud_name>
    const clean = String(url || "").trim();
    if (!clean.startsWith("cloudinary://")) return null;
    const withoutScheme = clean.replace("cloudinary://", "");
    const [creds, cloudName] = withoutScheme.split("@");
    if (!creds || !cloudName) return null;
    const [apiKey, apiSecret] = creds.split(":");
    if (!apiKey || !apiSecret) return null;
    return {
      cloudName: String(cloudName).trim(),
      apiKey: String(apiKey).trim(),
      apiSecret: String(apiSecret).trim(),
    };
  } catch {
    return null;
  }
}

function resolveCloudinaryConfig() {
  let cloudName = getEnvValue("CLOUDINARY_CLOUD_NAME");
  let apiKey = getEnvValue("CLOUDINARY_API_KEY");
  let apiSecret = getEnvValue("CLOUDINARY_API_SECRET");

  if (!cloudName || !apiKey || !apiSecret) {
    const parsed = parseCloudinaryUrl(getEnvValue("CLOUDINARY_URL"));
    if (parsed) {
      cloudName = cloudName || parsed.cloudName;
      apiKey = apiKey || parsed.apiKey;
      apiSecret = apiSecret || parsed.apiSecret;
    }
  }

  return { cloudName, apiKey, apiSecret };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getSession(cookies) {
  return getSessionFromCookies(cookies);
}

function getUserId(session) {
  const raw = session?.userId ?? session?.id ?? session?.Id ?? null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isAuthorized(request, cookies) {
  const key = request.headers.get("x-admin-key");
  if (key && key === SUPER_KEY) return true;

  const session = getSession(cookies);
  const role = normalizeRole(session?.rol);
  return role === "admin" || role === "superusuario";
}

function createCloudinarySignature(paramsToSign, apiSecret) {
  const sortedKeys = Object.keys(paramsToSign).sort();
  const signBase = sortedKeys
    .map((key) => `${key}=${paramsToSign[key]}`)
    .join("&");
  return crypto.createHash("sha1").update(signBase + apiSecret).digest("hex");
}

function inferMimeType(file) {
  const reported = String(file?.type || "").trim().toLowerCase();
  if (reported) {
    if (reported === "image/jpg") return "image/jpeg";
    if (reported === "application/x-pdf") return "application/pdf";
    return reported;
  }

  const name = String(file?.name || "").toLowerCase();
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  return "";
}

export async function POST({ request, cookies }) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ success: false, error: "formData invalido" }, 400);
  }

  const file = form.get("file");
  const tipoDocumento = String(form.get("tipoDocumento") || "").trim().toUpperCase();
  const empresaIdRaw = form.get("empresaId");
  const empresaId = empresaIdRaw == null || String(empresaIdRaw).trim() === ""
    ? null
    : Number(empresaIdRaw);

  const hasAdminAuth = isAuthorized(request, cookies);
  const isPublicPreregFlow = request.headers.get("x-public-company-request") === "1" && empresaId == null;
  if (!hasAdminAuth && !isPublicPreregFlow) {
    return json({ success: false, error: "Acceso denegado" }, 403);
  }

  await ensureEmpresaRegistrationSchema(db);

  const { cloudName, apiKey, apiSecret } = resolveCloudinaryConfig();

  if (!cloudName || !apiKey || !apiSecret) {
    const missing = [];
    if (!cloudName) missing.push("CLOUDINARY_CLOUD_NAME");
    if (!apiKey) missing.push("CLOUDINARY_API_KEY");
    if (!apiSecret) missing.push("CLOUDINARY_API_SECRET");
    return json(
      {
        success: false,
        error: "Faltan variables de Cloudinary",
        required: ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"],
        missing,
        hint: "Verifica .env y reinicia el servidor de desarrollo despues de cambiar variables de entorno.",
      },
      500
    );
  }

  if (!(file instanceof File)) {
    return json({ success: false, error: "Archivo requerido en campo file" }, 400);
  }

  if (!TIPOS_DOCUMENTO.has(tipoDocumento)) {
    return json({ success: false, error: "tipoDocumento invalido" }, 400);
  }

  if (empresaId != null && (!Number.isFinite(empresaId) || empresaId <= 0)) {
    return json({ success: false, error: "empresaId invalido" }, 400);
  }

  const normalizedMimeType = inferMimeType(file);

  if (!MIME_PERMITIDOS.has(normalizedMimeType)) {
    return json({ success: false, error: "Mime type no permitido" }, 400);
  }

  if (file.size > MAX_BYTES) {
    return json({ success: false, error: "Archivo excede 8MB" }, 400);
  }

  if (empresaId != null) {
    const empresaExists = await db.execute({
      sql: "SELECT Id_Empresa FROM Empresa WHERE Id_Empresa = ? LIMIT 1",
      args: [empresaId],
    });
    if (!empresaExists.rows.length) {
      return json({ success: false, error: "Empresa no encontrada" }, 404);
    }
  }

  const folder = empresaId == null
    ? "go2026/empresas/preregistro/fiscal"
    : `go2026/empresas/${empresaId}/fiscal`;
  const timestamp = Math.floor(Date.now() / 1000);
  const ext = file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "bin";
  const publicId = `${tipoDocumento.toLowerCase()}_${timestamp}`;
  const isPdf = normalizedMimeType === "application/pdf";
  const resourceType = isPdf ? "raw" : "image";

  const paramsToSign = {
    access_mode: "public",
    folder,
    public_id: publicId,
    type: "upload",
    timestamp,
  };
  const signature = createCloudinarySignature(paramsToSign, apiSecret);

  const cloudForm = new FormData();
  cloudForm.append("file", file);
  cloudForm.append("api_key", apiKey);
  cloudForm.append("timestamp", String(timestamp));
  cloudForm.append("signature", signature);
  cloudForm.append("access_mode", "public");
  cloudForm.append("folder", folder);
  cloudForm.append("public_id", publicId);
  cloudForm.append("type", "upload");

  try {
    const uploadRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`, {
      method: "POST",
      body: cloudForm,
    });

    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) {
      return json(
        {
          success: false,
          error: "Cloudinary rechazo el archivo",
          detail: uploadData?.error?.message || uploadData,
        },
        502
      );
    }

    const session = getSession(cookies);
    const userId = getUserId(session);
    const now = new Date().toISOString();

    if (empresaId != null) {
      await db.execute({
        sql: `INSERT INTO EmpresaDocumento
              (Id_Empresa, Tipo_Documento, URL_Archivo, Public_ID, Mime_Type, Nombre_Archivo, Size_Bytes, SHA256, Estado_Revision, Version, Fecha_Carga, Subido_Por)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', 1, ?, ?)`,
        args: [
          empresaId,
          tipoDocumento,
          String(uploadData.secure_url || ""),
          String(uploadData.public_id || ""),
          String(uploadData.resource_type || "") === "image" ? normalizedMimeType : String(uploadData.format ? `application/${uploadData.format}` : normalizedMimeType),
          String(file.name || `documento.${ext}`),
          Number(uploadData.bytes || file.size || 0),
          null,
          now,
          userId,
        ],
      });
    }

    return json({
      success: true,
      documento: {
        empresaId,
        tipoDocumento,
        url: uploadData.secure_url,
        publicId: uploadData.public_id,
        resourceType: uploadData.resource_type || resourceType,
        format: uploadData.format || (isPdf ? "pdf" : undefined),
        bytes: uploadData.bytes,
        linkedToEmpresa: empresaId != null,
      },
    });
  } catch (error) {
    console.error("[POST /api/admin/empresas/documentos/upload]", error);
    return json(
      {
        success: false,
        error: "Error subiendo documento",
        detail: String(error?.message || error),
      },
      500
    );
  }
}
