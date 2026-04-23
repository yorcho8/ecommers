// src/pages/api/recruitment.js

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const prerender = false;

const DB_PATH = process.env.RECRUITMENT_DB_PATH
  || (process.env.VERCEL ? '/tmp/recruitment.json' : join(process.cwd(), 'data', 'recruitment.json'));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readCandidates() {
  try {
    if (!existsSync(DB_PATH)) return [];
    return JSON.parse(readFileSync(DB_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function writeCandidates(candidates) {
  try {
    // ✅ FIX: mkdirSync importado arriba, llamado síncronamente
    const dir = dirname(DB_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(DB_PATH, JSON.stringify(candidates, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('❌ recruitment write error:', e.message);
    return false;
  }
}

// ─── API ──────────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST({ request }) {
  try {
    const body = await request.json();
    const { action } = body;

    // ── Guardar candidato ────────────────────────────────────────────────────
    if (action === 'save') {
      const {
        nombre    = '',
        email     = '',
        telefono  = '',
        puesto    = '',
        mensaje   = '',
        sessionId = '',
      } = body;

      if (!nombre && !email && !telefono) {
        return json({ ok: false, error: 'Datos insuficientes' }, 400);
      }

      const candidates = readCandidates();
      const candidate = {
        id:          `cand_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        nombre,
        email,
        telefono,
        puesto,
        mensaje,
        sessionId,
        estado:      'nuevo',
        ts:          new Date().toISOString(),
        tsFormatted: new Date().toLocaleString('es-MX', {
          day: '2-digit', month: 'long', year: 'numeric',
          hour: '2-digit', minute: '2-digit',
        }),
      };

      candidates.push(candidate);
      const ok = writeCandidates(candidates);

      if (!ok) return json({ ok: false, error: 'No se pudo escribir el archivo' }, 500);
      console.log(`✅ Candidato guardado: ${nombre} → ${puesto}`);
      return json({ ok: true, id: candidate.id });
    }

    // ── Listar candidatos ────────────────────────────────────────────────────
    if (action === 'list') {
      return json({ ok: true, candidates: readCandidates() });
    }

    // ── Actualizar estado ────────────────────────────────────────────────────
    if (action === 'updateStatus') {
      const { id, estado } = body;
      const valid = ['nuevo', 'revisado', 'contactado', 'descartado'];
      if (!valid.includes(estado)) return json({ ok: false, error: 'Estado inválido' }, 400);

      const candidates = readCandidates();
      const idx = candidates.findIndex(c => c.id === id);
      if (idx === -1) return json({ ok: false, error: 'Candidato no encontrado' }, 404);

      candidates[idx].estado    = estado;
      candidates[idx].tsUpdated = new Date().toISOString();
      writeCandidates(candidates);
      return json({ ok: true });
    }

    // ── Eliminar candidato ───────────────────────────────────────────────────
    if (action === 'delete') {
      const candidates = readCandidates().filter(c => c.id !== body.id);
      writeCandidates(candidates);
      return json({ ok: true });
    }

    // ── Reset total ──────────────────────────────────────────────────────────
    if (action === 'reset') {
      writeCandidates([]);
      return json({ ok: true });
    }

    return json({ ok: false, error: 'Acción desconocida' }, 400);

  } catch (err) {
    console.error('❌ recruitment endpoint:', err.message);
    return json({ ok: false, error: err.message }, 500);
  }
}

export async function GET() {
  try {
    return json({ ok: true, candidates: readCandidates() });
  } catch (err) {
    return json({ ok: false, error: err.message }, 500);
  }
}