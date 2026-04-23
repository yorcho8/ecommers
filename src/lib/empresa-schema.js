import { ensureDbSchemaOnce } from "./schema-once.js";

async function executeSafe(db, sql) {
  try {
    await db.execute({ sql, args: [] });
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();
    const ignorable =
      message.includes("already exists") ||
      message.includes("duplicate column") ||
      message.includes("duplicate");
    if (!ignorable) throw error;
  }
}

export async function ensureEmpresaRegistrationSchema(db) {
  void db;
  return true;
}
