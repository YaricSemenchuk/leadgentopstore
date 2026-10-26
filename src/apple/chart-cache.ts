import { pool } from '../db/pool.js';
import type { ChartEntry } from './charts.js';

/**
 * Кэш чартов в Postgres. iTunes RSS блокирует IP после нескольких сотен запросов,
 * а чарты меняются несколько раз в сутки — повторный проход в пределах TTL не ходит
 * в фид, а при блокировке можно взять устаревшую копию.
 */
export interface ChartCache {
  get(key: string): Promise<{ entries: ChartEntry[]; ageHours: number } | null>;
  put(key: string, entries: ChartEntry[]): Promise<void>;
}

/** Кэш на Postgres; без БД (dry run без DATABASE_URL) молча работает как пустой. */
export function pgChartCache(): ChartCache {
  let broken = false;
  return {
    async get(key) {
      if (broken) return null;
      try {
        const { rows } = await pool.query(
          `SELECT entries, extract(epoch FROM now() - fetched_at) / 3600 AS age FROM chart_cache WHERE key = $1`,
          [key],
        );
        return rows[0] ? { entries: rows[0].entries as ChartEntry[], ageHours: Number(rows[0].age) } : null;
      } catch {
        broken = true;
        return null;
      }
    },
    async put(key, entries) {
      if (broken) return;
      try {
        await pool.query(
          `INSERT INTO chart_cache (key, entries, fetched_at) VALUES ($1, $2, now())
           ON CONFLICT (key) DO UPDATE SET entries = $2, fetched_at = now()`,
          [key, JSON.stringify(entries)],
        );
      } catch {
        broken = true;
      }
    },
  };
}
