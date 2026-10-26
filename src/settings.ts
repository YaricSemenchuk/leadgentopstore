import { z } from 'zod';
import { pool } from './db/pool.js';
import { config, COUNTRY_NAMES, GENRE_NAMES, type Chart } from './config.js';

/**
 * Что парсить: выбирается на странице «Что парсить» и хранится в БД, чтобы на Railway
 * менять выборку без передеплоя. Значения по умолчанию — из .env (config.ts).
 */

export const CHARTS: Chart[] = ['top-free', 'top-grossing', 'top-paid'];
export const CHART_LABELS: Record<Chart, string> = {
  'top-free': 'Топ бесплатных',
  'top-grossing': 'Топ по выручке',
  'top-paid': 'Топ платных',
};
export const CHART_LIMITS = [25, 50, 100] as const;

const known = (dict: Record<string, string>) => (v: string) => v in dict;

export const ParseSettingsSchema = z.object({
  countries: z.array(z.string()).transform((a) => [...new Set(a)].filter(known(COUNTRY_NAMES))).pipe(z.array(z.string()).min(1, 'выбери хотя бы одну страну')),
  genres: z.array(z.string()).transform((a) => [...new Set(a)].filter(known(GENRE_NAMES))).pipe(z.array(z.string()).min(1, 'выбери хотя бы одну категорию')),
  charts: z.array(z.enum(['top-free', 'top-grossing', 'top-paid'])).min(1, 'выбери хотя бы один чарт'),
  chartLimit: z.union([z.literal(25), z.literal(50), z.literal(100)]),
  maxLlmPerRun: z.number().int().min(0).max(2_000),
  maxAppRatings: z.number().int().min(100).max(100_000_000),
  maxPublisherRatings: z.number().int().min(1_000).max(1_000_000_000),
  excludePublishers: z
    .array(z.string())
    .transform((a) => [...new Set(a.map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 2))])
    .pipe(z.array(z.string()).max(500)),
});

export type ParseSettings = z.infer<typeof ParseSettingsSchema>;

export function defaultSettings(): ParseSettings {
  const limit = CHART_LIMITS.find((l) => l >= config.chartLimit) ?? 100;
  return ParseSettingsSchema.parse({
    countries: config.countries,
    genres: config.genres,
    charts: config.charts,
    chartLimit: limit,
    maxLlmPerRun: config.targeting.maxLlmPerRun,
    maxAppRatings: config.targeting.maxAppRatings,
    maxPublisherRatings: config.targeting.maxPublisherRatings,
    excludePublishers: config.targeting.excludePublishers,
  });
}

/** Настройки из БД поверх значений по умолчанию; без БД или при битой записи — по умолчанию. */
export async function getParseSettings(): Promise<ParseSettings> {
  const defaults = defaultSettings();
  try {
    const { rows } = await pool.query(`SELECT value FROM settings WHERE key = 'parse'`);
    if (!rows[0]) return defaults;
    const parsed = ParseSettingsSchema.safeParse({ ...defaults, ...rows[0].value });
    return parsed.success ? parsed.data : defaults;
  } catch {
    return defaults;
  }
}

export async function saveParseSettings(s: ParseSettings): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('parse', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [JSON.stringify(s)],
  );
}

/** Сколько чартов и примерно во что обойдётся проход — для подсказки на странице. */
export function estimate(s: ParseSettings) {
  const charts = s.countries.length * s.genres.length * s.charts.length;
  return {
    charts,
    // ~3 с на чарт с учётом лимита iTunes RSS; в пределах 12 ч повтор берёт кэш
    minutes: Math.max(1, Math.round((charts * 3) / 60)),
    llmCostUsd: Math.round(s.maxLlmPerRun * 0.006 * 100) / 100,
  };
}
