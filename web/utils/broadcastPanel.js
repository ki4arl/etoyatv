'use strict';

const ACTION_LABELS = [
  { re: /^Начата трансляция \(Камера (\d+)\)$/i, label: (m) => `Начал эфир (камера ${m[1]})` },
  { re: /^Окончена трансляция \(Камера (\d+)\)$/i, label: (m) => `Завершил эфир (камера ${m[1]})` },
  { re: /^Начата трансляция/i, label: () => 'Начал эфир' },
  { re: /^Окончена трансляция/i, label: () => 'Завершил эфир' },
  { re: /^Автоматический сброс трансляции/i, label: () => 'Автосброс эфира' },
  { re: /^Неудачная попытка публикации/i, label: () => 'Отклонён вход в эфир' },
  { re: /^Неуспешный запуск трансляции/i, label: () => 'Неуспешный запуск' }
];

function formatRuDateTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function roleLabel(role) {
  if (role === 'owner') return 'Владелец';
  if (role === 'coowner') return 'Совладелец';
  if (role === 'reporter') return 'Репортёр';
  return 'Участник';
}

function friendlyAction(actionText) {
  const text = String(actionText || '');
  for (const item of ACTION_LABELS) {
    const m = text.match(item.re);
    if (m) return item.label(m);
  }
  return text;
}

function parseLogActor(logUsername, channelName) {
  const raw = String(logUsername || '');
  const suffix = `(${channelName})`;
  if (channelName && raw.endsWith(suffix)) {
    return raw.slice(0, -suffix.length) || raw;
  }
  const m = raw.match(/^(.+)\(([^)]*)\)\s*$/);
  return m ? m[1] : raw;
}

/**
 * Publishers for a channel + optional live marker.
 */
async function getBroadcastCrew(connection, channel) {
  const channelId = channel.id;
  const ownerId = channel.user_id;
  const currentStreamerId = channel.is_live ? channel.current_streamer_id : null;

  const [ownerRows] = await connection.query(
    'SELECT id, username, avatar FROM users WHERE id = ? LIMIT 1',
    [ownerId]
  );
  const crew = [];
  if (ownerRows.length) {
    crew.push({
      user_id: ownerRows[0].id,
      username: ownerRows[0].username,
      avatar: ownerRows[0].avatar || '/images/default_user_avatar.png',
      role: 'owner',
      role_label: roleLabel('owner'),
      is_live: currentStreamerId != null && Number(currentStreamerId) === Number(ownerRows[0].id)
    });
  }

  const [team] = await connection.query(
    `SELECT u.id, u.username, u.avatar, t.is_coowner, t.is_reporter
     FROM channel_team t
     JOIN users u ON u.id = t.user_id
     WHERE t.channel_id = ? AND (t.is_coowner = 1 OR t.is_reporter = 1)
     ORDER BY t.is_coowner DESC, u.username ASC`,
    [channelId]
  );

  for (const row of team) {
    if (Number(row.id) === Number(ownerId)) continue;
    const role = row.is_coowner == 1 ? 'coowner' : 'reporter';
    crew.push({
      user_id: row.id,
      username: row.username,
      avatar: row.avatar || '/images/default_user_avatar.png',
      role,
      role_label: roleLabel(role),
      is_live: currentStreamerId != null && Number(currentStreamerId) === Number(row.id)
    });
  }

  // If somehow current streamer is not in crew (stale key / edge), still show them
  if (currentStreamerId && !crew.some((c) => Number(c.user_id) === Number(currentStreamerId))) {
    const [extra] = await connection.query(
      'SELECT id, username, avatar FROM users WHERE id = ? LIMIT 1',
      [currentStreamerId]
    );
    if (extra.length) {
      crew.unshift({
        user_id: extra[0].id,
        username: extra[0].username,
        avatar: extra[0].avatar || '/images/default_user_avatar.png',
        role: 'reporter',
        role_label: 'Ведущий',
        is_live: true
      });
    }
  }

  const liveMember = crew.find((c) => c.is_live) || null;
  return {
    is_live: !!channel.is_live,
    live_started_at: channel.live_started_at || null,
    live_started_at_fmt: channel.live_started_at ? formatRuDateTime(channel.live_started_at) : null,
    current_streamer: liveMember,
    members: crew
  };
}

/**
 * Channel RTMP logs for owners — no IP.
 */
async function getBroadcastLogs(connection, channel, { limit = 40 } = {}) {
  const channelName = channel.name || '';
  const suffix = `(${channelName})`;
  const [rows] = await connection.query(
    `SELECT created_at, username, action_text
     FROM system_logs
     WHERE log_type = 'rtmp'
       AND RIGHT(username, CHAR_LENGTH(?)) = ?
       AND (
         action_text LIKE 'Начата трансляция%'
         OR action_text LIKE 'Окончена трансляция%'
         OR action_text LIKE 'Автоматический сброс трансляции%'
         OR action_text LIKE 'Неудачная попытка публикации%'
         OR action_text LIKE 'Неуспешный запуск трансляции%'
       )
     ORDER BY created_at DESC
     LIMIT ?`,
    [suffix, suffix, limit]
  );

  return rows.map((row) => ({
    at: row.created_at,
    at_fmt: formatRuDateTime(row.created_at),
    actor: parseLogActor(row.username, channelName),
    action: friendlyAction(row.action_text)
  }));
}

module.exports = {
  getBroadcastCrew,
  getBroadcastLogs,
  formatRuDateTime,
  roleLabel
};
