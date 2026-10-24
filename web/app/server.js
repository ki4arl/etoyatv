require('dotenv').config();
require('../utils/validateEnv').validateEnv('web-app');
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const emailService = require('../emailService');
const http = require('http');
const { Server } = require('socket.io');

const geoip = require('geoip-lite');
const { xffSanitizer } = require('../middlewares/xff');
const {
  edgeUrlsForRequest,
  startRuEdgeHealthProbe,
  ruEdgeRedirectMiddleware,
  getRuEdgeStatus,
} = require('../utils/ruEdge');
const port = process.env.PORT || 3001;

const app = express();
app.set('trust proxy', 1);

app.use(xffSanitizer);
app.use(ruEdgeRedirectMiddleware);
startRuEdgeHealthProbe();

function isOldUserAgent(ua) {
  if (!ua) return false;

  // Windows XP (NT 5.1/5.2) or Windows Vista (NT 6.0)
  const winMatch = ua.match(/Windows NT ([0-9\.]+)/);
  if (winMatch) {
    const ver = parseFloat(winMatch[1]);
    if (ver < 6.1) return true;
  }

  // Android < 7.1
  const androidMatch = ua.match(/Android\s+([0-9\.]+)/);
  if (androidMatch) {
    const ver = parseFloat(androidMatch[1]);
    if (ver < 7.1) return true;
  }

  // iOS <= 9
  const iosMatch = ua.match(/(iPhone|iPad|iPod).*OS\s+([0-9_\.]+)/);
  if (iosMatch) {
    const ver = parseFloat(iosMatch[2].replace(/_/g, '.'));
    if (ver < 10.0) return true;
  }

  // Internet Explorer <= 10
  if (/MSIE\s+([6-9]|10)\.0/.test(ua)) return true;

  // Presto-based Opera (old Presto engine)
  if (/Presto\//.test(ua)) return true;

  // Safari <= 9 (without Chrome in User-Agent)
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) {
    const safariMatch = ua.match(/Version\/([0-9\.]+)/);
    if (safariMatch) {
      const ver = parseFloat(safariMatch[1]);
      if (ver < 10.0) return true;
    }
  }

  return false;
}

function getSupermiumSuggestion(ua) {
  if (!ua) return false;
  const winMatch = ua.match(/Windows NT ([0-9\.]+)/);
  if (winMatch) {
    const ver = parseFloat(winMatch[1]);
    // Windows XP (5.1/5.2), Server 2003 (5.2), Vista (6.0), 7 (6.1), 8 (6.2), 8.1 (6.3)
    if (ver >= 5.1 && ver <= 6.3) {
      return true;
    }
  }
  return false;
}

function getFriendlyOSAndBrowser(ua) {
  if (!ua) return { os: 'Неизвестная ОС', browser: 'Неизвестный браузер' };

  let os = 'Неизвестная ОС';
  let browser = 'Неизвестный браузер';

  // Detect OS
  if (ua.includes('Windows NT 5.1')) os = 'Windows XP';
  else if (ua.includes('Windows NT 5.2')) os = 'Windows XP 64-bit / Server 2003';
  else if (ua.includes('Windows NT 6.0')) os = 'Windows Vista';
  else if (ua.includes('Windows NT 6.1')) os = 'Windows 7';
  else if (ua.includes('Windows NT 6.2')) os = 'Windows 8';
  else if (ua.includes('Windows NT 6.3')) os = 'Windows 8.1';
  else if (ua.includes('Windows NT 10.0')) os = 'Windows 10/11';
  else if (ua.includes('Android')) {
    const match = ua.match(/Android\s+([0-9\.]+)/);
    os = `Android ${match ? match[1] : ''}`;
  } else if (ua.includes('iPhone') || ua.includes('iPad') || ua.includes('iPod')) {
    const match = ua.match(/OS\s+([0-9_\.]+)/);
    os = `iOS ${match ? match[1].replace(/_/g, '.') : ''}`;
  } else if (ua.includes('Macintosh')) {
    os = 'macOS';
  } else if (ua.includes('Linux')) {
    os = 'Linux';
  }

  // Detect Browser
  if (ua.includes('MSIE') || ua.includes('Trident')) {
    const match = ua.match(/(?:MSIE\s+|rv:)([0-9\.]+)/);
    browser = `Internet Explorer ${match ? match[1] : ''}`;
  } else if (ua.includes('Presto') || ua.includes('OPR/')) {
    browser = 'Opera';
  } else if (ua.includes('Firefox')) {
    const match = ua.match(/Firefox\/([0-9\.]+)/);
    browser = `Firefox ${match ? match[1] : ''}`;
  } else if (ua.includes('Chrome')) {
    const match = ua.match(/Chrome\/([0-9\.]+)/);
    browser = `Chrome ${match ? match[1] : ''}`;
  } else if (ua.includes('Safari')) {
    const match = ua.match(/Version\/([0-9\.]+)/);
    browser = `Safari ${match ? match[1] : ''}`;
  }

  return { os, browser };
}

