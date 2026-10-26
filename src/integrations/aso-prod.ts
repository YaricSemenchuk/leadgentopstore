/**
 * Этап 2 — точный сигнал "слабое ASO" через promobile (aso-prod MCP).
 *
 * Сейчас квалификация использует приблизительный признак weakAsoHint
 * (мало отзывов при высокой позиции). Когда будешь готов подключить
 * реальные данные видимости/ключей, реализуй здесь вызов к promobile
 * (напр. app_keywords / aso_keywords / keyword_metrics) и верни скор.
 *
 * Держим это отдельным модулем, чтобы основной пайплайн не зависел
 * от доступности MCP и работал на Railway без него.
 */

export interface AsoSignal {
  /** 0-100: насколько ASO недооптимизировано (выше = больше потенциал роста). */
  weakAsoScore: number;
  /** Сколько целевых ключей вне топ-10 — грубая мера упущенной видимости. */
  keywordsOutOfTop?: number;
  source: 'promobile' | 'heuristic';
}

/**
 * Заглушка. Возвращает null, пока интеграция не подключена —
 * пайплайн тогда опирается на эвристику. Сигнатуру менять не нужно.
 */
export async function getAsoSignal(_trackId: string): Promise<AsoSignal | null> {
  return null;
}
