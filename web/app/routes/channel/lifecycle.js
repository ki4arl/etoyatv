// Channel lifecycle: create, restore, transfer
const express = require('express');
const router = express.Router();
const { pool } = require('../../../config/db');
const { requireAuth } = require('../../../middlewares/auth');
const { logAction } = require('../../../utils/logger');
const wordFilter = require('../../../utils/wordFilter');
const emailService = require('../../../emailService');
const {
  getRequestFingerprint,
  updateUserLastFingerprint
} = require('../../../utils/deviceFingerprint');
const {
  userRequiresChannelModeration,
  CHANNEL_PENDING_NOTICE,
  TRANSFER_PENDING_NOTICE
} = require('../../../utils/disposableGuard');
const sendSystemMessage = require('../../../utils/systemMessage');
const { createTeamInvite } = require('../../../utils/teamInvite');

const OWNED_CHANNEL_STATUSES = "('active', 'banned', 'pending_approval', 'rejected_approval')";

router.get('/channels/create', requireAuth, async (req, res) => {
  let deletedChannels = [];
  let personalCount = 0;
  let cooperativeCount = 0;
  let disposableEmailNotice = false;
  try {
    const connection = await pool.getConnection();

    const [deleted] = await connection.query("SELECT id, name, shortname, deleted_at FROM channels WHERE user_id = ? AND status = 'deleted' AND deleted_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)", [req.session.user.id]);
    
    const [owned] = await connection.query(
      `SELECT is_personal FROM channels WHERE user_id = ? AND status IN ${OWNED_CHANNEL_STATUSES}`,
      [req.session.user.id]
    );
    personalCount = owned.filter(c => c.is_personal).length;
    cooperativeCount = owned.filter(c => !c.is_personal).length;

    const mod = await userRequiresChannelModeration(connection, req.session.user.id, {
      isStaff: !!req.session.user.staff_role
    });
    disposableEmailNotice = !!mod.required;

    connection.release();

    deletedChannels = deleted.map(ch => {
      const diff = Date.now() - new Date(ch.deleted_at).getTime();
      const daysLeft = 30 - Math.floor(diff / (1000 * 60 * 60 * 24));
      return {
        id: ch.id,
        name: ch.name || ch.shortname || 'Без названия',
        daysLeft: daysLeft > 0 ? daysLeft : 0
      };
    }).filter(ch => ch.daysLeft > 0);
  } catch (e) {
    console.error('Error in channels/create GET:', e);
  }
  res.render('channel_create', { 
    pageTitle: 'Создание телеканала | ЭтоЯTV', 
    error: req.query.error, 
    deletedChannels,
    personalCount,
    cooperativeCount,
    disposableEmailNotice,
    channelApprovalPending: false
  });
});

