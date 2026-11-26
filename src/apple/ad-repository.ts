import { pool } from '../db/pool.js';
import { getJson, HttpError, sleep } from './http.js';

/**
 * Apple Ad Repository — публичный реестр рекламы в App Store для стран ЕС (DSA).
 * Ключ не нужен. По ID приложения отвечает, крутило ли оно Apple Ads в ЕС, где и когда.
 * Ключей и ставок там нет, США и Великобритании нет — только 25 стран ЕС.
 *
 * Документация: https://developer.apple.com/support/downloads/Ad-Repository.pdf (v1, март 2025).
 * Живыми запросами 2026-11-26 проверено, где API расходится с PDF:
 *  - countryOrRegion необязателен: без него ответ сразу по всем странам; в in=(…) не больше 5 стран;
 *  - offset — номер страницы, а не номер записи; limit не больше 100;
 *  - строки отсортированы по lastImpressionDate по убыванию; даты вида "2026-11-21 00:00:00.0";
 *  - заголовок Accept по умолчанию (звёздочка/звёздочка) даёт 503, нужен application/json;
 *  - лимит с одного IP — около 4 запросов подряд, дальше примерно один в 3 секунды, сверх — 429;
 *  - встречается плейсмент APPSTORE_PRODUCT_PAGE, которого в документации нет.
 * Данные отстают на ~5–7 дней: dataEndDate в ответе — последний день, за который они есть.
 */

const BASE = 'https://adrepository.apple.com/api/v1/ad-repository-ads';
const PAGE_SIZE = 100;
/**
 * Для разбивки по странам хватает 200 последних объявлений: у мелких и средних столько
 * за 90 дней обычно и нет, а у гигантов это свежая неделя-две, то есть где они крутятся сейчас.
 */
const MAX_PAGES = 2;
/** «Активна» — последний показ не раньше чем за неделю до конца данных, то есть ~2 недели от сегодня. */
const ACTIVE_DAYS = 7;
export const CACHE_HOURS = 24;

export type AsaEuStatus = 'active' | 'past' | 'none';

export interface AsaEuBreakdown {
  /** код страны (DE) или плейсмент (APPSTORE_SEARCH_RESULTS) */
  key: string;
  ads: number;
  /** последний показ, YYYY-MM-DD */
  last: string;
}

export interface AsaEuSummary {
  appId: string;
  status: AsaEuStatus;
  lastImpression: string | null;
  /** самый ранний первый показ среди просмотренных; если adsScanned < adsTotal, реальный может быть раньше */
  firstImpression: string | null;
  dataStart: string | null;
  dataEnd: string | null;
  adsTotal: number;
  adsScanned: number;
  countries: AsaEuBreakdown[];
  placements: AsaEuBreakdown[];
  developerName: string | null;
  legalName: string | null;
  checkedAt: string;
}

export interface AdRow {
  adId?: string;
  developerName?: string | null;
  legalName?: string | null;
  placement?: string | null;
  countryOrRegion?: string | null;
  firstImpressionDate?: string | null;
  lastImpressionDate?: string | null;
}

interface AdsPage {
  data?: AdRow[];
  dataStartDate?: string;
  dataEndDate?: string;
  pagination?: { totalResults?: number };
}

const day = (v: string | null | undefined): string | null => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

