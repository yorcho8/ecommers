// src/lib/pwned.js
// HaveIBeenPwned k-anonymity password breach check.
// RFC: https://haveibeenpwned.com/API/v3#SearchingPwnedPasswordsByRange
// Only the first 5 hex chars of the SHA-1 are sent — the full hash never leaves the server.
import { createHash } from 'node:crypto';

/**
 * Check whether a plaintext password appears in known breach datasets.
 * Fails OPEN on any network error so registration is never blocked by an API outage.
 *
 * @param {string} password - Plaintext password to check
 * @returns {Promise<{pwned: boolean, count: number}>}
 */
export async function checkPwnedPassword(password) {
  try {
    const sha1 = createHash('sha1')
      .update(String(password))
      .digest('hex')
      .toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const res = await fetch(
      `https://api.pwnedpasswords.com/range/${prefix}`,
      {
        headers: {
          'Add-Padding': 'true', // prevents traffic analysis
          'User-Agent': 'NEXUS-Ecommerce-SecurityCheck/1.0',
        },
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!res.ok) return { pwned: false, count: 0 }; // fail open

    const text = await res.text();
    for (const line of text.split('\n')) {
      const [hash, countStr] = line.trim().split(':');
      if (hash === suffix) {
        return { pwned: true, count: Number(countStr) || 1 };
      }
    }

    return { pwned: false, count: 0 };
  } catch {
    return { pwned: false, count: 0 }; // fail open on timeout/network error
  }
}
