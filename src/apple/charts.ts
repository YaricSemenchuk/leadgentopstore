import pLimit from 'p-limit';
import type { Chart } from '../config.js';
import { getJson, HttpError, sleep } from './http.js';
import type { ChartCache } from './chart-cache.js';

/** Одна позиция чарта. */
export interface ChartEntry {
  id: string;            // trackId
  name: string;
  artistName: string;
  genres: { genreId: string; name: string }[];
  url: string;
  releaseDate?: string;
  bundleId?: string;
}

/** Оба фида отдают максимум 100 позиций на чарт. */
export const MAX_CHART_LIMIT = 100;

// Основной источник — классический iTunes RSS: стабильный, есть top-grossing,
// у каждой позиции есть жанр и bundleId.
const ITUNES_RSS = 'https://itunes.apple.com';
const ITUNES_FEED: Record<Chart, string> = {
  'top-free': 'topfreeapplications',
  'top-paid': 'toppaidapplications',
  'top-grossing': 'topgrossingapplications',
};

interface ItunesEntry {
  'im:name': { label: string };
  'im:artist': { label: string };
  id: { label: string; attributes: { 'im:id': string; 'im:bundleId'?: string } };
  category?: { attributes: { 'im:id': string; label: string } };
  'im:releaseDate'?: { label: string };
}

interface ItunesFeed {
  // при одной позиции Apple отдаёт объект, а не массив; при пустом чарте поля нет
  feed: { entry?: ItunesEntry | ItunesEntry[] };
}

async function fetchItunesChart(
  country: string,
  chart: Chart,
  limit: number,
  genre: string,
): Promise<ChartEntry[]> {
  const genrePart = genre === 'all' ? '' : `/genre=${genre}`;
  const url = `${ITUNES_RSS}/${country}/rss/${ITUNES_FEED[chart]}/limit=${limit}${genrePart}/json`;
  // при сотнях чартов подряд RSS начинает отвечать 403 — это лимит частоты, ждём и повторяем
  const data = await getJson<ItunesFeed>(url, { attempts: 3, baseDelayMs: 5_000, retryAlso: [403] });
  const raw = data.feed.entry;
  const entries = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return entries.map((e) => ({
    id: e.id.attributes['im:id'],
    name: e['im:name'].label,
    artistName: e['im:artist'].label,
    genres: e.category
      ? [{ genreId: e.category.attributes['im:id'], name: e.category.attributes.label }]
      : [],
    url: e.id.label.split('?')[0],
    releaseDate: e['im:releaseDate']?.label,
    bundleId: e.id.attributes['im:bundleId'],
  }));
}

// Запасной источник — Marketing Tools RSS v2. Top-grossing там нет (404),
// и он часто отвечает 502/504, поэтому только как фолбэк.
const MARKETING_RSS = 'https://rss.marketingtools.apple.com/api/v2';

interface MarketingFeed {
  feed: {
    results: Array<{
      id: string;
      name: string;
      artistName: string;
      genres?: { genreId: string; name: string }[];
      url: string;
      releaseDate?: string;
    }>;
  };
}

async function fetchMarketingChart(country: string, chart: Chart, limit: number): Promise<ChartEntry[]> {
  const url = `${MARKETING_RSS}/${country}/apps/${chart}/${limit}/apps.json`;
  const data = await getJson<MarketingFeed>(url, { attempts: 3, timeoutMs: 35_000 });
  return data.feed.results.map((r) => ({
    id: r.id,
    name: r.name,
    artistName: r.artistName,
    genres: r.genres ?? [],
    url: r.url,
    releaseDate: r.releaseDate,
  }));
}

/**
 * Один чарт одной страны (genre 'all' — общий, иначе id категории).
 * iTunes RSS, при его отказе — Marketing RSS (только общие top-free/top-paid: категорий там нет).
 */
export async function fetchChart(
  country: string,
  chart: Chart,
  limit: number,
  genre = 'all',
): Promise<ChartEntry[]> {
  try {
    return await fetchItunesChart(country, chart, limit, genre);
  } catch (primaryError) {
    if (chart === 'top-grossing' || genre !== 'all') throw primaryError;
    try {
      return await fetchMarketingChart(country, chart, limit);
    } catch (e) {
      // нет такого чарта в стране — не ошибка
      if (e instanceof HttpError && e.status === 404) return [];
      throw primaryError;
    }
  }
}

