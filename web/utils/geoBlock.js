'use strict';

/** Lazy: admin panel does not ship geoip-lite / may not need ruEdge at all. */
function getRuEdgeHelpers() {
  try {
    return require('./ruEdge');
  } catch (_) {
    return {
      clientIp: () => '',
      clientCountry: () => ''
    };
  }
}

const { GEO_COUNTRY_OPTIONS } = require('./geoCountriesRu');

const GEO_COUNTRY_NAME_BY_CODE = GEO_COUNTRY_OPTIONS.reduce((acc, row) => {
  acc[row.code] = row.name;
  return acc;
}, {});

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_MAX = 10000;
/** @type {Map<string, { country: string, expires: number }>} */
const ipCountryCache = new Map();

function isStaffUser(user) {
  if (!user) return false;
  if (user.is_superadmin) return true;
  const role = String(user.staff_role || '').toLowerCase();
  return role === 'admin' || role === 'moderator' || role === 'mod';
}

/**
 * Normalize CSV / array of ISO-3166-1 alpha-2 codes → "RU,BY" or null.
 */
function normalizeCountryList(raw) {
  if (raw == null || raw === '') return null;
  let parts;
  if (Array.isArray(raw)) {
    parts = raw.map((s) => String(s).trim().toUpperCase());
  } else {
    parts = String(raw)
      .split(/[,;\s]+/)
      .map((s) => s.trim().toUpperCase());
  }
  parts = parts.filter((s) => /^[A-Z]{2}$/.test(s));
  if (!parts.length) return null;
  return [...new Set(parts)].join(',');
}

function parseCountryList(str) {
  if (!str) return [];
  return String(str)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z]{2}$/.test(s));
}

function countryLabel(code) {
  const c = String(code || '').toUpperCase();
  return GEO_COUNTRY_NAME_BY_CODE[c] || c;
}

/** Human labels for CSV, e.g. "Россия, Беларусь". */
function formatCountryListLabels(str) {
  return parseCountryList(str).map(countryLabel).join(', ');
}

/** Add codes to existing CSV; returns new CSV or null. */
function mergeCountryLists(existingCsv, addRaw) {
  const set = new Set(parseCountryList(existingCsv));
  parseCountryList(normalizeCountryList(addRaw) || '').forEach((c) => set.add(c));
  if (!set.size) return null;
  return [...set].join(',');
}

/** Remove one code from CSV; returns new CSV or null. */
function removeCountryFromList(existingCsv, code) {
  const c = String(code || '').trim().toUpperCase();
  const next = parseCountryList(existingCsv).filter((x) => x !== c);
  return next.length ? next.join(',') : null;
}

function countryFromIpCached(ip) {
  if (!ip) return '';
  const now = Date.now();
  const hit = ipCountryCache.get(ip);
  if (hit && hit.expires > now) return hit.country;

  let country = '';
  try {
    const geoip = require('geoip-lite');
    const geo = geoip.lookup(ip);
    country = geo && geo.country ? String(geo.country).toUpperCase() : '';
  } catch (_) {
    country = '';
  }

  if (ipCountryCache.size >= CACHE_MAX) {
    const firstKey = ipCountryCache.keys().next().value;
    ipCountryCache.delete(firstKey);
  }
  ipCountryCache.set(ip, { country, expires: now + CACHE_TTL_MS });
  return country;
}

/**
 * Resolve viewer country: CF-IPCountry first, then cached geoip-lite for client IP.
 */
function getRequestCountry(req) {
  if (!req) return '';
  try {
    const cf = String(req.headers['cf-ipcountry'] || '').toUpperCase();
    if (cf && cf !== 'XX' && cf !== 'T1') return cf;

    const helpers = getRuEdgeHelpers();
    const ipFn = typeof helpers.clientIp === 'function' ? helpers.clientIp : null;
    const countryFn = typeof helpers.clientCountry === 'function' ? helpers.clientCountry : null;
    const ip = ipFn ? ipFn(req) : '';
    if (!ip) return (countryFn && countryFn(req)) || '';

    const now = Date.now();
    const hit = ipCountryCache.get(ip);
    if (hit && hit.expires > now) return hit.country;

    const country = (countryFn && countryFn(req)) || countryFromIpCached(ip);
    if (ipCountryCache.size >= CACHE_MAX) {
      const firstKey = ipCountryCache.keys().next().value;
      ipCountryCache.delete(firstKey);
    }
    ipCountryCache.set(ip, { country, expires: now + CACHE_TTL_MS });
    return country;
  } catch (_) {
    return '';
  }
}

