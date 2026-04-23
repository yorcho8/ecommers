// src/pages/api/logout.js
import { SESSION_COOKIE } from '../../lib/session';

const COOKIE_CLEAR = [
  `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
  `authSession=; Path=/; Max-Age=0; SameSite=Lax`,
];

export async function POST() {
  return new Response(
    JSON.stringify({ success: true }),
    {
      status: 200,
      // ✅ Pasar headers como array de pares — garantiza múltiples Set-Cookie
      headers: [
        ['Content-Type', 'application/json'],
        ['Set-Cookie', COOKIE_CLEAR[0]],
        ['Set-Cookie', COOKIE_CLEAR[1]],
      ],
    }
  );
}

export async function GET() {
  return new Response(null, {
    status: 302,
    headers: [
      ['Location', '/es/login'],
      ['Set-Cookie', COOKIE_CLEAR[0]],
      ['Set-Cookie', COOKIE_CLEAR[1]],
    ],
  });
}