import { createClient } from "@libsql/client";
import "dotenv/config";
import {
  ensureEmpresaBiometriaSchema,
  getSolicitudBiometriaImage,
  getSolicitudBiometriaMeta,
} from "../../../../../lib/empresa-biometria.js";
import { getSessionFromCookies, normalizeRole } from "../../../../../lib/session.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

const SUPER_KEY = process.env.SUPER_ADMIN_KEY || "GOSUPER2026";

function checkAuth(request, cookies) {
  const key = request.headers.get("x-admin-key");
  if (key === SUPER_KEY) return true;
  const session = getSessionFromCookies(cookies);
  return normalizeRole(session?.rol) === "superusuario";
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET({ params, request, cookies }) {
  if (!checkAuth(request, cookies)) {
    return json({ success: false, error: "Acceso denegado" }, 403);
  }

  const id = Number(params?.id || 0);
  if (!id) return json({ success: false, error: "ID de solicitud requerido" }, 400);

  await ensureEmpresaBiometriaSchema(db);

  const meta = await getSolicitudBiometriaMeta(db, id);
  if (!meta) return json({ success: false, error: "Biometria no encontrada" }, 404);

  const img = await getSolicitudBiometriaImage(db, id);
  if (!img) return json({ success: false, error: "Imagen no encontrada" }, 404);

  return new Response(img.buffer, {
    status: 200,
    headers: {
      "Content-Type": img.mimeType,
      "Cache-Control": "no-store, private",
      "X-Biometric-Hash": String(meta.hashSha256 || "").slice(0, 12),
      "X-Retention-Until": String(meta.retencionHasta || ""),
    },
  });
}
