'use strict';

const { pool } = require('../config/db');
const {
  NOTIFICATIONS_USERNAME,
  ADMINISTRATION_USERNAME,
  ensureOfficialUserId
} = require('./officialAccounts');

async function sendFromOfficial(receiverId, content, kind) {
  try {
    const senderId = await ensureOfficialUserId(pool, kind);
    await pool.query(
      'INSERT INTO messages (sender_id, receiver_id, content, created_at) VALUES (?, ?, ?, NOW())',
      [senderId, receiverId, content]
    );
  } catch (error) {
    console.error(`Failed to send ${kind} message:`, error);
  }
}

/** System notices / broadcasts / auto-mails → «Уведомления ЭтоЯTV» (no replies). */
async function sendSystemMessage(receiverId, content) {
  return sendFromOfficial(receiverId, content, 'notifications');
}

/** Staff official PM → «Администрация ЭтоЯTV» (user may reply). */
async function sendAdministrationMessage(receiverId, content) {
  return sendFromOfficial(receiverId, content, 'administration');
}

module.exports = sendSystemMessage;
module.exports.sendSystemMessage = sendSystemMessage;
module.exports.sendAdministrationMessage = sendAdministrationMessage;
module.exports.NOTIFICATIONS_USERNAME = NOTIFICATIONS_USERNAME;
module.exports.ADMINISTRATION_USERNAME = ADMINISTRATION_USERNAME;
