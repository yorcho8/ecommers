import { createClient } from "@libsql/client";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../../../lib/session.js";

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
function getAdminUser(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const user = verifySessionToken(token);
    const role = String(user?.rol || "").toLowerCase();
    return role === "admin" || role === "superusuario" ? user : null;
  } catch {
    return null;
  }
}

export async function PUT({ params, request, cookies }) {
  const admin = getAdminUser(cookies);
  if (!admin) return json({ success: false, error: "Acceso denegado" }, 403);

  const id = Number(params?.id);
  if (!Number.isFinite(id) || id <= 0) {
    return json({ success: false, error: "ID de categoria invalido" }, 400);
  }

  try {
    const body = await request.json().catch(() => ({}));
    const nombre = String(body?.nombre || "").trim();
    const descripcion = String(body?.descripcion || "").trim();
    const imagenUrl = String(body?.imagenUrl || "").trim();

    if (!nombre) {
      return json({ success: false, error: "El nombre es obligatorio" }, 400);
    }

    const exists = await db.execute({
      sql: "SELECT Id_Categoria FROM Categoria WHERE Id_Categoria = ? LIMIT 1",
      args: [id],
    });

    if (!exists.rows.length) {
      return json({ success: false, error: "Categoria no encontrada" }, 404);
    }

    await db.execute({
      sql: `UPDATE Categoria
            SET Nombre = ?, Descripcion = ?, Imagen_URL = ?
            WHERE Id_Categoria = ?`,
      args: [nombre, descripcion || null, imagenUrl || null, id],
    });

    return json({ success: true, message: "Categoria actualizada" });
  } catch (error) {
    console.error("[PUT /api/admin/categorias/:id] Error:", error);
    return json({ success: false, error: "Error actualizando categoria" }, 500);
  }
}

export async function DELETE({ params, cookies }) {
  const admin = getAdminUser(cookies);
  if (!admin) return json({ success: false, error: "Acceso denegado" }, 403);

  const id = Number(params?.id);
  if (!Number.isFinite(id) || id <= 0) {
    return json({ success: false, error: "ID de categoria invalido" }, 400);
  }

  try {
    const exists = await db.execute({
      sql: "SELECT Id_Categoria FROM Categoria WHERE Id_Categoria = ? LIMIT 1",
      args: [id],
    });

    if (!exists.rows.length) {
      return json({ success: false, error: "Categoria no encontrada" }, 404);
    }

    const linkedProducts = await db.execute({
      sql: "SELECT COUNT(*) AS total FROM ProductoCategoria WHERE Id_Categoria = ?",
      args: [id],
    });

    const total = Number(linkedProducts.rows?.[0]?.total || 0);
    if (total > 0) {
      return json(
        {
          success: false,
          error: "No se puede eliminar una categoria con productos asignados",
        },
        409
      );
    }

    await db.execute({
      sql: "DELETE FROM Categoria WHERE Id_Categoria = ?",
      args: [id],
    });

    return json({ success: true, message: "Categoria eliminada" });
  } catch (error) {
    console.error("[DELETE /api/admin/categorias/:id] Error:", error);
    return json({ success: false, error: "Error eliminando categoria" }, 500);
  }
}
