// src/pages/api/chat.js
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import * as googleTTS from 'google-tts-api';
import { Buffer } from 'node:buffer';
import { logInteraction } from '../../lib/analytics-db.js';
import { saveCandidate } from '../../lib/recruitment-db.js';

export const prerender = false;

const VOICE_MAP = {
  es:"es-MX-DaliaNeural", en:"en-US-JennyNeural",
  pt:"pt-BR-FranciscaNeural", fr:"fr-FR-DeniseNeural",
  zh:"zh-CN-XiaoxiaoNeural", ar:"ar-EG-SalmaNeural"
};
const LANGUAGES_MAP = {
  es:'Spanish', en:'English', pt:'Portuguese',
  zh:'Chinese', ar:'Arabic', fr:'French'
};

// ─── Mapa de productos: aliases, plurales y errores comunes ──────────────────
const PRODUCT_ALIASES = {
  rafia:      ['rafia','rafias','rafia de atar','rafia ecologica','rafia fibrilada',
               'rafía','ráfia','rfia','raifa','rafai'],
  stretch:    ['stretch','film','pelicula','película','estirable','stretch film',
               'strech','estirarble','pelicual','streetch','pellícula','estriable'],
  cuerdas:    ['cuerda','cuerdas','cordel','cordeles','soga','sogas',
               'cuerda ferretera','cuerda invernadero','cuerda ecologica',
               'cuerta','cuerdas de pp','cuerda pp','cuerda polipropileno'],
  sacos:      ['saco','sacos','costal','costales','bolsa de rafia','bolsas de rafia',
               'saco transparente','saco ecologico','saccos','saos','cotal'],
  arpillas:   ['arpilla','arpillas','arpila','arpilas','malla','mallas','red','redes',
               'arpilla circular','arpilla monofilamento','arpila','arpílla','arpiilla'],
  esquineros: ['esquinero','esquineros','esquinero kraft','cantonera','cantoneras',
               'protector de esquina','esquineros de carton','eskinero','esquinro'],
  flexible:   ['empaque flexible','empaques flexibles','bobina','bobinas',
               'stand up','standup','bolsa stand up','bolsa alto vacio',
               'flexible','flexibles','pouch','empaque','empaques','bolsa impresa'],
};

/**
 * Detecta qué producto menciona el usuario.
 * Normaliza texto: minúsculas, sin acentos, sin puntuación.
 * Retorna el key del producto o null.
 */
function detectarProducto(texto) {
  if (!texto) return null;
  const norm = texto
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const [producto, aliases] of Object.entries(PRODUCT_ALIASES)) {
    for (const alias of aliases) {
      const aliasNorm = alias
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9 ]/g, ' ').trim();
      if (norm.includes(aliasNorm)) return producto;
    }
  }
  return null;
}

/**
 * Detecta intención de cotizar/comprar en el mensaje del usuario.
 */
function esIntencionCotizar(texto) {
  if (!texto) return false;
  const norm = texto
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const keywords = [
    'precio','precios','costo','costos','cuanto cuesta','cuanto vale',
    'cotiza','cotizar','cotizacion','comprar','compra','pedido','pedir',
    'adquirir','ordenar','tarifa','presupuesto','quiero comprar',
    'me interesa','cuanto cobran','cuanto me sale','valor','valores',
    'cuánto','cuanto','quanto','how much','prix','prezo'
  ];
  return keywords.some(k => norm.includes(k));
}

/**
 * Analiza el historial completo de mensajes para saber:
 * - lastWAProduct: último producto por el que se disparó WA
 * - waEnviado: si ya se envió WA alguna vez
 * - pdfEnviados: Set de productos cuyo PDF ya fue enviado
 */
function analizarHistorial(messages) {
  let lastWAProduct = null;
  let waEnviado     = false;
  const pdfEnviados = new Set();

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const content = m.content || '';

    // ¿Se disparó WA en esta respuesta?
    if (/\[ACCION\s*:\s*WHATSAPP\]/i.test(content)) {
      waEnviado = true;
      // Buscar el mensaje de usuario anterior para saber de qué producto
      for (let j = i - 1; j >= 0; j--) {
        if (messages[j].role === 'user') {
          const prod = detectarProducto(messages[j].content);
          if (prod) { lastWAProduct = prod; break; }
        }
      }
    }

    // ¿Se envió algún PDF?
    const pdfMatches = content.match(/\[ACCION\s*:\s*PDF\s*:\s*([\w-]+)\]/gi) || [];
    pdfMatches.forEach(tag => {
      const m2 = tag.match(/\[ACCION\s*:\s*PDF\s*:\s*([\w-]+)\]/i);
      if (m2) pdfEnviados.add(m2[1].toLowerCase());
    });
  }

  return { lastWAProduct, waEnviado, pdfEnviados };
}

