/*
 * Согласование инлайновых стилей с современной темой.
 *
 * В шаблонах около 2600 атрибутов style="...", и по специфичности они
 * побеждают любой файл темы. Поэтому старая палитра переписывается на токены
 * темы прямо в готовом HTML — в том же проходе cheerio, который уже делает
 * перевод текста.
 *
 * Значения не удаляются, а сопоставляются, и это принципиально:
 *  - смысловые цвета (красный, зелёный, бирюзовый, жёлтый баннер) остаются как
 *    есть, иначе пропадёт значение статусов;
 *  - в footer.ejs скрипт ищет блоки уведомлений селектором по инлайновому
 *    цвету (div[style*="color:#39b54a"]), удаление цвета его бы сломало;
 *  - геометрия (width, margin, display, position) не трогается вообще;
 *  - любое значение с url(...) сохраняется, потому что это содержимое
 *    (логотипы каналов, превью записей, снапшоты эфира), а не оформление.
 */

// Область действия: только каркас основного сайта. Панель управления и
// встраиваемые виджеты подчиняются оформлению канала, их палитру менять нельзя.
const SCOPE_SELECTOR = '#header, #content, #footer, #promopage, #promopage_auth';

// Элемент (или его родитель) с этим атрибутом пропускается целиком
const OPT_OUT_ATTR = 'data-theme-keep-style';

// Фоны: тёмно-серые поверхности старого дизайна
const BACKGROUND_MAP = {
  '#3e3e3e': 'var(--bg)',
  '#212121': 'var(--bg-elevated)',
  '#1a1a1a': 'var(--bg)',
  '#111': 'var(--bg)',
  '#111111': 'var(--bg)',
  // Чистый чёрный не трогаем: он осмыслен для областей плеера и превью
  '#232323': 'var(--surface-2)',
  '#2b2b2b': 'var(--surface)',
  '#262626': 'var(--surface)',
  '#2a2a2a': 'var(--surface)',
  '#222': 'var(--surface)',
  '#222222': 'var(--surface)',
  '#333': 'var(--surface-3)',
  '#333333': 'var(--surface-3)',
  '#444': 'var(--surface-3)',
  '#444444': 'var(--surface-3)',
  '#555': 'var(--surface-3)',
  '#555555': 'var(--surface-3)'
};

// Рамки
const BORDER_MAP = {
  // Значения по умолчанию у каналов без своего оформления: темнее любой
  // поверхности темы, поэтому читались как случайная тёмная обводка
  '#1a1a1a': 'var(--border)',
  '#262626': 'var(--border)',
  '#2a2a2a': 'var(--border)',
  '#2b2b2b': 'var(--border)',
  '#111': 'var(--border)',
  '#111111': 'var(--border)',
  '#222': 'var(--border)',
  '#222222': 'var(--border)',
  '#333': 'var(--border)',
  '#333333': 'var(--border)',
  '#444': 'var(--border-strong)',
  '#444444': 'var(--border-strong)',
  '#555': 'var(--border-strong)',
  '#555555': 'var(--border-strong)',
  '#666': 'var(--border-strong)',
  '#666666': 'var(--border-strong)'
};

// Текст: приглушённые серые старой темы
const TEXT_MAP = {
  '#c0c0b2': 'var(--text)',
  '#e0e0e0': 'var(--text)',
  '#ccc': 'var(--text)',
  '#cccccc': 'var(--text)',
  '#aaa': 'var(--muted)',
  '#aaaaaa': 'var(--muted)',
  '#999': 'var(--muted)',
  '#999999': 'var(--muted)',
  '#888': 'var(--muted)',
  '#888888': 'var(--muted)',
  '#7d7d7d': 'var(--muted)',
  '#777': 'var(--muted-dim)',
  '#777777': 'var(--muted-dim)',
  '#666': 'var(--muted-dim)',
  '#666666': 'var(--muted-dim)'
};

/**
 * Делит объявления по ';', не разрывая скобки:
 * data:image/svg+xml;base64,... внутри url() должно остаться целым.
 */
function splitDeclarations(style) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of style) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.filter(d => d.trim());
}

function mapForProperty(prop) {
  if (prop === 'color') return TEXT_MAP;
  if (prop.startsWith('border') || prop === 'outline' || prop === 'outline-color') return BORDER_MAP;
  if (prop === 'background' || prop.startsWith('background-')) return BACKGROUND_MAP;
  return null;
}

/** Заменяет известные цвета внутри одного значения, остальное оставляет. */
function remapValue(value, map) {
  let changed = false;

  // Шестнадцатеричные цвета
  let next = value.replace(/#[0-9a-fA-F]{3,8}\b/g, (hex) => {
    const replacement = map[hex.toLowerCase()];
    if (!replacement) return hex;
    changed = true;
    return replacement;
  });

  return changed ? next : null;
}

function remapStyleAttribute(style) {
  const declarations = splitDeclarations(style);
  let changed = false;

  const result = declarations.map((declaration) => {
    const colonAt = declaration.indexOf(':');
    if (colonAt === -1) return declaration;

    const rawProp = declaration.slice(0, colonAt);
    const rawValue = declaration.slice(colonAt + 1);
    const prop = rawProp.trim().toLowerCase();

    // Содержимое, а не оформление: картинки не трогаем
    if (rawValue.includes('url(')) return declaration;

    const map = mapForProperty(prop);
    if (!map) return declaration;

    const mapped = remapValue(rawValue, map);
    if (mapped === null) return declaration;

    changed = true;
    return `${rawProp}:${mapped}`;
  });

  return changed ? result.join(';') : null;
}

/**
 * Приводит инлайновые стили готового документа к палитре современной темы.
 * Работает на уже загруженном cheerio, второго разбора HTML не делает.
 *
 * @param {object} $ загруженный экземпляр cheerio
 * @returns {number} сколько атрибутов было изменено
 */
function harmonizeInlineStyles($) {
  let touched = 0;

  $('[style]').each((i, el) => {
    const $el = $(el);

    if ($el.closest(`[${OPT_OUT_ATTR}]`).length) return;
    if (!$el.closest(SCOPE_SELECTOR).length) return;

    const style = $el.attr('style');
    if (!style || style.indexOf('#') === -1) return;

    const remapped = remapStyleAttribute(style);
    if (remapped === null) return;

    $el.attr('style', remapped);
    touched++;
  });

  return touched;
}

module.exports = {
  harmonizeInlineStyles,
  remapStyleAttribute,
  splitDeclarations,
  SCOPE_SELECTOR,
  OPT_OUT_ATTR
};
