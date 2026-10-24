const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { logAction } = require('../../../utils/logger');
const { canUserPublishRtmp, enforceAccountBanSideEffects } = require('../../../utils/streamAccess');
const { isIpInBanRecord } = require('../../../utils/ipChecker');
const { requireRtmpInternalAuth } = require('../../../middlewares/rtmpInternalAuth');

// Gate all MediaMTX / legacy RTMP internal webhooks behind shared credentials.
router.use('/api/internal/rtmp', requireRtmpInternalAuth);

/** Normalize publisher IP; prefer fallback over empty/loopback from MediaMTX hooks. */
function resolvePublisherIp(rawIp, fallbackIp) {
  let clean = (rawIp == null ? '' : String(rawIp)).trim();
  if (clean.startsWith('::ffff:')) clean = clean.substring(7);
  if (clean === '::1') clean = '127.0.0.1';
  if (!clean || clean === '127.0.0.1' || clean === 'localhost') {
    let fb = (fallbackIp == null ? '' : String(fallbackIp)).trim();
    if (fb.startsWith('::ffff:')) fb = fb.substring(7);
    if (fb && fb !== '127.0.0.1' && fb !== 'localhost' && fb !== '::1') return fb;
  }
  return clean || '127.0.0.1';
}

function bumpStreamSession(teardownKey, meta) {
  global.streamSessions = global.streamSessions || {};
  global.streamSessionSeq = (global.streamSessionSeq || 0) + 1;
  const sessionId = global.streamSessionSeq;
  global.streamSessions[teardownKey] = Object.assign({ sessionId }, meta || {});
  return sessionId;
}

function getStreamSession(teardownKey) {
  global.streamSessions = global.streamSessions || {};
  return global.streamSessions[teardownKey] || null;
}

function clearStreamSession(teardownKey) {
  if (global.streamSessions) delete global.streamSessions[teardownKey];
}

function isSessionCurrent(teardownKey, sessionId) {
  if (sessionId == null) return true;
  const cur = getStreamSession(teardownKey);
  return !!(cur && cur.sessionId === sessionId);
}


