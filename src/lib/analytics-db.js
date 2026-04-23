import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL || import.meta.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN || import.meta.env.TURSO_AUTH_TOKEN;

const db = createClient({ url, authToken });
let isInitialized = false;

async function ensureInit() {
  if (isInitialized) return;

  await db.batch(
    [
      { sql: "INSERT OR IGNORE INTO counters (key, value) VALUES ('totalSessions', 0), ('totalMessages', 0), ('totalWhatsApp', 0), ('totalPDFs', 0)", args: [] },
      { sql: "INSERT OR IGNORE INTO intents (intent, count) VALUES ('compra',0),('pdf',0),('info',0),('reclutamiento',0),('otro',0)", args: [] },
    ],
    'write'
  );

  const hourInitQueries = [];
  for (let i = 0; i < 24; i++) {
    hourInitQueries.push({ sql: 'INSERT OR IGNORE INTO hourly (hour, count) VALUES (?, 0)', args: [i] });
  }
  await db.batch(hourInitQueries, 'write');
  
  isInitialized = true;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTodayKey()   { return new Date().toISOString().split('T')[0]; }
function getCurrentHour(){ return new Date().getHours(); }

const KEYWORD_LIST = [
  'precio','cotizar','cotización','presupuesto','comprar','pedido',
  'rafia','stretch','cuerdas','sacos','arpillas','esquineros','flexible',
  'catálogo','pdf','ficha','envíame','descargar',
  'empleo','trabajo','vacante','cv',
  'certificación','calidad','entrega','medidas','colores',
];

const PRODUCT_LIST = [
  'rafia','stretch','cuerdas','cuerda','sacos','saco',
  'arpillas','arpilla','esquineros','esquinero','flexible','empaque',
];

export function detectKeywords(text) {
  const lower = text.toLowerCase();
  return KEYWORD_LIST.filter(kw => lower.includes(kw));
}

export function detectProduct(text) {
  const lower = text.toLowerCase();
  return PRODUCT_LIST.find(p => lower.includes(p)) || null;
}

export function detectIntent(text, accionWA, accionPDF) {
  if (accionWA)  return 'compra';
  if (accionPDF) return 'pdf';
  const lower = text.toLowerCase();
  if (/empleo|trabajo|vacante|cv|currículum/.test(lower)) return 'reclutamiento';
  if (/qué|cómo|para qué|qué es|cuál|tipo|tienen/.test(lower)) return 'info';
  return 'otro';
}

// ─── WRITE ──────────────────────────────────────────────────────────────────

export async function logInteraction({
  userMessage  = '',
  botReply     = '',
  accionWA     = false,
  accionPDF    = null,
  isNewSession = false,
  language     = 'es',
}) {
  await ensureInit();
  
  const today   = getTodayKey();
  const hour    = getCurrentHour();
  const intent  = detectIntent(userMessage, accionWA, accionPDF);
  const product = detectProduct(userMessage) || accionPDF || null;
  const keywords = detectKeywords(userMessage);

  const stmts = [];

  stmts.push({ sql: 'UPDATE counters SET value = value + ? WHERE key = ?', args: [1, 'totalMessages'] });
  if (isNewSession) stmts.push({ sql: 'UPDATE counters SET value = value + ? WHERE key = ?', args: [1, 'totalSessions'] });
  if (accionWA)     stmts.push({ sql: 'UPDATE counters SET value = value + ? WHERE key = ?', args: [1, 'totalWhatsApp'] });
  if (accionPDF)    stmts.push({ sql: 'UPDATE counters SET value = value + ? WHERE key = ?', args: [1, 'totalPDFs'] });

  stmts.push({
    sql: `INSERT INTO daily (date, sessions, messages, wa, pdf) VALUES (?, ?, 1, ?, ?)
          ON CONFLICT(date) DO UPDATE SET sessions = sessions + excluded.sessions, messages = messages + 1, wa = wa + excluded.wa, pdf = pdf + excluded.pdf`,
    args: [today, isNewSession ? 1 : 0, accionWA ? 1 : 0, accionPDF ? 1 : 0]
  });

  stmts.push({ sql: 'UPDATE hourly SET count = count + 1 WHERE hour = ?', args: [hour] });

  for (const kw of keywords) {
    stmts.push({ sql: 'INSERT INTO keywords (word,count) VALUES (?,1) ON CONFLICT(word) DO UPDATE SET count=count+1', args: [kw] });
  }
  
  if (product) {
    stmts.push({ sql: 'INSERT INTO products (name,count) VALUES (?,1) ON CONFLICT(name) DO UPDATE SET count=count+1', args: [product] });
  }
  
  stmts.push({ sql: 'UPDATE intents SET count = count + 1 WHERE intent = ?', args: [intent] });

  stmts.push({
    sql: "INSERT INTO messages (ts,user_msg,bot_reply,lang,intent,product) VALUES (datetime('now'),?,?,?,?,?)",
    args: [userMessage.substring(0, 120), botReply?.substring(0, 300) || null, language, intent, product]
  });

  // Ejecutamos todo de un solo golpe en la nube
  await db.batch(stmts, 'write');
}
// ─── RESET ──────────────────────────────────────────────────────────────────

export async function resetData() {
  await ensureInit();
  // Borramos todo de un solo golpe en Turso
  await db.batch([
    { sql: 'UPDATE counters SET value = 0', args: [] },
    { sql: 'DELETE FROM daily', args: [] },
    { sql: 'UPDATE hourly SET count = 0', args: [] },
    { sql: 'DELETE FROM products', args: [] },
    { sql: 'DELETE FROM keywords', args: [] },
    { sql: 'UPDATE intents SET count = 0', args: [] },
    { sql: 'DELETE FROM messages', args: [] }
  ], 'write');
}

// ─── READ ───────────────────────────────────────────────────────────────────

export async function readAllData() {
  await ensureInit();

  const countersRes = await db.execute('SELECT key, value FROM counters');
  const counters = Object.fromEntries(countersRes.rows.map(r => [r.key, r.value]));

  const dailyRes = await db.execute('SELECT date,sessions,messages,wa,pdf FROM daily ORDER BY date DESC LIMIT 90');
  const daily = {};
  for (const r of dailyRes.rows) daily[r.date] = { sessions: r.sessions, messages: r.messages, wa: r.wa, pdf: r.pdf };

  const hourlyRes = await db.execute('SELECT hour, count FROM hourly ORDER BY hour');
  const hourly = Array(24).fill(0);
  for (const r of hourlyRes.rows) hourly[r.hour] = r.count;

  const productsRes = await db.execute('SELECT name, count FROM products ORDER BY count DESC LIMIT 20');
  const products = Object.fromEntries(productsRes.rows.map(r => [r.name, r.count]));

  const keywordsRes = await db.execute('SELECT word, count FROM keywords ORDER BY count DESC LIMIT 30');
  const keywords = Object.fromEntries(keywordsRes.rows.map(r => [r.word, r.count]));

  const intentsRes = await db.execute('SELECT intent, count FROM intents');
  const intents = { compra: 0, pdf: 0, info: 0, reclutamiento: 0, otro: 0 };
  for (const r of intentsRes.rows) intents[r.intent] = r.count;

  const messagesRes = await db.execute(`
    SELECT ts, user_msg as user, bot_reply as bot, lang, intent, product as prod
    FROM messages
    ORDER BY id DESC
    LIMIT 100
  `);
  const lastMessages = messagesRes.rows.reverse();

  return {
    totalSessions: counters.totalSessions || 0,
    totalMessages: counters.totalMessages || 0,
    totalWhatsApp: counters.totalWhatsApp || 0,
    totalPDFs:     counters.totalPDFs     || 0,
    daily, hourly, products, keywords, intents, lastMessages,
  };
}
// ─── DISTRIBUIDOR LEADS ──────────────────────────────────────────────────────

async function ensureLeadsTable() {
  return true;
}

export async function saveLead({ nombre, empresa, whatsapp, email, productos }) {
  await ensureInit();
  await ensureLeadsTable();
  await db.execute({
    sql: `INSERT INTO distribuidor_leads (nombre, empresa, whatsapp, email, productos)
          VALUES (?, ?, ?, ?, ?)`,
    args: [nombre || '', empresa || '', whatsapp || '', email || '', productos || ''],
  });
}

export async function readLeads() {
  await ensureInit();
  await ensureLeadsTable();
  const res = await db.execute(
    `SELECT id, ts, nombre, empresa, whatsapp, email, productos
     FROM distribuidor_leads ORDER BY id DESC LIMIT 500`
  );
  return res.rows;
}

export async function resetLeads() {
  await ensureInit();
  await ensureLeadsTable();
  await db.execute({ sql: 'DELETE FROM distribuidor_leads', args: [] });
}