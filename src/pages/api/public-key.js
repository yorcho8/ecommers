// src/pages/api/public-key.js
import { getPublicKey } from '../../lib/crypto';

export async function GET() {
  try {
    const publicKey = getPublicKey();

    return new Response(JSON.stringify({ publicKey }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (error) {
    console.error('[api/public-key] Error:', error);
    return new Response(JSON.stringify({ error: 'Error al obtener llave pública' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}