// src/pages/api/resenas/[productoId].js
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

function getGuestUserIdFromCookie(cookies) {
  const raw = cookies.get("reviewGuestUserId")?.value;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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

function getSafeUrl(request) {
  try {
    return new URL(request.url);
  } catch {
    const host = getRequestHost(request) || "localhost";
    const scheme = host === "localhost" || host === "127.0.0.1" || host === "::1" ? "http" : "https";
    const path = String(request.url || "/").startsWith("/") ? String(request.url || "/") : `/${String(request.url || "")}`;
    return new URL(`${scheme}://${host}${path}`);
  }
}

function isReviewBypassEnabled(request) {
  const envToggle = String(
    process.env.REVIEWS_BYPASS_PURCHASE_CHECK ||
      process.env.REVIEWS_BYPASS_PURCHASE ||
      process.env.PUBLIC_REVIEWS_BYPASS_PURCHASE ||
      ""
  )
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(envToggle)) return true;

  const host = (getSafeUrl(request).hostname || getRequestHost(request) || "").toLowerCase();
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

export async function GET({ params, request, cookies }) {
  try {
    const productoId = Number(params.productoId);
    if (!productoId || isNaN(productoId))
      return jsonResponse(400, { success: false, error: "ID de producto inválido" });

    const url    = getSafeUrl(request);
    const page   = Math.max(1, Number(url.searchParams.get("page")  || 1));
    const limit  = Math.min(20, Number(url.searchParams.get("limit") || 10));
    const offset = (page - 1) * limit;

    // ── Estadísticas (promedio + distribución) ──
    const statsRes = await db.execute({
      sql: `
        SELECT
          COUNT(*)                              AS total,
          ROUND(AVG(CAST(Calificacion AS REAL)), 1) AS promedio,
          SUM(CASE WHEN Calificacion = 5 THEN 1 ELSE 0 END) AS cinco,
          SUM(CASE WHEN Calificacion = 4 THEN 1 ELSE 0 END) AS cuatro,
          SUM(CASE WHEN Calificacion = 3 THEN 1 ELSE 0 END) AS tres,
          SUM(CASE WHEN Calificacion = 2 THEN 1 ELSE 0 END) AS dos,
          SUM(CASE WHEN Calificacion = 1 THEN 1 ELSE 0 END) AS uno
        FROM Resena
        WHERE Id_Producto = ? AND Estado = 'activo'
      `,
      args: [productoId],
    });

    const s = statsRes.rows[0];

    // ── Reseñas paginadas ──
    const resenasRes = await db.execute({
      sql: `
        SELECT
          r.Id_Resena, r.Id_Pedido, r.Calificacion, r.Comentario, r.Fecha_Creacion,
          u.Id            AS Id_Usuario,
          u.Nombre || ' ' || u.Apellido_Paterno AS Nombre_Usuario
        FROM Resena r
        JOIN Usuario u ON u.Id = r.Id_Usuario
        WHERE r.Id_Producto = ? AND r.Estado = 'activo'
        ORDER BY r.Fecha_Creacion DESC
        LIMIT ? OFFSET ?
      `,
      args: [productoId, limit, offset],
    });

    // ── Imágenes de las reseñas de esta página ──
    const resenaIds = resenasRes.rows.map((r) => Number(r.Id_Resena));
    const imagenesMap = {};

    if (resenaIds.length > 0) {
      const ph = resenaIds.map(() => "?").join(",");
      const imgRes = await db.execute({
        sql: `SELECT Id_Resena, Url FROM ResenaImagen WHERE Id_Resena IN (${ph}) ORDER BY Orden ASC`,
        args: resenaIds,
      });
      for (const img of imgRes.rows) {
        const id = Number(img.Id_Resena);
        if (!imagenesMap[id]) imagenesMap[id] = [];
        imagenesMap[id].push(String(img.Url));
      }
    }

    // ── ¿El usuario ya reseñó este producto? ──
    const user = getUserFromSession(cookies);
    const sessionUserId = user?.userId ? Number(user.userId) : null;
    const guestUserId = getGuestUserIdFromCookie(cookies);
    const actorUserId = sessionUserId || guestUserId;
    let miResena = null;
    let puedeResenar = false;

    const bypassPurchaseCheck = isReviewBypassEnabled(request);

    if (actorUserId) {
      // Verificar reseña existente
      const existeRes = await db.execute({
        sql: `SELECT Id_Resena FROM Resena WHERE Id_Usuario = ? AND Id_Producto = ? LIMIT 1`,
        args: [actorUserId, productoId],
      });
      if (existeRes.rows.length > 0) {
        miResena = Number(existeRes.rows[0].Id_Resena);
      }

      if (bypassPurchaseCheck) {
        puedeResenar = !miResena;
      } else if (sessionUserId) {
        // Verificar si compró el producto (pedido entregado)
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
          args: [productoId, sessionUserId],
        });
        puedeResenar = compraRes.rows.length > 0 && !miResena;
      }
    } else if (bypassPurchaseCheck) {
      puedeResenar = true;
    }

    const resenas = resenasRes.rows.map((r) => ({
      id:           Number(r.Id_Resena),
      calificacion: Number(r.Calificacion),
      comentario:   r.Comentario ? String(r.Comentario) : null,
      fecha:        String(r.Fecha_Creacion),
      usuario:      String(r.Nombre_Usuario),
      esVerificada: r.Id_Pedido != null,
      esPropia:     actorUserId ? Number(r.Id_Usuario) === Number(actorUserId) : false,
      imagenes:     imagenesMap[Number(r.Id_Resena)] ?? [],
    }));

    return jsonResponse(200, {
      success: true,
      stats: {
        total:    Number(s.total    ?? 0),
        promedio: Number(s.promedio ?? 0),
        distribucion: {
          5: Number(s.cinco  ?? 0),
          4: Number(s.cuatro ?? 0),
          3: Number(s.tres   ?? 0),
          2: Number(s.dos    ?? 0),
          1: Number(s.uno    ?? 0),
        },
      },
      paginacion: { page, limit, total: Number(s.total ?? 0) },
      puedeResenar,
      miResena,
      resenas,
    });
  } catch (err) {
    console.error("[GET /api/resenas/[productoId]]", err);
    return jsonResponse(500, { success: false, error: err?.message || "Error interno" });
  }
}