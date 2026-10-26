import * as cheerio from 'cheerio';

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

/** Похоже на имя частного лица: 2–3 слова без признаков компании («Luong Vuong», «Antoine Munch»). */
export function looksLikePerson(developer: string): boolean {
  const d = developer.trim();
  if (COMPANY_HINT.test(d) || /\d/.test(d)) return false;
  const words = d.split(/\s+/);
  return words.length >= 2 && words.length <= 3;
}

export interface LinkedInSearch {
  company: string;   // поиск компании в LinkedIn
  people: string;    // поиск людей: основатель / CEO / маркетинг (или сам разработчик-частное лицо)
  google: string;    // запасной путь: Google по site:linkedin.com
}

export function linkedinSearchLinks(developer: string): LinkedInSearch {
  const name = companyName(developer);
  const person = looksLikePerson(developer);
  const q = (s: string) => encodeURIComponent(s);
  return {
    company: `https://www.linkedin.com/search/results/companies/?keywords=${q(name)}`,
    people: person
      ? `https://www.linkedin.com/search/results/people/?keywords=${q(name)}`
      : `https://www.linkedin.com/search/results/people/?keywords=${q(`${name} (founder OR CEO OR marketing OR growth OR "user acquisition")`)}`,
    google: `https://www.google.com/search?q=${q(`site:linkedin.com/${person ? 'in' : 'company'} "${name}"`)}`,
  };
}
