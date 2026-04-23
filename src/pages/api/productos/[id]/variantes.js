import { getProductoDetalleById } from "../../../../lib/productos-service.js";

export async function GET({ params }) {
  const id = Number(params.id);
  if (!Number.isFinite(id) || id <= 0)
    return new Response(JSON.stringify({ success: false, error: "ID inválido" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });

  try {
    const producto = await getProductoDetalleById(id);
    if (!producto)
      return new Response(JSON.stringify({ success: false, error: "Producto no encontrado" }), {
        status: 404, headers: { "Content-Type": "application/json" },
      });

    return new Response(JSON.stringify({ success: true, variantes: producto.variantes }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}