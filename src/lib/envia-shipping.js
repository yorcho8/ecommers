/**
 * Envia.com Shipping API – Servicio de cotización multi-carrier.
 *
 * Conecta con la API de Envia.com para obtener tarifas reales de
 * FedEx, DHL, Estafeta y otros carriers en México y Latinoamérica.
 *
 * Docs: https://docs.envia.com/docs/ecommerce-checkout
 * Rate endpoint: POST /ship/rate/ (un carrier por request)
 *
 * Variables de entorno requeridas:
 *   ENVIA_API_TOKEN   – Bearer token (sandbox o producción)
 *   ENVIA_ENV         – "sandbox" | "production"  (default: sandbox)
 */

import "dotenv/config";

const ENVIA_ENV = process.env.ENVIA_ENV || import.meta.env?.ENVIA_ENV || "sandbox";

const BASE_URL =
  ENVIA_ENV === "production"
    ? "https://api.envia.com"
    : "https://api-test.envia.com";

const TOKEN =
  process.env.ENVIA_API_TOKEN || import.meta.env?.ENVIA_API_TOKEN || "";

const DEFAULT_PACKAGE = {
  length: 30,
  width: 25,
  height: 15,
  weight: 0.5,
};

const ALLOWED_ENVIASHIP_PRINT_SIZES = new Set([
  "PAPER_4.75X7",
  "PAPER_4X6",
  "PAPER_4X8",
  "PAPER_7X4.75",
  "PAPER_8.5X11",
  "PAPER_8.5X11_BOTTOM_HALF_LABEL",
  "PAPER_85X11_TOP_HALF_LABEL",
  "PAPER_LETTER",
  "STOCK_2.4X6",
  "STOCK_2.9X5",
  "STOCK_2.9X7",
  "STOCK_3.8X4.2",
  "STOCK_3.9X2.3",
  "STOCK_3.9X3.9",
  "STOCK_3.9X7",
  "STOCK_4X4",
  "STOCK_4X6",
  "STOCK_4X6.5",
  "STOCK_4X7.5",
  "STOCK_4X8",
  "STOCK_4X9",
  "PAPER_8.27X11.67",
  "STOCK_4X3",
  "STOCK_3.9X4.3",
]);

function normalizeEnviaPrintSize(rawValue) {
  const candidate = String(rawValue || "").trim().toUpperCase();
  if (!candidate) return "PAPER_LETTER";

  const aliases = {
    LETTER: "PAPER_LETTER",
    PAPERLETTER: "PAPER_LETTER",
    A4: "PAPER_8.27X11.67",
  };

  const normalized = aliases[candidate] || candidate;
  return ALLOWED_ENVIASHIP_PRINT_SIZES.has(normalized)
    ? normalized
    : "PAPER_LETTER";
}

const DEFAULT_ENVIASHIP_SETTINGS = {
  currency: "MXN",
  printFormat: "PDF",
  printSize: normalizeEnviaPrintSize(
    process.env.ENVIA_PRINT_SIZE || import.meta.env?.ENVIA_PRINT_SIZE || "PAPER_LETTER"
  ),
};

const DEFAULT_VOLUMETRIC_FACTOR = Number(
  process.env.ENVIA_VOLUMETRIC_FACTOR || import.meta.env?.ENVIA_VOLUMETRIC_FACTOR || 5000
);

function toPositiveNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveVolumetricFactor(carrier) {
  const key = String(carrier || "").trim().toUpperCase();
  if (!key) return toPositiveNumber(DEFAULT_VOLUMETRIC_FACTOR, 5000);

  const envName = `ENVIA_VOLUMETRIC_FACTOR_${key}`;
  const fromEnv = process.env[envName] || import.meta.env?.[envName];
  return toPositiveNumber(fromEnv, toPositiveNumber(DEFAULT_VOLUMETRIC_FACTOR, 5000));
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

  const length = parseDimensionFromSpecBlock(specs.largo);
  const width = parseDimensionFromSpecBlock(specs.ancho);
  const height = parseDimensionFromSpecBlock(specs.alto);

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
    const unitWeight = toPositiveNumber(item?.peso, DEFAULT_PACKAGE.weight);
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

  let length = DEFAULT_PACKAGE.length;
  let width = DEFAULT_PACKAGE.width;
  let height = DEFAULT_PACKAGE.height;

  if (hasDims && maxLength > 0 && maxWidth > 0 && totalVolumeCm3 > 0) {
    length = maxLength;
    width = maxWidth;
    const stackedHeight = totalVolumeCm3 / (length * width);
    height = Math.max(maxHeight, stackedHeight, 1);
  }

  const safeFactor = toPositiveNumber(volumetricFactor, 5000);
  const volumetricWeight = (length * width * height) / safeFactor;
  const chargeableWeight = Math.max(realWeight, volumetricWeight, DEFAULT_PACKAGE.weight);

  return {
    realWeight: Number(realWeight.toFixed(2)),
    volumetricWeight: Number(volumetricWeight.toFixed(2)),
    chargeableWeight: Number(chargeableWeight.toFixed(2)),
    factor: safeFactor,
    dimensions: {
      length: Number(length.toFixed(2)),
      width: Number(width.toFixed(2)),
      height: Number(height.toFixed(2)),
    },
  };
}

