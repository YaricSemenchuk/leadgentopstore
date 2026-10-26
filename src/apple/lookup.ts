import pLimit from 'p-limit';
import { getJson } from './http.js';

/** Метаданные приложения из iTunes Lookup API. */
export interface AppMeta {
  trackId: number;
  trackName: string;
  sellerName: string;
  artistName: string;
  primaryGenreName: string;
  genres: string[];
  price: number;
  currency: string;
  releaseDate?: string;
  currentVersionReleaseDate?: string;
  averageUserRating?: number;
  userRatingCount?: number;
  sellerUrl?: string;       // публичный сайт разработчика, если указан
  bundleId?: string;
  artistId?: number;
  trackViewUrl?: string;    // страница в App Store
}

/** iTunes Lookup лимитирован (~20 запросов/мин с IP): длинный бэкофф и честный Retry-After. */
const LOOKUP_RETRY = { attempts: 5, baseDelayMs: 3_000, timeoutMs: 30_000 };

const LOOKUP = 'https://itunes.apple.com/lookup';
const CHUNK = 150;

/** Лукап пачкой id в одном сторфронте. Упавшая пачка не роняет остальные. */
export async function lookupApps(
  ids: string[],
  country = 'us',
  concurrency = 3,
): Promise<Map<string, AppMeta>> {
  const out = new Map<string, AppMeta>();
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));

  const gate = pLimit(concurrency);
  await Promise.all(
    chunks.map((chunk) =>
      gate(async () => {
        const url = `${LOOKUP}?id=${chunk.join(',')}&country=${country}&entity=software`;
        let data: { results?: any[] };
        try {
          data = await getJson<{ results?: any[] }>(url, LOOKUP_RETRY);
        } catch (e) {
          console.warn(`  ⚠ lookup ${country} (${chunk.length} id): ${(e as Error).message}`);
          return;
        }
        for (const r of data.results ?? []) {
          if (!r.trackId) continue;
          out.set(String(r.trackId), {
            trackId: r.trackId,
            trackName: r.trackName,
            sellerName: r.sellerName ?? r.artistName,
            artistName: r.artistName,
            primaryGenreName: r.primaryGenreName,
            genres: r.genres ?? [],
            price: r.price ?? 0,
            currency: r.currency ?? 'USD',
            releaseDate: r.releaseDate,
            currentVersionReleaseDate: r.currentVersionReleaseDate,
            averageUserRating: r.averageUserRating,
            userRatingCount: r.userRatingCount,
            sellerUrl: r.sellerUrl,
            bundleId: r.bundleId,
            artistId: r.artistId,
            trackViewUrl: typeof r.trackViewUrl === 'string' ? r.trackViewUrl.split('?')[0] : undefined,
          });
        }
      }),
    ),
  );

  return out;
}

/**
 * Лукап с фолбэком по странам: сначала всё в US-сторе, затем приложения,
 * которых там нет (локальные для CN/JP/KR…), — в стране, где они попали в чарт.
 */
export async function lookupWithFallback(
  idsWithCountry: Map<string, string>,
  concurrency = 3,
): Promise<Map<string, AppMeta>> {
  const meta = await lookupApps([...idsWithCountry.keys()], 'us', concurrency);

  const missingByCountry = new Map<string, string[]>();
  for (const [id, country] of idsWithCountry) {
    if (meta.has(id) || country === 'us') continue;
    const list = missingByCountry.get(country) ?? [];
    list.push(id);
    missingByCountry.set(country, list);
  }

  for (const [country, ids] of missingByCountry) {
    const local = await lookupApps(ids, country, concurrency);
    for (const [id, m] of local) meta.set(id, m);
  }
  return meta;
}

/** Размер издателя: сколько у него приложений и сколько на них суммарно отзывов. */
export interface PublisherStats {
  apps: number;
  totalRatings: number;
}

const ARTIST_CHUNK = 20;

/**
 * Портфель издателей пачками: lookup?id=<artistId,…>&entity=software отдаёт
 * все приложения каждого издателя (Apple режет список на ~50 на издателя —
 * для порога «гигант или нет» этого хватает).
 */
export async function lookupPublishers(
  artistIds: number[],
  country = 'us',
  concurrency = 2,
): Promise<Map<number, PublisherStats>> {
  const out = new Map<number, PublisherStats>();
  const ids = [...new Set(artistIds)];
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += ARTIST_CHUNK) chunks.push(ids.slice(i, i + ARTIST_CHUNK));

  const gate = pLimit(concurrency);
  await Promise.all(
    chunks.map((chunk) =>
      gate(async () => {
        const url = `${LOOKUP}?id=${chunk.join(',')}&entity=software&limit=200&country=${country}`;
        let data: { results?: any[] };
        try {
          data = await getJson<{ results?: any[] }>(url, LOOKUP_RETRY);
        } catch (e) {
          console.warn(`  ⚠ lookup издателей (${chunk.length}): ${(e as Error).message}`);
          return;
        }
        for (const r of data.results ?? []) {
          if (r.wrapperType !== 'software' || !r.artistId) continue;
          const s = out.get(r.artistId) ?? { apps: 0, totalRatings: 0 };
          s.apps++;
          s.totalRatings += r.userRatingCount ?? 0;
          out.set(r.artistId, s);
        }
      }),
    ),
  );
  return out;
}
