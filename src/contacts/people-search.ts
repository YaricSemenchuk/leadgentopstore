import { z } from 'zod';
import { config } from '../config.js';
import { baseDomain } from './emails.js';
import { linkedinQueries, type BrandHints, type LinkedInQueries } from './linkedin.js';

/**
 * Автопоиск LinkedIn через поисковый API (Serper — выдача Google). Сам LinkedIn не открываем:
 * берём из выдачи ссылку на страницу компании и до трёх профилей людей с ролями
 * (CEO, founder, marketing, growth, UA). Имя и должность — из заголовка результата.
 */

export interface SearchHit {
  title: string;
  link: string;
  snippet: string;
}

export interface LinkedInPerson {
  name: string;
  title: string | null;
  url: string;
}

export interface LinkedInFound {
  companyUrl: string | null;
  people: LinkedInPerson[];
}

export class SearchApiError extends Error {
  constructor(message: string, public readonly fatal: boolean) {
    super(message);
  }
}

const SerperResponse = z.object({
  organic: z
    .array(z.object({ title: z.string(), link: z.string(), snippet: z.string().optional().default('') }))
    .optional()
    .default([]),
});

const SERPER_URL = 'https://google.serper.dev/search';

/** Один запрос к Serper. 401/403 — ключ неверный или кредиты кончились: дальше искать бессмысленно. */
export async function serperSearch(q: string, apiKey = config.search.apiKey): Promise<SearchHit[]> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(SERPER_URL, {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, num: 10 }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1_000 * attempt));
        continue;
      }
      throw new SearchApiError(`Serper недоступен: ${(e as Error).message}`, false);
    }
    if (res.status === 401 || res.status === 403) {
      throw new SearchApiError(`Serper отклонил ключ (HTTP ${res.status}): неверный ключ или закончились кредиты`, true);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
      continue;
    }
    if (!res.ok) throw new SearchApiError(`Serper HTTP ${res.status}`, false);
    const parsed = SerperResponse.safeParse(await res.json());
    if (!parsed.success) throw new SearchApiError('Serper вернул ответ в неожиданном формате', true);
    return parsed.data.organic;
  }
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');

function contains(text: string, term: string | null): boolean {
  if (!term) return false;
  const n = norm(term);
  return n.length >= 3 && norm(text).includes(n);
}

/** Короткие бренды («berk», «ceno», «lava», «combo») есть у десятков чужих фирм — сами не доказательство. */
const STRONG_LEN = 6;
const isStrong = (t: string | null): t is string => !!t && norm(t).length >= STRONG_LEN;

/** Надёжные названия для сверки: длинный бренд; если бренда нет или он короткий — длинное юрлицо. */
function strongTerms(q: LinkedInQueries): string[] {
  if (isStrong(q.brand)) return [q.brand];
  return isStrong(q.name) ? [q.name] : [];
}

/**
 * Компания стоит там, где пишут работодателя: в начале названия, после «at», «@», «,», «·», «–», «:».
 * «Founder at LAVA LABS», «Fuse Games TR» — да; «CEO Double Combo Games» для «Combo Games» — нет.
 */
const CONNECTOR = /\s(?:at|chez|bei|en|для|в)\s|@|,|\||·|\s[-–—]\s|:/gi;

export function namesCompany(text: string, terms: string[]): boolean {
  if (!text || terms.length === 0) return false;
  const starts = [0];
  for (const m of text.matchAll(CONNECTOR)) starts.push((m.index ?? 0) + m[0].length);
  return starts.some((i) => {
    const head = norm(text.slice(i, i + 80));
    return terms.some((t) => head.startsWith(norm(t)));
  });
}

const DOMAIN_IN_TEXT = /\b(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,6})\b/gi;

/** Домены, упомянутые в карточке («Website: www.fusegames.com»), кроме самого LinkedIn. */
function domainsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(DOMAIN_IN_TEXT)) {
    const d = baseDomain(m[1]);
    if (!/linkedin\.com$/.test(d) && /\.[a-z]{2,6}$/.test(d)) out.add(d);
  }
  return [...out];
}