function listIncludesCountry(listStr, country) {
  if (!country) return false;
  const list = parseCountryList(listStr);
  return list.includes(String(country).toUpperCase());
}

/**
 * True when viewer country is in channel and/or record denylist (staff never blocked).
 * Fail-closed: if a denylist is configured and country cannot be resolved → block.
 */
function isGeoBlockedForRequest({ channelCountries, recordCountries, req, isStaff }) {
  if (isStaff) return false;
  const hasDenylist =
    parseCountryList(channelCountries).length > 0 ||
    parseCountryList(recordCountries).length > 0;
  if (!hasDenylist) return false;

  const country = req && req.viewerCountry != null
    ? req.viewerCountry
    : getRequestCountry(req);
  if (!country) return true;
  return (
    listIncludesCountry(channelCountries, country) ||
    listIncludesCountry(recordCountries, country)
  );
}

/** Convenience: channel geo-block for current request (respects staff bypass). */
function shouldBlockChannel(req, channel) {
  if (!channel) return false;
  const staff = (req && req.isStaffGeoBypass) || isStaffUser(req && req.session && req.session.user);
  return isGeoBlockedForRequest({
    channelCountries: channel.geo_block_countries,
    req,
    isStaff: staff
  });
}

/** Convenience: record + parent channel geo-block. */
function shouldBlockRecord(req, record) {
  if (!record) return false;
  const staff = (req && req.isStaffGeoBypass) || isStaffUser(req && req.session && req.session.user);
  return isGeoBlockedForRequest({
    channelCountries: record.geo_block_countries_channel || record.c_geo_block_countries || record.channel_geo_block_countries,
    recordCountries: record.geo_block_countries,
    req,
    isStaff: staff
  });
}

/**
 * SQL fragment: channel alias not geo-blocked for `country`.
 * Returns { sql, params }. If no country → empty sql (page-level shouldBlock* is fail-closed).
 */
function sqlNotGeoBlockedChannel(alias, country) {
  if (!country) return { sql: '', params: [] };
  const a = alias || 'c';
  return {
    sql: ` AND (${a}.geo_block_countries IS NULL OR ${a}.geo_block_countries = '' OR FIND_IN_SET(?, REPLACE(${a}.geo_block_countries, ' ', '')) = 0)`,
    params: [String(country).toUpperCase()]
  };
}

/**
 * SQL: neither record nor parent channel geo-blocked.
 */
function sqlNotGeoBlockedRecord(channelAlias, recordAlias, country) {
  if (!country) return { sql: '', params: [] };
  const c = channelAlias || 'c';
  const r = recordAlias || 'r';
  const code = String(country).toUpperCase();
  return {
    sql:
      ` AND (${c}.geo_block_countries IS NULL OR ${c}.geo_block_countries = '' OR FIND_IN_SET(?, REPLACE(${c}.geo_block_countries, ' ', '')) = 0)` +
      ` AND (${r}.geo_block_countries IS NULL OR ${r}.geo_block_countries = '' OR FIND_IN_SET(?, REPLACE(${r}.geo_block_countries, ' ', '')) = 0)`,
    params: [code, code]
  };
}

function geoLocalsMiddleware(req, res, next) {
  const user = (req.session && req.session.user) || null;
  const isStaff = isStaffUser(user);
  const country = getRequestCountry(req);
  req.viewerCountry = country;
  req.isStaffGeoBypass = isStaff;
  res.locals.viewerCountry = country;
  res.locals.isStaffGeoBypass = isStaff;
  next();
}

module.exports = {
  GEO_COUNTRY_OPTIONS,
  GEO_COUNTRY_NAME_BY_CODE,
  isStaffUser,
  normalizeCountryList,
  parseCountryList,
  countryLabel,
  formatCountryListLabels,
  mergeCountryLists,
  removeCountryFromList,
  getRequestCountry,
  isGeoBlockedForRequest,
  shouldBlockChannel,
  shouldBlockRecord,
  sqlNotGeoBlockedChannel,
  sqlNotGeoBlockedRecord,
  geoLocalsMiddleware
};
