require('dotenv').config();
require('./utils/validateEnv').validateEnv('web-admin');
const express = require('express');
const path = require('path');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const { pool } = require('./config/db');
const dashboardRoutes = require('./routes/dashboard');
const { requireAdminAuth } = require('./middlewares/auth');

const port = process.env.PORT || 3002;
const app = express();

app.set('trust proxy', 1);

app.use((req, res, next) => {
  let ipHeader = req.headers['x-forwarded-for'];
  if (ipHeader) {
    if (Array.isArray(ipHeader)) {
      ipHeader = ipHeader.join(',');
    }
    if (typeof ipHeader === 'string') {
      const parts = ipHeader.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) {
        req.headers['x-forwarded-for'] = parts[parts.length - 1];
      }
    }
  }
  next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.json({ limit: '5mb' }));

// Disable caching for dynamic admin pages
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

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
  httpOnly: true,
  sameSite: 'lax',
  secure: secureCookies
};
if (process.env.SESSION_DOMAIN) {
  cookieConfig.domain = process.env.SESSION_DOMAIN;
}

// Sync with main app's session
app.use(session({
  key: sessionKey, // Same cookie name as main app
  secret: process.env.SESSION_SECRET, // Same secret as main app (validated at startup)
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: cookieConfig
}));

// Override res.redirect to always save session first
// This fixes the "double click" bug where the redirect happens before session is written to DB
app.use((req, res, next) => {
  const originalRedirect = res.redirect;
  res.redirect = function() {
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

// Middleware to log 403 and 500 errors into system_logs
app.use((req, res, next) => {
  const originalStatus = res.status;
  res.status = function(code) {
    if (code === 403 || code === 500) {
      const { logAction } = require('./utils/logger');
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
      const user = req.session && req.session.user ? req.session.user.username : 'Неизвестный';
      const action = code === 403 
        ? `Заблокирован доступ к ${req.originalUrl} (Ошибка 403)`
        : `Произошла внутренняя ошибка сервера (500) при запросе к ${req.originalUrl}`;
      
      logAction('system', user, action, ip).catch(err => console.error('Error logging system event:', err));
    }
    return originalStatus.apply(res, arguments);
  };
  next();
});

// Flash messages middleware
app.use((req, res, next) => {
  res.locals.success_msg = req.session.success_msg || null;
  res.locals.error_msg = req.session.error_msg || null;
  delete req.session.success_msg;
  delete req.session.error_msg;
  next();
});

// Global settings middleware
app.use(async (req, res, next) => {
  try {
    const { pool } = require('./config/db');
    const [rows] = await pool.query('SELECT setting_key, setting_value FROM system_settings');
    const settings = {};
    for (const row of rows) {
      settings[row.setting_key] = row.setting_value;
    }
    res.locals.systemSettings = settings;
    res.locals.invite_system_enabled = settings['invite_system_enabled'] === '1'; // keep for backward compatibility
  } catch (err) {
    console.error('Error fetching settings in admin panel:', err);
    res.locals.systemSettings = {};
    res.locals.invite_system_enabled = false;
  }
  next();
});

app.locals.CDN_BASE_URL = process.env.CDN_BASE_URL || '';
app.locals.APP_URL = process.env.APP_URL || 'http://localhost:3001';
try {
  const geoBlock = require('./utils/geoBlock');
  app.locals.GEO_COUNTRY_OPTIONS = geoBlock.GEO_COUNTRY_OPTIONS;
  app.locals.geoCountryLabel = geoBlock.countryLabel;
  app.locals.formatGeoCountries = geoBlock.formatCountryListLabels;
  app.locals.parseGeoCountries = geoBlock.parseCountryList;
} catch (e) {
  app.locals.GEO_COUNTRY_OPTIONS = [];
  app.locals.geoCountryLabel = (c) => c;
  app.locals.formatGeoCountries = () => '';
  app.locals.parseGeoCountries = () => [];
}
// --- TIMEZONE SYSTEM ---
app.locals.formatDate = (dateString, timezone = 'Europe/Moscow', formatStr = 'DD.MM.YYYY HH:mm:ss') => {
  if (!dateString) return 'Нет данных';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return 'Нет данных';

  try {
    if (formatStr === 'DD.MM.YYYY') {
      const options = { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: timezone };
      return new Intl.DateTimeFormat('ru-RU', options).format(date);
    } else if (formatStr === 'DD.MM.YYYY HH:mm') {
      const options = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: timezone };
      return new Intl.DateTimeFormat('ru-RU', options).format(date).replace(',', ' в');
    } else if (formatStr === 'DD.MM.YYYY HH:mm:ss') {
      const options = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: timezone };
      return new Intl.DateTimeFormat('ru-RU', options).format(date).replace(',', ' в');
    } else if (formatStr === 'YYYY-MM-DD') {
      const options = { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timezone };
      const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(date);
      return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
    }
  } catch (e) {
    return new Intl.DateTimeFormat('ru-RU').format(date);
  }
  return '';
};

// Aliasing for compatibility with old templates
app.locals.formatDateMsk = (dateStr) => app.locals.formatDate(dateStr, 'Europe/Moscow', 'DD.MM.YYYY HH:mm:ss');

app.locals.escapeHtml = (unsafe) => {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

app.use((req, res, next) => {
  res.locals.userTimezone = 'Europe/Moscow';
  next();
});
// -----------------------
// Apply auth middleware to all routes
app.use(requireAdminAuth);

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const csrf = require('csurf');

// Helmet for basic security headers (disabling CSP to not break inline scripts)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// Rate limiting for admin panel to prevent brute forcing
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // 300 requests per IP in 15 mins
  message: 'Слишком много запросов. Пожалуйста, подождите 15 минут.'
});
app.use(adminLimiter);

