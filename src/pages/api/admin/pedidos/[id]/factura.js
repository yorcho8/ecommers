// src/pages/api/me/pedidos/[id]/factura.js
import { createClient } from "@libsql/client";
import "dotenv/config";
import { getSessionFromCookies, normalizeRole } from "../../../../../lib/session.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

// ── Helpers ────────────────────────────────────────────────────────────────

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getSession(cookies) {
  return getSessionFromCookies(cookies);
}

function getEnv(key) {
  return String(process.env[key] ?? import.meta.env?.[key] ?? "").trim();
}

// ── Facturama client ───────────────────────────────────────────────────────

function facturamaAuth() {
  const user = getEnv("FACTURAMA_USER");
  const pass = getEnv("FACTURAMA_PASSWORD");
  if (!user || !pass) throw new Error("Faltan credenciales de Facturama (FACTURAMA_USER / FACTURAMA_PASSWORD)");
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

function facturamaBase() {
  // Cambia a https://api.facturama.mx en producción
  return getEnv("FACTURAMA_BASE_URL") || "https://apisandbox.facturama.mx";
}

async function facturamaRequest(method, path, body = null, taxpayerId = null) {
  const base = facturamaBase();
  // Multiemisor: /multi-issuer/{taxpayerId}/...  |  Single: /...
  const url = taxpayerId ? `${base}/multi-issuer/${taxpayerId}${path}` : `${base}${path}`;
  const headers = {
    Authorization: facturamaAuth(),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { rawText: text }; }
  return { ok: res.ok, status: res.status, data };
}

// ── SAT helpers ────────────────────────────────────────────────────────────

// Forma de pago SAT según método registrado en la BD
function formaPagoSAT(metodoPago) {
  const m = String(metodoPago || "").toLowerCase();
  if (m.includes("credito") || m.includes("credit")) return "04";
  if (m.includes("debito")  || m.includes("debit"))  return "28";
  if (m.includes("transfer"))                         return "03";
  if (m.includes("efectivo") || m.includes("cash"))   return "01";
  return "99"; // por definir
}

// Fallbacks SAT si el producto no tiene claves configuradas
const DEFAULT_CLAVE_PROD_SERV = "01010101"; // "No existe en el catálogo"
const DEFAULT_CLAVE_UNIDAD    = "H87";       // Pieza
const DEFAULT_UNIDAD_LABEL    = "Pieza";

// ── DB helpers ─────────────────────────────────────────────────────────────

async function getPedidoConEmpresa(pedidoId, userId) {
  // Trae el pedido + datos de la empresa emisora (de los productos)
  const res = await db.execute({
    sql: `
      SELECT
        p.Id_Pedido, p.Numero_Pedido, p.Fecha_pedido, p.Estado,
        p.Costo_Envio, p.Total, p.Id_Usuario,
        -- Empresa del primer producto del pedido
        emp.Id_Empresa,
        emp.Nombre_Empresa,
        emp.Razon_Social,
        emp.RFC,
        emp.Regimen_Fiscal        AS Emp_Regimen,
        emp.Codigo_Postal_Fiscal  AS Emp_CP,
        -- CSD activo de esa empresa en Facturama
        csd.Facturama_TaxpayerId,
        csd.Estado                AS CSD_Estado,
        -- Pago
        pg.Metodo_Pago, pg.Estado_Pago, pg.Monto AS Monto_Pago,
        pg.Codigo_Transaccion,
        -- Dirección envío
        d.Calle, d.Numero_casa, d.Ciudad, d.Provincia, d.Codigo_Postal, d.Pais
      FROM Pedido p
      JOIN Direccion d     ON d.Id_Direccion = p.Id_Direccion
      LEFT JOIN Pago pg    ON pg.Id_Pedido   = p.Id_Pedido
      -- Empresa desde el primer producto del pedido
      LEFT JOIN (
        SELECT dp.Id_Pedido, prod.Id_Empresa
        FROM DetallePedido dp
        JOIN Producto prod ON prod.Id_Producto = dp.Id_Producto
        WHERE prod.Id_Empresa IS NOT NULL
        GROUP BY dp.Id_Pedido
        ORDER BY dp.Id_Detalle ASC
        LIMIT 1
      ) ep ON ep.Id_Pedido = p.Id_Pedido
      LEFT JOIN Empresa emp ON emp.Id_Empresa = ep.Id_Empresa
      LEFT JOIN EmpresaCSD csd
        ON csd.Id_Empresa = emp.Id_Empresa
        AND csd.Estado = 'activo'
        AND csd.Facturama_TaxpayerId IS NOT NULL
      WHERE p.Id_Pedido = ? AND p.Id_Usuario = ?
      ORDER BY pg.Id_Pago DESC, csd.Id_CSD DESC
      LIMIT 1
    `,
    args: [pedidoId, userId],
  });
  return res.rows[0] || null;
}

async function getItemsConClavesSAT(pedidoId) {
  const res = await db.execute({
    sql: `
      SELECT
        dp.Id_Detalle, dp.Cantidad, dp.Precio_Unitario,
        prod.Id_Producto, prod.Nombre, prod.Descripcion,
        prod.ClaveProdServ, prod.ClaveUnidad, prod.Unidad_Venta,
        pv.Id_Variante,
        pv.ClaveProdServ AS Var_ClaveProdServ,
        pv.ClaveUnidad   AS Var_ClaveUnidad,
        pv.Descripcion   AS Var_Desc
      FROM DetallePedido dp
      JOIN Producto prod ON prod.Id_Producto = dp.Id_Producto
      LEFT JOIN ProductoVariante pv ON pv.Id_Variante = dp.Id_Variante
      WHERE dp.Id_Pedido = ?
      ORDER BY dp.Id_Detalle ASC
    `,
    args: [pedidoId],
  });
  return res.rows;
}

async function getFacturaExistente(pedidoId) {
  const res = await db.execute({
    sql: `SELECT * FROM Factura WHERE Id_Pedido = ? ORDER BY Id_Factura DESC LIMIT 1`,
    args: [pedidoId],
  });
  return res.rows[0] || null;
}

// ── GET ────────────────────────────────────────────────────────────────────
// Devuelve: estado de la factura o elegibilidad para facturar

export async function GET({ params, cookies, request }) {
  const session = getSession(cookies);
  if (!session?.userId) return json({ success: false, error: "No autenticado" }, 401);

  const pedidoId = Number(params.id);
  if (!pedidoId) return json({ success: false, error: "ID inválido" }, 400);

  const url = new URL(request.url);
  const download = url.searchParams.get("download"); // "pdf" | "xml"

  try {
    const pedido = await getPedidoExistente(pedidoId, session.userId);
    if (!pedido) return json({ success: false, error: "Pedido no encontrado" }, 404);

    // ── Descarga de PDF / XML ──────────────────────────────────────────────
    if (download === "pdf" || download === "xml") {
      const factura = await getFacturaExistente(pedidoId);
      if (!factura?.Facturama_Id) return json({ success: false, error: "Factura no encontrada" }, 404);

      // Necesitamos el taxpayerId de la empresa
      const empresaCsd = await getEmpresaCsdDeFactura(factura);
      if (!empresaCsd?.Facturama_TaxpayerId)
        return json({ success: false, error: "Configuración de empresa no disponible" }, 500);

      const formato = download === "pdf" ? "pdf" : "xml";
      const tipo    = "issued"; // facturas emitidas
      const r = await facturamaRequest(
        "GET",
        `/cfdi/${formato}/${tipo}/${factura.Facturama_Id}`,
        null,
        empresaCsd.Facturama_TaxpayerId
      );

      if (!r.ok) return json({ success: false, error: "No se pudo descargar el documento" }, 502);

      // Facturama regresa { Data: "<base64>", ... }
      const base64 = r.data?.Data || r.data?.ContentFile || "";
      const binary  = Buffer.from(base64, "base64");
      const mime    = download === "pdf" ? "application/pdf" : "application/xml";
      const filename = `factura-${pedidoId}.${download}`;

      return new Response(binary, {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": String(binary.length),
        },
      });
    }

    // ── Estado de factura ──────────────────────────────────────────────────
    const factura = await getFacturaExistente(pedidoId);
    if (factura) {
      return json({
        success: true,
        canRequest: false,
        factura: {
          id:            Number(factura.Id_Factura),
          facturamaId:   String(factura.Facturama_Id || ""),
          uuid:          factura.UUID ? String(factura.UUID) : null,
          rfcReceptor:   String(factura.RFC_Receptor || ""),
          nombreReceptor:String(factura.Nombre_Receptor || ""),
          usoCfdi:       String(factura.Uso_CFDI || ""),
          total:         Number(factura.Total || 0),
          fechaEmision:  String(factura.Fecha_Emision || ""),
          estado:        String(factura.Estado || "vigente"),
        },
      });
    }

    // ── Elegibilidad ───────────────────────────────────────────────────────
    const rol = normalizeRole(session?.rol);
    const isSuperuser = rol === "superusuario" || rol === "admin";
    const estadoNorm  = String(pedido.Estado || "").toLowerCase();
    const isEntregado = estadoNorm === "entregado";

    if (!isEntregado && !isSuperuser) {
      return json({
        success: true,
        canRequest: false,
        reason: "La factura estará disponible cuando el pedido sea entregado.",
      });
    }

    return json({
      success: true,
      canRequest: true,
      isTestOverride: isSuperuser && !isEntregado,
      reason: isSuperuser && !isEntregado
        ? "Modo pruebas: disponible para superusuario aunque no esté entregado."
        : "El pedido fue entregado. Puedes solicitar tu factura.",
    });

  } catch (err) {
    console.error("[GET /api/me/pedidos/[id]/factura]", err);
    return json({ success: false, error: "Error interno" }, 500);
  }
}

