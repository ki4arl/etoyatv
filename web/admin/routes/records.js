const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { logAction } = require('../utils/logger');
const { redirectBack } = require('../utils/safeRedirect');
const sendSystemMessage = require('../utils/systemMessage');
const { withAppealCta } = require('../utils/appeals');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { deletePublicFileIfExists, safeResolvePublic } = require('../utils/safePath');

const publicRoot = path.join(__dirname, '../public');
const uploadDir = path.join(publicRoot, 'uploads/records');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

function unlinkRecordFiles(record) {
  if (!record) return;
  if (record.video_url) deletePublicFileIfExists(record.video_url, publicRoot, { ignoreDefaults: false });
  if (record.thumbnail_url) deletePublicFileIfExists(record.thumbnail_url, publicRoot, { ignoreDefaults: false });
  if (record.hls_url) {
    const hlsFile = safeResolvePublic(record.hls_url, publicRoot);
    if (hlsFile) {
      const hlsDir = path.dirname(hlsFile);
      if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true });
    }
  }
}


const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ['.mp4', '.webm', '.mkv', '.mov', '.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.mp4';
    cb(null, 'record_' + Date.now() + '_' + Math.floor(Math.random() * 1000) + safeExt);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const okExt = ['.mp4', '.webm', '.mkv', '.mov', '.jpg', '.jpeg', '.png', '.webp'].includes(ext);
    const okMime = /^(video|image)\//.test(String(file.mimetype || ''));
    if (okExt && okMime) return cb(null, true);
    cb(new Error('Недопустимый тип файла'));
  }
});

