require("dotenv").config();
const { createClient } = require("@libsql/client");
(async () => {
  const db = createClient({ url: process.env.ECOMERS_DATABASE_URL, authToken: process.env.ECOMERS_AUTH_TOKEN });
  const r = await db.execute(`SELECT p.Id_Producto,p.Nombre,p.Precio,d.Tipo,d.Valor,d.Fecha_Inicio,d.Fecha_Fin,d.Activo FROM Producto p JOIN DescuentoProducto dp ON dp.Id_Producto=p.Id_Producto JOIN Descuento d ON d.Id_Descuento=dp.Id_Descuento WHERE COALESCE(p.Activo,1)=1 AND COALESCE(d.Activo,1)=1 ORDER BY d.Id_Descuento DESC`);
  const nowMs = Date.now();
  const parse = (v)=>{ if(!v) return NaN; const n=String(v).trim().replace(" ","T"); const ms=Date.parse(n); return Number.isFinite(ms)?ms:NaN; };
  const active = r.rows.filter(x=>{ const i=parse(x.Fecha_Inicio); const f=parse(x.Fecha_Fin); return !Number.isNaN(i)&&!Number.isNaN(f)&&nowMs>=i&&nowMs<=f;});
  console.log('NOW', new Date(nowMs).toISOString());
  console.log('ACTIVE_COUNT', active.length);
  console.log(JSON.stringify(active,null,2));
})();
