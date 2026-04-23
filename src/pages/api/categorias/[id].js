import { createClient } from "@libsql/client";
import 'dotenv/config';

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN
});

export async function GET({ params }) {
  const { id } = params;

  try {
    // Obtener productos de una categoría específica
    const result = await db.execute(`
      SELECT
        p.Id_Producto,
        p.Nombre,
        p.Descripcion,
        p.Precio,
        p.StockDisponible,
        p.Fecha_Creacion,
        c.Id_Categoria,
        c.Nombre as CategoriaNombre,
        ip.Url as ImagenUrl
      FROM Producto p
      LEFT JOIN ProductoCategoria pc ON p.Id_Producto = pc.Id_Producto
      LEFT JOIN Categoria c ON pc.Id_Categoria = c.Id_Categoria
      LEFT JOIN Imagen_Producto ip ON p.Id_Producto = ip.Id_Producto
      WHERE c.Id_Categoria = ?
      ORDER BY p.Fecha_Creacion DESC, ip.Id_Imagen ASC
    `, [id]);

    if (result.rows.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Categoría no encontrada'
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Obtener nombre de la categoría
    const categoriaNombre = result.rows[0].CategoriaNombre;

    // Agrupar productos
    const productosMap = new Map();

    result.rows.forEach(row => {
      if (!productosMap.has(row.Id_Producto)) {
        productosMap.set(row.Id_Producto, {
          id: row.Id_Producto,
          nombre: row.Nombre,
          descripcion: row.Descripcion,
          precio: row.Precio,
          stock: row.StockDisponible,
          fechaCreacion: row.Fecha_Creacion,
          imagenes: []
        });
      }

      // Agregar imagen si existe
      if (row.ImagenUrl) {
        const producto = productosMap.get(row.Id_Producto);
        if (!producto.imagenes.includes(row.ImagenUrl)) {
          producto.imagenes.push(row.ImagenUrl);
        }
      }
    });

    const productos = Array.from(productosMap.values());

    return new Response(
      JSON.stringify({
        success: true,
        categoria: {
          id: id,
          nombre: categoriaNombre,
          productos: productos
        }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error obteniendo categoría:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Error al obtener la categoría'
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}