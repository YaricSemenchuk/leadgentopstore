import * as cheerio from 'cheerio';
import { fetchPage } from './safe-fetch.js';
import { baseDomain, extractEmails, firstMailto, rankEmails, type EmailSource, type FoundEmail } from './emails.js';
import { extractLinkedIn, type LinkedInKind, type LinkedInLink } from './linkedin.js';

export interface Contacts {
  website: string | null;
  supportUrl: string | null;
  privacyUrl: string | null;
  playUrl: string | null;
  email: string | null;
  emailSource: EmailSource | null;
  emails: string[];          // запасные адреса
  emailPersonal: boolean;    // бесплатный ящик — вероятно, частное лицо
  linkedinUrl: string | null;          // со страниц самого разработчика
  linkedinKind: LinkedInKind | null;   // компания или личный профиль
  errors: string[];          // что не удалось проверить (для лога)
}

/** Версия сбора контактов: при росте лиды со старой версией перепроверяются (v2 — LinkedIn). */
export const CONTACTS_VERSION = 2;

export interface EnrichInput {
  trackId: string;
  name: string;
  bundleId?: string | null;
  sellerUrl?: string | null;
  country: string;           // сторфронт, где приложение точно есть
}

export class AppStoreLayoutError extends Error {}

const STORE_RETRY = { attempts: 4, baseDelayMs: 4_000, timeoutMs: 25_000 };

interface StoreLinks {
  website: string | null;
  supportUrl: string | null;
  privacyUrl: string | null;
}

/**
 * Ссылки разработчика со страницы App Store. Берём из встроенного JSON
 * (script#serialized-server-data), а не из разметки. Подписи ссылок локализованы,
 * поэтому сайт и поддержку различаем по иконке (safari / questionmark.circle).
 */
export async function appStoreLinks(trackId: string, country: string): Promise<StoreLinks> {
  // apps.apple.com отвечает 429 на частые запросы — ждём дольше
  const page = await fetchPage(`https://apps.apple.com/${country}/app/id${trackId}`, STORE_RETRY);
  if (page.status === 404) return { website: null, supportUrl: null, privacyUrl: null };
  if (!page.html) throw new Error(`App Store HTTP ${page.status}`);

  const raw = cheerio.load(page.html)('script#serialized-server-data').html();
  if (!raw) throw new AppStoreLayoutError('нет script#serialized-server-data — сменилась вёрстка App Store');
  const shelf = JSON.parse(raw)?.data?.[0]?.data?.shelfMapping;
  if (!shelf) throw new AppStoreLayoutError('нет shelfMapping в данных страницы App Store');

  const links: any[] = shelf.description?.items?.[0]?.developerLinks ?? [];
  const byIcon = (icon: string) =>
    links.find((l) => l?.systemImageName === icon)?.clickAction?.url ?? null;
  const substrings = shelf.privacyHeader?.items?.[0]?.bodyText?.linkedSubstrings ?? {};
  const privacy = Object.values<any>(substrings).find((v) => typeof v?.url === 'string')?.url ?? null;

  return { website: byIcon('safari'), supportUrl: byIcon('questionmark.circle'), privacyUrl: privacy };
}

