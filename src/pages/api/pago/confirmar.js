import Stripe from "stripe";
import { createClient } from "@libsql/client";
import "dotenv/config";
import { ensureProductVisibilitySchema } from "../../../lib/product-visibility.js";
import { verifySessionToken, SESSION_COOKIE } from "../../../lib/session.js";
import { generarEtiquetaEnvia } from "../../../lib/envia-shipping.js";
import { generarGuiaPaquetexpress } from "../../../lib/paquetexpress-shipping.js";
import { getActiveDiscountMap, resolveEffectiveUnitPrice, toMoney } from "../../../lib/pricing.js";
import {
  sendOrderConfirmation,
  sendShippingNotification,
  sendLowStockAlert,
  sendEmpresaNewOrderAlert,
} from "../../../lib/mail.js";

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY
);

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

let schemaInitPromise = null;

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function formatPickupEstimate(deliveryDate, deliveryEstimate, nowIso) {
  if (deliveryEstimate) return String(deliveryEstimate);
  if (deliveryDate) {
    const d = new Date(String(deliveryDate));
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString("es-MX", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
    }
  }
  const base = new Date(String(nowIso || new Date().toISOString()));
  base.setDate(base.getDate() + 1);
  return `aprox. ${base.toLocaleDateString("es-MX", { weekday: "short", day: "2-digit", month: "short" })}`;
}

async function getEmpresaOwnerOrderGroups(orderId) {
  const result = await db.execute({
    sql: `
      SELECT
        emp.Id_Empresa,
        emp.Nombre_Empresa,
        u.Id AS OwnerId,
        u.Nombre AS OwnerNombre,
        u.Correo AS OwnerCorreo,
        pr.Nombre AS ProductoNombre,
        dp.Cantidad,
        dp.Precio_Unitario
      FROM DetallePedido dp
      JOIN Producto pr ON pr.Id_Producto = dp.Id_Producto
      JOIN Empresa emp ON emp.Id_Empresa = pr.Id_Empresa
      LEFT JOIN UsuarioEmpresa ue
        ON ue.Id_Empresa = emp.Id_Empresa
       AND ue.Activo = 1
       AND LOWER(COALESCE(ue.Rol_Empresa, '')) IN ('admin','propietario','dueno','dueño','owner')
      LEFT JOIN Usuario u ON u.Id = ue.Id_Usuario
      WHERE dp.Id_Pedido = ?
      ORDER BY emp.Id_Empresa ASC, dp.Id_Detalle ASC
    `,
    args: [orderId],
  });

  const byEmpresa = new Map();
  for (const row of result.rows) {
    const empresaId = Number(row.Id_Empresa || 0);
    if (!empresaId) continue;

    if (!byEmpresa.has(empresaId)) {
      byEmpresa.set(empresaId, {
        empresaId,
        empresaNombre: String(row.Nombre_Empresa || ""),
        ownerNombre: String(row.OwnerNombre || "Administrador"),
        ownerCorreo: String(row.OwnerCorreo || "").trim().toLowerCase(),
        items: [],
      });
    }

    const grp = byEmpresa.get(empresaId);
    grp.items.push({
      nombre: String(row.ProductoNombre || "Producto"),
      cantidad: Number(row.Cantidad || 0),
      precioUnitario: Number(row.Precio_Unitario || 0),
      subtotal: Number(row.Cantidad || 0) * Number(row.Precio_Unitario || 0),
    });
  }

  return [...byEmpresa.values()].filter((g) => g.ownerCorreo);
}
/** Uses the signed, HttpOnly go_session cookie — not the forgeable authSession. */
function getUserFromSession(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
  } catch {
    return null;
  }
}

