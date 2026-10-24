'use strict';
/**
 * Rename DMCA-brand channels and notify owners.
 * Usage:
 *   node scripts/dmca-rename-channels.js --dry-run
 *   node scripts/dmca-rename-channels.js --apply
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mysql = require('mysql2/promise');

const apply = process.argv.includes('--apply');

const CHANNEL_BRAND_RE = new RegExp(
  [
    '(^|[^a-z0-9а-яё])nrj([^a-z0-9а-яё]|$)',
    '(^|[^a-z0-9а-яё])mtv([^a-z0-9а-яё]|$)',
    'karusel',
    'карусел',
    '(^|[^a-z0-9а-яё])tnt([^a-z0-9а-яё]|$)',
    '(^|[^a-z0-9а-яё])тнт([^a-z0-9а-яё]|$)',
    'brawl',
    'fixik',
    'фиксик',
    'tvrain',
    'дожд',
    'dozhd',
    'russia\\s*6',
    'россия\\s*6',
    'dvd.?rip',
    'pop\\s*fm',
    'popfm',
    '(^|[^a-z0-9а-яё])ntv([^a-z0-9а-яё]|$)',
    'нтв',
    '(^|[^a-z0-9а-яё])sts([^a-z0-9а-яё]|$)',
    '(^|[^а-яёa-z0-9])стс([^а-яёa-z0-9]|$)',
    '(^|[^a-z0-9а-яё])ren\\s*tv([^a-z0-9а-яё]|$)',
    'рентв',
    'match\\s*tv',
    'матч\\s*тв',
    'disney',
    'nickelodeon',
    'paw\\s*patrol',
    'щеняч',
    'маша\\s*и\\s*медвед',
    'supercell',
    'geometry\\s*dash',
    // compound slugs that embed brands
    'nrjhit|nrj12|mtvhit|mtv_|tntfake|tnt\\d|dvdrip'
  ].join('|'),
  'i'
);

function brandIn(text) {
  return CHANNEL_BRAND_RE.test(String(text || ''));
}

function sanitizeBase(shortname, id) {
  let base = String(shortname || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g)
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (!base || brandIn(base) || base.length < 2) base = `channel_${id}`;
  // strip brand tokens from slug if still present after regex
  base = base
    .replace(/nrj|mtv|karusel|tnt|brawl|fixik|tvrain|dvdrip|popfm|ntv|sts|rentv|disney|nickelodeon/gi, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (!base || base.length < 2) base = `channel_${id}`;
  return base.slice(0, 40);
}

async function uniqueShortname(connection, id, preferred) {
  let candidate = preferred;
  let n = 0;
  for (;;) {
    const [rows] = await connection.query(
      'SELECT id FROM channels WHERE LOWER(shortname) = LOWER(?) AND id != ? LIMIT 1',
      [candidate, id]
    );
    if (!rows.length) return candidate;
    n += 1;
    candidate = `${preferred}_${n}`.slice(0, 48);
  }
}

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  const [channels] = await connection.query(`
    SELECT c.id, c.name, c.shortname, c.user_id, c.status, u.username
    FROM channels c
    JOIN users u ON u.id = c.user_id
    WHERE c.status NOT IN ('deleted')
  `);

  const hits = channels.filter(
    (ch) => brandIn(ch.name) || brandIn(ch.shortname)
  );

  console.log(apply ? 'MODE apply' : 'MODE dry-run');
  console.log('hits', hits.length);

  const notifyByUser = new Map();
  const results = [];

  for (const ch of hits) {
    const oldName = ch.name;
    const oldShort = ch.shortname;
    const newName = `Канал #${ch.id}`;
    // Always neutralize slug when brand is in name or shortname — URLs expose brands too.
    let newShort = await uniqueShortname(connection, ch.id, `channel_${ch.id}`);

    console.log(
      `#${ch.id} ${oldShort} → ${newShort} | "${oldName}" → "${newName}" | @${ch.username}`
    );

    if (apply) {
      await connection.query(
        'UPDATE channels SET name = ?, shortname = ? WHERE id = ?',
        [newName, newShort, ch.id]
      );
    }

    results.push({ id: ch.id, oldName, newName, oldShort, newShort, user_id: ch.user_id });

    if (!notifyByUser.has(ch.user_id)) notifyByUser.set(ch.user_id, []);
    const slugNote =
      oldShort !== newShort
        ? ` (ссылка: /${oldShort} → /${newShort})`
        : '';
    notifyByUser.get(ch.user_id).push(
      `название телеканала «${oldName}» изменено на «${newName}»${slugNote}`
    );
  }

  const sendSystemMessage = require('../utils/systemMessage');
  console.log('users_to_notify', notifyByUser.size);

  for (const [userId, lines] of notifyByUser) {
    const body =
      `DMCA Detect\n\n` +
      `По обращению правообладателей название телеканала изменено, так как оно нарушало авторские или смежные права (использование чужих брендов / торговых марок):\n` +
      `${lines.map((l) => `• ${l}`).join('\n')}\n\n` +
      `Повторное использование чужих названий и логотипов может привести к ограничению канала. ` +
      `Если вы считаете решение ошибочным — напишите через обратную связь на сайте (раздел DMCA).`;

    console.log(`--- notify user_id=${userId} ---`);
    console.log(body);
    console.log('---');

    if (apply) {
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
