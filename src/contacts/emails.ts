import * as cheerio from 'cheerio';
import { asciiFold, matchPattern, mentionsName, nameParts, renderPattern, type NameParts } from './names.js';

/**
 * Откуда адрес. Сторы и Hunter дают адреса самого разработчика; со страниц сайта, поддержки и
 * политики берём только адреса на домене разработчика или ролевые (юрфирмы, GDPR-представители
 * и регуляторы из политик отсекаются).
 */
export type EmailSource =
  | 'google_play'        // «Support email» в карточке Google Play
  | 'play_developer'     // «About the developer» в Google Play — почта аккаунта разработчика
  | 'app_store_trader'   // блок продавца в App Store ЕС (DSA)
  | 'support_page'
  | 'privacy_policy'
  | 'website'
  | 'hunter';

const STORE_SOURCES = new Set<EmailSource>(['google_play', 'play_developer', 'app_store_trader', 'hunter']);

export interface FoundEmail {
  email: string;
  source: EmailSource;
  /** имя и должность, если источник их знает (Hunter) */
  person?: string | null;
  title?: string | null;
}

/** personal — адрес конкретного человека; role — общий ящик (support@, info@, studio@). */
export type EmailKind = 'personal' | 'role';

export interface CompanyEmail {
  email: string;
  kind: EmailKind;
  free: boolean;             // gmail, outlook, qq…
  sources: EmailSource[];
  person: string | null;     // чей адрес, если известно
  title: string | null;
  guessed: boolean;          // составлен по шаблону домена, не проверен
}

export interface Person {
  name: string;
  title: string | null;
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;
const EMAIL_EXACT = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/;

const JUNK_LOCAL = /(^|[._-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?)([._-]|$)/;
const JUNK_DOMAIN =
  /(^|\.)(example\.(com|org|net)|domain\.com|email\.com|yourdomain\.com|sentry\.io|wixpress\.com|sentry-next\.wixpress\.com)$|\.gov(\.[a-z]{2})?$/;
const ASSET = /\.(png|jpe?g|gif|webp|svg|css|js)$/;

const FREE_MAIL =
  /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|gmx|mail|yandex|ya|proton|protonmail|qq|163|126|naver|hanmail|daum|foxmail|sina|rambler|zoho|seznam|wp|o2|web|libero|orange|free)\.[a-z.]+$/;

/** Бесплатный почтовый домен (gmail, outlook, qq…): по нему не понять, чья это компания. */
export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL.test(domain.toLowerCase());
}

// Ролевые слова. Длинные ищем подстрокой («fingerrush.customerservice», «aos_support»),
// короткие — только целым словом: «mail» внутри «ismail», «dev» внутри «devon» — это имена.
const ROLE_SUBSTR =
  /support|supoprt|suport|contact|contato|team|engineer|technolog|software|digital|network|interactive|entertain|mobile|contacto|kontakt|service|servicio|customer|developer|marketing|partner|business|feedback|privacy|publish|career|recruit|helpdesk|enquir|inquir|office|admin|studio|hello|games|gaming|billing|account|finance|payment|invoice|legal|complian|newsletter|webmaster|suporte|soporte|atendimento|cooperat|advertis|official|operation|appstore|android|security|copyright|licens|affiliate|community|booking|reception|question|request|report|notification|subscription|social|global|general|people|welcome|investor/;