const COMPANY_URL = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([^/?#]+)/i;
const PROFILE_URL = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#]+)/i;

/**
 * Страница компании. Юрлица у разных фирм совпадают («Fuse Entertainment», «Muza Technologies»),
 * поэтому нужен бренд из домена в названии/адресе страницы или наш домен в карточке; карточка
 * с чужим сайтом отбрасывается. По одному юрлицу — только если бренда нет вовсе.
 */
export function pickCompany(hits: SearchHit[], q: LinkedInQueries): string | null {
  let best: { url: string; score: number } | null = null;
  for (const h of hits) {
    const m = h.link.match(COMPANY_URL);
    if (!m) continue;
    const mentioned = domainsIn(`${h.title} ${h.snippet}`);
    const domainHit = q.domains.length > 0 && mentioned.some((d) => q.domains.includes(d));
    if (q.domains.length > 0 && mentioned.length > 0 && !domainHit) continue; // у карточки чужой сайт
    const pageName = h.title.replace(/\s*\|\s*LinkedIn\s*$/i, '');
    const slug = decodeURIComponent(m[1]).replace(/[-_]+/g, ' ');
    // название страницы или адрес начинаются с надёжного названия; короткое — только с доменом
    const nameHit = namesCompany(pageName, strongTerms(q)) || namesCompany(slug, strongTerms(q));
    if (!domainHit && !nameHit) continue;
    const score = (domainHit ? 2 : 0) + (nameHit ? 1 : 0);
    if (!best || score > best.score) best = { url: `https://www.linkedin.com/company/${m[1]}/`, score };
  }
  return best?.url ?? null;
}

/** Serper отдаёт «Имя - Заголовок профиля»; в старом формате бывает хвост «| LinkedIn». */
export function parseProfileTitle(title: string): { name: string; title: string | null } {
  const clean = title.replace(/\s*[|–-]\s*LinkedIn\s*$/i, '').trim();
  const parts = clean.split(/\s+[-–—|]\s+/).map((p) => p.trim()).filter(Boolean);
  const name = parts[0] ?? clean;
  const role = parts.slice(1).join(' · ') || null;
  return { name: name.slice(0, 80), title: role ? role.slice(0, 120) : null };
}

// Поле «текущее место работы» в описании профиля на разных языках.
const EXPERIENCE = /^(experience|deneyim|опыт|досвід|erfahrung|expérience|experiencia|esperienza|experiência|pengalaman|kinh nghiệm|経験|경력|经历|工作经历|經歷)\s*[:：]\s*(.+)$/i;

function snippetParts(snippet: string): string[] {
  return snippet.split(/\s+·\s+|\s+\|\s+/).map((p) => p.trim()).filter(Boolean);
}

/** Текущий работодатель из «Experience: X» в описании профиля. */
export function currentEmployer(snippet: string): string | null {
  for (const part of snippetParts(snippet)) {
    const m = part.match(EXPERIENCE);
    if (m) return m[2].trim();
  }
  return null;
}

const NOT_DECISION = /\b(recruit\w*|talent|human resources?|hr|intern|internship|student|trainee|assistant|customer support|support specialist|tester)\b/i;
const ROLE_RANKS: Array<[RegExp, number]> = [
  [/\b(ceo|founder|co-?founder|owner|president|chief|cmo|coo|cto|cpo|managing director|general manager)\b|创始人|首席执行官|总经理|대표|창업자/i, 0],
  [/\b(marketing|growth|user acquisition|ua|performance|publishing|business development|bd|partnerships?|monetization|advertising)\b|市场|营销|发行|마케팅|퍼블리싱/i, 1],
  [/\b(director|head of|vp|vice president|lead|producer|manager)\b/i, 2],
];

/** Ранг роли: 0 — владелец/руководитель, 1 — маркетинг/UA/издательство, 2 — прочие руководители; null — не тот человек. */
export function roleRank(headline: string | null, snippet: string): number | null {
  if (headline && NOT_DECISION.test(headline)) return null;
  for (const text of [headline ?? '', snippet.slice(0, 200)]) {
    for (const [re, rank] of ROLE_RANKS) if (re.test(text)) return rank;
  }
  return null;
}

/**
 * Люди. Компания должна быть текущим местом работы: в заголовке профиля или в поле «Опыт»
 * описания, а не где-то в тексте (там бывают прошлые места и чужие упоминания). Сверяем по
 * надёжному названию (длинный бренд или юрлицо) или по нашему домену. Роль — из заголовка,
 * иначе из той же части описания. Профили, где «имя» — это бренд, отбрасываем. Для
 * разработчика-частного лица ищем его самого.
 */
export function pickPeople(hits: SearchHit[], q: LinkedInQueries, max = 3): LinkedInPerson[] {
  const terms = strongTerms(q);
  const isOurs = (text: string) => namesCompany(text, terms) || domainsIn(text).some((d) => q.domains.includes(d));
  const found: Array<LinkedInPerson & { rank: number }> = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const m = h.link.match(PROFILE_URL);
    if (!m) continue;
    const url = `https://www.linkedin.com/in/${m[1]}/`;
    if (seen.has(url)) continue;
    const { name, title } = parseProfileTitle(h.title);

    if (q.person) {
      if (contains(name, q.name)) {
        seen.add(url);
        found.push({ name, title, url, rank: 0 });
      }
      continue;
    }
    if ([q.brand, q.name].some((t) => contains(name, t))) continue; // «LastShelter Base» — не человек
    const employer = currentEmployer(h.snippet);
    const headlineOurs = !!title && isOurs(title);
    const employerOurs = !!employer && isOurs(employer);
    if (!headlineOurs && !employerOurs) continue;
    const ourPart = snippetParts(h.snippet).find((p) => isOurs(p)) ?? '';
    const rank = roleRank(title, ourPart);
    if (rank === null) continue;
    seen.add(url);
    found.push({ name, title, url, rank });
  }
  return found
    .sort((a, b) => a.rank - b.rank)
    .slice(0, max)
    .map(({ rank: _rank, ...p }) => p);
}

/** Компания и люди для лида: два запроса (для частного лица — один, его профиль). */
export async function findLinkedIn(
  developer: string,
  hints: BrandHints,
  search: (q: string) => Promise<SearchHit[]> = serperSearch,
): Promise<LinkedInFound> {
  const lq = linkedinQueries(developer, hints);
  const companyUrl = lq.person ? null : pickCompany(await search(lq.companyQuery), lq);
  const people = pickPeople(await search(lq.peopleQuery), lq);
  return { companyUrl, people };
}
