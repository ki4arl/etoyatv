const supportedThemes = ['default', 'modern'];
const supportedSchemes = ['dark', 'light'];
const DEFAULT_THEME = 'default';
const DEFAULT_SCHEME = 'dark';

/*
 * Оформление телеканала владелец подбирает под классическую тему, где фоном
 * страницы служит его собственный цвет или картинка. В тёмной теме текст лежит
 * на студийной темноте, и почти чёрный цвет владельца там исчезает совсем.
 * Поэтому такие цвета подтягиваем к светлому, а все остальные отдаём как есть.
 */
const MIN_TEXT_LUMINANCE = 0.12;
const TEXT_ON_DARK = [233, 241, 248]; // --text из theme_tokens.css

function parseHexColor(value) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || '').trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? match[1].replace(/./g, (c) => c + c) : match[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function relativeLuminance([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

// Цвет, пригодный для основного текста на тёмном фоне
function readableOnDark(value) {
  const rgb = parseHexColor(value);
  // rgba(), hsl() и именованные цвета не разбираем — отдаём без изменений
  if (!rgb) return value;
  if (relativeLuminance(rgb) >= MIN_TEXT_LUMINANCE) return value;

  const lifted = rgb.map((channel, i) => Math.round(channel + (TEXT_ON_DARK[i] - channel) * 0.62));
  return `rgb(${lifted.join(', ')})`;
}

function getCookie(req, name) {
  if (!req.headers.cookie) return null;
  const match = req.headers.cookie.match(new RegExp('(^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[2]) : null;
}

/*
 * Телефоны и планшеты без явного выбора темы получают «Эфир»: там есть
 * viewport и адаптивная вёрстка. Классика рассчитана на ~980px и на мобиле
 * ломается. Явный выбор (настройки, cookie, ?theme=) всегда важнее.
 */
function isMobileRequest(req) {
  const chMobile = req.headers['sec-ch-ua-mobile'];
  if (chMobile === '?1') return true;
  if (chMobile === '?0') return false;

  const ua = String(req.headers['user-agent'] || '');
  if (!ua) return false;

  return /Android|webOS|iPhone|iPod|iPad|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet|CriOS|FxiOS|EdgiOS|Kindle|Silk/i.test(ua);
}

// Detect the interface theme, mirroring the language detection priority
function detectTheme(req) {
  // 1. Query parameter
  if (req.query && req.query.theme && supportedThemes.includes(req.query.theme)) {
    return req.query.theme;
  }

  // 2. Явный выбор в сессии (/api/set-theme, настройки)
  if (req.session && req.session.theme && supportedThemes.includes(req.session.theme)) {
    return req.session.theme;
  }

  // 3. Cookie theme
  const cookieTheme = getCookie(req, 'theme');
  if (cookieTheme && supportedThemes.includes(cookieTheme)) {
    return cookieTheme;
  }

  // 4. В профиле сохранена только «Эфир» — заводское default не считаем выбором
  if (req.session && req.session.user && req.session.user.theme === 'modern') {
    return 'modern';
  }

  // 5. Мобильные без явного выбора — «Эфир»
  if (isMobileRequest(req)) {
    return 'modern';
  }

  // 6. Заводское default у залогиненных на десктопе
  if (req.session && req.session.user && req.session.user.theme === 'default') {
    return 'default';
  }

  return DEFAULT_THEME;
}

function detectColorScheme(req) {
  if (req.query && req.query.scheme && supportedSchemes.includes(req.query.scheme)) {
    return req.query.scheme;
  }
  if (req.session && req.session.user && req.session.user.color_scheme && supportedSchemes.includes(req.session.user.color_scheme)) {
    return req.session.user.color_scheme;
  }
  if (req.session && req.session.color_scheme && supportedSchemes.includes(req.session.color_scheme)) {
    return req.session.color_scheme;
  }
  const cookieScheme = getCookie(req, 'color_scheme');
  if (cookieScheme && supportedSchemes.includes(cookieScheme)) {
    return cookieScheme;
  }
  return DEFAULT_SCHEME;
}

module.exports = function (req, res, next) {
  const currentTheme = detectTheme(req);
  const currentScheme = detectColorScheme(req);

  req.theme = currentTheme;
  req.colorScheme = currentScheme;
  req.supportedThemes = supportedThemes;
  req.supportedSchemes = supportedSchemes;

  res.locals.currentTheme = currentTheme;
  res.locals.colorScheme = currentScheme;
  res.locals.supportedThemes = supportedThemes;
  res.locals.supportedSchemes = supportedSchemes;
  res.locals.isModernTheme = currentTheme === 'modern';
  res.locals.themeBodyClass = 'theme_' + currentTheme;
  res.locals.themeReadableColor = readableOnDark;

  next();
};

module.exports.detectTheme = detectTheme;
module.exports.isMobileRequest = isMobileRequest;
module.exports.detectColorScheme = detectColorScheme;
module.exports.readableOnDark = readableOnDark;
module.exports.supportedThemes = supportedThemes;
module.exports.supportedSchemes = supportedSchemes;
module.exports.DEFAULT_THEME = DEFAULT_THEME;
module.exports.DEFAULT_SCHEME = DEFAULT_SCHEME;