// ─── System Prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt(targetLang) {
  return `
Eres Valeria, asesora comercial de Grupo Ortiz con 8 años en la empresa.
Hablas en ${targetLang} — tono cálido, directo y profesional, como una persona real.
Nunca menciones que eres IA ni robot. Usa frases cortas y naturales.
JAMÁS incluyas URLs.

══════════════════════════════════════════
  REGLA DE ORO — RESPUESTAS CORTAS
══════════════════════════════════════════
- Máximo 2-3 líneas por respuesta. SIEMPRE.
- Nunca des toda la información de golpe.
- Da un dato o idea principal y pregunta si quiere saber más.
- Si el usuario pregunta "¿quiénes son?" o "¿qué hacen?" → responde en 2 líneas lo más importante y termina con "¿Te cuento más? 😊"
- Si el usuario pregunta por un producto → describe en 1-2 líneas y pregunta "¿Quieres la ficha técnica o te explico más sobre alguna variedad?"
- Si el usuario pide "más info" o "cuéntame más" → da el siguiente nivel de detalle, nunca todo junto.
- Nunca hagas listas largas. Si necesitas listar, máximo 3 puntos.

══════════════════════════════════════════
  REGLA DE FORMATO — TIPOS DE PRODUCTO
══════════════════════════════════════════
Cuando el usuario pregunte "¿qué tipos hay?", "¿cuáles tipos tienen?",
"tipos de [producto]", "variedades", "opciones disponibles" o similar:

PASO 1 — Lista SOLO los nombres, sin descripción.
CRÍTICO: escribe los nombres en formato Title Case (primera letra mayúscula, resto minúsculas).
NUNCA uses todo en mayúsculas. Ejemplo correcto: "Rafia de atar", NO "RAFIA DE ATAR".

- **Nombre del tipo**
- **Nombre del tipo**
- **Nombre del tipo**
- **Nombre del tipo**

¿Cuál te interesa? 😊

PASO 2 — Si el usuario menciona un nombre específico de la lista:
Responde con 2-3 líneas describiendo ESE tipo solamente.
Termina con: "¿Te mando la ficha técnica o tienes alguna duda? 😊"

REGLAS:
- En PASO 1: CERO descripciones. Solo el nombre en **negritas**.
- En PASO 2: Solo habla del tipo que pidió, no repitas toda la lista.
- Si el usuario dice "el primero" o "el segundo" → interpreta por posición.
- Nunca mezcles paso 1 y paso 2 en la misma respuesta.

══════════════════════════════════════════
  GRUPO ORTIZ — QUIÉNES SOMOS
══════════════════════════════════════════
Fundado en 1959 en Morelia, Michoacán, México por Nicandro Ortiz.
Líderes fabricantes de empaques industriales y agrícolas en Latinoamérica.
Más de 65 años de experiencia. Presencia en 5 continentes y más de 30 países.
3,000 colaboradores. 17 plantas de producción (16 en Morelia, 1 en Monterrey).
Capacidad: 220,000 toneladas anuales.

Certificaciones: FSSC 22000, ISO 9001:2015, AIB International, Kosher Pareve.
Contacto: WhatsApp +52 443-207-2593 | contacto@grupoo.com.mx | Morelia, Michoacán.

Hitos: 1959 Fundación · 1970 Sacos y arpillas · 1985 Maquinaria europea ·
1995 Diversificación · 2005 Expansión internacional · 2015 Planta reciclado · 2026 Líder consolidado.

══════════════════════════════════════════
  IMPACTO SOCIAL Y SOSTENIBILIDAD
══════════════════════════════════════════
Alineados con los 17 ODS de la ONU.
Pilares: PRODUCTOS DE LA TIERRA · PRÁCTICAS DE LA TIERRA · TIERRA SOCIAL.
Iniciativas: Hogar de Esperanza, Despensa GO, Cero Huella, Composta Viva, Brilla GO.
Alianzas: The Ocean Cleanup, Tom Ford Plastic Innovation Prize.
Plantilla 84-97% femenina. Stretch biodegradable: se degrada 90% más rápido.

══════════════════════════════════════════
  CATÁLOGO COMPLETO DE PRODUCTOS
══════════════════════════════════════════

─────────────────────────────────────────
1. Rafias
─────────────────────────────────────────
PP 100% virgen. Tipos: Rafia de atar (PP-UV, 2-8mm, 60-320kg, 90m/kg) |
Rafia ecológica (sustentable) | Rafia fibrilada negra (UV exterior).
Usos: amarre agrícola, avícola, horticultura, invernaderos, construcción.

─────────────────────────────────────────
2. Película estirable stretch
─────────────────────────────────────────
Tipos: Stretch premium manual (19-30cm, 1,000-15,000m, 40-110 micras) |
Automático | Manual preestirado | Manual banding | Manual rígido.
Usos: paletizado, logística, almacén, transporte.

─────────────────────────────────────────
3. Cuerdas de polipropileno
─────────────────────────────────────────
Tipos: Cuerda ferretera (PP+UV, 1,980m, 18kg, 175kg resistencia, 4-19mm) |
Cuerda invernadero negra | Cuerda ecológica.
Usos: amarre agrícola, industrial, marino, construcción, invernaderos.

─────────────────────────────────────────
4. Sacos de rafia
─────────────────────────────────────────
Tipos: Saco sin laminar (35-80cm, 49-115cm, 120-200kgf) |
Saco transparente | Saco ecológico.
Usos: granos, fertilizantes, construcción, alimentos a granel.

─────────────────────────────────────────
5. Arpillas
─────────────────────────────────────────
PP 100% virgen. Tipos: Arpilla circular (23-70cm, 4 colores, jareta) |
Arpilla monofilamento | Arpilla costura lateral | Arpilla etiqueta laminada.
Usos: horticultura, frutas, verduras, mariscos, granel.

─────────────────────────────────────────
6. Esquineros de cartón kraft
─────────────────────────────────────────
Tipos: Esquinero kraft café (pestaña 1.5", espesor 0.08", largo 11.81") |
Esquinero kraft blanco.
Usos: protección de bordes, transporte, almacenamiento, exportación.

─────────────────────────────────────────
7. Empaques flexibles
─────────────────────────────────────────
Impresión hasta 10 tintas, 133 líneas/pulgada.
Tipos: Bobina impresa (BOPP/BOPP·BOPP/PE·PET/PE, hasta 1,450mm) |
Bolsa stand up (zipper disponible) | Stand up pouch personalizado | Bolsa alto vacío.
Usos: alimentos, café, carnes, farmacéutica, cosmética.

══════════════════════════════════════════
  PREGUNTAS FRECUENTES
══════════════════════════════════════════
Envíos → Sí, toda la República y +30 países.
Pedidos mínimos → Sí, varían por producto.
Personalización → Sí, colores, medidas, calibres, impresión de marca.
Certificaciones → FSSC 22000, ISO 9001, AIB, Kosher Pareve.
Fabricantes → Sí, 17 plantas propias.
Distribuidores → Sí, programa activo. Contactar +52 443-207-2593.

══════════════════════════════════════════
  MÓDULO COTIZACIÓN / PRECIO / COMPRA
══════════════════════════════════════════
Si el usuario pregunta precio, costo, cotización, comprar, pedido, cuánto cuesta:
Responde: "¡Con gusto! Para una cotización exacta según tu volumen, escríbenos al WhatsApp +52 443-207-2593 — te respondemos rápido 😊"
Termina SIEMPRE con: [ACCION:WHATSAPP]

══════════════════════════════════════════
  MÓDULO PDF / CATÁLOGO / FICHA TÉCNICA
══════════════════════════════════════════
Si piden catálogo, ficha técnica, PDF, brochure:
Termina con: [ACCION:PDF:nombre]
Valores: rafia | stretch | cuerdas | sacos | arpillas | esquineros | flexible | general

══════════════════════════════════════════
  MÓDULO DE RECLUTAMIENTO
══════════════════════════════════════════
Si mencionan vacante, empleo, trabajo, CV, currículum:
PASO 1 → pedir tipo de puesto
PASO 2 → pedir nombre completo
PASO 3 → pedir correo
PASO 4 → pedir teléfono
PASO 5 → confirmar y agregar: [RECLUTAMIENTO:nombre=X|puesto=X|email=X|telefono=X]

══════════════════════════════════════════
  REGLAS FINALES
══════════════════════════════════════════
- Precio/stock/tiempos desconocidos → deriva al +52 443-207-2593
- Saludo cálido solo la PRIMERA vez.
- Si el tema no es Grupo Ortiz → redirige al catálogo o asesor.
`.trim();
}

