'use strict';

const bcrypt = require('bcrypt');

async function hashBackupCodes(codes) {
  return Promise.all(codes.map((c) => bcrypt.hash(String(c).toUpperCase(), 10)));
}

/**
 * Match plaintext code against stored hashes (or legacy plaintext list).
 * Returns remaining codes to persist, or null if no match.
 */
async function consumeBackupCode(storedJson, submitted) {
  if (!storedJson) return null;
  let list;
  try {
    list = JSON.parse(storedJson);
  } catch (_) {
    return null;
  }
  if (!Array.isArray(list) || !list.length) return null;
  const code = String(submitted || '').trim().toUpperCase();
  if (!code) return null;

  const remaining = [];
  let matched = false;
  for (const entry of list) {
    const s = String(entry || '');
    if (matched) {
      remaining.push(s);
      continue;
    }
    if (s.startsWith('$2')) {
      if (await bcrypt.compare(code, s)) {
        matched = true;
        continue;
      }
      remaining.push(s);
    } else if (s.toUpperCase() === code) {
      matched = true;
    } else {
      remaining.push(s);
    }
  }
  if (!matched) return null;

  const next = [];
  for (const entry of remaining) {
    if (String(entry).startsWith('$2')) next.push(entry);
    else next.push(await bcrypt.hash(String(entry).toUpperCase(), 10));
  }
  return next;
}

module.exports = { hashBackupCodes, consumeBackupCode };