router.post('/api/internal/rtmp/on_publish', async (req, res) => {
  const { shortname, key, streamId, ip } = req.body;
  try {
    // 1. Find channel & check global settings
    const [settings] = await pool.query('SELECT setting_value FROM system_settings WHERE setting_key = "rtmp_disabled"');
    if (settings.length > 0 && settings[0].setting_value === '1') {
      return res.status(403).json({ error: 'RTMP streaming is globally disabled' });
    }

    const [channels] = await pool.query('SELECT id, name, user_id, rtmp_disabled, stream_delay FROM channels WHERE LOWER(shortname) = LOWER(?) AND status = "active"', [shortname]);
    if (channels.length === 0) return res.status(403).json({ error: 'Channel not found' });
    if (channels[0].rtmp_disabled) return res.status(403).json({ error: 'RTMP streaming is disabled for this channel' });
    const channelId = channels[0].id;
    const channelName = channels[0].name;
    const channelOwnerId = channels[0].user_id;
    const streamDelay = 12;

    // 2. Disconnect stale publisher if active
    try {
      const axios = require('axios');
      const response = await axios.get('http://127.0.0.1:8000/api/streams', {
        auth: {
          username: process.env.RTMP_API_USER,
          password: process.env.RTMP_API_PASS
        }
      });
      const liveStreams = response.data.live;
      if (liveStreams && liveStreams[shortname] && liveStreams[shortname].publisher) {
        const oldClientId = liveStreams[shortname].publisher.clientId;
        if (oldClientId !== streamId) {
          console.log(`[RTMP] Stale publisher detected for channel ${shortname} (Client: ${oldClientId}). Disconnecting...`);
          try {
            await axios.delete(`http://127.0.0.1:8000/api/clients/${oldClientId}`, {
              auth: {
                username: process.env.RTMP_API_USER,
                password: process.env.RTMP_API_PASS
              }
            });
            console.log(`[RTMP] Disconnected stale client ${oldClientId} for channel ${shortname}`);
          } catch (delErr) {
            console.error(`[RTMP] Failed to disconnect stale client ${oldClientId}:`, delErr.message);
            // Fallback: delete the entire stream if client delete fails
            try {
              await axios.delete(`http://127.0.0.1:8000/api/streams/live/${shortname}`, {
                auth: {
                  username: process.env.RTMP_API_USER,
                  password: process.env.RTMP_API_PASS
                }
              });
              console.log(`[RTMP] Fallback: dropped stream for channel ${shortname}`);
            } catch (fallbackErr) {
              console.error(`[RTMP] Fallback stream drop also failed:`, fallbackErr.message);
            }
          }
        }
      }
    } catch (e) {
      console.error('[RTMP API] Error checking active streams:', e.message);
    }

    // 3. Verify key and get username of key owner
    const [keys] = await pool.query(`
      SELECT sk.user_id, sk.is_active, u.username 
      FROM stream_keys sk 
      JOIN users u ON sk.user_id = u.id 
      WHERE sk.channel_id = ? AND sk.stream_key = ?`, [channelId, key]);

    if (keys.length === 0 || !keys[0].is_active) {
      logAction('rtmp', `Неизвестный(${channelName})`, 'Неудачная попытка публикации (Неверный ключ трансляции)', ip);
      return res.status(403).json({ error: 'Invalid key' });
    }

    const allowed = await canUserPublishRtmp(pool, channelId, keys[0].user_id, channelOwnerId);
    if (!allowed) {
      await pool.query('UPDATE stream_keys SET is_active = 0 WHERE channel_id = ? AND user_id = ?', [channelId, keys[0].user_id]);
      logAction('rtmp', `${keys[0].username}(${channelName})`, 'Неудачная попытка публикации (нет прав на эфир)', ip);
      return res.status(403).json({ error: 'Stream access revoked' });
    }

    const streamerUsername = keys[0].username;
    const logIdentifier = `${streamerUsername}(${channelName})`;
    const publisherIp = resolvePublisherIp(ip);

    // Cancel grace period if active
    global.pendingStreamEnds = global.pendingStreamEnds || {};
    const wasReconnect = !!global.pendingStreamEnds[channelId];
    if (wasReconnect) {
      console.log(`[RTMP] Reconnected within grace period for channel ${channelId}. Cancelling teardown.`);
      clearTimeout(global.pendingStreamEnds[channelId]);
      delete global.pendingStreamEnds[channelId];
    }

    // Clear any stale immediate stream end flags
    global.immediateStreamEnds = global.immediateStreamEnds || {};
    if (global.immediateStreamEnds[channelId]) {
      console.log(`[RTMP] Found and cleared stale immediate stream end flag for channel ${channelId}`);
      delete global.immediateStreamEnds[channelId];
    }

    bumpStreamSession(String(channelId), { ip: publisherIp, logIdentifier, channelId });

    // 4. Start stream
    const [chRows] = await pool.query('SELECT is_live FROM channels WHERE id = ?', [channelId]);
    if (chRows.length > 0 && chRows[0].is_live === 0) {
      await pool.query('UPDATE channels SET is_live = 1, live_title = NULL, live_started_at = NOW(), current_streamer_id = ? WHERE id = ?', [keys[0].user_id, channelId]);
    } else {
      await pool.query('UPDATE channels SET is_live = 1, live_started_at = NOW(), current_streamer_id = ? WHERE id = ?', [keys[0].user_id, channelId]);
    }

    // Emit socket event to notify players
    req.app.get('io').to(`channel_${channelId}`).emit('stream_started');

    // Reconnect inside grace is the same air session — don't spam start/end logs
    if (!wasReconnect) {
      logAction('rtmp', logIdentifier, 'Начата трансляция', publisherIp);
    }

    res.json({ success: true, delay: streamDelay });
  } catch (e) {
    console.error('[RTMP API] on_publish Error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/api/internal/rtmp/on_reject', async (req, res) => {
  const { shortname, reason } = req.body;
  try {
    const [channels] = await pool.query('SELECT id, name, user_id FROM channels WHERE LOWER(shortname) = LOWER(?) AND status = "active"', [shortname]);
    if (channels.length > 0) {
      const channelName = channels[0].name;
      const userId = channels[0].user_id;
      
      const sendSystemMessage = require('../../../utils/systemMessage');
      const messageContent = `Неуспешно запущена трансляция телеканала "${channelName}". Причина: ${reason}. Пожалуйста, проверьте настройки кодировщика (OBS) и повторите попытку.`;
      
      await sendSystemMessage(userId, messageContent);
      console.log(`[RTMP REJECT] Sent system message to user ${userId} for channel ${channelName}. Reason: ${reason}`);

      // Log system action and trigger Telegram notification
      const logIdentifier = `Система(${channelName})`;
      await logAction('rtmp', logIdentifier, `Неуспешный запуск трансляции (Сброс): ${reason}`, '127.0.0.1');
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[RTMP API] on_reject Error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/api/internal/rtmp/on_done', async (req, res) => {
  const { shortname, streamId, ip } = req.body;
  try {
    const [channels] = await pool.query(`
      SELECT c.id, c.name, u.username 
      FROM channels c 
      LEFT JOIN users u ON c.current_streamer_id = u.id 
      WHERE LOWER(c.shortname) = LOWER(?)`, [shortname]);

    if (channels.length > 0) {
      const channelId = channels[0].id;
      const channelName = channels[0].name;
      const streamerUsername = channels[0].username || 'Неизвестный';
      const logIdentifier = `${streamerUsername}(${channelName})`;

      global.immediateStreamEnds = global.immediateStreamEnds || {};
      global.pendingStreamEnds = global.pendingStreamEnds || {};
      const sessionKey = String(channelId);
      const session = getStreamSession(sessionKey);
      const endIp = resolvePublisherIp(ip, session && session.ip);

      if (global.immediateStreamEnds[channelId]) {
        console.log(`[RTMP] Immediate teardown requested for channel ${channelId}`);
        delete global.immediateStreamEnds[channelId];
        if (global.pendingStreamEnds[channelId]) {
          clearTimeout(global.pendingStreamEnds[channelId]);
          delete global.pendingStreamEnds[channelId];
        }
        clearStreamSession(sessionKey);
        await pool.query('UPDATE channels SET is_live = 0, current_streamer_id = NULL WHERE id = ?', [channelId]);
        req.app.get('io').to(`channel_${channelId}`).emit('stream_ended');
        logAction('rtmp', logIdentifier, 'Окончена трансляция', endIp);
      } else {
        console.log(`[RTMP] Connection closed for channel ${channelId}. Starting 14s grace period.`);
        if (global.pendingStreamEnds[channelId]) {
          clearTimeout(global.pendingStreamEnds[channelId]);
        }
        const sessionIdAtUnpublish = session ? session.sessionId : null;
        global.pendingStreamEnds[channelId] = setTimeout(async () => {
          try {
            delete global.pendingStreamEnds[channelId];
            if (!isSessionCurrent(sessionKey, sessionIdAtUnpublish)) {
              console.log(`[RTMP] Grace teardown skipped — session superseded for channel ${channelId}`);
              return;
            }
            await pool.query('UPDATE channels SET is_live = 0, current_streamer_id = NULL WHERE id = ?', [channelId]);
            if (!isSessionCurrent(sessionKey, sessionIdAtUnpublish)) {
              console.log(`[RTMP] Grace teardown aborted mid-flight — reconnected channel ${channelId}`);
              await pool.query('UPDATE channels SET is_live = 1 WHERE id = ?', [channelId]);
              req.app.get('io').to(`channel_${channelId}`).emit('stream_started');
              return;
            }
            clearStreamSession(sessionKey);
            req.app.get('io').to(`channel_${channelId}`).emit('stream_ended');
            logAction('rtmp', logIdentifier, 'Окончена трансляция', endIp);
            console.log(`[RTMP] Grace period expired. Closed stream for channel ${channelId}`);
          } catch (err) {
            console.error('[RTMP] Error executing delayed stream teardown:', err);
          }
        }, 14000);
      }
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[RTMP API] on_done Error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/api/internal/rtmp/mediamtx_auth', async (req, res) => {
  const { ip, user, path, action } = req.body || {};
  console.log(`[MediaMTX Auth] action=${action} path=${path} user=${user ? '[set]' : '[empty]'} ip=${ip || ''}`);
  const { password, query } = req.body;

  if (action !== 'publish') {
    return res.status(200).send();
  }

  const pathParts = path.split('/');
  // MediaMTX paths are case-sensitive; normalize so OBS key casing matches HLS (always lower)
  let shortname = String(pathParts[pathParts.length - 1] || '').toLowerCase();

  console.log(`[MediaMTX Auth Debug] Incoming path: ${path}, shortname: ${shortname}`);

  let key = null;
  if (query) {
    const querystring = require('querystring');
    const parsedQuery = querystring.parse(query);
    key = parsedQuery.key;
  }
  if (!key) {
    key = password || user;
  }

  if (!shortname || !key) {
    console.log('[MediaMTX Auth] Rejected: missing shortname or stream key');
    return res.status(401).json({ error: 'Missing shortname or stream key' });
  }

  try {
    const [settings] = await pool.query('SELECT setting_value FROM system_settings WHERE setting_key = "rtmp_disabled"');
    if (settings.length > 0 && settings[0].setting_value === '1') {
      return res.status(403).json({ error: 'RTMP streaming is globally disabled' });
    }

    // Reject publish from IPs banned at account/full level (MediaMTX has no native IP ACL)
    const publisherIpEarly = resolvePublisherIp(ip);
    if (publisherIpEarly && publisherIpEarly !== '127.0.0.1') {
      const [ipBans] = await pool.query(
        "SELECT ip_address, ban_type FROM ip_bans WHERE ban_type IN ('account', 'all', 'full')"
      );
      const matchedIpBan = ipBans.find((b) => isIpInBanRecord(publisherIpEarly, b.ip_address));
      if (matchedIpBan) {
        console.log(`[MediaMTX Auth] Rejected publish from banned IP ${publisherIpEarly} (${matchedIpBan.ban_type})`);
        logAction('rtmp', 'Система', `Отклонено подключение: IP в бане (${matchedIpBan.ban_type})`, publisherIpEarly);
        return res.status(403).json({ error: 'IP banned' });
      }
    }

    let cleanShortname = shortname;
    let streamIndex = 1;

    // 1. Try exact match first (shortname already lowercased from path)
    let [channels] = await pool.query('SELECT id, name, user_id, rtmp_disabled, max_streams, is_premium, is_verified FROM channels WHERE LOWER(shortname) = ? AND status = "active"', [shortname]);

    if (channels.length === 0) {
      // 2. Try suffix match if exact name not found (e.g. shortname_2 or shortname_3)
      const match = shortname.match(/^(.+)_(1|2|3)$/);
      if (match) {
        cleanShortname = match[1];
        streamIndex = parseInt(match[2], 10);
        [channels] = await pool.query('SELECT id, name, user_id, rtmp_disabled, max_streams, is_premium, is_verified FROM channels WHERE LOWER(shortname) = ? AND status = "active"', [cleanShortname]);
      }
    } else {
      cleanShortname = shortname;
    }

    if (channels.length === 0) return res.status(403).json({ error: 'Channel not found' });

    // Check if the channel is in cooldown
    global.streamCooldowns = global.streamCooldowns || new Map();
    const cooldownKey = cleanShortname.toLowerCase();
    const cooldown = global.streamCooldowns.get(cooldownKey);
    if (cooldown) {
      if (Date.now() < cooldown.expires) {
        const remainingSec = Math.ceil((cooldown.expires - Date.now()) / 1000);
        console.log(`[MediaMTX Auth] Rejected connection for ${cleanShortname} (IP: ${ip}) due to active cooldown. Reason: ${cooldown.reason}. Remaining time: ${remainingSec}s`);
        
        // Log system action with client IP
        const channelName = channels[0].name;
        logAction('rtmp', `Система(${channelName})`, `Отклонено подключение: кулдаун (осталось ${remainingSec} сек)`, ip);

        return res.status(403).json({ error: `Канал временно заблокирован на ${remainingSec} сек за нарушение правил трансляции.` });
      } else {
        // Cooldown has expired, clean up the Map
        global.streamCooldowns.delete(cooldownKey);
      }
    }

    if (channels[0].rtmp_disabled) return res.status(403).json({ error: 'RTMP streaming is disabled for this channel' });
    const channelId = channels[0].id;
    const channelName = channels[0].name;
    const channelOwnerId = channels[0].user_id;

    // Stream index > 1 requires Premium or Verified status, and must be within max_streams setting
    const [settingsRows] = await pool.query("SELECT setting_value FROM system_settings WHERE setting_key = 'allow_multistream_for_everyone'");
    const allowEveryone = settingsRows.length > 0 && settingsRows[0].setting_value === '1';

    const maxStreams = (channels[0].is_premium || channels[0].is_verified || allowEveryone) ? (channels[0].max_streams || 1) : 1;
    if (streamIndex > maxStreams) {
      console.log(`[MediaMTX Auth] Rejected: Channel "${channelName}" requested stream index ${streamIndex} but max streams is set to ${maxStreams}`);
      return res.status(403).json({ error: `Multi-stream is not allowed or stream index ${streamIndex} exceeds allowed max_streams (${maxStreams})` });
    }

    const [keys] = await pool.query(`
      SELECT sk.user_id, sk.is_active, u.username, u.is_banned, u.banned_until
      FROM stream_keys sk 
      JOIN users u ON sk.user_id = u.id 
      WHERE sk.channel_id = ? AND sk.stream_key = ?`, [channelId, key]);

    if (keys.length === 0 || !keys[0].is_active) {
      logAction('rtmp', `Неизвестный(${channelName})`, 'Неудачная попытка публикации (Неверный ключ трансляции)', ip);
      return res.status(403).json({ error: 'Invalid key' });
    }

    const keyUser = keys[0];
    const now = new Date();
    const userBanned =
      keyUser.is_banned &&
      (!keyUser.banned_until || new Date(keyUser.banned_until) > now);
    if (userBanned) {
      await pool.query('UPDATE stream_keys SET is_active = 0 WHERE channel_id = ? AND user_id = ?', [channelId, keyUser.user_id]);
      logAction('rtmp', `${keyUser.username}(${channelName})`, 'Неудачная попытка публикации (аккаунт заблокирован)', ip);
      return res.status(403).json({ error: 'User banned' });
    }

    const allowed = await canUserPublishRtmp(pool, channelId, keyUser.user_id, channelOwnerId);
    if (!allowed) {
      await pool.query('UPDATE stream_keys SET is_active = 0 WHERE channel_id = ? AND user_id = ?', [channelId, keyUser.user_id]);
      logAction('rtmp', `${keyUser.username}(${channelName})`, 'Неудачная попытка публикации (нет прав на эфир)', ip);
      return res.status(403).json({ error: 'Stream access revoked' });
    }

    const streamerUsername = keyUser.username;
    const logIdentifier = `${streamerUsername}(${channelName})`;
    const publisherIp = resolvePublisherIp(ip);

    // Reconnected within grace period: clear the timeout for this specific stream index
    global.pendingStreamEnds = global.pendingStreamEnds || {};
    const teardownKey = `${channelId}_${streamIndex}`;
    const wasReconnect = !!global.pendingStreamEnds[teardownKey];
    if (wasReconnect) {
      console.log(`[MediaMTX] Reconnected within grace period for channel ${channelId} stream ${streamIndex}. Cancelling teardown.`);
      clearTimeout(global.pendingStreamEnds[teardownKey]);
      delete global.pendingStreamEnds[teardownKey];
    }

    global.immediateStreamEnds = global.immediateStreamEnds || {};
    const immediateKey = `${channelId}_${streamIndex}`;
    if (global.immediateStreamEnds[immediateKey]) {
      delete global.immediateStreamEnds[immediateKey];
    }
    // Legacy studio_stop key (channelId only)
    if (global.immediateStreamEnds[channelId]) {
      delete global.immediateStreamEnds[channelId];
    }

    bumpStreamSession(teardownKey, {
      ip: publisherIp,
      logIdentifier,
      streamIndex,
      channelId
    });

    // Set specific stream status and global live status
    const isLiveCol = `is_live_${streamIndex}`;
    await pool.query(`UPDATE channels SET is_live = 1, ${isLiveCol} = 1, live_title = IF(live_started_at IS NULL, NULL, live_title), live_started_at = IFNULL(live_started_at, NOW()), current_streamer_id = ? WHERE id = ?`, [keyUser.user_id, channelId]);

    // Emit event to notify client updates
    req.app.get('io').to(`channel_${channelId}`).emit('stream_started');

    // Same air session after brief drop — do not log a fake end/start pair
    if (!wasReconnect) {
      logAction('rtmp', logIdentifier, `Начата трансляция (Камера ${streamIndex})`, publisherIp);
    } else {
      console.log(`[MediaMTX] Suppressing duplicate start log for reconnect channel ${channelId} stream ${streamIndex}`);
    }

    res.status(200).send();
  } catch (e) {
    console.error('[MediaMTX Auth] Error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/api/internal/rtmp/mediamtx_unpublish', async (req, res) => {
  const { path, ip } = req.body;
  
  if (!path) {
    return res.status(400).json({ error: 'Missing path' });
  }

  console.log(`[MediaMTX Unpublish] path=${path} ip=${ip || ''}`);
  const pathParts = (req.body.path || req.body.name || '').split('/');
  const shortname = pathParts[pathParts.length - 1];

  try {
    let cleanShortname = shortname;
    let streamIndex = 1;

    let [channels] = await pool.query(`
      SELECT c.id, c.name, u.username 
      FROM channels c 
      LEFT JOIN users u ON c.current_streamer_id = u.id 
      WHERE LOWER(c.shortname) = LOWER(?)`, [shortname]);

    if (channels.length === 0) {
      const match = shortname.match(/^(.+)_(1|2|3)$/);
      if (match) {
        cleanShortname = match[1];
        streamIndex = parseInt(match[2], 10);
        [channels] = await pool.query(`
          SELECT c.id, c.name, u.username 
          FROM channels c 
          LEFT JOIN users u ON c.current_streamer_id = u.id 
          WHERE LOWER(c.shortname) = LOWER(?)`, [cleanShortname]);
      }
    } else {
      cleanShortname = shortname;
    }

    if (channels.length > 0) {
      const channelId = channels[0].id;
      const channelName = channels[0].name;
      const streamerUsername = channels[0].username || 'Неизвестный';
      const logIdentifier = `${streamerUsername}(${channelName})`;

      global.immediateStreamEnds = global.immediateStreamEnds || {};
      global.pendingStreamEnds = global.pendingStreamEnds || {};

      const immediateKey = `${channelId}_${streamIndex}`;
      const teardownKey = `${channelId}_${streamIndex}`;
      const session = getStreamSession(teardownKey);
      const endIp = resolvePublisherIp(ip, session && session.ip);
      const wantsImmediate = !!(global.immediateStreamEnds[immediateKey] || global.immediateStreamEnds[channelId]);

      if (wantsImmediate) {
        console.log(`[MediaMTX] Immediate teardown requested for channel ${channelId} stream ${streamIndex}`);
        delete global.immediateStreamEnds[immediateKey];
        delete global.immediateStreamEnds[channelId];
        if (global.pendingStreamEnds[teardownKey]) {
          clearTimeout(global.pendingStreamEnds[teardownKey]);
          delete global.pendingStreamEnds[teardownKey];
        }
        clearStreamSession(teardownKey);
        
        const isLiveCol = `is_live_${streamIndex}`;
        await pool.query(`UPDATE channels SET ${isLiveCol} = 0 WHERE id = ?`, [channelId]);

        // Check if any other streams are still active
        const [chState] = await pool.query(`SELECT is_live_1, is_live_2, is_live_3 FROM channels WHERE id = ?`, [channelId]);
        if (chState.length > 0) {
          const isAnyLive = chState[0].is_live_1 || chState[0].is_live_2 || chState[0].is_live_3;
          if (!isAnyLive) {
            await pool.query('UPDATE channels SET is_live = 0, live_title = NULL, current_streamer_id = NULL, live_started_at = NULL WHERE id = ?', [channelId]);
            req.app.get('io').to(`channel_${channelId}`).emit('stream_ended');
          } else {
            req.app.get('io').to(`channel_${channelId}`).emit('stream_updated');
          }
        }
        
        logAction('rtmp', logIdentifier, `Окончена трансляция (Камера ${streamIndex})`, endIp);
      } else {
        console.log(`[MediaMTX] Connection closed for channel ${channelId} stream ${streamIndex}. Starting 14s grace period.`);
        if (global.pendingStreamEnds[teardownKey]) {
          clearTimeout(global.pendingStreamEnds[teardownKey]);
        }
        const sessionIdAtUnpublish = session ? session.sessionId : null;
        global.pendingStreamEnds[teardownKey] = setTimeout(async () => {
          try {
            delete global.pendingStreamEnds[teardownKey];
            if (!isSessionCurrent(teardownKey, sessionIdAtUnpublish)) {
              console.log(`[MediaMTX] Grace teardown skipped — session superseded for channel ${channelId} stream ${streamIndex}`);
              return;
            }
            const isLiveCol = `is_live_${streamIndex}`;
            await pool.query(`UPDATE channels SET ${isLiveCol} = 0 WHERE id = ?`, [channelId]);

            if (!isSessionCurrent(teardownKey, sessionIdAtUnpublish)) {
              console.log(`[MediaMTX] Grace teardown aborted mid-flight — reconnected channel ${channelId} stream ${streamIndex}`);
              await pool.query(`UPDATE channels SET is_live = 1, ${isLiveCol} = 1 WHERE id = ?`, [channelId]);
              req.app.get('io').to(`channel_${channelId}`).emit('stream_started');
              return;
            }

            // Check if any other streams are still active
            const [chState] = await pool.query(`SELECT is_live_1, is_live_2, is_live_3 FROM channels WHERE id = ?`, [channelId]);
            if (chState.length > 0) {
              const isAnyLive = chState[0].is_live_1 || chState[0].is_live_2 || chState[0].is_live_3;
              if (!isAnyLive) {
                await pool.query('UPDATE channels SET is_live = 0, live_title = NULL, current_streamer_id = NULL, live_started_at = NULL WHERE id = ?', [channelId]);
                req.app.get('io').to(`channel_${channelId}`).emit('stream_ended');
              } else {
                req.app.get('io').to(`channel_${channelId}`).emit('stream_updated');
              }
            }
            clearStreamSession(teardownKey);
            logAction('rtmp', logIdentifier, `Окончена трансляция (Камера ${streamIndex})`, endIp);
            console.log(`[MediaMTX] Grace period expired. Closed stream ${streamIndex} for channel ${channelId}`);
          } catch (err) {
            console.error('[MediaMTX] Error executing delayed stream teardown:', err);
          }
        }, 14000);
      }
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[MediaMTX Unpublish] Error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * Admin/moderator emergency kill: drop publishers, clear live flags, notify clients.
 * Called from the admin panel over the docker network with RTMP internal auth.
 */
router.post('/api/internal/rtmp/admin_kill', async (req, res) => {
  const channelId = parseInt(req.body.channelId, 10);
  if (!Number.isFinite(channelId) || channelId <= 0) {
    return res.status(400).json({ error: 'Missing channelId' });
  }

  try {
    const [channels] = await pool.query(
      'SELECT id, name, shortname FROM channels WHERE id = ?',
      [channelId]
    );
    if (channels.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const channel = channels[0];
    const shortname = channel.shortname;

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
      clearStreamSession(key);
    }
    if (global.pendingStreamEnds[channelId]) {
      clearTimeout(global.pendingStreamEnds[channelId]);
      delete global.pendingStreamEnds[channelId];
    }
    clearStreamSession(String(channelId));

    const { kickStream } = require('../../../utils/mediaServer');
    const kickResult = await kickStream(shortname);

    await pool.query(
      'UPDATE channels SET is_live = 0, is_live_1 = 0, is_live_2 = 0, is_live_3 = 0, live_title = NULL, current_streamer_id = NULL WHERE id = ?',
      [channelId]
    );

    const io = req.app.get('io');
    if (io) {
      io.to(`channel_${channelId}`).emit('stream_ended');
    }

    const endIp = (kickResult && kickResult.ip) || '127.0.0.1';
    const adminName = (req.body.adminUsername && String(req.body.adminUsername).slice(0, 64)) || 'Админ';
    await logAction(
      'rtmp',
      `${adminName}(Админ)`,
      `Принудительно отключён эфир (${channel.name})`,
      endIp
    );

    console.log(`[MediaMTX] Admin kill for channel ${channelId} (${shortname}), kicked=${!!(kickResult && kickResult.kicked)}`);
    res.json({ success: true, kicked: !!(kickResult && kickResult.kicked) });
  } catch (e) {
    console.error('[MediaMTX] admin_kill Error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * After account ban from admin panel: kill live streams, revoke keys, ban last IP, kick MediaMTX by IP.
 */
router.post('/api/internal/rtmp/enforce_user_ban', async (req, res) => {
  const userId = parseInt(req.body.userId, 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Missing userId' });
  }

  try {
    const [uRows] = await pool.query('SELECT id, last_ip FROM users WHERE id = ?', [userId]);
    if (!uRows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const banIp = req.body.banIp !== false && req.body.banIp !== '0' && req.body.banIp !== 0;
    const banIpType = req.body.banIpType === 'full' ? 'full' : 'account';
    const bannedBy = req.body.bannedBy != null ? parseInt(req.body.bannedBy, 10) : null;
    const reason = req.body.reason != null ? String(req.body.reason).slice(0, 500) : null;
    const lastIp = (req.body.lastIp != null && String(req.body.lastIp).trim())
      ? String(req.body.lastIp).trim()
      : (uRows[0].last_ip || null);

    const result = await enforceAccountBanSideEffects(pool, {
      userId,
      lastIp,
      banIp,
      banIpType,
      bannedBy: Number.isFinite(bannedBy) ? bannedBy : null,
      reason,
      io: req.app.get('io')
    });

    console.log(`[MediaMTX] enforce_user_ban user=${userId}`, result);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[MediaMTX] enforce_user_ban Error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
