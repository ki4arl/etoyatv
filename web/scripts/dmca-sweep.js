'use strict';
/**
 * DMCA heuristic sweep: reset channel design assets and/or delete records, notify owners.
 * Usage:
 *   node scripts/dmca-sweep.js --dry-run
 *   node scripts/dmca-sweep.js --apply
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { deletePublicFileIfExists } = require('../utils/safePath');

const apply = process.argv.includes('--apply');
const publicRoot = process.env.MEDIA_STORAGE_PATH
  ? path.isAbsolute(process.env.MEDIA_STORAGE_PATH)
    ? process.env.MEDIA_STORAGE_PATH
    : path.resolve(__dirname, '../', process.env.MEDIA_STORAGE_PATH)
  : path.join(__dirname, '../public');

const DEFAULT_LOGO = '/images/default_channel_logo.png';

const CHANNEL_BRAND_RE = new RegExp(
  [
    '\\bnrj\\b',
    '\\bmtv\\b',
    'karusel',
    'карусел',
    '\\btnt\\b',
    'тнт\\d',
    'brawl',
    '\\bfixik',
    'фиксик',
    'tvrain',
    'дожд',
    'dozhd',
    'russia\\s*6',
    'россия\\s*6',
    'dvd.?rip',
    'pop\\s*fm',
    '\\bntv\\b',
    'нтв',
    '\\bsts\\b',
    'стс\\b',
    '\\bren\\s*tv\\b',
    '\\bрентв\\b',
    'match\\s*tv',
    'матч\\s*тв',
    'disney',
    'nickelodeon',
    'paw\\s*patrol',
    'щеняч',
    'мasha',
    'маша\\s*и\\s*медвед',
    'supercell',
    'geometry\\s*dash'
  ].join('|'),
  'i'
);

const RECORD_TITLE_RE = new RegExp(
  [
    'брат\\s*за\\s*брата',
    '\\benigma\\s*[-–—]',
    'geometry\\s*dash',
    'twitch[- ]?rip',
    'dvd[- ]?rip',
    'нтв\\s*мир',
    '\\btimotei\\b',
    'listapad',
    'листапад',
    'реклама\\s+(timotei|международного\\s+кинофестиваля)',
    'эфирная\\s+запись\\s+\\d+\\s+сери',
    'неполная\\s+эфирная\\s+запись',
    'зв[ёе]здный\\s+выбор',
    'мэшап.*меллстр',
    'меллстр.*чарт'
  ].join('|'),
  'i'
);

const NOTIFY_TEMPLATE = (parts) =>
  `DMCA Detect\n\n` +
  `По обращению правообладателей мы удалили материалы, которые, по имеющимся данным, нарушают авторские или смежные права:\n` +
  `${parts.map((p) => `• ${p}`).join('\n')}\n\n` +
  `Повторная загрузка подобного контента может привести к ограничению канала. ` +
  `Если вы считаете удаление ошибочным — ответьте через обратную связь на сайте (раздел DMCA).`;

function isCustomDesignUrl(v) {
  if (!v || typeof v !== 'string') return false;
  if (v === DEFAULT_LOGO) return false;
  if (v.includes('default_')) return false;
  return v.startsWith('/images/design/') || v.startsWith('/uploads/');
}

function unlinkRecordFiles(record) {
  if (!record) return;
  const { safeResolvePublic } = require('../utils/safePath');
  for (const key of ['video_url', 'thumbnail_url']) {
    if (record[key]) deletePublicFileIfExists(record[key], publicRoot, { ignoreDefaults: false });
  }
  if (record.hls_url) {
    const hlsFile = safeResolvePublic(record.hls_url, publicRoot);
    if (hlsFile) {
      const hlsDir = path.dirname(hlsFile);
      if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true });
    }
  }
}

async function resetChannelDesign(connection, channel) {
  const fields = ['logo_url', 'banner_url', 'bg_url', 'player_logo', 'player_bg_url'];
  const toDelete = [];
  for (const k of fields) {
    if (isCustomDesignUrl(channel[k])) toDelete.push(channel[k]);
  }
  if (!toDelete.length && channel.logo_url !== DEFAULT_LOGO && channel.logo_url) {
    // non-default logo path outside /images/design/
    if (!String(channel.logo_url).includes('default_channel_logo')) {
      toDelete.push(channel.logo_url);
    }
  }

  const updates = [
    'logo_url = ?',
    'banner_url = NULL',
    'bg_url = NULL',
    'player_logo = NULL',
    'player_bg_url = NULL'
  ];
  const params = [DEFAULT_LOGO, channel.id];

  if (apply) {
    for (const url of toDelete) {
      deletePublicFileIfExists(url, publicRoot, { ignoreDefaults: false });
    }
    await connection.query(`UPDATE channels SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  return { files: toDelete.length, updated: true };
}

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  const [channels] = await connection.query(`
    SELECT c.*, u.username
    FROM channels c
    JOIN users u ON u.id = c.user_id
    WHERE c.status NOT IN ('deleted', 'pending')
  `);

  const [records] = await connection.query(`
    SELECT r.*, c.shortname, c.name AS channel_name, c.user_id, u.username
    FROM records r
    JOIN channels c ON c.id = r.channel_id
    JOIN users u ON u.id = c.user_id
  `);

  const channelHits = [];
  for (const ch of channels) {
    const blob = `${ch.shortname} ${ch.name} ${ch.description || ''}`;
    if (CHANNEL_BRAND_RE.test(blob)) channelHits.push(ch);
  }

  const recordHits = records.filter((r) => RECORD_TITLE_RE.test(r.title || ''));

  const notifyByUser = new Map();

  function queueNotify(userId, line) {
    if (!notifyByUser.has(userId)) notifyByUser.set(userId, []);
    notifyByUser.get(userId).push(line);
  }

  console.log(apply ? 'MODE apply' : 'MODE dry-run');
  console.log('channel_brand_hits', channelHits.length);
  console.log('record_title_hits', recordHits.length);

  for (const ch of channelHits) {
    const hadCustom =
      isCustomDesignUrl(ch.logo_url) ||
      isCustomDesignUrl(ch.banner_url) ||
      isCustomDesignUrl(ch.bg_url) ||
      isCustomDesignUrl(ch.player_logo) ||
      isCustomDesignUrl(ch.player_bg_url);
    const reset = await resetChannelDesign(connection, ch);
    console.log(
      `[channel] #${ch.id} ${ch.shortname} (${ch.name}) user=${ch.username} design_reset=${reset.updated} files=${reset.files}`
    );
    if (hadCustom || reset.files) {
      queueNotify(
        ch.user_id,
        `оформление телеканала «${ch.name}» (логотип / обои / баннер)`
      );
    } else {
      queueNotify(
        ch.user_id,
        `материалы телеканала «${ch.name}» (проверка на сторонние бренды / оформление)`
      );
    }
  }

  for (const r of recordHits) {
    console.log(
      `[record] #${r.id} "${r.title}" @${r.shortname} user=${r.username}`
    );
    if (apply) {
      unlinkRecordFiles(r);
      await connection.query('DELETE FROM album_records WHERE record_id = ?', [r.id]);
      await connection.query('DELETE FROM records WHERE id = ?', [r.id]);
    }
    queueNotify(
      r.user_id,
      `запись «${r.title}» на канале «${r.channel_name || r.shortname}»`
    );
  }

  console.log('users_to_notify', notifyByUser.size);
  for (const [userId, lines] of notifyByUser) {
    const body = NOTIFY_TEMPLATE(lines);
    console.log(`--- notify user_id=${userId} lines=${lines.length} ---`);
    console.log(body);
    console.log('---');
    if (apply) {
      const sendSystemMessage = require('../utils/systemMessage');
      await sendSystemMessage(userId, body);
    }
  }

  await connection.end();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
