// src/pages/api/resenas/eliminar/[id].js
import { createClient } from "@libsql/client";
import { v2 as cloudinary } from "cloudinary";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../../../lib/session.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || import.meta.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY || import.meta.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET || import.meta.env.CLOUDINARY_API_SECRET,
});

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Signed go_session — not the forgeable plain-JSON authSession cookie. */
function getUserFromSession(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
  } catch {
    return null;
  }
}

export async function DELETE({ params, cookies }) {
  try {
    const user = getUserFromSession(cookies);
    if (!user?.userId)
      return jsonResponse(401, { success: false, error: "No autenticado" });

    const resenaId = Number(params.id);
    if (!resenaId || isNaN(resenaId))
      return jsonResponse(400, { success: false, error: "ID de reseña inválido" });

    const resenaRes = await db.execute({
      sql: `SELECT Id_Resena FROM Resena WHERE Id_Resena = ? AND Id_Usuario = ? LIMIT 1`,
      args: [resenaId, user.userId],
    });

    if (!resenaRes.rows.length)
      return jsonResponse(404, { success: false, error: "Reseña no encontrada" });

    const imgRes = await db.execute({
      sql: `SELECT Public_ID FROM ResenaImagen WHERE Id_Resena = ? AND Public_ID IS NOT NULL`,
      args: [resenaId],
    });

    for (const img of imgRes.rows) {
      if (img.Public_ID) {
        cloudinary.uploader.destroy(String(img.Public_ID)).catch((e) =>
          console.warn("[cloudinary destroy]", e?.message)
        );
      }
    }

    await db.execute({
      sql: `UPDATE Resena SET Estado = 'eliminado', Fecha_Actualizacion = ? WHERE Id_Resena = ?`,
      args: [new Date().toISOString(), resenaId],
    });

    return jsonResponse(200, { success: true, message: "Reseña eliminada" });
  } catch (err) {
    console.error("[DELETE /api/resenas/eliminar/[id]]", err);
    return jsonResponse(500, { success: false, error: err?.message || "Error interno" });
  }
}
