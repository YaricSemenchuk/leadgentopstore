import * as cheerio from 'cheerio';

export type EmailSource = 'google_play' | 'support_page' | 'privacy_policy' | 'website';

export interface FoundEmail {
  email: string;
  source: EmailSource;
}

export interface RankedEmails {
  best: FoundEmail | null;
  others: string[];          // до трёх запасных адресов
  personal: boolean;         // лучший адрес — бесплатный ящик (gmail и т.п.), скорее всего частное лицо
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;
const EMAIL_EXACT = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/;

const JUNK_LOCAL = /(^|[._-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?)([._-]|$)/;
const JUNK_DOMAIN =
  /(^|\.)(example\.(com|org|net)|domain\.com|email\.com|yourdomain\.com|sentry\.io|wixpress\.com|sentry-next\.wixpress\.com)$|\.gov(\.[a-z]{2})?$/;
const ASSET = /\.(png|jpe?g|gif|webp|svg|css|js)$/;

const FREE_MAIL =
  /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|gmx|mail|yandex|ya|proton|protonmail|qq|163|126|naver|hanmail|daum)\.[a-z.]+$/;

/** Бесплатный почтовый домен (gmail, outlook, qq…): по нему не понять, чья это компания. */
export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL.test(domain.toLowerCase());
}

// Чем ближе адрес к тому, кто решает о закупке трафика, тем выше.
const ROLES: Array<[RegExp, number]> = [
  [/(^|[._-])(partners?|partnerships?|bd|biz|business|marketing|ads|advertising|ua|growth|media|pr|press|publishing|hello|hi)([._-]|$)/, 3],
  [/(^|[._-])(contact|info|team|office|general|enquiries|inquiries|mail)([._-]|$)/, 2],
  [/(^|[._-])(support|help|service|feedback|cs|care|customer)([._-]|$)/, 1],
  // юридические ящики — последний вариант: обычный адрес на домене разработчика лучше
  [/(^|[._-])(privacy|dpo|legal|gdpr|compliance|abuse|security|dmca|copyright|data)([._-]|$)/, -1],
];

function roleScore(local: string): number | null {
  for (const [re, score] of ROLES) if (re.test(local)) return score;
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'ac', 'edu', 'ne', 'or', 'go', 'gov']);

/** Регистрируемый домен без поддоменов: help.plaud.ai → plaud.ai, foo.co.kr → foo.co.kr. */
export function baseDomain(hostOrUrl: string): string {
  let host = hostOrUrl;
  try {
    host = new URL(hostOrUrl).hostname;
  } catch {
    /* уже хост */
  }
  const parts = host.toLowerCase().replace(/^www\./, '').split('.');
  const tld = parts[parts.length - 1];
  if (parts.length > 2 && tld.length === 2 && SECOND_LEVEL.has(parts[parts.length - 2])) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

function normalize(raw: string): string | null {
  const e = raw.trim().toLowerCase().replace(/^mailto:/, '').replace(/[.,;:]+$/, '');
  if (!EMAIL_EXACT.test(e) || ASSET.test(e) || e.includes('..')) return null;
  const [local, domain] = e.split('@');
  if (JUNK_LOCAL.test(local) || JUNK_DOMAIN.test(domain)) return null;
  return e;
}

/** @, > и т.п. из JSON внутри страницы → обычные символы. */
function unescapeJson(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Адреса со страницы: ссылки mailto:, данные во встроенных скриптах (сайты на Next.js и
 * т.п. держат контент только там) и видимый текст. Текст собираем по узлам через пробел,
 * иначе соседние элементы склеиваются: «x@a.net» + «Address» → «x@a.netaddress».
 */
export function extractEmails(html: string): string[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  const out = new Set<string>();
  const add = (raw: string) => {
    const e = normalize(raw);
    if (e) out.add(e);
  };

  $('a[href^="mailto:"], a[href^="MAILTO:"]').each((_, el) => {
    const href = safeDecode($(el).attr('href') ?? '').replace(/^mailto:/i, '');
    for (const part of href.split('?')[0].split(',')) add(part);
  });

  $('script').each((_, el) => {
    const code = $(el).html() ?? '';
    if (!code.includes('@') && !code.includes('\\u0040')) return;
    for (const m of unescapeJson(code).matchAll(EMAIL)) add(m[0]);
  });

  $('script, style, noscript, template').remove();
  const texts: string[] = [];
  $('body').find('*').addBack().contents().each((_, node) => {
    if (node.type === 'text') texts.push(node.data);
  });
  for (const m of texts.join(' ').matchAll(EMAIL)) add(m[0]);

  return [...out];
}

/** Первый mailto: на странице Google Play — это контакт разработчика из блока «App support». */
export function firstMailto(html: string): string | null {
  const $ = cheerio.load(html);
  const href = $('a[href^="mailto:"]').first().attr('href');
  return href ? normalize(safeDecode(href).split('?')[0]) : null;
}

/**
 * Выбирает лучший адрес. Почта из Google Play — её указал сам разработчик — всегда в приоритете.
 * Адреса со сторонних страниц берём, только если они на домене разработчика или ролевые
 * (support@, contact@ …) — так отсекаются юрфирмы, GDPR-представители и регуляторы из политик.
 */
export function rankEmails(found: FoundEmail[], developerDomains: string[]): RankedEmails {
  const domains = new Set(developerDomains.filter(Boolean).map(baseDomain));
  const scored = new Map<string, { f: FoundEmail; score: number }>();

  for (const f of found) {
    const [local, domain] = f.email.split('@');
    const free = FREE_MAIL.test(domain);
    const sameDomain = domains.has(baseDomain(domain));
    const role = roleScore(local);
    if (f.source !== 'google_play') {
      if (!sameDomain && (role === null || role <= 0)) continue;
      if (free && role === null) continue;
    }
    const score =
      (f.source === 'google_play' ? 6 : 0) + (sameDomain ? 3 : 0) + (role ?? 0) - (free ? 1 : 0);
    const prev = scored.get(f.email);
    if (!prev || prev.score < score) scored.set(f.email, { f, score });
  }

  const ranked = [...scored.values()].sort((a, b) => b.score - a.score);
  const best = ranked[0]?.f ?? null;
  return {
    best,
    others: ranked.slice(1, 4).map((r) => r.f.email),
    personal: best ? FREE_MAIL.test(best.email.split('@')[1]) : false,
  };
}
