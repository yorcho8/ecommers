import { createClient } from "@libsql/client";
import 'dotenv/config';
import { ensureProductVisibilitySchema, getSessionUserId } from "../../../lib/product-visibility.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

export async function GET({ params, cookies }) {
  const { id } = params;

  if (!id || isNaN(Number(id))) {
    return new Response(
      JSON.stringify({ success: false, error: 'ID inválido' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    await ensureProductVisibilitySchema(db);
    const sessionUserId = getSessionUserId(cookies);

    const catCheck = await db.execute({
      sql: 'SELECT Id_Categoria, Nombre FROM Categoria WHERE Id_Categoria = ?',
      args: [Number(id)],
    });

    if (catCheck.rows.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Categoría no encontrada' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const categoria = catCheck.rows[0];

    const productosResult = await db.execute({
      sql: `
        SELECT 
          p.Id_Producto,
          p.Nombre,
          p.Descripcion,
          p.Precio,
          COALESCE(p.Activo, 1) AS Activo,
          (
            SELECT ip.Url
            FROM Imagen_Producto ip
            WHERE ip.Id_Producto = p.Id_Producto
            ORDER BY ip.Id_Imagen
            LIMIT 1
          ) as ImagenUrl
        FROM Producto p
        JOIN ProductoCategoria pc ON pc.Id_Producto = p.Id_Producto
        WHERE pc.Id_Categoria = ?
          AND COALESCE(p.Activo, 1) = 1
          AND (
            ? = 0 OR NOT EXISTS (
              SELECT 1
              FROM ProductoVisibilidadUsuario pvu
              WHERE pvu.Id_Producto = p.Id_Producto
                AND pvu.Id_Usuario = ?
                AND pvu.Visible = 0
            )
          )
        ORDER BY p.Fecha_Creacion DESC
      `,
      args: [Number(id), sessionUserId ? 1 : 0, sessionUserId || 0],
    });

    const productos = productosResult.rows.map(row => ({
      id: row.Id_Producto,
      nombre: row.Nombre,
      descripcion: row.Descripcion,
      precio: row.Precio,
      activo: Number(row.Activo || 0) === 1,
      imagen: row.ImagenUrl ?? null,
    }));

    return new Response(
      JSON.stringify({
        success: true,
        categoria: {
          id: categoria.Id_Categoria,
          nombre: categoria.Nombre,
        },
        productos,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error(`[GET /api/categorias/${id}] Error:`, error);
    return new Response(
      JSON.stringify({ success: false, error: 'Error al obtener productos' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}