// Redirect HTTP to HTTPS for modern browsers, bypass for old OS/browsers
app.use((req, res, next) => {
  if (req.secure) {
    return next();
  }

  if (req.path.startsWith('/api/internal/')) {
    return next();
  }
  if (req.path === '/api/ru-edge-status' || req.path === '/healthz') {
    return next();
  }

  const ua = req.headers['user-agent'] || '';
  if (isOldUserAgent(ua)) {
    return next();
  }

  const rawHost = String(req.headers.host || '').split(':')[0].toLowerCase();
  let allowedHosts = [];
  try {
    if (process.env.APP_URL) allowedHosts.push(new URL(process.env.APP_URL).hostname.toLowerCase());
  } catch (e) {}
  if (process.env.SESSION_DOMAIN) {
    allowedHosts.push(process.env.SESSION_DOMAIN.replace(/^\./, '').toLowerCase());
  }
  allowedHosts.push('localhost');
  const hostOk = allowedHosts.some((h) => rawHost === h || rawHost.endsWith('.' + h));
  const redirectHost = hostOk ? req.headers.host : (allowedHosts[0] || 'localhost');
  res.redirect(301, 'https://' + redirectHost + req.originalUrl);
});

app.get('/api/ru-edge-status', (req, res) => {
  res.json(getRuEdgeStatus());
});

