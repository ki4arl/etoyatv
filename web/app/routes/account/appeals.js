const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { pool } = require('../../../config/db');
const { requireAuth } = require('../../../middlewares/auth');
const { verifyHCaptcha } = require('../../../utils/hcaptcha');
const { logAction } = require('../../../utils/logger');
const sendSystemMessage = require('../../../utils/systemMessage');
const {
  subjectLabel,
  statusLabel,
  publicAuthorTitle,
  createAppealTicket,
  findOpenTicket,
  buildUserFacingFacts,
  outcomeSummary,
  appealTicketUserUrl,
  appealTicketAdminUrl
} = require('../../../utils/appeals');
const { formatCountryListLabels } = require('../../../utils/geoBlock');

function parseSnapshot(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

async function loadTicketForUser(connection, ticketId, userId) {
  const [rows] = await connection.query(
    'SELECT * FROM appeal_tickets WHERE id = ? AND user_id = ?',
    [ticketId, userId]
  );
  return rows[0] || null;
}

async function loadMessagesPublic(connection, ticketId) {
  const [rows] = await connection.query(
    `SELECT m.*, u.username AS author_username
     FROM appeal_messages m
     LEFT JOIN users u ON m.author_id = u.id
     WHERE m.ticket_id = ?
     ORDER BY m.created_at ASC, m.id ASC`,
    [ticketId]
  );
  return rows.map((m) => {
    const title = publicAuthorTitle(m.author_side);
    let displayName;
    if (m.author_side === 'user') displayName = 'Вы';
    else if (m.author_side === 'system') displayName = 'Служебное';
    else displayName = title || 'Система';
    return {
      id: m.id,
      author_side: m.author_side,
      body: m.body,
      created_at: m.created_at,
      display_name: displayName,
      // Hide noisy bootstrap system lines; context card already explains the case
      hide_in_thread: m.author_side === 'system' && /Обжалование принято|Тикет обжалования создан/i.test(m.body || '')
    };
  });
}

// ——— Ban appeal without full session (from login screen) ———
router.get('/appeals/from-ban', (req, res) => {
  res.render('appeals_from_ban', {
    pageTitle: 'Обжалование блокировки | ЭтоЯTV',
    error: null,
    success: null,
    username: req.query.username || ''
  });
});

router.post('/appeals/from-ban', async (req, res) => {
  const captchaToken = req.body['h-captcha-response'];
  const isCaptchaValid = await verifyHCaptcha(captchaToken);
  if (!isCaptchaValid) {
    return res.render('appeals_from_ban', {
      pageTitle: 'Обжалование блокировки | ЭтоЯTV',
      error: 'Подтвердите, что вы не робот.',
      success: null,
      username: req.body.username || ''
    });
  }

  const { username, password, message } = req.body;
  if (!username || !password || !message || String(message).trim().length < 10) {
    return res.render('appeals_from_ban', {
      pageTitle: 'Обжалование блокировки | ЭтоЯTV',
      error: 'Укажите логин, пароль и текст обжалования (не менее 10 символов).',
      success: null,
      username: username || ''
    });
  }

  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT * FROM users WHERE username = ?', [username]);
    if (!rows.length) {
      connection.release();
      return res.render('appeals_from_ban', {
        pageTitle: 'Обжалование блокировки | ЭтоЯTV',
        error: 'Неверный логин или пароль.',
        success: null,
        username
      });
    }
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      connection.release();
      return res.render('appeals_from_ban', {
        pageTitle: 'Обжалование блокировки | ЭтоЯTV',
        error: 'Неверный логин или пароль.',
        success: null,
        username
      });
    }

    const now = new Date();
    const isBanned = user.is_banned && (!user.banned_until || new Date(user.banned_until) > now);
    if (!isBanned) {
      connection.release();
      return res.render('appeals_from_ban', {
        pageTitle: 'Обжалование блокировки | ЭтоЯTV',
        error: 'Этот аккаунт сейчас не заблокирован. Войдите обычным способом.',
        success: null,
        username
      });
    }

    const snapshot = {
      reason_public: user.show_ban_reason ? (user.ban_reason || null) : null,
      banned_until: user.banned_until || null,
      permanent: !user.banned_until
    };

    const { ticketId, created, respondentId } = await createAppealTicket(connection, {
      userId: user.id,
      subjectType: 'user_ban',
      subjectId: user.id,
      subjectTitle: subjectLabel('user_ban'),
      sanctionSnapshot: snapshot,
      staffActorId: user.banned_by || null,
      initialMessage: message
    });

    if (created && respondentId) {
      await sendSystemMessage(
        respondentId,
        `Вам назначено обжалование №${ticketId} (вы ответчик). Откройте в админке:\n${appealTicketAdminUrl(ticketId)}`
      );
    }

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('user', user.username, created
      ? `Создал обжалование #${ticketId} (блокировка аккаунта)`
      : `Повторно открыл обжалование #${ticketId}`, userIp);

    connection.release();

    return res.render('appeals_from_ban', {
      pageTitle: 'Обжалование блокировки | ЭтоЯTV',
      error: null,
      success: created
        ? `Обжалование №${ticketId} создано. Ответ придёт в личные сообщения после рассмотрения.`
        : `У вас уже есть открытое обжалование №${ticketId}. Дождитесь ответа администрации.`,
      username
    });
  } catch (e) {
    console.error(e);
    return res.render('appeals_from_ban', {
      pageTitle: 'Обжалование блокировки | ЭтоЯTV',
      error: 'Ошибка сервера.',
      success: null,
      username: req.body.username || ''
    });
  }
});

