'use strict';

const {
  extractEmailDomain,
  checkEmailDisposable,
  refreshDisposableDomains
} = require('../config/disposableEmailDomains');

const CHANNEL_PENDING_NOTICE =
  'Ваш телеканал создан и ожидает одобрения администрацией (аккаунт на временной почте). Пока канал не одобрен, он скрыт от зрителей и эфир недоступен. По вопросам: обратитесь к администрации этого инстанса';

const TRANSFER_PENDING_NOTICE =
  'Канал получен, но ожидает одобрения администрацией, потому что ваш аккаунт на временной почте. До одобрения канал скрыт от зрителей. По вопросам: обратитесь к администрации этого инстанса';

/**
 * Mark email as disposable for labeling. Does NOT block channel creation —
 * new channels go to status pending_approval instead.
 * Preserves explicit admin whitelist (channel_approval_status = approved).
 */
async function flagUserDisposable(connection, userId) {
  const [res] = await connection.query(
    `UPDATE users SET
       email_is_disposable = 1,
       needs_channel_approval = IF(channel_approval_status = 'approved', 0, 1),
       channel_approval_status = IF(channel_approval_status IN ('approved', 'rejected'), channel_approval_status, 'pending')
     WHERE id = ? AND email_is_disposable = 0`,
    [userId]
  );
  return !!(res && res.affectedRows);
}

/**
 * Whether newly created / transferred channels for this user must wait for staff approval.
 * Staff always skip. Admin whitelist (channel_approval_status=approved) also skips.
 */
async function userRequiresChannelModeration(connection, userId, { isStaff = false } = {}) {
  if (isStaff) return { required: false, reason: null };

  const [rows] = await connection.query(
    'SELECT email, email_is_disposable, channel_approval_status FROM users WHERE id = ?',
    [userId]
  );
  if (!rows.length) return { required: false, reason: 'not_found' };
  const u = rows[0];

  // Explicit admin whitelist: channels go live immediately
  if (u.channel_approval_status === 'approved') {
    return { required: false, reason: null };
  }

  if (u.email_is_disposable) {
    return { required: true, reason: 'flagged' };
  }

  const check = await checkEmailDisposable(u.email);
  if (check.disposable) {
    await flagUserDisposable(connection, userId);
    console.log(
      `[disposable] user ${userId} marked disposable (${check.reason}: ${check.domain}${check.mx ? ' via ' + check.mx : ''})`
    );
    return { required: true, reason: check.reason || 'list' };
  }

  return { required: false, reason: null };
}

/** @deprecated use userRequiresChannelModeration — kept for any leftover callers */
async function checkChannelOwnershipAllowed(connection, userId, opts = {}) {
  const mod = await userRequiresChannelModeration(connection, userId, opts);
  // Always allow create/transfer; moderation is applied to the channel status.
  if (opts.blockIfRejected && mod.required === false) {
    const [rows] = await connection.query(
      'SELECT channel_approval_status FROM users WHERE id = ?',
      [userId]
    );
    if (rows.length && rows[0].channel_approval_status === 'rejected') {
      return { allowed: false, reason: 'rejected' };
    }
  }
  return { allowed: true, reason: null, moderation: mod };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Re-scan accounts: mark disposable emails, clear obsolete user-level "pending"
 * queue (moderation is now per-channel). Does not touch already-active channels.
 */
async function backfillDisposableUsers(pool) {
  // Clear user-level pending that blocked creation — channels are moderated now
  try {
    await pool.query(
      `UPDATE users SET needs_channel_approval = 0, channel_approval_status = 'none'
       WHERE channel_approval_status = 'pending' AND needs_channel_approval = 1`
    );
  } catch (e) {
    console.error('[disposable] clear user-level pending:', e.message);
  }

  const [users] = await pool.query(
    `SELECT u.id, u.email FROM users u
     LEFT JOIN staff s ON s.user_id = u.id
     WHERE u.deleted_at IS NULL AND s.user_id IS NULL
       AND u.email_is_disposable = 0 AND u.email IS NOT NULL AND u.email <> ''
       AND u.channel_approval_status != 'approved'`
  );
  if (!users.length) return { scanned: 0, flagged: 0 };

  const byDomain = new Map();
  for (const u of users) {
    const d = extractEmailDomain(u.email);
    if (!d) continue;
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(u.id);
  }

  const domains = [...byDomain.keys()];
  const results = await mapLimit(domains, 8, (d) => checkEmailDisposable('x@' + d));

  let flagged = 0;
  for (let i = 0; i < domains.length; i++) {
    if (!results[i] || !results[i].disposable) continue;
    for (const userId of byDomain.get(domains[i])) {
      const ok = await flagUserDisposable(pool, userId);
      if (ok) flagged++;
    }
  }

  console.log(`[disposable] backfill scanned ${users.length} users / ${domains.length} domains, flagged ${flagged}`);
  return { scanned: users.length, flagged };
}

function startDisposableJobs(pool) {
  const run = async (refresh) => {
    try {
      if (refresh) await refreshDisposableDomains();
      await backfillDisposableUsers(pool);
    } catch (e) {
      console.error('[disposable] job failed:', e.message);
    }
  };
  setTimeout(() => run(false), 25000);
  setTimeout(() => run(true), 2 * 60 * 1000);
  setInterval(() => run(true), 24 * 60 * 60 * 1000);
}

module.exports = {
  CHANNEL_PENDING_NOTICE,
  TRANSFER_PENDING_NOTICE,
  flagUserDisposable,
  userRequiresChannelModeration,
  checkChannelOwnershipAllowed,
  backfillDisposableUsers,
  startDisposableJobs
};
