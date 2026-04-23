// src/pages/api/me/pedidos/[id]/factura.js
import { createClient } from "@libsql/client";
import { crearFactura, obtenerArchivoCfdi, cancelarCfdi } from "../../../../../lib/facturama.js";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../../../../lib/session.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getSession(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
  } catch {
    return null;
  }
}

async function ensureFacturaTable() {
  return true;
}

// Admins y superusuarios pueden facturar en cualquier estado (para pruebas)
function canRequestFactura(user, estadoPedido) {
  const rol = String(user.rol || "").toLowerCase();
  if (rol === "superusuario" || rol === "admin") {
    return { can: true, isTestOverride: true };
  }
  return {
    can: String(estadoPedido || "").toLowerCase() === "entregado",
    isTestOverride: false,
  };
}

// ──────────────────── GET ────────────────────
// ?download=pdf  → entrega el PDF como descarga
// ?download=xml  → entrega el XML como descarga
// (sin param)    → JSON con estado de la factura
export async function GET({ params, cookies, request }) {
  const user = getSession(cookies);
  if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);

  const pedidoId = Number(params.id);
  if (!pedidoId) return json({ success: false, error: "ID de pedido inválido" }, 400);

  const url = new URL(request.url);
  const download = url.searchParams.get("download"); // "pdf" | "xml"

  try {
    await ensureFacturaTable();

    // Verificar propiedad del pedido
    const orderRes = await db.execute({
      sql: "SELECT Id_Pedido, Estado FROM Pedido WHERE Id_Pedido = ? AND Id_Usuario = ? LIMIT 1",
      args: [pedidoId, user.userId],
    });
    if (!orderRes.rows.length) return json({ success: false, error: "Pedido no encontrado" }, 404);

    const estadoPedido = String(orderRes.rows[0].Estado || "");
    const eligibility = canRequestFactura(user, estadoPedido);

    // ── Descarga de archivo ──
    if (download === "pdf" || download === "xml") {
      const facRes = await db.execute({
        sql: "SELECT Facturama_Id FROM Factura WHERE Id_Pedido = ? AND Id_Usuario = ? AND Estado = 'vigente' ORDER BY Id_Factura DESC LIMIT 1",
        args: [pedidoId, user.userId],
      });
      if (!facRes.rows.length) {
        return json({ success: false, error: "No existe factura vigente para este pedido" }, 404);
      }
      const facturamaId = String(facRes.rows[0].Facturama_Id || "");
      if (!facturamaId) return json({ success: false, error: "ID de Facturama no disponible" }, 404);

      const fileResult = await obtenerArchivoCfdi(facturamaId, download);
      if (!fileResult.ok || !fileResult.data?.Content) {
        return json({ success: false, error: "No se pudo obtener el archivo de Facturama" }, 502);
      }

      const buffer = Buffer.from(fileResult.data.Content, "base64");
      const contentType = download === "pdf" ? "application/pdf" : "application/xml";
      const filename = fileResult.data.Filename || `factura_pedido_${pedidoId}.${download}`;

      return new Response(buffer, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": String(buffer.length),
          "Cache-Control": "no-store",
        },
      });
    }

    // ── Estado JSON ──
    const facRes = await db.execute({
      sql: "SELECT * FROM Factura WHERE Id_Pedido = ? AND Id_Usuario = ? ORDER BY Id_Factura DESC LIMIT 1",
      args: [pedidoId, user.userId],
    });

    if (!facRes.rows.length) {
      return json({
        success: true,
        factura: null,
        canRequest: eligibility.can,
        isTestOverride: eligibility.isTestOverride,
        reason: eligibility.can
          ? null
          : "La factura estará disponible cuando el pedido sea entregado.",
      });
    }

    const f = facRes.rows[0];
    return json({
      success: true,
      canRequest: eligibility.can,
      isTestOverride: eligibility.isTestOverride,
      factura: {
        id: Number(f.Id_Factura),
        facturamaId: String(f.Facturama_Id || ""),
        uuid: String(f.UUID || ""),
        rfcReceptor: String(f.RFC_Receptor || ""),
        nombreReceptor: String(f.Nombre_Receptor || ""),
        usoCfdi: String(f.Uso_CFDI || ""),
        regimenFiscal: String(f.Regimen_Fiscal || ""),
        cpFiscal: String(f.CP_Fiscal || ""),
        estado: String(f.Estado || "vigente"),
        total: Number(f.Total || 0),
        fechaEmision: String(f.Fecha_Emision || ""),
      },
    });
  } catch (err) {
    console.error("[GET /api/me/pedidos/[id]/factura]", err);
    return json({ success: false, error: "Error interno del servidor" }, 500);
  }
}