// GET /records - List all records
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const search = req.query.q || '';

    let whereClause = '';
    let queryParams = [];
    
    if (search) {
      whereClause = 'WHERE r.title LIKE ? OR r.description LIKE ?';
      const searchParam = `%${search}%`;
      queryParams.push(searchParam, searchParam);
    }

    const countQuery = `SELECT COUNT(*) as count FROM records r ${whereClause}`;
    const [countRows] = await pool.query(countQuery, queryParams);
    const totalCount = countRows[0].count;
    const totalPages = Math.ceil(totalCount / limit) || 1;

    const dataQuery = `
      SELECT r.*, c.name as channel_name 
      FROM records r
      LEFT JOIN channels c ON r.channel_id = c.id
      ${whereClause}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `;
    const finalParams = [...queryParams, limit, offset];
    const [records] = await pool.query(dataQuery, finalParams);

    res.render('records', {
      currentPath: req.originalUrl.split('?')[0],
      pageTitle: 'Записи | Админ-панель',
      records,
      page,
      limit,
      totalPages,
      totalCount,
      q: search,
      user: req.session.user
    });

  } catch (error) {
    console.error('Error fetching records:', error);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

// GET /records/:id/edit - Edit record page
router.get('/:id/edit', async (req, res) => {
  if (req.user && !req.user.is_superadmin && req.user.staff_role === 'moderator') return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  try {
    const { id } = req.params;
    const [rows] = await pool.query(`
      SELECT r.*, c.name as channel_name 
      FROM records r
      LEFT JOIN channels c ON r.channel_id = c.id
      WHERE r.id = ?
    `, [id]);

    if (rows.length === 0) {
      req.session.error_msg = 'Запись не найдена';
      return res.redirect('/records');
    }

    const record = rows[0];

    // Calculate sizes from HLS folder depending on stream type
    let sdSize = 0;
    let highSize = 0;
    let lowSize = 0;

    if (record.hls_url) {
      const hlsDir = path.join(__dirname, '../public', path.dirname(record.hls_url));
      
      const getDirSize = (dirPath) => {
        let size = 0;
        if (fs.existsSync(dirPath)) {
          const files = fs.readdirSync(dirPath);
          for (let i = 0; i < files.length; i++) {
            const filePath = path.join(dirPath, files[i]);
            const stats = fs.statSync(filePath);
            if (stats.isFile()) {
              size += stats.size;
            } else if (stats.isDirectory()) {
              size += getDirSize(filePath);
            }
          }
        }
        return size;
      };

      sdSize = getDirSize(path.join(hlsDir, 'sd'));
      highSize = getDirSize(path.join(hlsDir, 'high'));
      lowSize = getDirSize(path.join(hlsDir, 'low'));
    }

    res.render('records-edit', {
      currentPath: '/records',
      pageTitle: 'Редактирование записи',
      record,
      sdSize,
      highSize,
      lowSize,
      user: req.session.user
    });

  } catch (error) {
    console.error('Error loading record edit page:', error);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

// POST /records/:id/edit - Save changes and optionally replace video
router.post('/:id/edit', upload.single('video'), async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, is_18_plus } = req.body;
    const is18Plus = is_18_plus === 'on' ? 1 : 0;

    if (!title) {
      req.session.error_msg = 'Заголовок не может быть пустым';
      return redirectBack(req, res, '/');
    }

    if (String(title).trim().length > 100) {
      req.session.error_msg = 'Название записи не должно превышать 100 символов';
      return redirectBack(req, res, '/');
    }

    if (description && description.length > 200) {
      req.session.error_msg = 'Краткое описание не может превышать 200 символов';
      return redirectBack(req, res, '/');
    }

    const [rows] = await pool.query('SELECT * FROM records WHERE id = ?', [id]);
    if (rows.length === 0) {
      req.session.error_msg = 'Запись не найдена';
      return res.redirect('/records');
    }
    const oldRecord = rows[0];

    let updates = ['title = ?', 'description = ?', 'is_18_plus = ?'];
    let params = [title.trim(), description ? description.trim() : '', is18Plus];

    // If new video uploaded
    if (req.file) {
      const newVideoUrl = '/uploads/records/' + req.file.filename;
      const newSize = req.file.size;
      const thumbnailFilename = 'thumb_' + path.parse(req.file.filename).name + '.jpg';
      const newThumbnailUrl = '/uploads/records/' + thumbnailFilename;
      
      updates.push('video_url = ?', 'size_bytes = ?', 'thumbnail_url = ?', 'hls_url = NULL', 'processing_status = "pending"');
      params.push(newVideoUrl, newSize, newThumbnailUrl);

      // Delete old video, old thumbnail, and HLS
      unlinkRecordFiles(oldRecord);
    }

    params.push(id);
    await pool.query(`UPDATE records SET ${updates.join(', ')} WHERE id = ?`, params);

    const [cRows] = await pool.query('SELECT name FROM channels WHERE id = ?', [oldRecord.channel_id]);
    const channelName = cRows.length > 0 ? cRows[0].name : 'Unknown';
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Изменил видеозапись "${title.trim()}" (ID: ${id}) телеканала "${channelName}"`, userIp);

    req.session.success_msg = 'Запись успешно сохранена';
    res.redirect('/records/' + id + '/edit');

  } catch (error) {
    console.error('Error saving record:', error);
    req.session.error_msg = 'Ошибка сервера при сохранении';
    redirectBack(req, res, '/');
  }
});

// POST /records/:id/toggle_status - Ban, Unban, or Geo-block
router.post('/:id/toggle_status', async (req, res) => {
  try {
    const { id } = req.params;
    const { new_status, block_type } = req.body;

    if (block_type === 'geo' || new_status === 'geo') {
      const {
        normalizeCountryList,
        mergeCountryLists,
        formatCountryListLabels
      } = require('../utils/geoBlock');
      const [rows] = await pool.query(
        'SELECT r.id, r.title, r.geo_block_countries, r.channel_id, c.name AS channel_name, c.user_id AS owner_id FROM records r LEFT JOIN channels c ON r.channel_id = c.id WHERE r.id = ?',
        [id]
      );
      if (!rows.length) {
        req.session.error_msg = 'Запись не найдена';
        return redirectBack(req, res, '/');
      }
      const selected = req.body.geo_countries != null ? req.body.geo_countries : req.body.geo_block_countries;
      const next = mergeCountryLists(rows[0].geo_block_countries, selected) || normalizeCountryList(selected);
      const reason = String(req.body.geo_block_reason || '').trim().slice(0, 500);
      const showReason = req.body.geo_block_show_reason === '1' || req.body.geo_block_show_reason === 'on' ? 1 : 0;
      if (!next) {
        req.session.error_msg = 'Выберите хотя бы одну страну для гео-блока';
        return redirectBack(req, res, '/');
      }
      if (!reason) {
        req.session.error_msg = 'Укажите причину гео-блокировки';
        return redirectBack(req, res, '/');
      }
      await pool.query(
        'UPDATE records SET geo_block_countries = ?, geo_block_reason = ?, geo_block_show_reason = ?, geo_blocked_by = ? WHERE id = ?',
        [next, reason, showReason, (req.session.user && req.session.user.id) || null, id]
      );
      const label = formatCountryListLabels(next);
      if (rows[0].owner_id) {
        let ownerMsg = `Ваша запись «${rows[0].title}» (канал «${rows[0].channel_name || '—'}») скрыта для зрителей из стран: ${label}.`;
        if (showReason) ownerMsg += `\nПричина: ${reason}`;
        const hub = (process.env.APP_URL || 'http://localhost:3001').replace(/\/$/, '') + '/appeals/new';
        if (!/\/appeals\//i.test(ownerMsg)) {
          ownerMsg += `\n\nЕсли считаете решение ошибочным — обжалуйте:\n${hub}`;
        }
        await sendSystemMessage(rows[0].owner_id, ownerMsg);
      }
      const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      logAction(
        'admin',
        req.session.user.username,
        `Гео-блок записи "${rows[0].title}" (ID: ${id}): ${label}. Причина: ${reason}${showReason ? ' [видна пользователю]' : ''}`,
        userIp
      );
      req.session.success_msg = `Гео-блок записи: ${label}. Запись полностью не скрыта.`;
      return redirectBack(req, res, '/');
    }

    if (new_status !== 'banned' && new_status !== 'active') {
      req.session.error_msg = 'Неверный статус';
      return redirectBack(req, res, '/');
    }

    await pool.query('UPDATE records SET status = ? WHERE id = ?', [new_status, id]);
    
    const [rRows] = await pool.query(
      'SELECT r.title, c.name, c.user_id AS owner_id FROM records r JOIN channels c ON r.channel_id = c.id WHERE r.id = ?',
      [id]
    );
    const rTitle = rRows.length > 0 ? rRows[0].title : 'Unknown';
    const cName = rRows.length > 0 ? rRows[0].name : 'Unknown';
    if (rRows.length && rRows[0].owner_id) {
      if (new_status === 'banned') {
        await sendSystemMessage(
          rRows[0].owner_id,
          withAppealCta(`Ваша запись «${rTitle}» (канал «${cName}») скрыта администрацией.`, 'record_ban', id)
        );
      } else if (new_status === 'active') {
        await sendSystemMessage(rRows[0].owner_id, `Ваша запись «${rTitle}» снова доступна.`);
      }
    }
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, new_status === 'banned' ? `Скрыл видеозапись "${rTitle}" (ID: ${id}) телеканала "${cName}"` : `Восстановил видеозапись "${rTitle}" (ID: ${id}) телеканала "${cName}"`, userIp);

    req.session.success_msg = new_status === 'banned' ? 'Запись скрыта (заблокирована)' : 'Запись восстановлена';
    redirectBack(req, res, '/');

  } catch (error) {
    console.error('Error toggling record status:', error);
    req.session.error_msg = 'Ошибка сервера';
    redirectBack(req, res, '/');
  }
});

// POST /records/:id/geo_block — set / add / remove / clear
router.post('/:id/geo_block', async (req, res) => {
  try {
    const { id } = req.params;
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

    const [rows] = await pool.query(
      'SELECT r.id, r.title, r.geo_block_countries, r.geo_block_reason, r.geo_block_show_reason, c.name AS channel_name, c.user_id AS owner_id FROM records r LEFT JOIN channels c ON r.channel_id = c.id WHERE r.id = ?',
      [id]
    );
    if (rows.length === 0) {
      req.session.error_msg = 'Запись не найдена';
      return res.redirect('/records');
    }

    let next = rows[0].geo_block_countries || null;
    let nextReason = rows[0].geo_block_reason || null;
    let nextShow = rows[0].geo_block_show_reason ? 1 : 0;
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
          req.session.error_msg = 'Укажите причину гео-блокировки';
          return res.redirect('/records/' + id + '/edit');
        }
        nextReason = reason;
        nextShow = showReason;
      }
    }

    await pool.query(
      'UPDATE records SET geo_block_countries = ?, geo_block_reason = ?, geo_block_show_reason = ?, geo_blocked_by = ? WHERE id = ?',
      [next, nextReason, nextShow, next ? ((req.session.user && req.session.user.id) || null) : null, id]
    );
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    const label = next ? formatCountryListLabels(next) : '';
    if (next && (action === 'set' || action === 'add') && rows[0].owner_id) {
      let ownerMsg = `Ваша запись «${rows[0].title}» скрыта для зрителей из стран: ${label}.`;
      if (nextShow && nextReason) ownerMsg += `\nПричина: ${nextReason}`;
      const hub = (process.env.APP_URL || 'http://localhost:3001').replace(/\/$/, '') + '/appeals/new';
      if (!/\/appeals\//i.test(ownerMsg)) ownerMsg += `\n\nЕсли считаете решение ошибочным — обжалуйте:\n${hub}`;
      await sendSystemMessage(rows[0].owner_id, ownerMsg);
    } else if (!next && rows[0].owner_id && (action === 'clear' || action === 'remove')) {
      await sendSystemMessage(rows[0].owner_id, `Гео-ограничения для записи «${rows[0].title}» сняты.`);
    }
    logAction(
      'admin',
      req.session.user.username,
      next
        ? `Гео-блок записи "${rows[0].title}" (ID: ${id}): ${label}${nextReason ? '. Причина: ' + nextReason : ''}${nextShow ? ' [видна пользователю]' : ''}`
        : `Снял гео-блок с записи "${rows[0].title}" (ID: ${id})`,
      userIp
    );
    req.session.success_msg = next
      ? `Гео-блок сохранён: ${label}`
      : 'Гео-блок снят';
    const back = req.get('Referer') && req.get('Referer').includes('/edit')
      ? '/records/' + id + '/edit'
      : null;
    if (back) return res.redirect(back);
    redirectBack(req, res, '/records/' + id + '/edit');
  } catch (error) {
    console.error('Error saving record geo_block:', error);
    req.session.error_msg = 'Ошибка сохранения гео-блока';
    redirectBack(req, res, '/');
  }
});

// POST /records/:id/delete - Full delete
router.post('/:id/delete', async (req, res) => {
  if (req.user && !req.user.is_superadmin && req.user.staff_role === 'moderator') return res.status(403).render('error', { status: 403, title: 'Отказано в доступе', message: 'Модераторам доступ запрещен' });
  try {
    const { id } = req.params;
    
    const [rows] = await pool.query('SELECT video_url, thumbnail_url, hls_url FROM records WHERE id = ?', [id]);
    
    if (rows.length > 0) {
      unlinkRecordFiles(rows[0]);
    }

    const [rRows] = await pool.query('SELECT r.title, c.name FROM records r JOIN channels c ON r.channel_id = c.id WHERE r.id = ?', [id]);
    const rTitle = rRows.length > 0 ? rRows[0].title : 'Unknown';
    const cName = rRows.length > 0 ? rRows[0].name : 'Unknown';

    await pool.query('DELETE FROM album_records WHERE record_id = ?', [id]);
    await pool.query('DELETE FROM records WHERE id = ?', [id]);

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', req.session.user.username, `Полностью удалил видеозапись "${rTitle}" (ID: ${id}) телеканала "${cName}"`, userIp);

    req.session.success_msg = 'Запись полностью удалена';
    res.redirect('/records');
  } catch (error) {
    console.error('Error deleting record:', error);
    req.session.error_msg = 'Ошибка сервера при удалении';
    redirectBack(req, res, '/');
  }
});

module.exports = router;
