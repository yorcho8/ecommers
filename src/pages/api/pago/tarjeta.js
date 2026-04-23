import Stripe from "stripe";
import { createClient } from "@libsql/client";
import "dotenv/config";
import { ensureProductVisibilitySchema } from "../../../lib/product-visibility.js";
import { verifySessionToken, SESSION_COOKIE } from "../../../lib/session.js";
import { getClientIp, checkRateLimit } from "../../../lib/rate-limit.js";

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY
);

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

/** Uses the signed, HttpOnly go_session cookie — not the forgeable authSession. */
function getUserFromSession(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
  } catch { return null; }
}

function isMissingStripeCustomerError(error) {
  const code = String(error?.code || "").toLowerCase();
  const param = String(error?.param || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  return code === "resource_missing" && (
    param === "customer" ||
    param === "id" ||
    message.includes("no such customer")
  );
}

function toMoney(value) {
  return Number(Number(value || 0).toFixed(2));
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
        ic.Cantidad,
        ic.Precio_Unitario,
        p.StockDisponible
      FROM ItemCarrito ic
      JOIN Producto p ON p.Id_Producto = ic.Id_Producto
      WHERE ic.Id_Carrito = ?
        AND COALESCE(p.Activo, 1) = 1
        AND NOT EXISTS (
          SELECT 1 FROM ProductoVisibilidadUsuario pvu
          WHERE pvu.Id_Producto = p.Id_Producto
            AND pvu.Id_Usuario = ?
            AND pvu.Visible = 0
        )
      ORDER BY ic.id_Item_Carrito DESC
    `,
    args: [cartId, userId],
  });

  return result.rows.map((row) => {
    const cantidad = Number(row.Cantidad || 0);
    const precio   = Number(row.Precio_Unitario || 0);
    return {
      itemId:           Number(row.id_Item_Carrito),
      productoId:       Number(row.Id_Producto),
      cantidad,
      precioUnitario:   toMoney(precio),
      subtotal:         toMoney(cantidad * precio),
      stockDisponible:  row.StockDisponible == null ? null : Number(row.StockDisponible),
    };
  });
}

async function findUserDefaultAddress(userId) {
  const result = await db.execute({
    sql: `SELECT Id_Direccion FROM Direccion WHERE Id_Usuario = ? ORDER BY Id_Direccion DESC LIMIT 1`,
    args: [userId],
  });
  if (!result.rows.length) return null;
  return Number(result.rows[0].Id_Direccion);
}

// ── Ahora usa la tabla migrada (sin número completo ni CVV) ──────────────────
async function findUserCard(userId, cardId) {
  const result = await db.execute({
    sql: `
      SELECT
        ID_Tarjeta,
        Stripe_Payment_Method_Id,
        Ultimos4,
        Marca,
        Mes_Expiracion,
        Anio_Expiracion,
        Nombre_Titular,
        Tipo_Financiamiento,
        Es_Predeterminada
      FROM Tarjeta
      WHERE ID_Tarjeta = ? AND Id_Usuario = ?
      LIMIT 1
    `,
    args: [cardId, userId],
  });

  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    id:                   Number(row.ID_Tarjeta),
    stripePaymentMethodId: String(row.Stripe_Payment_Method_Id || ""),
    ultimos4:             String(row.Ultimos4 || "----"),
    marca:                String(row.Marca || "desconocida").toLowerCase(),
    mesExpiracion:        Number(row.Mes_Expiracion || 0),
    anioExpiracion:       Number(row.Anio_Expiracion || 0),
    titular:              String(row.Nombre_Titular || ""),
    tipoFinanciamiento:   String(row.Tipo_Financiamiento || "no_definido").toLowerCase(),
    esPredeterminada:     Boolean(row.Es_Predeterminada),
  };
}

async function getOrCreateStripeCustomerId(userId, correo) {
  try {
    const result = await db.execute({
      sql: `SELECT Stripe_Customer_Id FROM Usuario WHERE Id = ? LIMIT 1`,
      args: [userId],
    });
    const existing = result.rows[0]?.Stripe_Customer_Id ? String(result.rows[0].Stripe_Customer_Id) : "";

    if (existing) {
      try {
        const customer = await stripe.customers.retrieve(existing);
        if (customer && !customer.deleted) return existing;
      } catch (error) {
        if (!isMissingStripeCustomerError(error)) throw error;
      }
    }

    const created = await stripe.customers.create(
      {
        email: String(correo || "").trim() || undefined,
        metadata: { userId: String(userId) },
      },
      { idempotencyKey: `create-customer-${userId}` },
    );

    await db.execute({
      sql: `UPDATE Usuario SET Stripe_Customer_Id = ? WHERE Id = ?`,
      args: [created.id, userId],
    });

    return String(created.id);
  } catch { return null; }
}

async function removeCardById(userId, cardId) {
  try {
    await db.execute({
      sql: `DELETE FROM Tarjeta WHERE ID_Tarjeta = ? AND Id_Usuario = ?`,
      args: [Number(cardId), Number(userId)],
    });
  } catch {}
}

async function ensurePaymentMethodReady(stripePaymentMethodId, stripeCustomerId) {
  try {
    const pm = await stripe.paymentMethods.retrieve(stripePaymentMethodId);
    const pmCustomer = pm?.customer ? String(pm.customer) : "";

    if (!pmCustomer) {
      const attached = await stripe.paymentMethods.attach(stripePaymentMethodId, { customer: stripeCustomerId });
      return { ok: true, paymentMethodId: String(attached.id || stripePaymentMethodId) };
    }

    if (pmCustomer !== stripeCustomerId) {
      try {
        await stripe.paymentMethods.detach(stripePaymentMethodId);
        const reattached = await stripe.paymentMethods.attach(stripePaymentMethodId, { customer: stripeCustomerId });
        return { ok: true, paymentMethodId: String(reattached.id || stripePaymentMethodId) };
      } catch {
        return { ok: false, reason: "payment_method_customer_mismatch" };
      }
    }

    return { ok: true, paymentMethodId: stripePaymentMethodId };
  } catch (error) {
    if (String(error?.code || "") === "resource_missing") {
      return { ok: false, reason: "payment_method_missing" };
    }
    return { ok: false, reason: "payment_method_not_retrievable" };
  }
}

async function ensurePaymentSchema() {
  return true;
}

async function getNextOrderNumber() {
  const result = await db.execute({
    sql: `SELECT MAX(Numero_Pedido) AS maxNumero FROM Pedido`,
    args: [],
  });
  return Number(result.rows[0]?.maxNumero || 0) + 1;
}

// ── Handler principal ────────────────────────────────────────────────────────
export async function POST({ request, cookies }) {
  try {
    await ensureProductVisibilitySchema(db);
    const user = getUserFromSession(cookies);
    if (!user?.userId) return jsonResponse(401, { success: false, error: "No autenticado" });

    // ── Rate limiting: máx 5 intentos de pago por IP cada 15 min ────────────
    const clientIp = getClientIp(request);
    const rl = checkRateLimit('payment', clientIp, { maxRequests: 5, windowMs: 15 * 60 * 1000, blockMs: 30 * 60 * 1000 });
    if (rl.limited) {
      return jsonResponse(429, { success: false, error: `Demasiados intentos de pago. Intenta en ${Math.ceil(rl.retryAfter / 60)} min.` });
    }

    const body                    = await request.json().catch(() => ({}));
    const cardId                  = Number(body?.cardId);
    const envioData               = body?.envio || null;
    const direccionIdFromCheckout = body?.direccionId ? Number(body.direccionId) : null;
    const notasCliente            = typeof body?.notas === "string" ? body.notas.slice(0, 500) : "";

    if (!Number.isFinite(cardId) || cardId <= 0) {
      return jsonResponse(400, { success: false, error: "Tarjeta inválida" });
    }

    const costoEnvio      = envioData ? Number(Number(envioData.costo || 0).toFixed(2)) : 0;
    const carrierLabel    = envioData?.carrierLabel    || "";
    const deliveryEstimate= envioData?.deliveryEstimate|| "";
    const deliveryDate    = envioData?.deliveryDate    || null;

    const cartId = await getOrCreateCartId(user.userId);
    const items  = await getCartItems(cartId, user.userId);

    if (!items.length)
      return jsonResponse(400, { success: false, error: "Tu carrito está vacío" });

    const outOfStock = items.find(
      (i) => i.stockDisponible != null && i.cantidad > i.stockDisponible
    );
    if (outOfStock)
      return jsonResponse(400, { success: false, error: "Stock insuficiente para un producto del carrito" });

    const addressId = direccionIdFromCheckout || await findUserDefaultAddress(user.userId);
    if (!addressId)
      return jsonResponse(400, { success: false, error: "Agrega una dirección en tu cuenta antes de pagar" });

    const card = await findUserCard(user.userId, cardId);
    if (!card)
      return jsonResponse(404, { success: false, error: "Tarjeta no encontrada" });

    // ── Validación: ya NO revisamos número completo, solo el pm_xxx ──────────
    if (!card.stripePaymentMethodId || !card.stripePaymentMethodId.startsWith("pm_")) {
      return jsonResponse(400, {
        success: false,
        error: "Tarjeta no configurada correctamente. Por favor elimínala y agrégala de nuevo.",
      });
    }

    const stripeCustomerId = await getOrCreateStripeCustomerId(user.userId, user.correo ?? user.email ?? "");
    if (!stripeCustomerId) {
      return jsonResponse(400, {
        success: false,
        error: "No tienes una cuenta de cobro configurada. Vuelve a guardar tu tarjeta.",
      });
    }

    const pmCheck = await ensurePaymentMethodReady(card.stripePaymentMethodId, stripeCustomerId);
    if (!pmCheck.ok) {
      if (pmCheck.reason === "payment_method_missing") {
        await removeCardById(user.userId, card.id);
        return jsonResponse(409, {
          success: false,
          error: "La tarjeta guardada ya no existe en Stripe y se removio de tu cuenta local. Agregala de nuevo para continuar.",
          reason: "payment_method_missing",
        });
      }

      if (pmCheck.reason === "payment_method_customer_mismatch") {
        return jsonResponse(409, {
          success: false,
          error: "La tarjeta esta asociada a otro perfil de cobro en Stripe. Eliminala y agregala nuevamente.",
          reason: "payment_method_customer_mismatch",
        });
      }

      return jsonResponse(409, {
        success: false,
        error: "No se pudo validar la tarjeta en Stripe. Agregala nuevamente.",
        reason: "payment_method_not_retrievable",
      });
    }

    const subtotalProductos = toMoney(items.reduce((s, i) => s + i.subtotal, 0));
    const total             = toMoney(subtotalProductos + costoEnvio);
    const orderNumber       = await getNextOrderNumber();

    await ensurePaymentSchema();

    const amountInCents = Math.round(total * 100);
    let paymentIntent;
    try {
      // Idempotency key prevents duplicate charges if the request is retried.
      // Tied to orderNumber + userId so retries produce the same PaymentIntent.
      paymentIntent = await stripe.paymentIntents.create(
        {
          amount:         amountInCents,
          currency:       "mxn",
          customer:       stripeCustomerId,
          payment_method: pmCheck.paymentMethodId,
          confirm:        false,
          off_session:    false,
          description:    `Pedido #${orderNumber}`,
          metadata: {
            orderNumber:  String(orderNumber),
            userId:       String(user.userId),
            ultimos4:     card.ultimos4,
            marca:        card.marca,
          },
        },
        { idempotencyKey: `create-pi-${orderNumber}-${user.userId}` },
      );
    } catch (stripeError) {
      console.error("[Stripe] Error creando PaymentIntent:", stripeError);
      const stripeCode = String(stripeError?.code || "").toLowerCase();
      const stripeParam = String(stripeError?.param || "").toLowerCase();
      if (stripeCode === "resource_missing" && stripeParam === "payment_method") {
        return jsonResponse(409, {
          success: false,
          error: "La tarjeta guardada ya no existe en Stripe. Elimínala en 'Mis tarjetas' y agrégala de nuevo para continuar.",
          stripeCode,
          reason: "payment_method_missing",
        });
      }
      return jsonResponse(402, {
        success:    false,
        error:      "Error al preparar el pago. Intenta de nuevo.",
        stripeCode: stripeError.code,
      });
    }

    return jsonResponse(200, {
      success:          true,
      requiresAction:   paymentIntent.status === "requires_action" || paymentIntent.status === "requires_confirmation",
      clientSecret:     paymentIntent.client_secret,
      paymentIntentId:  paymentIntent.id,
      orderNumber,
      subtotalProductos,
      costoEnvio,
      total,
      carrierLabel,
      deliveryEstimate,
      deliveryDate,
      addressId,
      cardId,
      // Datos seguros para mostrar en UI (sin número completo)
      cardInfo: {
        ultimos4:         card.ultimos4,
        marca:            card.marca,
        titular:          card.titular,
        tipoFinanciamiento: card.tipoFinanciamiento,
      },
      envioData,
      notas: notasCliente,
    });

  } catch (error) {
    console.error("[POST /api/pago/tarjeta] Error:", error);
    return jsonResponse(500, { success: false, error: "No se pudo procesar el pago con tarjeta" });
  }
}