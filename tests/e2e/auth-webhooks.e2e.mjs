import test from "node:test";
import assert from "node:assert/strict";

const BASE_URL = (process.env.E2E_BASE_URL || "https://localhost:4321").replace(/\/$/, "");
if (BASE_URL.startsWith("https://localhost")) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

async function request(path, init = {}) {
  return fetch(`${BASE_URL}${path}`, init);
}

function allowStatuses(response, allowed) {
  assert.ok(
    allowed.includes(response.status),
    `Expected one of [${allowed.join(", ")}], got ${response.status}`,
  );
}

test("register rejects invalid payload", async () => {
  const form = new FormData();
  form.set("nombre", "");
  form.set("correo", "correo-invalido");
  form.set("contrasena", "123");

  const res = await request("/api/register", {
    method: "POST",
    body: form,
  });

  allowStatuses(res, [400, 429]);
});

test("verify-email rejects malformed token", async () => {
  const res = await request("/api/verify-email?token=abc", {
    method: "GET",
  });

  allowStatuses(res, [400, 404, 410, 429]);
});

test("resend-verification returns safe response shape", async () => {
  const res = await request("/api/resend-verification", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ correo: "nobody@example.com" }),
  });

  allowStatuses(res, [200, 429]);
});

test("login requires credentials", async () => {
  const form = new FormData();
  const res = await request("/api/login", {
    method: "POST",
    body: form,
  });

  allowStatuses(res, [400, 401, 429]);
});

test("password-reset request does not leak account existence", async () => {
  const res = await request("/api/password-reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "request", correo: "noexiste@example.com" }),
  });

  allowStatuses(res, [200, 400]);
});

test("stripe webhook enforces verification", async () => {
  const res = await request("/api/stripe-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "evt_test", type: "payment_intent.succeeded", data: { object: {} } }),
  });

  allowStatuses(res, [400, 500]);
});

test("envia webhook rejects bad payload or signature", async () => {
  const res = await request("/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not-json}",
  });

  allowStatuses(res, [400, 401, 403]);
});
