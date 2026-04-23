// src/pages/api/resenas/index.js
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

function getRequestHost(request) {
  const hostHeader = (request.headers.get("x-forwarded-host") || request.headers.get("host") || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (hostHeader) return hostHeader.replace(/:\d+$/, "");

  const originHeader = request.headers.get("origin") || request.headers.get("referer") || "";
  if (originHeader) {
    try {
      return new URL(originHeader).hostname.toLowerCase();
    } catch {
      return "";
    }
  }
  return "";
}

function isReviewBypassEnabled(request) {
  const envFlag =
    String(
      process.env.REVIEWS_BYPASS_PURCHASE_CHECK ||
        process.env.REVIEWS_BYPASS_PURCHASE ||
        process.env.PUBLIC_REVIEWS_BYPASS_PURCHASE ||
        ""
    )
      .trim()
      .toLowerCase();

  if (["1", "true", "yes", "on"].includes(envFlag)) return true;

  let host = "";
  try {
    host = (new URL(request.url).hostname || "").toLowerCase();
  } catch {
    host = getRequestHost(request);
  }

  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

async function resolveReviewActorUserId({ cookies, bypassPurchaseCheck, user }) {
  if (user?.userId) return Number(user.userId);
  if (!bypassPurchaseCheck) return null;

  const existingGuestId = Number(cookies.get("reviewGuestUserId")?.value || 0);
  if (Number.isFinite(existingGuestId) && existingGuestId > 0) return existingGuestId;

  const nowIso = new Date().toISOString();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const email = `guest.review.${suffix}@nexus.local`;
  const password = `guest-${suffix}`;

  const insertUser = await db.execute({
    sql: `
      INSERT INTO Usuario
        (Nombre, Apellido_Paterno, Apellido_Materno, Correo, Contrasena, Rol, Telefono, Fecha_Creacion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: ["Cliente", "Invitado", null, email, password, "cliente", null, nowIso],
  });

  const guestUserId = Number(insertUser.lastInsertRowid);
  cookies.set("reviewGuestUserId", String(guestUserId), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: true,
    sameSite: "lax",
  });

  return guestUserId;
}

async function getNextOrderNumber() {
  const result = await db.execute({
    sql: `SELECT MAX(Numero_Pedido) AS maxNumero FROM Pedido`,
    args: [],
  });
  return Number(result.rows[0]?.maxNumero || 0) + 1;
}

async function getOrCreateReviewAddress(userId) {
  const existing = await db.execute({
    sql: `SELECT Id_Direccion FROM Direccion WHERE Id_Usuario = ? ORDER BY Id_Direccion DESC LIMIT 1`,
    args: [userId],
  });

  if (existing.rows.length) {
    return Number(existing.rows[0].Id_Direccion);
  }

  const created = await db.execute({
    sql: `
      INSERT INTO Direccion (
        Id_Usuario, Numero_casa, Calle, Codigo_Postal, Ciudad, Provincia, Pais, Nombre_Direccion
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [userId, 1, "Sin calle", 0, "Sin ciudad", "Sin provincia", "Mexico", "Direccion de prueba"],
  });

  return Number(created.lastInsertRowid);
}

async function createTechnicalDeliveredOrder({ userId, productoId }) {
  const productRes = await db.execute({
    sql: `SELECT Precio FROM Producto WHERE Id_Producto = ? LIMIT 1`,
    args: [productoId],
  });
  if (!productRes.rows.length) {
    throw new Error("Producto no encontrado para reseña");
  }

  const precio = Number(productRes.rows[0].Precio || 0);
  const direccionId = await getOrCreateReviewAddress(userId);
  const orderNumber = await getNextOrderNumber();
  const now = new Date().toISOString();

  const insertPedido = await db.execute({
    sql: `
      INSERT INTO Pedido (
        Id_Usuario, Id_Direccion, Numero_Pedido, Fecha_pedido,
        Estado, Costo_Envio, Total, Fecha_Entrega_estima, Notas_Cliente
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      userId,
      direccionId,
      orderNumber,
      now,
      "entregado",
      0,
      precio,
      now,
      "Pedido tecnico para habilitar reseña en entorno de prueba",
    ],
  });

  const pedidoId = Number(insertPedido.lastInsertRowid);

  await db.execute({
    sql: `
      INSERT INTO DetallePedido (Id_Pedido, Id_Producto, Cantidad, Precio_Unitario, Id_Variante)
      VALUES (?, ?, ?, ?, ?)
    `,
    args: [pedidoId, productoId, 1, precio, null],
  });

  return pedidoId;
}

export async function POST({ request, cookies }) {
  try {
    const bypassPurchaseCheck = isReviewBypassEnabled(request);
    const user = getUserFromSession(cookies);
    const actorUserId = await resolveReviewActorUserId({ cookies, bypassPurchaseCheck, user });

    if (!actorUserId)
      return jsonResponse(401, { success: false, error: "No autenticado" });

    const body = await request.json();
    const { productoId, calificacion, comentario, imagenes } = body;
    // imagenes = [{ url, publicId }, ...] — ya subidas a Cloudinary desde el frontend

    // ── Validaciones básicas ──
    if (!productoId || isNaN(Number(productoId)))
      return jsonResponse(400, { success: false, error: "ID de producto inválido" });

    const cal = Number(calificacion);
    if (!cal || cal < 1 || cal > 5)
      return jsonResponse(400, { success: false, error: "La calificación debe ser entre 1 y 5" });

    if (comentario && String(comentario).length > 1000)
      return jsonResponse(400, { success: false, error: "El comentario no puede superar 1000 caracteres" });

    if (imagenes && (!Array.isArray(imagenes) || imagenes.length > 5))
      return jsonResponse(400, { success: false, error: "Máximo 5 imágenes por reseña" });

    let pedidoId = null;

    if (!bypassPurchaseCheck && user?.userId) {
      // ── Verificar compra (pedido entregado) ──
      const compraRes = await db.execute({
        sql: `
          SELECT dp.Id_Pedido
          FROM DetallePedido dp
          JOIN Pedido p ON p.Id_Pedido = dp.Id_Pedido
          WHERE dp.Id_Producto = ?
            AND p.Id_Usuario   = ?
            AND p.Estado       = 'entregado'
          LIMIT 1
        `,
        args: [Number(productoId), Number(user.userId)],
      });

      if (!compraRes.rows.length)
        return jsonResponse(403, { success: false, error: "Solo puedes reseñar productos que hayas comprado y recibido" });

      pedidoId = Number(compraRes.rows[0].Id_Pedido);
    }

    if (bypassPurchaseCheck && !pedidoId) {
      pedidoId = await createTechnicalDeliveredOrder({
        userId: actorUserId,
        productoId: Number(productoId),
      });
    }

    // ── Verificar que no haya reseñado ya este producto ──
    const existeRes = await db.execute({
      sql: `SELECT Id_Resena FROM Resena WHERE Id_Usuario = ? AND Id_Producto = ? LIMIT 1`,
      args: [actorUserId, Number(productoId)],
    });

    if (existeRes.rows.length)
      return jsonResponse(409, { success: false, error: "Ya dejaste una reseña para este producto" });

    const ahora = new Date().toISOString();

    // ── Insertar reseña ──
    const insertRes = await db.execute({
      sql: `
        INSERT INTO Resena (Id_Producto, Id_Usuario, Id_Pedido, Calificacion, Comentario, Estado, Fecha_Creacion, Fecha_Actualizacion)
        VALUES (?, ?, ?, ?, ?, 'activo', ?, ?)
      `,
      args: [
        Number(productoId),
        actorUserId,
        pedidoId,
        cal,
        comentario ? String(comentario).trim() : null,
        ahora,
        ahora,
      ],
    });

    const resenaId = Number(insertRes.lastInsertRowid);

    // ── Insertar imágenes si las hay ──
    if (imagenes?.length) {
      for (let i = 0; i < imagenes.length; i++) {
        const img = imagenes[i];
        if (!img?.url) continue;
        await db.execute({
          sql: `INSERT INTO ResenaImagen (Id_Resena, Url, Public_ID, Orden) VALUES (?, ?, ?, ?)`,
          args: [resenaId, String(img.url), img.publicId ? String(img.publicId) : null, i],
        });
      }
    }

    return jsonResponse(201, {
      success: true,
      resenaId,
      message: "¡Gracias por tu reseña!",
    });
  } catch (err) {
    console.error("[POST /api/resenas]", err);
    return jsonResponse(500, { success: false, error: err?.message || "Error interno" });
  }
}