// ── POST ───────────────────────────────────────────────────────────────────
// Genera el CFDI en Facturama bajo el RFC de la empresa vendedora

export async function POST({ params, cookies, request }) {
  const session = getSession(cookies);
  if (!session?.userId) return json({ success: false, error: "No autenticado" }, 401);

  const pedidoId = Number(params.id);
  if (!pedidoId) return json({ success: false, error: "ID inválido" }, 400);

  let body;
  try { body = await request.json(); }
  catch { return json({ success: false, error: "JSON inválido" }, 400); }

  const rfcReceptor    = String(body?.rfc    || "").toUpperCase().replace(/\s+/g, "");
  const nombreReceptor = String(body?.nombre || "").trim().toUpperCase();
  const usoCfdi        = String(body?.usoCfdi || "G03").toUpperCase();
  const regimenFiscal  = String(body?.regimenFiscal || "616");
  const cpFiscal       = String(body?.cpFiscal || "64000");

  if (rfcReceptor.length < 12 || rfcReceptor.length > 13)
    return json({ success: false, error: "RFC inválido (12 o 13 caracteres)" }, 400);
  if (nombreReceptor.length < 3)
    return json({ success: false, error: "Nombre/razón social requerido" }, 400);

  try {
    // 1. Validar pedido
    const pedido = await getPedidoExistente(pedidoId, session.userId);
    if (!pedido) return json({ success: false, error: "Pedido no encontrado" }, 404);

    const rol = normalizeRole(session?.rol);
    const isSuperuser = rol === "superusuario" || rol === "admin";
    const estadoNorm  = String(pedido.Estado || "").toLowerCase();
    if (estadoNorm !== "entregado" && !isSuperuser)
      return json({ success: false, error: "Solo puedes facturar pedidos entregados" }, 422);

    // 2. Verificar que no exista ya una factura vigente
    const existing = await getFacturaExistente(pedidoId);
    if (existing && existing.Estado === "vigente")
      return json({ success: false, error: "Ya existe una factura vigente para este pedido" }, 409);

    // 3. Obtener empresa + CSD
    const p = await getPedidoConEmpresa(pedidoId, session.userId);
    if (!p) return json({ success: false, error: "Pedido no encontrado" }, 404);

    if (!p.Id_Empresa)
      return json({ success: false, error: "No se pudo determinar la empresa emisora de este pedido" }, 422);

    if (!p.Facturama_TaxpayerId || p.CSD_Estado !== "activo")
      return json({
        success: false,
        error: "La empresa vendedora aún no tiene su certificado fiscal (CSD) configurado para facturación. Contacta al soporte.",
      }, 422);

    if (!p.RFC)
      return json({ success: false, error: "La empresa emisora no tiene RFC registrado" }, 422);

    if (!p.Razon_Social)
      return json({ success: false, error: "La empresa emisora no tiene razón social registrada" }, 422);

    if (!p.Emp_CP)
      return json({ success: false, error: "La empresa emisora no tiene código postal fiscal registrado" }, 422);

    // 4. Obtener items con claves SAT
    const items = await getItemsConClavesSAT(pedidoId);
    if (!items.length) return json({ success: false, error: "El pedido no tiene productos" }, 422);

    // 5. Construir conceptos del CFDI
    const conceptos = items.map((row) => {
      const claveProd  = String(row.Var_ClaveProdServ || row.ClaveProdServ || DEFAULT_CLAVE_PROD_SERV);
      const claveUni   = String(row.Var_ClaveUnidad   || row.ClaveUnidad   || DEFAULT_CLAVE_UNIDAD);
      const desc       = String(row.Var_Desc || row.Nombre || "Producto");
      const unidadLabel= String(row.Unidad_Venta || DEFAULT_UNIDAD_LABEL);
      const cantidad   = Number(row.Cantidad || 1);
      const precioUnit = Number(row.Precio_Unitario || 0);
      // Precio unitario sin IVA (se asume que el precio ya incluye IVA en la BD)
      // Si tus precios son base+IVA, divide entre 1.16:
      const precioBase = Number((precioUnit / 1.16).toFixed(6));
      const subtotal   = Number((precioBase * cantidad).toFixed(2));
      const ivaImporte = Number((subtotal * 0.16).toFixed(2));
      const total      = Number((subtotal + ivaImporte).toFixed(2));

      return {
        ProductCode:          claveProd,
        IdentificationNumber: String(row.Id_Producto || ""),
        Description:          desc.slice(0, 1000),
        Unit:                 unidadLabel,
        UnitCode:             claveUni,
        UnitPrice:            precioBase,
        Quantity:             cantidad,
        Subtotal:             subtotal,
        TaxObject:            "02", // tiene impuestos
        Taxes: [
          {
            Total:       ivaImporte,
            Name:        "IVA",
            Base:        subtotal,
            Rate:        0.16,
            IsRetention: false,
          },
        ],
        Total: total,
      };
    });

    const subtotalGlobal = Number(conceptos.reduce((s, c) => s + c.Subtotal, 0).toFixed(2));
    const ivaGlobal      = Number(conceptos.reduce((s, c) => s + c.Taxes[0].Total, 0).toFixed(2));
    const totalGlobal    = Number((subtotalGlobal + ivaGlobal).toFixed(2));

    // 6. Payload CFDI Facturama Multiemisor
    // Nodo Issuer: identifica a la empresa vendedora (Loly, Grupo Ortiz, etc.)
    // El endpoint cambia a: /multi-issuer/{RFC-emisor}/3/cfdis
    // Folio es obligatorio en multiemisor (no se asigna automático)
    const cfdiPayload = {
      Folio:          Number(p.Numero_Pedido || pedidoId),
      Issuer: {
        Rfc:           String(p.Emp_RFC).trim().toUpperCase(),
        Name:          String(p.Emp_RazonSocial).trim().toUpperCase(),
        FiscalRegime:  String(p.Emp_Regimen || "601"),
      },
      Receiver: {
        Rfc:           rfcReceptor,
        Name:          nombreReceptor,
        CfdiUse:       usoCfdi,
        TaxZipCode:    cpFiscal,
        FiscalRegime:  regimenFiscal,
      },
      CfdiType:        "I",
      PaymentForm:     formaPagoSAT(p.Metodo_Pago),
      PaymentMethod:   "PUE",
      Currency:        "MXN",
      ExpeditionPlace: String(p.Emp_CP),
      Items:           conceptos,
    };

    // 7. Llamar a Facturama Multiemisor
    // POST /multi-issuer/{RFC-de-la-empresa}/3/cfdis
    const fRes = await facturamaRequest("POST", "/3/cfdis", cfdiPayload, p.Facturama_TaxpayerId);

    if (!fRes.ok) {
      const errMsg = fRes.data?.Message || fRes.data?.ModelState
        ? Object.values(fRes.data.ModelState || {}).flat().join(" | ")
        : JSON.stringify(fRes.data);
      console.error("[Facturama POST CFDI]", fRes.status, errMsg);
      return json({
        success: false,
        error: "Facturama rechazó la factura: " + (errMsg || "Error desconocido"),
      }, 422);
    }

    const cfdi = fRes.data;
    const now  = new Date().toISOString();

    // 8. Guardar en BD
    const insRes = await db.execute({
      sql: `INSERT INTO Factura
              (Id_Pedido, Id_Empresa, Id_Usuario, Facturama_Id, UUID,
               RFC_Receptor, Nombre_Receptor, Uso_CFDI, Regimen_Fiscal, CP_Fiscal,
               Total, Fecha_Emision, Estado, Fecha_Creacion)
            VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?)`,
      args: [
        pedidoId,
        Number(p.Id_Empresa),
        session.userId,
        String(cfdi.Id || cfdi.id || ""),
        String(cfdi.Complement?.TaxStamp?.Uuid || cfdi.uuid || ""),
        rfcReceptor,
        nombreReceptor,
        usoCfdi,
        regimenFiscal,
        cpFiscal,
        totalGlobal,
        String(cfdi.Date || now),
        "vigente",
        now,
      ],
    });

    const facturaId = Number(insRes.lastInsertRowid);

    // 9. Guardar conceptos
    for (const item of items) {
      const c = conceptos.find((x) => x.IdentificationNumber === String(item.Id_Producto));
      if (!c) continue;
      await db.execute({
        sql: `INSERT INTO FacturaConcepto
                (Id_Factura, Id_Producto, Id_Variante, ClaveProdServ, ClaveUnidad,
                 NoIdentificacion, Descripcion, Unidad, Cantidad, ValorUnitario,
                 Importe, Impuesto_Tasa, Impuesto_Importe)
              VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?)`,
        args: [
          facturaId,
          Number(item.Id_Producto),
          item.Id_Variante ? Number(item.Id_Variante) : null,
          c.ProductCode,
          c.UnitCode,
          String(item.Id_Producto),
          c.Description,
          c.Unit,
          c.Quantity,
          c.UnitPrice,
          c.Subtotal,
          0.16,
          c.Taxes[0].Total,
        ],
      });
    }

    return json({
      success: true,
      message: "Factura generada correctamente",
      factura: {
        id:          facturaId,
        facturamaId: String(cfdi.Id || ""),
        uuid:        String(cfdi.Complement?.TaxStamp?.Uuid || ""),
        total:       totalGlobal,
        estado:      "vigente",
      },
    }, 201);

  } catch (err) {
    console.error("[POST /api/me/pedidos/[id]/factura]", err);
    return json({ success: false, error: "Error interno: " + (err?.message || err) }, 500);
  }
}

