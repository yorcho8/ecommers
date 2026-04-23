import { createClient } from "@libsql/client";
import crypto from "crypto";
import "dotenv/config";
import { sendIncidentCreatedNotification } from "../../../../../lib/mail.js";
import { verifySessionToken, SESSION_COOKIE } from "../../../../../lib/session.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

const REPORT_WINDOW_DAYS = 15;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 5;
const ALLOWED_PRIORITY = new Set(["alta", "media", "baja"]);

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getSessionUser(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
  } catch {
    return null;
  }
}

function normalizeRole(value) {
  const compact = String(value || "").trim().toLowerCase().replace(/[\s_-]/g, "");
  if (compact === "superusuario" || compact === "superuser" || compact === "superadmin") return "superusuario";
  if (compact === "admin") return "admin";
  return String(value || "").trim().toLowerCase();
}

function asText(value, max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function normalizePriority(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (ALLOWED_PRIORITY.has(raw)) return raw;
  return "media";
}

function parseCloudinaryUrl(url) {
  try {
    const clean = String(url || "").trim();
    if (!clean.startsWith("cloudinary://")) return null;
    const withoutScheme = clean.replace("cloudinary://", "");
    const [creds, cloudName] = withoutScheme.split("@");
    if (!creds || !cloudName) return null;
    const [apiKey, apiSecret] = creds.split(":");
    if (!apiKey || !apiSecret) return null;
    return {
      cloudName: String(cloudName).trim(),
      apiKey: String(apiKey).trim(),
      apiSecret: String(apiSecret).trim(),
    };
  } catch {
    return null;
  }
}

function resolveCloudinaryConfig() {
  let cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || import.meta.env.CLOUDINARY_CLOUD_NAME || "").trim();
  let apiKey = String(process.env.CLOUDINARY_API_KEY || import.meta.env.CLOUDINARY_API_KEY || "").trim();
  let apiSecret = String(process.env.CLOUDINARY_API_SECRET || import.meta.env.CLOUDINARY_API_SECRET || "").trim();

  if (!cloudName || !apiKey || !apiSecret) {
    const parsed = parseCloudinaryUrl(String(process.env.CLOUDINARY_URL || import.meta.env.CLOUDINARY_URL || ""));
    if (parsed) {
      cloudName = cloudName || parsed.cloudName;
      apiKey = apiKey || parsed.apiKey;
      apiSecret = apiSecret || parsed.apiSecret;
    }
  }

  return { cloudName, apiKey, apiSecret };
}

function createCloudinarySignature(paramsToSign, apiSecret) {
  const signBase = Object.keys(paramsToSign)
    .sort()
    .map((key) => `${key}=${paramsToSign[key]}`)
    .join("&");

  return crypto.createHash("sha1").update(signBase + apiSecret).digest("hex");
}

