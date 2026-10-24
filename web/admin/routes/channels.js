const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { requireAdminAuth } = require('../middlewares/auth');
const sendSystemMessage = require('../utils/systemMessage');
const { withAppealCta } = require('../utils/appeals');
const { logAction } = require('../utils/logger');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { deletePublicFileIfExists, safeRedirectPath } = require('../utils/safePath');
const { createTeamInvite } = require('../utils/teamInvite');
const { revokeUserStreamAccess, forceKillChannelStream, resetAllChannelStreamKeys } = require('../utils/streamAccess');
const { recordTeamDeparture, assertNoTeamRejoinCooldown } = require('../utils/teamCooldown');

const DEFAULT_CDN_QUOTA_MB = 2048; // 2 GB
const PREMIUM_CDN_QUOTA_MB = 10240; // 10 GB

function resolveCdnQuotaMb(cdnQuotaGb, tier) {
  let quotaMB = cdnQuotaGb ? Math.floor(parseFloat(cdnQuotaGb) * 1024) : DEFAULT_CDN_QUOTA_MB;
  if (!Number.isFinite(quotaMB) || quotaMB < 0) {
    quotaMB = DEFAULT_CDN_QUOTA_MB;
  }
  if (tier >= 2) {
    quotaMB = Math.max(quotaMB, PREMIUM_CDN_QUOTA_MB);
  }
  return quotaMB;
}

// Setup multer for channel avatars
// Setup multer for channel avatars
let storageRoot = process.env.MEDIA_STORAGE_PATH;
if (storageRoot && !path.isAbsolute(storageRoot)) {
  storageRoot = path.resolve(__dirname, '../../', storageRoot);
} else if (!storageRoot) {
  storageRoot = path.join(__dirname, '../../public');
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = path.join(storageRoot, 'images', 'design');
    console.log('[Admin Avatar Upload] Saving to:', dir);
    if (!fs.existsSync(dir)){
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'channel_' + uniqueSuffix + ext);
  }
});
const imageFilter = (req, file, cb) => {
  const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Invalid file type'));
  }
};

const upload = multer({ 
  storage: storage,
  fileFilter: imageFilter,
  limits: { fileSize: 4 * 1024 * 1024 } // 4MB
});

