/**
 * SendIt – Servicio de cotización de envíos.
 *
 * Calcula el costo de envío basándose en la zona de destino, peso/volumen
 * del paquete y el método de envío seleccionado (estándar, express, etc.).
 *
 * En producción se conectaría a un proveedor externo (Estafeta, FedEx, DHL…).
 * Actualmente usa tarifas internas para México.
 */

// ─── Zonas de envío México ────────────────────────────────────
const ZONAS = {
  local: {
    nombre: "Local",
    descripcion: "Misma ciudad / zona metropolitana",
    multiplicador: 1,
  },
  regional: {
    nombre: "Regional",
    descripcion: "Mismo estado o estados vecinos",
    multiplicador: 1.4,
  },
  nacional: {
    nombre: "Nacional",
    descripcion: "Cualquier parte de México",
    multiplicador: 2,
  },
};

// ─── Métodos de envío ─────────────────────────────────────────
const METODOS_ENVIO = {
  estandar: {
    id: "estandar",
    nombre: "Envío Estándar",
    descripcion: "Entrega en 5-7 días hábiles",
    diasMin: 5,
    diasMax: 7,
    costoBase: 89,
    costoPorKg: 12,
    icon: "📦",
  },
  express: {
    id: "express",
    nombre: "Envío Express",
    descripcion: "Entrega en 2-3 días hábiles",
    diasMin: 2,
    diasMax: 3,
    costoBase: 159,
    costoPorKg: 22,
    icon: "🚀",
  },
  express_plus: {
    id: "express_plus",
    nombre: "Express Plus",
    descripcion: "Entrega al siguiente día hábil",
    diasMin: 1,
    diasMax: 1,
    costoBase: 279,
    costoPorKg: 35,
    icon: "⚡",
  },
};

// ─── Origen fijo (almacén) ────────────────────────────────────
const ORIGEN = {
  estado: "Jalisco",
  ciudad: "Guadalajara",
  cp: "44100",
};

// estados vecinos para clasificar como "regional"
const ESTADOS_VECINOS = {
  Jalisco: [
    "Aguascalientes",
    "Colima",
    "Guanajuato",
    "Michoacán",
    "Nayarit",
    "Zacatecas",
  ],
};

/**
 * Determina la zona de envío entre origen y destino
 */
function determinarZona(destinoEstado, destinoCiudad) {
  if (
    destinoEstado.toLowerCase() === ORIGEN.estado.toLowerCase() &&
    destinoCiudad.toLowerCase().includes(ORIGEN.ciudad.toLowerCase())
  ) {
    return "local";
  }

  const vecinos = ESTADOS_VECINOS[ORIGEN.estado] || [];
  if (
    destinoEstado.toLowerCase() === ORIGEN.estado.toLowerCase() ||
    vecinos.some((v) => v.toLowerCase() === destinoEstado.toLowerCase())
  ) {
    return "regional";
  }

  return "nacional";
}

/**
 * Estima el peso total de los items del carrito.
 * Usa 0.5 kg por item como peso promedio si no se tiene dato real.
 */
function estimarPesoKg(items) {
  const pesoPromedioPorUnidad = 0.5;
  return items.reduce(
    (total, item) => total + (item.cantidad || 1) * pesoPromedioPorUnidad,
    0
  );
}

/**
 * Calcula si aplica envío gratis según subtotal
 */
function aplicaEnvioGratis(subtotal) {
  return subtotal >= 2500;
}

/**
 * Cotiza todos los métodos de envío disponibles.
 *
 * @param {{ estado: string, ciudad: string, cp: string }} destino
 * @param {{ cantidad: number, precioUnitario: number, subtotal: number }[]} items
 * @returns {{ opciones: object[], zona: object, envioGratis: boolean, subtotal: number }}
 */
export function cotizarEnvio(destino, items) {
  const zona = determinarZona(destino.estado, destino.ciudad);
  const zonaInfo = ZONAS[zona];
  const pesoKg = estimarPesoKg(items);
  const subtotal = items.reduce((sum, i) => sum + (i.subtotal || 0), 0);
  const envioGratis = aplicaEnvioGratis(subtotal);

  const hoy = new Date();

  const opciones = Object.values(METODOS_ENVIO).map((metodo) => {
    const costoCalculado =
      (metodo.costoBase + metodo.costoPorKg * pesoKg) * zonaInfo.multiplicador;
    const costo = Number(costoCalculado.toFixed(2));
    const costoFinal = envioGratis && metodo.id === "estandar" ? 0 : costo;

    const fechaMin = new Date(hoy);
    fechaMin.setDate(fechaMin.getDate() + metodo.diasMin);
    // saltar fines de semana
    while (fechaMin.getDay() === 0 || fechaMin.getDay() === 6) {
      fechaMin.setDate(fechaMin.getDate() + 1);
    }

    const fechaMax = new Date(hoy);
    fechaMax.setDate(fechaMax.getDate() + metodo.diasMax);
    while (fechaMax.getDay() === 0 || fechaMax.getDay() === 6) {
      fechaMax.setDate(fechaMax.getDate() + 1);
    }

    return {
      id: metodo.id,
      nombre: metodo.nombre,
      descripcion: metodo.descripcion,
      icon: metodo.icon,
      costo,
      costoFinal,
      gratis: costoFinal === 0,
      diasMin: metodo.diasMin,
      diasMax: metodo.diasMax,
      fechaEstimadaMin: fechaMin.toISOString().split("T")[0],
      fechaEstimadaMax: fechaMax.toISOString().split("T")[0],
    };
  });

  return {
    opciones,
    zona: {
      id: zona,
      nombre: zonaInfo.nombre,
      descripcion: zonaInfo.descripcion,
    },
    envioGratis,
    subtotal: Number(subtotal.toFixed(2)),
    pesoEstimadoKg: Number(pesoKg.toFixed(2)),
  };
}

/**
 * Valida que un método de envío seleccionado sea válido.
 */
export function validarMetodoEnvio(metodoId) {
  return metodoId in METODOS_ENVIO;
}

/**
 * Obtiene los datos de un método de envío por ID.
 */
export function obtenerMetodoEnvio(metodoId) {
  return METODOS_ENVIO[metodoId] || null;
}
