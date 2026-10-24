const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { logAction } = require('../utils/logger');
const sendSystemMessage = require('../utils/systemMessage');
const {
  subjectLabel,
  statusLabel,
  isJudge,
  isRespondent,
  publicAuthorTitle,
  executeOverturn,
  executeUphold,
  buildStaffFacingFacts,
  appealTicketUserUrl,
  appealTicketAdminUrl
} = require('../utils/appeals');

function parseSnapshot(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function staffUser(req) {
  return req.user || (req.session && req.session.user) || null;
}

async function requireStaff(req, res) {
  const u = staffUser(req);
  if (!isRespondent(u)) {
    res.status(403).render('error', { status: 403, title: 'Доступ запрещен', message: 'Недостаточно прав' });
    return null;
  }
  return u;
}

/** Judges see all; moderators only tickets assigned to them (or unassigned). */
function respondentScopeSql(u, alias = 't') {
  if (isJudge(u)) return { sql: '1=1', params: [] };
  return {
    sql: `(${alias}.assigned_respondent_id = ? OR ${alias}.staff_actor_id = ? OR ${alias}.assigned_respondent_id IS NULL)`,
    params: [u.id, u.id]
  };
}

function canAccessTicket(u, ticket) {
  if (isJudge(u)) return true;
  if (!ticket.assigned_respondent_id && !ticket.staff_actor_id) return true;
  return ticket.assigned_respondent_id === u.id || ticket.staff_actor_id === u.id;
}

router.get('/', async (req, res) => {
  try {
    const u = await requireStaff(req, res);
    if (!u) return;

    const status = req.query.status || 'open';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;
    const scope = respondentScopeSql(u);
    const judge = isJudge(u);

    let statusSql = '1=1';
    const statusParams = [];
    if (status === 'open') {
      statusSql = `t.status IN ('open','awaiting_user','awaiting_staff')`;
    } else if (status === 'mine') {
      statusSql = `t.status IN ('open','awaiting_user','awaiting_staff') AND (t.assigned_respondent_id = ? OR t.staff_actor_id = ?)`;
      statusParams.push(u.id, u.id);
    } else if (status === 'resolved') {
      statusSql = `t.status IN ('resolved_upheld','resolved_overturned','closed')`;
    } else if (status !== 'all') {
      statusSql = `t.status = ?`;
      statusParams.push(status);
    }

    const where = `(${scope.sql}) AND (${statusSql})`;
    const params = [...scope.params, ...statusParams];

    const connection = await pool.getConnection();
    const [[{ total }]] = await connection.query(
      `SELECT COUNT(*) AS total FROM appeal_tickets t WHERE ${where}`,
      params
    );
    const [rows] = await connection.query(
      `SELECT t.*, u.username AS appellant_name, a.username AS actor_name, j.username AS judge_name,
              r.username AS respondent_name
       FROM appeal_tickets t
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN users a ON a.id = t.staff_actor_id
       LEFT JOIN users j ON j.id = t.judge_id
       LEFT JOIN users r ON r.id = t.assigned_respondent_id
       WHERE ${where}
       ORDER BY t.updated_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    connection.release();

    res.render('appeals', {
      pageTitle: 'Обжалования | Админ-панель',
      currentPath: '/appeals',
      tickets: rows.map((t) => ({
        ...t,
        subject_label: subjectLabel(t.subject_type),
        status_label: statusLabel(t.status),
        actor_name: t.actor_name || null,
        judge_name: judge ? (t.judge_name || null) : null,
        respondent_name: t.respondent_name || t.actor_name || null,
        is_mine: t.assigned_respondent_id === u.id || t.staff_actor_id === u.id
      })),
      statusFilter: status,
      page,
      totalPages: Math.ceil(total / limit) || 1,
      total,
      isJudge: judge,
      user: u
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const u = await requireStaff(req, res);
    if (!u) return;
    const judge = isJudge(u);
    const connection = await pool.getConnection();
    const [rows] = await connection.query(
      `SELECT t.*, u.username AS appellant_name, u.email AS appellant_email,
              a.username AS actor_name, j.username AS judge_name, r.username AS respondent_name
       FROM appeal_tickets t
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN users a ON a.id = t.staff_actor_id
       LEFT JOIN users j ON j.id = t.judge_id
       LEFT JOIN users r ON r.id = t.assigned_respondent_id
       WHERE t.id = ?`,
      [req.params.id]
    );
    if (!rows.length) {
      connection.release();
      return res.status(404).render('error', { status: 404, title: 'Не найдено', message: 'Тикет не найден' });
    }
    const ticket = rows[0];
    if (!canAccessTicket(u, ticket)) {
      connection.release();
      return res.status(403).render('error', {
        status: 403,
        title: 'Доступ запрещен',
        message: 'Этот тикет назначен другому ответчику.'
      });
    }

    // Backfill actor/respondent from channel sanction author if missing
    if (!ticket.staff_actor_id && ticket.subject_id) {
      let actorId = null;
      if (ticket.subject_type === 'channel_ban') {
        const [ch] = await connection.query('SELECT banned_by FROM channels WHERE id = ?', [ticket.subject_id]);
        actorId = ch.length ? ch[0].banned_by : null;
      } else if (ticket.subject_type === 'geo_block') {
        const [ch] = await connection.query('SELECT geo_blocked_by FROM channels WHERE id = ?', [ticket.subject_id]);
        actorId = ch.length ? ch[0].geo_blocked_by : null;
      } else if (ticket.subject_type === 'user_ban') {
        const [ur] = await connection.query('SELECT banned_by FROM users WHERE id = ?', [ticket.user_id]);
        actorId = ur.length ? ur[0].banned_by : null;
      }
      if (actorId) {
        await connection.query(
          `UPDATE appeal_tickets
           SET staff_actor_id = ?, assigned_respondent_id = COALESCE(assigned_respondent_id, ?)
           WHERE id = ?`,
          [actorId, actorId, ticket.id]
        );
        ticket.staff_actor_id = actorId;
        if (!ticket.assigned_respondent_id) ticket.assigned_respondent_id = actorId;
        const [an] = await connection.query('SELECT username FROM users WHERE id = ?', [actorId]);
        ticket.actor_name = an.length ? an[0].username : ticket.actor_name;
        if (!ticket.respondent_name) ticket.respondent_name = ticket.actor_name;
      }
    }

    const [messages] = await connection.query(
      `SELECT m.*, u.username AS author_username
       FROM appeal_messages m
       LEFT JOIN users u ON u.id = m.author_id
       WHERE m.ticket_id = ?
       ORDER BY m.created_at ASC, m.id ASC`,
      [ticket.id]
    );
    connection.release();

    const snapshot = parseSnapshot(ticket.sanction_snapshot);
    const open = ['open', 'awaiting_user', 'awaiting_staff'].includes(ticket.status);
    const iAmRespondent = ticket.assigned_respondent_id === u.id || ticket.staff_actor_id === u.id;
    const facts = buildStaffFacingFacts(ticket, snapshot);

    res.render('appeal-ticket', {
      pageTitle: `Обжалование #${ticket.id} | Админ-панель`,
      currentPath: '/appeals',
      ticket: {
        ...ticket,
        subject_label: subjectLabel(ticket.subject_type),
        status_label: statusLabel(ticket.status),
        snapshot,
        facts,
        open,
        actor_name: ticket.actor_name,
        judge_name: judge ? ticket.judge_name : null,
        respondent_name: ticket.respondent_name || ticket.actor_name,
        iAmRespondent
      },
      messages: messages.map((m) => ({
        ...m,
        display_name: m.author_side === 'user'
          ? `Истец (${m.author_username || 'пользователь'})`
          : m.author_side === 'system'
            ? 'Система'
            : m.author_side === 'respondent'
              ? `Ответчик${m.author_username ? ' (' + m.author_username + ')' : ''}`
              : `Судья${m.author_username ? ' (' + m.author_username + ')' : ''}`
      })),
      isJudge: judge,
      user: u,
      success_msg: res.locals.success_msg,
      error_msg: res.locals.error_msg
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

router.post('/:id/reply', async (req, res) => {
  try {
    const u = await requireStaff(req, res);
    if (!u) return;
    const body = (req.body.message || '').trim();
    if (body.length < 2 || body.length > 4000) {
      req.session.error_msg = 'Сообщение от 2 до 4000 символов';
      return res.redirect(`/appeals/${req.params.id}`);
    }
    const side = isJudge(u) && req.body.as_judge === '1' ? 'judge' : 'respondent';
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM appeal_tickets WHERE id = ?', [req.params.id]);
    if (!rows.length) {
      connection.release();
      return res.status(404).send('Не найдено');
    }
    const ticket = rows[0];
    if (!canAccessTicket(u, ticket)) {
      connection.release();
      return res.status(403).render('error', { status: 403, title: 'Доступ запрещен', message: 'Тикет назначен другому ответчику.' });
    }
    if (!['open', 'awaiting_user', 'awaiting_staff'].includes(ticket.status)) {
      connection.release();
      req.session.error_msg = 'Тикет закрыт';
      return res.redirect(`/appeals/${ticket.id}`);
    }

    await connection.query(
      `INSERT INTO appeal_messages (ticket_id, author_id, author_side, body, created_at) VALUES (?, ?, ?, ?, NOW())`,
      [ticket.id, u.id, side, body]
    );

    // Claim unassigned ticket when responding as respondent
    if (side === 'respondent' && !ticket.assigned_respondent_id) {
      await connection.query(
        `UPDATE appeal_tickets SET assigned_respondent_id = ?, staff_actor_id = COALESCE(staff_actor_id, ?), status = 'awaiting_user', updated_at = NOW() WHERE id = ?`,
        [u.id, u.id, ticket.id]
      );
    } else {
      await connection.query(
        `UPDATE appeal_tickets SET status = 'awaiting_user', updated_at = NOW() WHERE id = ?`,
        [ticket.id]
      );
    }
    connection.release();

    await sendSystemMessage(
      ticket.user_id,
      `По обжалованию №${ticket.id} получен ответ. Откройте:\n${appealTicketUserUrl(ticket.id)}`
    );

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('team', u.username, `Ответил в обжаловании #${ticket.id} как ${side}`, ip);
    req.session.success_msg = 'Ответ отправлен';
    res.redirect(`/appeals/${ticket.id}`);
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

router.post('/:id/verdict', async (req, res) => {
  try {
    const u = await requireStaff(req, res);
    if (!u) return;
    if (!isJudge(u)) {
      return res.status(403).render('error', { status: 403, title: 'Доступ запрещен', message: 'Вердикт могут выносить только администраторы (судьи).' });
    }

    const decision = req.body.decision;
    const verdictNote = (req.body.verdict_note || '').trim().slice(0, 2000);
    const internalNote = (req.body.internal_note || '').trim().slice(0, 2000);

    if (decision !== 'uphold' && decision !== 'overturn') {
      req.session.error_msg = 'Укажите решение';
      return res.redirect(`/appeals/${req.params.id}`);
    }

    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM appeal_tickets WHERE id = ?', [req.params.id]);
    if (!rows.length) {
      connection.release();
      return res.status(404).send('Не найдено');
    }
    const ticket = rows[0];
    if (!['open', 'awaiting_user', 'awaiting_staff'].includes(ticket.status)) {
      connection.release();
      req.session.error_msg = 'Тикет уже решён';
      return res.redirect(`/appeals/${ticket.id}`);
    }

    if (internalNote) {
      await connection.query('UPDATE appeal_tickets SET internal_note = ? WHERE id = ?', [internalNote, ticket.id]);
    }

    let publicMsg;
    if (decision === 'overturn') {
      await executeOverturn(connection, ticket, u.id);
      publicMsg = verdictNote || 'По итогам рассмотрения санкция отменена.';
      await connection.query(
        `INSERT INTO appeal_messages (ticket_id, author_id, author_side, body, created_at) VALUES (?, ?, 'judge', ?, NOW())`,
        [ticket.id, u.id, publicMsg]
      );
      await connection.query('UPDATE appeal_tickets SET verdict_note = ? WHERE id = ?', [publicMsg, ticket.id]);
    } else {
      await executeUphold(connection, ticket, u.id, verdictNote || 'Санкция оставлена в силе.');
      publicMsg = verdictNote || 'По итогам рассмотрения санкция оставлена в силе.';
      await connection.query(
        `INSERT INTO appeal_messages (ticket_id, author_id, author_side, body, created_at) VALUES (?, ?, 'judge', ?, NOW())`,
        [ticket.id, u.id, publicMsg]
      );
    }
    connection.release();

    await sendSystemMessage(
      ticket.user_id,
      `По обжалованию №${ticket.id} вынесено решение. Подробности:\n${appealTicketUserUrl(ticket.id)}`
    );

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('admin', u.username, `Вердикт по обжалованию #${ticket.id}: ${decision}`, ip);
    req.session.success_msg = decision === 'overturn' ? 'Санкция отменена' : 'Санкция оставлена в силе';
    res.redirect(`/appeals/${ticket.id}`);
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { status: 500, title: 'Ошибка', message: 'Ошибка сервера' });
  }
});

module.exports = router;