router.post('/channels/restore', requireAuth, async (req, res) => {
  const { channel_id } = req.body;
  try {
    const connection = await pool.getConnection();
    if (channel_id) {
      await connection.query("UPDATE channels SET status = 'active', deleted_at = NULL, rtmp_disabled = 0 WHERE user_id = ? AND id = ? AND status = 'deleted'", [req.session.user.id, channel_id]);
    } else {
      await connection.query("UPDATE channels SET status = 'active', deleted_at = NULL, rtmp_disabled = 0 WHERE user_id = ? AND status = 'deleted'", [req.session.user.id]);
    }
    
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Отменил удаление канала ${channel_id || ''}`.trim(), userIp);

    connection.release();
    res.redirect('/panel,dashboard');
  } catch (e) {
    console.error(e);
    res.redirect('/channels/create?error=' + encodeURIComponent('Ошибка восстановления'));
  }
});

router.post('/channels/create', requireAuth, async (req, res) => {
  const { name, description, channel_type, team_username, team_usernames } = req.body;
  let { shortname } = req.body;
  if (!name || !shortname || !channel_type) {
    return res.redirect('/channels/create?error=' + encodeURIComponent('Имя канала, короткое имя и тип канала обязательны.'));
  }
  if (channel_type !== 'personal' && channel_type !== 'cooperative') {
    return res.redirect('/channels/create?error=' + encodeURIComponent('Неверный тип канала.'));
  }
  if (name.length > 77) {
    return res.redirect('/channels/create?error=' + encodeURIComponent('Название телеканала не должно превышать 77 символов.'));
  }
  if (description && description.length > 200) {
    return res.redirect('/channels/create?error=' + encodeURIComponent('Описание телеканала не должно превышать 200 символов.'));
  }

  const restrictedSlugs = ['login', 'register', 'api', 'news', 'account', 'channels', 'admin', 'panel', 'tv', 'channel', 'messages', 'eula', 'channel_eula', 'rules', 'about', 'feedback', 'speedtest'];
  if (restrictedSlugs.includes(shortname.toLowerCase())) {
    return res.redirect('/channels/create?error=' + encodeURIComponent('Это короткое имя недоступно.'));
  }

  const slugRegex = /^[a-zA-Z0-9_-]+$/;
  if (!slugRegex.test(shortname)) {
    return res.redirect('/channels/create?error=' + encodeURIComponent('Короткое имя может содержать только латинские буквы, цифры, дефис и подчеркивание.'));
  }
  // MediaMTX paths are case-sensitive; store lowercase so keys/HLS/WHIP match
  shortname = String(shortname).toLowerCase();

  if (!req.session.user.staff_role && await wordFilter.containsBadWords(shortname)) {
    return res.redirect('/channels/create?error=' + encodeURIComponent('Данный URL адрес нельзя назвать.'));
  }

  try {
    const connection = await pool.getConnection();
    const { fp_hash: fpHash, ua } = getRequestFingerprint(req);
    const isStaff = !!req.session.user.staff_role;

    if (!fpHash && !isStaff) {
      connection.release();
      return res.redirect('/channels/create?error=' + encodeURIComponent('Не удалось определить устройство. Обновите страницу и попробуйте снова.'));
    }

    const mod = await userRequiresChannelModeration(connection, req.session.user.id, { isStaff });

    if (fpHash) {
      const [[{ cnt }]] = await connection.query(
        'SELECT COUNT(*) AS cnt FROM channel_create_events WHERE fp_hash = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)',
        [fpHash]
      );
      if (cnt >= 4 && !isStaff) {
        connection.release();
        return res.redirect('/channels/create?error=' + encodeURIComponent('Превышен дневной лимит создания каналов (4).'));
      }
      await updateUserLastFingerprint(connection, req.session.user.id, fpHash, ua);
    }

    // Check limits (pending / rejected also count so temp-mail can't spam the queue)
    const [owned] = await connection.query(
      `SELECT is_personal FROM channels WHERE user_id = ? AND status IN ${OWNED_CHANNEL_STATUSES}`,
      [req.session.user.id]
    );
    const personalCount = owned.filter(c => c.is_personal).length;
    const cooperativeCount = owned.filter(c => !c.is_personal).length;

    if (channel_type === 'personal' && personalCount >= 1) {
      connection.release();
      return res.redirect('/channels/create?error=' + encodeURIComponent('Превышен лимит личных каналов (максимум 1).'));
    }
    if (channel_type === 'cooperative' && cooperativeCount >= 3 && !req.session.user.staff_role) {
      connection.release();
      return res.redirect('/channels/create?error=' + encodeURIComponent('Превышен лимит кооперативных каналов (максимум 3).'));
    }

    // Check team member usernames if cooperative
    const teamUserIds = [];
    if (channel_type === 'cooperative') {
      let usernamesList = [];
      if (team_usernames) {
        if (Array.isArray(team_usernames)) {
          usernamesList = team_usernames.map(u => u.trim()).filter(Boolean);
        } else if (typeof team_usernames === 'string') {
          usernamesList = [team_usernames.trim()].filter(Boolean);
        }
      }
      if (team_username && team_username.trim()) {
        const singleInput = team_username.trim();
        if (!usernamesList.includes(singleInput)) {
          usernamesList.push(singleInput);
        }
      }
      // Unique list
      usernamesList = [...new Set(usernamesList)];

      for (const username of usernamesList) {
        const [users] = await connection.query('SELECT id FROM users WHERE username = ? AND deleted_at IS NULL AND is_banned = 0', [username]);
        if (users.length === 0) {
          connection.release();
          return res.redirect('/channels/create?error=' + encodeURIComponent(`Пользователь "${username}" не найден.`));
        }
        const teamUserId = users[0].id;
        if (teamUserId === req.session.user.id) {
          connection.release();
          return res.redirect('/channels/create?error=' + encodeURIComponent('Вы не можете добавить себя в команду.'));
        }
        if (!teamUserIds.includes(teamUserId)) {
          teamUserIds.push(teamUserId);
        }
      }
    }

    const [existing] = await connection.query('SELECT id FROM channels WHERE shortname = ?', [shortname]);
    if (existing.length > 0) {
      connection.release();
      return res.redirect('/channels/create?error=' + encodeURIComponent('Это короткое имя уже занято.'));
    }

    const filteredName = req.session.user.staff_role ? name : await wordFilter.filter(name);
    const filteredDescription = req.session.user.staff_role ? description : await wordFilter.filter(description);

    const initialStatus = mod.required ? 'pending_approval' : 'active';
    const rtmpDisabled = mod.required ? 1 : 0;

    const [result] = await connection.query(
      `INSERT INTO channels (user_id, name, description, shortname, bg_color, logo_url, status, rtmp_disabled, is_personal, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        req.session.user.id,
        filteredName,
        filteredDescription,
        shortname,
        '#262626',
        '/images/default_channel_logo.png',
        initialStatus,
        rtmpDisabled,
        channel_type === 'personal' ? 1 : 0
      ]
    );

    const channelId = result.insertId;

    if (channel_type === 'cooperative' && teamUserIds.length > 0) {
      // Invite only — do not force co-owner without acceptance
      for (const teamUserId of teamUserIds) {
        try {
          await createTeamInvite({
            channelId,
            channelName: filteredName,
            inviterId: req.session.user.id,
            inviterUsername: req.session.user.username,
            inviteeId: teamUserId,
            is_reporter: 1,
            is_moderator: 1,
            is_editor: 1,
            is_coowner: 1,
            appUrl: process.env.APP_URL
          });
        } catch (inviteErr) {
          console.error('Team invite on channel create failed:', inviteErr.message || inviteErr);
        }
      }
    }

    if (fpHash) {
      await connection.query(
        'INSERT INTO channel_create_events (fp_hash, ua, user_id, channel_id, created_at) VALUES (?, ?, ?, ?, NOW())',
        [fpHash, ua || null, req.session.user.id, channelId]
      );
    }

    if (mod.required) {
      sendSystemMessage(req.session.user.id, `Телеканал «${filteredName}» (${shortname}). ${CHANNEL_PENDING_NOTICE}`).catch(() => {});
      try {
        emailService.sendDisposableEmailNotice(req.session.user.email, req.session.user.username).catch(() => {});
      } catch (_) {}
    }

    connection.release();
    res.redirect(mod.required ? '/panel,dashboard?pending=1' : '/' + shortname);
  } catch (e) {
    console.error('Error creating channel:', e);
    res.redirect('/channels/create?error=' + encodeURIComponent('Внутренняя ошибка сервера.'));
  }
});

