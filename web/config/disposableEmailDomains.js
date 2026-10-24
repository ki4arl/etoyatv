/**
 * Disposable / temporary email detection.
 * Sources: curated list below + config/disposable_domains.txt (merged public lists,
 * refreshed in memory every 24h) + MX lookup against the same list.
 * A hit never blocks registration — it routes the account to channel-creation moderation.
 */
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;

const CURATED_DOMAINS = [
  // From product request
  'yzcalo.com',
  'olipii.com',
  'ncleap.com',

  // Popular temp-mail providers
  'mail.tm',
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamailblock.com',
  'sharklasers.com',
  'grr.la',
  'guerrillamail.info',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamail.de',
  '10minutemail.com',
  '10minutemail.net',
  '10minemail.com',
  'temp-mail.org',
  'temp-mail.io',
  'tempmail.com',
  'tempmailo.com',
  'tempmail.net',
  'tmpmail.org',
  'tmpmail.net',
  'throwaway.email',
  'throwawaymail.com',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
  'coolhotmail.com',
  'discard.email',
  'discardmail.com',
  'discardmail.de',
  'spamgourmet.com',
  'maildrop.cc',
  'mailnesia.com',
  'trashmail.com',
  'trashmail.me',
  'trashmail.net',
  'trash-mail.com',
  'getnada.com',
  'nada.email',
  'emailondeck.com',
  'fakeinbox.com',
  'mailcatch.com',
  'inboxkitten.com',
  'mohmal.com',
  'tempail.com',
  'tempr.email',
  'dispostable.com',
  'mailnull.com',
  'spam4.me',
  'mytemp.email',
  'tmpeml.com',
  'emailtemporanea.net',
  'emailfake.com',
  'generator.email',
  'crazymailing.com',
  'getairmail.com',
  'mintemail.com',
  'mailforspam.com',
  'spamfree24.org',
  'spamfree24.de',
  'spamfree24.eu',
  'spamfree24.net',
  'spamfree24.com',
  'wegwerfemail.de',
  'wegwerf-email.de',
  'trash-me.com',
  'burnermail.io',
  'simplelogin.co',
  // common freemail abuse aliases used as disposable
  '1secmail.com',
  '1secmail.org',
  '1secmail.net',
  'wwjmp.com',
  'esiix.com',
  'xojxe.com',
  'yoggm.com',

  // tempmail.plus (live domain picker + same-provider siblings)
  'mailto.plus',
  'fexpost.com',
  'fexbox.org',
  'mailbox.in.ua',
  'rover.info',
  'chitthi.in',
  'fextemp.com',
  'any.pink',
  'merepost.com',
  'tofeat.com',
  'intopwa.com',
  'intopwa.net',
  'intopwa.org',
  'inpwa.com',
  'tempmail.plus',
  'fex.plus',
  'fex.in'
];

// Mainstream providers: never flagged, even if a public list mistakenly includes them.
const NEVER_DISPOSABLE = new Set([
  'gmail.com', 'googlemail.com', 'yandex.ru', 'ya.ru', 'yandex.com', 'yandex.by', 'yandex.kz', 'yandex.ua',
  'mail.ru', 'bk.ru', 'list.ru', 'inbox.ru', 'internet.ru', 'rambler.ru', 'lenta.ru', 'autorambler.ru',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'yahoo.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.de', 'gmx.com', 'gmx.net', 'web.de',
  'ukr.net', 'i.ua', 'meta.ua', 'tut.by', 'aol.com', 'zoho.com', 'mail.com', 'tutanota.com', 'tuta.io',
  'fastmail.com', 'qq.com', '163.com', '126.com', 'seznam.cz', 'wp.pl', 'onet.pl', 'interia.pl',
  'o2.pl', 'libero.it', 'orange.fr', 'free.fr', 'laposte.net', 't-online.de', 'vk.com', 'bigmir.net',
  // Mail hosting behind custom domains (MX targets)
  'yandex.net', 'google.com', 'outlook.com', 'office365.com', 'protection.outlook.com', 'zoho.eu',
  'zohomail.com', 'icloud.com', 'messagingengine.com', 'protonmail.ch', 'forwardemail.net', 'improvmx.com',
  'mxrouting.net', 'privateemail.com', 'registrar-servers.com', 'secureserver.net', 'ovh.net', 'gandi.net',
  'hostinger.com', 'beget.com', 'timeweb.ru', 'reg.ru', 'yahoodns.net', 'emailsrvr.com', 'mailbox.org',
  'migadu.com', 'ionos.com', 'kundenserver.de', 'amazonaws.com', 'mailgun.org', 'sendgrid.net',
  'cloudflare.net', 'mimecast.com', 'pphosted.com', 'iphmx.com'
]);

const LIST_FILE = path.join(__dirname, 'disposable_domains.txt');

