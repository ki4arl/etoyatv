'use strict';

const BOOSTY_DONATE_POPUP_SETTING = 'boosty_donate_popup';
const BOOSTY_URL = 'https://boosty.to/etoyatv';

async function isSettingEnabled(connection, key) {
  const [rows] = await connection.query(
    'SELECT setting_value FROM system_settings WHERE setting_key = ? LIMIT 1',
    [key]
  );
  return rows.length > 0 && String(rows[0].setting_value) === '1';
}

async function isBoostyDonatePopupEnabled(connection) {
  return isSettingEnabled(connection, BOOSTY_DONATE_POPUP_SETTING);
}

async function userIsStaff(connection, userId) {
  if (!userId) return false;
  const [rows] = await connection.query(
    'SELECT id FROM staff WHERE user_id = ? LIMIT 1',
    [userId]
  );
  return rows.length > 0;
}

/**
 * Show nag popup to users without Boosty (and guests) when setting is on.
 * Staff and anyone with linked Boosty email never see it (fast DB check, no API).
 */
async function shouldShowBoostyDonatePopup(connection, userId) {
  if (!(await isBoostyDonatePopupEnabled(connection))) return false;
  if (!userId) return true;
  if (await userIsStaff(connection, userId)) return false;
  const [u] = await connection.query(
    'SELECT boosty_email FROM users WHERE id = ? LIMIT 1',
    [userId]
  );
  if (u.length && u[0].boosty_email) return false;
  return true;
}

module.exports = {
  BOOSTY_DONATE_POPUP_SETTING,
  BOOSTY_URL,
  isBoostyDonatePopupEnabled,
  shouldShowBoostyDonatePopup
};
