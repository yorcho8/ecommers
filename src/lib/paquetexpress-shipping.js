/**
 * Paquetexpress API – Cotización y generación de guías.
 *
 * Paquetexpress es ideal para carga pesada / industrial en México.
 * Sus tarifas son significativamente más baratas que FedEx/DHL para
 * envíos de +5 kg.
 *
 * API Docs: https://developers.paquetexpress.com.mx
 * Cotización:  POST /api/v1/services/quotation
 * Guía:        POST /api/v1/services/shipments
 *
 * Variables de entorno requeridas:
 *   PAQUETEXPRESS_USER     – usuario API
 *   PAQUETEXPRESS_PASSWORD – contraseña API
 *   PAQUETEXPRESS_CLIENT_ID – número de cliente
 *   PAQUETEXPRESS_ENV      – "sandbox" | "production" (default: sandbox)
 */

import "dotenv/config";

const PE_ENV =
  process.env.PAQUETEXPRESS_ENV ||
  import.meta.env?.PAQUETEXPRESS_ENV ||
  "sandbox";

const BASE_URL =
  PE_ENV === "production"
    ? "https://cc.paquetexpress.com.mx/WsQuotation"
    : "https://cc-test.paquetexpress.com.mx/WsQuotation";

const PE_USER =
  process.env.PAQUETEXPRESS_USER ||
  import.meta.env?.PAQUETEXPRESS_USER ||
  "";

const PE_PASS =
  process.env.PAQUETEXPRESS_PASSWORD ||
  import.meta.env?.PAQUETEXPRESS_PASSWORD ||
  "";

const PE_CLIENT =
  process.env.PAQUETEXPRESS_CLIENT_ID ||
  import.meta.env?.PAQUETEXPRESS_CLIENT_ID ||
  "";

const PE_DEFAULT_FACTOR = Number(
  process.env.PAQUETEXPRESS_VOLUMETRIC_FACTOR ||
    import.meta.env?.PAQUETEXPRESS_VOLUMETRIC_FACTOR ||
    5000
);

const PE_DEFAULT_PACKAGE = {
  length: 50,
  width: 40,
  height: 30,
  weight: 0.5,
};

// ── Dirección de origen fija (almacén) ──────────────────────────
const ORIGIN_CP = "58148"; // Morelia, Michoacán

/**
 * Estima el peso total del envío.
 */
function estimateWeight(items) {
  return items.reduce((sum, i) => {
    const unitWeight = i.peso && Number(i.peso) > 0 ? Number(i.peso) : 0.5;
    return sum + (i.cantidad || 1) * unitWeight;
  }, 0);
}

function toPositiveNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function unitToCmFactor(unit) {
  const u = String(unit || "cm").trim().toLowerCase();
  if (u === "mm") return 0.1;
  if (u === "cm") return 1;
  if (u === "m") return 100;
  if (u === "in") return 2.54;
  if (u === "ft") return 30.48;
  return 1;
}

function parseDimensionFromSpecBlock(block) {
  if (!block) return 0;
  if (typeof block === "number") return toPositiveNumber(block, 0);
  if (typeof block !== "object") return 0;
  const max = toPositiveNumber(block.max, 0);
  const min = toPositiveNumber(block.min, 0);
  const value = toPositiveNumber(block.value, 0);
  return Math.max(max, min, value, 0);
}

function resolveUnitDimensionsCm(item) {
  const directLength = toPositiveNumber(item?.largo, 0);
  const directWidth = toPositiveNumber(item?.ancho, 0);
  const directHeight = toPositiveNumber(item?.alto, 0);
  if (directLength && directWidth && directHeight) {
    return { length: directLength, width: directWidth, height: directHeight };
  }

  let specs = item?.especificaciones;
  if (!specs) return null;
  try {
    if (typeof specs === "string") specs = JSON.parse(specs);
  } catch {
    return null;
  }
  if (!specs || typeof specs !== "object") return null;

  const unitFactor = unitToCmFactor(
    specs?.largo?.unidad || specs?.ancho?.unidad || specs?.alto?.unidad || "cm"
  );

  const length = parseDimensionFromSpecBlock(specs.largo) * unitFactor;
  const width = parseDimensionFromSpecBlock(specs.ancho) * unitFactor;
  const height = parseDimensionFromSpecBlock(specs.alto) * unitFactor;

  if (!length || !width || !height) return null;
  return { length, width, height };
}