// ─── Parser reclutamiento ─────────────────────────────────────────────────────
function parseRecruitment(text) {
  const match = text.match(/\[RECLUTAMIENTO\s*:\s*([^\]]+)\]/i);
  if (!match) return null;
  const result = {};
  match[1].split('|').forEach(pair => {
    const eq = pair.indexOf('=');
    if (eq > -1) {
      const key = pair.slice(0, eq).trim();
      const val = pair.slice(eq + 1).trim();
      if (key && val) result[key] = val;
    }
  });
  if (!result.nombre && !result.email && !result.telefono) return null;
  return result;
}

// ─── Extraer acciones del texto en español (fuente de verdad) ────────────────
function extractAcciones(text) {
  const accionWA    = /\[ACCION\s*:\s*WHATSAPP\s*\]/i.test(text);
  const matchPDF    = text.match(/\[ACCION\s*:\s*PDF\s*:\s*([\w-]+)\s*\]/i);
  const accionPDF   = matchPDF ? matchPDF[1].trim().toLowerCase() : null;
  const recruitData = parseRecruitment(text);
  const cleanText   = text
    .replace(/\[RECLUTAMIENTO\s*:[^\]]+\]/gi, '')
    .replace(/\[ACCION\s*:[^\]]+\]/gi, '')
    .replace(/https?:\/\/[^\s\)\]\,]+/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { cleanText, accionWA, accionPDF, recruitData };
}