// ── Dirección de origen fija (almacén) ──────────────────────────
const WAREHOUSE_ORIGIN = {
  name: "Almacén GO",
  company: "GO Ecomers",
  phone: "+52 3312345678",
  street: "Av. Francisco I. Madero Pte.",
  number: "3349",
  city: "Morelia",
  state: "MI",
  country: "MX",
  postalCode: "58148",
};

// ── Mapeo de estados México → códigos ISO ───────────────────────
const STATE_CODES = {
  aguascalientes: "AG", baja_california: "BC", "baja california": "BC",
  "baja california sur": "BS", campeche: "CM", chiapas: "CS",
  chihuahua: "CH", coahuila: "CO", colima: "CL",
  "ciudad de méxico": "CMX", "ciudad de mexico": "CMX", cdmx: "CMX",
  durango: "DG", "estado de méxico": "EM", "estado de mexico": "EM",
  guanajuato: "GT", guerrero: "GR", hidalgo: "HG",
  jalisco: "JA", michoacán: "MI", michoacan: "MI",
  morelos: "MO", nayarit: "NA", "nuevo león": "NL", "nuevo leon": "NL",
  oaxaca: "OA", puebla: "PU", querétaro: "QE", queretaro: "QE",
  "quintana roo": "QR", "san luis potosí": "SL", "san luis potosi": "SL",
  sinaloa: "SI", sonora: "SO", tabasco: "TB",
  tamaulipas: "TM", tlaxcala: "TL", veracruz: "VE",
  yucatán: "YU", yucatan: "YU", zacatecas: "ZA",
};

// ── Mapeo de estados US → códigos ISO 2 letras ─────────────────
const US_STATE_CODES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR",
  california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
  "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC", "puerto rico": "PR",
};

function resolveStateCode(stateInput, countryCode = "MX") {
  if (!stateInput) return countryCode === "MX" ? "JA" : "";
  const clean = stateInput.trim().toLowerCase();
  // Si ya es código de 2 letras, devolver directo
  if (clean.length === 2) return clean.toUpperCase();
  // Intentar resolver por mapas según país
  if (countryCode === "MX") {
    if (clean.length === 3) return clean.toUpperCase();
    return STATE_CODES[clean] || stateInput.trim().slice(0, 3).toUpperCase();
  }
  if (countryCode === "US") {
    return US_STATE_CODES[clean] || stateInput.trim().slice(0, 2).toUpperCase();
  }
  // Otros países: devolver primeras 2-3 letras
  return stateInput.trim().slice(0, 2).toUpperCase();
}

// ── Mapeo de países (nombre/código) → ISO 2 ─────────────────────
const COUNTRY_CODES = {
  mx: "MX", mexico: "MX", méxico: "MX",
  us: "US", usa: "US", "united states": "US", "estados unidos": "US",
  ca: "CA", canada: "CA", canadá: "CA",
  gt: "GT", guatemala: "GT",
  bz: "BZ", belize: "BZ", belice: "BZ",
  sv: "SV", "el salvador": "SV",
  hn: "HN", honduras: "HN",
  ni: "NI", nicaragua: "NI",
  cr: "CR", "costa rica: ": "CR",
  pa: "PA", panama: "PA", panamá: "PA",
  cu: "CU", cuba: "CU",
  do: "DO", "republica dominicana": "DO", "república dominicana": "DO",
  ht: "HT", haiti: "HT", haití: "HT",
  jm: "JM", jamaica: "JM",
  pr: "PR", "puerto rico": "PR",
  co: "CO", colombia: "CO",
  ve: "VE", venezuela: "VE",
  ec: "EC", ecuador: "EC",
  pe: "PE", peru: "PE", perú: "PE",
  bo: "BO", bolivia: "BO",
  cl: "CL", chile: "CL",
  ar: "AR", argentina: "AR",
  uy: "UY", uruguay: "UY",
  py: "PY", paraguay: "PY",
  br: "BR", brasil: "BR", brazil: "BR",
  gy: "GY", guyana: "GY",
  sr: "SR", surinam: "SR", suriname: "SR",
};

