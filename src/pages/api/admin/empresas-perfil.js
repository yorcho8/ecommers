import Stripe from "stripe";
import { createClient } from "@libsql/client";
import "dotenv/config";
import { ensureEmpresaProfileSchema, expireEmpresaProfilePayments } from "../../../lib/empresa-profile.js";
import { verifySessionToken, SESSION_COOKIE } from "../../../lib/session.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY);

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getSessionUser(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const user = verifySessionToken(token);
    const role = String(user?.rol || "").toLowerCase();
    if (role !== "admin" && role !== "superusuario") return null;
    return user;
  } catch {
    return null;
  }
}

function allowLocalBypass(request) {
  const envValue = String(process.env.EMPRESA_PERFIL_BYPASS_PAGO_LOCAL || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(envValue)) return true;
  if (["0", "false", "no", "off"].includes(envValue)) return false;
  try {
    const host = String(new URL(request.url).hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

async function getUserCompanyId(userId) {
  const result = await db.execute({
    sql: `SELECT Id_Empresa FROM UsuarioEmpresa WHERE Id_Usuario = ? AND Activo = 1 ORDER BY Id_UsuarioEmpresa DESC LIMIT 1`,
    args: [Number(userId)],
  });
  if (!result.rows.length) return null;
  return Number(result.rows[0].Id_Empresa);
}

async function getStripeCustomerId(userId) {
  const result = await db.execute({
    sql: `SELECT Stripe_Customer_Id FROM Usuario WHERE Id = ? LIMIT 1`,
    args: [Number(userId)],
  });
  return result.rows[0]?.Stripe_Customer_Id ? String(result.rows[0].Stripe_Customer_Id) : null;
}

async function findUserCard(userId, cardId) {
  const result = await db.execute({
    sql: `SELECT ID_Tarjeta, Stripe_Payment_Method_Id, Marca, Ultimos4 FROM Tarjeta WHERE ID_Tarjeta = ? AND Id_Usuario = ? LIMIT 1`,
    args: [Number(cardId), Number(userId)],
  });
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    id: Number(row.ID_Tarjeta),
    stripePaymentMethodId: String(row.Stripe_Payment_Method_Id || ""),
    label: `${String(row.Marca || "Tarjeta")} ****${String(row.Ultimos4 || "")}`,
  };
}

function plusDaysIso(days) {
  const start = new Date();
  const end = new Date(start.getTime() + Number(days) * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export async function GET({ cookies, url }) {
  try {
    await ensureEmpresaProfileSchema(db);
    await expireEmpresaProfilePayments(db);

    const user = getSessionUser(cookies);
    if (!user?.userId) return json(401, { success: false, error: "No autenticado" });

    const role = String(user.rol || "").toLowerCase();
    const queryEmpresaId = Number(url.searchParams.get("empresaId") || 0);
    const ownCompanyId = await getUserCompanyId(user.userId);
    const empresaId = role === "superusuario" && queryEmpresaId > 0 ? queryEmpresaId : ownCompanyId;

    if (!empresaId || empresaId <= 0) {
      return json(404, { success: false, error: "No tienes empresa asignada" });
    }

    const empresaResult = await db.execute({
      sql: `
        SELECT
          Id_Empresa, Nombre_Empresa, Nombre_Comercial, Descripcion, Sitio_Web, Giro,
          Logo_URL, Banner_URL, Perfil_Slogan, Perfil_Publico_Activo
        FROM Empresa
        WHERE Id_Empresa = ?
        LIMIT 1
      `,
      args: [empresaId],
    });

    if (!empresaResult.rows.length) {
      return json(404, { success: false, error: "Empresa no encontrada" });
    }

    const cardsResult = await db.execute({
      sql: `
        SELECT ID_Tarjeta, Marca, Ultimos4, Es_Predeterminada
        FROM Tarjeta
        WHERE Id_Usuario = ?
        ORDER BY Es_Predeterminada DESC, ID_Tarjeta DESC
      `,
      args: [Number(user.userId)],
    });

    const paymentResult = await db.execute({
      sql: `
        SELECT Id_PerfilPago, Monto, Duracion_Dias, Fecha_Inicio, Fecha_Fin, Estado
        FROM EmpresaPerfilPago
        WHERE Id_Empresa = ?
        ORDER BY Id_PerfilPago DESC
        LIMIT 1
      `,
      args: [empresaId],
    });

    return json(200, {
      success: true,
      empresa: empresaResult.rows[0],
      cards: cardsResult.rows.map((row) => ({
        id: Number(row.ID_Tarjeta),
        label: `${String(row.Marca || "Tarjeta")} ****${String(row.Ultimos4 || "")}`,
        default: Number(row.Es_Predeterminada || 0) === 1,
      })),
      ultimoPago: paymentResult.rows[0] || null,
      plans: [
        { key: "30", label: "30 dias", amount: 399 },
        { key: "60", label: "60 dias", amount: 699 },
        { key: "90", label: "90 dias", amount: 999 },
      ],
    });
  } catch (error) {
    console.error("[GET /api/admin/empresas-perfil]", error);
    return json(500, { success: false, error: "Error al cargar perfil de empresa" });
  }
}

export async function POST({ cookies, request }) {
  try {
    await ensureEmpresaProfileSchema(db);
    await expireEmpresaProfilePayments(db);

    const user = getSessionUser(cookies);
    if (!user?.userId) return json(401, { success: false, error: "No autenticado" });

    const role = String(user.rol || "").toLowerCase();
    const body = await request.json().catch(() => ({}));

    const ownCompanyId = await getUserCompanyId(user.userId);
    const targetCompanyId = role === "superusuario"
      ? Number(body.empresaId || ownCompanyId || 0)
      : Number(ownCompanyId || 0);

    if (!targetCompanyId || targetCompanyId <= 0) {
      return json(400, { success: false, error: "Empresa inválida" });
    }

    const companyExists = await db.execute({
      sql: `SELECT Id_Empresa FROM Empresa WHERE Id_Empresa = ? LIMIT 1`,
      args: [targetCompanyId],
    });
    if (!companyExists.rows.length) {
      return json(404, { success: false, error: "Empresa no encontrada" });
    }

    const nombreComercial = String(body?.nombreComercial || "").trim();
    const descripcion = String(body?.descripcion || "").trim();
    const sitioWeb = String(body?.sitioWeb || "").trim();
    const giro = String(body?.giro || "").trim();
    const logoUrl = String(body?.logoUrl || "").trim();
    const bannerUrl = String(body?.bannerUrl || "").trim();
    const slogan = String(body?.slogan || "").trim();

    if (!nombreComercial || !descripcion || !logoUrl || !bannerUrl) {
      return json(400, { success: false, error: "Completa nombre comercial, descripcion, foto/logo y banner." });
    }

    const cardId = Number(body?.cardId || 0);
    const days = Math.max(1, Math.min(365, Number(body?.duracionDias) || 30));
    const amount = Number(body?.amount || 399);

    if (!Number.isFinite(cardId) || cardId <= 0) {
      return json(400, { success: false, error: "Selecciona una tarjeta para pagar." });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return json(400, { success: false, error: "Monto inválido." });
    }

    const card = await findUserCard(user.userId, cardId);
    const bypass = allowLocalBypass(request);
    const cardValid = !!(card && card.stripePaymentMethodId && card.stripePaymentMethodId.startsWith("pm_"));
    if (!cardValid && !bypass) {
      return json(400, { success: false, error: "Tarjeta no configurada correctamente." });
    }

    const stripeCustomerId = await getStripeCustomerId(user.userId);
    if (!stripeCustomerId && !bypass) {
      return json(400, { success: false, error: "No tienes cliente Stripe configurado." });
    }

    let paymentIntent = { id: `pi_local_profile_${Date.now()}`, status: "succeeded" };
    let simulated = false;

    if (stripeCustomerId && cardValid) {
      try {
        paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100),
          currency: "mxn",
          customer: stripeCustomerId,
          payment_method: card.stripePaymentMethodId,
          confirm: true,
          off_session: false,
          description: `Perfil empresa destacado - Empresa ${targetCompanyId}`,
          metadata: {
            tipo: "empresa_perfil_destacado",
            empresaId: String(targetCompanyId),
            userId: String(user.userId),
            duracionDias: String(days),
          },
        });
      } catch (error) {
        if (!bypass) {
          return json(402, {
            success: false,
            error: "No se pudo procesar el pago",
            detail: String(error?.message || ""),
          });
        }
        simulated = true;
      }
    } else {
      simulated = true;
    }

    const dates = plusDaysIso(days);
    const now = new Date().toISOString();

    await db.execute({
      sql: `
        UPDATE Empresa
        SET Nombre_Comercial = ?,
            Descripcion = ?,
            Sitio_Web = ?,
            Giro = ?,
            Logo_URL = ?,
            Banner_URL = ?,
            Perfil_Slogan = ?,
            Perfil_Publico_Activo = 1
        WHERE Id_Empresa = ?
      `,
      args: [
        nombreComercial,
        descripcion,
        sitioWeb || null,
        giro || null,
        logoUrl,
        bannerUrl,
        slogan || null,
        targetCompanyId,
      ],
    });

    await db.execute({
      sql: `
        INSERT INTO EmpresaPerfilPago (
          Id_Empresa, Id_Usuario, Monto, Moneda, Duracion_Dias,
          Fecha_Inicio, Fecha_Fin, Estado, Payment_Intent_Id, Fecha_Creacion, Fecha_Actualizacion
        ) VALUES (?, ?, ?, 'MXN', ?, ?, ?, 'activa', ?, ?, ?)
      `,
      args: [
        targetCompanyId,
        Number(user.userId),
        amount,
        days,
        dates.start,
        dates.end,
        String(paymentIntent.id),
        now,
        now,
      ],
    });

    return json(201, {
      success: true,
      message: simulated ? "Perfil de empresa activado (pago local simulado)." : "Perfil de empresa activado y publicado.",
      paymentIntentId: paymentIntent.id,
      empresaId: targetCompanyId,
      fechaInicio: dates.start,
      fechaFin: dates.end,
    });
  } catch (error) {
    console.error("[POST /api/admin/empresas-perfil]", error);
    return json(500, { success: false, error: "Error al guardar perfil de empresa" });
  }
}
