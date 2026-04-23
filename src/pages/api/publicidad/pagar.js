import Stripe from "stripe";
import { createClient } from "@libsql/client";
import "dotenv/config";
import {
  ensurePublicidadSchema,
  calculateCampaignQuote,
  getPublicidadPlan,
} from "../../../lib/publicidad.js";
import { verifySessionToken, SESSION_COOKIE } from "../../../lib/session.js";

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

function isLocalPaymentBypassEnabled(request) {
  const envValue = String(
    process.env.PUBLICIDAD_BYPASS_PAGO_LOCAL ||
      process.env.PUBLICIDAD_LOCAL_PAYMENT_BYPASS ||
      ""
  )
    .trim()
    .toLowerCase();

  if (["1", "true", "yes", "on"].includes(envValue)) return true;
  if (["0", "false", "no", "off"].includes(envValue)) return false;

  try {
    const host = String(new URL(request.url).hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function toIsoPlusDays(days) {
  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return { start: now.toISOString(), end: end.toISOString() };
}

async function findUserCard(userId, cardId) {
  const result = await db.execute({
    sql: `
      SELECT ID_Tarjeta, Stripe_Payment_Method_Id
      FROM Tarjeta
      WHERE ID_Tarjeta = ? AND Id_Usuario = ?
      LIMIT 1
    `,
    args: [cardId, userId],
  });
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    id: Number(row.ID_Tarjeta),
    stripePaymentMethodId: String(row.Stripe_Payment_Method_Id || ""),
  };
}

async function getStripeCustomerId(userId) {
  const result = await db.execute({
    sql: `SELECT Stripe_Customer_Id FROM Usuario WHERE Id = ? LIMIT 1`,
    args: [userId],
  });
  return result.rows[0]?.Stripe_Customer_Id
    ? String(result.rows[0].Stripe_Customer_Id)
    : null;
}

async function findProductOwnership(productId) {
  const result = await db.execute({
    sql: `
      SELECT
        p.Id_Producto,
        p.Id_Empresa,
        p.Nombre
      FROM Producto p
      WHERE p.Id_Producto = ?
        AND COALESCE(p.Activo, 1) = 1
        AND COALESCE(p.Estado, 1) = 1
      LIMIT 1
    `,
    args: [productId],
  });
  return result.rows[0] || null;
}

async function getUserCompanyId(userId) {
  if (!userId) return null;
  const result = await db.execute({
    sql: `
      SELECT Id_Empresa
      FROM UsuarioEmpresa
      WHERE Id_Usuario = ? AND Activo = 1
      ORDER BY Id_UsuarioEmpresa DESC
      LIMIT 1
    `,
    args: [Number(userId)],
  });
  if (!result.rows.length) return null;
  return Number(result.rows[0].Id_Empresa);
}

async function hasActiveCampaign(productId, position) {
  const result = await db.execute({
    sql: `
      SELECT Id_Publicidad
      FROM PublicidadCampana
      WHERE Id_Producto = ?
        AND Posicion = ?
        AND Estado = 'activa'
        AND (Fecha_Fin IS NULL OR Fecha_Fin > ?)
      LIMIT 1
    `,
    args: [productId, position, new Date().toISOString()],
  });
  return result.rows.length > 0;
}

export async function POST({ request, cookies }) {
  try {
    await ensurePublicidadSchema(db);
    const allowLocalBypass = isLocalPaymentBypassEnabled(request);

    const user = getUserFromSession(cookies);
    if (!user?.userId) {
      return jsonResponse(401, { success: false, error: "No autenticado" });
    }

    const body = await request.json().catch(() => ({}));
    const productoId = Number(body?.productoId);
    const cardId = Number(body?.cardId);
    const duracionDias = Math.max(1, Math.min(30, Number(body?.duracionDias) || 1));
    const prioridadExtra = Math.max(0, Math.min(10, Number(body?.prioridadExtra) || 0));
    const positionPlan = getPublicidadPlan(body?.posicion || "grid");
    const quote = calculateCampaignQuote({
      position: positionPlan.key,
      days: duracionDias,
    });

    if (!Number.isFinite(productoId) || productoId <= 0) {
      return jsonResponse(400, { success: false, error: "Producto inválido" });
    }

    if (!Number.isFinite(cardId) || cardId <= 0) {
      return jsonResponse(400, { success: false, error: "Tarjeta inválida" });
    }

    const ownership = await findProductOwnership(productoId);
    if (!ownership) {
      return jsonResponse(404, { success: false, error: "Producto no encontrado o inactivo. Solo se puede pagar publicidad para productos activos." });
    }

    const role = String(user.rol || "").toLowerCase();
    const isSuper = role === "superusuario";
    const userCompanyId = await getUserCompanyId(user.userId);
    const isOwner = Number(userCompanyId || 0) > 0 && Number(ownership.Id_Empresa || 0) === Number(userCompanyId || 0);
    if (!isSuper && !isOwner) {
      return jsonResponse(403, { success: false, error: "Solo el owner del producto o superusuario puede pagar publicidad" });
    }

    if (await hasActiveCampaign(productoId, quote.position)) {
      return jsonResponse(409, { success: false, error: `Este producto ya tiene campaña activa en ${quote.positionLabel}` });
    }

    const card = await findUserCard(user.userId, cardId);
    const isCardValid = !!(card && card.stripePaymentMethodId && card.stripePaymentMethodId.startsWith("pm_"));
    if (!isCardValid && !allowLocalBypass) {
      return jsonResponse(400, { success: false, error: "Tarjeta no configurada correctamente" });
    }

    const stripeCustomerId = await getStripeCustomerId(user.userId);
    if (!stripeCustomerId && !allowLocalBypass) {
      return jsonResponse(400, {
        success: false,
        error: "No tienes cuenta de cobro Stripe configurada",
      });
    }

    const amount = quote.total;
    let simulatedLocalPayment = false;

    let paymentIntent = {
      id: `pi_local_${Date.now()}`,
      status: "succeeded",
    };

    if (stripeCustomerId && isCardValid) {
      try {
        paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100),
          currency: "mxn",
          customer: stripeCustomerId,
          payment_method: card.stripePaymentMethodId,
          confirm: true,
          off_session: false,
          description: `Publicidad Nexus ${quote.positionLabel} - Producto ${productoId}`,
          metadata: {
            tipo: "publicidad_home",
            productoId: String(productoId),
            userId: String(user.userId),
            duracionDias: String(duracionDias),
            posicion: quote.position,
            precioDia: String(quote.pricePerDay),
            subtotal: String(quote.subtotal),
            descuento: String(quote.discountAmount),
          },
        });
      } catch (err) {
        const stripeCode = err?.code ? String(err.code) : null;
        const stripeDeclineCode = err?.decline_code ? String(err.decline_code) : null;
        const detail = err?.message ? String(err.message) : null;

        if (allowLocalBypass) {
          simulatedLocalPayment = true;
          paymentIntent = {
            id: `pi_local_bypass_${Date.now()}`,
            status: "succeeded",
          };
        } else {
          return jsonResponse(402, {
            success: false,
            error: "No se pudo procesar el pago de publicidad",
            stripeCode,
            stripeDeclineCode,
            detail,
          });
        }
      }
    } else {
      simulatedLocalPayment = true;
    }

    if (paymentIntent.status !== "succeeded") {
      if (allowLocalBypass) {
        simulatedLocalPayment = true;
        paymentIntent = {
          id: `pi_local_status_bypass_${Date.now()}`,
          status: "succeeded",
        };
      } else {
        return jsonResponse(402, {
          success: false,
          error: `Pago no completado (estado: ${paymentIntent.status})`,
          paymentIntentId: paymentIntent.id,
        });
      }
    }

    const now = new Date().toISOString();
    const { start, end } = toIsoPlusDays(duracionDias);

    const insert = await db.execute({
      sql: `
        INSERT INTO PublicidadCampana (
          Id_Producto, Id_Usuario, Id_Empresa, Monto, Moneda, Duracion_Dias,
          Fecha_Inicio, Fecha_Fin, Estado, Payment_Intent_Id, Fecha_Creacion, Fecha_Actualizacion,
          Posicion, Prioridad, Precio_Dia, Monto_Bruto, Descuento_MXN
        ) VALUES (?, ?, ?, ?, 'MXN', ?, ?, ?, 'activa', ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        productoId,
        Number(user.userId),
        ownership.Id_Empresa ? Number(ownership.Id_Empresa) : null,
        amount,
        duracionDias,
        start,
        end,
        String(paymentIntent.id),
        now,
        now,
        quote.position,
        quote.defaultPriority + prioridadExtra,
        quote.pricePerDay,
        quote.subtotal,
        quote.discountAmount,
      ],
    });

    return jsonResponse(201, {
      success: true,
      message: simulatedLocalPayment
        ? "Publicidad activada en inicio (pago simulado local)"
        : "Publicidad activada en inicio",
      simulado: simulatedLocalPayment,
      campaign: {
        id: Number(insert.lastInsertRowid),
        productoId,
        productoNombre: String(ownership.Nombre || ""),
        posicion: quote.position,
        posicionLabel: quote.positionLabel,
        prioridad: quote.defaultPriority + prioridadExtra,
        monto: amount,
        montoBruto: quote.subtotal,
        descuento: quote.discountAmount,
        moneda: "MXN",
        duracionDias,
        fechaInicio: start,
        fechaFin: end,
      },
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    console.error("[POST /api/publicidad/pagar]", error);
    return jsonResponse(500, { success: false, error: error?.message || "Error interno" });
  }
}