const CARRIERS_DOMESTIC     = ["fedex", "dhl", "estafeta", "redpack"];
const CARRIERS_INTERNATIONAL = ["fedex", "dhl", "ups"];

function resolveCountryCode(input) {
  if (!input) return "MX";
  const clean = String(input).trim().toLowerCase();
  // si ya es código ISO de 2 letras coincide en el mapa
  return COUNTRY_CODES[clean] || clean.toUpperCase().slice(0, 2);
}

function carriersForCountry(countryCode) {
  return countryCode === "MX" ? CARRIERS_DOMESTIC : CARRIERS_INTERNATIONAL;
}

/**
 * Arma el objeto packages para el request de Envia.
 */
function buildPackages(items, carrier) {
  const volumetricFactor = resolveVolumetricFactor(carrier);
  const metrics = estimatePackageMetrics(items, volumetricFactor);
  const totalValue = items.reduce((s, i) => s + (i.subtotal || 0), 0);

  return {
    packages: [
    {
      type: "box",
      content: "Productos e-commerce",
      amount: 1,
      declaredValue: Math.round(totalValue),
      lengthUnit: "CM",
      weightUnit: "KG",
      weight: metrics.chargeableWeight,
      dimensions: {
        length: metrics.dimensions.length,
        width: metrics.dimensions.width,
        height: metrics.dimensions.height,
      },
    },
    ],
    metrics,
  };
}

function buildEnviaShipSettings(overrides = {}) {
  return {
    ...DEFAULT_ENVIASHIP_SETTINGS,
    ...(overrides && typeof overrides === "object" ? overrides : {}),
  };
}

