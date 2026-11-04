import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { baseDomain, normalizeEmail } from './emails.js';
import type { CompanySize } from './people-search.js';

/**
 * Treg (treg.to) — шлюз к платным API по одному токену: `POST https://treg.to/call/<id>` с заголовком
 * X-Treg-Token, ключ провайдера Treg подставляет у себя. Используем «маршрутизируемые» инструменты:
 * treg.people.email.find (почта по имени и домену), treg.people.email.verify (проверка адреса),
 * treg.companies.enrich (размер компании по домену) — Treg сам берёт самого дешёвого провайдера и
 * идёт к следующему при промахе; плюс Hunter Domain Search и Serper без своих ключей.
 *
 * Деньги: цена вызова — заголовок X-Treg-Cost-Micro (микродоллары). X-Treg-Route-Max-Cost ограничивает
 * один вызов, а не прогон, поэтому у прогона свой потолок (TREG_MAX_USD_PER_RUN): перед вызовом
 * резервируем его максимум, после — списываем фактическую цену.
 */


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TregError extends Error {
  constructor(message: string, public readonly fatal: boolean, public readonly code: string | null = null) {
    super(message);
  }
}

/** Потолок расходов за прогон: резерв максимума вызова до запроса, фактическая цена — после. */
export class TregBudget {
  spentUsd = 0;
  private reservedUsd = 0;
  calls = 0;

  constructor(public readonly limitUsd: number) {}

  reserve(maxUsd: number): boolean {
    if (this.spentUsd + this.reservedUsd + maxUsd > this.limitUsd + 1e-9) return false;
    this.reservedUsd += maxUsd;
    return true;
  }

  /**
   * Резерв с ожиданием: если не хватает только из-за резерва параллельных вызовов — ждём, пока они
   * спишут факт (обычно меньше максимума). false — потолок исчерпан уже потраченным.
   */
  async acquire(maxUsd: number): Promise<boolean> {
    for (;;) {
      if (this.spentUsd + maxUsd > this.limitUsd + 1e-9) return false;
      if (this.reserve(maxUsd)) return true;
      await sleep(100);
    }
  }

  settle(maxUsd: number, actualUsd: number): void {
    this.reservedUsd = Math.max(0, this.reservedUsd - maxUsd);
    this.spentUsd += actualUsd;
    this.calls++;
  }
}

// Один прогон за раз (runner не даёт запустить второй) — бюджет общий для всех шагов прогона, включая Serper.
let budget = new TregBudget(config.treg.maxUsdPerRun);

/** Новый бюджет на прогон. */
export function startTregBudget(limitUsd = config.treg.maxUsdPerRun): TregBudget {
  budget = new TregBudget(limitUsd);
  return budget;
}

export function tregBudget(): TregBudget {
  return budget;
}

export interface TregCall {
  method?: 'GET' | 'POST';
  body?: unknown;
  query?: Record<string, string | number | boolean>;
  /** X-Treg-Route-Max-Cost: дороже — Treg откажет, ничего не списав */
  maxCostUsd: number;
  /** дополнительные заголовки X-Treg-Route-* */
  headers?: Record<string, string>;
}

export interface TregResponse {
  status: number;
  body: any;
  costUsd: number;
  servedBy: string | null;
  callId: string | null;
}

/** Код ошибки Treg из тела: {"detail": "...", "error": "insufficient_balance"} или вложенный в detail. */
export function tregErrorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, any>;
  const d = b.detail && typeof b.detail === 'object' ? b.detail : null;
  const code = b.error ?? b.code ?? d?.error ?? d?.code ?? null;
  if (typeof code === 'string') return code;
  const text = JSON.stringify(body);
  const known = ['insufficient_balance', 'route_max_cost', 'route_failed', 'share_busy', 'provider_rate_limited',
    'trial_allowance_reached', 'provider_capacity_unavailable', 'capability_pinned'];
  return known.find((k) => text.includes(k)) ?? null;
}

function errorText(body: unknown): string {
  if (!body || typeof body !== 'object') return String(body ?? '').slice(0, 200);
  const b = body as Record<string, any>;
  const d = typeof b.detail === 'string' ? b.detail : b.detail?.message ?? b.message ?? b.detail?.error;
  return String(d ?? JSON.stringify(body)).slice(0, 200);
}

