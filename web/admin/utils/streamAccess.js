'use strict';

const crypto = require('crypto');
const { kickStream, kickConnectionsByIp } = require('./mediaServer');

function generateStreamKey() {
  return 'sk_live_' + crypto.randomBytes(16).toString('hex');
}

/**
 * Owner, co-owner, or reporter may publish RTMP/WHIP for a channel.
 */
async function canUserPublishRtmp(connection, channelId, userId, channelOwnerId) {
  if (!userId || !channelId) return false;
  if (Number(userId) === Number(channelOwnerId)) return true;
  const [rows] = await connection.query(
    'SELECT is_reporter, is_coowner FROM channel_team WHERE channel_id = ? AND user_id = ? LIMIT 1',
    [channelId, userId]
  );
  if (!rows.length) return false;
  return rows[0].is_coowner == 1 || rows[0].is_reporter == 1;
}

/**
 * Rotate every stream key on a channel.
 * Eligible publishers get a fresh active key; everyone else gets a new inactive key
 * so old compromised keys stop working.
 * @returns {{ rotated: number, activated: number, ownKey: string|null }}
 */
async function resetAllChannelStreamKeys(connection, channelId, channelOwnerId, forUserId = null) {
  if (!channelId) return { rotated: 0, activated: 0, ownKey: null };

  const [rows] = await connection.query(
    'SELECT id, user_id FROM stream_keys WHERE channel_id = ?',
    [channelId]
  );

  let rotated = 0;
  let activated = 0;
  let ownKey = null;

  for (const row of rows) {
    const newKey = generateStreamKey();
    const allowed = await canUserPublishRtmp(connection, channelId, row.user_id, channelOwnerId);
    await connection.query(
      'UPDATE stream_keys SET stream_key = ?, is_active = ? WHERE id = ?',
      [newKey, allowed ? 1 : 0, row.id]
    );
    rotated++;
    if (allowed) activated++;
    if (forUserId != null && Number(row.user_id) === Number(forUserId)) {
      ownKey = allowed ? newKey : null;
    }
  }

  // Ensure current actor (owner/coowner) has an active key even if no row existed
  if (forUserId != null && ownKey == null) {
    const allowed = await canUserPublishRtmp(connection, channelId, forUserId, channelOwnerId);
    if (allowed) {
      ownKey = generateStreamKey();
      await connection.query(
        `INSERT INTO stream_keys (channel_id, user_id, stream_key, is_active)
         VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE stream_key = VALUES(stream_key), is_active = 1`,
        [channelId, forUserId, ownKey]
      );
      rotated++;
      activated++;
    }
  }

  return { rotated, activated, ownKey };
}

/**
 * Deactivate stream keys for a user on a channel.
 * If they are the current publisher, kick the live stream.
 */
async function revokeUserStreamAccess(connection, {
  channelId,
  userId,
  shortname,
  io = null,
  kickIfLive = true
}) {
  if (!channelId || !userId) return { revokedKeys: false, kicked: false };

  await connection.query(
    'UPDATE stream_keys SET is_active = 0 WHERE channel_id = ? AND user_id = ?',
    [channelId, userId]
  );

  let kicked = false;
  if (kickIfLive && shortname) {
    const [ch] = await connection.query(
      'SELECT current_streamer_id, is_live FROM channels WHERE id = ?',
      [channelId]
    );
    const isCurrent =
      ch.length > 0 &&
      ch[0].is_live == 1 &&
      Number(ch[0].current_streamer_id) === Number(userId);

    if (isCurrent) {
      kicked = await forceKillChannelStream(connection, {
        channelId,
        shortname,
        io
      });
    }
  }

  return { revokedKeys: true, kicked };
}

/**
 * Force-drop all publishers for a channel and clear live flags.
 */