router.get('/channels/transfer/confirm', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).render('error', {
      title: 'Неверная ссылка',
      message: 'Токен передачи не указан или неверен.',
      status: 400
    });
  }

  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT id FROM pending_channel_transfers WHERE token = ?', [token]);
    if (rows.length === 0) {
      connection.release();
      return res.status(404).render('error', {
        title: 'Запрос не найден',
        message: 'Запрос на передачу владения не существует или уже устарел.',
        status: 404
      });
    }

    await connection.query('UPDATE pending_channel_transfers SET email_confirmed = TRUE WHERE token = ?', [token]);
    connection.release();

    res.render('error', {
      title: 'Передача подтверждена',
      message: 'Передача успешно подтверждена вами по почте. Теперь получатель увидит предложение в своей панели и должен принять его для завершения процесса.',
      status: 'OK'
    });
  } catch (e) {
    console.error('Error confirming channel transfer:', e);
    res.status(500).render('error', {
      title: 'Ошибка сервера',
      message: 'Произошла непредвиденная ошибка на сервере.',
      status: 500
    });
  }
});

router.post('/channels/transfer/accept', requireAuth, async (req, res) => {
  const { transfer_id } = req.body;
  if (!transfer_id) {
    return res.status(400).send('Transfer ID is required');
  }

  const userId = req.session.user.id;
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [transferRows] = await connection.query(
      'SELECT * FROM pending_channel_transfers WHERE id = ? AND new_owner_id = ? AND email_confirmed = TRUE FOR UPDATE',
      [transfer_id, userId]
    );

    if (transferRows.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).send('Запрос на передачу не найден или не подтвержден владельцем.');
    }

    const transfer = transferRows[0];
    const channelId = transfer.channel_id;

    const [chanLock] = await connection.query(
      'SELECT id, status, user_id FROM channels WHERE id = ? FOR UPDATE',
      [channelId]
    );
    if (!chanLock.length) {
      await connection.rollback();
      connection.release();
      return res.status(404).send('Канал не найден.');
    }

    const [owned] = await connection.query(
      `SELECT id FROM channels WHERE user_id = ? AND is_personal = FALSE AND status IN ${OWNED_CHANNEL_STATUSES}`,
      [userId]
    );
    const [staffRows] = await connection.query('SELECT role FROM staff WHERE user_id = ?', [userId]);
    const isStaff = staffRows.length > 0;
    const mod = await userRequiresChannelModeration(connection, userId, { isStaff });
    if (!isStaff && owned.length >= 3) {
      await connection.rollback();
      connection.release();
      return res.status(400).send('Вы не можете принять владение этим каналом, так как у вас уже есть 3 кооперативных канала.');
    }

    if (mod.required) {
      // Never clear a banned channel via transfer — only force pending_approval otherwise
      await connection.query(
        `UPDATE channels SET user_id = ?,
         status = CASE WHEN status = 'banned' THEN 'banned' ELSE 'pending_approval' END,
         rtmp_disabled = 1,
         is_live = 0, is_live_1 = 0, is_live_2 = 0, is_live_3 = 0, current_streamer_id = NULL
         WHERE id = ?`,
        [userId, channelId]
      );
    } else {
      await connection.query('UPDATE channels SET user_id = ? WHERE id = ?', [userId, channelId]);
    }

    await connection.query('DELETE FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, userId]);

    await connection.query('DELETE FROM channel_team WHERE channel_id = ? AND user_id = ?', [channelId, transfer.old_owner_id]);
    await connection.query(
      'INSERT INTO channel_team (channel_id, user_id, is_reporter, is_moderator, is_editor, is_coowner) VALUES (?, ?, 1, 0, 1, 0)',
      [channelId, transfer.old_owner_id]
    );

    await connection.query('DELETE FROM pending_channel_transfers WHERE id = ?', [transfer_id]);

    await connection.commit();
    connection.release();
    connection = null;

    if (mod.required) {
      sendSystemMessage(userId, TRANSFER_PENDING_NOTICE).catch(() => {});
    }

    res.json({ success: true });
  } catch (e) {
    console.error('Error accepting channel transfer:', e);
    try {
      if (connection) {
        await connection.rollback();
        connection.release();
      }
    } catch (_) {}
    res.status(500).send('Internal server error');
  }
});

router.post('/channels/transfer/reject', requireAuth, async (req, res) => {
  const { transfer_id } = req.body;
  if (!transfer_id) {
    return res.status(400).send('Transfer ID is required');
  }

  const userId = req.session.user.id;

  try {
    const connection = await pool.getConnection();
    await connection.query('DELETE FROM pending_channel_transfers WHERE id = ? AND new_owner_id = ?', [transfer_id, userId]);
    connection.release();
    res.json({ success: true });
  } catch (e) {
    console.error('Error rejecting channel transfer:', e);
    res.status(500).send('Internal server error');
  }
});

module.exports = router;
