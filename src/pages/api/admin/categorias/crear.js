import { createClient } from "@libsql/client";
import "dotenv/config";
import { sendNewCategoriaAlert } from "../../../../lib/mail.js";
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
    if (role === "admin" || role === "superusuario") return user;
    return null;
  } catch {
    return null;
  }
}

export async function POST({ request, cookies }) {
  const user = getAdminUser(cookies);
  if (!user) {
    return json({ success: false, error: "No autenticado o sin permisos" }, 403);
  }

  try {
    const body = await request.json().catch(() => ({}));
    const nombre = String(body?.nombre || "").trim();
    const descripcion = String(body?.descripcion || "").trim();
    const imagenUrl = String(body?.imagenUrl || "").trim();

    if (!nombre) {
      return json({ success: false, error: "El nombre de la categoria es requerido" }, 400);
    }

    const existing = await db.execute({
      sql: "SELECT Id_Categoria FROM Categoria WHERE LOWER(Nombre) = LOWER(?) LIMIT 1",
      args: [nombre],
    });

    if (existing.rows.length) {
      return json({ success: false, error: "La categoria ya existe" }, 409);
    }

    await db.execute({
      sql: `INSERT INTO Categoria (Nombre, Descripcion, Imagen_URL) VALUES (?, ?, ?)`,
      args: [nombre, descripcion || null, imagenUrl || null],
    });

    const created = await db.execute({
      sql: `SELECT Id_Categoria, Nombre, Descripcion, Imagen_URL FROM Categoria WHERE LOWER(Nombre) = LOWER(?) LIMIT 1`,
      args: [nombre],
    });

    try {
      const superRes = await db.execute({
        sql: `SELECT Nombre, Correo FROM Usuario WHERE LOWER(Rol) = 'superusuario'`,
        args: [],
      });

      const creadoPorNombre = String(user?.nombre || user?.correo || "Admin");
      for (const row of superRes.rows) {
        const correoSup = String(row.Correo || "").trim().toLowerCase();
        if (!correoSup) continue;
        await sendNewCategoriaAlert({
          to: correoSup,
          reviewerName: String(row.Nombre || "Superusuario"),
          categoriaNombre: nombre,
          creadoPor: creadoPorNombre,
        }).catch((mailError) => {
          console.error("[api/admin/categorias/crear] mail:", mailError);
        });
      }
    } catch (mailError) {
      console.error("[api/admin/categorias/crear] notify error:", mailError);
    }

    return json(
      {
        success: true,
        message: "Categoria creada exitosamente",
        categoria: created.rows?.[0] || null,
      },
      201
    );
  } catch (error) {
    console.error("[POST /api/admin/categorias/crear] Error:", error);
    return json({ success: false, error: "Error al crear la categoria" }, 500);
  }
}
