import { createClient } from "@libsql/client";
import "dotenv/config";
import { verifySessionToken, SESSION_COOKIE } from "../../../lib/session.js";

const db = createClient({
  url: process.env.ECOMERS_DATABASE_URL || import.meta.env.ECOMERS_DATABASE_URL,
  authToken: process.env.ECOMERS_AUTH_TOKEN || import.meta.env.ECOMERS_AUTH_TOKEN,
});

const VALID_RANGES = new Set([7, 30, 90]);
const PAID_STATES = new Set(["pagado", "aprobado", "completado", "succeeded"]);
const BLOCKED_ORDER_STATES = new Set(["cancelado", "devolucion_solicitada"]);
const ESTIMATED_MARGIN = Number(process.env.ADMIN_ESTIMATED_MARGIN || "0.34");

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Signed go_session — not the forgeable plain-JSON authSession cookie. */
function getPrivilegedUser(cookies) {
  try {
    const token = cookies.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const user = verifySessionToken(token);
    const role = String(user?.rol || "").toLowerCase();
    if (role === "admin" || role === "superusuario") return user;
    return null;
  } catch {
    return null;
  }
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function formatDateKey(dateValue) {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function formatMonthKey(dateValue) {
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 7);
}

function getPreviousMonthKey(monthKey) {
  if (!monthKey) return "";
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month) return "";
  const prev = new Date(Date.UTC(year, month - 2, 1));
  return prev.toISOString().slice(0, 7);
}

function shouldCountAsRevenue(row) {
  const orderState = normalizeText(row.EstadoPedido);
  const payState = normalizeText(row.EstadoPago);

  if (BLOCKED_ORDER_STATES.has(orderState)) return false;
  if (PAID_STATES.has(payState)) return true;

  return orderState === "pagado" || orderState === "enviado" || orderState === "entregado";
}

function pct(current, previous) {
  const c = Number(current || 0);
  const p = Number(previous || 0);
  if (!p) return c > 0 ? 100 : 0;
  return Number((((c - p) / p) * 100).toFixed(2));
}

function mxn(value) {
  return Number(Number(value || 0).toFixed(2));
}

function clampRange(raw) {
  const parsed = Number(raw);
  if (VALID_RANGES.has(parsed)) return parsed;
  return 30;
}

async function resolveEmpresaId(user) {
  const role = String(user?.rol || "").toLowerCase();
  const userId = Number(user?.userId || 0);
  if (!userId || role === "superusuario") return null;

  const empresaRes = await db.execute({
    sql: `SELECT Id_Empresa FROM UsuarioEmpresa WHERE Id_Usuario = ? AND Activo = 1 LIMIT 1`,
    args: [userId],
  });

  if (!empresaRes.rows.length) return null;
  return Number(empresaRes.rows[0].Id_Empresa || 0) || null;
}

function buildEmpresaArgs(empresaId) {
  return [empresaId ? 1 : 0, empresaId || 0];
}

