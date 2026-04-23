// src/lib/facturama.js
// Servicio para crear y gestionar CFDIs a través de la API Web de Facturama
import "dotenv/config";

const BASE_URL =
  process.env.FACTURAMA_URL ||
  import.meta.env.FACTURAMA_URL ||
  "https://apisandbox.facturama.mx";

function getAuthHeader() {
  const user = process.env.FACTURAMA_USER || import.meta.env.FACTURAMA_USER;
  const pass = process.env.FACTURAMA_PASS || import.meta.env.FACTURAMA_PASS;
  if (!user || !pass) {
    throw new Error("Credenciales de Facturama no configuradas (FACTURAMA_USER / FACTURAMA_PASS)");
  }
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

async function facturamaFetch(path, method = "GET", body = null) {
  const headers = {
    Authorization: getAuthHeader(),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const opts = { method, headers };
  if (body !== null) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE_URL}${path}`, opts);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return { ok: res.ok, status: res.status, data };
}

// Mapear método de pago del sistema a clave SAT de forma de pago
// «99» (Por definir) SÓLO es válido con PaymentMethod «PPD», nunca con «PUE».
// Para e-commerce con Stripe el default seguro es «04» (Tarjeta de crédito).
function mapPaymentForm(metodo) {
  const m = String(metodo || "").toLowerCase();
  if (m.includes("debito") || m.includes("debit")) return "28";
  if (m.includes("transfer") || m.includes("transf")) return "03";
  if (m.includes("efectivo") || m.includes("cash")) return "01";
  // credito, tarjeta, card, stripe, o cualquier otro → 04 Tarjeta de crédito
  return "04";
}

/**
 * Crea un CFDI 4.0 de tipo Ingreso.
 * @param {object} opts
 * @param {object} opts.pedido  { items, pago, numero }
 * @param {object} opts.receptor { rfc, nombre, usoCfdi, regimenFiscal, cpFiscal }
 */
// RFCs genéricos SAT que exigen CfdiUse="S01" y FiscalRegime="616"
const GENERIC_RFCS = new Set(["XAXX010101000", "XEXX010101000"]);

export async function crearFactura({ pedido, receptor }) {
  const { items, pago, numero } = pedido;

  // Precisión requerida por SAT: 6 decimales para precios unitarios, 2 para totales
  const round6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
  const round2 = (n) => Math.round(Number(n) * 100) / 100;

  const cfdiItems = items.map((item, idx) => {
    const qty = Math.max(Number(item.cantidad || 1), 1);
    // Los precios almacenados incluyen IVA 16% — descomponerlos para el CFDI
    const precioConIva = Number(item.precioUnitario || 0);
    const unitPriceNoIva = round6(precioConIva / 1.16);
    const subtotal = round2(unitPriceNoIva * qty);
    const ivaMonto = round2(subtotal * 0.16);
    const total = round2(subtotal + ivaMonto);

    return {
      ProductCode: "43232408", // Artículos/accesorios de consumo general
      IdentificationNumber: String(item.productoId || idx + 1).padStart(4, "0"),
      Description: String(item.nombre || "Producto").substring(0, 1000),
      Unit: "Pieza",
      UnitCode: "H87",
      UnitPrice: unitPriceNoIva,
      Quantity: qty,
      Subtotal: subtotal,
      TaxObject: "02",
      Taxes: [
        {
          Total: ivaMonto,
          Name: "IVA",
          Base: subtotal,
          Rate: 0.16,
          IsRetention: false,
        },
      ],
      Total: total,
    };
  });

  const paymentForm = pago ? mapPaymentForm(pago.metodo) : "04";
  const cpEmisor =
    process.env.FACTURAMA_CP_EMISOR ||
    import.meta.env.FACTURAMA_CP_EMISOR ||
    "64000";

  const rfcClean = String(receptor.rfc).toUpperCase().trim();
  const isGenericRfc = GENERIC_RFCS.has(rfcClean);

  // SAT: RFC genérico sólo acepta CfdiUse=S01 y FiscalRegime=616
  // Además, el régimen 616 (Sin obligaciones fiscales) SOLO acepta CfdiUse=S01
  const fiscalRegime = isGenericRfc ? "616" : String(receptor.regimenFiscal || "601");
  const cfdiUse = (isGenericRfc || fiscalRegime === "616") ? "S01" : String(receptor.usoCfdi || "G03");

  // --- Auto-corrección SAT: tipo de persona vs régimen fiscal ---
  // RFC 12 chars = Persona Moral | RFC 13 chars = Persona Física
  const esPersonaFisica = rfcClean.length === 13;
  const REGIMENES_SOLO_MORAL  = new Set(["601", "603"]);
  const REGIMENES_SOLO_FISICA = new Set(["605","606","608","610","611","612","614","615","621","622","623","624","625","626"]);
  // D01-D10 = deducciones personales, solo válidas para Personas Físicas
  const USOS_SOLO_FISICA = new Set(["D01","D02","D03","D04","D05","D06","D07","D08","D09","D10"]);

  let finalRegimen = fiscalRegime;
  let finalCfdiUse = cfdiUse;

  if (!isGenericRfc) {
    if (esPersonaFisica && REGIMENES_SOLO_MORAL.has(fiscalRegime)) {
      finalRegimen = "612"; // Personas Físicas con Actividades Empresariales
    } else if (!esPersonaFisica && REGIMENES_SOLO_FISICA.has(fiscalRegime)) {
      finalRegimen = "601"; // General de Ley Personas Morales
    }
    if (finalRegimen === "616") {
      finalCfdiUse = "S01";
    } else if (!esPersonaFisica && USOS_SOLO_FISICA.has(cfdiUse)) {
      finalCfdiUse = "G03"; // D01-D10 no aplican a Personas Morales
    }
  }

  const folio = numero ? String(numero) : undefined;

  // SAT CFDI 4.0: cuando el receptor es RFC genérico (público en general),
  // es obligatorio incluir GlobalInformation con periodicidad, meses y año.
  const globalInfo = isGenericRfc
    ? { Periodicity: "04", Months: String(new Date().getMonth() + 1).padStart(2, "0"), Year: String(new Date().getFullYear()) }
    : undefined;

  const payload = {
    NameId: "1",
    ...(folio ? { Folio: folio } : {}),
    CfdiType: "I",
    PaymentForm: paymentForm,
    PaymentMethod: "PUE",
    ExpeditionPlace: cpEmisor,
    ...(globalInfo ? { GlobalInformation: globalInfo } : {}),
    Receiver: {
      Rfc: rfcClean,
      Name: String(receptor.nombre).toUpperCase().trim().substring(0, 254),
      CfdiUse: finalCfdiUse,
      FiscalRegime: finalRegimen,
      TaxZipCode: String(receptor.cpFiscal || cpEmisor),
    },
    Items: cfdiItems,
  };

  console.log("[Facturama] payload ->", JSON.stringify(payload, null, 2));
  return await facturamaFetch("/3/cfdis", "POST", payload);
}

/**
 * Descarga un archivo de CFDI (PDF o XML) en base64.
 * @param {string} cfdiId  ID del CFDI en Facturama
 * @param {"pdf"|"xml"|"html"} tipo
 * @returns {{ ok, status, data: { Content, ContentType, Filename } }}
 */
export async function obtenerArchivoCfdi(cfdiId, tipo = "pdf") {
  return await facturamaFetch(`/cfdi/${tipo}/issued/${cfdiId}`);
}

/**
 * Cancela un CFDI.
 * @param {string} cfdiId
 * @param {string} motivo  01=Con errores con relación | 02=Con errores sin relación | 03=No se realizó la operación | 04=Operación nominativa en factura global
 * @param {string|null} folioSustitucion  UUID del CFDI que sustituye (solo para motivo 01)
 */
export async function cancelarCfdi(cfdiId, motivo = "02", folioSustitucion = null) {
  let path = `/2/cfdis/${cfdiId}?motive=${motivo}`;
  if (motivo === "01" && folioSustitucion) {
    path += `&folioSustitucion=${folioSustitucion}`;
  }
  return await facturamaFetch(path, "DELETE");
}