const REMOTE_SOURCES = [
  { url: 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf', json: false },
  { url: 'https://raw.githubusercontent.com/disposable/disposable-email-domains/master/domains.txt', json: false },
  { url: 'https://raw.githubusercontent.com/7c/fakefilter/main/txt/data.txt', json: false },
  { url: 'https://raw.githubusercontent.com/wesbos/burner-email-providers/master/emails.txt', json: false },
  { url: 'https://raw.githubusercontent.com/FGRibreau/mailchecker/master/list.txt', json: false },
  { url: 'https://raw.githubusercontent.com/ivolo/disposable-email-domains/master/index.json', json: true }
];

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

const DISPOSABLE_EMAIL_DOMAINS = new Set(CURATED_DOMAINS);

function addDomains(list) {
  let added = 0;
  for (const raw of list) {
    const d = String(raw || '').trim().toLowerCase();
    if (!d || d.startsWith('#') || !DOMAIN_RE.test(d) || NEVER_DISPOSABLE.has(d)) continue;
    if (!DISPOSABLE_EMAIL_DOMAINS.has(d)) {
      DISPOSABLE_EMAIL_DOMAINS.add(d);
      added++;
    }
  }
  return added;
}

try {
  addDomains(fs.readFileSync(LIST_FILE, 'utf8').split('\n'));
} catch (e) {
  console.error('[disposable] Failed to load', LIST_FILE, e.message);
}

function extractEmailDomain(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).trim().toLowerCase().replace(/\.$/, '');
}

/** Domain or any parent (foo.bar.mailinator.com → mailinator.com) is in the list. */
function isDisposableDomain(domain) {
  if (!domain) return false;
  domain = String(domain).toLowerCase().replace(/\.$/, '');
  if (NEVER_DISPOSABLE.has(domain)) return false;
  const labels = domain.split('.');
  for (let i = 0; i <= labels.length - 2; i++) {
    const candidate = labels.slice(i).join('.');
    if (NEVER_DISPOSABLE.has(candidate)) return false;
    if (DISPOSABLE_EMAIL_DOMAINS.has(candidate)) return true;
  }
  return false;
}

function isDisposableEmail(email) {
  return isDisposableDomain(extractEmailDomain(email));
}

const MX_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const mxCache = new Map();

async function resolveMxHosts(domain) {
  const cached = mxCache.get(domain);
  if (cached && cached.expires > Date.now()) return cached.hosts;
  let hosts = [];
  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
    ]);
    hosts = (records || []).map((r) => String(r.exchange || '').toLowerCase().replace(/\.$/, '')).filter(Boolean);
  } catch (_) {
    hosts = [];
  }
  mxCache.set(domain, { hosts, expires: Date.now() + MX_CACHE_TTL_MS });
  return hosts;
}

/**
 * Full check: list (incl. parents) + MX servers belonging to a known disposable provider.
 * @returns {Promise<{ disposable: boolean, reason: 'list'|'mx'|null, domain: string|null, mx: string|null }>}
 */
async function checkEmailDisposable(email) {
  const domain = extractEmailDomain(email);
  if (!domain) return { disposable: false, reason: null, domain: null, mx: null };
  if (NEVER_DISPOSABLE.has(domain)) return { disposable: false, reason: null, domain, mx: null };
  if (isDisposableDomain(domain)) return { disposable: true, reason: 'list', domain, mx: null };

  const hosts = await resolveMxHosts(domain);
  for (const host of hosts) {
    if (isDisposableDomain(host)) {
      return { disposable: true, reason: 'mx', domain, mx: host };
    }
  }
  return { disposable: false, reason: null, domain, mx: null };
}

async function refreshDisposableDomains() {
  const axios = require('axios');
  let total = 0;
  for (const src of REMOTE_SOURCES) {
    try {
      const resp = await axios.get(src.url, { timeout: 30000, responseType: 'text', transformResponse: (x) => x });
      const body = String(resp.data || '');
      const list = src.json ? JSON.parse(body) : body.split('\n');
      total += addDomains(Array.isArray(list) ? list : []);
    } catch (e) {
      console.error('[disposable] refresh failed for', src.url, e.message);
    }
  }
  if (total > 0) {
    console.log(`[disposable] +${total} domains from remote lists (total ${DISPOSABLE_EMAIL_DOMAINS.size})`);
  }
  return total;
}

module.exports = {
  DISPOSABLE_EMAIL_DOMAINS,
  NEVER_DISPOSABLE,
  extractEmailDomain,
  isDisposableDomain,
  isDisposableEmail,
  checkEmailDisposable,
  refreshDisposableDomains,
  DISPOSABLE_REGISTRATION_BLOCK_MSG:
    'Регистрация и смена почты на временные (одноразовые) адреса запрещены. ' +
    'Используйте обычную почту: Gmail, Яндекс, Mail.ru, Outlook, iCloud или корпоративный адрес вашей организации.'
};
