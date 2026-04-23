import { createClient } from "@libsql/client";
import "dotenv/config";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

export async function GET({ params }) {
  const { id } = params;
  const productId = Number(id);

  if (!Number.isFinite(productId) || productId <= 0) {
    return new Response(JSON.stringify({ success: false, error: "ID invalido" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const productoResult = await db.execute({
      sql: `
        SELECT
          p.Id_Producto,
          p.Nombre,
          p.Descripcion,
          p.Precio,
          c.Nombre AS Categoria
        FROM Producto p
        LEFT JOIN ProductoCategoria pc ON pc.Id_Producto = p.Id_Producto
        LEFT JOIN Categoria c ON c.Id_Categoria = pc.Id_Categoria
        WHERE p.Id_Producto = ?
        LIMIT 1
      `,
      args: [productId],
    });

    if (!productoResult.rows.length) {
      return new Response(JSON.stringify({ success: false, error: "Producto no encontrado" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const imagesResult = await db.execute({
      sql: `
        SELECT Url
        FROM Imagen_Producto
        WHERE Id_Producto = ?
        ORDER BY Id_Imagen ASC
      `,
      args: [productId],
    });

    const row = productoResult.rows[0];
    const imagenes = imagesResult.rows
      .map((imgRow) => String(imgRow.Url || "").trim())
      .filter(Boolean);

    return new Response(
      JSON.stringify({
        success: true,
        producto: {
          id: row.Id_Producto,
          nombre: row.Nombre,
          descripcion: row.Descripcion,
          precio: row.Precio,
          categoria: row.Categoria || null,
          imagenes,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("[GET /api/productos/detalle/[id]] Error:", error);
    return new Response(JSON.stringify({ success: false, error: "Error al obtener detalle del producto" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