const ROLE_WORD = new Set([
  'info', 'help', 'team', 'hi', 'hey', 'hola', 'ciao', 'hallo', 'bonjour', 'sales', 'pr', 'press', 'media', 'news', 'jobs',
  'job', 'hr', 'bd', 'biz', 'ads', 'ua', 'growth', 'mail', 'email', 'dev', 'devs', 'app', 'apps', 'ios', 'game', 'play',
  'ask', 'data', 'qa', 'test', 'beta', 'ir', 'ops', 'cs', 'care', 'store', 'shop', 'order', 'orders', 'hq', 'dpo', 'gdpr',
  'abuse', 'bug', 'bugs', 'design', 'content', 'product', 'online', 'corp', 'group', 'staff', 'invest', 'love', 'us', 'we',
  'all', 'mobile', 'web', 'site', 'pay', 'ad', 'tech', 'it', 'kefu', 'service', 'events', 'event', 'marketing', 'contact',
  'office', 'admin', 'sale', 'player', 'players', 'fans', 'feedback', 'apple', 'google', 'facebook',
  'labs', 'lab', 'soft', 'studios', 'ltd', 'llc', 'inc', 'company', 'co', 'official', 'store',
]);
// Ящик руководителя — адрес конкретного человека, пусть и без имени.
const DECISION_LOCAL = /^(ceo|founder|cofounder|co-founder|owner|president|cmo|coo|cto|md|boss)\d*$/;

function isRoleLocal(local: string): boolean {
  if (ROLE_SUBSTR.test(local)) return true;
  return local.split(/[._+\-\d]+/).some((w) => ROLE_WORD.has(w));
}

/** Слова бренда/юрлица от 4 букв: «fusedelaware@» у Fuse Entertainment — ящик компании, не человека. */
function brandWords(company: string | null, domains: string[]): string[] {
  const words = new Set<string>();
  for (const w of asciiFold(company ?? '').split(/[^a-z0-9]+/)) if (w.length >= 4) words.add(w);
  for (const d of domains) {
    const label = baseDomain(d).split('.')[0];
    for (const w of label.split(/[^a-z0-9]+/)) if (w.length >= 4) words.add(w);
  }
  // типовые слова юрлиц — не бренд
  for (const w of ['limited', 'games', 'studio', 'studios', 'technology', 'technologies', 'entertainment', 'software', 'mobile', 'digital', 'interactive', 'media', 'group', 'apps', 'labs', 'company', 'global', 'international', 'yazilim', 'anonim', 'sirketi']) words.delete(w);
  return [...words];
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'ac', 'edu', 'ne', 'or', 'go', 'gov']);

/** Регистрируемый домен без поддоменов: help.plaud.ai → plaud.ai, foo.co.kr → foo.co.kr. */
export function baseDomain(hostOrUrl: string): string {
  let host = hostOrUrl;
  try {
    host = new URL(hostOrUrl).hostname;
  } catch {
    /* уже хост */
  }
  const parts = host.toLowerCase().replace(/^www\./, '').split('.');
  const tld = parts[parts.length - 1];
  if (parts.length > 2 && tld.length === 2 && SECOND_LEVEL.has(parts[parts.length - 2])) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase().replace(/^mailto:/, '').replace(/[.,;:]+$/, '');
  if (!EMAIL_EXACT.test(e) || ASSET.test(e) || e.includes('..')) return null;
  const [local, domain] = e.split('@');
  if (JUNK_LOCAL.test(local) || JUNK_DOMAIN.test(domain)) return null;
  return e;
}

/** @, > и т.п. из JSON внутри страницы → обычные символы. */
function unescapeJson(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Адреса со страницы: ссылки mailto:, данные во встроенных скриптах (сайты на Next.js и
 * т.п. держат контент только там) и видимый текст. Текст собираем по узлам через пробел,
 * иначе соседние элементы склеиваются: «x@a.net» + «Address» → «x@a.netaddress».
 * Простая маскировка «name [at] domain [dot] com» тоже распознаётся.
 */
export function extractEmails(html: string): string[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  const out = new Set<string>();
  const add = (raw: string) => {
    const e = normalizeEmail(raw);
    if (e) out.add(e);
  };

  $('a[href^="mailto:"], a[href^="MAILTO:"]').each((_, el) => {
    const href = safeDecode($(el).attr('href') ?? '').replace(/^mailto:/i, '');
    for (const part of href.split('?')[0].split(',')) add(part);
  });

  $('script').each((_, el) => {
    const code = $(el).html() ?? '';
    if (!code.includes('@') && !code.includes('\\u0040')) return;
    for (const m of unescapeJson(code).matchAll(EMAIL)) add(m[0]);
  });

  $('script, style, noscript, template').remove();
  const texts: string[] = [];
  $('body').find('*').addBack().contents().each((_, node) => {
    if (node.type === 'text') texts.push(node.data);
  });
  const text = texts.join(' ');
  for (const m of text.matchAll(EMAIL)) add(m[0]);
  const deobfuscated = text.replace(/\s*[[(]\s*at\s*[\])]\s*/gi, '@').replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, '.');
  if (deobfuscated !== text) for (const m of deobfuscated.matchAll(EMAIL)) add(m[0]);

  return [...out];
}