function addDays(isoDay: string, n: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function breakdown(rows: AdRow[], keyOf: (r: AdRow) => string | null | undefined): AsaEuBreakdown[] {
  const by = new Map<string, AsaEuBreakdown>();
  for (const r of rows) {
    const key = keyOf(r);
    const last = day(r.lastImpressionDate);
    if (!key || !last) continue;
    const e = by.get(key) ?? { key, ads: 0, last };
    e.ads += 1;
    if (last > e.last) e.last = last;
    by.set(key, e);
  }
  return [...by.values()].sort((a, b) => b.last.localeCompare(a.last) || b.ads - a.ads || a.key.localeCompare(b.key));
}

/** Сводка по строкам реестра. Чистая функция: на ней держатся тесты. */
export function summarize(
  appId: string,
  rows: AdRow[],
  meta: { total: number; dataStart?: string | null; dataEnd?: string | null },
  now = new Date(),
): AsaEuSummary {
  const lasts = rows.map((r) => day(r.lastImpressionDate)).filter((d): d is string => !!d);
  const firsts = rows.map((r) => day(r.firstImpressionDate)).filter((d): d is string => !!d);
  const lastImpression = lasts.length ? lasts.reduce((a, b) => (b > a ? b : a)) : null;
  const dataEnd = day(meta.dataEnd);
  let status: AsaEuStatus = 'none';
  if (lastImpression) {
    const edge = addDays(dataEnd ?? now.toISOString().slice(0, 10), -ACTIVE_DAYS);
    status = lastImpression >= edge ? 'active' : 'past';
  }
  const named = rows.find((r) => r.developerName || r.legalName);
  return {
    appId,
    status,
    lastImpression,
    firstImpression: firsts.length ? firsts.reduce((a, b) => (b < a ? b : a)) : null,
    dataStart: day(meta.dataStart),
    dataEnd,
    adsTotal: Math.max(meta.total, rows.length),
    adsScanned: rows.length,
    countries: breakdown(rows, (r) => r.countryOrRegion?.toUpperCase()),
    placements: breakdown(rows, (r) => r.placement),
    developerName: named?.developerName ?? null,
    legalName: named?.legalName ?? null,
    checkedAt: now.toISOString(),
  };
}

// Ведро токенов на весь сервер под лимит реестра: 4 запроса подряд, дальше один в 3 секунды.
const BURST = 4;
const REFILL_MS = 3_000;
let tokens = BURST;
let refilledAt = Date.now();
let queue: Promise<void> = Promise.resolve();

function takeToken(): Promise<void> {
  const turn = queue.then(async () => {
    for (;;) {
      const now = Date.now();
      const add = Math.floor((now - refilledAt) / REFILL_MS);
      if (add > 0) {
        tokens = Math.min(BURST, tokens + add);
        refilledAt = tokens === BURST ? now : refilledAt + add * REFILL_MS;
      }
      if (tokens > 0) {
        tokens -= 1;
        return;
      }
      await sleep(refilledAt + REFILL_MS - now);
    }
  });
  queue = turn.catch(() => undefined);
  return turn;
}

function pageUrl(appId: string, page: number): string {
  const q = new URLSearchParams({
    ql: `type==APP;id==${appId};datePreset==LAST_90_DAYS`,
    limit: String(PAGE_SIZE),
    offset: String(page),
  });
  return `${BASE}?${q}`;
}

/** Каждая попытка, и повтор после 429 тоже, берёт токен из общего ведра. */
async function fetchPage(appId: string, page: number): Promise<AdsPage> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await takeToken();
    try {
      return await getJson<AdsPage>(pageUrl(appId, page), {
        headers: { Accept: 'application/json' },
        attempts: 1,
        timeoutMs: 20_000,
      });
    } catch (e) {
      lastError = e;
      if (e instanceof HttpError && e.status < 500 && e.status !== 429 && e.status !== 408) throw e;
      await sleep(1_000 * attempt);
    }
  }
  throw lastError;
}

/**
 * Объявления приложения за 90 дней по всем странам ЕС. Строки идут от свежих к старым,
 * поэтому первая страница уже даёт последний показ, вторая уточняет разбивку по странам.
 */
export async function fetchAsaEu(appId: string): Promise<AsaEuSummary> {
  const first = await fetchPage(appId, 0);
  const rows = [...(first.data ?? [])];
  const total = first.pagination?.totalResults ?? rows.length;
  const pages = Math.ceil(total / PAGE_SIZE);
  for (let p = 1; p < Math.min(pages, MAX_PAGES); p++) rows.push(...((await fetchPage(appId, p)).data ?? []));
  return summarize(appId, rows, { total, dataStart: first.dataStartDate, dataEnd: first.dataEndDate });
}

export const isAppId = (v: string) => /^\d{1,12}$/.test(v);

// Одно приложение не запрашиваем у Apple дважды, если вкладки открыли одновременно.
const inFlight = new Map<string, Promise<AsaEuSummary>>();

export type CachedAsaEu = AsaEuSummary & { cached: boolean; stale?: boolean };

/** Лимит запросов к реестру на сервере исчерпан, а копии в кэше нет. */
export class AsaBudgetError extends Error {}

/**
 * Сводка из кэша на сутки; иначе свежая из реестра. allowMiss решает, можно ли сейчас
 * идти в реестр (лимит сервера). Если реестр лежит или лимит исчерпан, а в кэше есть
 * устаревшая копия, отдаём её с пометкой stale. Без БД работает без кэша.
 */
export async function getAsaEu(appId: string, allowMiss: () => boolean = () => true): Promise<CachedAsaEu> {
  if (!isAppId(appId)) throw new Error(`bad app id: ${appId}`);
  let stale: AsaEuSummary | null = null;
  try {
    const { rows } = await pool.query(
      `SELECT summary, fetched_at > now() - make_interval(hours => $2) AS fresh FROM asa_eu_cache WHERE app_id = $1`,
      [appId, CACHE_HOURS],
    );
    if (rows[0]?.fresh) return { ...(rows[0].summary as AsaEuSummary), cached: true };
    stale = (rows[0]?.summary as AsaEuSummary | undefined) ?? null;
  } catch {
    /* нет БД — идём в реестр */
  }

  let job = inFlight.get(appId);
  if (!job) {
    if (!allowMiss()) {
      if (stale) return { ...stale, cached: true, stale: true };
      throw new AsaBudgetError('Ad Repository request budget exhausted');
    }
    job = fetchAsaEu(appId).finally(() => inFlight.delete(appId));
    inFlight.set(appId, job);
  }
  try {
    const summary = await job;
    await pool
      .query(
        `INSERT INTO asa_eu_cache (app_id, summary, fetched_at) VALUES ($1, $2, now())
         ON CONFLICT (app_id) DO UPDATE SET summary = $2, fetched_at = now()`,
        [appId, JSON.stringify(summary)],
      )
      .catch(() => undefined);
    return { ...summary, cached: false };
  } catch (e) {
    if (stale) return { ...stale, cached: true, stale: true };
    throw e;
  }
}
