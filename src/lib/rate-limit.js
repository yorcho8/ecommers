// src/lib/rate-limit.js

var attempts = new Map();
var MAX_ATTEMPTS = 6;
var BLOCK_DURATION = 15 * 60 * 1000;
var WINDOW = 10 * 60 * 1000;
var lastCleanup = Date.now();
var distributedBuckets = new Map();

// ── Generic multi-bucket store for other endpoints ────────────────────────
// Keys are namespaced: "register:<ip>", "payment:<ip>", etc.
var genericBuckets = new Map();

var UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || import.meta.env?.UPSTASH_REDIS_REST_URL || '';
var UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || import.meta.env?.UPSTASH_REDIS_REST_TOKEN || '';

function hasRedisBackend() {
  return !!UPSTASH_URL && !!UPSTASH_TOKEN;
}

async function redisCommand(parts) {
  if (!hasRedisBackend()) return null;
  try {
    var url = UPSTASH_URL.replace(/\/+$/, '') + '/' + parts.map(function (p) {
      return encodeURIComponent(String(p));
    }).join('/');

    var res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + UPSTASH_TOKEN,
      },
    });

    if (!res.ok) return null;
    var data = await res.json().catch(function () { return null; });
    if (!data || typeof data !== 'object') return null;
    return data.result;
  } catch {
    return null;
  }
}

function fallbackKey(namespace, key) {
  return String(namespace || '') + ':' + String(key || '');
}

function fallbackNow() {
  return Date.now();
}

function fallbackGetOrCreateBucket(namespace, key, windowMs, blockMs) {
  var k = fallbackKey(namespace, key);
  var now = fallbackNow();
  var entry = distributedBuckets.get(k);

  if (!entry || now - entry.firstAttempt > windowMs) {
    entry = { count: 0, firstAttempt: now, blockedUntil: null, windowMs: windowMs, blockMs: blockMs };
    distributedBuckets.set(k, entry);
  }

  return entry;
}

function cleanup() {
  var now = Date.now();
  if (now - lastCleanup < 60000) return;
  lastCleanup = now;
  attempts.forEach(function(val, key) {
    if (now - val.firstAttempt > WINDOW + BLOCK_DURATION) {
      attempts.delete(key);
    }
  });
  // Also clean generic buckets
  genericBuckets.forEach(function(val, key) {
    if (now - val.firstAttempt > val.window + val.blockMs) {
      genericBuckets.delete(key);
    }
  });
}

export function getClientIp(request) {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    '127.0.0.1'
  );
}

export function isBlocked(ip) {
  cleanup();
  var entry = attempts.get(ip);
  if (!entry) return { blocked: false, retryAfter: 0 };
  var now = Date.now();
  if (entry.blockedUntil && now < entry.blockedUntil) {
    return { blocked: true, retryAfter: Math.ceil((entry.blockedUntil - now) / 1000) };
  }
  if (entry.blockedUntil && now >= entry.blockedUntil) {
    attempts.delete(ip);
    return { blocked: false, retryAfter: 0 };
  }
  if (now - entry.firstAttempt > WINDOW) {
    attempts.delete(ip);
    return { blocked: false, retryAfter: 0 };
  }
  return { blocked: false, retryAfter: 0 };
}

export function recordFailedAttempt(ip) {
  var now = Date.now();
  var entry = attempts.get(ip);
  if (!entry || now - entry.firstAttempt > WINDOW) {
    attempts.set(ip, { count: 1, firstAttempt: now, blockedUntil: null });
    return;
  }
  entry.count++;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.blockedUntil = now + BLOCK_DURATION;
  }
}

export function clearAttempts(ip) {
  attempts.delete(ip);
}

/**
 * Return the current failed-attempt count for an IP (0 if none or expired).
 * Used by login.js to decide whether to require a CAPTCHA challenge.
 */
export function getAttemptCount(ip) {
  const entry = attempts.get(ip);
  if (!entry) return 0;
  if (Date.now() - entry.firstAttempt > WINDOW) return 0;
  return entry.count || 0;
}

/**
 * Generic rate limiter for any endpoint.
 * @param {string} namespace - e.g. 'register', 'payment', 'kyc'
 * @param {string} key       - typically the client IP
 * @param {{ maxRequests?: number, windowMs?: number, blockMs?: number }} opts
 * @returns {{ limited: boolean, retryAfter: number }}
 */
export function checkRateLimit(namespace, key, opts) {
  cleanup();
  var maxReqs  = (opts && opts.maxRequests)  || 10;
  var windowMs = (opts && opts.windowMs)     || 15 * 60 * 1000;
  var blockMs  = (opts && opts.blockMs)      || 15 * 60 * 1000;
  var bucketKey = namespace + ':' + key;
  var now = Date.now();
  var entry = genericBuckets.get(bucketKey);

  if (!entry || now - entry.firstAttempt > windowMs) {
    genericBuckets.set(bucketKey, { count: 1, firstAttempt: now, blockedUntil: null, window: windowMs, blockMs });
    return { limited: false, retryAfter: 0 };
  }

  if (entry.blockedUntil && now < entry.blockedUntil) {
    return { limited: true, retryAfter: Math.ceil((entry.blockedUntil - now) / 1000) };
  }
  if (entry.blockedUntil && now >= entry.blockedUntil) {
    genericBuckets.delete(bucketKey);
    return { limited: false, retryAfter: 0 };
  }

  entry.count++;
  if (entry.count > maxReqs) {
    entry.blockedUntil = now + blockMs;
    return { limited: true, retryAfter: Math.ceil(blockMs / 1000) };
  }
  return { limited: false, retryAfter: 0 };
}