/**
 * Один вызов инструмента Treg. Сетевой сбой повторяется с тем же Idempotency-Key: если провайдер
 * успел ответить и списать деньги, Treg вернёт сохранённый ответ бесплатно. Ответ провайдера с
 * ошибкой Treg не тарифицирует. Фатально (дальше в прогоне не вызываем): токен отклонён, кончился
 * баланс Treg, исчерпан бюджет прогона.
 */
export async function tregCall(tool: string, c: TregCall, token = config.treg.token, fetchImpl: typeof fetch = fetch): Promise<TregResponse> {
  if (!token) throw new TregError('TREG_TOKEN не задан', true, 'no_token');
  const b = budget;   // бюджет, в котором резервировали, — даже если прогон сменился
  if (!(await b.acquire(c.maxCostUsd))) {
    throw new TregError(`Treg: исчерпан бюджет прогона $${b.limitUsd} (TREG_MAX_USD_PER_RUN)`, true, 'run_budget');
  }
  const url = new URL(`${config.treg.baseUrl}/call/${tool}`);
  for (const [k, v] of Object.entries(c.query ?? {})) url.searchParams.set(k, String(v));
  const method = c.method ?? (c.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = {
    'X-Treg-Token': token,
    'X-Treg-Route-Max-Cost': String(c.maxCostUsd),
    'Idempotency-Key': randomUUID(),
    ...c.headers,
  };
  if (c.body !== undefined) headers['content-type'] = 'application/json';

  let charged = 0;
  try {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method,
          headers,
          body: c.body === undefined ? undefined : JSON.stringify(c.body),
          signal: AbortSignal.timeout(75_000),   // асинхронного провайдера Treg ждёт до 60 с
        });
      } catch (e) {
        if (attempt < 3) {
          await sleep(1_500 * attempt);
          continue;
        }
        throw new TregError(`Treg недоступен: ${(e as Error).message}`, false);
      }
      charged = Number(res.headers.get('x-treg-cost-micro') ?? 0) / 1e6 || 0;
      const fromTreg = res.headers.get('x-treg-error') === '1';
      const text = await res.text();
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      const code = tregErrorCode(body);
      const out = { status: res.status, body, costUsd: charged, servedBy: res.headers.get('x-treg-served-by'), callId: res.headers.get('x-treg-call-id') };

      if (res.ok) return out;  // 200 и 202 (асинхронный провайдер ещё считает) — решает вызывающий
      if (res.status === 401 && fromTreg) throw new TregError(`Treg отклонил токен: ${errorText(body)}`, true, 'auth');
      if (res.status === 402 && code === 'insufficient_balance') {
        throw new TregError('Treg: на балансе не хватает денег — пополни баланс на treg.to', true, code);
      }
      if (res.status === 402) throw new TregError(`Treg: вызов дороже потолка $${c.maxCostUsd}`, false, code ?? 'route_max_cost');
      // все провайдеры маршрута промахнулись — это промах, а не сбой; промахи бывают платными
      if (res.status === 502 && code === 'route_failed') {
        charged = Number(body?.charged_micro ?? body?.detail?.charged_micro ?? 0) / 1e6 || charged;
        return { ...out, costUsd: charged };
      }
      if (res.status === 409 && attempt < 4) {
        await sleep(3_000);   // тот же вызов ещё идёт
        continue;
      }
      if (res.status === 429 && attempt < 4) {
        const wait = Number(body?.retry_after_s ?? body?.detail?.retry_after_s ?? 3);
        await sleep(Math.min(Math.max(wait, 1), 15) * 1_000);
        continue;
      }
      if (res.status >= 500 && !fromTreg && attempt < 3) {
        await sleep(2_000 * attempt);
        continue;
      }
      throw new TregError(`Treg ${tool}: HTTP ${res.status} ${errorText(body)}`, false, code);
    }
  } finally {
    b.settle(c.maxCostUsd, charged);
  }
}

// --- Почта по имени и домену: treg.people.email.find ---

export interface FindInput {
  domain: string;           // где искать: основной почтовый домен компании
  domains: string[];        // все домены компании — адрес на любом из них её
  fullName: string;
  linkedinUrl: string | null;
}

