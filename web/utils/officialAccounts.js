'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');

/** Official platform PM identities (not staff logins). */
const NOTIFICATIONS_USERNAME = 'Уведомления ЭтоЯTV';
const ADMINISTRATION_USERNAME = 'Администрация ЭтоЯTV';

const NOTIFICATIONS_EMAIL = 'notifications@etoyatv.ru';
const ADMINISTRATION_EMAIL = 'administration@etoyatv.ru';

/** Unusable bcrypt hash — login always fails; not a real password. */
const OFFICIAL_PASSWORD_MARKER = '!official-no-login!';

function isNotificationsAccount(username) {
  return username === NOTIFICATIONS_USERNAME;
}

function isAdministrationAccount(username) {
  return username === ADMINISTRATION_USERNAME;
}

function isOfficialAccount(username) {
  return isNotificationsAccount(username) || isAdministrationAccount(username);
}

function isOfficialEmail(email) {
  const e = String(email || '').toLowerCase();
  return e === NOTIFICATIONS_EMAIL.toLowerCase() || e === ADMINISTRATION_EMAIL.toLowerCase();
}

async function makeOfficialPasswordHash() {
  // Random bcrypt so even if somehow compared, it never matches a known password
  return bcrypt.hash(crypto.randomBytes(32).toString('hex') + OFFICIAL_PASSWORD_MARKER, 10);
}

/**
 * Ensure an official system user exists; return its id.
 * @param {import('mysql2/promise').Pool|import('mysql2/promise').PoolConnection} db
 * @param {'notifications'|'administration'} kind
 */
async function ensureOfficialUserId(db, kind) {
  const isNotif = kind === 'notifications';
  const username = isNotif ? NOTIFICATIONS_USERNAME : ADMINISTRATION_USERNAME;
  const email = isNotif ? NOTIFICATIONS_EMAIL : ADMINISTRATION_EMAIL;

  const [rows] = await db.query('SELECT id, password, role FROM users WHERE username = ?', [username]);
  if (rows.length > 0) {
    const u = rows[0];
    // Harden legacy plaintext / role=admin rows
    const needsHash =
      !u.password ||
      u.password === 'system_no_login_pw' ||
      !String(u.password).startsWith('$2');
    const needsRole = u.role === 'admin' || !u.role;
    if (needsHash || needsRole) {
      const hash = needsHash ? await makeOfficialPasswordHash() : u.password;
      await db.query(
        'UPDATE users SET password = ?, role = ?, is_verified = 1, email = ? WHERE id = ?',
        [hash, 'system', email, u.id]
      );
    }
    return u.id;
  }

  const hash = await makeOfficialPasswordHash();
  const [insertResult] = await db.query(
    `INSERT INTO users (username, email, password, role, is_verified, created_at, avatar)
     VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
    [username, email, hash, 'system', 1, '/images/default_user_avatar.png']
  );
  return insertResult.insertId;
}

module.exports = {
  NOTIFICATIONS_USERNAME,
  ADMINISTRATION_USERNAME,
  NOTIFICATIONS_EMAIL,
  ADMINISTRATION_EMAIL,
  isNotificationsAccount,
  isAdministrationAccount,
  isOfficialAccount,
  isOfficialEmail,
  ensureOfficialUserId,
  makeOfficialPasswordHash
};
