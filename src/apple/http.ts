/** Общий HTTP-клиент для публичных фидов Apple: таймаут, ретраи с бэкоффом. */

export class HttpError extends Error {
  constructor(public readonly status: number, url: string, public readonly retryAfterMs?: number) {
    super(`HTTP ${status} for ${url}`);
  }
}

// Фиды Apple регулярно отвечают 502/504 и зависают на ~30s — такие ответы повторяем.
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfter(res: Response): number | undefined {
  const v = res.headers.get('retry-after');
  if (!v) return undefined;
  const sec = Number(v);
  if (Number.isFinite(sec)) return sec * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export interface GetOptions {
  attempts?: number;
  timeoutMs?: number;
  /** база экспоненциального бэкоффа; для лимитированных API (iTunes Lookup) больше */
  baseDelayMs?: number;
  /** доп. статусы для повтора: iTunes RSS при превышении частоты отвечает 403, а не 429 */
  retryAlso?: number[];
}

export async function getJson<T>(
  url: string,
  { attempts = 4, timeoutMs = 20_000, baseDelayMs = 500, retryAlso = [] }: GetOptions = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'app-store-leads/0.1', 'Accept-Language': 'en-US' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return (await res.json()) as T;
      lastError = new HttpError(res.status, url, retryAfter(res));
    } catch (e) {
      // сетевые ошибки, таймаут, обрезанный JSON — повторяем
      lastError = e;
    }
    if (
      lastError instanceof HttpError &&
      !RETRYABLE.has(lastError.status) &&
      !retryAlso.includes(lastError.status)
    ) {
      throw lastError;
    }
    if (attempt < attempts) {
      const backoff = baseDelayMs * 2 ** (attempt - 1) + Math.random() * 250;
      const hinted = lastError instanceof HttpError ? lastError.retryAfterMs ?? 0 : 0;
      await sleep(Math.min(Math.max(backoff, hinted), 60_000));
    }
  }
  throw lastError;
}
