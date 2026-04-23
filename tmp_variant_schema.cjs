const { createClient } = require('@libsql/client');
require('dotenv/config');
(async () => {
  const db = createClient({
    url: process.env.ECOMERS_DATABASE_URL,
    authToken: process.env.ECOMERS_AUTH_TOKEN,
  });
  const t = await db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='ProductoVariante'");
  console.log('TABLE_SQL:\n' + (t.rows[0]?.sql || 'NOT_FOUND'));
  const cols = await db.execute("PRAGMA table_info(ProductoVariante)");
  console.log('\nCOLUMNS:');
  for (const c of cols.rows) {
    console.log(`${c.cid}. ${c.name} ${c.type} notnull=${c.notnull} dflt=${c.dflt_value}`);
  }
})();