// ——— Authenticated appeals ———
router.get('/appeals', requireAuth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [tickets] = await connection.query(
      `SELECT id, subject_type, subject_title, status, created_at, updated_at, resolved_at
       FROM appeal_tickets WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50`,
      [req.session.user.id]
    );
    connection.release();
    res.render('appeals_list', {
      pageTitle: 'Обжалования | ЭтоЯTV',
      tickets: tickets.map((t) => ({
        ...t,
        subject_label: subjectLabel(t.subject_type),
        status_label: statusLabel(t.status)
      })),
      error: req.query.error || null,
      success: req.query.success || null
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Ошибка сервера');
  }
});

router.get('/appeals/new', requireAuth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const userId = req.session.user.id;
    const preselect = String(req.query.type || '');
    const preselectId = req.query.id != null && req.query.id !== '' ? String(req.query.id) : '';

    // Deep link: if this sanction already has an open ticket — open it
    if (preselect && preselectId) {
      const sid = preselect === 'user_ban' ? userId : parseInt(preselectId, 10);
      if (!Number.isNaN(sid)) {
        const existing = await findOpenTicket(connection, userId, preselect, sid);
        if (existing) {
          connection.release();
          return res.redirect(`/appeals/${existing.id}?info=` + encodeURIComponent('Открытый тикет по этой санкции уже есть.'));
        }
      }
    }

    const [uRows] = await connection.query(
      'SELECT is_banned, banned_until, ban_reason, show_ban_reason, banned_by FROM users WHERE id = ?',
      [userId]
    );
    const user = uRows[0];
    const now = new Date();
    const options = [];

    if (user && user.is_banned && (!user.banned_until || new Date(user.banned_until) > now)) {
      options.push({
        subject_type: 'user_ban',
        subject_id: userId,
        label: subjectLabel('user_ban'),
        detail: user.show_ban_reason && user.ban_reason ? user.ban_reason : (user.banned_until ? `до ${user.banned_until}` : 'бессрочно')
      });
    }

    const [channels] = await connection.query(
      `SELECT id, name, shortname, status, ban_reason, banned_until, geo_block_countries, deleted_at, deleted_by_admin
       FROM channels WHERE user_id = ? AND (status IN ('banned','deleted') OR (geo_block_countries IS NOT NULL AND geo_block_countries != ''))`,
      [userId]
    );
    for (const ch of channels) {
      if (ch.status === 'banned') {
        options.push({
          subject_type: 'channel_ban',
          subject_id: ch.id,
          label: `${subjectLabel('channel_ban')}: ${ch.name}`,
          detail: ch.ban_reason || ch.shortname || ''
        });
      }
      if (ch.status === 'deleted' && ch.deleted_by_admin) {
        options.push({
          subject_type: 'channel_delete',
          subject_id: ch.id,
          label: `${subjectLabel('channel_delete')}: ${ch.name}`,
          detail: ch.shortname
        });
      }
      if (ch.geo_block_countries) {
        options.push({
          subject_type: 'geo_block',
          subject_id: ch.id,
          label: `${subjectLabel('geo_block')}: ${ch.name}`,
          detail: formatCountryListLabels(ch.geo_block_countries) || ch.geo_block_countries
        });
      }
    }

    const [records] = await connection.query(
      `SELECT r.id, r.title, r.status FROM records r
       JOIN channels c ON c.id = r.channel_id
       WHERE c.user_id = ? AND r.status = 'banned' LIMIT 50`,
      [userId]
    );
    for (const rec of records) {
      options.push({
        subject_type: 'record_ban',
        subject_id: rec.id,
        label: `${subjectLabel('record_ban')}: ${rec.title || ('#' + rec.id)}`,
        detail: ''
      });
    }

    connection.release();

    const focused = options.find(
      (o) => o.subject_type === preselect && String(o.subject_id) === String(preselectId || o.subject_id)
    ) || null;

    // Deep link to a sanction that is no longer appealable
    if (preselect && preselectId && !focused && options.length) {
      // fall through to list
    } else if (preselect && preselectId && !focused && !options.length) {
      return res.render('appeals_new', {
        pageTitle: 'Новое обжалование | ЭтоЯTV',
        options: [],
        focused: null,
        error: 'Эта санкция уже снята или недоступна для обжалования.',
        preselect,
        preselectId
      });
    }

    res.render('appeals_new', {
      pageTitle: focused ? 'Обжаловать санкцию | ЭтоЯTV' : 'Новое обжалование | ЭтоЯTV',
      options,
      focused,
      error: null,
      preselect,
      preselectId
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Ошибка сервера');
  }
});

