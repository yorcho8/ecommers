// src/pages/api/ai-analysis.js
// Usa el mismo /api/chat que el AdminPanel — SIN necesitar API key extra

export const prerender = false;

export async function POST({ request }) {
  try {
    const { data, periodo } = await request.json();
    if (!data) return json({ ok: false, error: 'Sin datos' }, 400);

    const tp   = Object.entries(data?.products || {}).sort(([,a],[,b]) => b-a).slice(0,5).map(([k,v]) => `${k}:${v}`).join(', ');
    const tk   = Object.entries(data?.keywords || {}).sort(([,a],[,b]) => b-a).slice(0,8).map(([k,v]) => `${k}:${v}`).join(', ');
    const msgs = (data?.lastMessages || []).slice(-20).map(m => m.user).join(' | ');

    const prompt = `Eres analista ejecutivo de ventas de Grupo Ortiz (empaques industriales, México).
Analiza los datos del chatbot BotGO del período "${periodo}" y genera un resumen ejecutivo en español (máximo 180 palabras).

DATOS:
Sesiones:${data.totalSessions||0}|Mensajes:${data.totalMessages||0}|WhatsApp:${data.totalWhatsApp||0}|PDFs:${data.totalPDFs||0}
Productos top: ${tp||'sin datos'}
Keywords top: ${tk||'sin datos'}
Intenciones: Compra=${data.intents?.compra||0}, Info=${data.intents?.info||0}, PDF=${data.intents?.pdf||0}, Empleo=${data.intents?.reclutamiento||0}
Consultas recientes: ${msgs.substring(0,400)||'sin datos'}

INSTRUCCIONES:
- Escribe exactamente 4 bullets con los hallazgos más importantes
- Cada bullet empieza con "- " (guión espacio)
- Incluye: comportamiento general, producto estrella, oportunidades, recomendación comercial
- Usa números concretos de los datos
- NO uses asteriscos, negritas ni markdown
- Empieza DIRECTAMENTE con el primer bullet, sin título ni introducción`;

    // ← Mismo endpoint que usa el AdminPanel, sin API key extra
    const origin  = new URL(request.url).origin;
    const chatRes = await fetch(`${origin}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], language: 'es', isVoice: false }),
    });

    if (!chatRes.ok) return json({ ok: false, error: `Chat API ${chatRes.status}` }, 500);

    const chatJson = await chatRes.json();
    const analysis = (chatJson.reply || '').trim();
    if (!analysis) return json({ ok: false, error: 'Respuesta vacía' }, 500);

    return json({ ok: true, analysis });

  } catch (err) {
    console.error('ai-analysis:', err.message);
    return json({ ok: false, error: err.message }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}