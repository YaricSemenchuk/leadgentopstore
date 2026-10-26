import { z } from 'zod';
import { config } from '../config.js';
import { linkedinQueries, type BrandHints } from './linkedin.js';

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

/** Результат про нужную компанию: бренд или название встречается в заголовке, описании или адресе. */
export function mentions(hit: SearchHit, terms: string[]): boolean {
  const hay = norm(`${hit.title} ${hit.snippet} ${hit.link}`);
  return terms.some((t) => {
    const n = norm(t);
    return n.length >= 3 && hay.includes(n);
  });
}

const COMPANY_URL = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([^/?#]+)/i;
const PROFILE_URL = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#]+)/i;

export function pickCompany(hits: SearchHit[], terms: string[]): string | null {
  for (const h of hits) {
    const m = h.link.match(COMPANY_URL);
    if (m && mentions(h, terms)) return `https://www.linkedin.com/company/${m[1]}/`;
  }
  return null;
}

/** «Ivan Petrov - Head of Marketing - Game Spark | LinkedIn» → имя и должность. */
export function parseProfileTitle(title: string): { name: string; title: string | null } {
  const clean = title.replace(/\s*[|–-]\s*LinkedIn\s*$/i, '').trim();
  const parts = clean.split(/\s+[-–—|]\s+/).map((p) => p.trim()).filter(Boolean);
  const name = parts[0] ?? clean;
  const role = parts.slice(1).join(' · ') || null;
  return { name: name.slice(0, 80), title: role ? role.slice(0, 120) : null };
}

export function pickPeople(hits: SearchHit[], terms: string[], max = 3): LinkedInPerson[] {
  const out: LinkedInPerson[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const m = h.link.match(PROFILE_URL);
    if (!m || !mentions(h, terms)) continue;
    const url = `https://www.linkedin.com/in/${m[1]}/`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ ...parseProfileTitle(h.title), url });
    if (out.length >= max) break;
  }
  return out;
}

/** Компания и люди для лида: два запроса (для частного лица — один, его профиль). */
export async function findLinkedIn(
  developer: string,
  hints: BrandHints,
  search: (q: string) => Promise<SearchHit[]> = serperSearch,
): Promise<LinkedInFound> {
  const lq = linkedinQueries(developer, hints);
  const companyUrl = lq.person ? null : pickCompany(await search(lq.companyQuery), lq.terms);
  const people = pickPeople(await search(lq.peopleQuery), lq.terms);
  return { companyUrl, people };
}
