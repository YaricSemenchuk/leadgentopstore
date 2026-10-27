import * as cheerio from 'cheerio';
import { baseDomain, isFreeMailDomain } from './emails.js';

/**
 * LinkedIn для лида. Сам LinkedIn не парсим (логин, антибот, ToS, персональные данные):
 *  - прямую ссылку берём со страниц самого разработчика, если он её туда поставил;
 *  - для каждого лида строим ссылки поиска — их открывает человек под своим логином.
 */

export type LinkedInKind = 'company' | 'person';

export interface LinkedInLink {
  url: string;
  kind: LinkedInKind;
}

const PROFILE = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(company|showcase|school|in)\/([^/?#\s"'<>]+)/i;
const PROFILE_IN_TEXT = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|showcase|school|in)\/[^/?#\s"'<>\\]+/gi;

function normalize(raw: string): LinkedInLink | null {
  const m = raw.trim().match(PROFILE);
  if (!m) return null;
  const type = m[1].toLowerCase();
  let slug = m[2];
  try {
    slug = decodeURIComponent(slug);
  } catch {
    /* оставляем как есть */
  }
  slug = slug.trim().replace(/\/+$/, '');
  if (!slug || slug.length > 100) return null;
  return {
    url: `https://www.linkedin.com/${type}/${encodeURIComponent(slug)}/`,
    kind: type === 'in' ? 'person' : 'company',
  };
}

/** Ссылки на LinkedIn со страницы: из <a href> и из встроенных данных. Компании — первыми. */
export function extractLinkedIn(html: string): LinkedInLink[] {
  if (!html || !/linkedin\.com/i.test(html)) return [];
  const $ = cheerio.load(html);
  const found = new Map<string, LinkedInLink>();
  const add = (raw: string) => {
    const l = normalize(raw);
    if (l) found.set(l.url, l);
  };
  $('a[href*="linkedin.com"]').each((_, el) => add($(el).attr('href') ?? ''));
  $('script').each((_, el) => {
    for (const m of ($(el).html() ?? '').replace(/\\\//g, '/').matchAll(PROFILE_IN_TEXT)) add(m[0]);
  });
  return [...found.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'company' ? -1 : 1));
}

// Юридические формы и служебные слова — мешают поиску компании по названию.
const LEGAL = [
  'pte', 'ltd', 'limited', 'llc', 'l.l.c', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'gmbh', 'ug', 'haftungsbeschrankt', 'ag', 's.r.o', 'sro', 'sp', 'z', 'o.o', 'a.s', 'as', 'anonim', 'sirketi',
  'limited sirketi', 'ltda', 'sas', 'sarl', 'srl', 'bv', 'b.v', 'oy', 'ab', 'kft', 'sa', 's.a', 'fz', 'fz-llc',
  'fze', 'llc-fz', 'l.l.c-fz', 'ou', 'oü', 'kk', 'k.k', 'jsc', 'plc', 'pty', 'tbk', 'pt', 'cv',
  'yazilim', 'bilisim', 'teknoloji', 'teknolojileri', 'teknolojiler', 'oyun', 'oyunlari', 'hk', 've', 'pazarlama', 'ticaret', 'hizmetleri', 'mobil',
];
const LEGAL_SET = new Set(LEGAL);

/** «Combo Yazilim Anonim Sirketi» → «Combo», «HURELAX PTE. LTD.» → «HURELAX». */
export function companyName(developer: string): string {
  const words = developer
    // польская «Sp. z o.o.» в любом написании, в том числе «SP Z O O»
    .replace(/\bsp\.?\s*z\s*o\.?\s*o\.?\s*$/i, ' ')
    .replace(/[(),®™]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // срезаем юридический хвост и служебные слова с конца, но не всё название целиком
  while (words.length > 1 && LEGAL_SET.has(words[words.length - 1].toLowerCase().replace(/[.,]+$/, ''))) words.pop();
  // «PT Sandi Daya Guna» — индонезийская форма в начале
  if (words.length > 1 && /^(pt|cv)\.?$/i.test(words[0])) words.shift();
  return words.join(' ').replace(/[.,]+$/, '').trim() || developer.trim();
}

const COMPANY_HINT = /\b(ltd|limited|llc|inc|corp|gmbh|pte|co\.|company|studio|studios|games?|labs?|technolog|tech|software|media|digital|apps?|interactive|entertainment|network|group|sirketi|ltda|s\.r\.o|sp\. z o\.o|ug|oy|ab|srl|sas|kft|pty|plc|fz|ou)\b/i;

// Частицы в именах: «Anderson Mateus de Lima», «Jan van der Berg», «Ahmad bin Ali».
const NAME_PARTICLE = /^(de|da|do|dos|das|del|della|di|van|von|der|den|ter|la|le|du|bin|binti|ibn|al|el|y|e)$/i;

/** Похоже на имя частного лица: 2–3 слова без признаков компании («Luong Vuong»), с частицами — до 5. */
export function looksLikePerson(developer: string): boolean {
  const d = developer.trim();
  if (COMPANY_HINT.test(d) || /\d/.test(d)) return false;
  const words = d.split(/\s+/);
  const particles = words.filter((w) => NAME_PARTICLE.test(w)).length;
  return words.length >= 2 && words.length - particles <= 3 && words.length <= 5;
}

// Хостинги и платформы: их домен — не бренд разработчика.
const GENERIC_HOSTS = new Set([
  'github', 'gitlab', 'notion', 'wixsite', 'wix', 'blogspot', 'wordpress', 'weebly', 'carrd', 'webflow',
  'google', 'apple', 'facebook', 'instagram', 'twitter', 'x', 'tiktok', 'youtube', 'linktr', 'linkedin',
  'itch', 'discord', 'telegram', 't', 'medium', 'substack', 'tumblr', 'helpshift', 'zendesk', 'freshdesk',
  'zohodesk', 'termly', 'iubenda', 'freeprivacypolicy', 'privacypolicies', 'app-privacy-policy', 'firebaseapp',
  'web', 'vercel', 'netlify', 'herokuapp', 'pages', 'sites', 'feishu', 'larksuite', 'qq', 'weixin', 'naver',
]);

/** Бренд по домену сайта: «https://www.lastshelter.net» → «lastshelter», «muza-technologies.com» → «muza technologies». */
export function brandFromWebsite(website: string | null | undefined): string | null {
  if (!website) return null;
  let host: string;
  try {
    host = new URL(website).hostname.toLowerCase();
  } catch {
    return null;
  }
  const parts = host.replace(/^www\./, '').split('.');
  // второй уровень: foo.co.kr → foo, foo.com → foo
  const label = parts.length >= 3 && parts[parts.length - 2].length <= 3 && parts[parts.length - 1].length === 2
    ? parts[parts.length - 3]
    : parts[parts.length - 2];
  if (!label || label.length < 3 || GENERIC_HOSTS.has(label)) return null;
  const tld = parts[parts.length - 1];
  // доменная зона-слово — часть названия: gryphon.games → «gryphon games», sunquest.app → «sunquest app»
  const words = label.replace(/[-_]+/g, ' ') + (WORD_TLDS.has(tld) ? ` ${tld}` : '');
  // юридическая форма в домене — не бренд: bravo-inc.store → «bravo»
  return companyName(words);
}

const WORD_TLDS = new Set(['games', 'game', 'studio', 'studios', 'app', 'apps', 'software', 'digital', 'media', 'tech', 'ventures', 'agency']);

export interface LinkedInSearch {
  company: string;   // компания: поиск в LinkedIn по бренду / названию
  people: string;    // люди: Google по профилям LinkedIn с ролями (CEO, founder, marketing, UA)
  google: string;    // компания через Google: site:linkedin.com/company
}

const ROLES = '(CEO OR founder OR "co-founder" OR marketing OR growth OR "user acquisition" OR publishing)';

/**
 * Ссылки поиска. Ищем по бренду (домен сайта), а не по юрлицу: страница в LinkedIn обычно
 * называется как продукт или студия, а не «XYZ Technology Pte. Ltd.». Точная фраза в кавычках
 * отсекает однофамильцев. Людей ищем через Google по site:linkedin.com/in — внутренний поиск
 * LinkedIn с ролями часто пуст.
 */
export interface BrandHints {
  website?: string | null;
  email?: string | null;
  supportUrl?: string | null;
  privacyUrl?: string | null;
}

/** Бренд по первому подходящему домену: сайт → почта (не gmail и т.п.) → поддержка → политика. */
export function brandFrom(h: BrandHints): string | null {
  const emailDomain = h.email?.split('@')[1];
  const fromEmail = emailDomain && !isFreeMailDomain(emailDomain) ? `https://${emailDomain}` : null;
  for (const url of [h.website, fromEmail, h.supportUrl, h.privacyUrl]) {
    const b = brandFromWebsite(url);
    if (b) return b;
  }
  return null;
}

/** Регистрируемые домены разработчика: сайт, почта (не бесплатная), поддержка, политика. */
export function knownDomains(h: BrandHints): string[] {
  const out = new Set<string>();
  const add = (u: string | null | undefined) => {
    if (!u) return;
    try {
      const host = new URL(u).hostname;
      const label = host.replace(/^www\./, '').split('.')[0];
      // «playchamp.zohodesk.com» — поддомен платформы: домен zohodesk.com не разработчика
      const baseLabel = baseDomain(host).split('.')[0];
      if (!GENERIC_HOSTS.has(label) && !GENERIC_HOSTS.has(baseLabel)) out.add(baseDomain(host));
    } catch {
      /* битый URL */
    }
  };
  add(h.website);
  const emailDomain = h.email?.split('@')[1];
  if (emailDomain && !isFreeMailDomain(emailDomain)) add(`https://${emailDomain}`);
  add(h.supportUrl);
  add(h.privacyUrl);
  return [...out];
}

export interface LinkedInQueries {
  person: boolean;         // разработчик — частное лицо
  brand: string | null;    // бренд из домена — главный признак «та самая компания»
  name: string;            // юрлицо без юридического хвоста — часто совпадает у разных фирм
  domains: string[];       // известные домены разработчика (сайт, почта, поддержка) для сверки с карточкой
  terms: string[];         // бренд и/или название — по ним проверяем, что результат про нужную компанию
  companyKeywords: string; // для поиска компаний внутри LinkedIn
  companyQuery: string;    // Google: site:linkedin.com/company …
  peopleQuery: string;     // Google: site:linkedin.com/in … с ролями
}

/** Поисковые запросы для лида — общие для ссылок в таблице и для автопоиска через API. */
export function linkedinQueries(developer: string, hints: BrandHints | string | null = null): LinkedInQueries {
  const name = companyName(developer);
  const brand = brandFrom(typeof hints === 'string' || hints === null ? { website: hints } : hints);
  const person = looksLikePerson(developer);
  const quoted = (s: string) => `"${s}"`;
  // оба варианта, если бренд отличается от юрлица
  const terms = [...new Set([brand, name].filter((v): v is string => !!v).map((v) => v.trim()))];
  const either = terms.length > 1 ? `(${terms.map(quoted).join(' OR ')})` : quoted(terms[0]);
  const domains = knownDomains(typeof hints === 'string' || hints === null ? { website: hints } : hints);
  if (person) {
    return {
      person,
      brand,
      name,
      domains,
      terms,
      companyKeywords: brand ?? name,
      companyQuery: `site:linkedin.com ${either}`,
      peopleQuery: `site:linkedin.com/in ${quoted(name)}`,
    };
  }
  return {
    person,
    brand,
    name,
    domains,
    terms,
    companyKeywords: quoted(brand ?? name),
    companyQuery: `site:linkedin.com/company ${either}`,
    peopleQuery: `site:linkedin.com/in ${either} ${ROLES}`,
  };
}

export function linkedinSearchLinks(developer: string, hints: BrandHints | string | null = null): LinkedInSearch {
  const lq = linkedinQueries(developer, hints);
  const q = (s: string) => encodeURIComponent(s);
  return {
    company: `https://www.linkedin.com/search/results/companies/?keywords=${q(lq.companyKeywords)}`,
    people: `https://www.google.com/search?q=${q(lq.peopleQuery)}`,
    google: `https://www.google.com/search?q=${q(lq.companyQuery)}`,
  };
}