function estimatePackageMetrics(items, volumetricFactor) {
  const safeItems = Array.isArray(items) ? items : [];

  let realWeight = 0;
  let totalVolumeCm3 = 0;
  let maxLength = 0;
  let maxWidth = 0;
  let maxHeight = 0;
  let hasDims = false;

  for (const item of safeItems) {
    const qty = Math.max(1, Number(item?.cantidad || 1));
    const unitWeight = toPositiveNumber(item?.peso, PE_DEFAULT_PACKAGE.weight);
    realWeight += qty * unitWeight;

    const dims = resolveUnitDimensionsCm(item);
    if (!dims) continue;

    hasDims = true;
    const unitVol = dims.length * dims.width * dims.height;
    totalVolumeCm3 += qty * unitVol;
    maxLength = Math.max(maxLength, dims.length);
    maxWidth = Math.max(maxWidth, dims.width);
    maxHeight = Math.max(maxHeight, dims.height);
  }

  let length = PE_DEFAULT_PACKAGE.length;
  let width = PE_DEFAULT_PACKAGE.width;
  let height = PE_DEFAULT_PACKAGE.height;

  if (hasDims && maxLength > 0 && maxWidth > 0 && totalVolumeCm3 > 0) {
    length = maxLength;
    width = maxWidth;
    const stackedHeight = totalVolumeCm3 / (length * width);
    height = Math.max(maxHeight, stackedHeight, 1);
  }

  const safeFactor = toPositiveNumber(volumetricFactor, 5000);
  const volumetric = (length * width * height) / safeFactor;
  const chargeable = Math.max(realWeight, volumetric, PE_DEFAULT_PACKAGE.weight);

  return {
    realWeight: Number(realWeight.toFixed(2)),
    volumetricWeight: Number(volumetric.toFixed(2)),
    chargeableWeight: Number(chargeable.toFixed(2)),
    factor: safeFactor,
    dimensions: {
      length: Number(length.toFixed(2)),
      width: Number(width.toFixed(2)),
      height: Number(height.toFixed(2)),
    },
  };
}

/**
 * Calcula el peso volumétrico (L × W × H / 5000).
 * Paquetexpress usa el mayor entre peso real y volumétrico.
 */
function volumetricWeight(length, width, height) {
  return (length * width * height) / 5000;
}

/**
 * Genera el token de autenticación Basic.
 */
function getAuthHeader() {
  const credentials = Buffer.from(`${PE_USER}:${PE_PASS}`).toString("base64");
  return `Basic ${credentials}`;
}

/**
 * Cotiza envío con Paquetexpress.
 *
 * @param {{ cp: string }} destino – mínimo el código postal destino
 * @param {{ cantidad: number, precioUnitario: number, subtotal: number, peso?: number }[]} items
 * @returns {Promise<{ success: boolean, opciones: object[], error?: string }>}
 */
