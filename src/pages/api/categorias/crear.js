import { createClient } from "@libsql/client";
import 'dotenv/config';
import { sendNewCategoriaAlert } from '../../../lib/mail.js';
import { verifySessionToken, SESSION_COOKIE } from '../../../lib/session.js';

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN
});

export async function POST({ request, cookies }) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) {
      return new Response(
        JSON.stringify({ success: false, error: 'No autenticado' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const user = (() => { try { return verifySessionToken(token); } catch { return null; } })();
    if (!user || !["admin", "superusuario"].includes(String(user?.rol || "").toLowerCase())) {
      return new Response(
        JSON.stringify({ success: false, error: 'Acceso denegado. Solo administradores pueden crear categorias' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { nombre, descripcion, imagenUrl } = await request.json();

    if (!nombre || !nombre.trim()) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'El nombre de la categoría es requerido'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const descripcionLimpia = typeof descripcion === 'string' ? descripcion.trim() : '';
    const imagenUrlLimpia = typeof imagenUrl === 'string' ? imagenUrl.trim() : '';

    const existing = await db.execute({
      sql: `SELECT Id_Categoria FROM Categoria WHERE Nombre = ?`,
      args: [nombre.trim()]
    });

    if (existing.rows.length > 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'La categoría ya existe'
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    await db.execute({
      sql: `INSERT INTO Categoria (Nombre, Descripcion, Imagen_URL) VALUES (?, ?, ?)`,
      args: [nombre.trim(), descripcionLimpia || null, imagenUrlLimpia || null]
    });

    const result = await db.execute({
      sql: `SELECT Id_Categoria, Nombre, Descripcion, Imagen_URL FROM Categoria WHERE Nombre = ?`,
      args: [nombre.trim()]
    });

    // Notify all superusuarios about the new category (non-blocking)
    try {
      const superRes = await db.execute({
        sql: `SELECT Nombre, Correo FROM Usuario WHERE LOWER(Rol) = 'superusuario'`,
        args: [],
      });
      const creadoPorNombre = String(user?.nombre || user?.correo || 'Admin');
      for (const row of superRes.rows) {
        const correoSup = String(row.Correo || '').trim().toLowerCase();
        if (!correoSup) continue;
        await sendNewCategoriaAlert({
          to:             correoSup,
          reviewerName:   String(row.Nombre || 'Superusuario'),
          categoriaNombre: nombre.trim(),
          creadoPor:      creadoPorNombre,
        }).catch((e) => console.error('[categorias/crear] email notif:', e));
      }
    } catch (mailErr) {
      console.error('[categorias/crear] Error notificando superusuarios:', mailErr);
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Categoría creada exitosamente',
        categoria: result.rows[0]
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error creando categoría:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Error al crear la categoría'
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}