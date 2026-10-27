import * as cheerio from 'cheerio';
import { fetchPage } from './safe-fetch.js';
import { baseDomain, extractEmails, type EmailSource, type FoundEmail } from './emails.js';
import { extractLinkedIn, type LinkedInLink } from './linkedin.js';

/**
 * Обход сайта разработчика: главная, затем страницы, где обычно лежат адреса людей, —
 * контакты, «о нас», команда, импрессум (в DE/AT/CH там директор и его почта), пресса,
 * вакансии. Плюс страницы поддержки и политики из стора. Сайты за защитой от ботов
 * (403 от Cloudflare и т.п.) пропускаются — их не обходим.
 */

// Соцсети и сторы не дают почту обычным GET — не тратим на них запросы.
const SKIP_HOSTS =
  /(^|\.)(facebook|instagram|twitter|x|linkedin|tiktok|youtube|discord|t|telegram|apple|google|notion|medium)\.(com|me|so|site|gg)$/i;

// Ссылки с главной, которые стоит открыть: по адресу или подписи.
const USEFUL_PAGE =
  /contact|kontakt|contato|contacto|about|ueber-uns|uber-uns|über|team|people|leadership|founders|company|impressum|imprint|legal-notice|mentions-legales|press|media-kit|careers|jobs|partners|business/i;

// Если на главной таких ссылок нет — пробуем типовые адреса.
const FALLBACK_PATHS = ['/contact', '/contact-us', '/about', '/about-us', '/impressum', '/team'];

const MAX_SITE_PAGES = 7;

export interface SiteResult {
  emails: FoundEmail[];
  linkedin: LinkedInLink[];   // только со страниц на домене разработчика
  websiteOk: boolean | null;  // главная открылась; null — сайта нет
  pages: number;
}

function sameSite(url: string, domain: string): boolean {
  try {
    return baseDomain(url) === domain;
  } catch {
    return false;
  }
}

/** Ссылки на полезные страницы того же сайта, по порядку появления. */
export function usefulLinks(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html);
  const domain = baseDomain(pageUrl);
  const out: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const label = $(el).text().trim().slice(0, 60);
    if (!USEFUL_PAGE.test(href) && !USEFUL_PAGE.test(label)) return;
    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol) || !sameSite(url.href, domain)) return;
    if (/\.(pdf|jpe?g|png|zip|mp4)$/i.test(url.pathname)) return;
    url.hash = '';
    if (!out.includes(url.href) && url.href !== pageUrl) out.push(url.href);
  });
  return out;
}

export async function crawlDeveloperSite(
  website: string | null,
  extra: Array<[string | null, EmailSource]> = [],
): Promise<SiteResult & { errors: string[] }> {
  const emails: FoundEmail[] = [];
  const linkedin: LinkedInLink[] = [];
  const errors: string[] = [];
  const visited = new Set<string>();
  let websiteOk: boolean | null = website ? false : null;
  const devDomain = website ? baseDomain(website) : null;

  const visit = async (url: string, source: EmailSource): Promise<string | null> => {
    if (visited.has(url)) return null;
    visited.add(url);
    try {
      if (SKIP_HOSTS.test(new URL(url).hostname)) return null;
      const page = await fetchPage(url);
      for (const email of extractEmails(page.html)) emails.push({ email, source });
      // LinkedIn — только со страниц самого разработчика: поддержка и политика часто лежат на чужих
      // платформах (Zendesk, Termly…), и в их подвале — LinkedIn самой платформы
      if (devDomain && sameSite(page.url, devDomain)) linkedin.push(...extractLinkedIn(page.html));
      return page.html || null;
    } catch (e) {
      errors.push(`${source}: ${(e as Error).message}`);
      return null;
    }
  };

  // поддержка и политика из стора — там чаще всего адрес
  for (const [url, source] of extra) if (url) await visit(url, source);

  if (website) {
    const home = await visit(website, 'website');
    websiteOk = home !== null;
    if (home) {
      let next = usefulLinks(home, website);
      if (next.length === 0) next = FALLBACK_PATHS.map((p) => new URL(p, website).href);
      for (const url of next.slice(0, MAX_SITE_PAGES)) await visit(url, 'website');
    }
  }

  return { emails, linkedin, websiteOk, pages: visited.size, errors };
}