// Block old OS/browsers early and return HTTP 503
app.use((req, res, next) => {
  const ua = req.headers['user-agent'] || '';
  if (isOldUserAgent(ua)) {
    // Bypass for internal APIs, socket.io, and static assets
    if (
      req.path.startsWith('/api/') ||
      req.path.startsWith('/chat-assets/') ||
      req.path.startsWith('/socket.io/') ||
      /\.(css|js|png|jpe?g|gif|svg|ico|mp3|mp4|webm|woff2?|ttf|eot)$/i.test(req.path)
    ) {
      return next();
    }

    const detectedSystem = getFriendlyOSAndBrowser(ua);
    const showSupermium = getSupermiumSuggestion(ua);

    res.status(503).send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Доступ ограничен</title>
  <style type="text/css">
    body {
      background-color: #121212;
      color: #e0e0e0;
      font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 20px;
      text-align: center;
    }
    .warning-banner {
      background: #1e1e1e;
      border: 1px solid #ff5c5c;
      border-radius: 12px;
      padding: 30px;
      max-width: 650px;
      width: 90%;
      margin: 10vh auto;
      display: inline-block;
      text-align: left;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.8);
      box-sizing: border-box;
      vertical-align: middle;
    }
    .warning-banner h3 {
      color: #ff5c5c;
      margin-top: 0;
      margin-bottom: 15px;
      font-size: 20px;
      font-weight: bold;
      line-height: 1.4;
    }
    .warning-banner p {
      font-size: 14px;
      line-height: 1.6;
      margin-bottom: 20px;
      color: #cccccc;
    }
    .table-container {
      margin-bottom: 20px;
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .legacy-table {
      width: 100%;
      border-collapse: collapse;
      background: rgba(20, 20, 20, 0.5);
    }
    .legacy-table th, .legacy-table td {
      padding: 12px 16px;
      text-align: left;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      font-size: 14px;
    }
    .legacy-table th {
      background: rgba(255, 92, 92, 0.1);
      color: #ff5c5c;
      font-weight: 600;
    }
    .legacy-table tr:last-child td {
      border-bottom: none;
    }
    .badge-danger {
      background: rgba(255, 92, 92, 0.2);
      color: #ff8585;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 12px;
      border: 1px solid rgba(255, 92, 92, 0.3);
      display: inline-block;
    }
    .badge-success {
      background: rgba(46, 204, 113, 0.2);
      color: #2ecc71;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 12px;
      border: 1px solid rgba(46, 204, 113, 0.3);
      display: inline-block;
    }
    .supermium-box {
      background: rgba(0, 225, 255, 0.05);
      border: 1px solid rgba(0, 225, 255, 0.2);
      border-radius: 6px;
      padding: 20px;
      margin-top: 15px;
    }
    .supermium-box h4 {
      color: #00e1ff;
      margin-top: 0;
      margin-bottom: 10px;
      font-size: 16px;
      font-weight: bold;
    }
    .supermium-links {
      margin-top: 15px;
    }
    .supermium-btn {
      display: inline-block;
      background: #00a0e3;
      color: #ffffff !important;
      padding: 10px 20px;
      text-decoration: none !important;
      border-radius: 4px;
      font-weight: bold;
      font-size: 14px;
      border: none;
    }
    .supermium-btn:hover {
      background: #00c0ff;
    }
  </style>
</head>
<body>
  <div class="warning-banner">
    <h3>Доступ ограничен: операционная система или браузер не поддерживаются</h3>
    <p>
      Вход на сайт с вашего устройства заблокирован из соображений безопасности. Вы используете устаревшую операционную систему или веб-браузер, которые не поддерживают современные стандарты безопасного шифрования (SSL/TLS), медиа-кодеки и API-интерфейсы. Для продолжения работы вам необходимо обновить ПО или использовать рекомендованный браузер.
    </p>
    
    <div class="table-container">
      <table class="legacy-table">
        <thead>
          <tr>
            <th>Параметр</th>
            <th>Ваше окружение</th>
            <th>Рекомендуемое окружение</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Операционная система</strong></td>
            <td>
              <span class="badge-danger">${detectedSystem.os}</span>
            </td>
            <td>Windows 10 / 11, Android 7.1+, iOS 10+, Linux, macOS</td>
          </tr>
          <tr>
            <td><strong>Браузер</strong></td>
            <td>
              <span class="badge-danger">${detectedSystem.browser}</span>
            </td>
            <td>Современные версии Chrome, Firefox, Opera, Safari</td>
          </tr>
          <tr>
            <td><strong>Статус безопасности</strong></td>
            <td>
              <span class="badge-danger">
                [Небезопасно] Небезопасное HTTP-соединение
              </span>
            </td>
            <td>
              <span class="badge-success">
                [Защищено] Защищенное HTTPS-соединение
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    ${showSupermium ? `
      <div class="supermium-box">
        <h4>[Решение] Решение для пользователей ${detectedSystem.os}:</h4>
        <p style="margin-bottom: 10px; font-size: 14px; line-height: 1.6;">
          Чтобы полноценно пользоваться сайтом с сохранением поддержки современных протоколов безопасности и медиа-функций, мы рекомендуем установить современный веб-браузер <strong>Supermium</strong>. Это полноценный порт современных версий Chromium, специально адаптированный для работы на Windows XP, Vista, 7, 8 и 8.1.
        </p>
        <div class="supermium-links">
          <a href="http://lunastore.app/download.php?id=32" class="supermium-btn">Скачать Supermium</a>
        </div>
      </div>
    ` : `
      <div class="supermium-box" style="background: rgba(255, 255, 255, 0.02); border-color: rgba(255, 255, 255, 0.1);">
        <h4>[Рекомендация] Рекомендация по обновлению:</h4>
        <p style="margin-bottom: 0; font-size: 14px; line-height: 1.6;">
          Пожалуйста, обновите операционную систему вашего устройства или установите последнюю поддерживаемую версию современного браузера (Google Chrome, Mozilla Firefox, Opera) для полноценного и безопасного доступа ко всем функциям платформы.
        </p>
      </div>
    `}
  </div>
</body>
</html>`);
    return;
  }
  next();
});

app.locals.CDN_BASE_URL = process.env.CDN_BASE_URL || '';
app.locals.RTMP_STREAM_URL = process.env.RTMP_STREAM_URL || 'http://localhost:8080/live';
app.locals.RTMP_INGEST_URL = process.env.RTMP_INGEST_URL || 'rtmp://localhost/live';
app.locals.ADMIN_URL = process.env.ADMIN_URL || 'http://localhost:3002';

// Always define before any request — EJS crashes if missing.
app.locals.ASSET_VERSION = String(Math.floor(Date.now() / 1000));
(function resolveAssetVersion() {
  const fromEnv = process.env.ASSET_VERSION && String(process.env.ASSET_VERSION).trim();
  if (fromEnv) {
    app.locals.ASSET_VERSION = fromEnv;
    return;
  }
  try {
    const { execSync } = require('child_process');
    // server.js lives in web/app → web root is ..
    const hash = execSync('git rev-parse --short HEAD', {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (hash) {
      app.locals.ASSET_VERSION = hash;
      return;
    }
  } catch (_) { /* no git in container */ }
  try {
    const pkg = require('../package.json');
    if (pkg && pkg.version) {
      app.locals.ASSET_VERSION = `${pkg.version}-${app.locals.ASSET_VERSION}`;
    }
  } catch (_) { /* keep boot stamp */ }
})();
console.log('[assets] ASSET_VERSION=', app.locals.ASSET_VERSION);


const server = http.createServer(app);
const { requireAuth, globalAuthMiddleware } = require('../middlewares/auth');
const { panelMiddleware, recordUploadMiddleware, designUploadMiddleware } = require('../middlewares/panel');
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});
app.set('io', io);
global.io = io;

const { upload, uploadDesign, uploadRecord } = require('../config/upload');
// Set EJS as templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use('/chat-assets', express.static(path.join(__dirname, '../public/js')));

// Private archives — never serve as public static / CDN-open files
app.use((req, res, next) => {
  const p = (req.path || '').split('?')[0];
  if (
    p.startsWith('/uploads/exports') ||
    p.startsWith('/uploads/transfers') ||
    p.startsWith('/storage/') ||
    p.startsWith('/private/')
  ) {
    return res.status(404).end();
  }
  next();
});

app.use(express.static(path.join(__dirname, '../public'), {
  maxAge: '365d',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // Long cache is safe: HTML always references ?v=ASSET_VERSION which changes on deploy.
    // Without a versioned URL browsers still revalidate via ETag/Last-Modified if we omit immutable —
    // but our templates always append ?v=, so immutable is OK for fingerprinted requests.
    if (/\.(css|js|mjs|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|mp3|webp|apng)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
    if (/\.(png|jpe?g|gif|svg|ico|webp|apng|bmp|avif)$/i.test(filePath)) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

// Disable caching for all dynamic routes
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

const { pool, initDbPromise } = require('../config/db');

const MySQLStore = require('express-mysql-session')(session);
const sessionStore = new MySQLStore({
  clearExpired: true,
  checkExpirationInterval: 900000,
  expiration: 2592000000, // 30 days
  createDatabaseTable: false
}, pool);
const secureCookies = /^https:\/\//i.test(process.env.APP_URL || '');
const sessionKey = secureCookies ? 'etoyatv_session_v2' : 'etoyatv_session_local';
const cookieConfig = {
  maxAge: 2592000000,
  sameSite: 'lax',
  secure: secureCookies
};
if (process.env.SESSION_DOMAIN) {
  cookieConfig.domain = process.env.SESSION_DOMAIN;
}

const sessionMiddleware = session({
  key: sessionKey,
  secret: process.env.SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: cookieConfig
});

// Speedtest Endpoints (Bypassing session middleware to avoid session lock race conditions and language reset)
// Stream a repeating incompressible pattern so multi-hundred-Mbit links can saturate.
const SPEEDTEST_CHUNK = crypto.randomBytes(256 * 1024); // 256 KiB random pattern
const SPEEDTEST_MAX = 64 * 1024 * 1024; // 64 MiB per request
const speedtestLimiter = require('express-rate-limit')({
  windowMs: 60 * 1000,
  // Parallel chunk workers need many req/s on fast links (4× down + 3× up).
  max: 3600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many speedtest requests' }
});

function writeSpeedtestPayload(res, size) {
  let sent = 0;
  function writeMore() {
    while (sent < size) {
      const n = Math.min(SPEEDTEST_CHUNK.length, size - sent);
      const ok = res.write(SPEEDTEST_CHUNK.subarray(0, n));
      sent += n;
      if (!ok) {
        res.once('drain', writeMore);
        return;
      }
    }
    res.end();
  }
  writeMore();
}

app.get('/api/speedtest/download', speedtestLimiter, (req, res) => {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Content-Encoding', 'identity');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.query.ping) {
    return res.end('pong');
  }
  let size = parseInt(req.query.size, 10) || (8 * 1024 * 1024);
  if (!Number.isFinite(size) || size < 1024) size = 1024 * 1024;
  if (size > SPEEDTEST_MAX) size = SPEEDTEST_MAX;
  res.setHeader('Content-Length', size);
  writeSpeedtestPayload(res, size);
});

app.post('/api/speedtest/upload', speedtestLimiter, (req, res) => {
  let bytesReceived = 0;
  req.on('data', (chunk) => {
    bytesReceived += chunk.length;
    // discard — do not buffer the whole body in memory
  });
  req.on('end', () => {
    res.json({ success: true, size: bytesReceived });
  });
  req.on('error', () => {
    if (!res.headersSent) res.status(400).json({ success: false });
  });
});

app.use(sessionMiddleware);

// Share express-session with Socket.IO so chat can read unlockedChannels / user
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// Override res.redirect to always save session first
// This fixes the "double click" bug where the redirect happens before session is written to DB
app.use((req, res, next) => {
  const originalRedirect = res.redirect;
  res.redirect = function () {
    const args = arguments;
    if (req.session) {
      req.session.save(() => {
        originalRedirect.apply(res, args);
      });
    } else {
      originalRedirect.apply(res, args);
    }
  };
  next();
});

const themeMiddleware = require('../middlewares/theme');
app.use(themeMiddleware);

const i18nMiddleware = require('../middlewares/i18n');
app.use(i18nMiddleware);




// Middleware to log 500 errors from the main app into system_logs
app.use((req, res, next) => {
  const originalStatus = res.status;
  res.status = function (code) {
    if (code === 500) {
      const { logAction } = require('../utils/logger');
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      const user = req.session && req.session.user ? req.session.user.username : 'Неизвестный';
      const action = `Произошла внутренняя ошибка сервера (500) в главном приложении при запросе к ${req.originalUrl}`;

      logAction('system', user, action, ip).catch(err => console.error('Error logging system event:', err));
    }
    return originalStatus.apply(res, arguments);
  };
  next();
});

// Pass variables to all templates
app.use(async (req, res, next) => {
  if (req.session && req.session.user) {
    try {
      const { pool } = require('../config/db');
      const [users] = await pool.query('SELECT username, email, role, timezone, chat_color, avatar, lang, theme, color_scheme FROM users WHERE id = ?', [req.session.user.id]);
      if (users.length > 0) {
        const u = users[0];
        req.session.user.username = u.username;
        req.session.user.email = u.email;
        req.session.user.role = u.role;
        req.session.user.timezone = u.timezone;
        req.session.user.chat_color = u.chat_color;
        req.session.user.avatar = u.avatar;
        req.session.user.lang = u.lang || 'ru';
        req.session.user.theme = u.theme || 'default';
        req.session.user.color_scheme = u.color_scheme === 'light' ? 'light' : 'dark';
      }
    } catch (e) {
      console.error('Error refreshing user session:', e);
    }
  }

  if (req.session && req.session.user) {
    try {
      const { pool } = require('../config/db');
      const [staff] = await pool.query('SELECT role, is_superadmin, mask_mode, hide_admin_tools FROM staff WHERE user_id = ?', [req.session.user.id]);
      if (staff.length === 0) {
        delete req.session.user.staff_role;
        delete req.session.user.is_superadmin;
        delete req.session.user.mask_mode;
        delete req.session.user.hide_admin_tools;
      } else {
        req.session.user.staff_role = staff[0].role;
        req.session.user.is_superadmin = staff[0].is_superadmin === 1;
        req.session.user.mask_mode = staff[0].mask_mode;
        req.session.user.hide_admin_tools = staff[0].hide_admin_tools === 1;
      }
    } catch (e) {
      console.error('Error verifying staff session status:', e);
    }
  }

  const { encryptUser } = require('../utils/chatCrypto');
  res.locals.encryptUser = encryptUser;

  res.locals.user = req.session && req.session.user ? req.session.user : null;

  // Viewer country for geo-block (CF-IPCountry / geoip-lite); staff bypass
  try {
    const { geoLocalsMiddleware } = require('../utils/geoBlock');
    geoLocalsMiddleware(req, res, () => {});
  } catch (e) {
    res.locals.viewerCountry = '';
    res.locals.isStaffGeoBypass = false;
  }

  // Re-resolve after the session refresh above, so a theme changed in another
  // session is picked up on this request rather than the next one
  const themeMod = require('../middlewares/theme');
  const resolvedTheme = themeMod.detectTheme(req);
  const resolvedScheme = themeMod.detectColorScheme(req);
  req.theme = resolvedTheme;
  req.colorScheme = resolvedScheme;
  res.locals.currentTheme = resolvedTheme;
  res.locals.colorScheme = resolvedScheme;
  res.locals.isModernTheme = resolvedTheme === 'modern';
  res.locals.themeBodyClass = 'theme_' + resolvedTheme;

  res.locals.currentPath = req.path;
  res.locals.ASSET_VERSION = app.locals.ASSET_VERSION || '1';
  const edge = edgeUrlsForRequest(req);
  let baseCdn = edge.CDN_BASE_URL || process.env.CDN_BASE_URL || '';
  let appUrl = edge.APP_URL || process.env.APP_URL || 'http://localhost:3001';
  let adminUrl = edge.ADMIN_URL || process.env.ADMIN_URL || 'http://localhost:3002';
  let rtmpStreamUrl = edge.RTMP_STREAM_URL || process.env.RTMP_STREAM_URL || 'https://kctv.localhost/live';
  const weblateUrl = process.env.WEBLATE_URL || 'https://weblate.localhost/';
  if (!req.secure) {
    res.locals.CDN_BASE_URL = baseCdn.replace('https://', 'http://');
    res.locals.APP_URL = appUrl.replace('https://', 'http://');
    res.locals.ADMIN_URL = adminUrl.replace('https://', 'http://');
    res.locals.WEBLATE_URL = weblateUrl.replace('https://', 'http://');
    res.locals.RTMP_STREAM_URL = rtmpStreamUrl.replace('https://', 'http://');
  } else {
    res.locals.CDN_BASE_URL = baseCdn;
    res.locals.APP_URL = appUrl;
    res.locals.ADMIN_URL = adminUrl;
    res.locals.WEBLATE_URL = weblateUrl;
    res.locals.RTMP_STREAM_URL = rtmpStreamUrl;
  }

  const ua = req.headers['user-agent'] || '';
  const isOld = isOldUserAgent(ua);
  res.locals.isOldUA = isOld;
  res.locals.showSupermium = getSupermiumSuggestion(ua);
  if (isOld) {
    res.locals.detectedSystem = getFriendlyOSAndBrowser(ua);
  } else {
    res.locals.detectedSystem = null;
  }

  res.locals.HCAPTCHA_SITEKEY = process.env.HCAPTCHA_SITEKEY || '7d8ab54a-d248-41ac-89b8-abecc204de9e';
  try {
    const { pool } = require('../config/db');
    if (!app.locals.__settingsCache || (Date.now() - (app.locals.__settingsCacheAt || 0)) > 15000) {
      const [rows] = await pool.query('SELECT setting_key, setting_value FROM system_settings');
      const settings = {};
      for (const row of rows) {
        settings[row.setting_key] = row.setting_value;
      }
      app.locals.__settingsCache = settings;
      app.locals.__settingsCacheAt = Date.now();
    }
    const settings = app.locals.__settingsCache || {};
    res.locals.systemSettings = settings;
    res.locals.invite_system_enabled = settings['invite_system_enabled'] === '1';

    let parsedAds = {};
    try {
      if (settings['ads_config']) {
        const rawAds = JSON.parse(settings['ads_config']);
        for (const [slot, ads] of Object.entries(rawAds)) {
          let selectedAd = null;
          if (Array.isArray(ads) && ads.length > 0) {
            selectedAd = ads[Math.floor(Math.random() * ads.length)];
          } else if (!Array.isArray(ads)) {
            selectedAd = ads;
          }
          if (selectedAd && selectedAd.image && selectedAd.image.startsWith('/')) {
            selectedAd.image = res.locals.CDN_BASE_URL + selectedAd.image;
          }
          parsedAds[slot] = selectedAd;
        }
      }
    } catch (e) { }
    res.locals.adsConfig = parsedAds;
    res.locals.adsEnabled = settings['ads_enabled'] === '1';

    // Boosty donate nag popup (guests + users without linked Boosty; staff skipped)
    res.locals.showBoostyDonatePopup = false;
    try {
      if (settings['boosty_donate_popup'] === '1') {
        const path = req.path || '';
        const skipPopup =
          path.startsWith('/api/') ||
          path.startsWith('/tv,studio') ||
          path.indexOf('/panel') === 0 ||
          path === '/login' ||
          path === '/register' ||
          path.indexOf('/login') === 0 ||
          path.indexOf('/register') === 0;
        if (!skipPopup) {
          const uid = req.session && req.session.user && req.session.user.id;
          if (req.session && req.session.user && req.session.user.staff_role && req.session.user.mask_mode !== 'user_mask') {
            res.locals.showBoostyDonatePopup = false;
          } else if (!uid) {
            res.locals.showBoostyDonatePopup = true;
          } else {
            const [uBoosty] = await pool.query(
              'SELECT boosty_email FROM users WHERE id = ? LIMIT 1',
              [uid]
            );
            res.locals.showBoostyDonatePopup = !(uBoosty.length && uBoosty[0].boosty_email);
          }
        }
      }
    } catch (boostyPopupErr) {
      res.locals.showBoostyDonatePopup = false;
    }

  } catch (err) {
    res.locals.systemSettings = {};
    res.locals.invite_system_enabled = false;
    res.locals.adsConfig = {};
    res.locals.adsEnabled = false;
    res.locals.showBoostyDonatePopup = false;
  }
  next();
});

// Site disabled middleware
app.use(async (req, res, next) => {
  if (req.path.startsWith('/api/internal/')) return next();
  const isSiteDisabled = res.locals.systemSettings && res.locals.systemSettings['site_disabled'] === '1';
  if (isSiteDisabled) {
    const user = res.locals.user;
    if (user) {
      try {
        const { pool } = require('../config/db');
        const [staff] = await pool.query('SELECT role FROM staff WHERE user_id = ?', [user.id]);
        if (staff.length > 0) {
          return next(); // Staff can access
        }
      } catch (e) {
        console.error('Error checking staff role for site_disabled:', e);
      }
    }
    // For non-staff or guests, show disabled message
    const msg = res.locals.systemSettings['site_disabled_message'] || 'Сайт временно отключен.';
    return res.status(503).render('error', {
      status: 503,
      title: 'Сайт отключен',
      message: msg
    });
  }
  next();
});

// --- TIMEZONE SYSTEM ---
app.locals.formatDate = (dateString, timezone = 'Europe/Moscow', formatStr = 'DD.MM.YYYY') => {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '';

  try {
    if (formatStr === 'DD.MM.YYYY') {
      const options = { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: timezone };
      return new Intl.DateTimeFormat('ru-RU', options).format(date);
    } else if (formatStr === 'DD.MM.YYYY HH:mm') {
      const options = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: timezone };
      return new Intl.DateTimeFormat('ru-RU', options).format(date).replace(',', ' в');
    } else if (formatStr === 'DD MMMM YYYY') {
      const options = { day: '2-digit', month: 'long', year: 'numeric', timeZone: timezone };
      return new Intl.DateTimeFormat('ru-RU', options).format(date);
    } else if (formatStr === 'HH:mm') {
      const options = { hour: '2-digit', minute: '2-digit', timeZone: timezone };
      return new Intl.DateTimeFormat('ru-RU', options).format(date);
    } else if (formatStr === 'DD.MM') {
      const options = { day: '2-digit', month: '2-digit', timeZone: timezone };
      return new Intl.DateTimeFormat('ru-RU', options).format(date);
    } else if (formatStr === 'DD MMM') {
      const options = { day: '2-digit', month: 'short', timeZone: timezone };
      return new Intl.DateTimeFormat('ru-RU', options).format(date);
    } else if (formatStr === 'DD MMMM') {
      const options = { day: '2-digit', month: 'long', timeZone: timezone };
      return new Intl.DateTimeFormat('ru-RU', options).format(date);
    }
  } catch (e) {
    return new Intl.DateTimeFormat('ru-RU').format(date);
  }
  return '';
};

app.locals.escapeHtml = (unsafe) => {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

// Escape text, then turn http(s) URLs and /appeals/… paths into clickable links (for PM bodies).
app.locals.linkifyText = (unsafe) => {
  const escaped = app.locals.escapeHtml(unsafe);
  if (!escaped) return '';
  let out = escaped.replace(
    /https?:\/\/[^\s<]+/gi,
    (raw) => {
      let url = raw;
      let trailing = '';
      while (/[),.;:!?\]]$/.test(url)) {
        trailing = url.slice(-1) + trailing;
        url = url.slice(0, -1);
      }
      if (!/^https?:\/\//i.test(url)) return raw;
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer" class="darkblue">' + url + '</a>' + trailing;
    }
  );
  // Legacy relative appeal links in system PMs
  out = out.replace(
    /(^|[\s>])(\/appeals\/[A-Za-z0-9_\-./?=&%]+)/g,
    (m, pre, path) => {
      let url = path;
      let trailing = '';
      while (/[),.;:!?\]]$/.test(url)) {
        trailing = url.slice(-1) + trailing;
        url = url.slice(0, -1);
      }
      return pre + '<a href="' + url + '" class="darkblue">' + url + '</a>' + trailing;
    }
  );
  return out;
};

// Validate a CSS color value to prevent CSS/attribute injection (XSS).
// Accepts hex (#rgb..#rrggbbaa), rgb()/rgba(), and plain named colors; otherwise returns fallback.
app.locals.safeColor = (value, fallback = '') => {
  if (!value || typeof value !== 'string') return fallback;
  const s = value.trim();
  if (/^#[0-9A-Fa-f]{3,8}$/.test(s)) return s;
  if (/^rgba?\(\s*[\d.,%\s]+\)$/i.test(s)) return s;
  if (/^[a-zA-Z]{3,20}$/.test(s)) return s;
  return fallback;
};

// Validate a URL/path used inside CSS url() or href to prevent breakout/injection.
// Rejects quotes, parentheses, backslashes, whitespace and angle brackets.
app.locals.safeUrlPath = (value) => {
  if (!value || typeof value !== 'string') return '';
  const s = value.trim();
  if (/["'()\\\s<>]/.test(s)) return '';
  if (/^\/[^/]/.test(s) || /^https?:\/\//i.test(s)) return s;
  return '';
};

app.use((req, res, next) => {
  res.locals.userTimezone = (req.session && req.session.user && req.session.user.timezone)
    ? req.session.user.timezone
    : 'Europe/Moscow';
  next();
});
// -----------------------

const { isIpInBanRecord } = require('../utils/ipChecker');
const {
  getRequestFingerprint,
  isFingerprintBanned,
  ensureAccessBlock,
  getActiveAccessBlock
} = require('../utils/deviceFingerprint');

app.use(async (req, res, next) => {
  const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
  const { fp_hash: fpHash, fp_hash_legacy: fpLegacy } = getRequestFingerprint(req);
  req.device_fp = fpHash || null;

  if (!userIp && !fpHash) return next();

  let connection;
  try {
    const { pool } = require('../config/db');
    connection = await pool.getConnection();

    if (userIp) {
      const [bans] = await connection.query('SELECT id, ip_address, ban_type, reason FROM ip_bans');
      const matchedBan = bans.find(b => isIpInBanRecord(userIp, b.ip_address));

      if (matchedBan) {
        req.ip_ban = matchedBan;
        if (matchedBan.ban_type === 'full') {
          const safeReason = app.locals.escapeHtml(matchedBan.reason || 'не указана');
          connection.release();
          connection = null;
          return res.status(403).send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #121212; color: white; height: 100vh;">
              <h1>Доступ запрещен</h1>
              <p>Ваш IP-адрес был полностью заблокирован администрацией сайта.</p>
              <p>Причина: <strong>${safeReason}</strong></p>
            </div>
          `);
        }
      }
    }

    // Fingerprint block after IP change — respects ban_type like IP bans
    if (fpHash && !(req.ip_ban && req.ip_ban.ban_type === 'full') && !req.ip_ban) {
      const bannedFp = await isFingerprintBanned(connection, fpHash, fpLegacy);
      if (bannedFp) {
        const fpType = bannedFp.ban_type === 'full' ? 'full' : 'account';
        req.fp_ban = {
          ban_type: fpType,
          reason: bannedFp.reason,
          fp_hash: bannedFp.fp_hash
        };

        if (fpType === 'full') {
          let block = await getActiveAccessBlock(connection, fpHash);
          if (!block) {
            block = await ensureAccessBlock(connection, fpHash, 2);
          }
          if (block && new Date(block.blocked_until) > new Date()) {
            req.fp_access_block = block;
            connection.release();
            connection = null;
            return res.status(403).send(`
              <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #121212; color: white; height: 100vh;">
                <h1>Доступ временно ограничен</h1>
                <p>Обнаружено совпадение цифрового отпечатка с заблокированным устройством.</p>
                <p>Доступ будет восстановлен автоматически через некоторое время (до 2 часов).</p>
                <p>По вопросам безопасности: обратитесь к администрации этого инстанса</p>
              </div>
            `);
          }
        }
        // account: browsing as guest is allowed; login/register blocked via req.fp_ban
      }
    }
  } catch (e) {
    console.error('IP/fingerprint check error:', e);
  } finally {
    if (connection) {
      try { connection.release(); } catch (_) {}
    }
  }
  next();
});