export async function GET({ cookies, request }) {
  const user = getPrivilegedUser(cookies);
  if (!user) return json({ success: false, error: "Acceso denegado" }, 403);

  try {
    const url = new URL(request.url);
    const range = clampRange(url.searchParams.get("range"));

    const empresaId = await resolveEmpresaId(user);
    const empresaArgs = buildEmpresaArgs(empresaId);

    const ordersRes = await db.execute({
      sql: `
        SELECT
          p.Id_Pedido,
          p.Fecha_pedido,
          p.Estado AS EstadoPedido,
          COALESCE(pg.Estado_Pago, '') AS EstadoPago,
          COALESCE(pg.Monto, p.Total, 0) AS Monto
        FROM Pedido p
        LEFT JOIN (
          SELECT p1.Id_Pedido, p1.Estado_Pago, p1.Monto
          FROM Pago p1
          JOIN (
            SELECT Id_Pedido, MAX(Id_Pago) AS MaxPagoId
            FROM Pago
            GROUP BY Id_Pedido
          ) latest ON latest.MaxPagoId = p1.Id_Pago
        ) pg ON pg.Id_Pedido = p.Id_Pedido
        WHERE date(p.Fecha_pedido) >= date('now', '-180 day')
          AND (
            ? = 0
            OR EXISTS (
              SELECT 1
              FROM DetallePedido dp
              JOIN Producto pr ON pr.Id_Producto = dp.Id_Producto
              WHERE dp.Id_Pedido = p.Id_Pedido
                AND pr.Id_Empresa = ?
            )
          )
        ORDER BY p.Fecha_pedido DESC, p.Id_Pedido DESC
      `,
      args: empresaArgs,
    });

    const now = new Date();
    const todayKey = formatDateKey(now);
    const monthKey = formatMonthKey(now);
    const prevMonthKey = getPreviousMonthKey(monthKey);

    const seriesMap = new Map();
    const rangeStart = new Date(now);
    rangeStart.setUTCDate(rangeStart.getUTCDate() - (range - 1));

    let ingresosHoy = 0;
    let ingresosMes = 0;
    let ingresosMesPrevio = 0;
    let ordenesHoy = 0;
    let ordenesMes = 0;

    for (const row of ordersRes.rows) {
      if (!shouldCountAsRevenue(row)) continue;

      const dateKey = formatDateKey(row.Fecha_pedido);
      const mKey = dateKey.slice(0, 7);
      const amount = Number(row.Monto || 0);

      if (dateKey === todayKey) {
        ingresosHoy += amount;
        ordenesHoy += 1;
      }

      if (mKey === monthKey) {
        ingresosMes += amount;
        ordenesMes += 1;
      }

      if (mKey === prevMonthKey) {
        ingresosMesPrevio += amount;
      }

      const rowDate = new Date(row.Fecha_pedido);
      if (Number.isNaN(rowDate.getTime()) || rowDate < rangeStart) continue;

      const existing = seriesMap.get(dateKey) || { date: dateKey, ingresos: 0, ordenes: 0 };
      existing.ingresos += amount;
      existing.ordenes += 1;
      seriesMap.set(dateKey, existing);
    }

    const trend = [];
    for (let i = range - 1; i >= 0; i -= 1) {
      const cursor = new Date(now);
      cursor.setUTCDate(cursor.getUTCDate() - i);
      const key = formatDateKey(cursor);
      const row = seriesMap.get(key) || { date: key, ingresos: 0, ordenes: 0 };
      trend.push({
        date: row.date,
        ingresos: mxn(row.ingresos),
        ordenes: Number(row.ordenes || 0),
      });
    }

    const topProductsRes = await db.execute({
      sql: `
        SELECT
          pr.Nombre AS NombreProducto,
          SUM(dp.Cantidad) AS Unidades,
          SUM(dp.Cantidad * dp.Precio_Unitario) AS Ingresos
        FROM Pedido p
        JOIN DetallePedido dp ON dp.Id_Pedido = p.Id_Pedido
        JOIN Producto pr ON pr.Id_Producto = dp.Id_Producto
        LEFT JOIN (
          SELECT p1.Id_Pedido, p1.Estado_Pago
          FROM Pago p1
          JOIN (
            SELECT Id_Pedido, MAX(Id_Pago) AS MaxPagoId
            FROM Pago
            GROUP BY Id_Pedido
          ) latest ON latest.MaxPagoId = p1.Id_Pago
        ) pg ON pg.Id_Pedido = p.Id_Pedido
        WHERE strftime('%Y-%m', p.Fecha_pedido) = ?
          AND lower(COALESCE(p.Estado, '')) NOT IN ('cancelado', 'devolucion_solicitada')
          AND (
            lower(COALESCE(pg.Estado_Pago, '')) IN ('pagado', 'aprobado', 'completado', 'succeeded')
            OR lower(COALESCE(p.Estado, '')) IN ('pagado', 'enviado', 'entregado')
          )
          AND (? = 0 OR pr.Id_Empresa = ?)
        GROUP BY pr.Id_Producto, pr.Nombre
        ORDER BY Ingresos DESC
        LIMIT 5
      `,
      args: [monthKey, ...empresaArgs],
    });

    const statusRes = await db.execute({
      sql: `
        SELECT
          lower(COALESCE(p.Estado, 'sin_estado')) AS Estado,
          COUNT(*) AS Total
        FROM Pedido p
        WHERE strftime('%Y-%m', p.Fecha_pedido) = ?
          AND (
            ? = 0
            OR EXISTS (
              SELECT 1
              FROM DetallePedido dp
              JOIN Producto pr ON pr.Id_Producto = dp.Id_Producto
              WHERE dp.Id_Pedido = p.Id_Pedido
                AND pr.Id_Empresa = ?
            )
          )
        GROUP BY lower(COALESCE(p.Estado, 'sin_estado'))
        ORDER BY Total DESC
      `,
      args: [monthKey, ...empresaArgs],
    });

    const topProductosMes = topProductsRes.rows.map((row) => ({
      nombre: String(row.NombreProducto || "Producto"),
      unidades: Number(row.Unidades || 0),
      ingresos: mxn(row.Ingresos || 0),
    }));

    const estadoPedidosMes = statusRes.rows.map((row) => ({
      estado: String(row.Estado || "sin_estado"),
      total: Number(row.Total || 0),
    }));

    const ticketPromedioMes = ordenesMes ? ingresosMes / ordenesMes : 0;
    const margen = Number.isFinite(ESTIMATED_MARGIN)
      ? Math.max(0, Math.min(0.95, ESTIMATED_MARGIN))
      : 0.34;

    return json({
      success: true,
      range,
      currency: "MXN",
      updatedAt: new Date().toISOString(),
      kpis: {
        ingresosHoy: mxn(ingresosHoy),
        ingresosMes: mxn(ingresosMes),
        crecimientoMensual: pct(ingresosMes, ingresosMesPrevio),
        ordenesHoy: Number(ordenesHoy || 0),
        ordenesMes: Number(ordenesMes || 0),
        ticketPromedioMes: mxn(ticketPromedioMes),
        gananciasEstimadasMes: mxn(ingresosMes * margen),
        margenEstimado: Number((margen * 100).toFixed(1)),
      },
      trend,
      topProductosMes,
      estadoPedidosMes,
    });
  } catch (error) {
    console.error("[GET /api/admin/dashboard-ventas] Error:", error);
    return json({ success: false, error: "No se pudieron obtener las metricas" }, 500);
  }
}