/** Варианты Android-пакета из iOS bundleId: часто совпадает целиком или без сегмента ios/iphone. */
function packageCandidates(bundleId: string): string[] {
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

/** Карточка Google Play по bundleId: почта разработчика из блока поддержки. */
async function googlePlay(bundleId: string, appName: string): Promise<{ playUrl: string; email: string | null } | null> {
  for (const pkg of packageCandidates(bundleId)) {
    const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en&gl=us`;
    const page = await fetchPage(url, STORE_RETRY);
    if (page.status === 404 || !page.html) continue;
    // Для изменённого пакета убеждаемся, что это то же приложение, а не однофамилец.
    if (pkg !== bundleId) {
      const title = cheerio.load(page.html)('title').text().toLowerCase();
      const word = firstWord(appName);
      if (!word || !title.includes(word)) continue;
    }
    return { playUrl: `https://play.google.com/store/apps/details?id=${pkg}`, email: firstMailto(page.html) };
  }
  return null;
}

// Соцсети и сторы не дают почту обычным GET — не тратим на них запросы.
const SKIP_HOSTS =
  /(^|\.)(facebook|instagram|twitter|x|linkedin|tiktok|youtube|discord|t|telegram|apple|google|notion|medium)\.(com|me|so|site|gg)$/i;

/** Собирает публичные контакты разработчика приложения. Ошибки отдельных источников не роняют сбор. */
export async function enrichContacts(app: EnrichInput): Promise<Contacts> {
  const errors: string[] = [];
  let links: StoreLinks = { website: null, supportUrl: null, privacyUrl: null };
  try {
    links = await appStoreLinks(app.trackId, app.country);
  } catch (e) {
    errors.push(`app store: ${(e as Error).message}`);
  }
  const website = links.website ?? app.sellerUrl ?? null;
  const found: FoundEmail[] = [];

  let playUrl: string | null = null;
  if (app.bundleId) {
    try {
      const play = await googlePlay(app.bundleId, app.name);
      if (play) {
        playUrl = play.playUrl;
        if (play.email) found.push({ email: play.email, source: 'google_play' });
      }
    } catch (e) {
      errors.push(`google play: ${(e as Error).message}`);
    }
  }

  const domains = [website, links.supportUrl, links.privacyUrl].filter((u): u is string => !!u);
  const pages: Array<[string, EmailSource]> = [];
  const seen = new Set<string>();
  const queue = (u: string | null, source: EmailSource) => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    try {
      if (SKIP_HOSTS.test(new URL(u).hostname)) return;
    } catch {
      return;
    }
    pages.push([u, source]);
  };
  queue(links.supportUrl, 'support_page');
  queue(links.privacyUrl, 'privacy_policy');
  queue(website, 'website');
  if (website) {
    try {
      queue(new URL('/contact', website).href, 'website');
    } catch {
      /* битый URL сайта — пропускаем */
    }
  }

  // Почта из Google Play уже лучший вариант; иначе обходим страницы, пока не найдём адрес на домене разработчика.
  const good = () => {
    const best = rankEmails(found, domains).best;
    return !!best && (best.source === 'google_play' || domains.some((d) => baseDomain(d) === baseDomain(best.email.split('@')[1])));
  };
  // LinkedIn берём только со страниц на домене сайта разработчика: поддержка и политика часто
  // лежат на чужих платформах (Zendesk, Termly…), и в их подвале — LinkedIn самой платформы.
  const devDomain = website ? baseDomain(website) : null;
  const linkedin: LinkedInLink[] = [];
  const fetched = new Set<string>();
  const visit = async (url: string, source: EmailSource) => {
    fetched.add(url);
    try {
      const page = await fetchPage(url);
      for (const email of extractEmails(page.html)) found.push({ email, source });
      if (devDomain && baseDomain(page.url) === devDomain) linkedin.push(...extractLinkedIn(page.html));
    } catch (e) {
      errors.push(`${source}: ${(e as Error).message}`);
    }
  };
  for (const [url, source] of pages) {
    if (good()) break;
    await visit(url, source);
  }
  // LinkedIn обычно в шапке или подвале главной: если почта нашлась раньше, заглянем и туда
  if (linkedin.length === 0 && website && pages.some(([u]) => u === website) && !fetched.has(website)) {
    await visit(website, 'website');
  }

  const li = linkedin.find((l) => l.kind === 'company') ?? linkedin[0] ?? null;
  const ranked = rankEmails(found, domains);
  return {
    website,
    supportUrl: links.supportUrl,
    privacyUrl: links.privacyUrl,
    playUrl,
    email: ranked.best?.email ?? null,
    emailSource: ranked.best?.source ?? null,
    emails: ranked.others,
    emailPersonal: ranked.personal,
    linkedinUrl: li?.url ?? null,
    linkedinKind: li?.kind ?? null,
    errors,
  };
}