app.use(globalAuthMiddleware);

const { startBackgroundJobs } = require('./jobs/background');
startBackgroundJobs({ pool, io });

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const csrf = require('csurf');

// Helmet for basic security headers (disabling CSP to not break inline scripts)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  frameguard: false
}));

// Apply X-Frame-Options: SAMEORIGIN to all routes except widget views
app.use((req, res, next) => {
  if (!req.path.startsWith('/widget/')) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }
  next();
});

// Rate limiting for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 requests per IP
  message: 'Слишком много попыток входа с этого IP, пожалуйста, подождите 15 минут.'
});
app.use('/login', authLimiter);
app.use('/register', authLimiter);
app.use('/forgot-password', authLimiter);
app.use('/reset-password', authLimiter);
app.use('/account/2fa/verify', authLimiter);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' }
});
app.use('/api/translate', apiLimiter);
app.use('/api/users/search', apiLimiter);

const transferUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Слишком много загрузок архива. Попробуйте позже.'
});
app.use('/ru/account,transfer/', transferUploadLimiter);
app.use('/account,transfer/', transferUploadLimiter);

// CSRF Protection — only MediaMTX internal webhooks are exempt (no browser cookie CSRF surface)
const csrfProtection = csrf({ cookie: false });
app.use((req, res, next) => {
  if (req.path.startsWith('/api/internal/rtmp')) return next();
  csrfProtection(req, res, next);
});

