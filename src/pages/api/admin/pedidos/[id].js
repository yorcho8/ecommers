/**
 * GET  /api/admin/pedidos/:id  — Obtener pedido por ID
 * PATCH /api/admin/pedidos/:id  — Cambiar estado del pedido
 *
 * Auth: admin o superusuario
 */
import { createClient } from "@libsql/client";
import Stripe from "stripe";
import "dotenv/config";
import {
  sendShippingNotification,
  sendOrderStatusNotification,
} from "../../../../lib/mail.js";
import { verifySessionToken, SESSION_COOKIE } from "../../../../lib/session.js";

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY
);

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

const ESTADOS_VALIDOS = new Set(["pagado", "enviado", "entregado", "cancelado", "procesando"]);

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

export async function GET({ params, cookies }) {
  const user = getPrivilegedUser(cookies);
  if (!user) return json({ success: false, error: "Acceso denegado" }, 403);

  const pedidoId = Number(params.id || 0);
  if (!pedidoId) return json({ success: false, error: "ID de pedido inválido" }, 400);

  try {
    const result = await db.execute({
      sql: `
        SELECT
          p.Id_Pedido, p.Numero_Pedido, p.Estado, p.Total, p.Costo_Envio,
          p.Fecha_pedido, p.Fecha_Entrega_estima, p.Notas_Cliente,
          u.Nombre AS UsuarioNombre, u.Correo AS UsuarioCorreo,
          e.Numero_Guia, e.Estado_envio, e.Carrier
        FROM Pedido p
        JOIN Usuario u ON u.Id = p.Id_Usuario
        LEFT JOIN Envio e ON e.Id_pedido = p.Id_Pedido
        WHERE p.Id_Pedido = ?
        LIMIT 1
      `,
      args: [pedidoId],
    });

    if (!result.rows.length) {
      return json({ success: false, error: "Pedido no encontrado" }, 404);
    }

    const row = result.rows[0];
    const detalles = await db.execute({
      sql: `
        SELECT dp.Id_Producto, dp.Cantidad, dp.Precio_Unitario, pr.Nombre
        FROM DetallePedido dp
        JOIN Producto pr ON pr.Id_Producto = dp.Id_Producto
        WHERE dp.Id_Pedido = ?
      `,
      args: [pedidoId],
    });

    return json({
      success: true,
      pedido: {
        id:               Number(row.Id_Pedido),
        numero:           String(row.Numero_Pedido || ""),
        estado:           String(row.Estado || ""),
        total:            Number(row.Total || 0),
        costoEnvio:       Number(row.Costo_Envio || 0),
        fechaPedido:      String(row.Fecha_pedido || ""),
        fechaEntregaEst:  row.Fecha_Entrega_estima ? String(row.Fecha_Entrega_estima) : null,
        notasCliente:     row.Notas_Cliente ? String(row.Notas_Cliente) : null,
        usuario:          { nombre: String(row.UsuarioNombre || ""), correo: String(row.UsuarioCorreo || "") },
        envio: row.Numero_Guia ? {
          guia:    String(row.Numero_Guia),
          estado:  String(row.Estado_envio || ""),
          carrier: String(row.Carrier || ""),
        } : null,
        detalles: detalles.rows.map((d) => ({
          productoId:     Number(d.Id_Producto),
          nombre:         String(d.Nombre || ""),
          cantidad:       Number(d.Cantidad || 0),
          precioUnitario: Number(d.Precio_Unitario || 0),
        })),
      },
    });
  } catch (error) {
    console.error("[GET /api/admin/pedidos/:id]", error);
    return json({ success: false, error: "Error obteniendo el pedido" }, 500);
  }
}