async function uploadImageToCloudinary(file, folder, publicId, cloudConfig) {
  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = {
    access_mode: "public",
    folder,
    public_id: publicId,
    type: "upload",
    timestamp,
  };

  const signature = createCloudinarySignature(paramsToSign, cloudConfig.apiSecret);
  const form = new FormData();
  form.append("file", file);
  form.append("api_key", cloudConfig.apiKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);
  form.append("access_mode", "public");
  form.append("folder", folder);
  form.append("public_id", publicId);
  form.append("type", "upload");

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudConfig.cloudName}/image/upload`, {
    method: "POST",
    body: form,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.secure_url) {
    throw new Error(data?.error?.message || "Cloudinary rechazo la imagen");
  }

  return {
    url: String(data.secure_url),
    publicId: String(data.public_id || ""),
  };
}

async function ensureIncidenciaSchema() {
  return true;
}

async function getOrderForUser(orderId, userId) {
  const result = await db.execute({
    sql: `
      SELECT
        p.Id_Pedido,
        p.Numero_Pedido,
        p.Estado,
        p.Fecha_pedido,
        (
          SELECT e.Fecha_Entrega
          FROM Envio e
          WHERE e.Id_pedido = p.Id_Pedido
          ORDER BY e.Id_Envio DESC
          LIMIT 1
        ) AS Fecha_Entrega
      FROM Pedido p
      WHERE p.Id_Pedido = ? AND p.Id_Usuario = ?
      LIMIT 1
    `,
    args: [orderId, userId],
  });

  return result.rows[0] || null;
}

function buildEligibility(orderRow, isSuperUser = false) {
  if (!orderRow) {
    return { canReport: false, reason: "Pedido no encontrado." };
  }

  const estado = String(orderRow.Estado || "").toLowerCase();
  if (estado !== "entregado") {
    if (isSuperUser) {
      const nowIso = new Date().toISOString();
      return {
        canReport: true,
        isTestOverride: true,
        reason: "Modo pruebas activo: como superusuario puedes reportar pedidos no entregados.",
        referenceDate: nowIso,
        deadline: nowIso,
        remainingDays: REPORT_WINDOW_DAYS,
      };
    }
    return { canReport: false, reason: "Solo puedes reportar fallos en pedidos entregados." };
  }

  const refDateRaw = orderRow.Fecha_Entrega || orderRow.Fecha_pedido;
  const refDate = new Date(String(refDateRaw || ""));
  if (Number.isNaN(refDate.getTime())) {
    return { canReport: false, reason: "No se pudo validar la fecha de entrega del pedido." };
  }

  const deadline = new Date(refDate.getTime() + REPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const now = new Date();
  const remainingDays = Math.ceil((deadline.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

  if (now.getTime() > deadline.getTime()) {
    return {
      canReport: false,
      reason: `El plazo de ${REPORT_WINDOW_DAYS} dias para reportar fallos ya vencio.`,
      referenceDate: refDate.toISOString(),
      deadline: deadline.toISOString(),
      remainingDays: 0,
    };
  }

  return {
    canReport: true,
    reason: "Puedes reportar incidencias de este pedido.",
    referenceDate: refDate.toISOString(),
    deadline: deadline.toISOString(),
    remainingDays,
  };
}

async function listIncidencias(orderId, userId) {
  const result = await db.execute({
    sql: `
      SELECT
        i.Id_Incidencia,
        i.Motivo,
        i.Prioridad,
        i.Descripcion,
        i.Estado,
        i.Veredicto,
        i.Comentario_Veredicto,
        i.Fecha_Creacion,
        i.Fecha_Resolucion
      FROM PedidoIncidencia i
      WHERE i.Id_Pedido = ? AND i.Id_Usuario = ?
      ORDER BY i.Fecha_Creacion DESC
    `,
    args: [orderId, userId],
  });

  const ids = result.rows.map((r) => Number(r.Id_Incidencia)).filter((n) => Number.isFinite(n) && n > 0);
  const imagesById = {};
  const logsById = {};

  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    const imgs = await db.execute({
      sql: `SELECT Id_Incidencia, URL_Imagen FROM PedidoIncidenciaImagen WHERE Id_Incidencia IN (${placeholders}) ORDER BY Id_Imagen ASC`,
      args: ids,
    });

    for (const row of imgs.rows) {
      const id = Number(row.Id_Incidencia);
      if (!imagesById[id]) imagesById[id] = [];
      imagesById[id].push(String(row.URL_Imagen || ""));
    }
  }

  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    const logs = await db.execute({
      sql: `
        SELECT
          l.Id_Incidencia,
          l.Accion,
          l.Detalle,
          l.Fecha_Creacion,
          u.Nombre,
          u.Apellido_Paterno,
          u.Apellido_Materno,
          u.Rol
        FROM PedidoIncidenciaBitacora l
        LEFT JOIN Usuario u ON u.Id = l.Id_Actor
        WHERE l.Id_Incidencia IN (${placeholders})
        ORDER BY l.Fecha_Creacion DESC, l.Id_Log DESC
      `,
      args: ids,
    });

    for (const row of logs.rows) {
      const id = Number(row.Id_Incidencia);
      if (!logsById[id]) logsById[id] = [];
      logsById[id].push({
        accion: String(row.Accion || ""),
        detalle: row.Detalle ? String(row.Detalle) : null,
        fecha: String(row.Fecha_Creacion || ""),
        actorNombre: [row.Nombre, row.Apellido_Paterno, row.Apellido_Materno].filter(Boolean).join(" ").trim() || "Sistema",
        actorRol: row.Rol ? String(row.Rol) : null,
      });
    }
  }

  return result.rows.map((row) => {
    const id = Number(row.Id_Incidencia);
    return {
      id,
      folio: `INC-${new Date(String(row.Fecha_Creacion || Date.now())).getFullYear()}-${String(id).padStart(6, "0")}`,
      motivo: String(row.Motivo || ""),
      prioridad: normalizePriority(row.Prioridad),
      descripcion: String(row.Descripcion || ""),
      estado: String(row.Estado || "pendiente"),
      veredicto: row.Veredicto ? String(row.Veredicto) : null,
      comentarioVeredicto: row.Comentario_Veredicto ? String(row.Comentario_Veredicto) : null,
      fechaCreacion: String(row.Fecha_Creacion || ""),
      fechaResolucion: row.Fecha_Resolucion ? String(row.Fecha_Resolucion) : null,
      imagenes: imagesById[id] || [],
      bitacora: logsById[id] || [],
    };
  });
}

async function getUserById(userId) {
  const result = await db.execute({
    sql: `SELECT Id, Nombre, Apellido_Paterno, Apellido_Materno, Correo FROM Usuario WHERE Id = ? LIMIT 1`,
    args: [Number(userId)],
  });
  return result.rows[0] || null;
}

async function getSuperUserEmails() {
  const result = await db.execute({
    sql: `
      SELECT Correo
      FROM Usuario
      WHERE LOWER(TRIM(Rol)) IN ('superusuario', 'super_user', 'superuser', 'superadmin')
        AND Correo IS NOT NULL
        AND TRIM(Correo) <> ''
    `,
    args: [],
  });

  const unique = new Set();
  for (const row of result.rows) {
    const email = String(row.Correo || "").trim().toLowerCase();
    if (email) unique.add(email);
  }
  return Array.from(unique);
}

async function appendBitacora({ incidenciaId, action, detail = null, actorId = null, when = null }) {
  await db.execute({
    sql: `
      INSERT INTO PedidoIncidenciaBitacora
        (Id_Incidencia, Accion, Detalle, Id_Actor, Fecha_Creacion)
      VALUES (?, ?, ?, ?, ?)
    `,
    args: [Number(incidenciaId), String(action || ""), detail ? String(detail) : null, actorId ? Number(actorId) : null, String(when || new Date().toISOString())],
  });
}

export async function GET({ params, cookies }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) {
    return json({ success: false, error: "No autenticado" }, 401);
  }

  const orderId = Number(params?.id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return json({ success: false, error: "Pedido invalido" }, 400);
  }

  try {
    await ensureIncidenciaSchema();

    const userRole = normalizeRole(sessionUser?.rol);
    const isSuperUser = userRole === "superusuario";
    const orderRow = await getOrderForUser(orderId, Number(sessionUser.userId));
    const eligibility = buildEligibility(orderRow, isSuperUser);
    const incidencias = orderRow ? await listIncidencias(orderId, Number(sessionUser.userId)) : [];

    if (incidencias.some((i) => i.estado === "pendiente")) {
      eligibility.canReport = false;
      eligibility.reason = "Ya tienes una incidencia pendiente en revision para este pedido.";
    }

    return json({
      success: true,
      eligibility,
      incidencias,
    });
  } catch (error) {
    console.error("[GET /api/me/pedidos/[id]/incidencias]", error);
    return json({ success: false, error: "No se pudo cargar incidencias" }, 500);
  }
}

export async function POST({ params, cookies, request }) {
  const sessionUser = getSessionUser(cookies);
  if (!sessionUser?.userId) {
    return json({ success: false, error: "No autenticado" }, 401);
  }

  const orderId = Number(params?.id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return json({ success: false, error: "Pedido invalido" }, 400);
  }

  try {
    await ensureIncidenciaSchema();

    const userRole = normalizeRole(sessionUser?.rol);
    const isSuperUser = userRole === "superusuario";
    const orderRow = await getOrderForUser(orderId, Number(sessionUser.userId));
    const eligibility = buildEligibility(orderRow, isSuperUser);
    if (!eligibility.canReport) {
      return json({ success: false, error: eligibility.reason || "El pedido no es elegible para reporte." }, 400);
    }

    const pending = await db.execute({
      sql: `SELECT Id_Incidencia FROM PedidoIncidencia WHERE Id_Pedido = ? AND Id_Usuario = ? AND Estado = 'pendiente' LIMIT 1`,
      args: [orderId, Number(sessionUser.userId)],
    });

    if (pending.rows.length) {
      return json({ success: false, error: "Ya existe una incidencia pendiente para este pedido." }, 409);
    }

    const formData = await request.formData();
    const motivo = asText(formData.get("motivo"), 100);
    const prioridad = normalizePriority(formData.get("prioridad"));
    const descripcion = asText(formData.get("descripcion"), 2500);
    const fotos = formData
      .getAll("fotos")
      .filter((f) => f instanceof File && f.size > 0);

    if (!motivo || motivo.length < 4) {
      return json({ success: false, error: "Debes indicar el motivo del fallo." }, 400);
    }

    if (!descripcion || descripcion.length < 20) {
      return json({ success: false, error: "La descripcion debe tener al menos 20 caracteres." }, 400);
    }

    if (fotos.length < 1) {
      return json({ success: false, error: "Debes adjuntar al menos una foto del fallo." }, 400);
    }

    if (fotos.length > MAX_IMAGES) {
      return json({ success: false, error: `Solo se permiten hasta ${MAX_IMAGES} fotos.` }, 400);
    }

    for (const foto of fotos) {
      if (!ALLOWED_MIME.has(foto.type)) {
        return json({ success: false, error: "Solo se aceptan imagenes JPG, PNG o WEBP." }, 400);
      }
      if (foto.size > MAX_IMAGE_BYTES) {
        return json({ success: false, error: "Cada foto debe pesar maximo 8MB." }, 400);
      }
    }

    const cloud = resolveCloudinaryConfig();
    if (!cloud.cloudName || !cloud.apiKey || !cloud.apiSecret) {
      return json({ success: false, error: "No hay configuracion de imagenes disponible para adjuntar evidencia." }, 500);
    }

    const now = new Date().toISOString();
    const insert = await db.execute({
      sql: `
        INSERT INTO PedidoIncidencia
          (Id_Pedido, Id_Usuario, Motivo, Prioridad, Descripcion, Estado, Fecha_Referencia_Entrega, Fecha_Limite_Reporte, Fecha_Creacion)
        VALUES (?, ?, ?, ?, ?, 'pendiente', ?, ?, ?)
      `,
      args: [
        orderId,
        Number(sessionUser.userId),
        motivo,
        prioridad,
        descripcion,
        String(eligibility.referenceDate || now),
        String(eligibility.deadline || now),
        now,
      ],
    });

    const incidenciaId = Number(insert.lastInsertRowid || 0);
    const folder = `go2026/incidencias/pedidos/${orderId}`;

    for (let i = 0; i < fotos.length; i += 1) {
      const photo = fotos[i];
      const uploaded = await uploadImageToCloudinary(
        photo,
        folder,
        `incidencia_${incidenciaId}_${Date.now()}_${i + 1}`,
        cloud
      );

      await db.execute({
        sql: `
          INSERT INTO PedidoIncidenciaImagen (Id_Incidencia, URL_Imagen, Public_ID, Fecha_Creacion)
          VALUES (?, ?, ?, ?)
        `,
        args: [incidenciaId, uploaded.url, uploaded.publicId, now],
      });
    }

    const folio = `INC-${new Date(now).getFullYear()}-${String(incidenciaId).padStart(6, "0")}`;
    await appendBitacora({
      incidenciaId,
      action: "creada",
      detail: `Incidencia creada por cliente con prioridad ${prioridad}.`,
      actorId: Number(sessionUser.userId),
      when: now,
    });

    // Notificacion por correo al cliente y a superusuarios. No bloquea la operacion.
    try {
      const customer = await getUserById(Number(sessionUser.userId));
      const customerName = [customer?.Nombre, customer?.Apellido_Paterno, customer?.Apellido_Materno].filter(Boolean).join(" ").trim() || "Cliente";
      const customerEmail = String(customer?.Correo || "").trim().toLowerCase();

      if (customerEmail) {
        await sendIncidentCreatedNotification({
          to: customerEmail,
          recipientRole: "usuario",
          customerName,
          orderNumber: String(orderRow?.Numero_Pedido || orderId),
          folio,
          motive: motivo,
          priority: prioridad,
          detail: descripcion,
          createdAt: now,
        });
      }

      const superEmails = await getSuperUserEmails();
      for (const email of superEmails) {
        await sendIncidentCreatedNotification({
          to: email,
          recipientRole: "superusuario",
          customerName,
          orderNumber: String(orderRow?.Numero_Pedido || orderId),
          folio,
          motive: motivo,
          priority: prioridad,
          detail: descripcion,
          createdAt: now,
        });
      }
    } catch (mailError) {
      console.error("[incidencias] fallo enviando notificaciones:", mailError);
      await appendBitacora({
        incidenciaId,
        action: "notificacion_fallida",
        detail: "No se pudo completar el envio de notificaciones por correo.",
        when: new Date().toISOString(),
      });
    }

    return json({
      success: true,
      incidencia: {
        id: incidenciaId,
        folio,
        prioridad,
        estado: "pendiente",
        fecha: now,
      },
      message: "Tu reporte fue enviado. Un administrador revisara tu evidencia.",
    });
  } catch (error) {
    console.error("[POST /api/me/pedidos/[id]/incidencias]", error);
    return json({ success: false, error: "No se pudo enviar la incidencia" }, 500);
  }
}
