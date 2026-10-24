const crypto = require('crypto');

const SECURITY_BAN_REASON =
  'Блокировка в целях безопасности вашего аккаунта от рук злоумышленников. Обращаться к администрации сайта: обратитесь к администрации этого инстанса';

const FP_COOKIE = 'etoyatv_dfp';
const FP_HEADER = 'x-device-fingerprint';
const MAX_RAW_LEN = 512;

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch (_) {
      out[key] = val;
    }
  }
  return out;
}

function getRawFingerprint(req) {
  const fromBody = req.body && (req.body.device_fingerprint || req.body.fingerprint);
  const fromHeader = req.headers && req.headers[FP_HEADER];
  const cookies = parseCookies(req);
  const fromCookie = cookies[FP_COOKIE];
  const raw = String(fromBody || fromHeader || fromCookie || '').trim();
  if (!raw || raw.length > MAX_RAW_LEN) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) return null;
  return raw;
}

function getUserAgent(req) {
  const ua = (req.headers && req.headers['user-agent']) || '';
  return String(ua).slice(0, 512);
}

function hashFingerprint(rawFp, _uaIgnored) {
  if (!rawFp) return null;
  // Hash raw device signals only — do not fold mutable User-Agent into the ban key
  return crypto
    .createHash('sha256')
    .update(String(rawFp))
    .digest('hex');
}

/** Legacy hash (raw|UA) kept for matching older bans until they expire/rotate. */
function legacyHashFingerprint(rawFp, ua) {
  if (!rawFp) return null;
  return crypto
    .createHash('sha256')
    .update(`${rawFp}|${ua || ''}`)
    .digest('hex');
}

function getRequestFingerprint(req) {
  const raw = getRawFingerprint(req);
  const ua = getUserAgent(req);
  const fp_hash = hashFingerprint(raw);
  const fp_hash_legacy = legacyHashFingerprint(raw, ua);
  return { raw, ua, fp_hash, fp_hash_legacy };
}

async function isFingerprintBanned(connection, fpHash, legacyHash) {
  if (!fpHash && !legacyHash) return null;
  const hashes = [fpHash, legacyHash].filter(Boolean);
  if (!hashes.length) return null;
  const placeholders = hashes.map(() => '?').join(',');
  const [rows] = await connection.query(
    `SELECT id, fp_hash, ua, ip_ban_id, source_ip, banned_by, reason, ban_type, created_at
     FROM banned_fingerprints WHERE fp_hash IN (${placeholders}) AND lifted_at IS NULL LIMIT 1`,
    hashes
  );
  return rows.length ? rows[0] : null;
}

function normalizeBanType(banType) {
  return banType === 'full' ? 'full' : 'account';
}

/** Viewer-only ban from IP or fingerprint (account type). */
function isViewerOnlyBan(req) {
  return (req.ip_ban && req.ip_ban.ban_type === 'account') ||
    (req.fp_ban && req.fp_ban.ban_type === 'account');
}

function viewerOnlyBanMessage(req) {
  if (req.fp_ban && req.fp_ban.ban_type === 'account' && !(req.ip_ban && req.ip_ban.ban_type === 'account')) {
    return 'Ваше устройство заблокировано для использования аккаунтов. Вы можете находиться на сайте только в режиме зрителя.';
  }
  return 'Ваш IP-адрес заблокирован для использования аккаунтов. Вы можете находиться на сайте только в режиме зрителя.';
}

async function rememberBannedFingerprint(connection, {
  fpHash,
  ua,
  ipBanId,
  sourceIp,
  bannedBy,
  reason,
  banType
}) {
  if (!fpHash) return;
  const type = normalizeBanType(banType);
  await connection.query(
    `INSERT INTO banned_fingerprints (fp_hash, ua, ip_ban_id, source_ip, banned_by, reason, ban_type, created_at, lifted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NULL)
     ON DUPLICATE KEY UPDATE
       ua = VALUES(ua),
       ip_ban_id = COALESCE(VALUES(ip_ban_id), ip_ban_id),
       source_ip = COALESCE(VALUES(source_ip), source_ip),
       banned_by = COALESCE(VALUES(banned_by), banned_by),
       reason = COALESCE(VALUES(reason), reason),
       ban_type = VALUES(ban_type),
       lifted_at = NULL`,
    [fpHash, ua || null, ipBanId || null, sourceIp || null, bannedBy || null, reason || null, type]
  );
}

async function liftFingerprintsForIpBan(connection, ipBanId) {
  if (!ipBanId) return;
  await connection.query(
    'UPDATE banned_fingerprints SET lifted_at = NOW() WHERE ip_ban_id = ? AND lifted_at IS NULL',
    [ipBanId]
  );
}