router.post('/appeals/new', requireAuth, async (req, res) => {
  const { subject_type, subject_id, message } = req.body;
  if (!subject_type || !message || String(message).trim().length < 10) {
    return res.redirect('/appeals?error=' + encodeURIComponent('Укажите предмет обжалования и текст (от 10 символов).'));
  }

  const allowed = ['user_ban', 'channel_ban', 'channel_delete', 'record_ban', 'geo_block'];
  if (!allowed.includes(subject_type)) {
    return res.redirect('/appeals?error=' + encodeURIComponent('Некорректный тип санкции.'));
  }

  try {
    const connection = await pool.getConnection();
    const userId = req.session.user.id;
    let subjectId = subject_id ? parseInt(subject_id, 10) : null;
    if (Number.isNaN(subjectId)) subjectId = null;

    let subjectTitle = subjectLabel(subject_type);
    let snapshot = {};
    let staffActorId = null;

    if (subject_type === 'user_ban') {
      subjectId = userId;
      const [u] = await connection.query(
        'SELECT is_banned, banned_until, ban_reason, show_ban_reason, banned_by FROM users WHERE id = ?',
        [userId]
      );
      const now = new Date();
      if (!u.length || !(u[0].is_banned && (!u[0].banned_until || new Date(u[0].banned_until) > now))) {
        connection.release();
        return res.redirect('/appeals?error=' + encodeURIComponent('Аккаунт не заблокирован.'));
      }
      staffActorId = u[0].banned_by;
      snapshot = {
        reason_public: u[0].show_ban_reason ? u[0].ban_reason : null,
        banned_until: u[0].banned_until,
        permanent: !u[0].banned_until
      };
    } else if (subject_type === 'channel_ban' || subject_type === 'channel_delete' || subject_type === 'geo_block') {
      const [ch] = await connection.query('SELECT * FROM channels WHERE id = ? AND user_id = ?', [subjectId, userId]);
      if (!ch.length) {
        connection.release();
        return res.redirect('/appeals?error=' + encodeURIComponent('Канал не найден.'));
      }
      if (subject_type === 'channel_ban' && ch[0].status !== 'banned') {
        connection.release();
        return res.redirect('/appeals?error=' + encodeURIComponent('Канал не заблокирован.'));
      }
      if (subject_type === 'channel_delete' && !(ch[0].status === 'deleted' && ch[0].deleted_by_admin)) {
        connection.release();
        return res.redirect('/appeals?error=' + encodeURIComponent('Канал не удалён администрацией.'));
      }
      if (
        subject_type === 'geo_block' &&
        !(ch[0].geo_block_countries && String(ch[0].geo_block_countries).trim())
      ) {
        connection.release();
        return res.redirect('/appeals?error=' + encodeURIComponent('На канале нет геоблока.'));
      }
      subjectTitle = `${subjectLabel(subject_type)}: ${ch[0].name}`;
      if (subject_type === 'channel_ban') {
        staffActorId = ch[0].banned_by || null;
      } else if (subject_type === 'geo_block') {
        staffActorId = ch[0].geo_blocked_by || null;
      } else {
        staffActorId = null;
      }
      snapshot = {
        channel_name: ch[0].name,
        shortname: ch[0].shortname,
        status: ch[0].status,
        ban_reason: ch[0].ban_reason || null,
        banned_until: ch[0].banned_until || null,
        geo_block_countries: ch[0].geo_block_countries || null,
        geo_countries_label: ch[0].geo_block_countries
          ? (formatCountryListLabels(ch[0].geo_block_countries) || ch[0].geo_block_countries)
          : null,
        geo_block_reason: ch[0].geo_block_reason || null,
        geo_block_show_reason: ch[0].geo_block_show_reason ? 1 : 0
      };
    } else if (subject_type === 'record_ban') {
      const [rec] = await connection.query(
        `SELECT r.* FROM records r JOIN channels c ON c.id = r.channel_id WHERE r.id = ? AND c.user_id = ?`,
        [subjectId, userId]
      );
      if (!rec.length || rec[0].status !== 'banned') {
        connection.release();
        return res.redirect('/appeals?error=' + encodeURIComponent('Запись не найдена или не заблокирована.'));
      }
      subjectTitle = `${subjectLabel('record_ban')}: ${rec[0].title || ('#' + rec[0].id)}`;
      snapshot = { record_title: rec[0].title, record_id: rec[0].id, status: rec[0].status };
    }

    const { ticketId, created, respondentId } = await createAppealTicket(connection, {
      userId,
      subjectType: subject_type,
      subjectId,
      subjectTitle,
      sanctionSnapshot: snapshot,
      staffActorId,
      initialMessage: message
    });

    if (created && respondentId) {
      await sendSystemMessage(
        respondentId,
        `Вам назначено обжалование №${ticketId} (вы ответчик). Откройте в админке:\n${appealTicketAdminUrl(ticketId)}`
      );
    }

    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    logAction('user', req.session.user.username, `${created ? 'Создал' : 'Повторно обратился к'} обжалованию #${ticketId}`, userIp);
    connection.release();

    if (!created) {
      return res.redirect(`/appeals/${ticketId}?info=` + encodeURIComponent('Открытый тикет по этой санкции уже есть.'));
    }
    return res.redirect(`/appeals/${ticketId}`);
  } catch (e) {
    console.error(e);
    return res.redirect('/appeals?error=' + encodeURIComponent('Ошибка сервера.'));
  }
});

