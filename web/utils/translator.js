'use strict';

/**
 * Free translation providers only (no paid Google/Yandex/DeepL by default).
 * Priority:
 *  1) LibreTranslate — set LIBRETRANSLATE_URL (self-host = unlimited/free)
 *  2) MyMemory — free public API (quota; set TRANSLATE_EMAIL for higher free limit)
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const CACHE_MAX = 2000;
const translationCache = new Map();

const SUPPORTED = new Set(['ru', 'en', 'uk', 'be']);

function cacheGet(key) {
  if (!translationCache.has(key)) return undefined;
  const val = translationCache.get(key);
  // refresh LRU order
  translationCache.delete(key);
  translationCache.set(key, val);
  return val;
}

function cacheSet(key, val) {
  if (translationCache.has(key)) translationCache.delete(key);
  translationCache.set(key, val);
  while (translationCache.size > CACHE_MAX) {
    const oldest = translationCache.keys().next().value;
    translationCache.delete(oldest);
  }
}

function httpJson(method, urlStr, bodyObj, headers = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(e);
    }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = bodyObj == null ? null : Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...headers
      },
      timeout: 12000
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: raw ? JSON.parse(raw) : null, raw });
        } catch (e) {
          resolve({ status: res.statusCode, data: null, raw });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('translate timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function httpGetJson(urlStr) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(e);
    }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: { Accept: 'application/json' },
      timeout: 12000
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: raw ? JSON.parse(raw) : null });
        } catch (e) {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('translate timeout'));
    });
  });
}

async function translateViaLibre(text, targetLang, sourceLang) {
  const base = (process.env.LIBRETRANSLATE_URL || '').replace(/\/$/, '');
  if (!base) return null;
  const apiKey = process.env.LIBRETRANSLATE_API_KEY || '';
  const body = {
    q: text,
    source: sourceLang === 'auto' ? 'auto' : sourceLang,
    target: targetLang,
    format: 'text'
  };
  if (apiKey) body.api_key = apiKey;
  const res = await httpJson('POST', `${base}/translate`, body);
  if (res.status >= 200 && res.status < 300 && res.data && typeof res.data.translatedText === 'string') {
    return res.data.translatedText;
  }
  return null;
}

function isBadTranslation(out) {
  if (!out || typeof out !== 'string') return true;
  const t = out.trim();
  if (!t) return true;
  // MyMemory returns quota / error strings in translatedText instead of failing HTTP
  if (/^INVALID\b/i.test(t)) return true;
  if (/^PLEASE SELECT\b/i.test(t)) return true;
  if (/MYMEMORY\s+WARNING/i.test(t)) return true;
  if (/YOU USED ALL AVAILABLE FREE TRANSLATIONS/i.test(t)) return true;
  if (/QUERY LENGTH LIMIT EXCEEDED/i.test(t)) return true;
  if (/^\*\*\s*MYMEMORY/i.test(t)) return true;
  return false;
}

/** After quota exhaustion, skip MyMemory for a while to avoid spamming and caching garbage. */
let myMemoryCooldownUntil = 0;

async function translateViaMyMemory(text, targetLang, sourceLang) {
  if (Date.now() < myMemoryCooldownUntil) return null;

  // Free: 5k chars/day anonymous, 50k with email (TRANSLATE_EMAIL)
  const src = sourceLang === 'auto' ? 'ru' : sourceLang;
  const q = text.slice(0, 450); // API hard limit ~500 bytes
  const email = process.env.TRANSLATE_EMAIL || process.env.SMTP_USER || '';
  let url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${encodeURIComponent(src + '|' + targetLang)}`;
  if (email) url += `&de=${encodeURIComponent(email)}`;
  const res = await httpGetJson(url);
  if (res.data && res.data.responseData && typeof res.data.responseData.translatedText === 'string') {
    const out = res.data.responseData.translatedText;
    if (isBadTranslation(out)) {
      if (/MYMEMORY\s+WARNING|YOU USED ALL AVAILABLE FREE TRANSLATIONS/i.test(out)) {
        // Cool down ~2h (message usually says next available in ~N hours)
        myMemoryCooldownUntil = Date.now() + 2 * 60 * 60 * 1000;
        console.warn('[translate] MyMemory quota exhausted — falling back to original text');
      }
      return null;
    }
    // Also treat very low match quality as failure when responseStatus is not 200
    const status = res.data.responseStatus;
    if (status != null && Number(status) !== 200) return null;
    return out;
  }
  return null;
}

/**
 * @param {string} text
 * @param {string} targetLang  e.g. en, uk, be
 * @param {string} [sourceLang='auto']
 * @returns {Promise<string>}
 */
async function translateText(text, targetLang, sourceLang = 'auto') {
  if (!text || typeof text !== 'string') return text || '';
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (!SUPPORTED.has(targetLang)) return text;
  if (sourceLang !== 'auto' && sourceLang === targetLang) return text;

  const cacheKey = `${sourceLang}->${targetLang}:${trimmed}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) {
    // Drop previously cached quota/error strings
    if (isBadTranslation(cached) && cached !== trimmed) {
      translationCache.delete(cacheKey);
    } else {
      return cached;
    }
  }

  let translated = null;
  try {
    translated = await translateViaLibre(trimmed, targetLang, sourceLang);
  } catch (e) {
    console.warn('[translate] LibreTranslate failed:', e.message);
  }
  if (translated == null) {
    try {
      translated = await translateViaMyMemory(trimmed, targetLang, sourceLang);
    } catch (e) {
      console.warn('[translate] MyMemory failed:', e.message);
    }
  }

  // Never persist provider error banners as translations
  if (translated != null && isBadTranslation(translated)) translated = null;

  const result = (translated != null && translated !== '') ? translated : text;
  // Cache originals on failure so we don't re-hit quota for the same string
  cacheSet(cacheKey, result);
  return result;
}

/**
 * Translate many strings; returns array same length as input.
 */
async function translateMany(texts, targetLang, sourceLang = 'auto') {
  if (!Array.isArray(texts)) return [];
  const out = [];
  // sequential with small concurrency to respect free quotas
  const CONCURRENCY = 8;
  let i = 0;
  async function worker() {
    while (i < texts.length) {
      const idx = i++;
      out[idx] = await translateText(texts[idx], targetLang, sourceLang);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, () => worker()));
  return out;
}

function getProviderInfo() {
  if (process.env.LIBRETRANSLATE_URL) {
    return { provider: 'libretranslate', url: process.env.LIBRETRANSLATE_URL };
  }
  return { provider: 'mymemory', free: true };
}

module.exports = {
  translateText,
  translateMany,
  getProviderInfo,
  SUPPORTED
};