// CSRF Protection
const csrfProtection = csrf({ cookie: false });
app.use(csrfProtection);

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
    res.render = function(view, options, callback) {
      const self = this;
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      options = options || {};
      options.csrfToken = token;
      
      originalRender.call(this, view, options, function(err, html) {
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

// Mount routes
app.use('/', dashboardRoutes);

const recordsRoutes = require('./routes/records');
app.use('/records', recordsRoutes);

const channelsRoutes = require('./routes/channels');
app.use('/', channelsRoutes);

const staffRoutes = require('./routes/staff');
app.use('/', staffRoutes);

const bansRoutes = require('./routes/bans');
app.use('/', bansRoutes);

const reportsRoutes = require('./routes/reports');
app.use('/reports', reportsRoutes);

const transfersRoutes = require('./routes/transfers');
app.use('/transfers', transfersRoutes);

const appealsRoutes = require('./routes/appeals');
app.use('/appeals', appealsRoutes);

const newsRoutes = require('./routes/news');
app.use('/news', newsRoutes);

const announcesRoutes = require('./routes/announces');
app.use('/announces', announcesRoutes);

const broadcastsRoutes = require('./routes/broadcasts');
app.use('/broadcasts', broadcastsRoutes);

const logsRoutes = require('./routes/logs');
app.use('/', logsRoutes);

// 404 handler
app.use((req, res, next) => {
  res.status(404).render('404', { 
    currentPath: req.originalUrl,
    pageTitle: 'Страница не найдена | Админ-панель',
    user: req.session.user
  });
});

const waitDb = async () => {
  let retries = 15;
  while (retries > 0) {
    try {
      const conn = await pool.getConnection();
      await conn.query('SELECT 1');
      conn.release();
      break;
    } catch (e) {
      retries--;
      if (retries === 0) throw e;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
};

waitDb().then(() => {
  app.listen(port, '0.0.0.0', () => {
    console.log(`Admin panel listening on port ${port}`);
    // Start Telegram bot polling
    try {
      const { startTelegramBotPolling } = require('./utils/telegram');
      startTelegramBotPolling();
    } catch (tgPollError) {
      console.error('Failed to start Telegram Bot Polling:', tgPollError);
    }
  });
}).catch(err => {
  console.error('Admin panel failed to connect to DB', err);
  process.exit(1);
});

