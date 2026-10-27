import * as cheerio from 'cheerio';
import { fetchPage } from './safe-fetch.js';
import { firstMailto, normalizeEmail } from './emails.js';

/**
 * Страницы сторов, где разработчик сам указал данные о себе:
 *  - App Store: ссылки на сайт/поддержку/политику и, в сторах ЕС, блок продавца (DSA):
 *    статус «торговца», D-U-N-S (Apple проверяет юрлицо), адрес, телефон, почта;
 *  - Google Play: «Support email» и «About the developer» — юрлицо, почта аккаунта
 *    (часто личный адрес основателя), адрес, телефон, ссылка на все приложения разработчика.
 */

export class AppStoreLayoutError extends Error {}

export const STORE_RETRY = { attempts: 4, baseDelayMs: 4_000, timeoutMs: 25_000 };

export interface Trader {
  isTrader: boolean;        // указал себя торговцем; частные лица обычно нет
  duns: string | null;
  address: string | null;
  country: string | null;   // последняя строка адреса
  phone: string | null;
  email: string | null;
}

export interface AppStorePage {
  website: string | null;
  supportUrl: string | null;
  privacyUrl: string | null;
  trader: Trader | null;    // null — блока нет (стор не из ЕС)
  developerUrl: string | null;
}

const EMPTY: AppStorePage = { website: null, supportUrl: null, privacyUrl: null, trader: null, developerUrl: null };

