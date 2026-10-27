import { z } from 'zod';
import { config } from '../config.js';
import { normalizeEmail, type FoundEmail } from './emails.js';
import type { CompanySize } from './people-search.js';

/**
 * Hunter.io Domain Search — платный (есть бесплатные 25 запросов в месяц) источник личной почты:
 * один запрос на домен отдаёт адреса сотрудников с именами и должностями, шаблон почты домена
 * и размер компании. Без ключа HUNTER_API_KEY выключен.
 */

export class HunterError extends Error {
  constructor(message: string, public readonly fatal: boolean) {
    super(message);
  }
}

const HunterEmail = z.object({
  value: z.string(),
  type: z.string().nullish(),            // personal | generic
  confidence: z.number().nullish(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  position: z.string().nullish(),
  verification: z.object({ status: z.string().nullish() }).nullish(),
});

const HunterResponse = z.object({
  data: z.object({
    domain: z.string().nullish(),
    pattern: z.string().nullish(),        // «{first}.{last}»
    organization: z.string().nullish(),
    headcount: z.string().nullish(),      // «11-50»
    emails: z.array(HunterEmail).nullish(),
  }),
});

export interface HunterResult {
  emails: FoundEmail[];
  pattern: string | null;
  size: CompanySize | null;
}

const PATTERN_OK = /^(\{(first|last|f|l)\}[._-]?){1,2}$/;

/** Ответ Domain Search → адреса, шаблон и размер. Адреса с отметкой «invalid» отбрасываются. */
export function parseHunter(json: unknown): HunterResult {
  const parsed = HunterResponse.safeParse(json);
  if (!parsed.success) throw new HunterError('Hunter вернул ответ в неожиданном формате', true);
  const d = parsed.data.data;
  const emails: FoundEmail[] = [];
  for (const e of d.emails ?? []) {
    const email = normalizeEmail(e.value);
    if (!email || e.verification?.status === 'invalid' || (e.confidence ?? 100) < 50) continue;
    const name = [e.first_name, e.last_name].filter(Boolean).join(' ').trim();
    const personal = e.type !== 'generic' && !!name;
    emails.push({ email, source: 'hunter', person: personal ? name : null, title: personal ? e.position ?? null : null });
  }
  const range = d.headcount?.replace(/\s+/g, '') ?? null;
  const min = range ? Number(range.split(/[-+]/)[0]) : NaN;
  return {
    emails,
    pattern: d.pattern && PATTERN_OK.test(d.pattern) ? d.pattern : null,
    size: range && Number.isFinite(min) ? { range, min } : null,
  };
}

export async function hunterDomainSearch(domain: string, apiKey = config.hunter.apiKey): Promise<HunterResult> {
  const url = new URL('https://api.hunter.io/v2/domain-search');
  url.searchParams.set('domain', domain);
  url.searchParams.set('limit', '10');
  url.searchParams.set('api_key', apiKey);
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1_000 * attempt));
        continue;
      }
      throw new HunterError(`Hunter недоступен: ${(e as Error).message}`, false);
    }
    if (res.status === 401 || res.status === 403) {
      throw new HunterError(`Hunter отклонил ключ (HTTP ${res.status})`, true);
    }
    if (res.status === 429) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 3_000));
        continue;
      }
      // лимит запросов в секунду или исчерпан месячный план — дальше в этом прогоне не ищем
      throw new HunterError('Hunter: лимит запросов исчерпан (HTTP 429)', true);
    }
    if (res.status >= 500 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
      continue;
    }
    if (!res.ok) throw new HunterError(`Hunter HTTP ${res.status} для ${domain}`, false);
    return parseHunter(await res.json());
  }
}
