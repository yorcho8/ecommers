import { createClient } from "@libsql/client";
import "dotenv/config";
import { cotizarEnvioEnvia } from "../../../lib/envia-shipping.js";
import { cotizarPaquetexpress } from "../../../lib/paquetexpress-shipping.js";
import { ensureProductVisibilitySchema } from "../../../lib/product-visibility.js";
import { getActiveDiscountMap, resolveEffectiveUnitPrice } from "../../../lib/pricing.js";
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

function getUserFromSession(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
  } catch {
    return null;
  }
}

/**
 * POST /api/envio/cotizar
 *
 * Body (opcional): { direccionId?: number }
 * Si no se envía direccionId, usa la dirección más reciente del usuario.
 *
 * Llama a la API de Envia.com para obtener tarifas reales de
 * FedEx, DHL, Estafeta, etc.
 */
export async function POST({ request, cookies }) {
  try {
    await ensureProductVisibilitySchema(db);

    const user = getUserFromSession(cookies);
    if (!user?.userId) {
      return jsonResponse(401, { success: false, error: "No autenticado" });
    }

    const body = await request.json().catch(() => ({}));
    const direccionId = body?.direccionId ? Number(body.direccionId) : null;

    // ── Obtener dirección ────────────────────────────────
    let addressQuery;
    if (direccionId) {
      addressQuery = await db.execute({
        sql: `SELECT Id_Direccion, Numero_casa, Calle, Codigo_Postal, Ciudad, Provincia, Nombre_Direccion, COALESCE(Pais, 'MX') AS Pais
              FROM Direccion WHERE Id_Direccion = ? AND Id_Usuario = ? LIMIT 1`,
        args: [direccionId, user.userId],
      });
    } else {
      addressQuery = await db.execute({
        sql: `SELECT Id_Direccion, Numero_casa, Calle, Codigo_Postal, Ciudad, Provincia, Nombre_Direccion, COALESCE(Pais, 'MX') AS Pais
              FROM Direccion WHERE Id_Usuario = ? ORDER BY Id_Direccion DESC LIMIT 1`,
        args: [user.userId],
      });
    }

    if (!addressQuery.rows.length) {
      return jsonResponse(400, {
        success: false,
        error: "No tienes una dirección registrada. Agrega una en Mi cuenta.",
      });
    }

    const addr = addressQuery.rows[0];

    // ── Obtener items del carrito ────────────────────────
    const cartResult = await db.execute({
      sql: `SELECT Id_Carrito FROM Carrito WHERE Id_Usuario = ? LIMIT 1`,
      args: [user.userId],
    });

    if (!cartResult.rows.length) {
      return jsonResponse(400, { success: false, error: "Tu carrito está vacío" });
    }

    const cartId = Number(cartResult.rows[0].Id_Carrito);

    const itemsResult = await db.execute({
      sql: `
         SELECT ic.id_Item_Carrito, ic.Id_Producto, ic.Id_Variante, ic.Cantidad, ic.Precio_Unitario,
           p.Nombre, p.Precio AS Precio_Base, pv.Precio AS Precio_Variante,
           p.StockDisponible, COALESCE(p.Peso, 0.5) AS Peso, p.Especificaciones
        FROM ItemCarrito ic
        JOIN Producto p ON p.Id_Producto = ic.Id_Producto
         LEFT JOIN ProductoVariante pv ON pv.Id_Variante = ic.Id_Variante
        WHERE ic.Id_Carrito = ?
          AND COALESCE(p.Activo, 1) = 1
          AND NOT EXISTS (
            SELECT 1 FROM ProductoVisibilidadUsuario pvu
            WHERE pvu.Id_Producto = p.Id_Producto AND pvu.Id_Usuario = ? AND pvu.Visible = 0
          )
        ORDER BY ic.id_Item_Carrito DESC
      `,
      args: [cartId, user.userId],
    });

    if (!itemsResult.rows.length) {
      return jsonResponse(400, { success: false, error: "Tu carrito está vacío" });
    }

    const discountMap = await getActiveDiscountMap(
      db,
      itemsResult.rows.map((row) => Number(row.Id_Producto || 0))
    );

    const items = itemsResult.rows.map((row) => {
      const cantidad = Number(row.Cantidad || 0);
      const variantPrice = row.Precio_Variante == null ? null : Number(row.Precio_Variante);
      const basePrice = variantPrice == null ? Number(row.Precio_Base || row.Precio_Unitario || 0) : variantPrice;
      const precio = resolveEffectiveUnitPrice(basePrice, Number(row.Id_Producto || 0), discountMap);
      return {
        productoId: Number(row.Id_Producto),
        nombre: String(row.Nombre || ""),
        cantidad,
        precioUnitario: Number(precio.toFixed(2)),
        subtotal: Number((cantidad * precio).toFixed(2)),
        peso: Number(row.Peso || 0.5),
        especificaciones: row.Especificaciones ? String(row.Especificaciones) : null,
      };
    });

    // ── Cotizar con Envia.com API ────────────────────────
    const destino = {
      calle: `${addr.Calle} #${addr.Numero_casa}`,
      ciudad: String(addr.Ciudad || ""),
      estado: String(addr.Provincia || ""),
      cp: String(addr.Codigo_Postal || ""),      pais: String(addr.Pais || "MX"),    };

    // ── Cotizar Envia.com + Paquetexpress en paralelo ────
    const isPaisMX = String(addr.Pais || "MX").toUpperCase() === "MX";

    const [cotizacionEnvia, cotizacionPE] = await Promise.all([
      cotizarEnvioEnvia(destino, items).catch((e) => {
        console.error("[cotizar] envia error:", e);
        return { success: false, opciones: [], error: String(e.message || e) };
      }),
      isPaisMX
        ? cotizarPaquetexpress(destino, items).catch((e) => {
            console.error("[cotizar] paquetexpress error:", e);
            return { success: false, opciones: [], error: String(e.message || e) };
          })
        : Promise.resolve({ success: false, opciones: [] }),
    ]);

    const allOpciones = [
      ...(cotizacionEnvia.opciones || []),
      ...(cotizacionPE.opciones || []),
    ].sort((a, b) => a.totalPrice - b.totalPrice);

    const combinedError =
      !cotizacionEnvia.success && !cotizacionPE.success
        ? [cotizacionEnvia.error, cotizacionPE.error].filter(Boolean).join(" | ")
        : null;

    const partialWarnings = [];
    if (!cotizacionEnvia.success && cotizacionEnvia.error) {
      partialWarnings.push(`Envia: ${cotizacionEnvia.error}`);
    }
    if (isPaisMX && !cotizacionPE.success && cotizacionPE.error) {
      partialWarnings.push(`Paquetexpress: ${cotizacionPE.error}`);
    }
    const warning = partialWarnings.length ? partialWarnings.join(" | ") : null;

    // ── Obtener todas las direcciones del usuario ────────
    const allAddresses = await db.execute({
      sql: `SELECT Id_Direccion, Numero_casa, Calle, Codigo_Postal, Ciudad, Provincia, Nombre_Direccion
            FROM Direccion WHERE Id_Usuario = ? ORDER BY Id_Direccion DESC`,
      args: [user.userId],
    });

    const direcciones = allAddresses.rows.map((r) => ({
      id: Number(r.Id_Direccion),
      nombre: r.Nombre_Direccion || null,
      calle: String(r.Calle || ""),
      numero: r.Numero_casa,
      cp: String(r.Codigo_Postal || ""),
      ciudad: String(r.Ciudad || ""),
      estado: String(r.Provincia || ""),
      label: `${r.Calle} #${r.Numero_casa}, ${r.Ciudad}, ${r.Provincia} CP ${r.Codigo_Postal}`,
    }));

    const subtotal = items.reduce((s, i) => s + i.subtotal, 0);

    const bestOptionWithWeight = allOpciones.find((o) =>
      Number.isFinite(Number(o?.pesoRealKg)) || Number.isFinite(Number(o?.pesoCobrableKg))
    );

    const pesoReal = bestOptionWithWeight
      ? Number(Number(bestOptionWithWeight.pesoRealKg || 0).toFixed(2))
      : Number(
          items
            .reduce((sum, i) => {
              const unit = i.peso && Number(i.peso) > 0 ? Number(i.peso) : 0.5;
              return sum + (i.cantidad || 1) * unit;
            }, 0)
            .toFixed(2)
        );

    const pesoVolumetrico = bestOptionWithWeight
      ? Number(Number(bestOptionWithWeight.pesoVolumetricoKg || 0).toFixed(2))
      : 0;

    const pesoCobrable = Number(Math.max(pesoReal, pesoVolumetrico).toFixed(2));

    // ── Recomendación de carrier según peso ────────────
    const pesoTotal = pesoCobrable;

    let recomendacion = null;
    if (isPaisMX) {
      if (pesoTotal < 5) {
        recomendacion = {
          carrier: "redpack",
          label: "Redpack",
          motivo: `Tu envío pesa ${pesoTotal.toFixed(1)} kg — Redpack es la opción más económica para paquetes ligeros.`,
        };
      } else if (pesoTotal <= 20) {
        recomendacion = {
          carrier: "paquetexpress",
          label: "Paquetexpress",
          motivo: `Tu envío pesa ${pesoTotal.toFixed(1)} kg — Paquetexpress tiene las mejores tarifas para carga de 5–20 kg.`,
        };
      } else {
        recomendacion = {
          carrier: "paquetexpress",
          label: "Paquetexpress",
          motivo: `Tu envío pesa ${pesoTotal.toFixed(1)} kg — para carga pesada, Paquetexpress ofrece tarifas industriales más competitivas.`,
        };
      }
    }

    return jsonResponse(200, {
      success: true,
      direccionSeleccionada: Number(addr.Id_Direccion),
      direcciones,
      envio: {
        opciones: allOpciones,
        error: combinedError,
        warning,
        recomendacion,
        pesoTotal: Number(pesoTotal.toFixed(2)),
        pesoReal: Number(pesoReal.toFixed(2)),
        pesoVolumetrico: Number(pesoVolumetrico.toFixed(2)),
        pesoCobrable: Number(pesoCobrable.toFixed(2)),
      },
      items,
      subtotal: Number(subtotal.toFixed(2)),
    });
  } catch (error) {
    console.error("[POST /api/envio/cotizar] Error:", error);
    return jsonResponse(500, {
      success: false,
      error: "No se pudieron obtener las opciones de envío",
    });
  }
}
