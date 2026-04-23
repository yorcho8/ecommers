import { createClient } from "@libsql/client";
import "dotenv/config";
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

/** Signed go_session — not the forgeable plain-JSON authSession cookie. */
function getSuperUser(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const user = verifySessionToken(token);
    const role = String(user?.rol || "").toLowerCase();
    if (role === "superusuario") return user;
    return null;
  } catch {
    return null;
  }
}

async function ensureFeedbackSchema() {
  return true;
}

function buildFolio(id) {
  const year = new Date().getFullYear();
  const seq = String(id).padStart(6, "0");
  return `QS-${year}-${seq}`;
}

export async function GET({ cookies, url }) {
  const superUser = getSuperUser(cookies);
  if (!superUser) return json({ success: false, error: "Acceso denegado" }, 403);

  try {
    await ensureFeedbackSchema();

    const limit = Math.min(300, Math.max(1, Number(url.searchParams.get("limit") || 120)));
    const status = String(url.searchParams.get("status") || "all").toLowerCase();

    let sql = `
      SELECT
        q.Id_Feedback,
        q.Id_Usuario,
        q.Tipo,
        q.Asunto,
        q.Mensaje,
        q.Categoria,
        q.Canal_Respuesta,
        q.Estado,
        q.Origen,
        q.Fecha_Creacion,
        q.Fecha_Actualizacion,
        u.Nombre AS UsuarioNombre,
        u.Correo AS UsuarioCorreo,
        u.Telefono AS UsuarioTelefono,
        d.Numero_casa AS UsuarioNumeroCasa
      FROM QuejaSugerencia q
      LEFT JOIN Usuario u ON u.Id = q.Id_Usuario
      LEFT JOIN Direccion d ON d.Id_Direccion = (
        SELECT d2.Id_Direccion
        FROM Direccion d2
        WHERE d2.Id_Usuario = q.Id_Usuario
        ORDER BY d2.Id_Direccion DESC
        LIMIT 1
      )
    `;
    const args = [];

    if (status !== "all") {
      sql += " WHERE LOWER(COALESCE(q.Estado, 'nuevo')) = ? ";
      args.push(status);
    }

    sql += " ORDER BY q.Fecha_Creacion DESC LIMIT ?";
    args.push(limit);

    const result = await db.execute({ sql, args });

    const items = result.rows.map((row) => {
      const id = Number(row.Id_Feedback || 0);
      return {
        id,
        folio: buildFolio(id),
        userId: row.Id_Usuario != null ? Number(row.Id_Usuario) : null,
        tipo: String(row.Tipo || "sugerencia"),
        asunto: String(row.Asunto || ""),
        mensaje: String(row.Mensaje || ""),
        categoria: String(row.Categoria || "general"),
        canalRespuesta: String(row.Canal_Respuesta || "ticket"),
        nombreContacto: String(row.UsuarioNombre || ""),
        correoContacto: String(row.UsuarioCorreo || ""),
        telefonoContacto: String(row.UsuarioTelefono || ""),
        numeroContacto: row.UsuarioNumeroCasa != null ? String(row.UsuarioNumeroCasa) : "",
        estado: String(row.Estado || "nuevo"),
        origen: String(row.Origen || "web"),
        fechaCreacion: String(row.Fecha_Creacion || ""),
        fechaActualizacion: String(row.Fecha_Actualizacion || ""),
      };
    });

    return json({ success: true, items });
  } catch (error) {
    console.error("[admin/feedback/get] error:", error);
    return json({ success: false, error: "No se pudieron cargar las quejas y sugerencias" }, 500);
  }
}
