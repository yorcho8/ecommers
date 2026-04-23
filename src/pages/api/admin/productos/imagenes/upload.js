import crypto from "crypto";
import "dotenv/config";
import { getSessionFromCookies, normalizeRole } from "../../../../../lib/session.js";

const SUPER_KEY = process.env.SUPER_ADMIN_KEY || "GOSUPER2026";
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 8 * 1024 * 1024;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getEnvValue(key) {
  const fromProcess = process.env[key];
  const fromMeta = import.meta.env?.[key];
  const raw = fromProcess ?? fromMeta ?? "";
  return String(raw || "").trim();
}

function parseCloudinaryUrl(url) {
  try {
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

function getSession(cookies) {
  return getSessionFromCookies(cookies);
}

function isAuthorized(request, cookies) {
  const key = request.headers.get("x-admin-key");
  if (key && key === SUPER_KEY) return true;

  const session = getSession(cookies);
  const role = normalizeRole(session?.rol);
  return role === "admin" || role === "superusuario";
}

function createCloudinarySignature(paramsToSign, apiSecret) {
  const signBase = Object.keys(paramsToSign)
    .sort()
    .map((key) => `${key}=${paramsToSign[key]}`)
    .join("&");

  return crypto.createHash("sha1").update(signBase + apiSecret).digest("hex");
}

export async function POST({ request, cookies }) {
  if (!isAuthorized(request, cookies)) {
    return json({ success: false, error: "Acceso denegado" }, 403);
  }

  const { cloudName, apiKey, apiSecret } = resolveCloudinaryConfig();
  if (!cloudName || !apiKey || !apiSecret) {
    return json({ success: false, error: "Configuracion de Cloudinary incompleta" }, 500);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ success: false, error: "formData invalido" }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return json({ success: false, error: "Archivo requerido en campo file" }, 400);
  }

  if (!ALLOWED_MIME.has(file.type)) {
    return json({ success: false, error: "Formato no permitido. Usa JPG, PNG o WEBP" }, 400);
  }

  if (file.size > MAX_BYTES) {
    return json({ success: false, error: "La imagen excede 8MB" }, 400);
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `producto_${timestamp}_${crypto.randomBytes(4).toString("hex")}`;
  const folder = "go2026/productos/admin";

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
    const uploadRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
      method: "POST",
      body: cloudForm,
    });

    const uploadData = await uploadRes.json().catch(() => ({}));
    if (!uploadRes.ok || !uploadData?.secure_url) {
      return json(
        {
          success: false,
          error: "Cloudinary rechazo la imagen",
          detail: uploadData?.error?.message || "Error de subida",
        },
        502
      );
    }

    return json({
      success: true,
      url: String(uploadData.secure_url || ""),
      publicId: String(uploadData.public_id || ""),
      bytes: Number(uploadData.bytes || file.size || 0),
    });
  } catch (error) {
    return json({ success: false, error: "Error subiendo imagen", detail: String(error?.message || error) }, 500);
  }
}