export async function checkRateLimitDistributed(namespace, key, opts) {
  var maxReqs = (opts && opts.maxRequests) || 10;
  var windowMs = (opts && opts.windowMs) || 15 * 60 * 1000;
  var blockMs = (opts && opts.blockMs) || 15 * 60 * 1000;
  var windowSec = Math.ceil(windowMs / 1000);
  var blockSec = Math.ceil(blockMs / 1000);
  var countKey = 'rl:' + namespace + ':' + key + ':count';
  var blockKey = 'rl:' + namespace + ':' + key + ':block';

  if (!hasRedisBackend()) {
    return checkRateLimit(namespace, key, opts);
  }

  var blockedVal = await redisCommand(['GET', blockKey]);
  if (blockedVal !== null) {
    var blockTtl = await redisCommand(['TTL', blockKey]);
    return { limited: true, retryAfter: Math.max(1, Number(blockTtl || blockSec)) };
  }

  var count = Number(await redisCommand(['INCR', countKey]) || 0);
  if (count === 1) {
    await redisCommand(['EXPIRE', countKey, windowSec]);
  }

  if (count > maxReqs) {
    await redisCommand(['SETEX', blockKey, blockSec, 1]);
    return { limited: true, retryAfter: blockSec };
  }

  return { limited: false, retryAfter: 0 };
}

export async function isBlockedDistributed(namespace, key, opts) {
  var blockMs = (opts && opts.blockMs) || 15 * 60 * 1000;
  var blockSec = Math.ceil(blockMs / 1000);
  var blockKey = 'rl:' + namespace + ':' + key + ':block';

  if (!hasRedisBackend()) {
    var entry = fallbackGetOrCreateBucket(namespace, key, WINDOW, blockMs);
    var now = fallbackNow();
    if (entry.blockedUntil && now < entry.blockedUntil) {
      return { blocked: true, retryAfter: Math.ceil((entry.blockedUntil - now) / 1000) };
    }
    if (entry.blockedUntil && now >= entry.blockedUntil) {
      entry.blockedUntil = null;
      entry.count = 0;
      entry.firstAttempt = now;
    }
    return { blocked: false, retryAfter: 0 };
  }

  var blockedVal = await redisCommand(['GET', blockKey]);
  if (blockedVal === null) return { blocked: false, retryAfter: 0 };
  var ttl = Number(await redisCommand(['TTL', blockKey]) || blockSec);
  return { blocked: true, retryAfter: Math.max(1, ttl) };
}

export async function recordFailedAttemptDistributed(namespace, key, opts) {
  var maxAttempts = (opts && opts.maxAttempts) || MAX_ATTEMPTS;
  var windowMs = (opts && opts.windowMs) || WINDOW;
  var blockMs = (opts && opts.blockMs) || BLOCK_DURATION;
  var windowSec = Math.ceil(windowMs / 1000);
  var blockSec = Math.ceil(blockMs / 1000);
  var countKey = 'rl:' + namespace + ':' + key + ':count';
  var blockKey = 'rl:' + namespace + ':' + key + ':block';

  if (!hasRedisBackend()) {
    var entry = fallbackGetOrCreateBucket(namespace, key, windowMs, blockMs);
    var now = fallbackNow();
    entry.count = Number(entry.count || 0) + 1;
    if (entry.count >= maxAttempts) {
      entry.blockedUntil = now + blockMs;
    }
    return;
  }

  var count = Number(await redisCommand(['INCR', countKey]) || 0);
  if (count === 1) {
    await redisCommand(['EXPIRE', countKey, windowSec]);
  }
  if (count >= maxAttempts) {
    await redisCommand(['SETEX', blockKey, blockSec, 1]);
  }
}

export async function clearAttemptsDistributed(namespace, key) {
  var countKey = 'rl:' + namespace + ':' + key + ':count';
  var blockKey = 'rl:' + namespace + ':' + key + ':block';

  if (!hasRedisBackend()) {
    distributedBuckets.delete(fallbackKey(namespace, key));
    return;
  }

  await redisCommand(['DEL', countKey]);
  await redisCommand(['DEL', blockKey]);
}

export async function getAttemptCountDistributed(namespace, key, opts) {
  var windowMs = (opts && opts.windowMs) || WINDOW;
  var countKey = 'rl:' + namespace + ':' + key + ':count';

  if (!hasRedisBackend()) {
    var entry = fallbackGetOrCreateBucket(namespace, key, windowMs, BLOCK_DURATION);
    var now = fallbackNow();
    if (now - entry.firstAttempt > windowMs) {
      entry.count = 0;
      entry.firstAttempt = now;
    }
    return Number(entry.count || 0);
  }

  var count = await redisCommand(['GET', countKey]);
  return Number(count || 0);
}