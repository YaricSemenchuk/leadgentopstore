import { appStorePage, googlePlayApp, googlePlayDeveloperApps, type PlayDeveloper, type PlayListing, type Trader } from './store-pages.js';
import { crawlDeveloperSite } from './site.js';
import { baseDomain, buildCompanyEmails, isFreeMailDomain, type CompanyEmails, type EmailPattern, type FoundEmail, type Person } from './emails.js';
import { looksLikePerson, type LinkedInLink } from './linkedin.js';

/**
 * Сбор контактов на уровне компании (разработчика), а не приложения: у компании может быть
 * несколько приложений в чартах, а сайт, люди и почта у них общие. Источники — сторы
 * (App Store ЕС, Google Play), сайт разработчика; LinkedIn и Hunter добавляются отдельными
 * шагами (они платные/лимитированные) и пересчитывают почту через finalizeEmails.
 */

/** Версия сбора: при росте компании со старой версией перепроверяются (v3 — уровень компаний). */
export const COMPANY_CONTACTS_VERSION = 3;

export interface CompanyApp {
  trackId: string;
  name: string;
  bundleId: string | null;
  sellerUrl: string | null;
  country: string;           // сторфронт, где приложение точно есть
}

export interface CompanyInput {
  id: number;
  name: string;
  apps: CompanyApp[];        // лучшие первыми
}

export type CompanyKind = 'company' | 'individual';

export interface CompanyContacts {
  kind: CompanyKind;
  trader: Trader | null;
  playDeveloper: PlayDeveloper | null;
  website: string | null;
  websiteOk: boolean | null;
  supportUrl: string | null;
  privacyUrl: string | null;
  playDeveloperUrl: string | null;
  androidApps: PlayListing[] | null;     // null — в Google Play не нашли
  appPlayUrls: Array<{ trackId: string; playUrl: string }>;
  emailsRaw: FoundEmail[];
  linkedinSite: LinkedInLink | null;     // ссылка с сайта разработчика
  errors: string[];
}

/**
 * Компания или частное лицо. D-U-N-S и статус торговца в App Store ЕС — компания (Apple проверяет
 * юрлицо); иначе судим по названию: 2–3 слова без признаков фирмы — человек.
 */
export function companyKind(name: string, trader: Trader | null): CompanyKind {
  if (trader?.duns || trader?.isTrader) return 'company';
  return looksLikePerson(name) ? 'individual' : 'company';
}

// Сколько приложений компании проверять в Google Play: у разных приложений бывает разная почта поддержки.
const PLAY_APPS_PER_COMPANY = 3;

export async function enrichCompanyContacts(input: CompanyInput): Promise<CompanyContacts> {
  const errors: string[] = [];
  const emails: FoundEmail[] = [];
  const main = input.apps[0];

  // 1. App Store: ссылки и блок продавца (ЕС) — по лучшему приложению
  let store = { website: null as string | null, supportUrl: null as string | null, privacyUrl: null as string | null, trader: null as Trader | null };
  if (main) {
    try {
      store = await appStorePage(main.trackId, main.country);
    } catch (e) {
      errors.push(`app store: ${(e as Error).message}`);
    }
  }
  if (store.trader?.email) emails.push({ email: store.trader.email, source: 'app_store_trader' });

  // 2. Google Play: карточки до трёх приложений, затем страница разработчика со всеми приложениями
  let playDeveloper: PlayDeveloper | null = null;
  let playDeveloperUrl: string | null = null;
  let playWebsite: string | null = null;
  const appPlayUrls: CompanyContacts['appPlayUrls'] = [];
  for (const app of input.apps.filter((a) => a.bundleId).slice(0, PLAY_APPS_PER_COMPANY)) {
    try {
      const play = await googlePlayApp(app.bundleId!, app.name);
      if (!play) continue;
      appPlayUrls.push({ trackId: app.trackId, playUrl: play.playUrl });
      if (play.supportEmail) emails.push({ email: play.supportEmail, source: 'google_play' });
      if (play.developer?.email) emails.push({ email: play.developer.email, source: 'play_developer' });
      playDeveloper ??= play.developer;
      playDeveloperUrl ??= play.developerPageUrl;
      playWebsite ??= play.website;
    } catch (e) {
      errors.push(`google play: ${(e as Error).message}`);
    }
  }
  let androidApps: PlayListing[] | null = null;
  if (playDeveloperUrl) {
    try {
      androidApps = await googlePlayDeveloperApps(playDeveloperUrl);
    } catch (e) {
      errors.push(`google play developer: ${(e as Error).message}`);
    }
  }
  if (!androidApps && appPlayUrls.length) androidApps = appPlayUrls.map((a) => ({ packageId: a.playUrl.split('id=')[1], name: '' }));

  // 3. Сайт разработчика: главная и страницы с контактами, плюс поддержка и политика
  const website = store.website ?? main?.sellerUrl ?? playWebsite ?? null;
  const site = await crawlDeveloperSite(website, [
    [store.supportUrl, 'support_page'],
    [store.privacyUrl, 'privacy_policy'],
  ]);
  errors.push(...site.errors);
  emails.push(...site.emails);

  // одинаковый адрес с разных страниц сайта — одна запись на источник
  const seen = new Set<string>();
  const unique = emails.filter((e) => !seen.has(`${e.email}|${e.source}`) && seen.add(`${e.email}|${e.source}`));

  return {
    kind: companyKind(input.name, store.trader),
    trader: store.trader,
    playDeveloper,
    website,
    websiteOk: site.websiteOk,
    supportUrl: store.supportUrl,
    privacyUrl: store.privacyUrl,
    playDeveloperUrl,
    androidApps,
    appPlayUrls,
    emailsRaw: unique,
    linkedinSite: site.linkedin.find((l) => l.kind === 'company') ?? site.linkedin[0] ?? null,
    errors,
  };
}

// Платформы поддержки и политик: их домен — не домен разработчика.
const PLATFORM_DOMAINS =
  /(^|\.)(zendesk|freshdesk|zohodesk|helpshift|intercom|helpscoutdocs|notion|termly|iubenda|freeprivacypolicy|privacypolicies|app-privacy-policy|firebaseapp|github|gitlab|google|apple|wixsite|blogspot|wordpress|weebly|carrd|webflow|vercel|netlify|herokuapp|feishu|larksuite|tilda|sites|linktr|itch|medium|substack|gitbook)\.[a-z.]+$/;

/** Домены разработчика: сайт, поддержка и политика, кроме платформ (Zendesk, Termly, Notion…). */
export function developerDomains(urls: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    try {
      const d = baseDomain(new URL(u).hostname);
      if (!PLATFORM_DOMAINS.test(d) && !isFreeMailDomain(d)) out.add(d);
    } catch {
      /* битый URL */
    }
  }
  return [...out];
}

export interface EmailInputs {
  name: string;
  kind: CompanyKind;
  website: string | null;
  supportUrl: string | null;
  privacyUrl: string | null;
  emailsRaw: FoundEmail[];
  hunterEmails: FoundEmail[];
  hunterPattern: EmailPattern | null;
  people: Person[];
}

/** Итоговая почта компании из всего собранного: сторы, сайт, Hunter, люди из LinkedIn. */
export function finalizeEmails(i: EmailInputs): CompanyEmails {
  return buildCompanyEmails(
    [...i.emailsRaw, ...i.hunterEmails],
    {
      company: i.name,
      domains: developerDomains([i.website, i.supportUrl, i.privacyUrl]),
      people: i.people,
      individual: i.kind === 'individual',
    },
    i.hunterPattern,
  );
}