// GET /channels - List all channels
router.get('/channels', requireAdminAuth, async (req, res) => {
  const query = req.query.q || '';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  try {
    const connection = await pool.getConnection();
    
    let countRows, channelsRows;
    if (query.trim() === '') {
      [countRows] = await connection.query('SELECT COUNT(*) as count FROM channels');
      [channelsRows] = await connection.query(`
        SELECT c.*, u.username as owner_username, u.boosty_email as owner_boosty_email 
        FROM channels c
        JOIN users u ON c.user_id = u.id
        ORDER BY c.id DESC LIMIT ? OFFSET ?
      `, [limit, offset]);
    } else {
      const searchPattern = '%' + query + '%';
      [countRows] = await connection.query('SELECT COUNT(*) as count FROM channels WHERE name LIKE ? OR shortname LIKE ?', [searchPattern, searchPattern]);
      [channelsRows] = await connection.query(`
        SELECT c.*, u.username as owner_username, u.boosty_email as owner_boosty_email 
        FROM channels c
        JOIN users u ON c.user_id = u.id
        WHERE c.name LIKE ? OR c.shortname LIKE ?
        ORDER BY c.id DESC LIMIT ? OFFSET ?
      `, [searchPattern, searchPattern, limit, offset]);
    }
    
    connection.release();

    const totalCount = countRows[0].count;
    const totalPages = Math.ceil(totalCount / limit) || 1;

    res.render('channels', {
      pageTitle: 'Все каналы | Админ-панель',
      channels: channelsRows,
      q: query,
      page,
      limit,
      totalPages,
      totalCount,
      baseUrl: '/channels'
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Internal Server Error');
  }
});

// GET /channels/banned - List all banned channels
router.get('/channels/banned', requireAdminAuth, async (req, res) => {
  const query = req.query.q || '';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  try {
    const connection = await pool.getConnection();
    
    let countRows, channelsRows;
    if (query.trim() === '') {
      [countRows] = await connection.query('SELECT COUNT(*) as count FROM channels WHERE status = "banned"');
      [channelsRows] = await connection.query(`
        SELECT c.*, u.username as owner_username 
        FROM channels c
        JOIN users u ON c.user_id = u.id
        WHERE c.status = 'banned'
        ORDER BY c.id DESC LIMIT ? OFFSET ?
      `, [limit, offset]);
    } else {
      const searchPattern = '%' + query + '%';
      [countRows] = await connection.query('SELECT COUNT(*) as count FROM channels WHERE status = "banned" AND (name LIKE ? OR shortname LIKE ?)', [searchPattern, searchPattern]);
      [channelsRows] = await connection.query(`
        SELECT c.*, u.username as owner_username 
        FROM channels c
        JOIN users u ON c.user_id = u.id
        WHERE c.status = 'banned' AND (c.name LIKE ? OR c.shortname LIKE ?)
        ORDER BY c.id DESC LIMIT ? OFFSET ?
      `, [searchPattern, searchPattern, limit, offset]);
    }
    
    connection.release();

    const totalCount = countRows[0].count;
    const totalPages = Math.ceil(totalCount / limit) || 1;

    res.render('channels', {
      pageTitle: 'Заблокированные каналы | Админ-панель',
      channels: channelsRows,
      q: query,
      page,
      limit,
      totalPages,
      totalCount,
      baseUrl: '/channels/banned'
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Internal Server Error');
  }
});

// GET /channels/deleted - List all deleted channels
router.get('/channels/deleted', requireAdminAuth, async (req, res) => {
  const query = req.query.q || '';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  try {
    const connection = await pool.getConnection();
    
    let countRows, channelsRows;
    if (query.trim() === '') {
      [countRows] = await connection.query('SELECT COUNT(*) as count FROM channels WHERE status = "deleted"');
      [channelsRows] = await connection.query(`
        SELECT c.*, u.username as owner_username 
        FROM channels c
        JOIN users u ON c.user_id = u.id
        WHERE c.status = 'deleted'
        ORDER BY c.id DESC LIMIT ? OFFSET ?
      `, [limit, offset]);
    } else {
      const searchPattern = '%' + query + '%';
      [countRows] = await connection.query('SELECT COUNT(*) as count FROM channels WHERE status = "deleted" AND (name LIKE ? OR shortname LIKE ?)', [searchPattern, searchPattern]);
      [channelsRows] = await connection.query(`
        SELECT c.*, u.username as owner_username 
        FROM channels c
        JOIN users u ON c.user_id = u.id
        WHERE c.status = 'deleted' AND (c.name LIKE ? OR c.shortname LIKE ?)
        ORDER BY c.id DESC LIMIT ? OFFSET ?
      `, [searchPattern, searchPattern, limit, offset]);
    }
    
    connection.release();

    const totalCount = countRows[0].count;
    const totalPages = Math.ceil(totalCount / limit) || 1;

    res.render('channels', {
      pageTitle: 'Удаленные каналы | Админ-панель',
      channels: channelsRows,
      q: query,
      page,
      limit,
      totalPages,
      totalCount,
      baseUrl: '/channels/deleted'
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Internal Server Error');
  }
});

// GET /channels/approvals — temp-mail channel moderation queue
router.get('/channels/approvals', requireAdminAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;
    const statusFilter = req.query.status || 'pending';

    const connection = await pool.getConnection();
    let where = "c.status = 'pending_approval'";
    if (statusFilter === 'approved') where = "c.status = 'active' AND c.approved_at IS NOT NULL";
    if (statusFilter === 'rejected') where = "c.status = 'rejected_approval'";
    if (statusFilter === 'all') {
      where = "c.status IN ('pending_approval', 'rejected_approval') OR (c.status = 'active' AND c.approved_at IS NOT NULL)";
    }

    const [[{ total }]] = await connection.query(
      `SELECT COUNT(*) as total FROM channels c WHERE ${where}`
    );
    const [channels] = await connection.query(
      `SELECT c.id, c.name, c.shortname, c.status, c.created_at, c.approved_at, c.is_personal,
              u.id AS owner_id, u.username, u.email, u.email_is_disposable, u.reg_ip, u.last_ip
       FROM channels c
       JOIN users u ON u.id = c.user_id
       WHERE ${where}
       ORDER BY COALESCE(c.approved_at, c.created_at) DESC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    connection.release();

    res.render('channels-approvals', {
      currentPath: '/channels/approvals',
      channels,
      limit,
      page,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      statusFilter
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

router.post('/channels/approvals/:id/approve', requireAdminAuth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query(
      `SELECT c.id, c.name, c.shortname, c.user_id, c.status, u.username
       FROM channels c JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
      [req.params.id]
    );
    if (!rows.length) {
      connection.release();
      req.session.error_msg = 'Канал не найден';
      return res.redirect('/channels/approvals');
    }
    const ch = rows[0];
    if (ch.status !== 'pending_approval' && ch.status !== 'rejected_approval') {
      connection.release();
      req.session.error_msg = 'Канал не в очереди на одобрение';
      return res.redirect('/channels/approvals');
    }
    await connection.query(
      `UPDATE channels SET status = 'active', rtmp_disabled = 0, approved_at = NOW(), approved_by = ?
       WHERE id = ?`,
      [req.session.user.id, ch.id]
    );
    connection.release();
    await sendSystemMessage(
      ch.user_id,
      `Телеканал «${ch.name}» (${ch.shortname}) одобрен администрацией. Канал доступен зрителям, эфир можно запускать.`
    );
    logAction(
      'team',
      req.session.user.username,
      `Одобрил канал "${ch.name}" /${ch.shortname} (владелец ${ch.username})`,
      req.headers['x-forwarded-for'] || null
    );
    req.session.success_msg = 'Канал одобрен';
    res.redirect('/channels/approvals?status=pending');
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

router.post('/channels/approvals/:id/reject', requireAdminAuth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query(
      `SELECT c.id, c.name, c.shortname, c.user_id, c.status, u.username
       FROM channels c JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
      [req.params.id]
    );
    if (!rows.length) {
      connection.release();
      req.session.error_msg = 'Канал не найден';
      return res.redirect('/channels/approvals');
    }
    const ch = rows[0];
    if (ch.status !== 'pending_approval' && ch.status !== 'active') {
      connection.release();
      req.session.error_msg = 'Этот канал нельзя отклонить из текущего статуса';
      return res.redirect('/channels/approvals');
    }
    await connection.query(
      `UPDATE channels SET status = 'rejected_approval', rtmp_disabled = 1,
         is_live = 0, is_live_1 = 0, is_live_2 = 0, is_live_3 = 0, current_streamer_id = NULL,
         approved_at = NULL, approved_by = ?
       WHERE id = ?`,
      [req.session.user.id, ch.id]
    );
    connection.release();
    await sendSystemMessage(
      ch.user_id,
      `Телеканал «${ch.name}» (${ch.shortname}) отклонён администрацией. Канал скрыт от зрителей. По вопросам: обратитесь к администрации этого инстанса`
    );
    logAction(
      'team',
      req.session.user.username,
      `Отклонил канал "${ch.name}" /${ch.shortname} (владелец ${ch.username})`,
      req.headers['x-forwarded-for'] || null
    );
    req.session.success_msg = 'Канал отклонён';
    res.redirect('/channels/approvals?status=pending');
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

// GET /channels/api/users_search - API for user autocomplete
router.get('/channels/api/users_search', requireAdminAuth, async (req, res) => {
  const q = req.query.q || '';
  if (q.length < 1) return res.json([]);
  try {
    const connection = await pool.getConnection();
    const searchPattern = q + '%';
    const [users] = await connection.query('SELECT id, username FROM users WHERE username LIKE ? OR id = ? LIMIT 10', [searchPattern, q]);
    connection.release();
    res.json(users);
  } catch(e) {
    console.error('User search API error:', e);
    res.json([]);
  }
});

// GET /channels/:id/edit - Edit channel page
router.get('/channels/:id/edit', requireAdminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const connection = await pool.getConnection();
    const [channels] = await connection.query(`
      SELECT c.*, u.username as owner_username, u.boosty_email as owner_boosty_email, u.boosty_channel_id as owner_boosty_channel_id 
      FROM channels c 
      JOIN users u ON c.user_id = u.id 
      WHERE c.id = ?
    `, [id]);
    
    if (channels.length === 0) {
      connection.release();
      return res.status(404).send('Канал не найден');
    }
    const channel = channels[0];

    // Get owner's other channels
    const [ownerChannels] = await connection.query(`
      SELECT id, name, shortname, is_personal 
      FROM channels 
      WHERE user_id = ? AND status IN ('active', 'banned')
    `, [channel.user_id]);

    // Get team members
    const [team] = await connection.query(`
      SELECT ct.*, u.username 
      FROM channel_team ct 
      JOIN users u ON ct.user_id = u.id 
      WHERE ct.channel_id = ?
    `, [id]);

    // Get stream key
    const [keys] = await connection.query('SELECT stream_key FROM stream_keys WHERE channel_id = ? LIMIT 1', [id]);
    const streamKey = keys.length > 0 ? keys[0].stream_key : null;

    // Get CDN usage
    const [recRows] = await connection.query('SELECT SUM(size_bytes) as total FROM records WHERE channel_id = ?', [id]);
    const totalBytes = recRows[0].total || 0;
    const usageGB = (totalBytes / (1024 * 1024 * 1024)).toFixed(2);
    
    // Convert quota to GB for display
    const quotaGB = channel.cdn_quota_mb ? (channel.cdn_quota_mb / 1024).toFixed(2) : '2.00';

    // Check if it is a service channel
    const [settings] = await connection.query("SELECT setting_value FROM system_settings WHERE setting_key = 'service_channel_id'");
    const isServiceChannel = settings.length > 0 && settings[0].setting_value == id;

    // Get ban info if banned
    let banInfo = null;
    if (channel.status === 'banned') {
       const [ownerBans] = await connection.query('SELECT banned_until, ban_reason FROM users WHERE id = ?', [channel.user_id]);
       banInfo = ownerBans[0];
    }

    connection.release();

    res.render('channel-edit', {
      pageTitle: `Редактирование канала - ${channel.shortname} (id: ${channel.id})`,
      channel,
      team,
      streamKey,
      usageGB,
      quotaGB,
      isServiceChannel,
      banInfo,
      ownerChannels
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Internal Server Error');
  }
});

// POST /channels/:id/edit - Update channel info
router.post('/channels/:id/edit', requireAdminAuth, (req, res, next) => {
  if (!req.user.is_superadmin && req.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторы не могут изменять данные каналов.' });
  }
  upload.single('avatar')(req, res, (err) => {
    if (err) {
      console.error('[Admin Avatar Upload] Multer error:', err);
      let errorMsg = 'Ошибка загрузки аватара: ';
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          errorMsg += 'размер файла превышает 4 МБ.';
        } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          errorMsg += 'разрешена загрузка только изображений (jpeg, jpg, png, gif, webp).';
        } else {
          errorMsg += err.message;
        }
      } else {
        errorMsg += err.message;
      }
      req.session.error_msg = errorMsg;
      return res.redirect('/channels/' + req.params.id + '/edit');
    }
    next();
  });
}, async (req, res) => {
  console.log('[Admin Avatar Upload] POST received. req.file:', req.file ? req.file.originalname : 'No file');
  console.log('[Admin Edit] req.body:', req.body);
  const { id } = req.params;
  const { name, shortname, description, rtmp_disabled, autopilot_disabled, chat_disabled, design_disabled, team_assign_disabled, coowners_disabled, team_change_disabled } = req.body;
  
  if (name && name.length > 77) {
    req.session.error_msg = 'Ошибка: Название телеканала не должно превышать 77 символов.';
    return res.redirect('/channels/' + id + '/edit');
  }

  if (description && description.length > 200) {
    req.session.error_msg = 'Ошибка: Описание канала не может превышать 200 символов.';
    return res.redirect('/channels/' + id + '/edit');
  }

  if (shortname) {
    const restrictedSlugs = ['login', 'register', 'api', 'news', 'account', 'channels', 'admin', 'panel', 'tv', 'channel', 'messages', 'eula', 'channel_eula', 'rules', 'about', 'feedback', 'speedtest'];
    if (restrictedSlugs.includes(shortname.toLowerCase())) {
      req.session.error_msg = 'Ошибка: Это короткое имя недоступно (зарезервировано системой).';
      return res.redirect('/channels/' + id + '/edit');
    }

    const slugRegex = /^[a-zA-Z0-9_-]+$/;
    if (!slugRegex.test(shortname)) {
      req.session.error_msg = 'Ошибка: Короткое имя может содержать только латинские буквы, цифры, дефис и подчеркивание.';
      return res.redirect('/channels/' + id + '/edit');
    }
  }

  // Check uniqueness (case-insensitive; shortnames are stored lowercase for new/edited values)
  const normalizedShortname = shortname ? String(shortname).toLowerCase() : shortname;
  const [existing] = await pool.query('SELECT id FROM channels WHERE LOWER(shortname) = ? AND id != ?', [normalizedShortname, id]);
  if (existing.length > 0) {
    req.session.error_msg = 'Короткое имя уже занято!';
    return res.redirect('/channels/' + id + '/edit');
  }

  try {
    const { 
      name, shortname, description, 
      rtmp_disabled, autopilot_disabled, chat_disabled, design_disabled,
      team_assign_disabled, coowners_disabled, team_change_disabled,
      cdn_quota_gb, premium_tier, premium_until, boosty_channel_id
    } = req.body;

    let dbPremium = 0;
    let dbVerified = 0;
    let dbPremiumUntil = null;

    const tier = parseInt(premium_tier, 10);
    const premiumManual = tier >= 2 ? 1 : 0;
    const quotaMB = resolveCdnQuotaMb(cdn_quota_gb, tier);
    if (tier === 2) {
      dbVerified = 1;
    } else if (tier === 3) {
      dbPremium = 1;
      dbVerified = 1;
      if (premium_until && premium_until.trim() !== '') {
        dbPremiumUntil = premium_until;
      }
    }

    const connection = await pool.getConnection();

    // Fetch owner information
    const [chRows] = await connection.query('SELECT user_id FROM channels WHERE id = ?', [id]);
    if (chRows.length > 0) {
      const channelOwnerId = chRows[0].user_id;

      // Boosty sync only when premium is not manually granted on this channel
      if (boosty_channel_id !== undefined && premiumManual === 0) {
        const newTargetId = boosty_channel_id ? parseInt(boosty_channel_id, 10) : null;
        await connection.query('UPDATE users SET boosty_channel_id = ? WHERE id = ?', [newTargetId, channelOwnerId]);

        // Sync premium status dynamically across owner's channels if they have active Boosty email
        const [userRows] = await connection.query('SELECT boosty_email FROM users WHERE id = ?', [channelOwnerId]);
        if (userRows.length > 0 && userRows[0].boosty_email) {
          try {
            const { checkSubscriberByEmail } = require('../utils/boosty');
            const subscriber = await checkSubscriberByEmail(userRows[0].boosty_email);

          if (subscriber) {
            const isActive = subscriber.subscribed === true && 
                             subscriber.status === 'active' && 
                             subscriber.level && 
                             subscriber.level.price > 0;
            if (isActive) {
              const nextPayTimeDate = new Date((subscriber.offTime || subscriber.nextPayTime || 0) * 1000);
              
              const [ownerChs] = await connection.query('SELECT id, is_personal, premium_manual FROM channels WHERE user_id = ? AND status IN (\'active\', \'banned\')', [channelOwnerId]);
              
              let activeTargetChannelId = newTargetId;
              if (!activeTargetChannelId && ownerChs.length > 0) {
                const personalCh = ownerChs.find(c => c.is_personal === 1 || c.is_personal === true);
                if (personalCh) {
                  activeTargetChannelId = personalCh.id;
                } else {
                  activeTargetChannelId = ownerChs[0].id;
                }
              }

              for (const ch of ownerChs) {
                if (ch.premium_manual === 1 || ch.premium_manual === true) {
                  continue;
                }
                if (ch.id === activeTargetChannelId) {
                  if (ch.id == id) {
                    dbPremium = 1;
                    dbVerified = 1;
                    dbPremiumUntil = nextPayTimeDate;
                  } else {
                    await connection.query('UPDATE channels SET is_premium = 1, is_verified = 1, premium_until = ?, cdn_quota_mb = GREATEST(IFNULL(cdn_quota_mb, ?), ?) WHERE id = ?', [nextPayTimeDate, DEFAULT_CDN_QUOTA_MB, PREMIUM_CDN_QUOTA_MB, ch.id]);
                  }
                } else {
                  if (ch.id == id) {
                    dbPremium = 0;
                    dbVerified = 0;
                    dbPremiumUntil = null;
                  } else {
                    await connection.query('UPDATE channels SET is_premium = 0, is_verified = 0, premium_until = NULL WHERE id = ?', [ch.id]);
                  }
                }
              }
            }
          }
          } catch (boostyErr) {
            console.error('[Admin] Boosty sync skipped on channel save:', boostyErr.message);
            req.session.error_msg = 'Канал сохранён, но синхронизация Boosty не удалась: ' + boostyErr.message + '. Обновите BOOSTY_* токены в .env.';
          }
        }
      }
    }

    let finalQuotaMB = quotaMB;
    if (dbPremium || dbVerified) {
      finalQuotaMB = Math.max(finalQuotaMB, PREMIUM_CDN_QUOTA_MB);
    }

    let query, params;

    if (req.file) {
      const avatarPath = '/images/design/' + req.file.filename;
      query = 'UPDATE channels SET name = ?, shortname = ?, description = ?, logo_url = ?, rtmp_disabled = ?, autopilot_disabled = ?, autopilot_enabled = CASE WHEN ? = 1 THEN 0 ELSE autopilot_enabled END, chat_disabled = ?, chat_enabled = CASE WHEN ? = 1 THEN 0 ELSE chat_enabled END, design_disabled = ?, team_assign_disabled = ?, coowners_disabled = ?, team_change_disabled = ?, cdn_quota_mb = ?, is_premium = ?, is_verified = ?, premium_until = ?, premium_manual = ? WHERE id = ?';
      params = [
        name, normalizedShortname, description, avatarPath,
        rtmp_disabled ? 1 : 0, 
        autopilot_disabled ? 1 : 0,
        autopilot_disabled ? 1 : 0,
        chat_disabled ? 1 : 0,
        chat_disabled ? 1 : 0,
        design_disabled ? 1 : 0,
        team_assign_disabled ? 1 : 0,
        coowners_disabled ? 1 : 0,
        team_change_disabled ? 1 : 0,
        finalQuotaMB,
        dbPremium,
        dbVerified,
        dbPremiumUntil,
        premiumManual,
        id
      ];
    } else {
      query = 'UPDATE channels SET name = ?, shortname = ?, description = ?, rtmp_disabled = ?, autopilot_disabled = ?, autopilot_enabled = CASE WHEN ? = 1 THEN 0 ELSE autopilot_enabled END, chat_disabled = ?, chat_enabled = CASE WHEN ? = 1 THEN 0 ELSE chat_enabled END, design_disabled = ?, team_assign_disabled = ?, coowners_disabled = ?, team_change_disabled = ?, cdn_quota_mb = ?, is_premium = ?, is_verified = ?, premium_until = ?, premium_manual = ? WHERE id = ?';
      params = [
        name, normalizedShortname, description, 
        rtmp_disabled ? 1 : 0, 
        autopilot_disabled ? 1 : 0,
        autopilot_disabled ? 1 : 0,
        chat_disabled ? 1 : 0,
        chat_disabled ? 1 : 0,
        design_disabled ? 1 : 0,
        team_assign_disabled ? 1 : 0,
        coowners_disabled ? 1 : 0,
        team_change_disabled ? 1 : 0,
        finalQuotaMB,
        dbPremium,
        dbVerified,
        dbPremiumUntil,
        premiumManual,
        id
      ];
    }
    
    await connection.query(query, params);

    // Кооперативный канал + запрет совладельцев → снять роль у всех в команде
    if (coowners_disabled) {
      await connection.query('UPDATE channel_team SET is_coowner = 0 WHERE channel_id = ?', [id]);
    }

    // Если только что запретили RTMP — сразу выкинуть текущий паблишер.
    // Иначе on_publish блокирует лишь новые коннекты, а уже идущий эфир живёт.
    if (rtmp_disabled) {
      try {
        const [snRows] = await connection.query('SELECT shortname FROM channels WHERE id = ?', [id]);
        if (snRows.length > 0) {
          const { kickStream } = require('../utils/mediaServer');
          await kickStream(snRows[0].shortname);
          await connection.query(
            'UPDATE channels SET is_live = 0, is_live_1 = 0, is_live_2 = 0, is_live_3 = 0 WHERE id = ?',
            [id]
          );
          const io = req.app.get('io');
          if (io) {
            io.to('channel_' + id).emit('stream_ended');
          }
        }
      } catch (kickErr) {
        console.error('[Admin] Failed to kick stream after rtmp_disabled:', kickErr.message);
      }
    }

    connection.release();
    
    if (autopilot_disabled) {
      const io = req.app.get('io');
      if (io) {
        io.to('channel_' + id).emit('autopilot_update');
      }
    }
    
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Изменил настройки телеканала "${name}" (ID: ${id})`, userIp);

    req.session.success_msg = 'Канал успешно обновлен!';
    req.session.save(() => {
      res.redirect('/channels/' + id + '/edit');
    });
  } catch (e) {
    console.error(e);
    req.session.error_msg = 'Ошибка сохранения: ' + e.message;
    res.redirect('/channels/' + id + '/edit');
  }
});

// POST /channels/:id/geo_block — set / add / remove / clear denylist countries
router.post('/channels/:id/geo_block', requireAdminAuth, async (req, res) => {
  const { id } = req.params;
  const redirectUrl = safeRedirectPath(req.query.redirect, '/channels/' + id + '/edit');
  try {
    const {
      normalizeCountryList,
      mergeCountryLists,
      removeCountryFromList,
      formatCountryListLabels
    } = require('../utils/geoBlock');

    const action = String(req.body.action || 'set').toLowerCase();
    const countriesRaw = req.body.geo_countries != null ? req.body.geo_countries : req.body.geo_block_countries;
    const singleCountry = req.body.country;
    const reason = String(req.body.geo_block_reason || '').trim().slice(0, 500);
    const showReason = req.body.geo_block_show_reason === '1' || req.body.geo_block_show_reason === 'on' ? 1 : 0;

    const connection = await pool.getConnection();
    const adminId = req.session.user ? req.session.user.id : null;
    const [ch] = await connection.query('SELECT id, name, user_id, geo_block_countries, geo_block_reason, geo_block_show_reason FROM channels WHERE id = ?', [id]);
    if (ch.length === 0) {
      connection.release();
      req.session.error_msg = 'Канал не найден';
      return res.redirect(redirectUrl);
    }

    let next = ch[0].geo_block_countries || null;
    let nextReason = ch[0].geo_block_reason || null;
    let nextShow = ch[0].geo_block_show_reason ? 1 : 0;
    if (action === 'clear') {
      next = null;
      nextReason = null;
      nextShow = 0;
    } else if (action === 'remove') {
      next = removeCountryFromList(next, singleCountry || countriesRaw);
      if (!next) {
        nextReason = null;
        nextShow = 0;
      }
    } else if (action === 'add') {
      next = mergeCountryLists(next, countriesRaw || singleCountry);
      if (reason) {
        nextReason = reason;
        nextShow = showReason;
      }
    } else {
      next = normalizeCountryList(countriesRaw);
      if (!next) {
        nextReason = null;
        nextShow = 0;
      } else {
        if (!reason) {
          connection.release();
          req.session.error_msg = 'Укажите причину гео-блокировки';
          return res.redirect(redirectUrl);
        }
        nextReason = reason;
        nextShow = showReason;
      }
    }

    await connection.query(
      'UPDATE channels SET geo_block_countries = ?, geo_block_reason = ?, geo_block_show_reason = ?, geo_blocked_by = ? WHERE id = ?',
      [next, nextReason, nextShow, next ? adminId : null, id]
    );
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    const label = next ? formatCountryListLabels(next) : '';
    if (next && (action === 'set' || action === 'add') && ch[0].user_id) {
      let ownerMsg = `Ваш телеканал «${ch[0].name}» скрыт для зрителей из стран: ${label}.`;
      if (nextShow && nextReason) ownerMsg += `\nПричина: ${nextReason}`;
      await sendSystemMessage(ch[0].user_id, withAppealCta(ownerMsg, 'geo_block', id));
    } else if (!next && ch[0].user_id && (action === 'clear' || action === 'remove')) {
      await sendSystemMessage(ch[0].user_id, `Гео-ограничения для телеканала «${ch[0].name}» сняты.`);
    }
    logAction(
      'admin',
      req.session.user.username,
      next
        ? `Гео-блок телеканала "${ch[0].name}" (ID: ${id}): ${label}${nextReason ? '. Причина: ' + nextReason : ''}${nextShow ? ' [видна пользователю]' : ''}`
        : `Снял гео-блок с телеканала "${ch[0].name}" (ID: ${id})`,
      userIp
    );
    connection.release();
    req.session.success_msg = next
      ? `Гео-блок сохранён: ${label}`
      : 'Гео-блок снят';
    res.redirect(redirectUrl);
  } catch (e) {
    console.error('[Admin] geo_block Error:', e);
    req.session.error_msg = 'Ошибка сохранения гео-блока';
    res.redirect(redirectUrl);
  }
});

// POST /channels/:id/delete_avatar
router.post('/channels/:id/delete_avatar', requireAdminAuth, async (req, res) => {
  if (!req.user.is_superadmin && req.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  }
  const { id } = req.params;
  try {
    const [c] = await pool.query('SELECT name FROM channels WHERE id = ?', [id]);
    const cName = c.length > 0 ? c[0].name : 'Unknown';
    await pool.query('UPDATE channels SET logo_url = "/images/default_channel_logo.png" WHERE id = ?', [id]);
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Сбросил аватар телеканала "${cName}" (ID: ${id})`, userIp);
    req.session.success_msg = 'Аватар удален!';
    res.redirect('/channels/' + id + '/edit');
  } catch(e) {
    req.session.error_msg = 'Ошибка: ' + e.message;
    res.redirect('/channels/' + id + '/edit');
  }
});

// POST /channels/:id/toggle_status
router.post('/channels/:id/toggle_status', requireAdminAuth, async (req, res) => {
  const { id } = req.params;
  const redirectUrl = safeRedirectPath(req.query.redirect, '/channels/' + id + '/edit');
  const { action_type, ban_type, banned_until, ban_reason } = req.body;

  try {
    const connection = await pool.getConnection();
    const [c] = await connection.query('SELECT status, user_id, name, shortname, id FROM channels WHERE id = ?', [id]);
    
    if (c.length > 0) {
      const channel = c[0];
      const adminId = req.session.user ? req.session.user.id : 1;
      
      if (action_type === 'ban') {
        // Гео-блокировка: канал остаётся active, скрыт только в указанных странах
        if (ban_type === 'geo') {
          const {
            normalizeCountryList,
            mergeCountryLists,
            formatCountryListLabels
          } = require('../utils/geoBlock');
          const [full] = await connection.query('SELECT geo_block_countries FROM channels WHERE id = ?', [id]);
          const existing = full.length ? full[0].geo_block_countries : null;
          const selected = req.body.geo_countries != null ? req.body.geo_countries : req.body.geo_block_countries;
          const next = mergeCountryLists(existing, selected) || normalizeCountryList(selected);
          const reason = String(req.body.geo_block_reason || '').trim().slice(0, 500);
          const showReason = req.body.geo_block_show_reason === '1' || req.body.geo_block_show_reason === 'on' ? 1 : 0;
          if (!next) {
            connection.release();
            req.session.error_msg = 'Выберите хотя бы одну страну для гео-блока';
            return res.redirect(redirectUrl);
          }
          if (!reason) {
            connection.release();
            req.session.error_msg = 'Укажите причину гео-блокировки';
            return res.redirect(redirectUrl);
          }
          await connection.query(
            'UPDATE channels SET geo_block_countries = ?, geo_block_reason = ?, geo_block_show_reason = ?, geo_blocked_by = ? WHERE id = ?',
            [next, reason, showReason, adminId, id]
          );
          const label = formatCountryListLabels(next);
          let ownerMsg = `Ваш телеканал «${channel.name}» скрыт для зрителей из стран: ${label}.`;
          if (showReason) ownerMsg += `\nПричина: ${reason}`;
          await sendSystemMessage(channel.user_id, withAppealCta(ownerMsg, 'geo_block', id));
          req.session.success_msg = `Гео-блок установлен: ${label}. Канал полностью не забанен.`;
          const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
          logAction(
            'admin',
            req.session.user.username,
            `Гео-блок телеканала "${channel.name}" (ID: ${id}): ${label}. Причина: ${reason}${showReason ? ' [видна пользователю]' : ''}`,
            userIp
          );
        } else {
          const parsedUntil = (ban_type === 'temporary' && banned_until) ? banned_until : null;
          await connection.query('UPDATE channels SET status = ?, banned_until = ?, ban_reason = ?, banned_by = ? WHERE id = ?', ['banned', parsedUntil, ban_reason, adminId, id]);
          
          let messageText = 'Ваш телеканал заблокирован навсегда.';
          if (parsedUntil) {
            const d = new Date(parsedUntil);
            const formattedDate = `${d.getDate().toString().padStart(2, '0')}.${(d.getMonth() + 1).toString().padStart(2, '0')}.${d.getFullYear()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
            messageText = `Ваш телеканал заблокирован до ${formattedDate}.`;
          }
          if (ban_reason) messageText += `\nПричина: ${ban_reason}`;
          messageText = `Телеканал «${channel.name}». ${messageText}`;
          
          await sendSystemMessage(channel.user_id, withAppealCta(messageText, 'channel_ban', id));

          // Cut live publish immediately (MediaMTX kick via web app)
          try {
            const axios = require('axios');
            const webBase = process.env.WEB_INTERNAL_URL || 'http://app:3001';
            const rtmpPass = process.env.RTMP_API_PASS || '';
            await axios.post(
              `${webBase}/api/internal/rtmp/admin_kill`,
              {
                channelId: channel.id,
                adminUsername: (req.session.user && req.session.user.username) || 'Админ'
              },
              {
                headers: {
                  'Content-Type': 'application/json',
                  'X-RTMP-Internal': rtmpPass
                },
                timeout: 10000
              }
            );
          } catch (killErr) {
            console.error('[Admin] kill on channel ban failed, local fallback:', killErr.message);
            try {
              await forceKillChannelStream(connection, {
                channelId: channel.id,
                shortname: channel.shortname,
                io: null
              });
            } catch (e2) {
              console.error('[Admin] local forceKill on channel ban failed:', e2.message);
            }
          }

          req.session.success_msg = 'Канал заблокирован!';
          const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
          logAction('admin', req.session.user.username, `Заблокировал телеканал "${channel.name}" (ID: ${id})`, userIp);
        }
      } else if (action_type === 'edit_ban') {
        if (channel.status !== 'banned') {
          connection.release();
          req.session.error_msg = 'Канал не заблокирован';
          return res.redirect(redirectUrl);
        }
        const parsedUntil = (ban_type === 'temporary' && banned_until) ? banned_until : null;
        await connection.query(
          'UPDATE channels SET banned_until = ?, ban_reason = ? WHERE id = ? AND status = ?',
          [parsedUntil, ban_reason || null, id, 'banned']
        );
        req.session.success_msg = 'Параметры блокировки канала обновлены';
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        logAction('admin', req.session.user.username, `Обновил бан телеканала "${channel.name}" (ID: ${id})`, userIp);
      } else if (action_type === 'unban') {
        await connection.query('UPDATE channels SET status = ?, banned_until = NULL, ban_reason = NULL, banned_by = NULL WHERE id = ?', ['active', id]);
        await sendSystemMessage(channel.user_id, 'Ваш телеканал был разблокирован.');
        req.session.success_msg = 'Канал разблокирован!';
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        logAction('admin', req.session.user.username, `Разблокировал телеканал "${channel.name}" (ID: ${id})`, userIp);
      } else {
        const newStatus = channel.status === 'banned' ? 'active' : 'banned';
        await connection.query('UPDATE channels SET status = ? WHERE id = ?', [newStatus, id]);
        req.session.success_msg = 'Статус изменен!';
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        logAction('admin', req.session.user.username, `Изменил статус телеканала "${channel.name}" (ID: ${id}) на ${newStatus}`, userIp);
      }
    }
    
    connection.release();
    res.redirect(redirectUrl);
  } catch(e) {
    console.error(e);
    req.session.error_msg = 'Ошибка изменения статуса';
    res.redirect(redirectUrl);
  }
});

function deleteFileIfExistsAdmin(fileUrl) {
  deletePublicFileIfExists(fileUrl, storageRoot);
}

// POST /channels/:id/delete
router.post('/channels/:id/delete', requireAdminAuth, async (req, res) => {
  if (!req.user.is_superadmin && req.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  }
  const { id } = req.params;
  const redirectUrl = safeRedirectPath(req.query.redirect, '/channels/' + id + '/edit');
  try {
    const connection = await pool.getConnection();
    const [c] = await connection.query('SELECT status, deleted_at, logo_url, bg_url, name FROM channels WHERE id = ?', [id]);
    if (c.length > 0) {
      if (c[0].status === 'deleted' || c[0].deleted_at !== null) {
        // Отменить удаление (если канал был удален юзером или при удалении пользователя)
        const channel = c[0];
        await connection.query('UPDATE channels SET status = ?, deleted_at = NULL, deleted_by_admin = 0 WHERE id = ?', ['active', id]);
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        logAction('admin', req.session.user.username, `Отменил удаление телеканала "${channel.name}" (ID: ${id})`, userIp);
        connection.release();
        req.session.success_msg = 'Канал восстановлен!';
        return res.redirect(redirectUrl);
      } else {
        // Немедленное физическое удаление (если админ удаляет активный или забаненный канал)
        const channel = c[0];
        
        // Удаляем файлы записей
        const [records] = await connection.query('SELECT video_url, thumbnail_url FROM records WHERE channel_id = ?', [id]);
        for (const record of records) {
          deleteFileIfExistsAdmin(record.video_url);
          deleteFileIfExistsAdmin(record.thumbnail_url);
        }
        
        // Удаляем файлы оформления
        deleteFileIfExistsAdmin(channel.logo_url);
        deleteFileIfExistsAdmin(channel.bg_url);
        
        // Удаляем запись из БД (КАСКАДНО удалит связанные записи)
        await connection.query('DELETE FROM channels WHERE id = ?', [id]);
        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        logAction('admin', req.session.user.username, `Полностью удалил телеканал "${channel.name}" (ID: ${id})`, userIp);
        connection.release();
        req.session.success_msg = 'Канал полностью удален!';
        // Перенаправляем на список каналов, так как текущего больше нет
        return res.redirect('/channels');
      }
    }
    connection.release();
    res.redirect('/channels');
  } catch(e) {
    console.error(e);
    res.redirect(redirectUrl);
  }
});

// POST /channels/:id/kill_stream — emergency cut live broadcast (admins + mods)
router.post('/channels/:id/kill_stream', requireAdminAuth, async (req, res) => {
  const { id } = req.params;
  const redirectUrl = '/channels/' + id + '/edit';
  try {
    const connection = await pool.getConnection();
    const [ch] = await connection.query('SELECT id, name, shortname, is_live FROM channels WHERE id = ?', [id]);
    if (ch.length === 0) {
      connection.release();
      req.session.error_msg = 'Канал не найден';
      return res.redirect(redirectUrl);
    }

    const channel = ch[0];
    const axios = require('axios');
    const webBase = process.env.WEB_INTERNAL_URL || 'http://app:3001';
    const rtmpPass = process.env.RTMP_API_PASS || '';

    let killOk = false;
    try {
      const resp = await axios.post(
        `${webBase}/api/internal/rtmp/admin_kill`,
        {
          channelId: channel.id,
          adminUsername: (req.session.user && req.session.user.username) || 'Админ'
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-RTMP-Internal': rtmpPass
          },
          timeout: 10000
        }
      );
      killOk = resp.status === 200 && resp.data && resp.data.success;
    } catch (callErr) {
      console.error('[Admin] admin_kill via web app failed, falling back to local kick:', callErr.message);
      try {
        const { kickStream } = require('../utils/mediaServer');
        await kickStream(channel.shortname);
        await connection.query(
          'UPDATE channels SET is_live = 0, is_live_1 = 0, is_live_2 = 0, is_live_3 = 0, live_title = NULL, current_streamer_id = NULL WHERE id = ?',
          [id]
        );
        killOk = true;
      } catch (fallbackErr) {
        console.error('[Admin] Local kick fallback failed:', fallbackErr.message);
      }
    }

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction(
      'admin',
      req.session.user.username,
      `Принудительно отключил эфир телеканала "${channel.name}" (ID: ${id})`,
      userIp
    );
    connection.release();

    if (killOk) {
      req.session.success_msg = 'Эфир принудительно отключён';
    } else {
      req.session.error_msg = 'Не удалось отключить эфир — проверьте MediaMTX / логи';
    }
    res.redirect(redirectUrl);
  } catch (e) {
    console.error('[Admin] kill_stream Error:', e);
    req.session.error_msg = 'Ошибка при отключении эфира';
    res.redirect(redirectUrl);
  }
});

// POST /channels/:id/reset_stream_key
router.post('/channels/:id/reset_stream_key', requireAdminAuth, async (req, res) => {
  if (!req.user.is_superadmin && req.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  }
  const { id } = req.params;
  try {
    const connection = await pool.getConnection();
    const [ch] = await connection.query('SELECT user_id, name, shortname FROM channels WHERE id = ?', [id]);
    if (ch.length > 0) {
      await resetAllChannelStreamKeys(connection, parseInt(id, 10), ch[0].user_id, ch[0].user_id);
      try {
        await forceKillChannelStream(connection, {
          channelId: parseInt(id, 10),
          shortname: ch[0].shortname,
          io: req.app.get('io')
        });
      } catch (kickErr) {
        console.error('[Admin] kick after reset_stream_key:', kickErr.message);
      }
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      logAction('admin', req.session.user.username, `Сбросил все ключи вещания для телеканала "${ch[0].name}" (ID: ${id})`, userIp);
    }
    connection.release();
    req.session.success_msg = 'Все ключи канала сброшены, эфир отключён!';
    res.redirect('/channels/' + id + '/edit');
  } catch(e) {
    console.error(e);
    req.session.error_msg = 'Ошибка при сбросе ключей';
    res.redirect('/channels/' + id + '/edit');
  }
});

// POST /channels/:id/toggle_service
router.post('/channels/:id/toggle_service', requireAdminAuth, async (req, res) => {
  if (!req.user.is_superadmin && req.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  }
  const { id } = req.params;
  try {
    const connection = await pool.getConnection();
    const [sets] = await connection.query("SELECT setting_value FROM system_settings WHERE setting_key = 'service_channel_id'");
    
    // First, clear any existing service channel
    await connection.query("DELETE FROM system_settings WHERE setting_key = 'service_channel_id'");
    
    // If it was not this channel, insert it (toggle on)
    if (!(sets.length > 0 && sets[0].setting_value == id)) {
      await connection.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('service_channel_id', ?)", [id]);
    }
    
    connection.release();
    req.session.success_msg = 'Служебный канал изменен!';
    res.redirect('/channels/' + id + '/edit');
  } catch(e) {
    res.redirect('/channels/' + id + '/edit');
  }
});

// POST /channels/:id/change_owner
router.post('/channels/:id/change_owner', requireAdminAuth, async (req, res) => {
  if (!req.user.is_superadmin && req.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  }
  const { id } = req.params;
  const { new_owner } = req.body;
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT id, username FROM users WHERE id = ? OR username = ?', [new_owner, new_owner]);
    if (users.length > 0) {
      const [c] = await connection.query('SELECT name FROM channels WHERE id = ?', [id]);
      const cName = c.length > 0 ? c[0].name : 'Unknown';
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      
      await connection.query('UPDATE channels SET user_id = ? WHERE id = ?', [users[0].id, id]);
      logAction('admin', req.session.user.username, `Изменил владельца телеканала "${cName}" (ID: ${id}) на пользователя "${users[0].username || users[0].id}"`, userIp);
      
      req.session.success_msg = 'Владелец изменен!';
    } else {
      req.session.error_msg = 'Пользователь не найден';
    }
    connection.release();
    res.redirect('/channels/' + id + '/edit');
  } catch(e) {
    req.session.error_msg = 'Ошибка: ' + e.message;
    res.redirect('/channels/' + id + '/edit');
  }
});