async function getOrCreateCartId(userId) {
  const cart = await db.execute({
    sql: `SELECT Id_Carrito FROM Carrito WHERE Id_Usuario = ? LIMIT 1`,
    args: [userId],
  });
  if (cart.rows.length) return Number(cart.rows[0].Id_Carrito);

  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO Carrito (Id_Usuario, Fecha_Creacion) VALUES (?, ?)`,
    args: [userId, now],
  });
  const created = await db.execute({
    sql: `SELECT Id_Carrito FROM Carrito WHERE Id_Usuario = ? ORDER BY Id_Carrito DESC LIMIT 1`,
    args: [userId],
  });
  return Number(created.rows[0].Id_Carrito);
}

async function getCartItems(cartId, userId) {
  const result = await db.execute({
    sql: `
      SELECT
        ic.id_Item_Carrito,
        ic.Id_Producto,
        ic.Id_Variante,
        ic.Cantidad,
        ic.Precio_Unitario,
        p.Precio AS Precio_Base,
        pv.Precio AS Precio_Variante,
        p.StockDisponible,
        COALESCE(p.Peso, 0.5) AS Peso,
        p.Especificaciones
      FROM ItemCarrito ic
      JOIN Producto p ON p.Id_Producto = ic.Id_Producto
      LEFT JOIN ProductoVariante pv ON pv.Id_Variante = ic.Id_Variante
      WHERE ic.Id_Carrito = ?
        AND COALESCE(p.Activo, 1) = 1
        AND NOT EXISTS (
          SELECT 1
          FROM ProductoVisibilidadUsuario pvu
          WHERE pvu.Id_Producto = p.Id_Producto
            AND pvu.Id_Usuario = ?
            AND pvu.Visible = 0
        )
      ORDER BY ic.id_Item_Carrito DESC
    `,
    args: [cartId, userId],
  });

  const discountMap = await getActiveDiscountMap(
    db,
    result.rows.map((row) => Number(row.Id_Producto || 0))
  );

  return result.rows.map((row) => {
    const cantidad = Number(row.Cantidad || 0);
    const variantPrice = row.Precio_Variante == null ? null : Number(row.Precio_Variante);
    const basePrice = variantPrice == null ? Number(row.Precio_Base || row.Precio_Unitario || 0) : variantPrice;
    const precio = resolveEffectiveUnitPrice(basePrice, Number(row.Id_Producto || 0), discountMap);
    return {
      itemId:          Number(row.id_Item_Carrito),
      productoId:      Number(row.Id_Producto),
      varianteId:      row.Id_Variante ? Number(row.Id_Variante) : null,
      cantidad,
      precioUnitario:  toMoney(precio),
      subtotal:        toMoney(cantidad * precio),
      peso:            Number(row.Peso || 0.5),
      especificaciones: row.Especificaciones ? String(row.Especificaciones) : null,
      stockDisponible: row.StockDisponible == null ? null : Number(row.StockDisponible),
    };
  });
}

async function findUserCard(userId, cardId) {
  const result = await db.execute({
    sql: `
      SELECT ID_Tarjeta, Stripe_Payment_Method_Id, Ultimos4,
             Marca, Mes_Expiracion, Anio_Expiracion,
             Nombre_Titular, Tipo_Financiamiento
      FROM Tarjeta
      WHERE ID_Tarjeta = ? AND Id_Usuario = ?
      LIMIT 1
    `,
    args: [cardId, userId],
  });
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    id:                 Number(row.ID_Tarjeta),
    stripeMethodId:     String(row.Stripe_Payment_Method_Id || ""),
    tipo:               String(row.Marca || "tarjeta").toLowerCase(),
    tipoFinanciamiento: String(row.Tipo_Financiamiento || "no_definido").toLowerCase(),
    titular:            String(row.Nombre_Titular || ""),
    ultimos4:           String(row.Ultimos4 || ""),
    vencimiento:        `${String(row.Mes_Expiracion || "").padStart(2, "0")}/${String(row.Anio_Expiracion || "").slice(-2)}`,
  };
}

async function findUserAddressDetails(addressId) {
  const result = await db.execute({
    sql: `SELECT Calle, Numero_casa, Codigo_Postal, Ciudad, Provincia
          FROM Direccion WHERE Id_Direccion = ? LIMIT 1`,
    args: [addressId],
  });
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    calle:  String(row.Calle || ""),
    numero: row.Numero_casa != null ? String(row.Numero_casa) : "S/N",
    ciudad: String(row.Ciudad || ""),
    estado: String(row.Provincia || ""),
    cp:     String(row.Codigo_Postal || ""),
  };
}

async function ensurePaymentSchema() {
  return true;
}

async function ensureShippingSchema() {
  return true;
}

async function ensureSchemasReady() {
  if (!schemaInitPromise) {
    schemaInitPromise = (async () => {
      await ensurePaymentSchema();
      await ensureShippingSchema();
    })().catch((error) => {
      schemaInitPromise = null;
      throw error;
    });
  }
  return schemaInitPromise;
}

export async function POST({ request, cookies }) {
  try {
    const user = getUserFromSession(cookies);
    if (!user?.userId)
      return jsonResponse(401, { success: false, error: "No autenticado" });

    const body = await request.json().catch(() => ({}));
    const { paymentIntentId, orderNumber, addressId, cardId, envioData, notas } = body;

    if (!paymentIntentId || !orderNumber || !addressId || !cardId)
      return jsonResponse(400, { success: false, error: "Faltan datos para confirmar el pedido" });

    // Idempotency: si ya existe un pedido con este paymentIntentId, devolverlo sin reenviar emails
    const existingPago = await db.execute({
      sql: `SELECT p.Id_Pedido, p.Numero_Pedido, p.Total, pe.Estado_Pago
            FROM Pago pe JOIN Pedido p ON p.Id_Pedido = pe.Id_Pedido
            WHERE pe.Codigo_Transaccion = ? AND pe.Id_Pedido IS NOT NULL LIMIT 1`,
      args: [paymentIntentId],
    });
    if (existingPago.rows.length) {
      const row = existingPago.rows[0];
      return jsonResponse(200, {
        success: true,
        message: "Pedido ya procesado",
        order: {
          id:               Number(row.Id_Pedido),
          numero:           Number(row.Numero_Pedido || orderNumber),
          total:            Number(row.Total || 0),
          subtotalProductos: 0,
          costoEnvio:       0,
          carrier:          "",
          deliveryEstimate: "",
          tracking:         null,
        },
        payment: { metodo: "tarjeta", estado: row.Estado_Pago || "aprobado", codigoTransaccion: paymentIntentId },
      });
    }


    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    } catch (err) {
      console.error("[Stripe] Error retrieving PaymentIntent:", err);
      return jsonResponse(500, { success: false, error: "Error verificando el pago" });
    }

    if (paymentIntent.status !== "succeeded")
      return jsonResponse(400, {
        success: false,
        error: `El pago no está confirmado (estado: ${paymentIntent.status})`,
      });

    const cartId = await getOrCreateCartId(user.userId);
    const items  = await getCartItems(cartId, user.userId);
    if (!items.length)
      return jsonResponse(400, { success: false, error: "El carrito está vacío" });

    // Validar stock suficiente antes de procesar el pago
    for (const item of items) {
      if (item.stockDisponible !== null && item.cantidad > item.stockDisponible) {
        return jsonResponse(400, {
          success: false,
          error: item.stockDisponible === 0
            ? `El producto #${item.productoId} está agotado.`
            : `Stock insuficiente para el producto #${item.productoId}. Solo quedan ${item.stockDisponible} unidades.`,
          stockInsuficiente: true,
          productoId: item.productoId,
          stockDisponible: item.stockDisponible,
        });
      }
    }

    const card = await findUserCard(user.userId, cardId);
    if (!card)
      return jsonResponse(404, { success: false, error: "Tarjeta no encontrada" });

    const costoEnvio        = envioData ? Number(Number(envioData.costo || 0).toFixed(2)) : 0;
    const carrierLabel      = envioData?.carrierLabel || "";
    const deliveryEstimate  = envioData?.deliveryEstimate || "";
    const deliveryDate      = envioData?.deliveryDate || null;
    const subtotalProductos = toMoney(items.reduce((sum, i) => sum + i.subtotal, 0));
    const total             = toMoney(subtotalProductos + costoEnvio);
    const now               = new Date().toISOString();

    await ensureSchemasReady();

    // PASO 1: Insertar el Pedido
    await db.execute({
      sql: `
        INSERT INTO Pedido (
          Id_Usuario, Id_Direccion, Numero_Pedido, Fecha_pedido,
          Estado, Costo_Envio, Total, Fecha_Entrega_estima, Notas_Cliente
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        user.userId, addressId, orderNumber, now, "pagado",
        costoEnvio, total, deliveryDate,
        notas || (carrierLabel ? `Envío: ${carrierLabel} — ${deliveryEstimate}` : "Pago con tarjeta"),
      ],
    });

    const orderResult = await db.execute({
      sql: `SELECT Id_Pedido FROM Pedido WHERE Numero_Pedido = ? LIMIT 1`,
      args: [orderNumber],
    });
    if (!orderResult.rows.length)
      return jsonResponse(500, { success: false, error: "No se pudo recuperar el pedido creado" });

    const orderId = Number(orderResult.rows[0].Id_Pedido);

    try {
      // PASO 2: Batch atómico — detalles, stock, pago, limpiar carrito
      const batchStatements = [];

      for (const item of items) {
        batchStatements.push({
          sql: `INSERT INTO DetallePedido (Id_Pedido, Id_Producto, Id_Variante, Cantidad, Precio_Unitario) VALUES (?, ?, ?, ?, ?)`,
          args: [orderId, item.productoId, item.varianteId ?? null, item.cantidad, item.precioUnitario],
        });

        if (item.varianteId) {
          batchStatements.push({
            sql: `
              UPDATE ProductoVariante
              SET Stock = CASE WHEN Stock IS NULL THEN NULL ELSE MAX(Stock - ?, 0) END
              WHERE Id_Variante = ?
            `,
            args: [item.cantidad, item.varianteId],
          });
        }

        batchStatements.push({
          sql: `
            UPDATE Producto
            SET StockDisponible = CASE WHEN StockDisponible IS NULL THEN NULL ELSE MAX(StockDisponible - ?, 0) END
            WHERE Id_Producto = ?
          `,
          args: [item.cantidad, item.productoId],
        });
      }

      batchStatements.push({
        sql: `
          INSERT INTO Pago (
            Id_Pedido, Metodo_Pago, Estado_Pago, Monto,
            Codigo_Transaccion, Fecha_Pago, ID_Tarjeta,
            Marca_Tarjeta, Tipo_Financiamiento, Ultimos4
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          orderId, "tarjeta", "aprobado", total,
          paymentIntentId, now, card.id,
          card.tipo, card.tipoFinanciamiento, card.ultimos4,
        ],
      });

      batchStatements.push({
        sql: `DELETE FROM ItemCarrito WHERE Id_Carrito = ?`,
        args: [cartId],
      });

      await db.batch(batchStatements, "write");

      // PASO 3: Generar etiqueta (no interrumpe el éxito si falla)
      let tracking = null;
      try {
        const carrier = envioData?.carrier || null;
        const service = envioData?.service || null;
        if (carrier && service) {
          const addrDetails = await findUserAddressDetails(addressId);
          if (addrDetails) {
            let etiqueta;
            if (carrier === "paquetexpress") {
              etiqueta = await generarGuiaPaquetexpress(addrDetails, items, service);
            } else {
              etiqueta = await generarEtiquetaEnvia(addrDetails, items, carrier, service);
            }
            const guia        = etiqueta.success ? etiqueta.data.trackingNumber : "PENDIENTE";
            const estadoEnvio = etiqueta.success ? "creado" : "pendiente";
            if (etiqueta.success) tracking = etiqueta.data;
            await db.execute({
              sql: `
                INSERT INTO Envio (Id_pedido, Numero_Guia, Estado_envio, Fecha_Envio, Carrier, Service)
                VALUES (?, ?, ?, ?, ?, ?)
              `,
              args: [orderId, guia, estadoEnvio, now, String(carrier || ""), String(service || "")],
            });
          }
        } else {
          await db.execute({
            sql: `
              INSERT INTO Envio (Id_pedido, Numero_Guia, Estado_envio, Fecha_Envio, Carrier, Service)
              VALUES (?, ?, ?, ?, ?, ?)
            `,
            args: [orderId, "PENDIENTE", "pendiente", now, null, null],
          });
        }
      } catch (labelErr) {
        console.error("[POST /api/pago/confirmar] Error generando etiqueta (no crítico):", labelErr);
      }

      // PASO 4: Emails no críticos (no interrumpen el éxito)
      try {
        const userRes = await db.execute({
          sql: `SELECT Nombre, Correo FROM Usuario WHERE Id = ? LIMIT 1`,
          args: [user.userId],
        });
        if (userRes.rows.length) {
          const uNombre = String(userRes.rows[0].Nombre || "Cliente");
          const uCorreo = String(userRes.rows[0].Correo || "").trim().toLowerCase();

          if (uCorreo) {
            const addrDetails = await findUserAddressDetails(addressId).catch(() => null);
            const direccionStr = addrDetails
              ? `${addrDetails.calle}, ${addrDetails.ciudad}, ${addrDetails.estado} CP ${addrDetails.cp}`
              : "";

            await sendOrderConfirmation({
              to:               uCorreo,
              name:             uNombre,
              orderNumber,
              total,
              items:            items.map((i) => ({
                nombre:   String(i.especificaciones || "Producto"),
                cantidad: i.cantidad,
                precio:   i.precioUnitario,
              })),
              direccion:        direccionStr,
              carrier:          carrierLabel,
              deliveryEstimate,
            }).catch((e) => console.error("[confirmar] email confirmación:", e));

            if (tracking?.trackingNumber) {
              await sendShippingNotification({
                to:          uCorreo,
                name:        uNombre,
                orderNumber,
                guia:        tracking.trackingNumber,
                carrier:     carrierLabel,
                trackUrl:    tracking.trackUrl || "",
              }).catch((e) => console.error("[confirmar] email envío:", e));
            }
          }
        }

        // Low-stock alerts to admins
        const LOW_STOCK_THRESHOLD = 5;
        const lowStockItems = [];
        for (const item of items) {
          const stockRes = await db.execute({
            sql: `SELECT Nombre, StockDisponible FROM Producto WHERE Id_Producto = ? LIMIT 1`,
            args: [item.productoId],
          });
          if (stockRes.rows.length) {
            const stockActual = stockRes.rows[0].StockDisponible == null
              ? null
              : Number(stockRes.rows[0].StockDisponible);
            if (stockActual !== null && stockActual <= LOW_STOCK_THRESHOLD) {
              lowStockItems.push({
                nombre: String(stockRes.rows[0].Nombre || ""),
                stock:  stockActual,
              });
            }
          }
        }

        if (lowStockItems.length) {
          const adminsRes = await db.execute({
            sql: `SELECT Correo FROM Usuario WHERE LOWER(Rol) IN ('admin', 'superusuario') AND Correo IS NOT NULL`,
            args: [],
          });
          const adminEmails = [...new Set(
            adminsRes.rows.map((r) => String(r.Correo || "").trim().toLowerCase()).filter(Boolean)
          )];
          for (const adminEmail of adminEmails) {
            await sendLowStockAlert({ to: adminEmail, products: lowStockItems })
              .catch((e) => console.error("[confirmar] email stock bajo:", e));
          }
        }
        // Nuevo correo al dueño/admin de cada empresa involucrada en el pedido.
        try {
          const groups = await getEmpresaOwnerOrderGroups(orderId);
          const pickupEstimate = formatPickupEstimate(deliveryDate, deliveryEstimate, now);
          for (const grp of groups) {
            await sendEmpresaNewOrderAlert({
              to: grp.ownerCorreo,
              ownerName: grp.ownerNombre,
              empresaNombre: grp.empresaNombre,
              orderNumber,
              pickupEstimate,
              items: grp.items,
            }).catch((e) => console.error("[confirmar] email nuevo pedido empresa:", e));
          }
        } catch (ownerMailErr) {
          console.error("[POST /api/pago/confirmar] Error notificando dueño de empresa (no crítico):", ownerMailErr);
        }
      } catch (emailErr) {
        console.error("[POST /api/pago/confirmar] Error en notificaciones (no crítico):", emailErr);
      }

      return jsonResponse(200, {
        success: true,
        message: "Pedido confirmado",
        order: {
          id:               orderId,
          numero:           orderNumber,
          total,
          subtotalProductos,
          costoEnvio,
          carrier:          carrierLabel,
          deliveryEstimate,
          tracking: tracking
            ? { numero: tracking.trackingNumber, url: tracking.trackUrl, labelUrl: tracking.labelUrl }
            : null,
        },
        payment: {
          metodo: "tarjeta",
          estado: "aprobado",
          codigoTransaccion: paymentIntentId,
          tarjeta: {
            id:                 card.id,
            titular:            card.titular,
            numeroEnmascarado:  `**** **** **** ${card.ultimos4}`,
            tipo:               card.tipo,
            tipoFinanciamiento: card.tipoFinanciamiento,
          },
        },
      });
    } catch (batchError) {
      console.error("[POST /api/pago/confirmar] Error en batch:", batchError);
      await db.execute({
        sql: `UPDATE Pedido SET Estado = 'error_batch' WHERE Id_Pedido = ?`,
        args: [orderId],
      }).catch(e => console.error("Error marcando pedido como error_batch:", e));
      throw batchError;
    }
  } catch (error) {
    console.error("[POST /api/pago/confirmar] Error general:", error);
    return jsonResponse(500, { success: false, error: error?.message || "No se pudo confirmar el pedido" });
  }
}