// src/lib/recruitment-db.js
// Mismo patrón que analytics-db.js — operaciones directas sin fetch interno

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ─── Ruta del JSON ─────────────────────────────────────────────────────────────
// En Vercel/serverless usa /tmp. En local/VPS usa data/ dentro del proyecto.
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
    const dir = DB_PATH.replace(/[^/\\]+$/, '');
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(DB_PATH, JSON.stringify(candidates, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('❌ recruitment-db write error:', e.message);
    return false;
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────

export function saveCandidate({ nombre = '', email = '', telefono = '', puesto = '', mensaje = '', sessionId = '' }) {
  const candidates = readCandidates();

  const candidate = {
    id:           `cand_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    nombre,
    email,
    telefono,
    puesto,
    mensaje,
    sessionId,
    estado:       'nuevo',   // nuevo | revisado | contactado | descartado
    ts:           new Date().toISOString(),
    tsFormatted:  new Date().toLocaleString('es-MX', {
      day: '2-digit', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }),
  };

  candidates.push(candidate);
  const ok = writeCandidates(candidates);
  if (ok) console.log(`✅ Candidato guardado: ${nombre} → ${puesto}`);
  return ok ? candidate : null;
}

export function getAllCandidates() {
  return readCandidates();
}

export function updateCandidateStatus(id, estado) {
  const valid = ['nuevo', 'revisado', 'contactado', 'descartado'];
  if (!valid.includes(estado)) return false;
  const candidates = readCandidates();
  const idx = candidates.findIndex(c => c.id === id);
  if (idx === -1) return false;
  candidates[idx].estado    = estado;
  candidates[idx].tsUpdated = new Date().toISOString();
  return writeCandidates(candidates);
}

export function deleteCandidate(id) {
  const candidates = readCandidates().filter(c => c.id !== id);
  return writeCandidates(candidates);
}

export function resetCandidates() {
  return writeCandidates([]);
}