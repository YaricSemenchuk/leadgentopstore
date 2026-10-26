import type { RawAppearance } from '../apple/charts.js';
import type { AppMeta, PublisherStats } from '../apple/lookup.js';
import { GENRE_NAMES } from '../config.js';

/** Лучшее попадание в чарт: где именно приложение стоит выше всего. */
export interface Placement {
  country: string;
  chart: string;
  genre: string;         // название категории, 'Overall' — общий чарт
  rank: number;
}

/** Кандидат-лид: приложение, собранное из всех его появлений в чартах + метаданные. */
export interface Candidate {
  trackId: string;
  name: string;
  developer: string;
  artistId?: number;
  bundleId?: string;
  sellerUrl?: string;
  appStoreUrl?: string;
  primaryGenre: string;
  genres: string[];
  price: number;
  // Сигналы охвата
  countries: string[];            // страны, где засветилось
  countryCount: number;
  charts: string[];               // в каких чартах
  bestRank: number;               // лучшая позиция по всем появлениям
  bestPlacement: Placement;
  inGrossing: boolean;            // есть в top-grossing = уже монетизируется
  // Сигналы свежести/качества (из lookup)
  releaseDate?: string;
  lastUpdate?: string;
  rating?: number;
  ratingCount?: number;
  // Размер издателя (заполняется перед LLM)
  publisher?: PublisherStats;
}

/** Схлопывает появления по trackId и обогащает метаданными. */
export function buildCandidates(
  appearances: RawAppearance[],
  meta: Map<string, AppMeta>,
): Candidate[] {
  const byId = new Map<string, RawAppearance[]>();
  for (const a of appearances) {
    const arr = byId.get(a.entry.id) ?? [];
    arr.push(a);
    byId.set(a.entry.id, arr);
  }

  const candidates: Candidate[] = [];
  for (const [trackId, apps] of byId) {
    const first = apps[0].entry;
    const m = meta.get(trackId);
    const countries = [...new Set(apps.map((a) => a.country))];
    const charts = [...new Set(apps.map((a) => a.chart))];
    const best = apps.reduce((b, a) => (a.rank < b.rank ? a : b));

    candidates.push({
      trackId,
      name: m?.trackName ?? first.name,
      developer: m?.sellerName ?? first.artistName,
      artistId: m?.artistId,
      bundleId: m?.bundleId ?? first.bundleId,
      sellerUrl: m?.sellerUrl,
      appStoreUrl: m?.trackViewUrl ?? first.url,
      primaryGenre: m?.primaryGenreName ?? first.genres[0]?.name ?? 'Unknown',
      genres: m?.genres ?? first.genres.map((g) => g.name),
      price: m?.price ?? 0,
      countries,
      countryCount: countries.length,
      charts,
      bestRank: best.rank,
      bestPlacement: {
        country: best.country,
        chart: best.chart,
        genre: GENRE_NAMES[best.genre] ?? best.genre,
        rank: best.rank,
      },
      inGrossing: charts.includes('top-grossing'),
      releaseDate: m?.releaseDate ?? first.releaseDate,
      lastUpdate: m?.currentVersionReleaseDate,
      rating: m?.averageUserRating,
      ratingCount: m?.userRatingCount,
    });
  }

  // Сортируем по привлекательности: широкое гео + хорошая позиция вперёд.
  candidates.sort(
    (a, b) => b.countryCount - a.countryCount || a.bestRank - b.bestRank,
  );
  return candidates;
}

/** Дешёвые детерминированные сигналы — считаем без LLM, чтобы не гонять модель впустую. */
export function heuristicSignals(c: Candidate) {
  const now = Date.now();
  const months = (iso?: string) =>
    iso ? (now - new Date(iso).getTime()) / (1000 * 60 * 60 * 24 * 30) : Infinity;

  return {
    isNew: months(c.releaseDate) <= 6,          // релиз за последние полгода
    recentlyUpdated: months(c.lastUpdate) <= 1, // активно развивается
    wideGeo: c.countryCount >= 5,
    isGameOrUtility:
      /game|util|productiv|entertain/i.test(c.primaryGenre) ||
      c.genres.some((g) => /game|util/i.test(g)),
    lowRatingVolume:
      c.ratingCount !== undefined && c.ratingCount > 0 && c.ratingCount < 5000,
    // "слабое ASO" пока приблизительно: мало отзывов при попадании в топ.
    // Точный сигнал добавим на этапе 2 через aso-prod MCP (promobile).
    weakAsoHint:
      c.ratingCount !== undefined && c.ratingCount < 2000 && c.bestRank <= 100,
  };
}

/** Порядок отбора в LLM: сначала те, у кого больше признаков «нужен буст». */
export function priorityScore(c: Candidate): number {
  const s = heuristicSignals(c);
  return (
    (s.isNew ? 3 : 0) +
    (s.weakAsoHint ? 2 : 0) +
    (s.lowRatingVolume ? 1 : 0) +
    (s.wideGeo ? 2 : 0) +
    (s.isGameOrUtility ? 1 : 0) +
    (c.inGrossing ? 2 : 0) +           // уже зарабатывает — есть чем платить за трафик
    Math.min(c.countryCount, 10) / 5 +
    (c.bestRank <= 20 ? 1 : 0)
  );
}