/** Итог поиска одного человека; status — проверка ящика (valid | invalid | accept_all | unknown). */
export interface FindResult {
  email: string | null;
  status: string | null;
  servedBy: string | null;
  /** почта нашлась, но на чужом домене (прошлый работодатель) — не берём */
  foreign: boolean;
  pending: boolean;
}

const FindBody = z.object({
  output: z.object({ email: z.string().nullish(), verified: z.boolean().nullish() }).nullish(),
  _treg: z
    .object({
      served_by: z.string().nullish(),
      domain_match: z.boolean().nullish(),
      outcome: z.string().nullish(),
      verification: z.object({ verdict: z.string().nullish(), status: z.string().nullish() }).passthrough().nullish(),
    })
    .passthrough()
    .nullish(),
});

/** Ответ treg.people.email.find → адрес, если он на домене компании и не признан недействительным. */
export function parseEmailFind(status: number, body: unknown, domains: string[]): FindResult {
  const empty: FindResult = { email: null, status: null, servedBy: null, foreign: false, pending: false };
  const parsed = FindBody.safeParse(body);
  if (!parsed.success) return empty;
  const t = parsed.data._treg;
  if (status === 202 || t?.outcome === 'pending') return { ...empty, pending: true, servedBy: t?.served_by ?? null };
  const email = normalizeEmail(parsed.data.output?.email ?? '');
  if (!email) return { ...empty, servedBy: t?.served_by ?? null };
  // вердикт проверки Treg важнее отметки провайдера «verified»
  const verdict = normalizeVerdict(t?.verification?.verdict ?? t?.verification?.status, parsed.data.output?.verified ? true : null);
  const own = domains.map(baseDomain);
  const foreign = t?.domain_match === false || (own.length > 0 && !own.includes(baseDomain(email.split('@')[1])));
  return { email: foreign ? null : email, status: verdict, servedBy: t?.served_by ?? null, foreign, pending: false };
}

export async function tregFindEmail(i: FindInput): Promise<FindResult & { costUsd: number }> {
  const body: Record<string, string> = { domain: i.domain, full_name: i.fullName };
  if (i.linkedinUrl && config.treg.useLinkedIn) body.linkedin_url = i.linkedinUrl;
  const r = await tregCall('treg.people.email.find', {
    method: 'POST',
    body,
    maxCostUsd: 0.04,
    // проверка ящика в том же вызове, отдельной небольшой ценой
    headers: { 'X-Treg-Route-Verify': 'true' },
  });
  return { ...parseEmailFind(r.status, r.body, [i.domain, ...i.domains]), costUsd: r.costUsd };
}

// --- Проверка адреса: treg.people.email.verify ---

export interface VerifyResult {
  status: string | null;   // valid | invalid | accept_all | unknown | …
  servedBy: string | null;
}

const VerifyBody = z.object({
  output: z.object({ valid: z.boolean().nullish(), status: z.string().nullish() }).nullish(),
  _treg: z.object({ served_by: z.string().nullish() }).passthrough().nullish(),
});

