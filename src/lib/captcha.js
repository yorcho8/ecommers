// src/lib/captcha.js
// Cloudflare Turnstile server-side token validation.
// Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
//
// Configure:
//   TURNSTILE_SECRET_KEY = <your Turnstile secret key>
//   TURNSTILE_SITE_KEY   = <your Turnstile site key> (used by the frontend widget)
//
// If TURNSTILE_SECRET_KEY is not set, captcha validation is SKIPPED (dev/test mode).

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Validate a Cloudflare Turnstile captcha token server-side.
 * Fails OPEN on network errors so captcha outages don't block users.
 *
 * @param {string|null|undefined} token - The cf-turnstile-response value from the client
 * @param {string} [ip] - Client IP for additional binding (optional)
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function validateCaptcha(token, ip) {
  const secret =
    process.env.TURNSTILE_SECRET_KEY ||
    import.meta.env?.TURNSTILE_SECRET_KEY ||
    '';

  // If secret not configured → skip validation (dev/CI mode)
  if (!secret) return { valid: true, reason: 'captcha_disabled' };

  if (!token) return { valid: false, reason: 'missing_token' };

  try {
    const body = new URLSearchParams({
      secret: String(secret),
      response: String(token),
    });
    if (ip) body.set('remoteip', String(ip));

    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      // Turnstile API itself failed → fail open
      console.warn('[captcha] Turnstile verify endpoint returned', res.status);
      return { valid: true, reason: 'verify_request_failed' };
    }

    const data = await res.json();
    return data.success === true
      ? { valid: true }
      : { valid: false, reason: (data['error-codes'] || []).join(',') || 'invalid_token' };
  } catch (err) {
    // Network timeout or other error → fail open
    console.warn('[captcha] Turnstile verify timeout/error:', err?.message);
    return { valid: true, reason: 'captcha_verify_timeout' };
  }
}

/**
 * Returns true only if captcha checking is actively enabled (secret key is set).
 */
export function isCaptchaEnabled() {
  const secret =
    process.env.TURNSTILE_SECRET_KEY ||
    import.meta.env?.TURNSTILE_SECRET_KEY ||
    '';
  return Boolean(secret);
}