export async function PATCH({ params, request, cookies }) {
  const user = getPrivilegedUser(cookies);
  if (!user) return json({ success: false, error: "Acceso denegado" }, 403);

  const pedidoId = Number(params.id || 0);
  if (!pedidoId) return json({ success: false, error: "ID de pedido inválido" }, 400);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "JSON inválido" }, 400);
  }

  const nuevoEstado = String(body?.estado || "").toLowerCase().trim();
  if (!nuevoEstado || !ESTADOS_VALIDOS.has(nuevoEstado)) {
    return json({
      success: false,
      error: `Estado inválido. Valores permitidos: ${[...ESTADOS_VALIDOS].join(", ")}`,
    }, 400);
  }

  try {
    // Fetch current order + user info
    const found = await db.execute({
      sql: `
        SELECT p.Id_Pedido, p.Numero_Pedido, p.Estado, p.Id_Usuario,
               u.Correo AS UsuarioCorreo, u.Nombre AS UsuarioNombre,
               e.Numero_Guia, e.Carrier
        FROM Pedido p
        JOIN Usuario u ON u.Id = p.Id_Usuario
        LEFT JOIN Envio e ON e.Id_pedido = p.Id_Pedido
        WHERE p.Id_Pedido = ?
        LIMIT 1
      `,
      args: [pedidoId],
    });

    if (!found.rows.length) {
      return json({ success: false, error: "Pedido no encontrado" }, 404);
    }

    const pedido = found.rows[0];
    const estadoActual = String(pedido.Estado || "").toLowerCase();

    // Prevent re-applying the same state
    if (estadoActual === nuevoEstado) {
      return json({ success: false, error: `El pedido ya está en estado '${nuevoEstado}'` }, 409);
    }

    const now = new Date().toISOString();
    await db.execute({
      sql: `UPDATE Pedido SET Estado = ?, Fecha_Actualizacion = ? WHERE Id_Pedido = ?`,
      args: [nuevoEstado, now, pedidoId],
    });

    // If state changed to "enviado", send shipping notification to customer
    if (nuevoEstado === "enviado") {
      const guia    = pedido.Numero_Guia ? String(pedido.Numero_Guia) : "PENDIENTE";
      const carrier = pedido.Carrier ? String(pedido.Carrier) : "";
      const correo  = String(pedido.UsuarioCorreo || "").trim().toLowerCase();
      const nombre  = String(pedido.UsuarioNombre || "Cliente").trim();

      if (correo) {
        try {
          await sendShippingNotification({
            to:          correo,
            name:        nombre,
            orderNumber: String(pedido.Numero_Pedido || pedidoId),
            guia,
            carrier,
            trackUrl:    guia !== "PENDIENTE"
              ? `${process.env.APP_URL || "http://localhost:4321"}/es/mi-cuenta/pedidos`
              : "",
          });
        } catch (mailErr) {
          console.error("[PATCH /api/admin/pedidos/:id] Error enviando email de envío:", mailErr);
        }
      }
    }

    // Notifications for other state changes
    if (["procesando", "entregado", "cancelado"].includes(nuevoEstado)) {
      const correo = String(pedido.UsuarioCorreo || "").trim().toLowerCase();
      const nombre = String(pedido.UsuarioNombre || "Cliente").trim();
      if (correo) {
        // Fetch order total for the email
        let orderTotal = 0;
        try {
          const totalRes = await db.execute({
            sql: `SELECT Total FROM Pedido WHERE Id_Pedido = ? LIMIT 1`,
            args: [pedidoId],
          });
          orderTotal = Number(totalRes.rows[0]?.Total || 0);
        } catch (_) {}

        sendOrderStatusNotification({
          to:          correo,
          name:        nombre,
          orderNumber: String(pedido.Numero_Pedido || pedidoId),
          estado:      nuevoEstado,
          total:       orderTotal,
        }).catch((e) => console.error("[PATCH /api/admin/pedidos/:id] email estado:", e));
      }
    }

    // Auto-refund via Stripe when admin cancels a paid order
    let refundResult = null;
    if (nuevoEstado === "cancelado") {
      try {
        const pagoRes = await db.execute({
          sql: `SELECT Id_Pago, Codigo_Transaccion, Monto, Estado_Pago FROM Pago WHERE Id_Pedido = ? LIMIT 1`,
          args: [pedidoId],
        });
        if (pagoRes.rows.length) {
          const pago = pagoRes.rows[0];
          const pagoEstado = String(pago.Estado_Pago || "").toLowerCase();
          const isRefundable = ["aprobado", "pagado", "capturado"].includes(pagoEstado);
          const piId = String(pago.Codigo_Transaccion || "").trim();

          if (isRefundable && piId.startsWith("pi_")) {
            const refund = await stripe.refunds.create({
              payment_intent: piId,
              reason: "requested_by_customer",
              metadata: { source: "admin_cancelacion", pedido_id: String(pedidoId) },
            });
            const refundStatus = String(refund.status || "pending");
            const estadoReembolso = refundStatus === "succeeded" ? "completado" : refundStatus === "failed" ? "fallido" : "pendiente";
            const estadoPago = refundStatus === "succeeded" ? "reembolsado" : refundStatus === "failed" ? "reembolso_fallido" : "reembolso_pendiente";
            await db.execute({
              sql: `UPDATE Pago SET Estado_Pago = ?, Estado_Reembolso = ?, Stripe_Refund_Id = ?, Fecha_Reembolso = ? WHERE Id_Pago = ?`,
              args: [estadoPago, estadoReembolso, String(refund.id || ""), now, Number(pago.Id_Pago)],
            });
            refundResult = { intentado: true, exitoso: true, refundId: refund.id, estado: refundStatus };
          }
        }
      } catch (refundErr) {
        console.error("[PATCH /api/admin/pedidos/:id] Error en reembolso Stripe:", refundErr);
        refundResult = { intentado: true, exitoso: false, error: refundErr?.message };
      }
    }

    return json({
      success:  true,
      message:  `Estado del pedido actualizado a '${nuevoEstado}'`,
      pedidoId,
      estadoAnterior: estadoActual,
      estadoNuevo:    nuevoEstado,
      reembolso:      refundResult,
    });
  } catch (error) {
    console.error("[PATCH /api/admin/pedidos/:id]", error);
    return json({ success: false, error: "Error actualizando el pedido" }, 500);
  }
}
