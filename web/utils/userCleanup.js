'use strict';

const { pool } = require('../config/db');
const { deleteChannelData } = require('./cleanup');
const { deletePublicFileIfExists } = require('./safePath');

const INACTIVE_DAYS = 7;

async function logSystem(connection, actionText) {
  try {
    await connection.query(
      'INSERT INTO system_logs (log_type, username, action_text, ip_address) VALUES (?, ?, ?, ?)',
      ['system', 'Система', actionText, '127.0.0.1']
    );
  } catch (err) {
    console.error('[USER_CLEANUP] Failed to log system action:', err);
  }
}

/**
 * Users eligible for hard delete:
 * - email not verified for 7+ days
 * - not staff / system accounts
 */
async function findInactiveUsers(connection) {
  const [rows] = await connection.query(`
    SELECT u.id, u.username, u.email, u.created_at, u.last_email_sent, u.is_verified
    FROM users u
    LEFT JOIN staff s ON s.user_id = u.id
    WHERE s.user_id IS NULL
      AND IFNULL(u.role, 'user') NOT IN ('admin', 'system')
      AND u.is_verified = 0
      AND COALESCE(u.created_at, u.last_email_sent) <= DATE_SUB(NOW(), INTERVAL ? DAY)
    ORDER BY u.id ASC
  `, [INACTIVE_DAYS]);
  return rows;
}

async function hardDeleteUser(connection, userId) {
  const [users] = await connection.query(`
    SELECT u.id, u.username, u.avatar
    FROM users u
    LEFT JOIN staff s ON s.user_id = u.id
    WHERE u.id = ?
      AND s.user_id IS NULL
      AND IFNULL(u.role, 'user') NOT IN ('admin', 'system')
  `, [userId]);

  if (users.length === 0) {
    return { deleted: false, reason: 'protected_or_missing' };
  }

  const user = users[0];
  const [channels] = await connection.query('SELECT id FROM channels WHERE user_id = ?', [userId]);
  for (const channel of channels) {
    await deleteChannelData(connection, channel.id);
  }

  if (user.avatar && !String(user.avatar).includes('default_user_avatar')) {
    deletePublicFileIfExists(user.avatar);
  }

  await connection.query('DELETE FROM users WHERE id = ?', [userId]);
  await logSystem(
    connection,
    `Автоудаление неподтверждённого аккаунта «${user.username}» (ID: ${userId}, неактивен ${INACTIVE_DAYS}+ дней)`
  );

  return { deleted: true, username: user.username, id: userId };
}

/**
 * @param {{ dryRun?: boolean }} [opts]
 */
async function purgeInactiveUsers(opts = {}) {
  const dryRun = !!opts.dryRun;
  const connection = await pool.getConnection();
  const result = { dryRun, found: 0, deleted: 0, users: [] };

  try {
    const candidates = await findInactiveUsers(connection);
    result.found = candidates.length;

    if (dryRun) {
      result.users = candidates.map((u) => ({
        id: u.id,
        username: u.username,
        created_at: u.created_at,
        last_email_sent: u.last_email_sent
      }));
      return result;
    }

    for (const candidate of candidates) {
      const del = await hardDeleteUser(connection, candidate.id);
      if (del.deleted) {
        result.deleted += 1;
        result.users.push({ id: del.id, username: del.username });
        console.log(`[USER_CLEANUP] Deleted user #${del.id} (${del.username})`);
      }
    }

    if (result.deleted > 0) {
      await logSystem(
        connection,
        `Фоновая очистка: удалено неподтверждённых аккаунтов (${result.deleted})`
      );
    }

    return result;
  } finally {
    connection.release();
  }
}

async function runUserCleanup() {
  console.log(`[USER_CLEANUP] Checking unverified accounts older than ${INACTIVE_DAYS} days...`);
  try {
    const result = await purgeInactiveUsers({ dryRun: false });
    if (result.found === 0) {
      console.log('[USER_CLEANUP] Nothing to delete.');
    } else {
      console.log(`[USER_CLEANUP] Removed ${result.deleted}/${result.found} account(s).`);
    }
  } catch (err) {
    console.error('[USER_CLEANUP] Error:', err);
  }
}

module.exports = {
  INACTIVE_DAYS,
  findInactiveUsers,
  hardDeleteUser,
  purgeInactiveUsers,
  runUserCleanup
};
