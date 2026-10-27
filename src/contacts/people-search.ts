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

/** Размер компании из карточки LinkedIn: «Company size: 51-200 employees». */
export interface CompanySize {
  range: string;   // «51-200», «10001+»
  min: number;     // нижняя граница — для фильтра «от 50 сотрудников»
}

export interface LinkedInFound {
  companyUrl: string | null;
  companyConfirmed: boolean;   // страница найдена по своему домену, а не только по названию
  companySize: CompanySize | null;
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

/** Версия правил отбора людей: при росте компании, где поиск что-то нашёл, перепроверяются. */
export const LINKEDIN_SEARCH_VERSION = 3;

/** Версия поиска страницы компании: v4 — с размером компании (запрос с «Company size»). */
export const LINKEDIN_COMPANY_VERSION = 4;

// «Company size: 51-200 employees» на языке страницы: Google показывает карточку на языке поддомена.
const NUM = '([\\d.,\\s]*\\d\\s*(?:[-–]\\s*[\\d.,\\s]*\\d)?\\s*\\+?)';
const SIZES = [
  new RegExp(`Company size\\s*[:：]?\\s*${NUM}\\s*employees`, 'i'),
  new RegExp(`회사 규모\\s*(?:직원)?\\s*${NUM}\\s*명`),
  new RegExp(`(?:公司规模|公司規模|企業規模|会社規模)\\s*[:：]?\\s*${NUM}\\s*(?:名|人)`),
  new RegExp(`Unternehmensgröße\\s*[:：]?\\s*${NUM}\\s*Beschäftigte`, 'i'),
  new RegExp(`Taille de l.entreprise\\s*[:：]?\\s*${NUM}\\s*employés`, 'i'),
  new RegExp(`Tamaño de la empresa\\s*[:：]?\\s*${NUM}\\s*empleados`, 'i'),
  new RegExp(`Tamanho da empresa\\s*[:：]?\\s*${NUM}\\s*funcionários`, 'i'),
  new RegExp(`Şirket büyüklüğü\\s*[:：]?\\s*${NUM}\\s*çalışan`, 'i'),
  new RegExp(`Размер компании\\s*[:：]?\\s*${NUM}\\s*сотрудник`, 'i'),
];

export function parseCompanySize(text: string): CompanySize | null {
  const m = SIZES.map((re) => text.match(re)).find(Boolean);
  if (!m) return null;
  const range = m[1].replace(/\s+/g, '').replace(/–/g, '-').replace(/[.,]/g, '');
  const min = Number(range.split(/[-+]/)[0]);
  return Number.isFinite(min) ? { range, min } : null;
}

/** Слаг страницы компании: «https://tr.linkedin.com/company/fusegamestr?trk=…» → «fusegamestr». */
export function companySlug(url: string | null | undefined): string | null {
  const m = (url ?? '').match(COMPANY_URL);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return m[1].toLowerCase();
  }
}

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

// Типовые слова в юрлицах: «Muza Technologies», «Fuse Entertainment» совпадают у разных фирм.
const GENERIC_WORDS = /\b(technolog(y|ies)|tech|entertainment|games?|studios?|software|digital|media|interactive|labs?|apps?|mobile|network|global|international|group|holdings?|solutions|systems|ventures|company|services|information|development)\b/gi;

/** Юрлицо отличительное, если без типовых слов остаётся ≥ 6 букв («Apextens», «Stormborn»). */
function distinctive(name: string): boolean {
  return norm(name.replace(GENERIC_WORDS, ' ')).length >= STRONG_LEN;
}

/** Надёжные названия: длинный бренд + отличительное юрлицо; без бренда — длинное юрлицо. */
function strongTerms(q: LinkedInQueries): string[] {
  const terms: string[] = [];
  if (isStrong(q.brand)) terms.push(q.brand);
  if (isStrong(q.name) && (terms.length === 0 || distinctive(q.name))) terms.push(q.name);
  return terms;
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
  return pickCompanyHit(hits, q)?.url ?? null;
}

/** confirmed — в карточке назван наш домен: это точно та компания, её размеру можно верить. */
export function pickCompanyHit(
  hits: SearchHit[],
  q: LinkedInQueries,
): { url: string; size: CompanySize | null; confirmed: boolean } | null {
  let best: { url: string; size: CompanySize | null; confirmed: boolean; score: number } | null = null;
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
    if (!best || score > best.score) {
      best = { url: `https://www.linkedin.com/company/${m[1]}/`, size: parseCompanySize(h.snippet), confirmed: domainHit, score };
    }
  }
  return best ? { url: best.url, size: best.size, confirmed: best.confirmed } : null;
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