export interface RawAppearance {
  entry: ChartEntry;
  country: string;
  chart: Chart;
  genre: string;         // 'all' или id категории
  rank: number;          // позиция в чарте, с 1
}

export interface ChartsResult {
  appearances: RawAppearance[];
  total: number;         // сколько чартов в выборке
  fetched: number;       // скачано из фида
  fromCache: number;     // свежая копия из кэша
  stale: number;         // фид не ответил — взята устаревшая копия
  failed: string[];      // "us/top-free/6014" — не получены совсем
  rateLimited: boolean;  // сработал предохранитель по 403
}

export interface FetchChartsOptions {
  limit: number;
  concurrency: number;
  cache?: ChartCache;
  cacheTtlHours?: number;  // свежая копия — без запроса к фиду
  staleMaxHours?: number;  // при отказе фида берём копию не старше
  minIntervalMs?: number;  // темп запросов к RSS
  breakerAfter?: number;   // столько 403 подряд — дальше в фид не ходим
}

/** Не чаще одного запроса в minIntervalMs на весь процесс. */
function pacer(minIntervalMs: number) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + minIntervalMs;
    if (at > now) await sleep(at - now);
  };
}

/**
 * Тянет страны×категории×чарты. Упавший чарт не роняет проход. iTunes RSS блокирует IP
 * после нескольких сотен запросов, поэтому: свежий кэш вместо запроса, ровный темп,
 * а после серии 403 — больше не стучимся (повторы только продлевают блок) и
 * дорабатываем на устаревшем кэше.
 */
export async function fetchAllCharts(
  countries: string[],
  genres: string[],
  charts: Chart[],
  {
    limit,
    concurrency,
    cache,
    cacheTtlHours = 12,
    staleMaxHours = 24 * 7,
    minIntervalMs = 700,
    breakerAfter = 6,
  }: FetchChartsOptions,
): Promise<ChartsResult> {
  const gate = pLimit(concurrency);
  const pace = pacer(minIntervalMs);
  const result: ChartsResult = {
    appearances: [], total: 0, fetched: 0, fromCache: 0, stale: 0, failed: [], rateLimited: false,
  };
  let forbiddenStreak = 0;
  const jobs: Promise<RawAppearance[]>[] = [];

  for (const country of countries) {
    for (const genre of genres) {
      for (const chart of charts) {
        const label = `${country}/${chart}/${genre}`;
        const toAppearances = (entries: ChartEntry[]) =>
          entries.map((entry, i) => ({ entry, country, chart, genre, rank: i + 1 }));

        jobs.push(
          gate(async () => {
            const key = `${label}/${limit}`;
            const cached = await cache?.get(key);
            if (cached && cached.ageHours <= cacheTtlHours) {
              result.fromCache++;
              return toAppearances(cached.entries);
            }

            let error: unknown = null;
            if (!result.rateLimited) {
              try {
                await pace();
                const entries = await fetchChart(country, chart, limit, genre);
                forbiddenStreak = 0;
                result.fetched++;
                await cache?.put(key, entries);
                return toAppearances(entries);
              } catch (e) {
                error = e;
                if (e instanceof HttpError && e.status === 403) {
                  if (++forbiddenStreak >= breakerAfter && !result.rateLimited) {
                    result.rateLimited = true;
                    console.warn(`  ⚠ iTunes RSS отвечает 403 подряд ${forbiddenStreak} раз — лимит, дальше только кэш`);
                  }
                } else {
                  forbiddenStreak = 0;
                }
              }
            }

            if (cached && cached.ageHours <= staleMaxHours) {
              result.stale++;
              return toAppearances(cached.entries);
            }
            result.failed.push(label);
            if (error) console.warn(`  ⚠ чарт ${label}: ${(error as Error).message}`);
            return [];
          }),
        );
      }
    }
  }

  result.total = jobs.length;
  result.appearances = (await Promise.all(jobs)).flat();
  return result;
}
