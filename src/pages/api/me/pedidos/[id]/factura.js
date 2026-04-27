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

async function ensureUsuarioDatosFiscalesSchema() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS UsuarioDatosFiscales (
      Id_Datos integer PRIMARY KEY AUTOINCREMENT,
      Id_Usuario integer NOT NULL UNIQUE,
      RFC_Fiscal text NOT NULL,
      Razon_Social_Fiscal text NOT NULL,
      Regimen_Fiscal text NOT NULL,
      Codigo_Postal_Fiscal text NOT NULL,
      Uso_CFDI text DEFAULT 'G03' NOT NULL,
      Fecha_Creacion text NOT NULL,
      Fecha_Actualizacion text NOT NULL,
      CONSTRAINT fk_UsuarioDatosFiscales_Id_Usuario_Usuario_Id_fk
        FOREIGN KEY (Id_Usuario) REFERENCES Usuario(Id) ON DELETE CASCADE
    )
  `);

  const cols = await db.execute("PRAGMA table_info(UsuarioDatosFiscales)");
  const hasUsoCfdi = cols.rows.some((row) => String(row.name || "") === "Uso_CFDI");
  if (!hasUsoCfdi) {
    await db.execute("ALTER TABLE UsuarioDatosFiscales ADD COLUMN Uso_CFDI text DEFAULT 'G03' NOT NULL");
  }
}

async function getSavedFiscalData(userId) {
  const result = await db.execute({
    sql: `
      SELECT RFC_Fiscal, Razon_Social_Fiscal, Regimen_Fiscal, Codigo_Postal_Fiscal, Uso_CFDI
      FROM UsuarioDatosFiscales
      WHERE Id_Usuario = ?
      LIMIT 1
    `,
    args: [Number(userId)],
  });
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    rfcFiscal: String(row.RFC_Fiscal || ""),
    razonSocialFiscal: String(row.Razon_Social_Fiscal || ""),
    regimenFiscal: String(row.Regimen_Fiscal || ""),
    codigoPostalFiscal: String(row.Codigo_Postal_Fiscal || ""),
    usoCfdi: String(row.Uso_CFDI || "G03"),
  };
}

function normalizeFiscalInput(body = {}) {
  return {
    rfc: String(body?.rfc || "").trim().toUpperCase().replace(/\s+/g, ""),
    nombre: String(body?.nombre || "").trim().toUpperCase(),
    usoCfdi: String(body?.usoCfdi || "").trim().toUpperCase(),
    regimenFiscal: String(body?.regimenFiscal || "").trim(),
    cpFiscal: String(body?.cpFiscal || "").trim(),
  };
}

function mergeFiscalInputWithSaved(input, saved = null) {
  return {
    rfc: input.rfc || String(saved?.rfcFiscal || "").trim().toUpperCase(),
    nombre: input.nombre || String(saved?.razonSocialFiscal || "").trim().toUpperCase(),
    usoCfdi: input.usoCfdi || String(saved?.usoCfdi || "G03").trim().toUpperCase(),
    regimenFiscal: input.regimenFiscal || String(saved?.regimenFiscal || "616").trim(),
    cpFiscal: input.cpFiscal || String(saved?.codigoPostalFiscal || "64000").trim(),
  };
}

async function upsertSavedFiscalData(userId, fiscal) {
  const now = new Date().toISOString();
  await db.execute({
    sql: `
      INSERT INTO UsuarioDatosFiscales
        (Id_Usuario, RFC_Fiscal, Razon_Social_Fiscal, Regimen_Fiscal, Codigo_Postal_Fiscal, Uso_CFDI, Fecha_Creacion, Fecha_Actualizacion)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(Id_Usuario) DO UPDATE SET
        RFC_Fiscal = excluded.RFC_Fiscal,
        Razon_Social_Fiscal = excluded.Razon_Social_Fiscal,
        Regimen_Fiscal = excluded.Regimen_Fiscal,
        Codigo_Postal_Fiscal = excluded.Codigo_Postal_Fiscal,
        Uso_CFDI = excluded.Uso_CFDI,
        Fecha_Actualizacion = excluded.Fecha_Actualizacion
    `,
    args: [
      Number(userId),
      fiscal.rfc,
      fiscal.nombre,
      fiscal.regimenFiscal,
      fiscal.cpFiscal,
      fiscal.usoCfdi,
      now,
      now,
    ],
  });
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
    await ensureUsuarioDatosFiscalesSchema();

    // Verificar propiedad del pedido
    const orderRes = await db.execute({
      sql: "SELECT Id_Pedido, Estado FROM Pedido WHERE Id_Pedido = ? AND Id_Usuario = ? LIMIT 1",
      args: [pedidoId, user.userId],
    });
    if (!orderRes.rows.length) return json({ success: false, error: "Pedido no encontrado" }, 404);

    const estadoPedido = String(orderRes.rows[0].Estado || "");
    const eligibility = canRequestFactura(user, estadoPedido);
    const savedFiscalData = await getSavedFiscalData(user.userId);

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
        datosFiscales: savedFiscalData,
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
      datosFiscales: savedFiscalData,
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

  const saveFiscalData = body?.saveFiscalData !== false;

  const inputFiscal = normalizeFiscalInput(body || {});

  try {
    await ensureFacturaTable();
    await ensureUsuarioDatosFiscalesSchema();

    const savedFiscalData = await getSavedFiscalData(user.userId);
    const mergedFiscal = mergeFiscalInputWithSaved(inputFiscal, savedFiscalData);

    const rfcClean = mergedFiscal.rfc;
    const receptorName = mergedFiscal.nombre;
    const receptorUsoCfdi = mergedFiscal.usoCfdi || "G03";
    const receptorRegimen = mergedFiscal.regimenFiscal || "616";
    const receptorCpFiscal = mergedFiscal.cpFiscal || "64000";

    if (!rfcClean || rfcClean.length < 12) {
      return json({ success: false, error: "RFC invalido (minimo 12 caracteres)" }, 400);
    }
    if (!receptorName || receptorName.length < 3) {
      return json({ success: false, error: "Nombre o razon social invalido" }, 400);
    }

    if (!/^\d{5}$/.test(receptorCpFiscal)) {
      return json({ success: false, error: "Codigo postal fiscal invalido" }, 400);
    }

    if (!receptorRegimen) {
      return json({ success: false, error: "Regimen fiscal invalido" }, 400);
    }

    if (rfcClean.length < 12 || rfcClean.length > 13) {
      return json({ success: false, error: "RFC debe tener 12 caracteres (moral) o 13 (fisica)" }, 400);
    }

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
        nombre: receptorName,
        usoCfdi: receptorUsoCfdi,
        regimenFiscal: receptorRegimen,
        cpFiscal: receptorCpFiscal,
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
        receptorName,
        receptorUsoCfdi,
        receptorRegimen,
        receptorCpFiscal,
        totalCfdi,
        fechaEmision,
        now,
      ],
    });

    if (saveFiscalData) {
      await upsertSavedFiscalData(user.userId, {
        rfc: rfcClean,
        nombre: receptorName,
        usoCfdi: receptorUsoCfdi,
        regimenFiscal: receptorRegimen,
        cpFiscal: receptorCpFiscal,
      });
    }

    return json(
      {
        success: true,
        message: "Factura generada y timbrada exitosamente",
        factura: {
          facturamaId,
          uuid,
          rfcReceptor: rfcClean,
          nombreReceptor: receptorName,
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
