const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { logAction } = require('../utils/logger');
const {
  rememberFingerprintsForIp,
  liftFingerprintsForIpAddress,
  liftFingerprintByHash
} = require('../utils/deviceFingerprint');
const sendSystemMessage = require('../utils/systemMessage');

async function checkAccess(req) {
  if (!req.session.user) return false;
  const connection = await pool.getConnection();
  const [rows] = await connection.query('SELECT role, is_superadmin FROM staff WHERE user_id = ?', [req.session.user.id]);
  connection.release();
  if (rows.length === 0) return false;
  return rows[0].role === 'moderator' || rows[0].role === 'admin' || rows[0].is_superadmin;
}

async function checkAdminAccess(req) {
  if (!req.session.user) return false;
  const connection = await pool.getConnection();
  const [rows] = await connection.query('SELECT role, is_superadmin FROM staff WHERE user_id = ?', [req.session.user.id]);
  connection.release();
  if (rows.length === 0) return false;
  return rows[0].role === 'admin' || rows[0].is_superadmin;
}

// User Bans List
router.get('/bans/users', async (req, res) => {
  try {
    if (!(await checkAccess(req))) return res.status(403).render('error', { status: 403, title: 'Доступ запрещен', message: 'Недостаточно прав' });
    
    const { search } = req.query;
    let query = `
      SELECT u.id, u.username, u.email, u.ban_reason, u.banned_until,
             a.username as banned_by_username
      FROM users u
      LEFT JOIN users a ON u.banned_by = a.id
      WHERE u.is_banned = 1
    `;
    let countQuery = `SELECT COUNT(*) as total FROM users u WHERE u.is_banned = 1`;
    let params = [];

    if (search) {
      if (!isNaN(search)) {
        query += ` AND u.id = ?`;
        countQuery += ` AND u.id = ?`;
        params.push(search);
      } else {
        query += ` AND (u.username LIKE ? OR u.email LIKE ?)`;
        countQuery += ` AND (u.username LIKE ? OR u.email LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`);
      }
    }
    
    const limit = parseInt(req.query.limit) || 10;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    query += ` ORDER BY u.banned_until ASC LIMIT ? OFFSET ?`;

    const connection = await pool.getConnection();
    const [[{ total }]] = await connection.query(countQuery, params);
    
    params.push(limit, offset);
    const [bans] = await connection.query(query, params);
    connection.release();

    const totalPages = Math.ceil(total / limit);

    res.render('bans-users', {
      currentPath: '/bans/users',
      bans,
      search: search || '',
      limit,
      page,
      total,
      totalPages
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

// IP Bans List
router.get('/bans/ip', async (req, res) => {
  try {
    if (!(await checkAdminAccess(req))) return res.status(403).render('error', { status: 403, title: 'Доступ запрещен', message: 'Недостаточно прав' });
    
    const limit = parseInt(req.query.limit) || 10;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;

    const connection = await pool.getConnection();
    const [[{ total }]] = await connection.query('SELECT COUNT(*) as total FROM ip_bans');
    
    const [bans] = await connection.query(`
      SELECT i.*, a.username as banned_by_username
      FROM ip_bans i
      LEFT JOIN users a ON i.banned_by = a.id
      ORDER BY i.created_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);
    connection.release();

    const totalPages = Math.ceil(total / limit);

    res.render('bans-ip', {
      currentPath: '/bans/ip',
      bans,
      limit,
      page,
      total,
      totalPages
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

// Fingerprint bans list
router.get('/bans/fingerprints', async (req, res) => {
  try {
    if (!(await checkAdminAccess(req))) return res.status(403).render('error', { status: 403, title: 'Доступ запрещен', message: 'Недостаточно прав' });

    const limit = parseInt(req.query.limit) || 10;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;
    const showLifted = req.query.show === 'all';

    const connection = await pool.getConnection();
    const where = showLifted ? '1=1' : 'bf.lifted_at IS NULL';
    const [[{ total }]] = await connection.query(`SELECT COUNT(*) as total FROM banned_fingerprints bf WHERE ${where}`);
    const [bans] = await connection.query(`
      SELECT bf.*, a.username as banned_by_username, ib.ip_address as linked_ip
      FROM banned_fingerprints bf
      LEFT JOIN users a ON bf.banned_by = a.id
      LEFT JOIN ip_bans ib ON bf.ip_ban_id = ib.id
      WHERE ${where}
      ORDER BY bf.created_at DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);
    connection.release();

    res.render('bans-fingerprints', {
      currentPath: '/bans/fingerprints',
      bans,
      limit,
      page,
      total,
      totalPages: Math.ceil(total / limit),
      showLifted
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

router.post('/bans/fingerprints/:hash/lift', async (req, res) => {
  try {
    if (!(await checkAdminAccess(req))) return res.status(403).render('error', { status: 403, title: 'Доступ запрещен', message: 'Недостаточно прав' });
    const fpHash = String(req.params.hash || '').trim();
    if (!/^[a-f0-9]{64}$/i.test(fpHash)) {
      return res.status(400).render('error', { status: 400, title: 'Ошибка', message: 'Некорректный отпечаток' });
    }
    const connection = await pool.getConnection();
    await liftFingerprintByHash(connection, fpHash);
    connection.release();
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Снял блокировку отпечатка ${fpHash.slice(0, 12)}…`, userIp);
    req.session.success_msg = 'Блокировка по отпечатку снята';
    res.redirect('/bans/fingerprints');
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

// Legacy URLs → channels section
router.get('/bans/channel-approvals', (req, res) => {
  const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(301, '/channels/approvals' + q);
});
router.post('/bans/channel-approvals/:id/approve', (req, res) => {
  res.redirect(307, '/channels/approvals/' + req.params.id + '/approve');
});
router.post('/bans/channel-approvals/:id/reject', (req, res) => {
  res.redirect(307, '/channels/approvals/' + req.params.id + '/reject');
});

// Edit existing IP ban (reason / type) without unban
router.post('/bans/ip/:ip/edit', async (req, res) => {
  try {
    if (!(await checkAdminAccess(req))) return res.status(403).render('error', { status: 403, title: 'Доступ запрещен', message: 'Недостаточно прав' });

    const ip = req.params.ip;
    const { ip_ban_type, reason } = req.body;
    if (reason && reason.length > 200) {
      return res.status(400).render('error', { status: 400, title: 'Ошибка', message: 'Причина блокировки не может превышать 200 символов.' });
    }
    const ipType = ip_ban_type === 'full' ? 'full' : 'account';
    const adminId = req.session.user ? req.session.user.id : null;

    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT id FROM ip_bans WHERE ip_address = ?', [ip]);
    if (!rows.length) {
      connection.release();
      req.session.error_msg = 'IP-бан не найден';
      return res.redirect('/bans/ip');
    }
    await connection.query(
      'UPDATE ip_bans SET ban_type = ?, reason = ?, banned_by = COALESCE(?, banned_by) WHERE ip_address = ?',
      [ipType, reason || null, adminId, ip]
    );
    // Keep linked fingerprint bans in sync
    try {
      await connection.query(
        `UPDATE banned_fingerprints SET ban_type = ?, reason = ?
         WHERE ip_ban_id = ? AND lifted_at IS NULL`,
        [ipType, reason || null, rows[0].id]
      );
    } catch (_) {}
    connection.release();

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Обновил IP-бан ${ip} (Тип: ${ipType}, Причина: ${reason || '—'})`, userIp);
    req.session.success_msg = 'Параметры IP-бана обновлены';
    res.redirect('/bans/ip');
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

// Unban IP
router.post('/bans/ip/:ip/unban', async (req, res) => {
  try {
    if (!(await checkAdminAccess(req))) return res.status(403).render('error', { status: 403, title: 'Доступ запрещен', message: 'Недостаточно прав' });
    
    const ip = req.params.ip;
    const connection = await pool.getConnection();
    await liftFingerprintsForIpAddress(connection, ip);
    await connection.query('DELETE FROM ip_bans WHERE ip_address = ?', [ip]);
    connection.release();
    
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', req.session.user.username, `Разблокировал IP: ${ip}`, userIp);
    
    req.session.success_msg = 'IP-адрес успешно разблокирован';
    res.redirect('/bans/ip');
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

// Add Manual IP Ban
router.post('/bans/ip/add', async (req, res) => {
  try {
    if (!(await checkAdminAccess(req))) return res.status(403).render('error', { status: 403, title: 'Доступ запрещен', message: 'Недостаточно прав' });
    
    const { ip_address, ip_ban_type, reason } = req.body;
    const adminId = req.session.user ? req.session.user.id : null;
    
    if (!ip_address || ip_address.trim() === '') {
      return res.status(400).render('error', { status: 400, title: 'Ошибка', message: 'IP-адрес обязателен.' });
    }
    if (reason && reason.length > 200) {
      return res.status(400).render('error', { status: 400, title: 'Ошибка', message: 'Причина блокировки не может превышать 200 символов.' });
    }
    
    const ipType = ip_ban_type === 'full' ? 'full' : 'account';
    
    const connection = await pool.getConnection();
    
    const { isProtectedIp } = require('../utils/ipChecker');
    const myIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    const protectedIp = await isProtectedIp(connection, ip_address.trim(), myIp);
    
    if (protectedIp) {
      connection.release();
      return res.status(400).render('error', { status: 400, title: 'Ошибка', message: 'Нельзя заблокировать этот IP, так как он принадлежит вам или члену персонала.' });
    }
    await connection.query(
      'INSERT INTO ip_bans (ip_address, banned_by, ban_type, reason) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE banned_by = VALUES(banned_by), ban_type = VALUES(ban_type), reason = VALUES(reason)',
      [ip_address.trim(), adminId, ipType, reason]
    );
    const [banRows] = await connection.query('SELECT id FROM ip_bans WHERE ip_address = ?', [ip_address.trim()]);
    const ipBanId = banRows.length ? banRows[0].id : null;
    await rememberFingerprintsForIp(connection, ip_address.trim(), {
      ipBanId,
      bannedBy: adminId,
      reason,
      banType: ipType
    });
    connection.release();
    
    logAction('team', req.session.user.username, `Заблокировал IP: ${ip_address.trim()} (Тип: ${ipType}, Причина: ${reason})`, myIp);
    
    req.session.success_msg = 'IP-адрес успешно заблокирован';
    res.redirect('/bans/ip');
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

module.exports = router;
