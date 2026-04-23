import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import Stripe from "stripe";
import { createDb, hasDbConfig, insertRow, randTag, scalar, tableExists, nowIso } from "./helpers/db-fixtures.mjs";

const BASE_URL = (process.env.E2E_BASE_URL || "https://localhost:4321").replace(/\/$/, "");
if (BASE_URL.startsWith("https://localhost")) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

async function request(path, init = {}) {
  return fetch(`${BASE_URL}${path}`, init);
}

function stripeSignature(payload, secret) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_placeholder");
  return stripe.webhooks.generateTestHeaderString({
    payload,
    secret,
    timestamp: Math.floor(Date.now() / 1000),
  });
}

function enviaSignature(payload, secret, timestamp) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
}

test("stripe webhook side-effects: pago/pedido and stock restore", async (t) => {
  if (!hasDbConfig()) {
    t.skip("Missing ECOMERS_DATABASE_URL / ECOMERS_AUTH_TOKEN");
    return;
  }
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    t.skip("Missing STRIPE_WEBHOOK_SECRET");
    return;
  }

  const db = createDb();
  const required = ["Usuario", "Direccion", "Pedido", "Pago", "Producto", "DetallePedido", "ProductoVariante"];
  for (const table of required) {
    if (!(await tableExists(db, table))) {
      t.skip(`Missing table ${table}`);
      return;
    }
  }

  const tag = randTag("stripe");
  const userId = await insertRow(db, "Usuario", {
    Nombre: `E2E ${tag}`,
    Apellido_Paterno: "Tester",
    Correo: `${tag}@example.com`,
    Contrasena: "hash:salt:100000",
    Rol: "usuario",
    Fecha_Creacion: nowIso(),
  });

  const direccionId = await insertRow(db, "Direccion", {
    Id_Usuario: userId,
    Nombre_Direccion: "E2E",
    Numero_casa: 1,
    Calle: "Test St",
    Codigo_Postal: 64000,
    Ciudad: "Monterrey",
    Provincia: "NL",
    Pais: "MX",
  });

  const productId = await insertRow(db, "Producto", {
    Nombre: `Producto ${tag}`,
    Descripcion: "e2e",
    Precio: 100,
    StockDisponible: 8,
    Fecha_Creacion: nowIso(),
    Activo: 1,
  });

  const orderNumber = Number(Date.now().toString().slice(-8));
  const pedidoId = await insertRow(db, "Pedido", {
    Id_Usuario: userId,
    Id_Direccion: direccionId,
    Numero_Pedido: orderNumber,
    Fecha_pedido: nowIso(),
    Estado: "pendiente",
    Costo_Envio: 0,
    Total: 200,
  });

  await insertRow(db, "DetallePedido", {
    Id_Pedido: pedidoId,
    Id_Producto: productId,
    Id_Variante: null,
    Cantidad: 2,
    Precio_Unitario: 100,
  });

  const paymentIntentId = `pi_${tag}`;
  await insertRow(db, "Pago", {
    Id_Pedido: pedidoId,
    Metodo_Pago: "tarjeta",
    Estado_Pago: "pendiente",
    Monto: 200,
    Codigo_Transaccion: paymentIntentId,
    Fecha_Pago: nowIso(),
  });

  const stockBeforeRefund = Number(await scalar(db, "SELECT StockDisponible AS v FROM Producto WHERE Id_Producto = ?", [productId]) || 0);

  const succeededPayload = JSON.stringify({
    id: `evt_${tag}_ok`,
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: paymentIntentId,
        amount: 20000,
        amount_received: 20000,
        currency: "mxn",
        metadata: { orderNumber: String(orderNumber) },
      },
    },
  });

  const succeededRes = await request("/api/stripe-webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": stripeSignature(succeededPayload, webhookSecret),
    },
    body: succeededPayload,
  });
  assert.equal(succeededRes.status, 200);

  const estadoPagoOk = String(await scalar(db, "SELECT Estado_Pago AS v FROM Pago WHERE Id_Pedido = ? ORDER BY Id_Pago DESC LIMIT 1", [pedidoId]) || "").toLowerCase();
  const estadoPedidoOk = String(await scalar(db, "SELECT Estado AS v FROM Pedido WHERE Id_Pedido = ?", [pedidoId]) || "").toLowerCase();
  assert.ok(["aprobado", "pagado", "completado", "succeeded"].includes(estadoPagoOk));
  assert.equal(estadoPedidoOk, "pagado");

  const refundedPayload = JSON.stringify({
    id: `evt_${tag}_refund`,
    type: "charge.refunded",
    data: {
      object: {
        payment_intent: paymentIntentId,
        amount: 20000,
        amount_refunded: 20000,
        refunds: { data: [{ id: `re_${tag}` }] },
      },
    },
  });

  const refundedRes = await request("/api/stripe-webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": stripeSignature(refundedPayload, webhookSecret),
    },
    body: refundedPayload,
  });
  assert.equal(refundedRes.status, 200);

  const estadoPagoRefund = String(await scalar(db, "SELECT Estado_Pago AS v FROM Pago WHERE Id_Pedido = ? ORDER BY Id_Pago DESC LIMIT 1", [pedidoId]) || "").toLowerCase();
  const estadoPedidoRefund = String(await scalar(db, "SELECT Estado AS v FROM Pedido WHERE Id_Pedido = ?", [pedidoId]) || "").toLowerCase();
  const stockAfterRefund = Number(await scalar(db, "SELECT StockDisponible AS v FROM Producto WHERE Id_Producto = ?", [productId]) || 0);

  assert.equal(estadoPagoRefund, "reembolsado");
  assert.equal(estadoPedidoRefund, "devolucion_completada");
  assert.equal(stockAfterRefund, stockBeforeRefund + 2);
});

