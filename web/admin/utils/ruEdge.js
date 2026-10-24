'use strict';

const http = require('http');
const geoip = require('geoip-lite');

const RU_EDGE_IP = process.env.RU_EDGE_IP || '127.0.0.1';
const RU_EDGE_HOST = process.env.RU_EDGE_HOST || '';
const RU_HEALTH_PATH = process.env.RU_EDGE_HEALTH_PATH || '/healthz';
const MAIN_REDIRECT_HOSTS = new Set();
try {
  if (process.env.APP_URL) MAIN_REDIRECT_HOSTS.add(new URL(process.env.APP_URL).hostname.toLowerCase());
} catch (_) {}
const PROBE_INTERVAL_MS = Number(process.env.RU_EDGE_PROBE_MS || 15000);
const PROBE_TIMEOUT_MS = Number(process.env.RU_EDGE_PROBE_TIMEOUT_MS || 2500);
const FAIL_THRESHOLD = Number(process.env.RU_EDGE_FAIL_THRESHOLD || 2);

let ruEdgeHealthy = false;
let failStreak = 0;
let probeTimer = null;
let lastProbeAt = 0;
let lastProbeError = '';

function isRuHost(host) {
  const h = String(host || '').split(':')[0].toLowerCase();
  return (RU_EDGE_HOST && h === RU_EDGE_HOST.toLowerCase()) || h.startsWith('ru.');
}

function rewriteToRuEdge(url) {
  if (!url || !RU_EDGE_HOST) return url;
  try {
    const parsed = new URL(url);
    if (MAIN_REDIRECT_HOSTS.has(parsed.hostname.toLowerCase())) {
      parsed.host = RU_EDGE_HOST;
      return parsed.toString();
    }
  } catch (_) {}
  return url;
}

function edgeUrlsForHost(host) {
  const onRu = isRuHost(host);
  const map = (u) => (onRu ? rewriteToRuEdge(u) : u);
  return {
    onRu,
    host: String(host || '').split(':')[0].toLowerCase(),
    CDN_BASE_URL: map(process.env.CDN_BASE_URL || ''),
    APP_URL: map(process.env.APP_URL || ''),
    ADMIN_URL: map(process.env.ADMIN_URL || ''),
    RTMP_STREAM_URL: map(process.env.RTMP_STREAM_URL || 'https://kctv.localhost/live'),
  };
}

function edgeUrlsForRequest(req) {
  return edgeUrlsForHost(req.headers && req.headers.host);
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return (req.ip || req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function clientCountry(req) {
  const cf = String(req.headers['cf-ipcountry'] || '').toUpperCase();
  if (cf && cf !== 'XX' && cf !== 'T1') return cf;
  const geo = geoip.lookup(clientIp(req));
  return geo && geo.country ? String(geo.country).toUpperCase() : '';
}

function isRuEdgeHealthy() {
  return ruEdgeHealthy;
}

function getRuEdgeStatus() {
  return {
    healthy: ruEdgeHealthy,
    failStreak,
    lastProbeAt,
    lastProbeError,
    edgeIp: RU_EDGE_IP,
    edgeHost: RU_EDGE_HOST,
  };
}

function probeRuEdge() {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: RU_EDGE_IP,
        port: 80,
        path: RU_HEALTH_PATH,
        method: 'GET',
        headers: { Host: RU_EDGE_HOST, Connection: 'close' },
        timeout: PROBE_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        lastProbeAt = Date.now();
        if (ok) {
          failStreak = 0;
          ruEdgeHealthy = true;
          lastProbeError = '';
        } else {
          failStreak += 1;
          lastProbeError = `status ${res.statusCode}`;
          if (failStreak >= FAIL_THRESHOLD) ruEdgeHealthy = false;
        }
        resolve(ruEdgeHealthy);
      }
    );
    req.on('timeout', () => {
      req.destroy();
    });
    req.on('error', (err) => {
      lastProbeAt = Date.now();
      failStreak += 1;
      lastProbeError = err && err.message ? err.message : 'probe error';
      if (failStreak >= FAIL_THRESHOLD) ruEdgeHealthy = false;
      resolve(ruEdgeHealthy);
    });
    req.end();
  });
}

function startRuEdgeHealthProbe() {
  if (probeTimer || !RU_EDGE_HOST) return;
  probeRuEdge().catch(() => {});
  probeTimer = setInterval(() => {
    probeRuEdge().catch(() => {});
  }, PROBE_INTERVAL_MS);
  if (typeof probeTimer.unref === 'function') probeTimer.unref();
}

/**
 * RU clients use the configured regional host only while its health check succeeds.
 * 302 (not 301) so browsers retry main when the edge is down.
 */
function ruEdgeRedirectMiddleware(req, res, next) {
  if (!RU_EDGE_HOST) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/internal/')) return next();
  if (req.path === '/healthz' || req.path === '/api/ru-edge-status') return next();

  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (!MAIN_REDIRECT_HOSTS.has(host)) return next();
  if (isRuHost(host)) return next();
  if (!ruEdgeHealthy) return next();
  if (clientCountry(req) !== 'RU') return next();

  const target = 'https://' + RU_EDGE_HOST + (req.originalUrl || '/');
  return res.redirect(302, target);
}

module.exports = {
  isRuHost,
  rewriteToRuEdge,
  edgeUrlsForHost,
  edgeUrlsForRequest,
  clientIp,
  clientCountry,
  isRuEdgeHealthy,
  getRuEdgeStatus,
  probeRuEdge,
  startRuEdgeHealthProbe,
  ruEdgeRedirectMiddleware,
};
