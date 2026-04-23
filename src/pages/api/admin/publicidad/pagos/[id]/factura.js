// GET  /api/admin/publicidad/pagos/[id]/factura  → estado JSON | ?download=pdf|xml
// POST /api/admin/publicidad/pagos/[id]/factura  → emitir CFDI (Nexus → Empresa)
// DELETE /api/admin/publicidad/pagos/[id]/factura → cancelar CFDI
import { createClient } from "@libsql/client";
import { crearFactura, obtenerArchivoCfdi, cancelarCfdi } from "../../../../../../lib/facturama.js";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../../../../../lib/session.js";

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

function isAdmin(user) {
  const rol = String(user?.rol || "").toLowerCase();
  return rol === "admin" || rol === "superusuario";
}

// Crea la tabla FacturaPublicidad si no existe y aplica migraciones de esquema
async function ensureFacturaPublicidadTable() {
  return true;
}

// ──────────────────── GET ────────────────────
export async function GET({ params, cookies, request }) {
  const user = getSession(cookies);
  if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);
  if (!isAdmin(user)) return json({ success: false, error: "Sin permisos" }, 403);

  const campanaId = Number(params.id);
  if (!campanaId) return json({ success: false, error: "ID de campaña inválido" }, 400);

  const url = new URL(request.url);
  const download = url.searchParams.get("download"); // "pdf" | "xml"

  try {
    await ensureFacturaPublicidadTable();

    // Verificar que la campaña existe
    const campRes = await db.execute({
      sql: `SELECT Id_Publicidad, Monto FROM PublicidadCampana WHERE Id_Publicidad = ? LIMIT 1`,
      args: [campanaId],
    });
    if (!campRes.rows.length) return json({ success: false, error: "Campaña no encontrada" }, 404);

    if (download === "pdf" || download === "xml") {
      const facRes = await db.execute({
        sql: `SELECT Facturama_Id FROM FacturaPublicidad
              WHERE Id_Campana = ? AND Estado = 'vigente'
              ORDER BY Id_FacturaPublicidad DESC LIMIT 1`,
        args: [campanaId],
      });
      if (!facRes.rows.length) {
        return json({ success: false, error: "No existe factura vigente para esta campaña" }, 404);
      }
      const facturamaId = String(facRes.rows[0].Facturama_Id || "");
      if (!facturamaId) return json({ success: false, error: "ID de Facturama no disponible" }, 422);

      const fileResult = await obtenerArchivoCfdi(facturamaId, download);
      if (!fileResult.ok || !fileResult.data?.Content) {
        return json({ success: false, error: "No se pudo obtener el archivo de Facturama" }, 502);
      }

      const buffer = Buffer.from(fileResult.data.Content, "base64");
      const contentType = download === "pdf" ? "application/pdf" : "application/xml";
      const filename = fileResult.data.Filename || `factura_publicidad_${campanaId}.${download}`;

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

    // Estado JSON
    const facRes = await db.execute({
      sql: `SELECT * FROM FacturaPublicidad WHERE Id_Campana = ? ORDER BY Id_FacturaPublicidad DESC LIMIT 1`,
      args: [campanaId],
    });

    if (!facRes.rows.length) {
      return json({ success: true, factura: null });
    }

    const f = facRes.rows[0];
    return json({
      success: true,
      factura: {
        id: Number(f.Id_FacturaPublicidad),
        facturamaId: String(f.Facturama_Id || ""),
        uuid: String(f.UUID || ""),
        rfcReceptor: String(f.RFC_Receptor || ""),
        nombreReceptor: String(f.Nombre_Receptor || ""),
        usoCfdi: String(f.Uso_CFDI || ""),
        regimenFiscal: String(f.Regimen_Fiscal || ""),
        cpFiscal: String(f.CP_Fiscal || ""),
        total: Number(f.Total || 0),
        fechaEmision: String(f.Fecha_Emision || ""),
        estado: String(f.Estado || "vigente"),
      },
    });
  } catch (err) {
    console.error("[GET admin publicidad factura]", err);
    return json({ success: false, error: "Error interno del servidor" }, 500);
  }
}