// POST /channels/:id/add_team
router.post('/channels/:id/add_team', requireAdminAuth, async (req, res) => {
  if (!req.user.is_superadmin && req.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  }
  const { id } = req.params;
  const { team_user, is_reporter, is_moderator, is_editor } = req.body;
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT id, username FROM users WHERE id = ? OR username = ?', [team_user, team_user]);
    if (users.length > 0) {
      const uId = users[0].id;
      
      const [c] = await connection.query('SELECT name FROM channels WHERE id = ?', [id]);
      const cName = c.length > 0 ? c[0].name : 'Unknown';
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;

      if (!is_reporter && !is_moderator && !is_editor) {
        // remove
        await connection.query('DELETE FROM channel_team WHERE channel_id = ? AND user_id = ?', [id, uId]);
        await connection.query(
          "UPDATE pending_team_invites SET status = 'cancelled' WHERE channel_id = ? AND invitee_id = ? AND status = 'pending'",
          [id, uId]
        );
        try {
          await recordTeamDeparture(connection, parseInt(id, 10), uId);
        } catch (cdErr) {
          console.error('[Admin] record team cooldown:', cdErr.message);
        }
        try {
          const [sn] = await connection.query('SELECT shortname FROM channels WHERE id = ?', [id]);
          await revokeUserStreamAccess(connection, {
            channelId: parseInt(id, 10),
            userId: uId,
            shortname: sn.length ? sn[0].shortname : null,
            io: req.app.get('io')
          });
        } catch (revErr) {
          console.error('[Admin] revoke stream on team remove:', revErr.message);
        }
        logAction('admin', req.session.user.username, `Удалил пользователя "${users[0].username || users[0].id}" из команды телеканала "${cName}" (ID: ${id})`, userIp);
        req.session.success_msg = 'Пользователь удален из команды';
      } else {
        const rep = is_reporter ? 1 : 0;
        const mod = is_moderator ? 1 : 0;
        const ed = is_editor ? 1 : 0;
        const [existing] = await connection.query('SELECT user_id, is_coowner FROM channel_team WHERE channel_id = ? AND user_id = ?', [id, uId]);
        if (existing.length > 0) {
          await connection.query(
            'UPDATE channel_team SET is_reporter = ?, is_moderator = ?, is_editor = ? WHERE channel_id = ? AND user_id = ?',
            [rep, mod, ed, id, uId]
          );
          const stillCanStream = existing[0].is_coowner == 1 || rep === 1;
          if (!stillCanStream) {
            try {
              const [sn] = await connection.query('SELECT shortname FROM channels WHERE id = ?', [id]);
              await revokeUserStreamAccess(connection, {
                channelId: parseInt(id, 10),
                userId: uId,
                shortname: sn.length ? sn[0].shortname : null,
                io: req.app.get('io')
              });
            } catch (revErr) {
              console.error('[Admin] revoke stream on role update:', revErr.message);
            }
          }
          logAction('admin', req.session.user.username, `Изменил права пользователя "${users[0].username || users[0].id}" в команде телеканала "${cName}" (ID: ${id})`, userIp);
          req.session.success_msg = 'Команда обновлена!';
        } else {
          connection.release();
          try {
            await createTeamInvite({
              channelId: parseInt(id, 10),
              channelName: cName,
              inviterId: req.session.user.id,
              inviterUsername: req.session.user.username,
              inviteeId: uId,
              is_reporter: rep,
              is_moderator: mod,
              is_editor: ed,
              is_coowner: 0,
              appUrl: process.env.APP_URL
            });
          } catch (invErr) {
            if (invErr && invErr.code === 'TEAM_COOLDOWN') {
              req.session.error_msg = invErr.message;
              return res.redirect('/channels/' + id + '/edit');
            }
            throw invErr;
          }
          logAction('admin', req.session.user.username, `Пригласил пользователя "${users[0].username || users[0].id}" в команду телеканала "${cName}" (ID: ${id})`, userIp);
          req.session.success_msg = 'Приглашение отправлено пользователю';
          return res.redirect('/channels/' + id + '/edit');
        }
      }
    } else {
      req.session.error_msg = 'Пользователь не найден';
    }
    connection.release();
    res.redirect('/channels/' + id + '/edit');
  } catch(e) {
    req.session.error_msg = 'Ошибка: ' + e.message;
    res.redirect('/channels/' + id + '/edit');
  }
});