/** «**Email**\nx@y.com» → ['Email', 'x@y.com']; подписи локализованы, поэтому смотрим на значения. */
function markdownPairs(texts: string[]): Array<[string, string]> {
  return texts
    .map((t) => t.match(/^\*\*(.+?)\*\*\s*\n([\s\S]+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => [m[1].trim(), m[2].trim()]);
}

const PHONE = /^\+?[\d][\d\s().-]{6,}$/;

// Страны в адресах продавцов. Порядок строк в адресе разный (в Гонконге страна первой), поэтому
// ищем название в любом месте; берём то, что ближе к концу адреса.
const COUNTRIES: Array<[RegExp, string]> = [
  [/united states|\busa\b|u\.s\.a/i, 'United States'], [/united kingdom|\bu\.?k\.?\b|england|scotland|great britain/i, 'United Kingdom'],
  [/hong kong|香港/i, 'Hong Kong'], [/singapore/i, 'Singapore'], [/t(ü|u)rkiye|turkey/i, 'Türkiye'], [/cyprus/i, 'Cyprus'],
  [/\bchina\b|中国|p\.?r\.?c/i, 'China'], [/taiwan/i, 'Taiwan'], [/japan|日本/i, 'Japan'], [/korea/i, 'South Korea'],
  [/viet\s?nam/i, 'Vietnam'], [/\bindia\b/i, 'India'], [/indonesia/i, 'Indonesia'], [/malaysia/i, 'Malaysia'],
  [/thailand/i, 'Thailand'], [/philippines/i, 'Philippines'], [/pakistan/i, 'Pakistan'], [/israel/i, 'Israel'],
  [/united arab emirates|\buae\b|dubai|abu dhabi/i, 'UAE'], [/saudi arabia/i, 'Saudi Arabia'], [/egypt/i, 'Egypt'],
  [/germany|deutschland/i, 'Germany'], [/france/i, 'France'], [/spain|españa/i, 'Spain'], [/italy|italia/i, 'Italy'],
  [/netherlands|nederland/i, 'Netherlands'], [/belgium/i, 'Belgium'], [/switzerland/i, 'Switzerland'], [/austria/i, 'Austria'],
  [/poland|polska/i, 'Poland'], [/czech/i, 'Czechia'], [/slovakia/i, 'Slovakia'], [/hungary/i, 'Hungary'], [/romania/i, 'Romania'],
  [/bulgaria/i, 'Bulgaria'], [/serbia/i, 'Serbia'], [/croatia/i, 'Croatia'], [/slovenia/i, 'Slovenia'], [/greece/i, 'Greece'],
  [/portugal/i, 'Portugal'], [/ireland/i, 'Ireland'], [/sweden/i, 'Sweden'], [/norway/i, 'Norway'], [/denmark/i, 'Denmark'],
  [/finland/i, 'Finland'], [/estonia/i, 'Estonia'], [/latvia/i, 'Latvia'], [/lithuania/i, 'Lithuania'], [/malta/i, 'Malta'],
  [/luxembourg/i, 'Luxembourg'], [/ukraine|україна/i, 'Ukraine'], [/russia|россия/i, 'Russia'], [/belarus/i, 'Belarus'],
  [/kazakhstan/i, 'Kazakhstan'], [/armenia/i, 'Armenia'], [/georgia(?!\s*\d)/i, 'Georgia'], [/azerbaijan/i, 'Azerbaijan'],
  [/uzbekistan/i, 'Uzbekistan'], [/canada/i, 'Canada'], [/mexico|méxico/i, 'Mexico'], [/brazil|brasil/i, 'Brazil'],
  [/argentina/i, 'Argentina'], [/chile/i, 'Chile'], [/colombia/i, 'Colombia'], [/australia/i, 'Australia'],
  [/new zealand/i, 'New Zealand'], [/south africa/i, 'South Africa'], [/nigeria/i, 'Nigeria'],
];

export function detectCountry(address: string | null | undefined): string | null {
  if (!address) return null;
  let best: { name: string; at: number } | null = null;
  for (const [re, name] of COUNTRIES) {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    for (const m of address.matchAll(new RegExp(re.source, flags))) {
      if (!best || (m.index ?? 0) > best.at) best = { name, at: m.index ?? 0 };
    }
  }
  return best?.name ?? null;
}

/** Блок продавца из раздела «Информация»: тот, где есть фраза про trader или D-U-N-S. */
export function parseTrader(informationItems: any[]): Trader | null {
  for (const item of informationItems) {
    const texts: string[] = (item?.items ?? [])
      .map((x: any) => x?.linkableText?.styledText?.rawText)
      .filter((t: unknown): t is string => typeof t === 'string');
    const statement = texts.find((t) => !t.startsWith('**')) ?? '';
    const pairs = markdownPairs(texts);
    const looksLikeTrader = /trader|händler|commerçant|comerciante|commerciante|handelaar|D-?U-?N-?S/i.test(texts.join(' '));
    if (!looksLikeTrader) continue;
    const trader: Trader = {
      isTrader: pairs.length > 0 || !/not identified|nicht als|pas identifié|no se ha identificado|non si è identificato|niet geïdentificeerd/i.test(statement),
      duns: null, address: null, country: null, phone: null, email: null,
    };
    for (const [label, value] of pairs) {
      if (/D-?U-?N-?S/i.test(label)) trader.duns = value.replace(/\D/g, '') || null;
      else if (!trader.email && normalizeEmail(value)) trader.email = normalizeEmail(value);
      else if (!trader.phone && PHONE.test(value)) trader.phone = value;
      else if (!trader.address && value.includes('\n')) trader.address = value.replace(/\n+/g, ', ');
    }
    if (!trader.duns) {
      const duns = pairs.find(([, v]) => /^\d{9}$/.test(v.trim()));
      if (duns) trader.duns = duns[1].trim();
    }
    trader.country = detectCountry(trader.address);
    return trader;
  }
  return null;
}

/** Ссылки и блок продавца из встроенного JSON страницы (script#serialized-server-data). */
export function parseAppStorePage(html: string): AppStorePage {
  const raw = cheerio.load(html)('script#serialized-server-data').html();
  if (!raw) throw new AppStoreLayoutError('нет script#serialized-server-data — сменилась вёрстка App Store');
  const shelf = JSON.parse(raw)?.data?.[0]?.data?.shelfMapping;
  if (!shelf) throw new AppStoreLayoutError('нет shelfMapping в данных страницы App Store');

  // подписи ссылок локализованы, сайт и поддержку различаем по иконке
  const links: any[] = shelf.description?.items?.[0]?.developerLinks ?? [];
  const byIcon = (icon: string) => links.find((l) => l?.systemImageName === icon)?.clickAction?.url ?? null;
  const substrings = shelf.privacyHeader?.items?.[0]?.bodyText?.linkedSubstrings ?? {};
  const privacy = Object.values<any>(substrings).find((v) => typeof v?.url === 'string')?.url ?? null;
  const seeAll = JSON.stringify(shelf.moreByDeveloper?.seeAllAction ?? {}).match(/https:\/\/apps\.apple\.com\/[a-z]{2}\/developer\/[^"]+/);

  return {
    website: byIcon('safari'),
    supportUrl: byIcon('questionmark.circle'),
    privacyUrl: privacy,
    trader: parseTrader(shelf.information?.items ?? []),
    developerUrl: seeAll?.[0] ?? null,
  };
}

/**
 * Страница приложения в App Store: сначала ирландский стор (ЕС, английский — есть блок продавца),
 * если там приложения нет — стор страны, где оно в чарте (там только ссылки).
 */
export async function appStorePage(trackId: string, country: string): Promise<AppStorePage> {
  for (const cc of [...new Set(['ie', country])]) {
    // apps.apple.com отвечает 429 на частые запросы — ждём дольше
    const page = await fetchPage(`https://apps.apple.com/${cc}/app/id${trackId}`, STORE_RETRY);
    if (page.status === 404) continue;
    if (!page.html) throw new Error(`App Store HTTP ${page.status}`);
    return parseAppStorePage(page.html);
  }
  return EMPTY;
}

export interface PlayDeveloper {
  name: string | null;      // юрлицо или имя
  email: string | null;     // почта аккаунта разработчика
  address: string | null;
  phone: string | null;
}

export interface PlayApp {
  playUrl: string;
  packageId: string;
  supportEmail: string | null;
  website: string | null;
  developer: PlayDeveloper | null;
  developerPageUrl: string | null;  // все приложения разработчика
}

/** Текстовые узлы страницы по порядку — классы в разметке Google Play обфусцированы и меняются. */
function textNodes(html: string): string[] {
  const $ = cheerio.load(html);
  $('script, style, noscript, template').remove();
  const out: string[] = [];
  $('body').find('*').addBack().contents().each((_, node) => {
    if (node.type === 'text') {
      const t = node.data.replace(/ /g, ' ').trim();
      if (t) out.push(t);
    }
  });
  return out;
}

// Следующий раздел страницы или служебные иконки Material — конец блока о разработчике.
const PLAY_SECTION_END = /^(Similar (games|apps)|More by\b|Ratings and reviews|Data safety|What's new|App support|Flag as inappropriate|arrow_forward|expand_more|star$)/i;

/** «About the developer»: имя, почта, адрес, телефон — в таком порядке, но любые поля могут отсутствовать. */
export function parsePlayDeveloper(html: string): PlayDeveloper | null {
  const nodes = textNodes(html);
  const start = nodes.findIndex((t) => /^About the developer$/i.test(t));
  if (start < 0) return null;
  const dev: PlayDeveloper = { name: null, email: null, address: null, phone: null };
  const address: string[] = [];
  for (const t of nodes.slice(start + 1, start + 12)) {
    if (PLAY_SECTION_END.test(t)) break;
    const email = normalizeEmail(t);
    if (email) dev.email ??= email;
    else if (PHONE.test(t)) {
      dev.phone ??= t;
      break; // телефон — последнее поле блока
    }
    else if (!dev.name && !dev.email && address.length === 0) dev.name = t;
    else address.push(t);
  }
  dev.address = address.length ? address.join(', ').replace(/\s*\n\s*/g, ', ') : null;
  return dev.name || dev.email || dev.address || dev.phone ? dev : null;
}

export function parsePlayApp(html: string, packageId: string): PlayApp {
  const $ = cheerio.load(html);
  const devHref = $('a[href*="/store/apps/dev"]').first().attr('href') ?? null;
  const website = $('a[aria-label^="Website "]').first().attr('href') ?? null;
  return {
    playUrl: `https://play.google.com/store/apps/details?id=${packageId}`,
    packageId,
    supportEmail: firstMailto(html),
    website: website && /^https?:\/\//i.test(website) ? website : null,
    developer: parsePlayDeveloper(html),
    developerPageUrl: devHref ? new URL(devHref, 'https://play.google.com').href.replace(/&hl=[^&]*|&gl=[^&]*/g, '') : null,
  };
}

/** Варианты Android-пакета из iOS bundleId: часто совпадает целиком или без сегмента ios/iphone. */
export function packageCandidates(bundleId: string): string[] {
  const parts = bundleId.split('.');
  const stripped = parts
    .filter((p) => !/^(ios|iphone|ipad|iosapp)$/i.test(p))
    .map((p) => p.replace(/[-_](ios|iphone|ipad)$/i, ''))
    .join('.');
  return [...new Set([bundleId, stripped])].filter((p) => /^[A-Za-z][\w]*(\.[A-Za-z0-9_]+)+$/.test(p));
}

function firstWord(name: string): string {
  return (name.toLowerCase().match(/[\p{L}\p{N}]{3,}/u)?.[0] ?? '').trim();
}

/** Карточка Google Play по iOS bundleId. Для изменённого пакета сверяем название, чтобы не взять однофамильца. */
export async function googlePlayApp(bundleId: string, appName: string): Promise<PlayApp | null> {
  for (const pkg of packageCandidates(bundleId)) {
    const page = await fetchPage(`https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en&gl=us`, STORE_RETRY);
    if (page.status === 404 || !page.html) continue;
    if (pkg !== bundleId) {
      const title = cheerio.load(page.html)('title').text().toLowerCase();
      const word = firstWord(appName);
      if (!word || !title.includes(word)) continue;
    }
    return parsePlayApp(page.html, pkg);
  }
  return null;
}

export interface PlayListing {
  packageId: string;
  name: string;
}

/** Приложения разработчика со страницы developer?id=… / dev?id=… (Google Play показывает до ~100). */
export function parsePlayDeveloperPage(html: string): PlayListing[] {
  const $ = cheerio.load(html);
  const out = new Map<string, PlayListing>();
  $('a[href*="/store/apps/details?id="]').each((_, el) => {
    const id = ($(el).attr('href') ?? '').match(/[?&]id=([\w.]+)/)?.[1];
    if (!id || out.has(id)) return;
    const name = $(el).find('span').first().text().replace(/ /g, ' ').trim();
    out.set(id, { packageId: id, name: name || id });
  });
  return [...out.values()];
}

export async function googlePlayDeveloperApps(developerPageUrl: string): Promise<PlayListing[]> {
  const url = new URL(developerPageUrl);
  if (url.hostname !== 'play.google.com') return [];
  url.searchParams.set('hl', 'en');
  url.searchParams.set('gl', 'us');
  const page = await fetchPage(url.href, STORE_RETRY);
  return page.html ? parsePlayDeveloperPage(page.html) : [];
}