// Бывшее место работы — не повод писать: «Former CEO, Mullvad VPN».
const FORMER = /\b(former|ex-|ex\s|previously|past|бывш)/i;

// Частный разработчик: однофамильцев много, берём только профиль про разработку приложений.
const DEV_PROFILE = /\b(developer|indie|gamedev|game developer|app developer|ios|android|apps?|unity|swift|flutter|programmer|software engineer|mobile engineer)\b|разработчик|개발자|开发/i;

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
      const domainHit = domainsIn(`${title ?? ''} ${h.snippet}`).some((d) => q.domains.includes(d));
      const devProfile = DEV_PROFILE.test(`${title ?? ''} ${currentEmployer(h.snippet) ?? ''}`);
      if (contains(name, q.name) && (domainHit || devProfile)) {
        seen.add(url);
        found.push({ name, title, url, rank: 0 });
      }
      continue;
    }
    if ([q.brand, q.name].some((t) => contains(name, t))) continue; // «LastShelter Base» — не человек
    if (title && /^\s*(former|ex[-\s])/i.test(title)) continue; // «Former Director of BD …» — уже не работает
    const employer = currentEmployer(h.snippet);
    const employerOurs = !!employer && isOurs(employer);
    // «Former CEO, Mullvad VPN» — в заголовке бывшая работа; верим только полю «Опыт»
    const headlineOurs = !!title && isOurs(title) && !FORMER.test(title);
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

export interface FindOptions {
  company?: boolean;               // искать страницу компании и её размер (1–2 запроса)
  people?: boolean;                // искать людей (1 запрос)
  knownCompanyUrl?: string | null; // ссылка с сайта разработчика: ищем только её размер
}

/** Запрос размера одной страницы: «site:linkedin.com/company/slug "Company size"» — Google показывает этот блок. */
export const sizeQuery = (slug: string) => `site:linkedin.com/company/${slug} "Company size"`;

/** Поиск страницы по своему домену: в карточке LinkedIn есть «Website: …» — такая страница точно та. */
export const domainQuery = (domains: string[]) =>
  `site:linkedin.com/company (${domains.slice(0, 3).map((d) => `"${d}"`).join(' OR ')}) "Company size"`;

/**
 * Компания и люди: до трёх запросов (для частного лица — один, его профиль). Страницу компании ищем
 * обычным запросом; если в описании карточки нет размера — второй запрос по самой странице с
 * «Company size». Если её карточка называет чужой сайт, страница отбрасывается (однофамилец).
 */
export async function findLinkedIn(
  developer: string,
  hints: BrandHints,
  search: (q: string) => Promise<SearchHit[]> = serperSearch,
  { company = true, people = true, knownCompanyUrl = null }: FindOptions = {},
): Promise<LinkedInFound> {
  const lq = linkedinQueries(developer, hints);
  let companyUrl: string | null = null;
  let companyConfirmed = false;
  let companySize: CompanySize | null = null;
  if (company && !lq.person) {
    // Размер записываем только для подтверждённой страницы: по одному названию находятся
    // однофамильцы (ром «Takamaka», студия VFX «Stormborn»), а их размер испортил бы фильтр «от 50».
    const known = companySlug(knownCompanyUrl);
    const sizeOf = async (slug: string) => {
      const own = (await search(sizeQuery(slug))).find((h) => companySlug(h.link) === slug);
      return own ? parseCompanySize(own.snippet) : null;
    };
    if (known) {
      // ссылку дал сам разработчик на сайте — нужен только размер
      companySize = await sizeOf(known);
    } else {
      // 1) по своему домену — страница подтверждена, обычно сразу с размером
      const byDomain = lq.domains.length ? pickCompanyHit(await search(domainQuery(lq.domains)), lq) : null;
      if (byDomain?.confirmed) {
        companyUrl = byDomain.url;
        companyConfirmed = true;
        companySize = byDomain.size ?? (await sizeOf(companySlug(byDomain.url)!));
      } else {
        // 2) по названию — только ссылка, без размера (бывают однофамильцы)
        companyUrl = pickCompanyHit(await search(lq.companyQuery), lq)?.url ?? null;
      }
    }
  }
  const found = people ? pickPeople(await search(lq.peopleQuery), lq) : [];
  return { companyUrl, companyConfirmed, companySize, people: found };
}
