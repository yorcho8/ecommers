import { createClient } from "@libsql/client";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../lib/session.js";

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

function getSessionUser(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
  } catch {
    return null;
  }
}

function sanitizeText(value, max = 3000) {
  return String(value || "").trim().slice(0, max);
}

async function ensureFeedbackSchema() {
  return true;
}

async function getUserContactData(userId) {
  const result = await db.execute({
    sql: `SELECT
            u.Id,
            u.Nombre,
            u.Correo,
            u.Telefono,
            d.Numero_casa
          FROM Usuario u
          LEFT JOIN Direccion d ON d.Id_Usuario = u.Id
          WHERE u.Id = ?
          ORDER BY d.Id_Direccion DESC
          LIMIT 1`,
    args: [Number(userId)],
  });

  if (!result.rows.length) return null;
  const row = result.rows[0];

  const nombre = sanitizeText(row.Nombre, 120);
  const correo = sanitizeText(row.Correo, 160).toLowerCase();
  const telefono = sanitizeText(row.Telefono, 40);
  const numero = row.Numero_casa != null ? String(row.Numero_casa).trim() : "";

  return { nombre, correo, telefono, numero };
}

function buildFolio(id) {
  const year = new Date().getFullYear();
  const seq = String(id).padStart(6, "0");
  return `QS-${year}-${seq}`;
}

function normalizeCategory(value) {
  const raw = sanitizeText(value, 40).toLowerCase();
  const allowed = ["producto_pedido", "atencion", "tecnico_fallo", "general"];
  return allowed.includes(raw) ? raw : "general";
}

function normalizeContactChannel(value) {
  const raw = sanitizeText(value, 24).toLowerCase();
  const allowed = ["ticket", "whatsapp", "correo"];
  return allowed.includes(raw) ? raw : "ticket";
}

export async function POST({ request, cookies }) {
  try {
    await ensureFeedbackSchema();
    const body = await request.json().catch(() => ({}));
    const sessionUser = getSessionUser(cookies);
    if (!sessionUser?.userId) {
      return json({ success: false, error: "Debes iniciar sesion para enviar una queja o sugerencia." }, 401);
    }

    const userContact = await getUserContactData(sessionUser.userId);
    if (!userContact) {
      return json({ success: false, error: "No se pudo obtener tu informacion de contacto." }, 404);
    }

    const tipoRaw = sanitizeText(body?.tipo, 20).toLowerCase();
    const tipo = tipoRaw === "queja" || tipoRaw === "fallo" ? tipoRaw : "sugerencia";
    const categoria = normalizeCategory(body?.categoria);
    const canalRespuesta = normalizeContactChannel(body?.canalRespuesta);

    const asunto = sanitizeText(body?.asunto, 120);
    const mensaje = sanitizeText(body?.mensaje, 3000);
    const nombre = userContact.nombre;
    const correo = userContact.correo;
    const telefono = userContact.telefono;
    const numero = userContact.numero;

    if (!asunto || asunto.length < 6) {
      return json({ success: false, error: "El asunto debe tener al menos 6 caracteres." }, 400);
    }

    if (!mensaje || mensaje.length < 20) {
      return json({ success: false, error: "El mensaje debe tener al menos 20 caracteres." }, 400);
    }

    if (!correo || !correo.includes("@")) {
      return json({ success: false, error: "Ingresa un correo valido para contactarte." }, 400);
    }

    const now = new Date().toISOString();
    const insert = await db.execute({
      sql: `INSERT INTO QuejaSugerencia
            (Id_Usuario, Tipo, Asunto, Mensaje, Categoria, Canal_Respuesta, Estado, Origen, Fecha_Creacion, Fecha_Actualizacion)
            VALUES (?, ?, ?, ?, ?, ?, 'nuevo', 'web', ?, ?)`,
      args: [
        Number(sessionUser.userId),
        tipo,
        asunto,
        mensaje,
        categoria,
        canalRespuesta,
        now,
        now,
      ],
    });

    const feedbackId = Number(insert.lastInsertRowid || 0);

    return json({
      success: true,
      message: "Tu mensaje fue enviado correctamente.",
      feedback: {
        id: feedbackId,
        folio: buildFolio(feedbackId),
        tipo,
        categoria,
        canalRespuesta,
        estado: "nuevo",
        fecha: now,
        contacto: {
          nombre,
          correo,
          telefono,
          numero,
        },
      },
    });
  } catch (error) {
    console.error("[feedback/post] error:", error);
    return json({ success: false, error: "No se pudo enviar tu mensaje." }, 500);
  }
}

export async function GET({ cookies, url }) {
  try {
    await ensureFeedbackSchema();
    const sessionUser = getSessionUser(cookies);
    if (!sessionUser?.userId) {
      return json({ success: false, error: "No autenticado" }, 401);
    }

    const userContact = await getUserContactData(sessionUser.userId);
    if (!userContact) {
      return json({ success: false, error: "Usuario no encontrado" }, 404);
    }

    const limit = Math.min(30, Math.max(1, Number(url.searchParams.get("limit") || 10)));

    const result = await db.execute({
      sql: `SELECT Id_Feedback, Tipo, Asunto, Mensaje, Categoria, Canal_Respuesta, Estado, Fecha_Creacion
            FROM QuejaSugerencia
            WHERE Id_Usuario = ?
            ORDER BY Fecha_Creacion DESC
            LIMIT ?`,
      args: [Number(sessionUser.userId), limit],
    });

    const items = result.rows.map((row) => {
      const id = Number(row.Id_Feedback || 0);
      return {
        id,
        folio: buildFolio(id),
        tipo: String(row.Tipo || "sugerencia"),
        asunto: String(row.Asunto || ""),
        mensaje: String(row.Mensaje || ""),
        categoria: String(row.Categoria || "general"),
        canalRespuesta: String(row.Canal_Respuesta || "ticket"),
        estado: String(row.Estado || "nuevo"),
        fecha: String(row.Fecha_Creacion || ""),
      };
    });

    return json({
      success: true,
      viewer: {
        id: Number(sessionUser.userId),
        contacto: userContact.nombre,
        correo: userContact.correo,
        telefono: userContact.telefono,
        numero: userContact.numero,
      },
      items,
    });
  } catch (error) {
    console.error("[feedback/get] error:", error);
    return json({ success: false, error: "No se pudo cargar tu historial." }, 500);
  }
}
