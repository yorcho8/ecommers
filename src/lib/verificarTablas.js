import { createClient } from "@libsql/client";
import 'dotenv/config';

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN
});

async function verificarTablas() {
  try {
    console.log('Verificando tablas existentes...');

    // Verificar tabla Producto
    const productoResult = await db.execute(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='Producto'
    `);
    console.log('Tabla Producto existe:', productoResult.rows.length > 0);

    // Mostrar esquema de Imagen_Producto si existe
    const imagenProductoResult = await db.execute(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='Imagen_Producto'
    `);
    console.log('Tabla Imagen_Producto existe:', imagenProductoResult.rows.length > 0);

    if (imagenProductoResult.rows.length > 0) {
      const schemaResult = await db.execute(`
        PRAGMA table_info(Imagen_Producto)
      `);
      console.log('Esquema de Imagen_Producto:', schemaResult.rows);
    }

    // Mostrar esquema de ProductoCategoria si existe
    if (productoCategoriaResult.rows.length > 0) {
      const schemaResult = await db.execute(`
        PRAGMA table_info(ProductoCategoria)
      `);
      console.log('Esquema de ProductoCategoria:', schemaResult.rows);
    }

    // Mostrar todas las tablas
    const allTables = await db.execute(`
      SELECT name FROM sqlite_master WHERE type='table'
    `);
    console.log('Todas las tablas:', allTables.rows.map(row => row.name));

  } catch (err) {
    console.error("Error verificando tablas:", err);
  }
}

verificarTablas();