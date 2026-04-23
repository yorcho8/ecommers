/**
 * GET /api/cron/carrito-abandonado
 *
 * Endpoint de cron para detectar carritos abandonados y enviar emails de recuperación.
 * Debe llamarse con la cabecera Authorization: Bearer <CRON_SECRET> desde un cron externo
 * (Vercel Cron Jobs, Railway Cron, o cualquier scheduler HTTP).
 *
 * Lógica:
 *  - Carritos con items cuya Ultima_Actividad fue hace más de ABANDONMENT_HOURS horas
 *  - Solo carritos de usuarios registrados (con email)
 *  - Solo si no se envió email de recuperación en las últimas 48h
 *  - Marca el carrito con Email_Abandono_Enviado para no reenviar
 */
import { createClient } from "@libsql/client";
import "dotenv/config";
import { sendAbandonedCartEmail } from "../../../lib/mail.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

const ABANDONMENT_HOURS = 24;     // horas inactivo para considerar abandonado
const RESEND_COOLDOWN_HOURS = 48; // no reenviar si ya se mandó en este periodo
const MAX_BATCH = 50;             // máximo de emails por ejecución

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function ensureSchema() {
  return true;
}

export async function GET({ request }) {
  // Verificar secreto de cron
  const cronSecret = process.env.CRON_SECRET || import.meta.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (token !== cronSecret) {
      return json({ success: false, error: "No autorizado" }, 401);
    }
  }

  try {
    await ensureSchema();

    const now = new Date();
    const cutoffAbandonment = new Date(now.getTime() - ABANDONMENT_HOURS * 60 * 60 * 1000).toISOString();
    const cutoffResend      = new Date(now.getTime() - RESEND_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();

    // Buscar carritos con actividad antigua, items, usuario con correo
    const carritosRes = await db.execute({
      sql: `
        SELECT
          c.Id_Carrito,
          c.Id_Usuario,
          c.Ultima_Actividad,
          c.Email_Abandono_Enviado,
          u.Nombre AS UsuarioNombre,
          u.Correo AS UsuarioCorreo
        FROM Carrito c
        JOIN Usuario u ON u.Id = c.Id_Usuario
        WHERE c.Id_Usuario IS NOT NULL
          AND u.Correo IS NOT NULL
          AND c.Ultima_Actividad IS NOT NULL
          AND c.Ultima_Actividad < ?
          AND (c.Email_Abandono_Enviado IS NULL OR c.Email_Abandono_Enviado < ?)
          AND EXISTS (
            SELECT 1 FROM ItemCarrito ic
            WHERE ic.Id_Carrito = c.Id_Carrito
          )
        ORDER BY c.Ultima_Actividad ASC
        LIMIT ?
      `,
      args: [cutoffAbandonment, cutoffResend, MAX_BATCH],
    });

    const resultados = { procesados: 0, enviados: 0, errores: 0, detalles: [] };

    for (const row of carritosRes.rows) {
      resultados.procesados++;
      const cartId  = Number(row.Id_Carrito);
      const correo  = String(row.UsuarioCorreo || "").trim().toLowerCase();
      const nombre  = String(row.UsuarioNombre || "Cliente").trim();

      // Obtener items del carrito con imagen y precio
      let items = [];
      try {
        const itemsRes = await db.execute({
          sql: `
            SELECT
              p.Nombre,
              ic.Cantidad,
              ic.Precio_Unitario,
              (SELECT ip.Url FROM Imagen_Producto ip WHERE ip.Id_Producto = p.Id_Producto ORDER BY ip.Id_Imagen ASC LIMIT 1) AS Imagen
            FROM ItemCarrito ic
            JOIN Producto p ON p.Id_Producto = ic.Id_Producto
            WHERE ic.Id_Carrito = ? AND COALESCE(p.Activo, 1) = 1
            LIMIT 5
          `,
          args: [cartId],
        });
        items = itemsRes.rows.map((i) => ({
          nombre:   String(i.Nombre || "Producto"),
          cantidad: Number(i.Cantidad || 1),
          precio:   Number(i.Precio_Unitario || 0),
          imagen:   i.Imagen ? String(i.Imagen) : null,
        }));
      } catch (e) {
        console.error(`[carrito-abandonado] Error obteniendo items del carrito ${cartId}:`, e);
      }

      if (!items.length) continue;

      const total = items.reduce((sum, i) => sum + i.precio * i.cantidad, 0);
      const cartUrl = `${process.env.APP_URL || "http://localhost:4321"}/es/carrito`;

      try {
        const result = await sendAbandonedCartEmail({ to: correo, name: nombre, items, total, cartUrl });
        if (result.sent) {
          resultados.enviados++;
          await db.execute({
            sql: "UPDATE Carrito SET Email_Abandono_Enviado = ? WHERE Id_Carrito = ?",
            args: [now.toISOString(), cartId],
          });
          resultados.detalles.push({ cartId, correo, status: "enviado" });
        } else {
          resultados.errores++;
          resultados.detalles.push({ cartId, correo, status: "fallo", reason: result.reason });
        }
      } catch (e) {
        resultados.errores++;
        resultados.detalles.push({ cartId, correo, status: "error", error: e?.message });
      }
    }

    return json({ success: true, ...resultados });
  } catch (error) {
    console.error("[GET /api/cron/carrito-abandonado] Error:", error);
    return json({ success: false, error: error?.message || "Error en cron de carrito abandonado" }, 500);
  }
}