/** Первый mailto: на странице Google Play — это контакт разработчика из блока «App support». */
export function firstMailto(html: string): string | null {
  const $ = cheerio.load(html);
  const href = $('a[href^="mailto:"]').first().attr('href');
  return href ? normalizeEmail(safeDecode(href).split('?')[0]) : null;
}

export interface EmailContext {
  company: string | null;     // юрлицо разработчика
  domains: string[];          // сайт, поддержка, политика — регистрируемые домены разработчика
  people: Person[];           // люди компании (LinkedIn, Hunter)
  individual: boolean;        // разработчик — частное лицо: его gmail — личный адрес
}

/** Человек, чей это адрес: по шаблону имени или по имени внутри адреса. */
function ownerOf(local: string, people: Array<Person & { parts: NameParts }>): (Person & { pattern: string | null }) | null {
  for (const p of people) {
    const pattern = matchPattern(local, p.parts);
    if (pattern) return { ...p, pattern };
  }
  for (const p of people) if (mentionsName(local, p.parts)) return { ...p, pattern: null };
  return null;
}

/** Личный адрес или общий ящик. Имя человека в адресе — личный, ролевое слово или бренд — общий. */
export function classifyEmail(email: string, ctx: Pick<EmailContext, 'company' | 'domains' | 'individual'>): EmailKind {
  const [local, domain] = email.split('@');
  const free = isFreeMailDomain(domain);
  if (DECISION_LOCAL.test(local)) return 'personal';
  // gmail частного разработчика — его собственный ящик, как бы он ни назывался
  if (free && ctx.individual) return 'personal';
  if (isRoleLocal(local)) return 'role';
  // бренд в адресе — ящик компании («fusedelaware@», «studioname.games@gmail.com»)
  if (brandWords(ctx.company, ctx.domains).some((w) => local.includes(w))) return 'role';
  if (free) return 'personal';
  // похоже на имя: буквы с точкой/дефисом/подчёркиванием, не длиннее трёх частей
  const letters = local.replace(/[._-]/g, '');
  return /^[a-z][a-z'-]*([._-][a-z][a-z'-]*){0,2}\d{0,2}$/.test(local) && letters.length >= 3 && letters.length <= 30
    ? 'personal'
    : 'role';
}

// Чем ближе общий ящик к тому, кто решает о закупке трафика, тем выше.
const ROLE_RANKS: Array<[RegExp, number]> = [
  [/(^|[._-])(partners?|partnerships?|bd|biz|business|marketing|ads|advertising|ua|growth|media|pr|press|publishing|hello|hi)([._-]|$)/, 3],
  [/(^|[._-])(contact|info|team|office|general|enquiries|inquiries|mail|developer|dev)([._-]|$)/, 2],
  [/(^|[._-])(support|help|service|feedback|cs|care|customer)([._-]|$)/, 1],
  // юридические ящики — последний вариант
  [/(^|[._-])(privacy|dpo|legal|gdpr|compliance|abuse|security|dmca|copyright|data)([._-]|$)/, -1],
];

function roleScore(local: string): number | null {
  for (const [re, score] of ROLE_RANKS) if (re.test(local)) return score;
  return null;
}

export interface EmailPattern {
  pattern: string;            // {first}.{last}
  domain: string;             // на каком домене он действует
}

export interface CompanyEmails {
  emails: CompanyEmail[];     // все адреса, лучшие первыми; угаданные — в конце
  best: CompanyEmail | null;  // кому писать первым (угаданные не считаются)
  pattern: EmailPattern | null;
}

