const crypto = require('crypto');

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseBasicAuth(header) {
  if (!header || typeof header !== 'string') return null;
  const m = header.match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  try {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch (_) {
    return null;
  }
}

function normalizeIp(ip) {
  if (!ip || typeof ip !== 'string') return '';
  let cleaned = ip;
  if (cleaned.includes(',')) {
    // Prefer last hop (closest to our edge) — first hop is client-spoofable
    const parts = cleaned.split(',').map((s) => s.trim()).filter(Boolean);
    cleaned = parts.length ? parts[parts.length - 1] : '';
  }
  if (cleaned.startsWith('::ffff:')) cleaned = cleaned.slice(7);
  return cleaned;
}

function isPrivateOrLanIp(ip) {
  const cleaned = normalizeIp(ip);
  if (!cleaned) return false;
  if (cleaned === '127.0.0.1' || cleaned === '::1' || cleaned === 'localhost') return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleaned)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(cleaned)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(cleaned)) return true;
  // Unique-local IPv6
  if (/^f[cd][0-9a-f]{2}:/i.test(cleaned)) return true;
  return false;
}

function requestIp(req) {
  const rawIp = req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || '';
  return normalizeIp(rawIp);
}

/** Header/query/basic RTMP hooks only from private/LAN or RTMP_HOOK_ALLOWLIST. */
function isInternalAuthIpAllowed(req) {
  const ip = requestIp(req);
  if (isPrivateOrLanIp(ip)) return true;
  const allowlist = String(process.env.RTMP_HOOK_ALLOWLIST || '')
    .split(',')
    .map((s) => normalizeIp(s.trim()))
    .filter(Boolean);
  return allowlist.includes(ip);
}

/**
 * Protect /api/internal/rtmp/* so only MediaMTX/hooks with shared credentials can call them.
 * Accepts (any one), and always requires allowed source IP:
 *  - HTTP Basic matching RTMP_API_USER / RTMP_API_PASS
 *  - Header X-RTMP-Internal matching RTMP_API_PASS
 *  - Query ?internal= matching RTMP_API_PASS (for MediaMTX authHTTPAddress)
 */
function requireRtmpInternalAuth(req, res, next) {
  const expectedUser = process.env.RTMP_API_USER || '';
  const expectedPass = process.env.RTMP_API_PASS || '';

  if (!expectedPass) {
    console.error('[RTMP Internal Auth] RTMP_API_PASS is not configured — rejecting request');
    return res.status(503).json({ error: 'RTMP internal auth not configured' });
  }

  if (!isInternalAuthIpAllowed(req)) {
    console.warn(`[RTMP Internal Auth] Rejected from public IP ${requestIp(req) || req.ip} for ${req.method} ${req.path}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const headerSecret = req.get('x-rtmp-internal') || '';
  if (headerSecret && timingSafeEqualStr(headerSecret, expectedPass)) {
    return next();
  }

  const querySecret = typeof req.query.internal === 'string' ? req.query.internal : '';
  if (querySecret && timingSafeEqualStr(querySecret, expectedPass)) {
    return next();
  }

  const basic = parseBasicAuth(req.get('authorization'));
  if (
    basic &&
    timingSafeEqualStr(basic.user, expectedUser) &&
    timingSafeEqualStr(basic.pass, expectedPass)
  ) {
    return next();
  }

  console.warn(`[RTMP Internal Auth] Unauthorized ${req.method} ${req.path} from ${req.ip}`);
  return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { requireRtmpInternalAuth };