/** Вердикт приводим к четырём словам: valid, invalid, accept_all, unknown. */
export function normalizeVerdict(status: string | null | undefined, valid?: boolean | null): string | null {
  const s = (status ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return valid === true ? 'valid' : valid === false ? 'invalid' : null;
  if (/^(valid|deliverable|ok|safe)$/.test(s)) return 'valid';
  if (/^(invalid|undeliverable|bounce|bounced|disposable|spamtrap|do_not_mail|abuse)$/.test(s)) return 'invalid';
  if (/(accept_?all|catch_?all|catchall|risky)/.test(s)) return 'accept_all';
  return 'unknown';
}

export function parseVerify(body: unknown): VerifyResult {
  const parsed = VerifyBody.safeParse(body);
  if (!parsed.success) return { status: null, servedBy: null };
  return {
    status: normalizeVerdict(parsed.data.output?.status, parsed.data.output?.valid),
    servedBy: parsed.data._treg?.served_by ?? null,
  };
}

export async function tregVerifyEmail(email: string): Promise<VerifyResult & { costUsd: number }> {
  const r = await tregCall('treg.people.email.verify', { method: 'POST', body: { email }, maxCostUsd: 0.015 });
  return { ...parseVerify(r.body), costUsd: r.costUsd };
}

// --- Размер компании: treg.companies.enrich ---

export interface CompanyEnrich {
  size: CompanySize | null;
  name: string | null;
  industry: string | null;
  location: string | null;
  founded: number | null;
  linkedinUrl: string | null;
  servedBy: string | null;
  /** провайдер нашёл другую компанию (не наш домен) */
  foreign: boolean;
}

/**
 * Размер в любом виде, как его пишут провайдеры: «51-200», «51-200 employees», «1,001-5,000», «10001+»,
 * «1K-5K», «120», 64. Нижняя граница — для фильтра «от 50 сотрудников».
 */
export function parseEmployees(v: unknown): CompanySize | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? { range: String(Math.round(v)), min: Math.round(v) } : null;
  if (typeof v !== 'string') return null;
  const s = v.toLowerCase().replace(/employees?|сотрудник\w*|people/g, '').replace(/[\s,]/g, '').replace(/–|—|to/g, '-');
  const num = (x: string) => {
    const m = x.match(/^(\d+(?:\.\d+)?)(k)?$/);
    return m ? Math.round(Number(m[1]) * (m[2] ? 1000 : 1)) : NaN;
  };
  const range = s.match(/^(\d+(?:\.\d+)?k?)-(\d+(?:\.\d+)?k?)$/);
  if (range) {
    const [a, b] = [num(range[1]), num(range[2])];
    return Number.isFinite(a) && Number.isFinite(b) && a <= b ? { range: `${a}-${b}`, min: a } : null;
  }
  const plus = s.match(/^(\d+(?:\.\d+)?k?)\+$/);
  if (plus) {
    const a = num(plus[1]);
    return Number.isFinite(a) ? { range: `${a}+`, min: a } : null;
  }
  const one = num(s);
  return Number.isFinite(one) && one > 0 ? { range: String(one), min: one } : null;
}

const EnrichBody = z.object({
  output: z
    .object({
      name: z.string().nullish(),
      domain: z.string().nullish(),
      website: z.string().nullish(),
      employees: z.union([z.string(), z.number()]).nullish(),
      industry: z.string().nullish(),
      location: z.string().nullish(),
      founded: z.number().nullish(),
      linkedin_url: z.string().nullish(),
    })
    .nullish(),
  _treg: z.object({ served_by: z.string().nullish(), domain_match: z.boolean().nullish() }).passthrough().nullish(),
});

/** Ответ treg.companies.enrich; чужой домен в ответе — другая компания, её размер не берём. */
export function parseCompanyEnrich(body: unknown, domain: string): CompanyEnrich | null {
  const parsed = EnrichBody.safeParse(body);
  if (!parsed.success || !parsed.data.output?.name) return null;
  const o = parsed.data.output;
  const t = parsed.data._treg;
  const theirs = o.domain || o.website;
  let foreign = t?.domain_match === false;
  if (!foreign && theirs) {
    try {
      foreign = baseDomain(theirs.includes('://') ? new URL(theirs).hostname : theirs) !== baseDomain(domain);
    } catch {
      /* битый адрес сайта — судим по domain_match */
    }
  }
  return {
    size: foreign ? null : parseEmployees(o.employees),
    name: o.name ?? null,
    industry: o.industry ?? null,
    location: o.location ?? null,
    founded: o.founded ?? null,
    linkedinUrl: o.linkedin_url ?? null,
    servedBy: t?.served_by ?? null,
    foreign,
  };
}

export async function tregEnrichCompany(domain: string, linkedinUrl: string | null): Promise<{ result: CompanyEnrich | null; costUsd: number }> {
  const body: Record<string, string> = { domain };
  // страница LinkedIn — только сверенная с доменом (по однофамильцу провайдер дал бы чужой размер)
  // и только если разрешено TREG_USE_LINKEDIN
  if (linkedinUrl && config.treg.useLinkedIn) body.linkedin_url = linkedinUrl;
  const r = await tregCall('treg.companies.enrich', { method: 'POST', body, maxCostUsd: 0.03 });
  return { result: r.status === 200 ? parseCompanyEnrich(r.body, domain) : null, costUsd: r.costUsd };
}
