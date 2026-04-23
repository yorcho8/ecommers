import { createClient } from "@libsql/client";
import 'dotenv/config';

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

// GET /api/productos/categorias
// Devuelve todas las categorías con sus subcategorías anidadas
export async function GET() {
  try {
    // Todas las categorías
    const result = await db.execute({
      sql: `
        SELECT
          c.Id_Categoria,
          c.Nombre,
          c.Descripcion,
          c.Imagen_URL,
          c.Id_CategoriaPadre,
          COUNT(pc.Id_Producto) AS Total_Productos
        FROM Categoria c
        LEFT JOIN ProductoCategoria pc ON pc.Id_Categoria = c.Id_Categoria
        GROUP BY c.Id_Categoria
        ORDER BY c.Nombre ASC
      `,
      args: [],
    });

    const todas = result.rows.map(row => ({
      id:               Number(row.Id_Categoria),
      nombre:           String(row.Nombre),
      descripcion:      row.Descripcion      ? String(row.Descripcion) : null,
      imagenUrl:        row.Imagen_URL        ? String(row.Imagen_URL)  : null,
      categoriaPadreId: row.Id_CategoriaPadre ? Number(row.Id_CategoriaPadre) : null,
      totalProductos:   Number(row.Total_Productos ?? 0),
      subcategorias:    [], // se llena abajo
    }));

    // Armar árbol: padres con sus hijos anidados
    const mapa = Object.fromEntries(todas.map(c => [c.id, c]));
    const raices = [];

    for (const cat of todas) {
      if (cat.categoriaPadreId && mapa[cat.categoriaPadreId]) {
        mapa[cat.categoriaPadreId].subcategorias.push(cat);
      } else {
        raices.push(cat);
      }
    }

    return json({
      success: true,
      categorias: raices,        // árbol jerárquico
      todas,                     // lista plana (útil para selects/dropdowns)
    });

  } catch (error) {
    console.error("[GET /api/productos/categorias] Error:", error);
    return json({ success: false, error: "Error al obtener categorías" }, 500);
  }
}