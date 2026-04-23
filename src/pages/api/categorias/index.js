import { createClient } from "@libsql/client";
import 'dotenv/config';

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN
});

export async function GET() {
  try {
    const result = await db.execute({
      sql: `SELECT Id_Categoria, Nombre, Descripcion, Imagen_URL FROM Categoria ORDER BY Nombre`,
      args: []
    });

    return new Response(
      JSON.stringify({
        success: true,
        categorias: result.rows
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error obteniendo categorías:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Error al obtener las categorías'
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}