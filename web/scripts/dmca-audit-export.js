'use strict';
/**
 * One-off audit: list channels/records with non-default design media.
 * Usage: node scripts/dmca-audit-export.js [--json-only]
 */
require('dotenv').config();
const mysql = require('mysql2/promise');

const DEFAULTS = new Set([
  '/images/default_channel_logo.png',
  '/images/default_channel_logo_50.png',
  '/images/logo_cort.png',
  '/images/default_user_avatar.png',
  null,
  ''
]);

function isCustomUrl(v) {
  if (!v || DEFAULTS.has(v)) return false;
  const s = String(v);
  if (s.includes('default_')) return false;
  return true;
}

async function main() {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  const [[chCount]] = await c.query(
    'SELECT COUNT(*) AS n FROM channels WHERE status != ?',
    ['deleted']
  );
  const [[recCount]] = await c.query('SELECT COUNT(*) AS n FROM records');
  console.log('channels', chCount.n, 'records', recCount.n);

  const [channels] = await c.query(`
    SELECT c.id, c.shortname, c.name, c.user_id, u.username,
      c.logo_url, c.banner_url, c.bg_url, c.player_logo, c.player_bg_url, c.status
    FROM channels c
    JOIN users u ON u.id = c.user_id
    WHERE c.status NOT IN ('deleted', 'pending')
  `);

  const customCh = [];
  for (const ch of channels) {
    const fields = [];
    for (const k of ['logo_url', 'banner_url', 'bg_url', 'player_logo', 'player_bg_url']) {
      const v = ch[k];
      if (isCustomUrl(v)) fields.push({ k, v });
    }
    if (fields.length) {
      customCh.push({
        id: ch.id,
        shortname: ch.shortname,
        name: ch.name,
        user_id: ch.user_id,
        username: ch.username,
        fields
      });
    }
  }
  console.log('channels_custom_design', customCh.length);

  const [records] = await c.query(`
    SELECT r.id, r.title, r.thumbnail_url, r.video_url, r.channel_id,
      c.shortname, c.user_id, u.username
    FROM records r
    JOIN channels c ON c.id = r.channel_id
    JOIN users u ON u.id = c.user_id
  `);

  const customRec = records.filter((r) => isCustomUrl(r.thumbnail_url));
  console.log('records_total', records.length, 'custom_thumbs', customRec.length);

  let news = [];
  try {
    const [rows] = await c.query(`
      SELECT n.id, n.channel_id, LEFT(n.content, 80) AS content_preview, n.image_url,
        c.shortname, c.user_id, u.username
      FROM channel_news n
      JOIN channels c ON c.id = n.channel_id
      JOIN users u ON u.id = c.user_id
      WHERE n.image_url IS NOT NULL AND n.image_url != ''
    `);
    news = rows;
  } catch (e) {
    console.log('channel_news_skip', e.message);
  }
  console.log('news_with_images', news.length);

  const out = {
    customCh,
    customRec: customRec.map((r) => ({
      id: r.id,
      title: r.title,
      thumbnail_url: r.thumbnail_url,
      channel_id: r.channel_id,
      shortname: r.shortname,
      user_id: r.user_id,
      username: r.username
    })),
    news
  };

  console.log('---AUDIT_JSON---');
  console.log(JSON.stringify(out));
  console.log('---END---');

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
