import { createClient } from "@libsql/client";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../../../lib/session.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Signed go_session — not the forgeable plain-JSON authSession cookie. */
function getPrivilegedUser(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const user = verifySessionToken(token);
    const role = String(user?.rol || "").toLowerCase();
    if (role === "admin" || role === "superusuario") return user;
    return null;
  } catch {
    return null;
  }
}

async function ensurePaymentSchema() {
  return true;
}

export async function GET({ cookies }) {
  const user = getPrivilegedUser(cookies);
  if (!user) return json({ success: false, error: "Acceso denegado" }, 403);

  try {
    await ensurePaymentSchema();

    const rol          = String(user?.rol || "").toLowerCase();
    const esSuperAdmin = rol === "superusuario";
    const userId       = user?.userId;

    let empresaId = null;
    if (!esSuperAdmin && userId) {
      const empresaRes = await db.execute({
        sql: `SELECT Id_Empresa FROM UsuarioEmpresa WHERE Id_Usuario = ? AND Activo = 1 LIMIT 1`,
        args: [userId],
      });
      if (empresaRes.rows.length) empresaId = Number(empresaRes.rows[0].Id_Empresa);
    }

    // ── Query principal de pedidos ──
    const result = await db.execute({
      sql: `
        SELECT
          p.Id_Pedido,
          p.Numero_Pedido,
          p.Fecha_pedido,
          p.Estado,
          p.Costo_Envio,
          p.Total,
          p.Notas_Cliente,

          u.Id AS UsuarioId,
          u.Nombre,
          u.Apellido_Paterno,
          u.Apellido_Materno,
          u.Correo,
          u.Telefono,

          d.Numero_casa,
          d.Calle,
          d.Codigo_Postal,
          d.Ciudad,
          d.Provincia,
          d.Pais,

          pg.Id_Pago,
          pg.Metodo_Pago,
          pg.Estado_Pago,
          pg.Monto,
          pg.Codigo_Transaccion,
          pg.Fecha_Pago,
          pg.Marca_Tarjeta,
          pg.Tipo_Financiamiento,
          pg.Ultimos4,

          COALESCE((
            SELECT SUM(dp.Cantidad)
            FROM DetallePedido dp
            WHERE dp.Id_Pedido = p.Id_Pedido
          ), 0) AS Cantidad_Total

        FROM Pedido p
        JOIN Usuario u ON u.Id = p.Id_Usuario
        LEFT JOIN Direccion d ON d.Id_Direccion = p.Id_Direccion
        LEFT JOIN Pago pg ON pg.Id_Pedido = p.Id_Pedido
        WHERE (
          ? = 0
          OR EXISTS (
            SELECT 1
            FROM DetallePedido dp
            JOIN Producto pr ON pr.Id_Producto = dp.Id_Producto
            WHERE dp.Id_Pedido = p.Id_Pedido
              AND pr.Id_Empresa = ?
          )
        )
        ORDER BY p.Fecha_pedido DESC, p.Id_Pedido DESC
      `,
      args: [empresaId ? 1 : 0, empresaId || 0],
    });

    if (!result.rows.length) return json({ success: true, pedidos: [] });

    // ── Query de items con variante para todos los pedidos ──
    const pedidoIds = result.rows.map(r => Number(r.Id_Pedido));
    const placeholders = pedidoIds.map(() => "?").join(",");

    const itemsResult = await db.execute({
      sql: `
        SELECT
          dp.Id_Pedido,
          dp.Id_Producto,
          dp.Cantidad,
          dp.Precio_Unitario,
          pr.Nombre AS NombreProducto,
          pv.Descripcion AS DescripcionVariante
        FROM DetallePedido dp
        JOIN Producto pr ON pr.Id_Producto = dp.Id_Producto
        LEFT JOIN ProductoVariante pv ON pv.Id_Variante = dp.Id_Variante
        WHERE dp.Id_Pedido IN (${placeholders})
          AND (? = 0 OR pr.Id_Empresa = ?)
        ORDER BY dp.Id_Detalle ASC
      `,
      args: [...pedidoIds, empresaId ? 1 : 0, empresaId || 0],
    });

    // Agrupar items por pedido
    const itemsMap = {};
    for (const row of itemsResult.rows) {
      const pid = Number(row.Id_Pedido);
      if (!itemsMap[pid]) itemsMap[pid] = [];
      itemsMap[pid].push({
        productoId:      Number(row.Id_Producto),
        nombre:          String(row.NombreProducto || ""),
        variante:        row.DescripcionVariante ? String(row.DescripcionVariante) : null,
        cantidad:        Number(row.Cantidad || 0),
        precioUnitario:  Number(row.Precio_Unitario || 0),
        subtotal:        Number(row.Cantidad || 0) * Number(row.Precio_Unitario || 0),
      });
    }

    // ── Armar respuesta ──
    const pedidos = result.rows.map((row) => {
      const pid = Number(row.Id_Pedido);
      const items = itemsMap[pid] || [];

      const nombreCompleto = [
        String(row.Nombre || "").trim(),
        String(row.Apellido_Paterno || "").trim(),
        String(row.Apellido_Materno || "").trim(),
      ].filter(Boolean).join(" ");

      const direccionCompleta = [
        row.Calle ? `Calle ${row.Calle}` : "",
        row.Numero_casa != null ? `No. ${row.Numero_casa}` : "",
        row.Ciudad ? String(row.Ciudad) : "",
        row.Provincia ? String(row.Provincia) : "",
        row.Codigo_Postal != null ? `CP ${row.Codigo_Postal}` : "",
      ].filter(Boolean).join(", ");

      // Resumen para búsqueda
      const resumenItems = items
        .map(it => `${it.nombre}${it.variante ? ` (${it.variante})` : ""} x${it.cantidad}`)
        .join(" | ");

      return {
        id:            pid,
        numeroPedido:  Number(row.Numero_Pedido || 0),
        fechaPedido:   row.Fecha_pedido,
        estadoPedido:  String(row.Estado || "").toLowerCase(),
        notas:         row.Notas_Cliente || "",

        usuario: {
          id:             Number(row.UsuarioId),
          nombreCompleto,
          correo:         String(row.Correo || ""),
          telefono:       String(row.Telefono || ""),
        },

        direccion: {
          calle:        row.Calle ? `${row.Calle} ${row.Numero_casa || ""}`.trim() : "",
          ciudad:       String(row.Ciudad || ""),
          estado:       String(row.Provincia || ""),
          cp:           row.Codigo_Postal ? String(row.Codigo_Postal) : "",
          pais:         String(row.Pais || "México"),
          completa:     direccionCompleta || "Sin dirección",
        },

        pago: {
          idPago:             row.Id_Pago == null ? null : Number(row.Id_Pago),
          metodo:             String(row.Metodo_Pago || "").toLowerCase(),
          estado:             String(row.Estado_Pago || "").toLowerCase(),
          monto:              Number(row.Monto || row.Total || 0),
          transaccion:        row.Codigo_Transaccion || null,
          fechaPago:          row.Fecha_Pago || null,
          marcaTarjeta:       String(row.Marca_Tarjeta || ""),
          tipoFinanciamiento: String(row.Tipo_Financiamiento || "no_definido").toLowerCase(),
          ultimos4:           String(row.Ultimos4 || ""),
        },

        items,
        resumenItems,
        cantidadTotal:    Number(row.Cantidad_Total || 0),
        subtotalProductos: Number(items.reduce((s, i) => s + i.subtotal, 0).toFixed(2)),
        costoEnvio:       Number(row.Costo_Envio || 0),
        totalPedido:      Number(row.Total || 0),
      };
    });

    return json({ success: true, pedidos });
  } catch (error) {
    console.error("[GET /api/admin/pedidos] Error:", error);
    return json({ success: false, error: "Error obteniendo pedidos" }, 500);
  }
}