// CSRF error handler
app.use((err, req, res, next) => {
  if (err.code !== 'EBADCSRFTOKEN') return next(err);
  res.status(403).send('Отказано в доступе: недействительный CSRF токен. Пожалуйста, вернитесь назад, обновите страницу и попробуйте еще раз.');
});

// Transparent CSRF injection into forms
app.use((req, res, next) => {
  if (req.csrfToken) {
    const token = req.csrfToken();
    res.locals.csrfToken = token;

    const originalRender = res.render;
    res.render = function (view, options, callback) {
      const self = this;
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      options = options || {};
      options.csrfToken = token;



      originalRender.call(this, view, options, function (err, html) {
        if (err) {
          if (callback) return callback(err);
          return self.req.next(err);
        }

        // Inject CSRF token into all POST forms automatically using robust regex
        if (html && html.includes('<form')) {
          html = html.replace(/(<form\b(?:[^>"']|"[^"]*"|'[^']*')*>)/gi, (match) => {
            if (/method=['"]?POST['"]?/i.test(match)) {
              if (/enctype=['"]?multipart\/form-data['"]?/i.test(match)) {
                if (/action=['"]([^'"]*)['"]/i.test(match)) {
                  match = match.replace(/(action=['"])([^'"]*)(['"])/i, (m, p1, p2, p3) => {
                    const sep = p2.includes('?') ? '&' : '?';
                    return `${p1}${p2}${sep}_csrf=${token}${p3}`;
                  });
                }
              } else {
                match = match + `\n<input type="hidden" name="_csrf" value="${token}">`;
              }
            }
            return match;
          });
        }

        // Inject fetch override to automatically send CSRF token
        if (html && html.includes('</head>')) {
          const fetchOverride = `
<script>
  window.csrfToken = "${token}";
  window.friendsPost = function(action, username, confirmMsg) {
    const run = function() {
      const f = document.createElement('form');
      f.method = 'POST';
      f.action = action;
      const u = document.createElement('input');
      u.type = 'hidden';
      u.name = 'username';
      u.value = username;
      f.appendChild(u);
      const c = document.createElement('input');
      c.type = 'hidden';
      c.name = '_csrf';
      c.value = window.csrfToken || '';
      f.appendChild(c);
      document.body.appendChild(f);
      f.submit();
    };
    if (confirmMsg && typeof window.yatvConfirm === 'function') {
      window.yatvConfirm(confirmMsg, run);
    } else {
      run();
    }
  };
  const originalFetch = window.fetch;
  function resolveFetchUrl(resource) {
    if (typeof resource === 'string') {
      if (resource.charAt(0) === '/' && resource.charAt(1) !== '/') {
        return new URL(resource, window.location.origin).href;
      }
      try {
        var parsed = new URL(resource);
        if (parsed.username || parsed.password) {
          parsed.username = '';
          parsed.password = '';
          return parsed.href;
        }
      } catch (e) {}
    }
    return resource;
  }
  window.fetch = function(resource, config) {
    resource = resolveFetchUrl(resource);
    if (config && config.method && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(config.method.toUpperCase())) {
      config.headers = config.headers || {};
      if (config.headers instanceof Headers) {
        config.headers.append('X-CSRF-Token', window.csrfToken);
      } else {
        config.headers['X-CSRF-Token'] = window.csrfToken;
      }
      return originalFetch(resource, config);
    }
    if (config) return originalFetch(resource, config);
    return originalFetch(resource);
  };
</script>`;
          html = html.replace('</head>', fetchOverride + '\n</head>');
        }

        if (callback) return callback(null, html);
        self.send(html);
      });
    };
  }
  next();
});

// Mounting all route modules
const { langPrefixMiddleware } = require('../middlewares/langPrefix');
app.use(langPrefixMiddleware);

app.use('/', require('./routes/public'));
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/account'));
app.use('/', require('./routes/panel'));
app.use('/', require('./routes/channel'));
app.use('/', require('./routes/records'));
app.use('/', require('./routes/api'));
app.use('/', require('./routes/developer_api'));
app.use('/', require('./routes/404'));

require('./routes/chat')(io);

// Start the server
initDbPromise.then(() => {
  const { runStartupHeal } = require('./bootstrap/startup-heal');
  runStartupHeal({ pool });

  // Start background validation of stream formats & parameters
  const { startStreamValidator } = require('../utils/streamValidator');
  startStreamValidator();

  // Start background processing of system broadcasts (queues & email delivery)
  const { startBroadcastProcessor } = require('./utils/broadcastProcessor');
  startBroadcastProcessor();

  server.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on port ${port}`);
  });
});
