require("dotenv").config();
const { createClient } = require("@libsql/client");
(async () => {
  const db = createClient({
    url: process.env.ECOMERS_DATABASE_URL,
    authToken: process.env.ECOMERS_AUTH_TOKEN,
  });
  const sql = "SELECT d.Id_Descuento,d.Nombre,d.Tipo,d.Valor,d.Fecha_Inicio,d.Fecha_Fin,d.Activo,dp.Id_Producto,p.Nombre AS Producto FROM Descuento d JOIN DescuentoProducto dp ON dp.Id_Descuento=d.Id_Descuento JOIN Producto p ON p.Id_Producto=dp.Id_Producto ORDER BY d.Id_Descuento DESC LIMIT 10";
  const r = await db.execute(sql);
  console.log(JSON.stringify(r.rows, null, 2));
})();