router.get('/appeals/:id', requireAuth, async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const ticket = await loadTicketForUser(connection, req.params.id, req.session.user.id);
    if (!ticket) {
      connection.release();
      return res.status(404).render('error', { status: 404, title: 'Не найдено', message: 'Тикет не найден.' });
    }
    const messages = await loadMessagesPublic(connection, ticket.id);

    let snapshot = parseSnapshot(ticket.sanction_snapshot);
    // Enrich thin snapshots for older tickets (channel / geo / delete)
    if (['channel_ban', 'channel_delete', 'geo_block'].includes(ticket.subject_type) && ticket.subject_id) {
      const [ch] = await connection.query(
        'SELECT name, shortname, status, ban_reason, banned_until, geo_block_countries, geo_block_reason, geo_block_show_reason FROM channels WHERE id = ? AND user_id = ?',
        [ticket.subject_id, req.session.user.id]
      );
      if (ch.length) {
        const c = ch[0];
        const countries = snapshot.geo_block_countries || c.geo_block_countries || null;
        snapshot = {
          channel_name: snapshot.channel_name || c.name,
          shortname: snapshot.shortname || c.shortname,
          status: snapshot.status || c.status,
          ban_reason: snapshot.ban_reason || c.ban_reason || null,
          banned_until: snapshot.banned_until || c.banned_until || null,
          geo_block_countries: countries,
          geo_countries_label: snapshot.geo_countries_label
            || (countries ? (formatCountryListLabels(countries) || countries) : null),
          geo_block_reason: snapshot.geo_block_reason
            || (c.geo_block_show_reason ? c.geo_block_reason : null)
            || null
        };
      }
    }
    connection.release();

    const open = ['open', 'awaiting_user', 'awaiting_staff'].includes(ticket.status);
    const facts = buildUserFacingFacts(ticket, snapshot);
    const outcome = outcomeSummary(ticket.status);
    const thread = messages.filter((m) => !m.hide_in_thread);
    // Avoid duplicating the same verdict text as both last judge message and footer
    const lastHuman = [...thread].reverse().find((m) => m.author_side === 'judge' || m.author_side === 'respondent');
    const showVerdictFooter = ticket.verdict_note
      && (!lastHuman || String(lastHuman.body).trim() !== String(ticket.verdict_note).trim());

    res.render('appeals_ticket', {
      pageTitle: `Обжалование №${ticket.id} | ЭтоЯTV`,
      ticket: {
        ...ticket,
        subject_label: subjectLabel(ticket.subject_type),
        status_label: statusLabel(ticket.status),
        snapshot,
        open,
        facts,
        outcome,
        show_verdict_footer: showVerdictFooter
      },
      messages: thread,
      info: req.query.info || null,
      error: req.query.error || null
    });
  } catch (e) {
    console.error(e);
    res.status(500).send('Ошибка сервера');
  }
});

