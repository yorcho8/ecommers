// GET /api/admin/publicidad/pagos
// Lista el historial completo de pagos de publicidad (empresa -> Nexus)
// Solo accesible para admin y superusuario
import { createClient } from "@libsql/client";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../../../lib/session.js";

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

function getSession(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
  } catch {
    return null;
  }
}

export async function GET({ cookies, request }) {
  const user = getSession(cookies);
  if (!user?.userId) return json({ success: false, error: "No autenticado" }, 401);

  const rol = String(user.rol || "").toLowerCase();
  if (rol !== "admin" && rol !== "superusuario") {
    return json({ success: false, error: "Sin permisos" }, 403);
  }

  // Schema is managed offline by migrations.

  try {
    const url = new URL(request.url);
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const perPage = Math.min(100, Math.max(5, Number(url.searchParams.get("perPage") || 20)));
    const offset = (page - 1) * perPage;
    const search = url.searchParams.get("q")?.trim() || "";
    const estadoFilter = url.searchParams.get("estado") || "";

    let whereClauses = [];
    let whereArgs = [];

    if (search) {
      whereClauses.push(`(
        e.Nombre_Empresa LIKE ?
        OR e.RFC LIKE ?
        OR p.Nombre LIKE ?
      )`);
      const like = `%${search}%`;
      whereArgs.push(like, like, like);
    }

    if (estadoFilter && ["activa", "vencida"].includes(estadoFilter)) {
      whereClauses.push(`pc.Estado = ?`);
      whereArgs.push(estadoFilter);
    }

    const whereSQL = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";

    const [countRes, rowsRes] = await Promise.all([
      db.execute({
        sql: `
          SELECT COUNT(*) AS total
          FROM PublicidadCampana pc
          LEFT JOIN Empresa e ON e.Id_Empresa = pc.Id_Empresa
          LEFT JOIN Producto p ON p.Id_Producto = pc.Id_Producto
          ${whereSQL}
        `,
        args: whereArgs,
      }),
      db.execute({
        sql: `
          SELECT
            pc.Id_Publicidad,
            pc.Id_Producto,
            pc.Id_Empresa,
            pc.Id_Usuario,
            pc.Monto,
            pc.Moneda,
            pc.Duracion_Dias,
            pc.Posicion,
            pc.Prioridad,
            pc.Precio_Dia,
            pc.Monto_Bruto,
            pc.Descuento_MXN,
            pc.Estado,
            pc.Payment_Intent_Id,
            pc.Fecha_Inicio,
            pc.Fecha_Fin,
            pc.Fecha_Creacion,
            e.Nombre_Empresa,
            e.Nombre_Comercial,
            e.RFC,
            e.Regimen_Fiscal,
            (SELECT d.Codigo_Postal FROM Direccion d WHERE d.Id_Empresa = e.Id_Empresa ORDER BY d.Id_Direccion LIMIT 1) AS CP_Fiscal_Empresa,
            p.Nombre  AS Nombre_Producto,
            u.Nombre  AS Nombre_Usuario,
            u.Correo  AS Correo_Usuario,
            fac.Id_FacturaPublicidad,
            fac.Estado AS Factura_Estado,
            fac.UUID   AS Factura_UUID
          FROM PublicidadCampana pc
          LEFT JOIN Empresa e  ON e.Id_Empresa  = pc.Id_Empresa
          LEFT JOIN Producto p ON p.Id_Producto = pc.Id_Producto
          LEFT JOIN Usuario  u ON u.Id          = pc.Id_Usuario
          LEFT JOIN FacturaPublicidad fac ON fac.Id_Campana = pc.Id_Publicidad
                                          AND fac.Estado = 'vigente'
          ${whereSQL}
          ORDER BY pc.Fecha_Creacion DESC
          LIMIT ? OFFSET ?
        `,
        args: [...whereArgs, perPage, offset],
      }),
    ]);

    const total = Number(countRes.rows[0]?.total || 0);
    const pagos = rowsRes.rows.map((r) => ({
      id: Number(r.Id_Publicidad),
      productoId: Number(r.Id_Producto),
      empresaId: r.Id_Empresa ? Number(r.Id_Empresa) : null,
      usuarioId: Number(r.Id_Usuario),
      monto: Number(r.Monto || 0),
      moneda: String(r.Moneda || "MXN"),
      duracionDias: Number(r.Duracion_Dias || 0),
      posicion: String(r.Posicion || "grid"),
      prioridad: Number(r.Prioridad || 0),
      precioDia: Number(r.Precio_Dia || 0),
      montoBruto: Number(r.Monto_Bruto || 0),
      descuento: Number(r.Descuento_MXN || 0),
      estado: String(r.Estado || ""),
      paymentIntentId: String(r.Payment_Intent_Id || ""),
      fechaInicio: r.Fecha_Inicio ? String(r.Fecha_Inicio) : null,
      fechaFin: r.Fecha_Fin ? String(r.Fecha_Fin) : null,
      fechaCreacion: String(r.Fecha_Creacion || ""),
      empresa: {
        nombre: r.Nombre_Comercial ? String(r.Nombre_Comercial) : (r.Nombre_Empresa ? String(r.Nombre_Empresa) : "Sin empresa"),
        rfc: r.RFC ? String(r.RFC) : null,
        regimenFiscal: r.Regimen_Fiscal ? String(r.Regimen_Fiscal) : null,
        cp: r.CP_Fiscal_Empresa ? String(r.CP_Fiscal_Empresa) : null,
      },
      producto: String(r.Nombre_Producto || "Producto eliminado"),
      usuario: {
        nombre: r.Nombre_Usuario ? String(r.Nombre_Usuario) : "",
        correo: r.Correo_Usuario ? String(r.Correo_Usuario) : "",
      },
      factura: r.Id_FacturaPublicidad
        ? {
            id: Number(r.Id_FacturaPublicidad),
            estado: String(r.Factura_Estado || ""),
            uuid: String(r.Factura_UUID || ""),
          }
        : null,
    }));

    return json({
      success: true,
      pagos,
      pagination: {
        total,
        page,
        perPage,
        pages: Math.ceil(total / perPage),
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/publicidad/pagos]", err);
    return json({ success: false, error: "Error interno" }, 500);
  }
}
