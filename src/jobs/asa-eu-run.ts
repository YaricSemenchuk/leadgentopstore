import { config } from '../config.js';
import { getAsaEu } from '../apple/ad-repository.js';
import { appsNeedingAsaEu } from '../db/companies.js';

/** Итог шага «Apple Ads в ЕС»: сколько приложений проверили и что нашли. */
export interface AsaEuRunResult {
  checked: number;
  active: number;
  past: number;
  failed: number;
  error?: string;
}

/**
 * Проверка приложений целевых компаний и компаний «под вопросом» в реестре рекламы Apple.
 * Бесплатно, но медленно: общее с расширением «ведро» запросов пускает ~1 запрос в 3 секунды,
 * поэтому идём по одному приложению. Результат ложится в asa_eu_cache, компании читают его оттуда.
 */
export async function runAsaEu(
  report: (stage: string) => void = () => {},
  limit = config.asaEu.maxPerRun,
): Promise<AsaEuRunResult> {
  const ids = await appsNeedingAsaEu(limit, config.asaEu.recheckDays);
  const result: AsaEuRunResult = { checked: 0, active: 0, past: 0, failed: 0 };
  let failedInRow = 0;
  for (const id of ids) {
    report(`Apple Ads в ЕС ${result.checked + result.failed}/${ids.length}, крутят сейчас ${result.active}`);
    try {
      const s = await getAsaEu(id);
      if (s.stale) throw new Error('реестр не ответил, осталась старая копия');
      result.checked++;
      if (s.status === 'active') result.active++;
      else if (s.status === 'past') result.past++;
      failedInRow = 0;
    } catch (e) {
      result.failed++;
      console.warn(`  ⚠ Apple Ads ЕС ${id}: ${(e as Error).message}`);
      // реестр лёг или режет нас — не тратим полчаса на заведомо пустые повторы
      if (++failedInRow >= 5) {
        result.error = 'реестр Apple не отвечает пять раз подряд — остановлено';
        break;
      }
    }
  }
  if (ids.length) {
    console.log(`  Apple Ads ЕС: проверено ${result.checked} из ${ids.length}, крутят сейчас ${result.active}, раньше ${result.past}${result.error ? ` — ${result.error}` : ''}`);
  }
  return result;
}