// POST /channels/:id/edit_coowners
router.post('/channels/:id/edit_coowners', requireAdminAuth, async (req, res) => {
  if (!req.user.is_superadmin && req.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  }
  const { id } = req.params;
  const { coowner_user, is_coowner } = req.body;
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.query('SELECT id, username FROM users WHERE id = ? OR username = ?', [coowner_user, coowner_user]);
    if (users.length > 0) {
      const uId = users[0].id;
      
      const [c] = await connection.query('SELECT name FROM channels WHERE id = ?', [id]);
      const cName = c.length > 0 ? c[0].name : 'Unknown';
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;

      if (!is_coowner) {
        // remove co-owner status
        await connection.query('UPDATE channel_team SET is_coowner = 0 WHERE channel_id = ? AND user_id = ?', [id, uId]);
        const [rows] = await connection.query('SELECT is_reporter, is_moderator, is_editor FROM channel_team WHERE channel_id = ? AND user_id = ?', [id, uId]);
        let stillCanStream = false;
        let removedFromTeam = false;
        if (rows.length > 0 && rows[0].is_reporter === 0 && rows[0].is_moderator === 0 && rows[0].is_editor === 0) {
          await connection.query('DELETE FROM channel_team WHERE channel_id = ? AND user_id = ?', [id, uId]);
          removedFromTeam = true;
        } else if (rows.length > 0) {
          stillCanStream = rows[0].is_reporter == 1;
        } else {
          removedFromTeam = true;
        }
        if (removedFromTeam) {
          try {
            await recordTeamDeparture(connection, parseInt(id, 10), uId);
          } catch (cdErr) {
            console.error('[Admin] record team cooldown after coowner remove:', cdErr.message);
          }
        }
        if (!stillCanStream) {
          try {
            const [sn] = await connection.query('SELECT shortname FROM channels WHERE id = ?', [id]);
            await revokeUserStreamAccess(connection, {
              channelId: parseInt(id, 10),
              userId: uId,
              shortname: sn.length ? sn[0].shortname : null,
              io: req.app.get('io')
            });
          } catch (revErr) {
            console.error('[Admin] revoke stream after coowner remove:', revErr.message);
          }
        }
        logAction('admin', req.session.user.username, `Удалил права со-владельца у пользователя "${users[0].username || users[0].id}" для телеканала "${cName}" (ID: ${id})`, userIp);
        req.session.success_msg = 'Пользователь удален из со-владельцев';
      } else {
        // add co-owner status
        const [existing] = await connection.query(
          'SELECT user_id FROM channel_team WHERE channel_id = ? AND user_id = ?',
          [id, uId]
        );
        if (existing.length === 0) {
          try {
            await assertNoTeamRejoinCooldown(connection, parseInt(id, 10), uId);
          } catch (cdErr) {
            connection.release();
            req.session.error_msg = cdErr.message;
            return res.redirect('/channels/' + id + '/edit');
          }
        }
        await connection.query('INSERT INTO channel_team (channel_id, user_id, is_coowner, is_editor, is_reporter, is_moderator) VALUES (?, ?, 1, 1, 1, 1) ON DUPLICATE KEY UPDATE is_coowner = 1', [id, uId]);
        logAction('admin', req.session.user.username, `Назначил пользователя "${users[0].username || users[0].id}" со-владельцем телеканала "${cName}" (ID: ${id})`, userIp);
        req.session.success_msg = 'Со-владелец добавлен!';
      }
    } else {
      req.session.error_msg = 'Пользователь не найден';
    }
    connection.release();
    res.redirect('/channels/' + id + '/edit');
  } catch(e) {
    req.session.error_msg = 'Ошибка: ' + e.message;
    res.redirect('/channels/' + id + '/edit');
  }
});