async function forceKillChannelStream(connection, { channelId, shortname, io = null }) {
  if (!channelId || !shortname) return false;

  try {
    if (typeof global !== 'undefined') {
      global.immediateStreamEnds = global.immediateStreamEnds || {};
      global.pendingStreamEnds = global.pendingStreamEnds || {};
      global.immediateStreamEnds[channelId] = true;
      for (let idx = 1; idx <= 3; idx++) {
        const key = `${channelId}_${idx}`;
        global.immediateStreamEnds[key] = true;
        if (global.pendingStreamEnds[key]) {
          clearTimeout(global.pendingStreamEnds[key]);
          delete global.pendingStreamEnds[key];
        }
      }
      if (global.pendingStreamEnds[channelId]) {
        clearTimeout(global.pendingStreamEnds[channelId]);
        delete global.pendingStreamEnds[channelId];
      }
    }
  } catch (_) {}

  let kicked = false;
  try {
    const result = await kickStream(shortname);
    kicked = !!(result && result.kicked);
  } catch (e) {
    console.error('[streamAccess] kickStream failed:', e.message);
  }

  await connection.query(
    'UPDATE channels SET is_live = 0, is_live_1 = 0, is_live_2 = 0, is_live_3 = 0, live_title = NULL, current_streamer_id = NULL WHERE id = ?',
    [channelId]
  );

  if (io) {
    try {
      io.to(`channel_${channelId}`).emit('stream_ended');
    } catch (_) {}
  }

  return kicked;
}

/**
 * After account ban: kill every owned/live stream, deactivate keys, ban last IP on MediaMTX side.
 */
async function enforceAccountBanSideEffects(connection, {
  userId,
  lastIp = null,
  banIp = true,
  banIpType = 'account',
  bannedBy = null,
  reason = null,
  io = null
}) {
  const result = { channelsKilled: 0, keysRevoked: 0, ipBanned: false, ipKicked: 0 };

  const [owned] = await connection.query(
    'SELECT id, shortname FROM channels WHERE user_id = ?',
    [userId]
  );
  const [liveAs] = await connection.query(
    `SELECT id, shortname FROM channels
     WHERE current_streamer_id = ? AND (is_live = 1 OR is_live_1 = 1 OR is_live_2 = 1 OR is_live_3 = 1)`,
    [userId]
  );

  const seen = new Set();
  for (const ch of [...owned, ...liveAs]) {
    if (!ch || !ch.id || seen.has(ch.id)) continue;
    seen.add(ch.id);
    try {
      await forceKillChannelStream(connection, {
        channelId: ch.id,
        shortname: ch.shortname,
        io
      });
      result.channelsKilled++;
    } catch (e) {
      console.error(`[streamAccess] kill on ban channel ${ch.id}:`, e.message);
    }
  }

  const [keyRes] = await connection.query(
    'UPDATE stream_keys SET is_active = 0 WHERE user_id = ?',
    [userId]
  );
  result.keysRevoked = keyRes && keyRes.affectedRows ? keyRes.affectedRows : 0;

  if (banIp && lastIp) {
    const ipType = banIpType === 'full' ? 'full' : 'account';
    try {
      const { isProtectedIp } = require('./ipChecker');
      const protectedIp = await isProtectedIp(connection, lastIp, null);
      if (!protectedIp) {
        await connection.query(
          `INSERT INTO ip_bans (ip_address, banned_by, ban_type, reason)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             banned_by = VALUES(banned_by),
             ban_type = IF(VALUES(ban_type) = 'full' OR ban_type = 'full', 'full', VALUES(ban_type)),
             reason = COALESCE(VALUES(reason), reason)`,
          [lastIp, bannedBy, ipType, reason]
        );
        result.ipBanned = true;
        try {
          const {
            rememberFingerprintsForIp
          } = require('./deviceFingerprint');
          const [banRows] = await connection.query('SELECT id FROM ip_bans WHERE ip_address = ?', [lastIp]);
          const ipBanId = banRows.length ? banRows[0].id : null;
          await rememberFingerprintsForIp(connection, lastIp, {
            ipBanId,
            bannedBy,
            reason,
            banType: ipType
          });
        } catch (fpErr) {
          console.error('[streamAccess] fp remember on ban:', fpErr.message);
        }
      }
    } catch (e) {
      console.error('[streamAccess] ip ban on account ban:', e.message);
    }

    try {
      const kick = await kickConnectionsByIp(lastIp);
      result.ipKicked = kick && kick.kicked ? kick.kicked : 0;
    } catch (e) {
      console.error('[streamAccess] kick by IP on ban:', e.message);
    }
  }

  return result;
}

module.exports = {
  canUserPublishRtmp,
  revokeUserStreamAccess,
  forceKillChannelStream,
  enforceAccountBanSideEffects,
  resetAllChannelStreamKeys,
  generateStreamKey
};