// ──────────────────── POST ────────────────────
export async function POST({ params, cookies, request }) {
  const user = getSession(cookies);
  if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);

  const pedidoId = Number(params.id);
  if (!pedidoId) return json({ success: false, error: "ID de pedido inválido" }, 400);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "Cuerpo JSON inválido" }, 400);
  }

  const { rfc, nombre, usoCfdi, regimenFiscal, cpFiscal } = body || {};

  if (!rfc || String(rfc).trim().length < 12) {
    return json({ success: false, error: "RFC inválido (mínimo 12 caracteres)" }, 400);
  }
  if (!nombre || String(nombre).trim().length < 3) {
    return json({ success: false, error: "Nombre o razón social inválido" }, 400);
  }

  const rfcClean = String(rfc).trim().toUpperCase().replace(/\s+/g, "");
  if (rfcClean.length < 12 || rfcClean.length > 13) {
    return json({ success: false, error: "RFC debe tener 12 caracteres (moral) o 13 (física)" }, 400);
  }

  try {
    await ensureFacturaTable();

    // Verificar propiedad y estado del pedido
    const orderRes = await db.execute({
      sql: `SELECT p.Id_Pedido, p.Estado, p.Total, p.Numero_Pedido, pg.Metodo_Pago
            FROM Pedido p
            LEFT JOIN Pago pg ON pg.Id_Pedido = p.Id_Pedido
            WHERE p.Id_Pedido = ? AND p.Id_Usuario = ?
            LIMIT 1`,
      args: [pedidoId, user.userId],
    });
    if (!orderRes.rows.length) return json({ success: false, error: "Pedido no encontrado" }, 404);

    const pr = orderRes.rows[0];
    const eligibility = canRequestFactura(user, pr.Estado);
    if (!eligibility.can) {
      return json(
        { success: false, error: "El pedido debe estar entregado para solicitar factura" },
        403
      );
    }

    // Solo se permite una factura vigente por pedido
    const existing = await db.execute({
      sql: "SELECT Id_Factura FROM Factura WHERE Id_Pedido = ? AND Id_Usuario = ? AND Estado = 'vigente' LIMIT 1",
      args: [pedidoId, user.userId],
    });
    if (existing.rows.length) {
      return json({ success: false, error: "Ya existe una factura vigente para este pedido" }, 409);
    }

    // Obtener artículos del pedido
    const itemsRes = await db.execute({
      sql: `SELECT dp.Id_Producto AS productoId,
                   dp.Cantidad AS cantidad,
                   dp.Precio_Unitario AS precioUnitario,
                   prod.Nombre AS nombre
            FROM DetallePedido dp
            JOIN Producto prod ON prod.Id_Producto = dp.Id_Producto
            WHERE dp.Id_Pedido = ?`,
      args: [pedidoId],
    });

    if (!itemsRes.rows.length) {
      return json({ success: false, error: "No se encontraron productos en el pedido" }, 422);
    }

    const items = itemsRes.rows.map((r) => ({
      productoId: Number(r.productoId),
      cantidad: Number(r.cantidad),
      precioUnitario: Number(r.precioUnitario),
      nombre: String(r.nombre || "Producto"),
    }));

    // Llamar a Facturama
    const result = await crearFactura({
      pedido: {
        items,
        pago: { metodo: String(pr.Metodo_Pago || "") },
        numero: Number(pr.Numero_Pedido || pedidoId),
      },
      receptor: {
        rfc: rfcClean,
        nombre: String(nombre).trim(),
        usoCfdi: String(usoCfdi || "G03"),
        regimenFiscal: String(regimenFiscal || "616"),
        cpFiscal: String(cpFiscal || "64000"),
      },
    });

    if (!result.ok) {
      const d = result.data;
      console.error("[Facturama POST /3/cfdis] status:", result.status);
      console.error("[Facturama POST /3/cfdis] body:", JSON.stringify(d, null, 2));

      let errMsg;
      if (Array.isArray(d) && d.length > 0) {
        errMsg = d
          .map((e) => {
            const parts = [];
            if (e.Detail) parts.push(e.Detail);
            if (e.Message) parts.push(e.Message);
            if (e.Property) parts.push(`(campo: ${e.Property})`);
            return parts.length ? parts.join(" ") : JSON.stringify(e);
          })
          .join(" | ");
      } else {
        errMsg =
          d?.Message ||
          d?.message ||
          d?.Detail ||
          (d?.raw ? String(d.raw).slice(0, 400) : null) ||
          JSON.stringify(d).slice(0, 400);
      }

      return json(
        { success: false, error: `Error al timbrar CFDI: ${errMsg}` },
        422
      );
    }

    const cfdi = result.data;
    const facturamaId = String(cfdi.Id || "");
    const uuid = String(
      cfdi.Complement?.TaxStamp?.UUID ||
        cfdi.ComplementoTimbre?.UUID ||
        ""
    );
    const fechaEmision = String(cfdi.Date || new Date().toISOString());
    const totalCfdi = Number(cfdi.Total || pr.Total || 0);

    // Guardar en DB
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO Factura
              (Id_Pedido, Id_Usuario, Facturama_Id, UUID, RFC_Receptor, Nombre_Receptor,
               Uso_CFDI, Regimen_Fiscal, CP_Fiscal, Total, Fecha_Emision, Estado, Fecha_Creacion)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'vigente', ?)`,
      args: [
        pedidoId,
        user.userId,
        facturamaId,
        uuid,
        rfcClean,
        String(nombre).trim().toUpperCase(),
        String(usoCfdi || "G03"),
        String(regimenFiscal || "616"),
        String(cpFiscal || "64000"),
        totalCfdi,
        fechaEmision,
        now,
      ],
    });

    return json(
      {
        success: true,
        message: "Factura generada y timbrada exitosamente",
        factura: {
          facturamaId,
          uuid,
          rfcReceptor: rfcClean,
          nombreReceptor: String(nombre).trim().toUpperCase(),
          total: totalCfdi,
          fechaEmision,
        },
      },
      201
    );
  } catch (err) {
    console.error("[POST /api/me/pedidos/[id]/factura]", err);
    return json({ success: false, error: "Error interno al generar la factura" }, 500);
  }
}

// ──────────────────── DELETE ─────────────────
// Cancela una factura vigente (CFDI) en Facturama y la marca cancelada en DB
// Body: { motivo: "01"|"02"|"03"|"04", folioSustitucion?: "uuid" }
export async function DELETE({ params, cookies, request }) {
  const user = getSession(cookies);
  if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);

  const rol = String(user.rol || "").toLowerCase();
  if (rol !== "admin" && rol !== "superusuario") {
    return json({ success: false, error: "Sin permisos para cancelar facturas" }, 403);
  }

  const pedidoId = Number(params.id);
  if (!pedidoId) return json({ success: false, error: "ID de pedido inválido" }, 400);

  let body = {};
  try { body = await request.json(); } catch { /* sin body */ }

  const motivo = ["01", "02", "03", "04"].includes(body?.motivo) ? body.motivo : "02";
  const folioSustitucion = body?.folioSustitucion ? String(body.folioSustitucion).trim() : null;

  try {
    await ensureFacturaTable();

    const facRes = await db.execute({
      sql: `SELECT Id_Factura, Facturama_Id FROM Factura
            WHERE Id_Pedido = ? AND Estado = 'vigente'
            ORDER BY Id_Factura DESC LIMIT 1`,
      args: [pedidoId],
    });
    if (!facRes.rows.length) {
      return json({ success: false, error: "No existe factura vigente para cancelar" }, 404);
    }

    const row = facRes.rows[0];
    const facturamaId = String(row.Facturama_Id || "");
    if (!facturamaId) return json({ success: false, error: "ID de Facturama no disponible" }, 422);

    const cancelResult = await cancelarCfdi(facturamaId, motivo, folioSustitucion);
    if (!cancelResult.ok) {
      const d = cancelResult.data;
      const errMsg = d?.Message || d?.message || d?.Detail || JSON.stringify(d).slice(0, 300);
      console.error("[DELETE factura pedido] Facturama error:", JSON.stringify(d, null, 2));
      return json({ success: false, error: `Error al cancelar en Facturama: ${errMsg}` }, 422);
    }

    await db.execute({
      sql: `UPDATE Factura SET Estado = 'cancelada' WHERE Id_Factura = ?`,
      args: [Number(row.Id_Factura)],
    });

    return json({ success: true, message: "Factura cancelada exitosamente" });
  } catch (err) {
    console.error("[DELETE /api/me/pedidos/[id]/factura]", err);
    return json({ success: false, error: "Error interno al cancelar la factura" }, 500);
  }
}