async function liftFingerprintsForIpAddress(connection, ipAddress) {
  if (!ipAddress) return;
  await connection.query(
    `UPDATE banned_fingerprints bf
     INNER JOIN ip_bans ib ON bf.ip_ban_id = ib.id
     SET bf.lifted_at = NOW()
     WHERE ib.ip_address = ? AND bf.lifted_at IS NULL`,
    [ipAddress]
  );
  // Also lift rows that only stored source_ip without ip_ban_id link
  await connection.query(
    `UPDATE banned_fingerprints SET lifted_at = NOW()
     WHERE source_ip = ? AND ip_ban_id IS NULL AND lifted_at IS NULL`,
    [ipAddress]
  );
}

async function liftFingerprintByHash(connection, fpHash) {
  if (!fpHash) return;
  await connection.query(
    'UPDATE banned_fingerprints SET lifted_at = NOW() WHERE fp_hash = ? AND lifted_at IS NULL',
    [fpHash]
  );
}

async function rememberFingerprintsForIp(connection, ipAddress, meta = {}) {
  if (!ipAddress) return;
  const [users] = await connection.query(
    'SELECT last_fp_hash, last_fp_ua FROM users WHERE last_ip = ? AND last_fp_hash IS NOT NULL',
    [ipAddress]
  );
  for (const u of users) {
    await rememberBannedFingerprint(connection, {
      fpHash: u.last_fp_hash,
      ua: u.last_fp_ua,
      ipBanId: meta.ipBanId || null,
      sourceIp: ipAddress,
      bannedBy: meta.bannedBy || null,
      reason: meta.reason || null,
      banType: meta.banType || 'account'
    });
  }
}

async function updateUserLastFingerprint(connection, userId, fpHash, ua) {
  if (!userId || !fpHash) return;
  await connection.query(
    'UPDATE users SET last_fp_hash = ?, last_fp_ua = ? WHERE id = ?',
    [fpHash, ua || null, userId]
  );
}

async function ensureAccessBlock(connection, fpHash, hours = 2) {
  if (!fpHash) return null;
  const [active] = await connection.query(
    'SELECT id, blocked_until FROM fingerprint_access_blocks WHERE fp_hash = ? AND blocked_until > NOW() ORDER BY blocked_until DESC LIMIT 1',
    [fpHash]
  );
  if (active.length) return active[0];
  await connection.query(
    'INSERT INTO fingerprint_access_blocks (fp_hash, blocked_until, created_at) VALUES (?, DATE_ADD(NOW(), INTERVAL ? HOUR), NOW())',
    [fpHash, hours]
  );
  const [rows] = await connection.query(
    'SELECT id, blocked_until FROM fingerprint_access_blocks WHERE fp_hash = ? ORDER BY id DESC LIMIT 1',
    [fpHash]
  );
  return rows[0] || null;
}

async function getActiveAccessBlock(connection, fpHash) {
  if (!fpHash) return null;
  const [rows] = await connection.query(
    'SELECT id, blocked_until FROM fingerprint_access_blocks WHERE fp_hash = ? AND blocked_until > NOW() ORDER BY blocked_until DESC LIMIT 1',
    [fpHash]
  );
  return rows.length ? rows[0] : null;
}

async function banAccountForStolenSession(connection, userId, adminId = null) {
  await connection.query(
    `UPDATE users SET is_banned = 1, banned_by = ?, banned_until = NULL, ban_reason = ?, show_ban_reason = 1, deleted_at = NULL WHERE id = ?`,
    [adminId, SECURITY_BAN_REASON, userId]
  );
  await connection.query(
    'UPDATE channels SET status = "banned", deleted_at = NULL, rtmp_disabled = 1 WHERE user_id = ?',
    [userId]
  );
}

module.exports = {
  SECURITY_BAN_REASON,
  FP_COOKIE,
  FP_HEADER,
  getRawFingerprint,
  getUserAgent,
  hashFingerprint,
  legacyHashFingerprint,
  getRequestFingerprint,
  isFingerprintBanned,
  normalizeBanType,
  isViewerOnlyBan,
  viewerOnlyBanMessage,
  rememberBannedFingerprint,
  liftFingerprintsForIpBan,
  liftFingerprintsForIpAddress,
  liftFingerprintByHash,
  rememberFingerprintsForIp,
  updateUserLastFingerprint,
  ensureAccessBlock,
  getActiveAccessBlock,
  banAccountForStolenSession
};