router.post('/appeals/:id/reply', requireAuth, async (req, res) => {
  const body = (req.body.message || '').trim();
  if (body.length < 2 || body.length > 4000) {
    return res.redirect(`/appeals/${req.params.id}?error=` + encodeURIComponent('Сообщение от 2 до 4000 символов.'));
  }
  try {
    const connection = await pool.getConnection();
    const ticket = await loadTicketForUser(connection, req.params.id, req.session.user.id);
    if (!ticket) {
      connection.release();
      return res.status(404).send('Не найдено');
    }
    if (!['open', 'awaiting_user', 'awaiting_staff'].includes(ticket.status)) {
      connection.release();
      return res.redirect(`/appeals/${ticket.id}?error=` + encodeURIComponent('Тикет уже закрыт.'));
    }
    await connection.query(
      `INSERT INTO appeal_messages (ticket_id, author_id, author_side, body, created_at) VALUES (?, ?, 'user', ?, NOW())`,
      [ticket.id, req.session.user.id, body]
    );
    await connection.query(
      `UPDATE appeal_tickets SET status = 'awaiting_staff', updated_at = NOW() WHERE id = ?`,
      [ticket.id]
    );
    const respondentNotifyId = ticket.assigned_respondent_id || ticket.staff_actor_id;
    connection.release();

    if (respondentNotifyId) {
      await sendSystemMessage(
        respondentNotifyId,
        `Истец ответил в обжаловании №${ticket.id}. Откройте:\n${appealTicketAdminUrl(ticket.id)}`
      );
    }

    res.redirect(`/appeals/${ticket.id}`);
  } catch (e) {
    console.error(e);
    res.redirect(`/appeals/${req.params.id}?error=` + encodeURIComponent('Ошибка сервера.'));
  }
});

module.exports = router;
