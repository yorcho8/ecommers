// src/lib/totp.js
// TOTP implementation — RFC 6238 (HMAC-SHA1, 30-second window, 6-digit codes)
// No external dependencies — pure Node.js crypto.
import { createHmac, randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';

// ── Base32 (RFC 4648) ─────────────────────────────────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (let i = 0; i < buf.length; i++) {
    val = (val << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const s = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0;
  const bytes = [];
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((val >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ── HOTP core ─────────────────────────────────────────────────────────────────
function hotp(secret, counter) {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  let c = BigInt(Math.floor(counter));
  for (let i = 7; i >= 0; i--) {
    msg[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[19] & 0x0f;
  const code =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

// ── AES-256-GCM helpers for encrypting TOTP secrets at rest ──────────────────
function getTotpEncryptionKey() {
  const raw =
    process.env.TOTP_AES_KEY ||
    process.env.BIOMETRIC_AES_KEY ||
    import.meta.env?.TOTP_AES_KEY ||
    import.meta.env?.BIOMETRIC_AES_KEY ||
    '';
  const safe = String(raw || '').trim();
  if (!safe) return null;
  try {
    const b = Buffer.from(safe, 'base64');
    if (b.length === 32) return b;
  } catch { /* fallthrough */ }
  return createHash('sha256').update(safe).digest();
}

function encryptSecret(plaintext) {
  const key = getTotpEncryptionKey();
  if (!key) return plaintext; // fallback: store as-is with a warning
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${enc.toString('base64')}:${iv.toString('base64')}:${tag.toString('base64')}`;
}

function decryptSecret(stored) {
  if (!String(stored).startsWith('enc:')) return stored; // legacy / unencrypted
  const key = getTotpEncryptionKey();
  if (!key) return stored.replace(/^enc:[^:]+:[^:]+:[^:]+$/, ''); // can't decrypt
  const [, encB64, ivB64, tagB64] = stored.split(':');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Generate a new cryptographically random TOTP secret (Base32, 20 bytes). */
export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

/**
 * Build an otpauth:// URI suitable for QR code generation.
 * @param {string} secret Base32 secret
 * @param {string} accountEmail User email (shown in authenticator app)
 * @param {string} [issuer] App name (default 'NEXUS')
 */
export function getTotpUri(secret, accountEmail, issuer = 'NEXUS') {
  const e = encodeURIComponent;
  return `otpauth://totp/${e(issuer)}:${e(accountEmail)}?secret=${secret}&issuer=${e(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/**
 * Verify a 6-digit TOTP code. Allows ±1 time-step window for clock drift.
 * Uses timing-safe comparison.
 */
export function verifyTotpCode(rawSecret, code, nowMs = Date.now()) {
  const secret = decryptSecret(String(rawSecret));
  const normalized = String(code || '').replace(/\s/g, '').padStart(6, '0');
  const step = Math.floor(nowMs / 1000 / 30);
  for (let d = -1; d <= 1; d++) {
    const expected = Buffer.from(hotp(secret, step + d));
    const provided = Buffer.from(normalized);
    if (
      expected.length === provided.length &&
      timingSafeEqual(expected, provided)
    ) return true;
  }
  return false;
}

/**
 * Encrypt a TOTP secret before storing in DB.
 * Returns the raw secret if encryption key is not configured.
 */
export function encryptTotpSecret(secret) {
  if (!getTotpEncryptionKey()) {
    console.warn('[totp] TOTP_AES_KEY not set — TOTP secret stored as plaintext.');
  }
  return encryptSecret(secret);
}

/**
 * Decrypt a TOTP secret retrieved from DB.
 */
export function decryptTotpSecret(stored) {
  return decryptSecret(stored);
}

/**
 * Hash a backup code for safe storage (SHA-256, single-use codes are high-entropy).
 */
export function hashBackupCode(code) {
  return createHash('sha256').update(String(code)).digest('hex');
}

/**
 * Generate n random backup codes formatted as XXXXXX-XXXXXX (uppercase hex).
 */
export function generateBackupCodes(n = 10) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const a = randomBytes(3).toString('hex').toUpperCase();
    const b = randomBytes(3).toString('hex').toUpperCase();
    codes.push(`${a}-${b}`);
  }
  return codes;
}
