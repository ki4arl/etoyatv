'use strict';

const { pool } = require('../config/db');
const sendSystemMessage = require('./systemMessage');
const { assertNoTeamRejoinCooldown } = require('./teamCooldown');

function roleListRu({ is_reporter, is_moderator, is_editor, is_coowner }) {
  const parts = [];
  if (is_coowner) parts.push('совладельцем');
  if (is_editor) parts.push('редактором');
  if (is_moderator) parts.push('модератором');
  if (is_reporter) parts.push('репортёром');
  if (!parts.length) return 'участником команды';
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(', ') + ' и ' + parts[parts.length - 1];
}

/**
 * Create (or refresh) a pending team invite and notify the invitee via system PM.
 * Throws Error with code TEAM_COOLDOWN if invitee left/was kicked within the last hour.
 */
async function createTeamInvite({
  channelId,
  channelName,
  inviterId,
  inviterUsername,
  inviteeId,
  is_reporter = 0,
  is_moderator = 0,
  is_editor = 0,
  is_coowner = 0,
  appUrl
}) {
  const rep = is_reporter ? 1 : 0;
  const mod = is_moderator ? 1 : 0;
  const ed = is_editor ? 1 : 0;
  const co = is_coowner ? 1 : 0;

  await assertNoTeamRejoinCooldown(pool, channelId, inviteeId);

  // Cancel previous pending invite for same pair, then insert fresh
  await pool.query(
    "UPDATE pending_team_invites SET status = 'cancelled' WHERE channel_id = ? AND invitee_id = ? AND status = 'pending'",
    [channelId, inviteeId]
  );

  const [result] = await pool.query(
    `INSERT INTO pending_team_invites
      (channel_id, inviter_id, invitee_id, is_reporter, is_moderator, is_editor, is_coowner, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [channelId, inviterId, inviteeId, rep, mod, ed, co]
  );

  const roleText = roleListRu({ is_reporter: rep, is_moderator: mod, is_editor: ed, is_coowner: co });
  const base = (appUrl || process.env.APP_URL || 'http://localhost:3001').replace(/\/$/, '');
  const link = `${base}/panel,select?to=channel`;
  const msg =
    `${inviterUsername} назначил вас ${roleText} на канале «${channelName}». ` +
    `Подтвердите, если хотите стать членом команды.\n\n` +
    `Открыть приглашения: ${link}`;

  await sendSystemMessage(inviteeId, msg);
  return result.insertId;
}

module.exports = {
  createTeamInvite,
  roleListRu
};