test("envia webhook side-effects: delivered updates envio and pedido", async (t) => {
  if (!hasDbConfig()) {
    t.skip("Missing ECOMERS_DATABASE_URL / ECOMERS_AUTH_TOKEN");
    return;
  }
  const enviaSecret = process.env.ENVIA_WEBHOOK_SECRET;
  if (!enviaSecret) {
    t.skip("Missing ENVIA_WEBHOOK_SECRET");
    return;
  }

  const db = createDb();
  const required = ["Usuario", "Direccion", "Pedido", "Envio"];
  for (const table of required) {
    if (!(await tableExists(db, table))) {
      t.skip(`Missing table ${table}`);
      return;
    }
  }

  const tag = randTag("envia");
  const userId = await insertRow(db, "Usuario", {
    Nombre: `E2E ${tag}`,
    Apellido_Paterno: "Tester",
    Correo: `${tag}@example.com`,
    Contrasena: "hash:salt:100000",
    Rol: "usuario",
    Fecha_Creacion: nowIso(),
  });

  const direccionId = await insertRow(db, "Direccion", {
    Id_Usuario: userId,
    Nombre_Direccion: "E2E",
    Numero_casa: 10,
    Calle: "Webhook St",
    Codigo_Postal: 64000,
    Ciudad: "Monterrey",
    Provincia: "NL",
    Pais: "MX",
  });

  const pedidoId = await insertRow(db, "Pedido", {
    Id_Usuario: userId,
    Id_Direccion: direccionId,
    Numero_Pedido: Number(Date.now().toString().slice(-8)),
    Fecha_pedido: nowIso(),
    Estado: "en_transito",
    Costo_Envio: 0,
    Total: 100,
  });

  const guide = `GUIA_${tag}`;
  await insertRow(db, "Envio", {
    Id_pedido: pedidoId,
    Numero_Guia: guide,
    Estado_envio: "en_transito",
    Fecha_Envio: nowIso(),
    Carrier: "envia",
    Service: "express",
  });

  const payload = JSON.stringify({
    event: "status_updated",
    data: {
      trackingNumber: guide,
      status: "delivered",
    },
  });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = enviaSignature(payload, enviaSecret, timestamp);
  const res = await request("/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-envia-timestamp": timestamp,
      "x-envia-signature": `sha256=${signature}`,
    },
    body: payload,
  });

  assert.equal(res.status, 200);

  const estadoEnvio = String(await scalar(db, "SELECT Estado_envio AS v FROM Envio WHERE Numero_Guia = ?", [guide]) || "").toLowerCase();
  const estadoPedido = String(await scalar(db, "SELECT Estado AS v FROM Pedido WHERE Id_Pedido = ?", [pedidoId]) || "").toLowerCase();
  assert.equal(estadoEnvio, "entregado");
  assert.equal(estadoPedido, "entregado");
});