export async function cotizarPaquetexpress(destino, items) {
  if (!PE_USER || !PE_PASS || !PE_CLIENT) {
    return {
      success: false,
      opciones: [],
      error: "PAQUETEXPRESS credenciales no configuradas.",
    };
  }

  const metrics = estimatePackageMetrics(items, PE_DEFAULT_FACTOR);
  const totalValue = items.reduce((s, i) => s + (i.subtotal || 0), 0);

  const requestBody = {
    header: {
      user: PE_USER,
      password: PE_PASS,
      clientId: PE_CLIENT,
    },
    shipment: {
      originZipCode: ORIGIN_CP,
      destinationZipCode: String(destino.cp || "00000"),
      weight: metrics.chargeableWeight,
      length: metrics.dimensions.length,
      width: metrics.dimensions.width,
      height: metrics.dimensions.height,
      declaredValue: Math.round(totalValue),
      quantity: 1,
    },
  };

  console.log(
    `[paquetexpress] cotizando: origen=${ORIGIN_CP} destino=${destino.cp} pesoReal=${metrics.realWeight}kg vol=${metrics.volumetricWeight}kg cobrable=${metrics.chargeableWeight}kg`
  );

  try {
    const res = await fetch(`${BASE_URL}/api/v1/services/quotation`, {
      method: "POST",
      headers: {
        Authorization: getAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const text = await res.text();
    console.log(
      `[paquetexpress] status=${res.status} body=${text.slice(0, 500)}`
    );

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return {
        success: false,
        opciones: [],
        error: `Paquetexpress respuesta inválida: ${text.slice(0, 200)}`,
      };
    }

    if (!res.ok) {
      return {
        success: false,
        opciones: [],
        error:
          data?.message || data?.error || `HTTP ${res.status}`,
      };
    }

    // La respuesta tiene un array de servicios disponibles
    const services = data?.services || data?.data || [];
    if (!Array.isArray(services) || services.length === 0) {
      // Paquetexpress puede devolver un solo objeto en vez de array
      const single = data?.totalAmount || data?.total;
      if (single) {
        return {
          success: true,
          opciones: [
            {
              id: "paquetexpress_terrestre",
              carrier: "paquetexpress",
              carrierLabel: "Paquetexpress",
              carrierIcon: "🚛",
              carrierColor: "#0054A6",
              service: "terrestre",
              serviceDescription: "Envío terrestre económico",
              deliveryEstimate: data?.deliveryDays
                ? `${data.deliveryDays} días hábiles`
                : "3-7 días hábiles",
              deliveryDate: null,
              deliveryDays: data?.deliveryDays || null,
              totalPrice: Number(parseFloat(single).toFixed(2)),
              currency: "MXN",
              pesoRealKg: metrics.realWeight,
              pesoVolumetricoKg: metrics.volumetricWeight,
              pesoCobrableKg: metrics.chargeableWeight,
              factorVolumetrico: metrics.factor,
              dimensionesPaqueteCm: metrics.dimensions,
            },
          ],
        };
      }

      return {
        success: false,
        opciones: [],
        error: "Sin servicios disponibles para esa ruta",
      };
    }

    const opciones = services.map((svc) => {
      const serviceId = String(
        svc.serviceId || svc.service || svc.code || "terrestre"
      ).toLowerCase();
      const price = Number(
        parseFloat(svc.totalAmount || svc.total || svc.price || 0).toFixed(2)
      );
      const days = svc.deliveryDays || svc.estimatedDays || svc.days || null;
      return {
        id: `paquetexpress_${serviceId}`,
        carrier: "paquetexpress",
        carrierLabel: "Paquetexpress",
        carrierIcon: "🚛",
        carrierColor: "#0054A6",
        service: serviceId,
        serviceDescription:
          svc.serviceDescription || svc.description || svc.name || serviceId,
        deliveryEstimate: days ? `${days} días hábiles` : "3-7 días hábiles",
        deliveryDate: svc.deliveryDate || null,
        deliveryDays: days,
        totalPrice: price,
        currency: "MXN",
        pesoRealKg: metrics.realWeight,
        pesoVolumetricoKg: metrics.volumetricWeight,
        pesoCobrableKg: metrics.chargeableWeight,
        factorVolumetrico: metrics.factor,
        dimensionesPaqueteCm: metrics.dimensions,
      };
    });

    opciones.sort((a, b) => a.totalPrice - b.totalPrice);

    console.log(`[paquetexpress] ${opciones.length} opciones encontradas`);
    return { success: true, opciones };
  } catch (err) {
    console.error("[paquetexpress] error:", err);
    return {
      success: false,
      opciones: [],
      error: String(err.message || err),
    };
  }
}

/**
 * Genera guía de envío con Paquetexpress.
 *
 * @param {{ calle, ciudad, estado, cp, nombre, telefono }} destino
 * @param {object[]} items
 * @param {string} service – tipo de servicio (e.g. "terrestre")
 * @returns {Promise<{ success: boolean, data?: object, error?: string }>}
 */
export async function generarGuiaPaquetexpress(destino, items, service) {
  if (!PE_USER || !PE_PASS || !PE_CLIENT) {
    return { success: false, error: "PAQUETEXPRESS credenciales no configuradas." };
  }

  const metrics = estimatePackageMetrics(items, PE_DEFAULT_FACTOR);
  const totalValue = items.reduce((s, i) => s + (i.subtotal || 0), 0);

  const requestBody = {
    header: {
      user: PE_USER,
      password: PE_PASS,
      clientId: PE_CLIENT,
    },
    shipment: {
      originZipCode: ORIGIN_CP,
      destinationZipCode: String(destino.cp || "00000"),
      weight: metrics.chargeableWeight,
      length: metrics.dimensions.length,
      width: metrics.dimensions.width,
      height: metrics.dimensions.height,
      declaredValue: Math.round(totalValue),
      quantity: 1,
      service: service || "terrestre",
    },
    origin: {
      name: "Almacén GO",
      company: "GO Ecomers",
      phone: "+52 3312345678",
      street: "Av. Francisco I. Madero Pte. #3349",
      city: "Morelia",
      state: "MI",
      zipCode: ORIGIN_CP,
    },
    destination: {
      name: destino.nombre || "Cliente",
      phone: destino.telefono || "+52 0000000000",
      street: destino.calle || "Sin calle",
      city: destino.ciudad || "",
      state: destino.estado || "",
      zipCode: String(destino.cp || "00000"),
    },
  };

  console.log(
    `[paquetexpress] generando guía: destino CP=${destino.cp} servicio=${service}`
  );

  try {
    const res = await fetch(`${BASE_URL}/api/v1/services/shipments`, {
      method: "POST",
      headers: {
        Authorization: getAuthHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const json = await res.json();
    console.log(
      `[paquetexpress] guía status=${res.status}`,
      JSON.stringify(json).slice(0, 300)
    );

    if (!res.ok) {
      return {
        success: false,
        error: json?.message || json?.error || `HTTP ${res.status}`,
      };
    }

    const trackingNumber =
      json?.trackingNumber ||
      json?.data?.trackingNumber ||
      json?.guideNumber ||
      "PENDIENTE";
    const labelUrl =
      json?.labelUrl || json?.data?.label || json?.pdfUrl || null;

    return {
      success: true,
      data: {
        trackingNumber,
        labelUrl,
        trackUrl: json?.trackUrl || null,
        price: json?.totalAmount || json?.total || null,
        carrier: "paquetexpress",
        service: service || "terrestre",
      },
    };
  } catch (err) {
    console.error("[paquetexpress] error generando guía:", err);
    return { success: false, error: String(err.message || err) };
  }
}