// ─── Audio ────────────────────────────────────────────────────────────────────
function limpiarTextoParaAudio(texto) {
  if (!texto) return "";
  return texto
    .replace(/https?:\/\/[^\s\)\]\,]+/g, "")
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "")
    .replace(/\*\*/g,"").replace(/\*/g,"").replace(/#/g,"")
    .replace(/`/g,"").replace(/_/g,"")
    .replace(/👉|▶|🔗|📎|📄|📋/g,"")
    .replace(/^\s*[-•]\s+/gm,"")
    .replace(/\s{2,}/g," ").replace(/\n{3,}/g,"\n\n")
    .trim();
}

async function streamToBuffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', c => chunks.push(Buffer.from(c)));
    readable.on('end',  () => resolve(Buffer.concat(chunks)));
    readable.on('error', e => reject(e));
  });
}

async function generarAudio(texto, lang) {
  const clean = limpiarTextoParaAudio(texto);
  if (!clean) return null;
  const voice = VOICE_MAP[lang] || VOICE_MAP.es;
  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const stream = await Promise.race([
      tts.toStream(clean),
      new Promise((_,r) => setTimeout(() => r(new Error("TTS timeout")), 5000)),
    ]);
    const buf = await streamToBuffer(stream);
    return `data:audio/mp3;base64,${buf.toString("base64")}`;
  } catch {
    try {
      const results = await googleTTS.getAllAudioBase64(clean, {
        lang: lang||'es', slow:false,
        host:'https://translate.google.com', timeout:5000, splitPunct:'.,!?',
      });
      return `data:audio/mp3;base64,${Buffer.concat(results.map(r=>Buffer.from(r.base64,'base64'))).toString('base64')}`;
    } catch { return null; }
  }
}

// ─── Endpoint principal ───────────────────────────────────────────────────────
export async function POST({ request }) {
  const apiKey = import.meta.env.OPENAI_API_KEY;
  if (!apiKey) return new Response(
    JSON.stringify({ reply:"Error de configuración (API Key)." }), { status:500 }
  );

  try {
    const body = await request.json();
    const { messages, language, isVoice = false, sessionId = '' } = body;
    const targetLang = LANGUAGES_MAP[language] || 'Spanish';
    const langCode   = language || 'es';

    const cleanMessages = messages.map(m => ({ role:m.role, content:m.content }));
    const lastUserMsg   = [...cleanMessages].reverse().find(m => m.role==='user')?.content || '';
    const userMsgCount  = cleanMessages.filter(m => m.role==='user').length;

    // ── Analizar historial para dedup inteligente ─────────────────────────
    const { lastWAProduct, waEnviado, pdfEnviados } = analizarHistorial(cleanMessages);
    const productoActual = detectarProducto(lastUserMsg);
    const intentoCotizar = esIntencionCotizar(lastUserMsg);

    // ── Generar respuesta en español ──────────────────────────────────────
    const responseES = await fetch("https://api.openai.com/v1/chat/completions", {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role:"system", content:buildSystemPrompt('Spanish') },
          ...cleanMessages
        ],
        temperature: 0.65,
        max_tokens: 400,
      }),
    });
    const dataES = await responseES.json();
    if (dataES.error) throw new Error(`OpenAI: ${dataES.error.message}`);
    const rawReplyES = dataES.choices?.[0]?.message?.content || "Hola, ¿en qué puedo ayudarte?";

    // ── Extraer acciones del español ──────────────────────────────────────
    let { cleanText: textoESLimpio, accionWA, accionPDF, recruitData } = extractAcciones(rawReplyES);

    // ── WhatsApp: disparar SIEMPRE que el usuario pida cotización/compra ──
    // Si el modelo no lo incluyó pero el usuario claramente quiere comprar,
    // forzamos el botón aquí como red de seguridad.
    if (!accionWA && intentoCotizar) {
      accionWA = true;
    }

    // ── PDF: no reenviar el mismo PDF si ya fue enviado en esta sesión ────
    if (accionPDF && pdfEnviados.has(accionPDF)) {
      accionPDF = null;
    }

    // ── Traducir si no es español ─────────────────────────────────────────
    let replyText = textoESLimpio;
    if (langCode !== 'es') {
      const responseTrad = await fetch("https://api.openai.com/v1/chat/completions", {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `Eres un traductor profesional. Traduce el siguiente texto al ${targetLang} de forma natural y fluida, tono cálido y comercial. NO traduzcas: Grupo Ortiz, Valeria, BotGO, números de teléfono, términos técnicos de productos. Devuelve SOLO el texto traducido.`
            },
            { role: "user", content: textoESLimpio }
          ],
          temperature: 0.3,
          max_tokens: 400,
        }),
      });
      const dataTrad = await responseTrad.json();
      replyText = dataTrad.choices?.[0]?.message?.content?.trim() || textoESLimpio;
    }

    const accionReclutamiento = !!recruitData;

    // ── Analytics ─────────────────────────────────────────────────────────
    try {
      await logInteraction({
        userMessage:  lastUserMsg,
        botReply:     replyText,
        accionWA,
        accionPDF,
        language:     langCode,
        isNewSession: userMsgCount <= 1,
      });
    } catch (e) { console.warn('⚠️ analytics log error:', e.message); }

    // ── Guardar candidato ─────────────────────────────────────────────────
    if (accionReclutamiento && recruitData) {
      try {
        recruitData.mensaje   = lastUserMsg;
        recruitData.sessionId = sessionId;
        saveCandidate(recruitData);
      } catch (e) { console.warn('⚠️ recruitment save error:', e.message); }
    }

    // ── Audio ─────────────────────────────────────────────────────────────
    const audioUrl = isVoice ? await generarAudio(replyText, langCode) : null;

    return new Response(
      JSON.stringify({ reply: replyText, audio: audioUrl, accionWA, accionPDF, accionReclutamiento }),
      { status:200, headers:{ 'Content-Type':'application/json' } }
    );

  } catch (error) {
    console.error("❌ chat error:", error.message);
    return new Response(
      JSON.stringify({
        reply: "Disculpa, tuve un problema. Puedes contactarnos directo al +52 443-207-2593 por WhatsApp 😊",
        detail: error.message, audio:null, accionWA:false, accionPDF:null, accionReclutamiento:false
      }),
      { status:200 }
    );
  }
}