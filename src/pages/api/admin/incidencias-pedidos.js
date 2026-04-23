import { createClient } from "@libsql/client";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../../lib/session.js";

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

function normalizeRole(value) {
  const compact = String(value || "").trim().toLowerCase().replace(/[\s_-]/g, "");
  if (compact === "superusuario" || compact === "superuser" || compact === "superadmin") return "superusuario";
  if (compact === "admin") return "admin";
  return String(value || "").trim().toLowerCase();
}

function normalizePriority(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "alta" || v === "baja") return v;
  return "media";
}

/** Signed go_session — not the forgeable plain-JSON authSession cookie. */
function getPrivilegedUser(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const user = verifySessionToken(token);
    const role = normalizeRole(user?.rol);
    if (role === "admin" || role === "superusuario") return user;
    return null;
  } catch {
    return null;
  }
}

async function ensureIncidenciaSchema() {
  return true;
}

export async function GET({ cookies, url }) {
  const user = getPrivilegedUser(cookies);
  if (!user) return json({ success: false, error: "Acceso denegado" }, 403);

  try {
    await ensureIncidenciaSchema();

    const status = String(url.searchParams.get("status") || "all").toLowerCase();
    const allowed = new Set(["all", "pendiente", "aprobada_devolucion", "rechazada_devolucion"]);
    const safeStatus = allowed.has(status) ? status : "all";

    let sql = `
      SELECT
        i.Id_Incidencia,
        i.Id_Pedido,
        i.Id_Usuario,
        i.Motivo,
        i.Prioridad,
        i.Descripcion,
        i.Estado,
        i.Veredicto,
        i.Comentario_Veredicto,
        i.Fecha_Referencia_Entrega,
        i.Fecha_Limite_Reporte,
        i.Fecha_Creacion,
        i.Fecha_Resolucion,
        p.Numero_Pedido,
        p.Estado AS Estado_Pedido,
        u.Nombre,
        u.Apellido_Paterno,
        u.Apellido_Materno,
        u.Correo
      FROM PedidoIncidencia i
      JOIN Pedido p ON p.Id_Pedido = i.Id_Pedido
      JOIN Usuario u ON u.Id = i.Id_Usuario
    `;

    const args = [];
    if (safeStatus !== "all") {
      sql += " WHERE i.Estado = ? ";
      args.push(safeStatus);
    }

    sql += " ORDER BY i.Fecha_Creacion DESC LIMIT 400";

    const result = await db.execute({ sql, args });
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

    const items = result.rows.map((row) => {
      const id = Number(row.Id_Incidencia || 0);
      return {
        id,
        folio: `INC-${new Date(String(row.Fecha_Creacion || Date.now())).getFullYear()}-${String(id).padStart(6, "0")}`,
        pedidoId: Number(row.Id_Pedido || 0),
        numeroPedido: Number(row.Numero_Pedido || 0),
        estadoPedido: String(row.Estado_Pedido || ""),
        motivo: String(row.Motivo || ""),
        prioridad: normalizePriority(row.Prioridad),
        descripcion: String(row.Descripcion || ""),
        estado: String(row.Estado || "pendiente"),
        veredicto: row.Veredicto ? String(row.Veredicto) : null,
        comentarioVeredicto: row.Comentario_Veredicto ? String(row.Comentario_Veredicto) : null,
        fechaReferenciaEntrega: String(row.Fecha_Referencia_Entrega || ""),
        fechaLimiteReporte: String(row.Fecha_Limite_Reporte || ""),
        fechaCreacion: String(row.Fecha_Creacion || ""),
        fechaResolucion: row.Fecha_Resolucion ? String(row.Fecha_Resolucion) : null,
        usuario: {
          id: Number(row.Id_Usuario || 0),
          nombre: [row.Nombre, row.Apellido_Paterno, row.Apellido_Materno].filter(Boolean).join(" ").trim(),
          correo: String(row.Correo || ""),
        },
        imagenes: imagesById[id] || [],
        bitacora: logsById[id] || [],
      };
    });

    return json({
      success: true,
      canVerdict: normalizeRole(user?.rol) === "superusuario",
      items,
    });
  } catch (error) {
    console.error("[GET /api/admin/incidencias-pedidos]", error);
    return json({ success: false, error: "No se pudieron cargar incidencias" }, 500);
  }
}

export async function PATCH({ cookies, request }) {
  const user = getPrivilegedUser(cookies);
  if (!user) return json({ success: false, error: "Acceso denegado" }, 403);

  const role = normalizeRole(user?.rol);
  if (role !== "superusuario") {
    return json({ success: false, error: "Solo superusuario puede dictaminar devoluciones" }, 403);
  }

  try {
    await ensureIncidenciaSchema();

    const body = await request.json().catch(() => ({}));
    const incidenciaId = Number(body?.id || 0);
    const accion = String(body?.veredicto || "").toLowerCase();
    const comentario = String(body?.comentario || "").trim().slice(0, 2000);

    if (!incidenciaId || !Number.isFinite(incidenciaId)) {
      return json({ success: false, error: "Incidencia invalida" }, 400);
    }

    const veredictMap = {
      aprobar: { estado: "aprobada_devolucion", veredicto: "devolucion_aprobada" },
      rechazar: { estado: "rechazada_devolucion", veredicto: "devolucion_rechazada" },
    };

    if (!veredictMap[accion]) {
      return json({ success: false, error: "Veredicto invalido" }, 400);
    }

    const found = await db.execute({
      sql: "SELECT Id_Incidencia, Id_Pedido, Estado FROM PedidoIncidencia WHERE Id_Incidencia = ? LIMIT 1",
      args: [incidenciaId],
    });

    if (!found.rows.length) {
      return json({ success: false, error: "Incidencia no encontrada" }, 404);
    }

    const row = found.rows[0];
    if (String(row.Estado || "") !== "pendiente") {
      return json({ success: false, error: "La incidencia ya fue dictaminada" }, 409);
    }

    const now = new Date().toISOString();
    const verdict = veredictMap[accion];

    await db.execute({
      sql: `
        UPDATE PedidoIncidencia
        SET Estado = ?, Veredicto = ?, Comentario_Veredicto = ?, Fecha_Resolucion = ?, Resuelto_Por = ?
        WHERE Id_Incidencia = ?
      `,
      args: [verdict.estado, verdict.veredicto, comentario || null, now, Number(user.userId || 0), incidenciaId],
    });

    await db.execute({
      sql: `
        INSERT INTO PedidoIncidenciaBitacora
          (Id_Incidencia, Accion, Detalle, Id_Actor, Fecha_Creacion)
        VALUES (?, ?, ?, ?, ?)
      `,
      args: [
        incidenciaId,
        accion === "aprobar" ? "dictamen_aprobado" : "dictamen_rechazado",
        comentario || (accion === "aprobar" ? "Devolucion aprobada por superusuario." : "Devolucion rechazada por superusuario."),
        Number(user.userId || 0),
        now,
      ],
    });

    if (accion === "aprobar") {
      await db.execute({
        sql: "UPDATE Pedido SET Estado = 'devolucion_solicitada' WHERE Id_Pedido = ?",
        args: [Number(row.Id_Pedido)],
      });
    }

    return json({ success: true, message: "Veredicto registrado correctamente" });
  } catch (error) {
    console.error("[PATCH /api/admin/incidencias-pedidos]", error);
    return json({ success: false, error: "No se pudo registrar el veredicto" }, 500);
  }
}