function splitStreetAndNumber(streetInput, numberInput) {
  const rawStreet = String(streetInput || "").trim();
  const explicitNumber = String(numberInput || "").trim();
  if (explicitNumber) {
    return {
      street: rawStreet || "Sin calle",
      number: explicitNumber,
    };
  }

  // Try to extract a trailing house number from a full street string.
  const match = rawStreet.match(/^(.*?)(?:\s+#?([\w-]+))?$/);
  const baseStreet = String(match?.[1] || rawStreet).trim();
  const extracted = String(match?.[2] || "").trim();

  return {
    street: baseStreet || "Sin calle",
    number: extracted || "S/N",
  };
}

function buildAddressPayload(inputAddress = {}, countryCode = "MX") {
  const parts = splitStreetAndNumber(inputAddress.calle, inputAddress.numero);
  return {
    name: inputAddress.nombre || "Cliente",
    phone: inputAddress.telefono || "+52 0000000000",
    street: parts.street,
    number: parts.number,
    city: inputAddress.ciudad || "",
    state: resolveStateCode(inputAddress.estado, countryCode),
    country: countryCode,
    postalCode: String(inputAddress.cp || "00000"),
  };
}

/**
 * Logos / iconos de carriers conocidos.
 */
const CARRIER_META = {
  fedex: { icon: "📦", color: "#4D148C", label: "FedEx" },
  dhl: { icon: "📮", color: "#FFCC00", label: "DHL" },
  estafeta: { icon: "🚚", color: "#00529B", label: "Estafeta" },
  ups: { icon: "📫", color: "#351C15", label: "UPS" },
  redpack: { icon: "📦", color: "#E31E26", label: "Redpack" },
  "99minutos": { icon: "⚡", color: "#00C4B3", label: "99 Minutos" },
  paquetexpress: { icon: "🚛", color: "#0054A6", label: "Paquetexpress" },
};

function getCarrierMeta(carrier) {
  const key = String(carrier || "").toLowerCase();
  return CARRIER_META[key] || { icon: "📦", color: "#666", label: carrier };
}

function toReadableApiError(value) {
  if (value == null) return "sin detalle";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    const mapped = value.map((v) => toReadableApiError(v)).filter(Boolean);
    return mapped.join("; ") || "sin detalle";
  }

  if (typeof value === "object") {
    const known =
      value.message ||
      value.error ||
      value.detail ||
      value.msg ||
      value.description ||
      value.title ||
      value.reason;

    if (known) return toReadableApiError(known);

    const entries = Object.entries(value)
      .map(([k, v]) => `${k}: ${toReadableApiError(v)}`)
      .filter(Boolean);

    return entries.join(" | ") || JSON.stringify(value);
  }

  return String(value);
}

/**
 * Cotiza tarifas de envío con la API de Envia.com.
 *
 * @param {{ calle: string, ciudad: string, estado: string, cp: string, pais?: string, nombre?: string }} destino
 * @param {{ cantidad: number, precioUnitario: number, subtotal: number, peso?: number, largo?: number, ancho?: number, alto?: number, especificaciones?: string|object|null }[]} items
 * @returns {Promise<{ success: boolean, opciones: object[], error?: string }>}
 */
export async function cotizarEnvioEnvia(destino, items) {
  if (!TOKEN) {
    return {
      success: false,
      opciones: [],
      error: "ENVIA_API_TOKEN no configurado. Agrega tu token de Envia.com.",
    };
  }

  const countryCode = resolveCountryCode(destino.pais || "MX");

  const destination = {
    name: destino.nombre || "Cliente",
    phone: destino.telefono || "+52 0000000000",
    street: destino.calle || "Sin calle",
    city: destino.ciudad || "",
    state: resolveStateCode(destino.estado, countryCode),
    country: countryCode,
    postalCode: String(destino.cp || "00000"),
  };

  const carriers = carriersForCountry(countryCode);

  console.log(`[envia] cotizando destino: CP=${destination.postalCode} ciudad=${destination.city} estado=${destination.state} país=${countryCode}`);
  console.log(`[envia] token (primeros 8): ${TOKEN.slice(0,8)}... env=${ENVIA_ENV} url=${BASE_URL}`);

  // Cotizar todos los carriers en paralelo
  const ratePromises = carriers.map((carrier) => {
    const packageInfo = buildPackages(items, carrier);
    const body = {
      origin: WAREHOUSE_ORIGIN,
      destination,
      packages: packageInfo.packages,
      shipment: { type: 1, carrier },
    };
    console.log(`[envia] POST /ship/rate/ carrier=${carrier}`, JSON.stringify(body));
    return fetch(`${BASE_URL}/ship/rate/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })
      .then(async (r) => {
        const text = await r.text();
        console.log(`[envia] carrier=${carrier} status=${r.status} body=${text.slice(0,500)}`);
        try { return { carrier, data: JSON.parse(text), status: r.status, metrics: packageInfo.metrics }; }
        catch { return { carrier, error: `status ${r.status}: ${text.slice(0,200)}` }; }
      })
      .catch((err) => ({ carrier, error: String(err.message || err) }));
  });

  const results = await Promise.allSettled(ratePromises);

  const opciones = [];
  const debugErrors = [];

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const { carrier, data, error, status, metrics } = result.value;
    if (error) {
      debugErrors.push({ carrier, error });
      console.warn(`[envia] ${carrier} error:`, error);
      continue;
    }
    if (!data?.data?.length) {
      const msg = data?.message || data?.error || data?.errors || JSON.stringify(data).slice(0,200);
      debugErrors.push({ carrier, error: msg, status });
      console.warn(`[envia] ${carrier} sin opciones. respuesta:`, msg);
      continue;
    }

    for (const rate of data.data) {
      const meta = getCarrierMeta(rate.carrier || carrier);
      opciones.push({
        id: `${(rate.carrier || carrier).toLowerCase()}_${(rate.service || "standard").toLowerCase()}`,
        carrier: (rate.carrier || carrier).toLowerCase(),
        carrierLabel: meta.label,
        carrierIcon: meta.icon,
        carrierColor: meta.color,
        service: rate.service || "standard",
        serviceDescription: rate.serviceDescription || rate.service || "",
        deliveryEstimate: rate.deliveryEstimate || "",
        deliveryDate: rate.deliveryDate?.date || null,
        deliveryDays: rate.deliveryDate?.dateDifference || null,
        totalPrice: Number(parseFloat(rate.totalPrice || 0).toFixed(2)),
        currency: rate.currency || "MXN",
        pesoRealKg: metrics?.realWeight ?? null,
        pesoVolumetricoKg: metrics?.volumetricWeight ?? null,
        pesoCobrableKg: metrics?.chargeableWeight ?? null,
        factorVolumetrico: metrics?.factor ?? null,
        dimensionesPaqueteCm: metrics?.dimensions || null,
      });
    }
  }

  // Ordenar por precio
  opciones.sort((a, b) => a.totalPrice - b.totalPrice);

  console.log(`[envia] resultado: ${opciones.length} opciones, ${debugErrors.length} errores`);
  if (debugErrors.length) console.log("[envia] errores por carrier:", JSON.stringify(debugErrors));

  return {
    success: true,
    opciones,
    _debug: debugErrors.length ? debugErrors : undefined,
  };
}

/**
 * Genera la etiqueta de envío después del pago.
 *
 * @param {{ calle, ciudad, estado, cp, nombre, telefono }} destino
 * @param {object[]} items
 * @param {string} carrier
 * @param {string} service
 * @returns {Promise<{ success: boolean, data?: object, error?: string }>}
 */
export async function generarEtiquetaEnvia(destino, items, carrier, service) {
  if (!TOKEN) {
    return { success: false, error: "ENVIA_API_TOKEN no configurado" };
  }

  const countryCode = resolveCountryCode(destino.pais || "MX");

  const destination = buildAddressPayload(destino, countryCode);

  const packageInfo = buildPackages(items, carrier);
  const packages = packageInfo.packages;
  const settings = buildEnviaShipSettings();

  try {
    const res = await fetch(`${BASE_URL}/ship/generate/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        origin: WAREHOUSE_ORIGIN,
        destination,
        packages,
        settings,
        shipment: { type: 1, carrier, service },
      }),
    });

    const json = await res.json();

    if (!res.ok || !json.data?.length) {
      return {
        success: false,
        error: json.error || json.message || "No se pudo generar la etiqueta",
      };
    }

    const shipment = json.data[0];
    return {
      success: true,
      data: {
        trackingNumber: shipment.trackingNumber,
        labelUrl: shipment.label,
        trackUrl: shipment.trackUrl,
        price: shipment.totalPrice,
        carrier,
        service,
      },
    };
  } catch (err) {
    return { success: false, error: String(err.message || err) };
  }
}

