const express = require('express');
const router = express.Router();
const { pool } = require('../../config/db');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const emailService = require('../../emailService');
const { requireAuth } = require('../../middlewares/auth');
const { logAction } = require('../../utils/logger');
const { panelMiddleware, recordUploadMiddleware, designUploadMiddleware } = require('../../middlewares/panel');
const geoip = require('geoip-lite');
const rateLimit = require('express-rate-limit');
const { shouldBlockRecord, sqlNotGeoBlockedChannel, sqlNotGeoBlockedRecord, isStaffUser } = require('../../utils/geoBlock');

const recordViewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many view requests' }
});

const LIST_SORTS = new Set(['new', 'popular', 'random']);

function parseListFilters(query, { withLive } = {}) {
  const sort = LIST_SORTS.has(query.sort) ? query.sort : 'new';
  const liveOnly = !!(withLive && (query.live === '1' || query.live === 'on' || query.live === 'true'));
  let seed = parseInt(query.seed, 10);
  if (sort === 'random') {
    if (!Number.isInteger(seed) || seed < 1 || seed > 2147483646) {
      seed = Math.floor(Math.random() * 2147483646) + 1;
    }
  } else {
    seed = 0;
  }
  return { sort, liveOnly, seed };
}

function buildListQuery({ sort, liveOnly, searchQuery, seed }) {
  const params = new URLSearchParams();
  if (sort && sort !== 'new') params.set('sort', sort);
  if (liveOnly) params.set('live', '1');
  if (searchQuery) params.set('q', searchQuery);
  if (sort === 'random' && seed) params.set('seed', String(seed));
  const qs = params.toString();
  return qs ? '&' + qs : '';
}

function buildListHref(path, { page, sort, liveOnly, searchQuery, seed }) {
  const params = new URLSearchParams();
  if (page && Number(page) > 1) params.set('page', String(page));
  if (sort && sort !== 'new') params.set('sort', sort);
  if (liveOnly) params.set('live', '1');
  if (searchQuery) params.set('q', searchQuery);
  if (sort === 'random' && seed) params.set('seed', String(seed));
  const qs = params.toString();
  return path + (qs ? '?' + qs : '');
}

function isAjaxListRequest(req) {
  return req.query.ajax === '1'
    || String(req.get('X-Requested-With') || '').toLowerCase() === 'xmlhttprequest';
}

function channelOrderSql(sort, liveOnly, seed) {
  const parts = [];
  if (liveOnly) parts.push('(c.is_live = 1) DESC');
  if (sort === 'popular') {
    parts.push('fans_count DESC', 'c.created_at DESC');
  } else if (sort === 'random') {
    parts.push(`RAND(${Number(seed)})`);
  } else {
    parts.push('c.created_at DESC');
  }
  return ' ORDER BY ' + parts.join(', ');
}

function recordOrderSql(sort, seed) {
  if (sort === 'popular') return ' ORDER BY r.views DESC, r.created_at DESC';
  if (sort === 'random') return ` ORDER BY RAND(${Number(seed)})`;
  return ' ORDER BY r.created_at DESC';
}

