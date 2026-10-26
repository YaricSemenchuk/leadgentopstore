import { lookup } from 'node:dns/promises';
import net from 'node:net';

/**
 * Загрузка сторонних страниц (сайты, политики, поддержка разработчиков).
 * URL приходят из данных сторов, их пишет сам разработчик — это недоверенный ввод:
 * только http(s) на стандартных портах, без приватных/loopback/link-local адресов
 * (иначе на Railway можно дотянуться до внутренней сети или метаданных облака),
 * ручные редиректы с проверкой каждого шага и потолок размера ответа.
 */

export class BlockedUrlError extends Error {}

const MAX_REDIRECTS = 4;
const MAX_BYTES = 3_000_000;
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||   // CGNAT
      (a === 169 && b === 254) ||             // link-local, метаданные облака
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`схема ${url.protocol} запрещена`);
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new BlockedUrlError(`порт ${url.port} запрещён`);
  }
  if (url.username || url.password) throw new BlockedUrlError('URL с учётными данными запрещён');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateIp)) {
    throw new BlockedUrlError(`${host} указывает на непубличный адрес`);
  }
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface Page {
  url: string;           // итоговый URL после редиректов
  status: number;
  html: string;          // пусто, если не 2xx или не HTML
}

const HTML_TYPE = /text\/html|application\/xhtml\+xml|text\/plain/i;

export interface FetchPageOptions {
  timeoutMs?: number;
  language?: string;
  /** попыток на сетевую ошибку / 5xx / 429; сторам (App Store, Google Play) нужно больше и с паузой */
  attempts?: number;
  baseDelayMs?: number;
}

/** GET страницы с проверками выше и повтором с экспоненциальной паузой. */
export async function fetchPage(
  rawUrl: string,
  { timeoutMs = 15_000, language = 'en-US', attempts = 2, baseDelayMs = 1_000 }: FetchPageOptions = {},
): Promise<Page> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchOnce(new URL(rawUrl), timeoutMs, language);
    } catch (e) {
      const retryable = !(e instanceof BlockedUrlError) && attempt < attempts;
      if (!retryable) throw e;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1) + Math.random() * 500));
    }
  }
}

class RetryableStatus extends Error {}

async function fetchOnce(start: URL, timeoutMs: number, language: string): Promise<Page> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': language, Accept: 'text/html,*/*;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel();
      throw new RetryableStatus(`HTTP ${res.status} for ${url.href}`);
    }
    if (!res.ok || !HTML_TYPE.test(res.headers.get('content-type') ?? '')) {
      await res.body?.cancel();
      return { url: url.href, status: res.status, html: '' };
    }
    return { url: url.href, status: res.status, html: await readCapped(res) };
  }
  throw new Error(`слишком много редиректов: ${start.href}`);
}
