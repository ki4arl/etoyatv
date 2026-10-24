/**
 * Appeals (обжалования санкций) — ticket helpers.
 * Staff identities are never exposed to the appellant.
 */

const SUBJECT_LABELS = {
  user_ban: 'Блокировка аккаунта',
  channel_ban: 'Блокировка телеканала',
  channel_delete: 'Удаление телеканала',
  record_ban: 'Блокировка записи',
  geo_block: 'Географическое ограничение',
  other: 'Иная санкция'
};

const STATUS_LABELS = {
  open: 'Открыт',
  awaiting_user: 'Ожидает вашего ответа',
  awaiting_staff: 'На рассмотрении',
  resolved_upheld: 'Санкция оставлена в силе',
  resolved_overturned: 'Санкция отменена',
  closed: 'Закрыт'
};

function subjectLabel(type) {
  return SUBJECT_LABELS[type] || SUBJECT_LABELS.other;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

function isJudge(user) {
  if (!user) return false;
  if (user.is_superadmin) return true;
  return user.staff_role === 'admin';
}

function isRespondent(user) {
  if (!user) return false;
  if (isJudge(user)) return true;
  return user.staff_role === 'moderator';
}

/** Public-facing author title — never a real staff username. */
function publicAuthorTitle(authorSide) {
  if (authorSide === 'user') return null; // use real username
  if (authorSide === 'respondent') return 'Ответчик (служба модерации)';
  if (authorSide === 'judge') return 'Судья (администрация)';
  return 'Система';
}

/**
 * Human-readable facts for the plaintiff ticket page (no staff names).
 */
function buildUserFacingFacts(ticket, snapshot = {}, forStaff = false) {
  const facts = [];
  const type = ticket.subject_type;
  facts.push({ label: 'Что обжалуется', value: subjectLabel(type) });

  if (snapshot.channel_name) {
    const chName = snapshot.channel_name;
    const sn = snapshot.shortname ? String(snapshot.shortname).replace(/^\/+/, '') : '';
    facts.push({
      label: 'Канал',
      value: chName,
      href: sn ? `/${sn}` : null
    });
  }
  if (snapshot.record_title) {
    facts.push({
      label: 'Запись',
      value: snapshot.record_title,
      href: snapshot.record_id ? `/viewrecord,${snapshot.record_id}` : null
    });
  }

  if (type === 'user_ban') {
    if (snapshot.permanent) {
      facts.push({ label: 'Срок', value: 'бессрочно' });
    } else if (snapshot.banned_until) {
      facts.push({ label: 'Срок до', value: String(snapshot.banned_until) });
    }
    if (snapshot.reason_public) {
      facts.push({ label: forStaff ? 'Причина (показана истцу)' : 'Причина (показанная вам)', value: snapshot.reason_public });
    } else if (forStaff && snapshot.ban_reason) {
      facts.push({ label: 'Причина (скрыта от истца)', value: snapshot.ban_reason });
    }
  } else if (type === 'channel_ban') {
    if (snapshot.banned_until) {
      facts.push({ label: 'Срок до', value: String(snapshot.banned_until) });
    } else {
      facts.push({ label: 'Срок', value: 'бессрочно' });
    }
    if (snapshot.ban_reason || snapshot.reason_public) {
      facts.push({ label: 'Причина', value: snapshot.ban_reason || snapshot.reason_public });
    }
  } else if (type === 'geo_block') {
    let countries = snapshot.geo_countries_label || null;
    if (!countries && snapshot.geo_block_countries) {
      try {
        const { formatCountryListLabels } = require('./geoBlock');
        countries = formatCountryListLabels(snapshot.geo_block_countries) || snapshot.geo_block_countries;
      } catch (_) {
        countries = snapshot.geo_block_countries;
      }
    }
    if (countries) {
      facts.push({ label: 'Скрыт для зрителей из', value: countries });
    }
    const reason = snapshot.geo_block_reason || snapshot.reason_public;
    const reasonIsPublic = snapshot.geo_block_show_reason === 1 || snapshot.geo_block_show_reason === true
      || (!!snapshot.reason_public && !snapshot.geo_block_reason);
    if (forStaff) {
      if (reason) {
        facts.push({
          label: reasonIsPublic ? 'Причина' : 'Причина (скрыта от истца)',
          value: reason
        });
      } else {
        facts.push({ label: 'Причина', value: 'не указана' });
      }
    } else if (reason && reasonIsPublic) {
      facts.push({ label: 'Причина', value: reason });
    }
  } else if (type === 'channel_delete') {
    facts.push({ label: 'Действие', value: 'Телеканал удалён администрацией' });
  }

  return facts;
}

/** Staff ticket facts — includes internal reason fields. */
function buildStaffFacingFacts(ticket, snapshot = {}) {
  return buildUserFacingFacts(ticket, snapshot, true);
}

function outcomeSummary(status) {
  if (status === 'resolved_overturned') {
    return { tone: 'ok', title: 'Санкция отменена', text: 'По итогам рассмотрения ограничение снято.' };
  }
  if (status === 'resolved_upheld') {
    return { tone: 'bad', title: 'Санкция оставлена в силе', text: 'По итогам рассмотрения решение не изменено.' };
  }
  if (status === 'closed') {
    return { tone: 'muted', title: 'Тикет закрыт', text: null };
  }
  if (status === 'awaiting_user') {
    return { tone: 'wait', title: 'Нужен ваш ответ', text: 'Ответчик ответил — можете продолжить переписку ниже.' };
  }
  if (status === 'awaiting_staff' || status === 'open') {
    return { tone: 'wait', title: 'На рассмотрении', text: 'Ожидается ответ ответчика или решение судьи.' };
  }
  return null;
}

/** Relative path to start an appeal for a concrete sanction. */
function appealPath(subjectType, subjectId, opts = {}) {
  if (subjectType === 'user_ban') {
    const q = opts.username ? `?username=${encodeURIComponent(opts.username)}` : '';
    return `/appeals/from-ban${q}`;
  }
  const params = new URLSearchParams();
  if (subjectType) params.set('type', subjectType);
  if (subjectId != null && subjectId !== '') params.set('id', String(subjectId));
  const qs = params.toString();
  return qs ? `/appeals/new?${qs}` : '/appeals/new';
}

function appealAbsoluteUrl(subjectType, subjectId, opts = {}) {
  const base = (process.env.APP_URL || 'http://localhost:3001').replace(/\/$/, '');
  return base + appealPath(subjectType, subjectId, opts);
}

function siteAbsoluteUrl(path) {
  const base = (process.env.APP_URL || 'http://localhost:3001').replace(/\/$/, '');
  const p = path && String(path).startsWith('/') ? path : `/${path || ''}`;
  return base + p;
}

function adminAbsoluteUrl(path) {
  let base = (process.env.ADMIN_URL || '').replace(/\/$/, '');
  if (!base) {
    const app = (process.env.APP_URL || 'http://localhost:3001').replace(/\/$/, '');
    if (/localhost/i.test(app)) base = 'https://admin.localhost';
    else base = app;
  }
  const p = path && String(path).startsWith('/') ? path : `/${path || ''}`;
  return base + p;
}

function appealTicketUserUrl(ticketId) {
  return siteAbsoluteUrl(`/appeals/${ticketId}`);
}

function appealTicketAdminUrl(ticketId) {
  return adminAbsoluteUrl(`/appeals/${ticketId}`);
}

/**
 * Append a clickable appeal CTA to a system PM (uses absolute URL — linkifyText).
 */
function withAppealCta(message, subjectType, subjectId, opts = {}) {
  const text = String(message || '').trim();
  if (!text) return text;
  if (/\/appeals\//i.test(text)) return text;
  const url = appealAbsoluteUrl(subjectType, subjectId, opts);
  return `${text}\n\nЕсли считаете решение ошибочным — обжалуйте по ссылке:\n${url}`;
}

function sanitizeSnapshotForUser(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return {};
  const out = { ...snapshot };
  delete out.staff_actor_id;
  delete out.staff_actor_username;
  delete out.banned_by;
  delete out.banned_by_username;
  delete out.internal_reason;
  return out;
}

async function findOpenTicket(connection, userId, subjectType, subjectId) {
  const [rows] = await connection.query(
    `SELECT id FROM appeal_tickets
     WHERE user_id = ? AND subject_type = ? AND (subject_id <=> ?)
       AND status IN ('open','awaiting_user','awaiting_staff')
     LIMIT 1`,
    [userId, subjectType, subjectId == null ? null : subjectId]
  );
  return rows[0] || null;
}

async function createAppealTicket(connection, {
  userId,
  subjectType,
  subjectId,
  subjectTitle,
  sanctionSnapshot,
  staffActorId,
  initialMessage
}) {
  const existing = await findOpenTicket(connection, userId, subjectType, subjectId);
  if (existing) {
    return { ticketId: existing.id, created: false };
  }

  const snapshot = sanitizeSnapshotForUser(sanctionSnapshot || {});
  // Respondent = staff who applied the sanction (if known)
  const respondentId = staffActorId || null;
  const [ins] = await connection.query(
    `INSERT INTO appeal_tickets
      (user_id, subject_type, subject_id, subject_title, sanction_snapshot, staff_actor_id, assigned_respondent_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_staff', NOW(), NOW())`,
    [
      userId,
      subjectType,
      subjectId == null ? null : subjectId,
      subjectTitle || subjectLabel(subjectType),
      JSON.stringify(snapshot),
      staffActorId || null,
      respondentId
    ]
  );
  const ticketId = ins.insertId;

  if (initialMessage && String(initialMessage).trim()) {
    await connection.query(
      `INSERT INTO appeal_messages (ticket_id, author_id, author_side, body, created_at)
       VALUES (?, ?, 'user', ?, NOW())`,
      [ticketId, userId, String(initialMessage).trim().slice(0, 4000)]
    );
  }

  await connection.query(
    `INSERT INTO appeal_messages (ticket_id, author_id, author_side, body, created_at)
     VALUES (?, NULL, 'system', ?, NOW())`,
    [ticketId, 'Обжалование принято. Ниже ваше обращение и переписка. Имена сотрудников вам не показываются.']
  );

  return { ticketId, created: true, respondentId };
}

async function executeOverturn(connection, ticket, judgeId) {
  const type = ticket.subject_type;
  const sid = ticket.subject_id;
  const userId = ticket.user_id;

  if (type === 'user_ban') {
    await connection.query(
      'UPDATE users SET is_banned = 0, banned_by = NULL, banned_until = NULL, ban_reason = NULL, show_ban_reason = 0 WHERE id = ?',
      [userId]
    );
    await connection.query(
      'UPDATE channels SET status = "active", rtmp_disabled = 0 WHERE user_id = ? AND status = "banned"',
      [userId]
    );
  } else if (type === 'channel_ban' && sid) {
    await connection.query(
      'UPDATE channels SET status = "active", banned_until = NULL, ban_reason = NULL, banned_by = NULL, rtmp_disabled = 0 WHERE id = ?',
      [sid]
    );
  } else if (type === 'channel_delete' && sid) {
    await connection.query(
      `UPDATE channels SET status = 'active', deleted_at = NULL, deleted_by_admin = 0, rtmp_disabled = 0 WHERE id = ? AND user_id = ?`,
      [sid, userId]
    );
  } else if (type === 'record_ban' && sid) {
    await connection.query(
      `UPDATE records SET status = 'active' WHERE id = ?`,
      [sid]
    );
  } else if (type === 'geo_block' && sid) {
    await connection.query(
      `UPDATE channels SET geo_block_countries = NULL, geo_block_reason = NULL, geo_block_show_reason = 0, geo_blocked_by = NULL WHERE id = ?`,
      [sid]
    );
  }

  await connection.query(
    `UPDATE appeal_tickets
     SET status = 'resolved_overturned', judge_id = ?, resolved_at = NOW(), updated_at = NOW()
     WHERE id = ?`,
    [judgeId, ticket.id]
  );
}

async function executeUphold(connection, ticket, judgeId, verdictNote) {
  await connection.query(
    `UPDATE appeal_tickets
     SET status = 'resolved_upheld', judge_id = ?, verdict_note = ?, resolved_at = NOW(), updated_at = NOW()
     WHERE id = ?`,
    [judgeId, verdictNote || null, ticket.id]
  );
}

module.exports = {
  SUBJECT_LABELS,
  STATUS_LABELS,
  subjectLabel,
  statusLabel,
  isJudge,
  isRespondent,
  publicAuthorTitle,
  buildUserFacingFacts,
  buildStaffFacingFacts,
  outcomeSummary,
  appealPath,
  appealAbsoluteUrl,
  siteAbsoluteUrl,
  adminAbsoluteUrl,
  appealTicketUserUrl,
  appealTicketAdminUrl,
  withAppealCta,
  sanitizeSnapshotForUser,
  findOpenTicket,
  createAppealTicket,
  executeOverturn,
  executeUphold
};
