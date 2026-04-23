import "dotenv/config";
import { getSessionFromCookies, normalizeRole } from "../../../../../lib/session.js";

const SUPER_KEY = process.env.SUPER_ADMIN_KEY || "GOSUPER2026";

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

function parseFromCloudinaryUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const uploadIdx = parts.findIndex((p) => p === "upload");
    if (uploadIdx < 0) return null;

    const resourceType = parts[0] || "raw";
    const afterUpload = parts.slice(uploadIdx + 1);
    if (!afterUpload.length) return null;

    const maybeVersion = afterUpload[0];
    const pubParts = maybeVersion.startsWith("v") ? afterUpload.slice(1) : afterUpload;
    if (!pubParts.length) return null;

    const finalPart = pubParts[pubParts.length - 1] || "";
    const dot = finalPart.lastIndexOf(".");
    const format = dot > 0 ? finalPart.slice(dot + 1).toLowerCase() : "";
    if (dot > 0) pubParts[pubParts.length - 1] = finalPart.slice(0, dot);

    return {
      resourceType,
      publicId: decodeURIComponent(pubParts.join("/")),
      format,
    };
  } catch {
    return null;
  }
}

export async function GET({ request, cookies, url }) {
  if (!isAuthorized(request, cookies)) {
    return json({ success: false, error: "Acceso denegado" }, 403);
  }

  const { cloudName, apiKey, apiSecret } = resolveCloudinaryConfig();
  if (!cloudName || !apiKey || !apiSecret) {
    return json({ success: false, error: "Configuracion Cloudinary incompleta" }, 500);
  }

  const inputUrl = String(url.searchParams.get("url") || "").trim();
  const inputPublicId = String(url.searchParams.get("public_id") || "").trim();
  const inputResourceType = String(url.searchParams.get("resource_type") || "").trim().toLowerCase();
  const inputFormat = String(url.searchParams.get("format") || "").trim().toLowerCase();

  const parsed = inputPublicId ? null : parseFromCloudinaryUrl(inputUrl);

  const publicId = inputPublicId || parsed?.publicId || "";
  const resourceType = inputResourceType || parsed?.resourceType || "raw";
  const format = inputFormat || parsed?.format || "";

  if (!publicId) {
    return json({ success: false, error: "No se pudo resolver el documento a visualizar" }, 400);
  }

  const baseAuth = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;

  const candidates = (() => {
    const set = new Set();
    const push = (v) => {
      const x = String(v || "").trim();
      if (x) set.add(x);
    };
    push(publicId);

    if (resourceType === "raw" && format) {
      if (!publicId.toLowerCase().endsWith(`.${format.toLowerCase()}`)) {
        push(`${publicId}.${format}`);
      } else {
        push(publicId.slice(0, -(`.${format}`.length)));
      }
    }

    return Array.from(set);
  })();

  let lastError = "No se pudo obtener el documento";

  for (const pid of candidates) {
    const qs = new URLSearchParams({
      public_id: pid,
      type: "upload",
      attachment: "false",
    });
    if (format) qs.set("format", format);

    const endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/download?${qs.toString()}`;

    try {
      const cloudRes = await fetch(endpoint, {
        method: "GET",
        headers: {
          Authorization: baseAuth,
        },
      });

      if (!cloudRes.ok) {
        lastError = await cloudRes.text().catch(() => `Cloudinary ${cloudRes.status}`);
        continue;
      }

      const headers = new Headers();
      const contentType = cloudRes.headers.get("content-type") || "application/octet-stream";
      headers.set("Content-Type", contentType);
      const contentDisposition = cloudRes.headers.get("content-disposition");
      if (contentDisposition) headers.set("Content-Disposition", contentDisposition);
      headers.set("Cache-Control", "private, no-store");

      return new Response(cloudRes.body, {
        status: 200,
        headers,
      });
    } catch (e) {
      lastError = String(e?.message || e);
    }
  }

  return json({ success: false, error: "No se pudo descargar el documento", detail: lastError }, 502);
}
