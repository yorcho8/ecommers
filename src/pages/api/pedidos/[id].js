// src/pages/api/pedidos/[id].js
import { createClient } from "@libsql/client";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../../lib/session.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Signed go_session — not the forgeable plain-JSON authSession cookie. */
function getUserFromSession(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
  } catch {
    return null;
  }
}

// Whitelist of known table names. Never interpolate user input into PRAGMA.
const ALLOWED_TABLES = new Set(["Tarjeta", "Pedido", "Pago", "Producto", "Usuario"]);

async function getTableColumns(tableName) {
  if (!ALLOWED_TABLES.has(tableName)) throw new Error(`Tabla no permitida: ${tableName}`);
  const result = await db.execute({ sql: `PRAGMA table_info(${tableName})`, args: [] });
  return new Set(result.rows.map((row) => String(row.name || "")));
}

export async function GET({ params, cookies, request }) {
  try {
    const user = getUserFromSession(cookies);
    if (!user?.userId)
      return jsonResponse(401, { success: false, error: "No autenticado" });

    const url = new URL(request.url);
    const pedidoId = Number(params.id || url.searchParams.get("id"));
    if (!pedidoId || isNaN(pedidoId))
      return jsonResponse(400, { success: false, error: "ID de pedido inválido" });

    const pedidoRes = await db.execute({
      sql: `
        SELECT
          p.Id_Pedido, p.Numero_Pedido, p.Fecha_pedido, p.Estado,
          p.Costo_Envio, p.Total, p.Fecha_Entrega_estima, p.Notas_Cliente,
          d.Calle, d.Numero_casa, d.Ciudad, d.Provincia,
          d.Codigo_Postal, d.Pais, d.Nombre_Direccion
        FROM Pedido p
        JOIN Direccion d ON d.Id_Direccion = p.Id_Direccion
        WHERE p.Id_Pedido = ? AND p.Id_Usuario = ?
        LIMIT 1
      `,
      args: [pedidoId, user.userId],
    });

    if (!pedidoRes.rows.length)
      return jsonResponse(404, { success: false, error: "Pedido no encontrado" });

    const pr = pedidoRes.rows[0];

    const itemsRes = await db.execute({
      sql: `
        SELECT
          dp.Id_Detalle, dp.Id_Producto, dp.Cantidad, dp.Precio_Unitario,
          prod.Nombre, prod.Descripcion, prod.Peso,
          img.Url AS Imagen_URL
        FROM DetallePedido dp
        JOIN Producto prod ON prod.Id_Producto = dp.Id_Producto
        LEFT JOIN (
          SELECT Id_Producto, MIN(Id_Imagen) AS min_id
          FROM Imagen_Producto
          GROUP BY Id_Producto
        ) first_img ON first_img.Id_Producto = dp.Id_Producto
        LEFT JOIN Imagen_Producto img ON img.Id_Imagen = first_img.min_id
        WHERE dp.Id_Pedido = ?
        ORDER BY dp.Id_Detalle ASC
      `,
      args: [pedidoId],
    });

    const envioRes = await db.execute({
      sql: `
        SELECT Id_Envio, Numero_Guia, Estado_envio, Fecha_Envio, Fecha_Entrega
        FROM Envio
        WHERE Id_pedido = ?
        ORDER BY Id_Envio DESC
        LIMIT 1
      `,
      args: [pedidoId],
    });

    const tarjetaColumns = await getTableColumns("Tarjeta");
    const hasMesExpiracion = tarjetaColumns.has("Mes_Expiracion");
    const hasAnioExpiracion = tarjetaColumns.has("Anio_Expiracion");
    const hasFechaVencimiento = tarjetaColumns.has("Fecha_Vencimiento");

    const tarjetaExpSelect = ["t.Nombre_Titular"];
    if (hasMesExpiracion) tarjetaExpSelect.push("t.Mes_Expiracion");
    if (hasAnioExpiracion) tarjetaExpSelect.push("t.Anio_Expiracion");
    if (hasFechaVencimiento) tarjetaExpSelect.push("t.Fecha_Vencimiento");

    const pagoRes = await db.execute({
      sql: `
        SELECT
          pg.Id_Pago, pg.Metodo_Pago, pg.Estado_Pago, pg.Monto,
          pg.Codigo_Transaccion, pg.Fecha_Pago, pg.Marca_Tarjeta,
          pg.Tipo_Financiamiento, pg.Ultimos4,
          ${tarjetaExpSelect.join(", ")}
        FROM Pago pg
        LEFT JOIN Tarjeta t ON t.ID_Tarjeta = pg.ID_Tarjeta
        WHERE pg.Id_Pedido = ?
        ORDER BY pg.Id_Pago DESC
        LIMIT 1
      `,
      args: [pedidoId],
    });

    const items = itemsRes.rows.map((r) => ({
      id: Number(r.Id_Detalle),
      productoId: Number(r.Id_Producto),
      nombre: String(r.Nombre || ""),
      descripcion: String(r.Descripcion || ""),
      cantidad: Number(r.Cantidad || 0),
      precioUnitario: Number(r.Precio_Unitario || 0),
      subtotal: Number(r.Cantidad || 0) * Number(r.Precio_Unitario || 0),
      imagen: r.Imagen_URL ? String(r.Imagen_URL) : null,
    }));

    const subtotalProductos = items.reduce((s, i) => s + i.subtotal, 0);
    const costoEnvio = Number(pr.Costo_Envio || 0);

    const envio = envioRes.rows.length
      ? {
          guia: String(envioRes.rows[0].Numero_Guia || ""),
          estado: String(envioRes.rows[0].Estado_envio || ""),
          fechaEnvio: envioRes.rows[0].Fecha_Envio ? String(envioRes.rows[0].Fecha_Envio) : null,
          fechaEntrega: envioRes.rows[0].Fecha_Entrega ? String(envioRes.rows[0].Fecha_Entrega) : null,
        }
      : null;

    const pago = pagoRes.rows.length
      ? (() => {
          const pagoRow = pagoRes.rows[0];
          let vencimiento = null;

          if (pagoRow.Mes_Expiracion || pagoRow.Anio_Expiracion) {
            const mes = String(pagoRow.Mes_Expiracion || "").padStart(2, "0");
            const anio = String(pagoRow.Anio_Expiracion || "").slice(-2);
            if (mes.trim() && anio.trim()) vencimiento = `${mes}/${anio}`;
          }

          if (!vencimiento && pagoRow.Fecha_Vencimiento) {
            vencimiento = String(pagoRow.Fecha_Vencimiento);
          }

          return {
          metodo: String(pagoRes.rows[0].Metodo_Pago || ""),
          estado: String(pagoRes.rows[0].Estado_Pago || ""),
          monto: Number(pagoRes.rows[0].Monto || 0),
          transaccion: pagoRes.rows[0].Codigo_Transaccion ? String(pagoRes.rows[0].Codigo_Transaccion) : null,
          fecha: String(pagoRes.rows[0].Fecha_Pago || ""),
          marca: pagoRes.rows[0].Marca_Tarjeta ? String(pagoRes.rows[0].Marca_Tarjeta) : null,
          tipoFinanciamiento: pagoRes.rows[0].Tipo_Financiamiento ? String(pagoRes.rows[0].Tipo_Financiamiento) : null,
          ultimos4: pagoRes.rows[0].Ultimos4 ? String(pagoRes.rows[0].Ultimos4).slice(-4) : null,
          titular: pagoRes.rows[0].Nombre_Titular ? String(pagoRes.rows[0].Nombre_Titular) : null,
          vencimiento,
        };
        })()
      : null;

    return jsonResponse(200, {
      success: true,
      pedido: {
        id: Number(pr.Id_Pedido),
        numero: Number(pr.Numero_Pedido),
        fecha: String(pr.Fecha_pedido),
        estado: String(pr.Estado),
        costoEnvio,
        subtotalProductos: Number(subtotalProductos.toFixed(2)),
        total: Number(pr.Total || 0),
        fechaEntregaEstimada: pr.Fecha_Entrega_estima ? String(pr.Fecha_Entrega_estima) : null,
        notasCliente: pr.Notas_Cliente ? String(pr.Notas_Cliente) : null,
        direccion: {
          nombre: pr.Nombre_Direccion ? String(pr.Nombre_Direccion) : null,
          calle: `${pr.Calle} #${pr.Numero_casa}`,
          ciudad: String(pr.Ciudad || ""),
          estado: String(pr.Provincia || ""),
          cp: String(pr.Codigo_Postal || ""),
          pais: String(pr.Pais || "México"),
        },
        items,
        envio,
        pago,
      },
    });
  } catch (error) {
    console.error("[GET /api/pedidos/[id]] Error:", error);
    return jsonResponse(500, {
      success: false,
      error: error?.message || "Error interno del servidor",
    });
  }
}