// ── DELETE ─────────────────────────────────────────────────────────────────
// Cancela el CFDI ante el SAT vía Facturama

export async function DELETE({ params, cookies, request }) {
  const session = getSession(cookies);
  if (!session?.userId) return json({ success: false, error: "No autenticado" }, 401);

  const pedidoId = Number(params.id);
  if (!pedidoId) return json({ success: false, error: "ID inválido" }, 400);

  let body;
  try { body = await request.json(); } catch { body = {}; }

  const motivo           = String(body?.motivo || "02"); // 02 = error sin relación
  const folioSustitucion = body?.folioSustitucion ? String(body.folioSustitucion).trim() : null;

  const motivosValidos = ["01", "02", "03", "04"];
  if (!motivosValidos.includes(motivo))
    return json({ success: false, error: "Motivo SAT inválido" }, 400);

  if (motivo === "01" && !folioSustitucion)
    return json({ success: false, error: "El motivo 01 requiere el UUID del CFDI sustituto" }, 400);

  try {
    const factura = await getFacturaExistente(pedidoId);
    if (!factura) return json({ success: false, error: "Factura no encontrada" }, 404);
    if (factura.Id_Usuario !== session.userId) return json({ success: false, error: "Sin permisos" }, 403);
    if (factura.Estado === "cancelada") return json({ success: false, error: "La factura ya fue cancelada" }, 409);
    if (!factura.Facturama_Id) return json({ success: false, error: "Factura sin ID de Facturama" }, 422);

    // Obtener taxpayerId de la empresa
    const csd = await getEmpresaCsdDeFactura(factura);
    if (!csd?.Facturama_TaxpayerId)
      return json({ success: false, error: "CSD de empresa no disponible" }, 422);

    // Construir query string para Facturama
    let qs = `?motive=${motivo}`;
    if (folioSustitucion) qs += `&uuidReplacement=${encodeURIComponent(folioSustitucion)}`;

    const fRes = await facturamaRequest(
      "DELETE",
      `/cfdis/${factura.Facturama_Id}${qs}`,
      null,
      csd.Facturama_TaxpayerId
    );

    if (!fRes.ok) {
      const errMsg = fRes.data?.Message || JSON.stringify(fRes.data);
      console.error("[Facturama DELETE CFDI]", fRes.status, errMsg);
      return json({ success: false, error: "Facturama no pudo cancelar: " + errMsg }, 422);
    }

    // Actualizar BD
    const now = new Date().toISOString();
    await db.execute({
      sql: `UPDATE Factura
            SET Estado = 'cancelada', Motivo_Cancelacion = ?, UUID_Sustitucion = ?, Fecha_Cancelacion = ?
            WHERE Id_Factura = ?`,
      args: [motivo, folioSustitucion || null, now, Number(factura.Id_Factura)],
    });

    return json({ success: true, message: "Factura cancelada ante el SAT" });

  } catch (err) {
    console.error("[DELETE /api/me/pedidos/[id]/factura]", err);
    return json({ success: false, error: "Error interno: " + (err?.message || err) }, 500);
  }
}

// ── Helpers internos ───────────────────────────────────────────────────────

async function getPedidoExistente(pedidoId, userId) {
  const res = await db.execute({
    sql: `SELECT Id_Pedido, Estado, Id_Usuario FROM Pedido WHERE Id_Pedido = ? AND Id_Usuario = ? LIMIT 1`,
    args: [pedidoId, userId],
  });
  return res.rows[0] || null;
}

async function getEmpresaCsdDeFactura(factura) {
  if (!factura?.Id_Empresa) return null;
  const res = await db.execute({
    sql: `SELECT Facturama_TaxpayerId, Estado
          FROM EmpresaCSD
          WHERE Id_Empresa = ? AND Estado = 'activo' AND Facturama_TaxpayerId IS NOT NULL
          ORDER BY Id_CSD DESC LIMIT 1`,
    args: [Number(factura.Id_Empresa)],
  });
  return res.rows[0] || null;
}