// ──────────────────── POST ────────────────────
// Body: { rfc, nombre, usoCfdi, regimenFiscal, cpFiscal }
export async function POST({ params, cookies, request }) {
  const user = getSession(cookies);
  if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);
  if (!isAdmin(user)) return json({ success: false, error: "Sin permisos" }, 403);

  const campanaId = Number(params.id);
  if (!campanaId) return json({ success: false, error: "ID de campaña inválido" }, 400);

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
    return json({ success: false, error: "RFC debe tener 12 (moral) o 13 (física) caracteres" }, 400);
  }

  try {
    await ensureFacturaPublicidadTable();

    // Obtener datos de la campaña
    const campRes = await db.execute({
      sql: `
        SELECT
          pc.Id_Publicidad,
          pc.Monto,
          pc.Duracion_Dias,
          pc.Posicion,
          pc.Id_Empresa,
          pc.Payment_Intent_Id,
          p.Nombre AS Nombre_Producto
        FROM PublicidadCampana pc
        LEFT JOIN Producto p ON p.Id_Producto = pc.Id_Producto
        WHERE pc.Id_Publicidad = ?
        LIMIT 1
      `,
      args: [campanaId],
    });
    if (!campRes.rows.length) return json({ success: false, error: "Campaña no encontrada" }, 404);

    const camp = campRes.rows[0];

    // Verificar que no haya factura vigente ya
    const existing = await db.execute({
      sql: `SELECT Id_FacturaPublicidad FROM FacturaPublicidad
            WHERE Id_Campana = ? AND Estado = 'vigente' LIMIT 1`,
      args: [campanaId],
    });
    if (existing.rows.length) {
      return json({ success: false, error: "Ya existe una factura vigente para esta campaña" }, 409);
    }

    // El servicio facturado es el servicio de publicidad
    const monto = Number(camp.Monto || 0);
    const posicionLabel = String(camp.Posicion || "publicidad").replace(/^./, (c) => c.toUpperCase());
    const nombreProducto = String(camp.Nombre_Producto || "Producto");
    const descripcionServicio = `Servicio de publicidad digital - ${posicionLabel} - ${String(camp.Duracion_Dias || 1)} día(s) - ${nombreProducto}`;

    // Construir item de servicio de publicidad
    // ProductCode 80141500 = Servicios de publicidad (SAT)
    const montoSinIva = Math.round((monto / 1.16) * 1e6) / 1e6;
    const subtotal = Math.round(montoSinIva * 100) / 100;
    const ivaMonto = Math.round(subtotal * 0.16 * 100) / 100;
    const total = Math.round((subtotal + ivaMonto) * 100) / 100;

    const pedidoFake = {
      items: [
        {
          productoId: campanaId,
          cantidad: 1,
          precioUnitario: monto,  // con IVA incluido — facturama.js lo descompone
          nombre: descripcionServicio.substring(0, 1000),
        },
      ],
      pago: { metodo: camp.Payment_Intent_Id?.startsWith("pi_") ? "tarjeta" : "transferencia" },
      numero: campanaId,
    };

    const result = await crearFactura({
      pedido: pedidoFake,
      receptor: {
        rfc: rfcClean,
        nombre: String(nombre).trim(),
        usoCfdi: String(usoCfdi || "G03"),
        regimenFiscal: String(regimenFiscal || "601"),
        cpFiscal: String(cpFiscal || "64000"),
      },
    });

    if (!result.ok) {
      const d = result.data;
      console.error("[Facturama publicidad POST] status:", result.status);
      console.error("[Facturama publicidad POST] body:", JSON.stringify(d, null, 2));

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
          d?.Message || d?.message || d?.Detail ||
          (d?.raw ? String(d.raw).slice(0, 400) : null) ||
          JSON.stringify(d).slice(0, 400);
      }

      return json({ success: false, error: `Error al timbrar CFDI: ${errMsg}` }, 422);
    }

    const cfdi = result.data;
    const facturamaId = String(cfdi.Id || "");
    const uuid = String(cfdi.Complement?.TaxStamp?.UUID || cfdi.ComplementoTimbre?.UUID || "");
    const fechaEmision = String(cfdi.Date || new Date().toISOString());

    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO FacturaPublicidad
              (Id_Campana, Id_Empresa, Facturama_Id, UUID, RFC_Receptor, Nombre_Receptor,
               Uso_CFDI, Regimen_Fiscal, CP_Fiscal, Total, Fecha_Emision, Estado, Fecha_Creacion)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'vigente', ?)`,
      args: [
        campanaId,
        camp.Id_Empresa ? Number(camp.Id_Empresa) : null,
        facturamaId,
        uuid,
        rfcClean,
        String(nombre).trim().toUpperCase(),
        String(usoCfdi || "G03"),
        String(regimenFiscal || "601"),
        String(cpFiscal || "64000"),
        total,
        fechaEmision,
        now,
      ],
    });

    return json(
      {
        success: true,
        message: "Factura de publicidad generada y timbrada exitosamente",
        factura: {
          facturamaId,
          uuid,
          rfcReceptor: rfcClean,
          nombreReceptor: String(nombre).trim().toUpperCase(),
          total,
          fechaEmision,
        },
      },
      201
    );
  } catch (err) {
    console.error("[POST admin publicidad factura]", err);
    return json({ success: false, error: "Error interno al generar la factura" }, 500);
  }
}

// ──────────────────── DELETE ─────────────────
// Body: { motivo: "01"|"02"|"03"|"04", folioSustitucion?: "uuid" }
export async function DELETE({ params, cookies, request }) {
  const user = getSession(cookies);
  if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);
  if (!isAdmin(user)) return json({ success: false, error: "Sin permisos" }, 403);

  const campanaId = Number(params.id);
  if (!campanaId) return json({ success: false, error: "ID de campaña inválido" }, 400);

  let body = {};
  try { body = await request.json(); } catch { /* sin body */ }

  const motivo = ["01", "02", "03", "04"].includes(body?.motivo) ? body.motivo : "02";
  const folioSustitucion = body?.folioSustitucion ? String(body.folioSustitucion).trim() : null;

  try {
    await ensureFacturaPublicidadTable();

    const facRes = await db.execute({
      sql: `SELECT Id_FacturaPublicidad, Facturama_Id FROM FacturaPublicidad
            WHERE Id_Campana = ? AND Estado = 'vigente'
            ORDER BY Id_FacturaPublicidad DESC LIMIT 1`,
      args: [campanaId],
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
      console.error("[DELETE publicidad factura] Facturama error:", JSON.stringify(d, null, 2));
      return json({ success: false, error: `Error al cancelar en Facturama: ${errMsg}` }, 422);
    }

    await db.execute({
      sql: `UPDATE FacturaPublicidad SET Estado = 'cancelada' WHERE Id_FacturaPublicidad = ?`,
      args: [Number(row.Id_FacturaPublicidad)],
    });

    return json({ success: true, message: "Factura cancelada exitosamente" });
  } catch (err) {
    console.error("[DELETE admin publicidad factura]", err);
    return json({ success: false, error: "Error interno al cancelar la factura" }, 500);
  }
}
