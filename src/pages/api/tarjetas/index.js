import Stripe from "stripe";
import { createClient } from "@libsql/client";
import "dotenv/config";

const stripe = new Stripe(
  process.env.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY
);

const db = createClient({
  url:       process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN   || import.meta.env.ECOMERS_AUTH_TOKEN,
});

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

import { verifySessionToken, SESSION_COOKIE } from "../../../lib/session.js";

/** Uses the signed, HttpOnly go_session cookie — not the forgeable authSession. */
function getSessionUser(cookies) {
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

async function clearUserStripeCustomerId(userId) {
  await db.execute({
    sql: `UPDATE Usuario SET Stripe_Customer_Id = NULL WHERE Id = ?`,
    args: [userId],
  });
}

async function getOrCreateStripeCustomer(userId, correo) {
  const row = await db.execute({
    sql:  `SELECT Stripe_Customer_Id FROM Usuario WHERE Id = ? LIMIT 1`,
    args: [userId],
  });
  const existing = row.rows[0]?.Stripe_Customer_Id;
  if (existing) {
    const existingId = String(existing);
    try {
      const customer = await stripe.customers.retrieve(existingId);
      if (customer && !customer.deleted) return existingId;
    } catch (error) {
      // If the stored customer no longer exists, recreate transparently.
      if (!isMissingStripeCustomerError(error)) {
        throw error;
      }
    }
  }

  const customer = await stripe.customers.create({
    email: correo || undefined,
    metadata: { userId: String(userId) },
  });
  await db.execute({
    sql:  `UPDATE Usuario SET Stripe_Customer_Id = ? WHERE Id = ?`,
    args: [customer.id, userId],
  });
  return customer.id;
}

async function removeCardRow(userId, cardId) {
  try {
    await db.execute({
      sql: `DELETE FROM Tarjeta WHERE ID_Tarjeta = ? AND Id_Usuario = ?`,
      args: [Number(cardId), Number(userId)],
    });
  } catch {}
}

async function getStripeCustomerId(userId) {
  const row = await db.execute({
    sql: `SELECT Stripe_Customer_Id FROM Usuario WHERE Id = ? LIMIT 1`,
    args: [userId],
  });
  return row.rows[0]?.Stripe_Customer_Id ? String(row.rows[0].Stripe_Customer_Id) : null;
}

/* ── GET /api/tarjetas ─────────────────────────────────────────────────────── */
export async function GET({ cookies }) {
  try {
    const user = getSessionUser(cookies);
    if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);

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
        WHERE Id_Usuario = ?
        ORDER BY Es_Predeterminada DESC, ID_Tarjeta DESC
      `,
      args: [user.userId],
    });

    const stripeCustomerId = await getOrCreateStripeCustomer(user.userId, user.correo ?? user.email ?? "");
    const tarjetas = [];

    for (const row of result.rows) {
      const cardId = Number(row.ID_Tarjeta);
      const pmId = String(row.Stripe_Payment_Method_Id || "");

      let valid = pmId.startsWith("pm_");
      if (valid) {
        try {
          await stripe.paymentMethods.retrieve(pmId);
          // Keep visible even when PM is attached to another customer.
          // Checkout flow already repairs customer mismatch before charging.
          valid = true;
        } catch (err) {
          valid = String(err?.code || "") !== "resource_missing";
        }
      }

      if (!valid) {
        await removeCardRow(user.userId, cardId);
        continue;
      }

      tarjetas.push({
        id: cardId,
        titular: row.Nombre_Titular,
        numero: `**** **** **** ${row.Ultimos4 || "----"}`,
        vencimiento: `${String(row.Mes_Expiracion || "").padStart(2, "0")}/${row.Anio_Expiracion || ""}`,
        marca: row.Marca,
        tipoFinanciamiento: row.Tipo_Financiamiento || "no_definido",
        default: Number(row.Es_Predeterminada || 0) === 1,
      });
    }

    return json({ success: true, tarjetas });
  } catch (error) {
    console.error("Error in GET /api/tarjetas:", error);
    return json({ success: false, error: "Error obteniendo tarjetas" }, 500);
  }
}

/* ── POST /api/tarjetas ────────────────────────────────────────────────────── */
export async function POST({ cookies, request }) {
  try {
    const user = getSessionUser(cookies);
    if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);

    const body = await request.json().catch(() => ({}));
    const paymentMethodId    = String(body?.paymentMethodId || "").trim();
    const tipoFinanciamiento = String(body?.tipoFinanciamiento || "no_definido").toLowerCase();

    if (!paymentMethodId.startsWith("pm_")) {
      return json({ success: false, error: "paymentMethodId inválido. Usa Stripe Elements." }, 400);
    }

    const correo           = user.correo ?? user.email ?? "";
    const stripeCustomerId = await getOrCreateStripeCustomer(user.userId, correo);

    // Adjuntar PaymentMethod al Customer
    let pm;
    try {
      pm = await stripe.paymentMethods.attach(paymentMethodId, { customer: stripeCustomerId });
    } catch (stripeErr) {
      if (stripeErr?.code === "payment_method_already_attached") {
        pm = await stripe.paymentMethods.retrieve(paymentMethodId);
      } else if (isMissingStripeCustomerError(stripeErr)) {
        await clearUserStripeCustomerId(user.userId);
        const healedCustomerId = await getOrCreateStripeCustomer(user.userId, correo);
        pm = await stripe.paymentMethods.attach(paymentMethodId, { customer: healedCustomerId });
      } else {
        throw stripeErr;
      }
    }

    const card           = pm.card;
    if (!card) {
      return json({ success: false, error: "Solo se aceptan tarjetas de crédito/débito. Intenta con una tarjeta bancaria." }, 400);
    }
    const ultimos4       = card.last4;
    const marca          = card.brand;
    const mesExpiracion  = card.exp_month;
    const anioExpiracion = card.exp_year;
    const titular        = pm.billing_details?.name || String(body?.titular || "").trim() || "Titular";

    // Verificar duplicado
    const dup = await db.execute({
      sql: `
        SELECT
          ID_Tarjeta,
          Stripe_Payment_Method_Id
        FROM Tarjeta
        WHERE Id_Usuario = ? AND Ultimos4 = ? AND Marca = ? AND Anio_Expiracion = ?
        LIMIT 1
      `,
      args: [user.userId, ultimos4, marca, anioExpiracion],
    });

    if (dup.rows.length) {
      const existing = dup.rows[0];
      const existingCardId = Number(existing.ID_Tarjeta);
      const existingPmId = String(existing.Stripe_Payment_Method_Id || "");

      let canReplace = false;
      if (!existingPmId.startsWith("pm_")) {
        canReplace = true;
      } else {
        try {
          await stripe.paymentMethods.retrieve(existingPmId);
        } catch (err) {
          if (String(err?.code || "") === "resource_missing") {
            canReplace = true;
          } else {
            throw err;
          }
        }
      }

      if (canReplace) {
        await db.execute({
          sql: `
            UPDATE Tarjeta
            SET Stripe_Payment_Method_Id = ?,
                Mes_Expiracion = ?,
                Anio_Expiracion = ?,
                Nombre_Titular = ?,
                Tipo_Financiamiento = ?
            WHERE ID_Tarjeta = ? AND Id_Usuario = ?
          `,
          args: [
            pm.id,
            mesExpiracion,
            anioExpiracion,
            titular,
            tipoFinanciamiento,
            existingCardId,
            user.userId,
          ],
        });

        return json({
          success: true,
          message: "Tarjeta actualizada",
          tarjeta: { marca, ultimos4, mesExpiracion, anioExpiracion },
          replacedStaleCard: true,
        }, 200);
      }

      return json({
        success: true,
        message: "La tarjeta ya estaba guardada",
        duplicate: true,
        tarjeta: { marca, ultimos4, mesExpiracion, anioExpiracion },
      }, 200);
    }

    // Primera tarjeta → predeterminada automáticamente
    const countRes = await db.execute({
      sql:  `SELECT COUNT(*) AS total FROM Tarjeta WHERE Id_Usuario = ?`,
      args: [user.userId],
    });
    const isDefault = Number(countRes.rows[0]?.total || 0) === 0 ? 1 : 0;

    await db.execute({
      sql: `
        INSERT INTO Tarjeta (
          Id_Usuario, Stripe_Payment_Method_Id, Ultimos4, Marca,
          Mes_Expiracion, Anio_Expiracion, Nombre_Titular,
          Tipo_Financiamiento, Es_Predeterminada
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        user.userId,
        pm.id,            // pm_xxx — nunca el número real
        ultimos4,
        marca,
        mesExpiracion,
        anioExpiracion,
        titular,
        tipoFinanciamiento,
        isDefault,
      ],
    });

    return json({
      success: true,
      message: "Tarjeta guardada",
      tarjeta: { marca, ultimos4, mesExpiracion, anioExpiracion },
    }, 201);

  } catch (error) {
    console.error("Error in POST /api/tarjetas:", error);
    if (isMissingStripeCustomerError(error)) {
      return json({
        success: false,
        error: "Tu perfil de cobro en Stripe estaba desactualizado. Intenta guardar la tarjeta nuevamente.",
        reason: "stripe_customer_stale",
      }, 409);
    }
    if (String(error?.code || "") === "resource_missing" && String(error?.param || "") === "payment_method") {
      return json({
        success: false,
        error: "Stripe no reconoce el método de pago generado. Verifica que STRIPE_SECRET_KEY y la llave pública del frontend sean de la misma cuenta (modo test).",
        reason: "stripe_key_mismatch",
      }, 409);
    }
    return json({ success: false, error: "Error guardando tarjeta" }, 500);
  }
}