/**
 * Собирает почту компании: отсеивает чужие адреса со страниц, делит на личные и общие,
 * привязывает личные к людям из LinkedIn/Hunter, выводит шаблон домена и составляет по нему
 * адреса остальных людей (guessed). Первым идёт тот, кому писать: руководитель → человек →
 * партнёрский/маркетинговый ящик → контакт → поддержка → юридический.
 */
export function buildCompanyEmails(found: FoundEmail[], ctx: EmailContext, knownPattern: EmailPattern | null = null): CompanyEmails {
  const domains = new Set(ctx.domains.filter(Boolean).map(baseDomain));
  // домены из адресов, которые дал сам разработчик в сторе, — тоже его
  for (const f of found) {
    const d = f.email.split('@')[1];
    if (STORE_SOURCES.has(f.source) && !isFreeMailDomain(d)) domains.add(baseDomain(d));
  }
  const domainList = [...domains];
  const people = [
    ...ctx.people,
    ...found.filter((f) => f.person).map((f) => ({ name: f.person!, title: f.title ?? null })),
  ]
    .map((p) => ({ ...p, parts: nameParts(p.name) }))
    .filter((p): p is Person & { parts: NameParts } => !!p.parts);

  const byEmail = new Map<string, CompanyEmail & { score: number }>();
  let pattern = knownPattern;
  for (const f of found) {
    const [local, domain] = f.email.split('@');
    const free = isFreeMailDomain(domain);
    const sameDomain = domains.has(baseDomain(domain));
    const kind = f.person ? 'personal' : classifyEmail(f.email, { company: ctx.company, domains: domainList, individual: ctx.individual });
    const role = roleScore(local);
    // со страниц: только домен разработчика или ролевой адрес (юрфирмы и регуляторы из политик — мимо)
    if (!STORE_SOURCES.has(f.source) && !sameDomain && (role === null || role <= 0)) continue;
    const owner = f.person ? { name: f.person, title: f.title ?? null, pattern: null } : kind === 'personal' ? ownerOf(local, people) : null;
    if (owner?.pattern && sameDomain && !free) pattern ??= { pattern: owner.pattern, domain };
    const decision = owner?.title ? /\b(ceo|founder|co-?founder|owner|president|chief|cmo|coo|managing director|general manager)\b/i.test(owner.title) : DECISION_LOCAL.test(local);
    const score =
      (kind === 'personal' ? 10 + (decision ? 3 : 0) + (owner ? 1 : 0) - (free && !ctx.individual ? 4 : 0) : role ?? 0) +
      (STORE_SOURCES.has(f.source) ? 1 : 0) + (sameDomain ? 1 : 0);
    const prev = byEmail.get(f.email);
    if (prev) {
      if (!prev.sources.includes(f.source)) prev.sources.push(f.source);
      prev.score = Math.max(prev.score, score);
      prev.person ??= owner?.name ?? null;
      prev.title ??= owner?.title ?? null;
      continue;
    }
    byEmail.set(f.email, {
      email: f.email, kind, free, sources: [f.source], person: owner?.name ?? null, title: owner?.title ?? null, guessed: false, score,
    });
  }

  const real = [...byEmail.values()].sort((a, b) => b.score - a.score);
  // адреса людей без почты — по шаблону, на том домене, где шаблон подтвердился
  const guessed: CompanyEmail[] = [];
  if (pattern && !ctx.individual) {
    const taken = new Set(real.map((e) => e.person).filter(Boolean));
    for (const p of people) {
      if (taken.has(p.name)) continue;
      const local = renderPattern(pattern.pattern, p.parts);
      if (!local) continue;
      const email = `${local}@${pattern.domain}`;
      if (byEmail.has(email) || guessed.some((g) => g.email === email)) continue;
      guessed.push({ email, kind: 'personal', free: false, sources: [], person: p.name, title: p.title, guessed: true });
    }
  }

  const emails: CompanyEmail[] = [...real.map(({ score: _s, ...e }) => e), ...guessed];
  return { emails, best: emails.find((e) => !e.guessed) ?? null, pattern };
}