/**
 * Cancela una guia ya generada en Envia.com.
 * Solo aplica si el carrier aun no recoge/escanea el paquete.
 */
export async function cancelarEnvioEnvia(carrier, trackingNumber, folio = null) {
  if (!TOKEN) {
    return { success: false, error: "ENVIA_API_TOKEN no configurado" };
  }

  const safeCarrier = String(carrier || "").trim().toLowerCase();
  const safeTracking = String(trackingNumber || "").trim();
  if (!safeCarrier || !safeTracking) {
    return { success: false, error: "carrier y trackingNumber son obligatorios" };
  }

  const body = {
    carrier: safeCarrier,
    trackingNumber: safeTracking,
  };
  if (folio) body.folio = String(folio);

  try {
    const res = await fetch(`${BASE_URL}/ship/cancel/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      return {
        success: false,
        error: parsed?.error || parsed?.message || `No se pudo cancelar guia (HTTP ${res.status})`,
      };
    }

    return {
      success: true,
      data: parsed,
    };
  } catch (error) {
    return {
      success: false,
      error: String(error?.message || error),
    };
  }
}

/**
 * Genera guia de devolucion (cliente -> almacen) usando Estafeta en Envia.
 */
export async function generarEtiquetaDevolucionEnvia(origenCliente, items, service = "ground") {
  if (!TOKEN) {
    return { success: false, error: "ENVIA_API_TOKEN no configurado" };
  }

  const countryCode = resolveCountryCode(origenCliente?.pais || "MX");

  const origin = buildAddressPayload(origenCliente || {}, countryCode);

  const destination = { ...WAREHOUSE_ORIGIN };
  const packageInfo = buildPackages(items || [], "estafeta");
  const packages = packageInfo.packages;
  const settings = buildEnviaShipSettings({
    comments: "devolucion_cliente",
  });

  const serviceCandidates = Array.from(new Set([
    String(service || "").trim(),
    "ground",
    "express",
    "priority",
  ].filter(Boolean)));

  const errors = [];

  for (const svc of serviceCandidates) {
    try {
      const res = await fetch(`${BASE_URL}/ship/generate/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          origin,
          destination,
          packages,
          settings,
          shipment: { type: 1, carrier: "estafeta", service: svc },
        }),
      });

      const text = await res.text();
      let json = {};
      try {
        json = JSON.parse(text || "{}");
      } catch {
        json = {};
      }

      if (!res.ok || !json?.data?.length) {
        const detail =
          toReadableApiError(json?.error) ||
          toReadableApiError(json?.message) ||
          toReadableApiError(json?.errors) ||
          toReadableApiError(json) ||
          `HTTP ${res.status}`;
        errors.push(`${svc}: ${detail}`);
        continue;
      }

      const shipment = json.data[0];
      return {
        success: true,
        data: {
          trackingNumber: shipment.trackingNumber,
          labelUrl: shipment.label,
          trackUrl: shipment.trackUrl,
          price: shipment.totalPrice,
          carrier: "estafeta",
          service: svc,
        },
      };
    } catch (error) {
      errors.push(`${svc}: ${String(error?.message || error)}`);
    }
  }

  return {
    success: false,
    error: errors.length
      ? `No se pudo generar la guia de devolucion (${errors.join(" | ")})`
      : "No se pudo generar la guia de devolucion",
  };
}
