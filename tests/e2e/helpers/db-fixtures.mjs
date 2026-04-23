import { createClient } from "@libsql/client";
import "dotenv/config";

export function hasDbConfig() {
  const url = String(process.env.ECOMERS_DATABASE_URL || "").trim();
  const token = String(process.env.ECOMERS_AUTH_TOKEN || "").trim();
  return Boolean(url) && Boolean(token);
}

export function createDb() {
  if (!hasDbConfig()) {
    throw new Error("Missing ECOMERS_DATABASE_URL / ECOMERS_AUTH_TOKEN");
  }
  return createClient({
    url: process.env.ECOMERS_DATABASE_URL,
    authToken: process.env.ECOMERS_AUTH_TOKEN,
  });
}

export function nowIso() {
  return new Date().toISOString();
}

export function randTag(prefix = "e2e") {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

export async function tableExists(db, tableName) {
  const result = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    args: [tableName],
  });
  return result.rows.length > 0;
}

async function getColumns(db, tableName) {
  const result = await db.execute(`PRAGMA table_info(${tableName})`);
  return result.rows.map((row) => ({
    name: String(row.name || row.Name),
    type: String(row.type || row.Type || "").toUpperCase(),
    notNull: Number(row.notnull || row.NotNull || 0) === 1,
    defaultValue: row.dflt_value ?? row.DefaultValue ?? null,
    pk: Number(row.pk || row.PK || 0) === 1,
  }));
}

function inferValue(column, tableName) {
  const n = column.name.toLowerCase();
  const t = column.type;
  if (n.includes("fecha") || n.includes("created") || n.includes("updated") || n.endsWith("_at") || n.includes("expira")) {
    return nowIso();
  }
  if (n.includes("correo") || n.includes("email")) {
    return `${randTag(tableName)}@example.com`;
  }
  if (n.includes("contrasena") || n.includes("password")) {
    return "hash:salt:100000";
  }
  if (n.includes("rol")) {
    return "usuario";
  }
  if (n.includes("estado")) {
    return "pendiente";
  }
  if (n.includes("rfc")) {
    return "XAXX010101000";
  }
  if (n.includes("codigo_postal") || n.includes("cp")) {
    return 64000;
  }
  if (n.includes("telefono")) {
    return "5512345678";
  }
  if (t.includes("INT") || t.includes("REAL") || t.includes("NUM") || t.includes("DEC")) {
    return 0;
  }
  return `${tableName}_${column.name}_${Date.now()}`.slice(0, 120);
}

export async function insertRow(db, tableName, values) {
  const columns = await getColumns(db, tableName);
  const row = { ...values };

  for (const col of columns) {
    if (Object.prototype.hasOwnProperty.call(row, col.name)) continue;
    if (col.pk) continue;
    if (!col.notNull) continue;
    if (col.defaultValue != null) continue;
    row[col.name] = inferValue(col, tableName);
  }

  const keys = Object.keys(row);
  const placeholders = keys.map(() => "?").join(", ");
  const sql = `INSERT INTO ${tableName} (${keys.join(", ")}) VALUES (${placeholders})`;
  await db.execute({ sql, args: keys.map((k) => row[k]) });

  const pk = columns.find((c) => c.pk);
  if (pk && Object.prototype.hasOwnProperty.call(row, pk.name)) {
    return row[pk.name];
  }

  const idLike = columns.find((c) => /^id/i.test(c.name));
  if (idLike) {
    const lookup = await db.execute(`SELECT ${idLike.name} FROM ${tableName} ORDER BY ${idLike.name} DESC LIMIT 1`);
    if (lookup.rows.length) return Number(lookup.rows[0][idLike.name]);
  }
  return null;
}

export async function scalar(db, sql, args = []) {
  const result = await db.execute({ sql, args });
  if (!result.rows.length) return null;
  const row = result.rows[0];
  const firstKey = Object.keys(row)[0];
  return row[firstKey];
}
