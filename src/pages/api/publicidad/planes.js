import { getPublicidadPlansWithExamples } from "../../../lib/publicidad.js";

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET() {
  try {
    const plans = getPublicidadPlansWithExamples();
    return jsonResponse(200, { success: true, plans });
  } catch (error) {
    console.error("[GET /api/publicidad/planes]", error);
    return jsonResponse(500, { success: false, error: error?.message || "Error interno" });
  }
}