router.post('/api/records/:id/favorite_fan', requireAuth, async (req, res) => {
  const recordId = req.params.id;
  const userId = req.session.user.id;
  try {
    const connection = await pool.getConnection();
    const [existing] = await connection.query('SELECT id FROM record_favorites WHERE user_id = ? AND record_id = ?', [userId, recordId]);
    let isFan = false;
    if (existing.length > 0) {
      await connection.query('DELETE FROM record_favorites WHERE id = ?', [existing[0].id]);
    } else {
      await connection.query('INSERT INTO record_fans (user_id, record_id) VALUES (?, ?)', [userId, recordId]);
      isFan = true;
    }
    const [countRows] = await connection.query('SELECT COUNT(*) as count FROM record_favorites WHERE record_id = ?', [recordId]);
    connection.release();
    res.json({ success: true, isFan, count: countRows[0].count });
  } catch (e) {
    console.error('Error toggling record fan:', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

router.get('/ru/tv,viewrecord,:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [recordRows] = await pool.query(`
      SELECT r.*, c.name as channel_name, u.username as owner_username, c.user_id as owner_user_id, c.shortname, c.status as c_status,
             c.logo_url as channel_logo_url, c.logo_fit as channel_logo_fit,
             c.is_verified as channel_is_verified, c.is_premium as channel_is_premium,
             c.geo_block_countries as channel_geo_block_countries,
             s.is_superadmin as owner_is_superadmin
      FROM records r
      JOIN channels c ON r.channel_id = c.id
      JOIN users u ON c.user_id = u.id
      LEFT JOIN staff s ON u.id = s.user_id
      WHERE r.id = ?
    `, [id]);

    if (recordRows.length === 0) {
      return res.status(404).render('404', { pageTitle: 'Запись не найдена | ЭтоЯTV' });
    }
    const record = recordRows[0];

    if (record.access_level === 'private') {
      const currentUser = req.session.user;
      let hasAccess = false;
      if (currentUser) {
        if (currentUser.id === record.owner_user_id || ['admin', 'moderator'].includes(currentUser.staff_role)) {
          hasAccess = true;
        } else {
          const [perms] = await pool.query('SELECT 1 FROM record_permissions WHERE record_id = ? AND user_id = ?', [record.id, currentUser.id]);
          if (perms.length > 0) {
            hasAccess = true;
          }
        }
      }
      if (!hasAccess) {
        return res.status(403).render('restricted_record', {
          pageTitle: 'Доступ ограничен | ЭтоЯTV'
        });
      }
    }
    
    if (record.status === 'deleted' || record.status === 'banned' || record.c_status === 'deleted' || record.c_status === 'banned') {
      const isAdminOrMod = req.session.user && ['admin', 'moderator', 'mod'].includes(req.session.user.staff_role);
      if (!isAdminOrMod) {
        return res.status(403).render('deleted_record', { activeMenu: 'channels', pageTitle: 'Видеозапись недоступна | ЭтоЯTV' });
      }
    }
    if (shouldBlockRecord(req, record)) {
      return res.status(403).render('geo_blocked_record', { activeMenu: 'channels', pageTitle: 'Видеозапись недоступна | ЭтоЯTV' });
    }

    const isOwnerOrStaff = req.session.user && (req.session.user.id === record.owner_user_id || ['admin', 'moderator'].includes(req.session.user.staff_role));
    const accessFilter = isOwnerOrStaff ? '' : " AND access_level = 'public'";

    // fetch other records from same channel
    let otherRecordsSql = `
      SELECT id, title, duration, views, thumbnail_url, created_at, is_18_plus,
             (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = records.id) as fans_count
             ${req.session.user ? `, (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = records.id AND rf.user_id = ${Number(req.session.user.id)}) > 0 as is_fan` : ', 0 as is_fan'}
      FROM records 
      WHERE channel_id = ? AND id != ? AND status NOT IN ('deleted', 'banned')${accessFilter}`;
    const otherParams = [record.channel_id, id];
    if (!isStaffUser(req.session && req.session.user) && req.viewerCountry) {
      // Filter sibling records by their own geo denylist (parent channel is already reachable here)
      otherRecordsSql += ` AND (geo_block_countries IS NULL OR geo_block_countries = '' OR FIND_IN_SET(?, REPLACE(geo_block_countries, ' ', '')) = 0)`;
      otherParams.push(String(req.viewerCountry).toUpperCase());
    }
    otherRecordsSql += ` ORDER BY created_at DESC LIMIT 10`;
    const [otherRecordsRows] = await pool.query(otherRecordsSql, otherParams);

    // get like stats
    const [likeRows] = await pool.query('SELECT COUNT(*) as cnt FROM record_favorites WHERE record_id = ?', [id]);
    const likesCount = likeRows[0].cnt;

    let isLiked = false;
    let isFavorited = false;
    if (req.session.user) {
      const [userLikeRows] = await pool.query('SELECT id FROM record_likes WHERE record_id = ? AND user_id = ?', [id, req.session.user.id]);
      isLiked = userLikeRows.length > 0;

      const [userFavRows] = await pool.query('SELECT id FROM record_favorites WHERE record_id = ? AND user_id = ?', [id, req.session.user.id]);
      isFavorited = userFavRows.length > 0;
    }
    // fetch comments
    const cpage = parseInt(req.query.cpage) || 1;
    const climit = 7;
    const coffset = (cpage - 1) * climit;

    const [cCountRows] = await pool.query('SELECT COUNT(*) as cnt FROM record_comments WHERE record_id = ? AND is_hidden = 0', [id]);
    const totalComments = cCountRows[0].cnt;
    const cTotalPages = Math.ceil(totalComments / climit) || 1;

    const [commentRows] = await pool.query(`
      SELECT rc.id, rc.record_id, rc.user_id, rc.text, rc.created_at, rc.is_hidden,
             COALESCE(u.username, rc.author_name, 'Пользователь') AS username,
             CASE WHEN u.id IS NULL THEN '/images/default_user_avatar.png' ELSE u.avatar END AS avatar_url
      FROM record_comments rc
      LEFT JOIN users u ON rc.user_id = u.id
      WHERE rc.record_id = ? AND rc.is_hidden = 0
      ORDER BY rc.created_at DESC
      LIMIT ? OFFSET ?
    `, [id, climit, coffset]);

    let userAge = null;
    let hasBirthdate = false;
    if (req.session.user) {
      const [uRows] = await pool.query('SELECT birthdate FROM users WHERE id = ?', [req.session.user.id]);
      if (uRows.length > 0 && uRows[0].birthdate) {
        hasBirthdate = true;
        const birthdate = new Date(uRows[0].birthdate);
        const diff_ms = Date.now() - birthdate.getTime();
        const age_dt = new Date(diff_ms);
        userAge = Math.abs(age_dt.getUTCFullYear() - 1970);
      }
    }

    res.render('viewrecord', {
      pageTitle: record.title + ' | ЭтоЯTV',
      record,
      userAge,
      hasBirthdate,
      otherRecords: otherRecordsRows,
      likesCount,
      isLiked,
      isFavorited,
      comments: commentRows,
      cpage,
      cTotalPages,
      totalComments,
      user: req.session.user
    });
  } catch (e) {
    console.error('Error fetching record:', e);
    res.status(500).send('Server Error');
  }
});

router.post('/api/records/:id/like', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const [likeRows] = await pool.query('SELECT id FROM record_likes WHERE record_id = ? AND user_id = ?', [id, req.session.user.id]);
    if (likeRows.length > 0) {
      await pool.query('DELETE FROM record_likes WHERE record_id = ? AND user_id = ?', [id, req.session.user.id]);
      res.json({ success: true, liked: false });
    } else {
      await pool.query('INSERT INTO record_likes (record_id, user_id) VALUES (?, ?)', [id, req.session.user.id]);
      res.json({ success: true, liked: true });
    }
  } catch (e) {
    console.error('Error liking record:', e);
    res.status(500).json({ success: false, error: 'Server Error' });
  }
});

router.post('/api/records/:id/favorite', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const [favRows] = await pool.query('SELECT id FROM record_favorites WHERE record_id = ? AND user_id = ?', [id, req.session.user.id]);
    let favorited = false;
    if (favRows.length > 0) {
      await pool.query('DELETE FROM record_favorites WHERE id = ?', [favRows[0].id]);
    } else {
      await pool.query('INSERT INTO record_favorites (record_id, user_id) VALUES (?, ?)', [id, req.session.user.id]);
      favorited = true;
    }
    const [countRows] = await pool.query('SELECT COUNT(*) as count FROM record_favorites WHERE record_id = ?', [id]);
    res.json({ success: true, favorited: favorited, isFan: favorited, count: countRows[0].count });
  } catch (e) {
    console.error('Error toggling favorite:', e);
    res.status(500).json({ success: false, error: 'Server Error' });
  }
});

router.post('/api/records/:id/comment', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  if (!text || text.trim() === '') {
    return res.status(400).json({ success: false, error: 'Text is required' });
  }
  try {
    const [recordRows] = await pool.query('SELECT channel_id FROM records WHERE id = ?', [id]);
    if (recordRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Record not found' });
    }
    const channelId = recordRows[0].channel_id;

    const [bans] = await pool.query(
      'SELECT id FROM channel_bans WHERE channel_id = ? AND user_id = ? AND banned_until > NOW()',
      [channelId, req.session.user.id]
    );
    if (bans.length > 0) {
      return res.status(403).json({ success: false, error: 'Вы заблокированы на этом канале и не можете оставлять комментарии.' });
    }

    await pool.query('INSERT INTO record_comments (record_id, user_id, text) VALUES (?, ?, ?)', [id, req.session.user.id, text.trim()]);
    
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('user', req.session.user.username, `Оставил комментарий к записи (ID: ${id})`, userIp);

    res.json({ success: true });
  } catch (e) {
    console.error('Error posting comment:', e);
    res.status(500).json({ success: false, error: 'Server Error' });
  }
});

router.delete('/api/records/:id/comment/:commentId', requireAuth, async (req, res) => {
  const { id, commentId } = req.params;
  try {
    const [recordRows] = await pool.query('SELECT c.user_id FROM records r JOIN channels c ON r.channel_id = c.id WHERE r.id = ?', [id]);
    if (recordRows.length === 0) return res.status(404).json({ success: false, error: 'Record not found' });
    const channelOwnerId = recordRows[0].user_id;

    const [commentRows] = await pool.query('SELECT user_id FROM record_comments WHERE id = ? AND record_id = ?', [commentId, id]);
    if (commentRows.length === 0) return res.status(404).json({ success: false, error: 'Comment not found' });
    const commentAuthorId = commentRows[0].user_id;

    const role = req.session.user.role || 'registered';
    if (req.session.user.id !== channelOwnerId && req.session.user.id !== commentAuthorId && role !== 'admin' && role !== 'mod') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    await pool.query('DELETE FROM record_comments WHERE id = ?', [commentId]);
    res.json({ success: true });
  } catch (e) {
    console.error('Error deleting comment:', e);
    res.status(500).json({ success: false, error: 'Server Error' });
  }
});

router.get('/ru/tv,records', async (req, res) => {
  const searchQuery = req.query.q || '';
  const page = parseInt(req.query.page) || 1;
  const limit = 10;
  const offset = (page - 1) * limit;
  const { sort, seed } = parseListFilters(req.query);
  const listQuery = buildListQuery({ sort, searchQuery, seed });
  const listHref = buildListHref('/tv,records', { page, sort, searchQuery, seed });

  try {
    let queryParams = [];
    let whereClause = 'WHERE c.status = "active" AND r.status NOT IN ("deleted", "banned") AND r.access_level = "public"';

    if (searchQuery) {
      whereClause += ' AND r.title LIKE ?';
      queryParams.push('%' + searchQuery + '%');
    }

    const staffBypass = isStaffUser(req.session && req.session.user);
    if (!staffBypass && req.viewerCountry) {
      const geoRec = sqlNotGeoBlockedRecord('c', 'r', req.viewerCountry);
      whereClause += geoRec.sql;
      queryParams.push(...geoRec.params);
    }

    const [countRows] = await pool.query(`SELECT COUNT(*) as cnt FROM records r JOIN channels c ON r.channel_id = c.id ${whereClause}`, queryParams);
    const totalRecords = countRows[0].cnt;
    const totalPages = Math.ceil(totalRecords / limit) || 1;

    queryParams.push(limit, offset);
    const [records] = await pool.query(`
      SELECT r.id, r.title, r.duration, r.views, r.thumbnail_url, r.created_at, r.is_18_plus,
             c.name as channel_name, c.shortname,
             (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = r.id) as fans_count
             ${req.session.user ? `, (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = r.id AND rf.user_id = ${Number(req.session.user.id)}) > 0 as is_fan` : ', 0 as is_fan'}
      FROM records r
      JOIN channels c ON r.channel_id = c.id
      ${whereClause} 
      ${recordOrderSql(sort, seed)}
      LIMIT ? OFFSET ?
    `, queryParams);

    const listLocals = {
      records,
      currentPage: page,
      totalPages: totalPages,
      searchQuery: searchQuery,
      user: req.session.user,
      sort,
      seed,
      listQuery,
      listHref
    };

    if (isAjaxListRequest(req)) {
      return res.render('partials/records_list', listLocals);
    }

    res.render('global_records', {
      pageTitle: 'Поиск записей | ЭтоЯTV',
      ...listLocals
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.get('/ru/tv,programs', async (req, res) => {
  const searchQuery = req.query.q || '';
  const page = parseInt(req.query.page) || 1;
  const limit = 5;
  const offset = (page - 1) * limit;

  try {
    const connection = await pool.getConnection();

    let items = [];

    // 1. Fetch live channels matching search
    let liveQuery = "SELECT c.*, 'channel' as item_type, (SELECT COUNT(*) FROM channel_fans f WHERE f.channel_id = c.id) as fans_count FROM channels c WHERE c.status = 'active' AND c.is_live = 1 AND c.access_level != 'private'";
    let liveParams = [];
    if (searchQuery) {
      liveQuery += " AND (c.name LIKE ? OR c.description LIKE ? OR c.live_title LIKE ?)";
      liveParams.push(`%${searchQuery}%`, `%${searchQuery}%`, `%${searchQuery}%`);
    }
    const staffBypassProg = isStaffUser(req.session && req.session.user);
    if (!staffBypassProg && req.viewerCountry) {
      const geoLive = sqlNotGeoBlockedChannel('c', req.viewerCountry);
      liveQuery += geoLive.sql;
      liveParams.push(...geoLive.params);
    }
    const [liveChannels] = await connection.query(liveQuery, liveParams);

    // 2. Fetch upcoming programs matching search
    let progQuery = `
      SELECT p.*, c.name as channel_name, c.shortname as channel_shortname, c.logo_url as channel_logo, c.logo_fit as channel_logo_fit, c.is_18_plus, 'program' as item_type,
             (SELECT COUNT(*) FROM personal_schedules ps WHERE ps.program_id = p.id) as bookmarks_count
             ${req.session.user ? `, (SELECT COUNT(*) FROM personal_schedules ps WHERE ps.program_id = p.id AND ps.user_id = ${Number(req.session.user.id)}) > 0 as is_bookmarked` : ', 0 as is_bookmarked'}
      FROM programs p 
      JOIN channels c ON p.channel_id = c.id 
      WHERE c.status = 'active' AND c.access_level != 'private' AND p.start_time >= NOW() AND (p.is_hidden = 0 OR p.is_hidden IS NULL)
    `;
    let progParams = [];
    if (searchQuery) {
      progQuery += " AND (p.title LIKE ? OR p.description LIKE ?)";
      progParams.push(`%${searchQuery}%`, `%${searchQuery}%`);
    }
    if (!staffBypassProg && req.viewerCountry) {
      const geoProg = sqlNotGeoBlockedChannel('c', req.viewerCountry);
      progQuery += geoProg.sql;
      progParams.push(...geoProg.params);
    }
    progQuery += " ORDER BY p.start_time ASC";
    const [upcomingPrograms] = await connection.query(progQuery, progParams);

    // Combine them
    items = [...liveChannels, ...upcomingPrograms];

    // Paginate in memory
    const totalItems = items.length;
    const totalPages = Math.ceil(totalItems / limit) || 1;
    const paginatedItems = items.slice(offset, offset + limit);

    // check if user is fan for live channels
    if (req.session.user) {
       for (let item of paginatedItems) {
         if (item.item_type === 'channel') {
           const [fanRows] = await connection.query('SELECT 1 FROM channel_fans WHERE channel_id = ? AND user_id = ?', [item.id, req.session.user.id]);
           item.is_fan = fanRows.length > 0;
         }
       }
    }

    connection.release();
    res.render('tv_programs', {
      pageTitle: 'Анонсы и прямые трансляции | ЭтоЯTV',
      items: paginatedItems,
      searchQuery,
      currentPage: page,
      totalPages
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.get('/ru/tv,channels', async (req, res) => {
  const searchQuery = req.query.q || '';
  const page = parseInt(req.query.page) || 1;
  const limit = 21;
  const offset = (page - 1) * limit;
  const { sort, liveOnly, seed } = parseListFilters(req.query, { withLive: true });
  const listQuery = buildListQuery({ sort, liveOnly, searchQuery, seed });

  try {
    const connection = await pool.getConnection();
    let queryStr = `SELECT c.*, 
        (SELECT COUNT(*) FROM channel_fans f WHERE f.channel_id = c.id) as fans_count
        ${req.session.user ? `, (SELECT COUNT(*) FROM channel_fans f WHERE f.channel_id = c.id AND f.user_id = ${Number(req.session.user.id)}) as is_fan` : `, 0 as is_fan`}
        FROM channels c WHERE c.status = 'active'`;
    let countQueryStr = "SELECT COUNT(*) as count FROM channels c WHERE c.status = 'active'";
    let params = [];

    if (searchQuery) {
      queryStr += " AND (c.name LIKE ? OR c.shortname LIKE ?)";
      countQueryStr += " AND (c.name LIKE ? OR c.shortname LIKE ?)";
      params.push(`%${searchQuery}%`, `%${searchQuery}%`);
    }

    if (liveOnly) {
      queryStr += " AND (c.is_live = 1 OR c.autopilot_enabled = 1)";
      countQueryStr += " AND (c.is_live = 1 OR c.autopilot_enabled = 1)";
    }

    const staffBypass = isStaffUser(req.session && req.session.user);
    if (!staffBypass && req.viewerCountry) {
      const geoCh = sqlNotGeoBlockedChannel('c', req.viewerCountry);
      queryStr += geoCh.sql;
      countQueryStr += geoCh.sql;
      params.push(...geoCh.params);
    }

    queryStr += channelOrderSql(sort, liveOnly, seed) + " LIMIT ? OFFSET ?";

    const [countRows] = await connection.query(countQueryStr, params);
    const totalChannels = countRows[0].count;
    const totalPages = Math.ceil(totalChannels / limit) || 1;

    const [channels] = await connection.query(queryStr, [...params, limit, offset]);

    connection.release();

    const listLocals = {
      channels: channels,
      currentPage: page,
      totalPages: totalPages,
      searchQuery: searchQuery,
      sort,
      liveOnly,
      seed,
      listQuery,
      listHref: buildListHref('/tv,channels', { page, sort, liveOnly, searchQuery, seed })
    };

    if (isAjaxListRequest(req)) {
      return res.render('partials/channels_list', listLocals);
    }

    res.render('channels', listLocals);
  } catch (err) {
    console.error('Error fetching channels:', err);
    res.status(500).send('Server Error');
  }
});

router.get('/api/records/:id/comments_html', async (req, res) => {
  const { id } = req.params;
  const cpage = parseInt(req.query.cpage) || 1;
  const cperPage = 7;
  const coffset = (cpage - 1) * cperPage;

  try {
    const connection = await pool.getConnection();
    const [recordRows] = await connection.query(`
      SELECT r.*,
             (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = r.id) as fans_count
             ${req.session.user ? `, (SELECT COUNT(*) FROM record_favorites rf WHERE rf.record_id = r.id AND rf.user_id = ${Number(req.session.user.id)}) > 0 as is_fan` : ', 0 as is_fan'}
      FROM records r WHERE id = ?`, [id]);
    if (recordRows.length === 0) {
      connection.release();
      return res.status(404).send('Record not found');
    }
    const record = recordRows[0];

    const [commentCountRows] = await connection.query('SELECT COUNT(*) as cnt FROM record_comments WHERE record_id = ? AND is_hidden = 0', [id]);
    const totalComments = commentCountRows[0].cnt;
    const cTotalPages = Math.ceil(totalComments / cperPage);

    const [commentsRows] = await connection.query(`
      SELECT c.id, c.text, c.created_at, c.user_id,
             COALESCE(u.username, c.author_name, 'Пользователь') AS username,
             CASE WHEN u.id IS NULL THEN '/images/default_user_avatar.png' ELSE u.avatar END AS avatar_url
      FROM record_comments c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.record_id = ? AND c.is_hidden = 0
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `, [id, cperPage, coffset]);

    connection.release();

    res.render('partials/record_comments_list', {
      comments: commentsRows,
      cpage,
      cTotalPages,
      user: req.session.user,
      record: record
    });
  } catch (e) {
    console.error('Error in record comments html:', e);
    res.status(500).send('Error');
  }
});

router.get('/api/records/:id/comments_count', async (req, res) => {
  const { id } = req.params;
  try {
    const [countRows] = await pool.query('SELECT COUNT(*) as cnt FROM record_comments WHERE record_id = ? AND is_hidden = 0', [id]);
    res.json({ success: true, count: countRows[0].cnt });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

router.post('/api/records/:id/view', recordViewLimiter, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ success: false, error: 'Invalid record id' });
    }

    const [recRows] = await pool.query('SELECT id, channel_id, views FROM records WHERE id = ?', [id]);
    if (recRows.length === 0) {
      return res.status(404).json({ success: false, error: 'Record not found' });
    }

    const channelId = recRows[0].channel_id;
    const currentViews = recRows[0].views || 0;

    // Use Express req.ip (trust proxy) — NOT raw X-Forwarded-For first hop,
    // which clients can spoof to bypass IP dedupe via the public API.
    const viewerIp = String(req.ip || req.socket.remoteAddress || '')
      .replace(/^::ffff:/i, '')
      .trim()
      .slice(0, 45) || null;
    const userId = (req.session && req.session.user && req.session.user.id) ? req.session.user.id : null;

    // One counted view per IP (and per logged-in user) within 24h — YouTube-like cooldown
    const DEDUPE_HOURS = 24;
    let alreadyCounted = false;

    if (userId) {
      const [uRows] = await pool.query(
        `SELECT id FROM record_view_stats
         WHERE record_id = ? AND user_id = ?
           AND created_at > DATE_SUB(NOW(), INTERVAL ? HOUR)
         LIMIT 1`,
        [id, userId, DEDUPE_HOURS]
      );
      alreadyCounted = uRows.length > 0;
    }

    if (!alreadyCounted && viewerIp) {
      const [ipRows] = await pool.query(
        `SELECT id FROM record_view_stats
         WHERE record_id = ? AND viewer_ip = ?
           AND created_at > DATE_SUB(NOW(), INTERVAL ? HOUR)
         LIMIT 1`,
        [id, viewerIp, DEDUPE_HOURS]
      );
      alreadyCounted = ipRows.length > 0;
    }

    if (alreadyCounted) {
      return res.json({ success: true, views: currentViews, counted: false });
    }

    const geo = viewerIp ? geoip.lookup(viewerIp) : null;
    const countryCode = geo ? geo.country : null;

    await pool.query(
      'INSERT INTO record_view_stats (record_id, channel_id, country_code, viewer_ip, user_id) VALUES (?, ?, ?, ?, ?)',
      [id, channelId, countryCode, viewerIp, userId]
    );
    await pool.query('UPDATE records SET views = views + 1 WHERE id = ?', [id]);
    const [rows] = await pool.query('SELECT views FROM records WHERE id = ?', [id]);
    res.json({ success: true, views: rows[0].views, counted: true });
  } catch (e) {
    console.error('[VIEW_INCREMENT] Error:', e);
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;
