'use strict';

const TEAM_REJOIN_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

function formatMinutesLeft(untilDate) {
  const ms = Math.max(0, new Date(untilDate).getTime() - Date.now());
  return Math.max(1, Math.ceil(ms / 60000));
}

/**
 * Block re-invite / re-join for channelId+userId after leave or kick.
 */
async function recordTeamDeparture(connection, channelId, userId) {
  if (!channelId || !userId) return;
  const until = new Date(Date.now() + TEAM_REJOIN_COOLDOWN_MS);
  await connection.query(
    `INSERT INTO team_rejoin_cooldowns (channel_id, user_id, until_at)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE until_at = GREATEST(until_at, VALUES(until_at))`,
    [channelId, userId, until]
  );
}

/**
 * @returns {null|{ until: Date, minutesLeft: number, message: string }}
 */
async function getTeamRejoinBlock(connection, channelId, userId) {
  if (!channelId || !userId) return null;
  const [rows] = await connection.query(
    `SELECT until_at FROM team_rejoin_cooldowns
     WHERE channel_id = ? AND user_id = ? AND until_at > NOW()
     LIMIT 1`,
    [channelId, userId]
  );
  if (!rows.length) return null;
  const until = rows[0].until_at;
  const minutesLeft = formatMinutesLeft(until);
  return {
    until,
    minutesLeft,
    message:
      `Повторное присоединение к команде этого канала временно недоступно (осталось ~${minutesLeft} мин). ` +
      `Кулдаун 1 час после выхода или исключения из команды.`
  };
}

async function assertNoTeamRejoinCooldown(connection, channelId, userId) {
  const block = await getTeamRejoinBlock(connection, channelId, userId);
  if (block) {
    const err = new Error(block.message);
    err.code = 'TEAM_COOLDOWN';
    err.minutesLeft = block.minutesLeft;
    throw err;
  }
}

module.exports = {
  TEAM_REJOIN_COOLDOWN_MS,
  recordTeamDeparture,
  getTeamRejoinBlock,
  assertNoTeamRejoinCooldown
};
