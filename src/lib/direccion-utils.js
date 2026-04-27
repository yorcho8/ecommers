// src/lib/direccion-utils.js
// Ensures Direccion has the minimum columns required by /api/me/direcciones.

export async function ensureDireccionSchema(db) {
  if (!db || typeof db.execute !== "function") return;

  await db.execute(`
    CREATE TABLE IF NOT EXISTS Direccion (
      Id_Direccion integer PRIMARY KEY AUTOINCREMENT,
      Id_Usuario integer,
      Id_Empresa integer,
      Numero_casa integer NOT NULL,
      Calle text NOT NULL,
      Codigo_Postal integer NOT NULL,
      Ciudad text NOT NULL,
      Provincia text NOT NULL,
      Nombre_Direccion text,
      Pais text DEFAULT 'Mexico' NOT NULL
    )
  `);

  const pragma = await db.execute("PRAGMA table_info(Direccion)");
  const cols = new Set((pragma?.rows || []).map((row) => String(row.name || "")));

  const alterStatements = [];
  if (!cols.has("Nombre_Direccion")) {
    alterStatements.push("ALTER TABLE Direccion ADD COLUMN Nombre_Direccion text");
  }
  if (!cols.has("Pais")) {
    alterStatements.push("ALTER TABLE Direccion ADD COLUMN Pais text DEFAULT 'Mexico' NOT NULL");
  }

  for (const sql of alterStatements) {
    await db.execute(sql);
  }
}
