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

async function assertCardOwnership(userId, cardId) {
  const result = await db.execute({
    sql:  `SELECT ID_Tarjeta, Es_Predeterminada, Stripe_Payment_Method_Id
           FROM Tarjeta WHERE ID_Tarjeta = ? AND Id_Usuario = ? LIMIT 1`,
    args: [cardId, userId],
  });
  return result.rows[0] || null;
}

async function setDefaultCard(userId, cardId) {
  await db.execute({
    sql:  `UPDATE Tarjeta SET Es_Predeterminada = 0 WHERE Id_Usuario = ?`,
    args: [userId],
  });
  await db.execute({
    sql:  `UPDATE Tarjeta SET Es_Predeterminada = 1 WHERE ID_Tarjeta = ? AND Id_Usuario = ?`,
    args: [cardId, userId],
  });
}

/* ── PUT /api/tarjetas/:id — Solo permite cambiar titular y tipo ────────────
   El número/fecha/marca NO se pueden editar: son datos de Stripe, inmutables.
   Si el usuario quiere cambiar la tarjeta, debe eliminarla y agregar una nueva. */
export async function PUT({ params, cookies, request }) {
  try {
    const user = getSessionUser(cookies);
    if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);

    const cardId = Number(params?.id);
    if (!Number.isFinite(cardId) || cardId <= 0)
      return json({ success: false, error: "ID de tarjeta inválido" }, 400);

    const card = await assertCardOwnership(user.userId, cardId);
    if (!card) return json({ success: false, error: "Tarjeta no encontrada" }, 404);

    const body               = await request.json().catch(() => ({}));
    const titular            = String(body?.titular || "").trim();
    const tipoFinanciamiento = String(body?.tipoFinanciamiento || "no_definido").toLowerCase();

    if (!titular) return json({ success: false, error: "El titular es obligatorio" }, 400);
    if (!["debito", "credito", "no_definido"].includes(tipoFinanciamiento))
      return json({ success: false, error: "Tipo de financiamiento inválido" }, 400);

    await db.execute({
      sql:  `UPDATE Tarjeta
             SET Nombre_Titular = ?, Tipo_Financiamiento = ?
             WHERE ID_Tarjeta = ? AND Id_Usuario = ?`,
      args: [titular, tipoFinanciamiento, cardId, user.userId],
    });

    return json({ success: true, message: "Tarjeta actualizada" });
  } catch (error) {
    console.error("Error in PUT /api/tarjetas/:id:", error);
    return json({ success: false, error: "Error actualizando tarjeta" }, 500);
  }
}

/* ── PATCH /api/tarjetas/:id — Marcar como predeterminada ────────────────── */
export async function PATCH({ params, cookies, request }) {
  try {
    const user = getSessionUser(cookies);
    if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);

    const cardId = Number(params?.id);
    if (!Number.isFinite(cardId) || cardId <= 0)
      return json({ success: false, error: "ID de tarjeta inválido" }, 400);

    const card = await assertCardOwnership(user.userId, cardId);
    if (!card) return json({ success: false, error: "Tarjeta no encontrada" }, 404);

    const body = await request.json().catch(() => ({}));
    if (body?.predeterminada !== true)
      return json({ success: false, error: "Operación no soportada" }, 400);

    await setDefaultCard(user.userId, cardId);
    return json({ success: true, message: "Tarjeta predeterminada actualizada" });
  } catch (error) {
    console.error("Error in PATCH /api/tarjetas/:id:", error);
    return json({ success: false, error: "Error actualizando tarjeta predeterminada" }, 500);
  }
}

/* ── DELETE /api/tarjetas/:id ────────────────────────────────────────────── */
export async function DELETE({ params, cookies }) {
  try {
    const user = getSessionUser(cookies);
    if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);

    const cardId = Number(params?.id);
    if (!Number.isFinite(cardId) || cardId <= 0)
      return json({ success: false, error: "ID de tarjeta inválido" }, 400);

    const card = await assertCardOwnership(user.userId, cardId);
    if (!card) return json({ success: false, error: "Tarjeta no encontrada" }, 404);

    // Desadjuntar de Stripe también (buena práctica)
    const pmId = card.Stripe_Payment_Method_Id;
    if (pmId && pmId.startsWith("pm_")) {
      try {
        await stripe.paymentMethods.detach(pmId);
      } catch (stripeErr) {
        // Si ya estaba desadjunto, no es error crítico
        console.warn("[DELETE tarjeta] stripe.detach warning:", stripeErr?.message);
      }
    }

    await db.execute({
      sql:  `DELETE FROM Tarjeta WHERE ID_Tarjeta = ? AND Id_Usuario = ?`,
      args: [cardId, user.userId],
    });

    // Si era predeterminada, asignar la siguiente
    if (Number(card.Es_Predeterminada || 0) === 1) {
      const next = await db.execute({
        sql:  `SELECT ID_Tarjeta FROM Tarjeta WHERE Id_Usuario = ? ORDER BY ID_Tarjeta DESC LIMIT 1`,
        args: [user.userId],
      });
      if (next.rows.length) {
        await setDefaultCard(user.userId, next.rows[0].ID_Tarjeta);
      }
    }

    return json({ success: true, message: "Tarjeta eliminada" });
  } catch (error) {
    console.error("Error in DELETE /api/tarjetas/:id:", error);
    return json({ success: false, error: "Error eliminando tarjeta" }, 500);
  }
}