// POST /channels/:id/toggle_personal - Toggle channel is_personal status
router.post('/channels/:id/toggle_personal', requireAdminAuth, async (req, res) => {
  if (!req.user.is_superadmin && req.user.staff_role === 'moderator') {
    return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторы не могут изменять данные каналов.' });
  }
  const { id } = req.params;
  try {
    const connection = await pool.getConnection();
    const [channels] = await connection.query('SELECT name, is_personal FROM channels WHERE id = ?', [id]);
    if (channels.length > 0) {
      const channel = channels[0];
      const newStatus = channel.is_personal ? 0 : 1;
      await connection.query('UPDATE channels SET is_personal = ? WHERE id = ?', [newStatus, id]);
      
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      logAction('admin', req.session.user.username, `Изменил тип телеканала "${channel.name}" (ID: ${id}) на ${newStatus ? 'Личный' : 'Кооперативный'}`, userIp);
      
      req.session.success_msg = `Тип канала успешно изменен на ${newStatus ? 'Личный' : 'Кооперативный'}!`;
    } else {
      req.session.error_msg = 'Канал не найден';
    }
    connection.release();
    res.redirect('/channels/' + id + '/edit');
  } catch(e) {
    req.session.error_msg = 'Ошибка: ' + e.message;
    res.redirect('/channels/' + id + '/edit');
  }
});

module.exports = router;

