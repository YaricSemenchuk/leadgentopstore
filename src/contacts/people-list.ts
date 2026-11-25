import type { CompanyEmail, EmailSource, EmailStatus } from './emails.js';
import { linkedinQueries, linkedinSearchLinks } from './linkedin.js';
import { nameParts } from './names.js';

/**
 * Список «Люди»: строка — человек, кому писать. Собирается из того, что уже лежит у компании:
 * люди из LinkedIn (имя, должность, профиль) и личные адреса (сторы, сайт, Hunter, Treg). Адрес
 * привязан к человеку, если совпало имя; адрес без человека — отдельная строка, имя берётся из
 * адреса («li.wei@» → Li Wei). Общие ящики (info@, support@) людьми не считаются — они идут
 * запасным адресом компании в каждой строке.
 */

export interface LinkedInPerson {
  name: string;
  title: string | null;
  url: string | null;
}

export interface ContextApp {
  name: string;
  tier: string;
  vertical?: string | null;
  placement?: string | null;
  countries?: number | null;
  reason?: string | null;      // у целевых — кто это («инди-студия казуальных игр»), у прочих — почему не целевой
  reasons?: string[] | null;   // обоснования модели
  url?: string | null;
}

/** Поля строки из topCompanies, которые нужны списку. */
export interface CompanyRow {
  name: string;
  kind: string | null;
  tier: string;
  best_fit: number | null;
  emails: CompanyEmail[] | null;
  linkedin_people: LinkedInPerson[] | null;
  linkedin_url: string | null;
  website: string | null;
  support_url: string | null;
  privacy_url: string | null;
  email: string | null;
  country: string | null;
  employees: string | null;
  ios_apps: number | null;
  ios_ratings: number | string | null;
  android_apps: number | null;
  treg_company: { industry?: string | null; founded?: string | number | null; location?: string | null } | null;
  site_description: string | null;
  apps: ContextApp[] | null;
  pitch_hook: string | null;
}

/** Откуда имя: профиль LinkedIn, провайдер почты (Hunter/Treg знают владельца), сам адрес, имя частного разработчика. */
export type NameFrom = 'linkedin' | 'provider' | 'email' | 'developer';

export interface PersonContact {
  name: string | null;
  nameFrom: NameFrom | null;
  title: string | null;
  linkedin: string | null;       // профиль человека
  linkedinSearch: string;        // поиск профиля в Google, если его нет
  email: string | null;          // найденный адрес (не угаданный)
  otherEmails: string[];         // ещё адреса того же человека (у частного разработчика их бывает несколько)
  emailFree: boolean;            // gmail, outlook… — не корпоративный
  emailStatus: EmailStatus | null;
  emailSources: EmailSource[];
  emailGuess: string | null;     // по шаблону домена, не проверен
  emailGuessStatus: EmailStatus | null;
  rank: number;                  // руководитель 2, закупка трафика/маркетинг 1, прочие 0
}

const DECISION = /\b(ceo|founder|co-?founder|owner|president|chief|cmo|coo|managing director|general manager|director|head|partner|vp)\b/i;
const BUYER = /\b(user acquisition|ua|marketing|growth|performance|monetization|publishing|business development|bd)\b/i;
const DECISION_LOCAL: Record<string, string> = {
  ceo: 'CEO', founder: 'Founder', cofounder: 'Co-founder', 'co-founder': 'Co-founder', owner: 'Owner',
  president: 'President', cmo: 'CMO', coo: 'COO', cto: 'CTO', md: 'Managing Director',
};

function rankOf(title: string | null): number {
  if (!title) return 0;
  if (DECISION.test(title)) return 2;
  return BUYER.test(title) ? 1 : 0;
}

const capitalize = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/**
 * Имя из адреса — только когда части разделены точкой, дефисом или подчёркиванием: «li.wei» → Li Wei,
 * «huanqing.liu» → Huanqing Liu. Слитное «thanhlx» или «jsmith» не разобрать — null.
 */
export function nameFromEmail(email: string): string | null {
  const local = email.split('@')[0].toLowerCase().replace(/\d+$/, '');
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^[a-z]{2,}$/.test(p))) return null;
  return parts.map(capitalize).join(' ');
}

/** Один и тот же человек: имя совпало целиком или совпали имя и фамилия латиницей. */
function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true;
  const x = nameParts(a);
  const y = nameParts(b);
  return !!x && !!y && !!x.last && x.first === y.first && x.last === y.last;
}

/** Поиск профиля человека в Google: имя + бренд или название компании. */
export function personSearchLink(name: string | null, r: Pick<CompanyRow, 'name' | 'website' | 'email' | 'support_url' | 'privacy_url'>): string {
  const hints = { website: r.website, email: r.email, supportUrl: r.support_url, privacyUrl: r.privacy_url };
  if (!name) return linkedinSearchLinks(r.name, hints).people;
  const { terms, person } = linkedinQueries(r.name, hints);
  const company = person ? '' : ` ${terms.length > 1 ? `(${terms.map((t) => `"${t}"`).join(' OR ')})` : `"${terms[0]}"`}`;
  return `https://www.google.com/search?q=${encodeURIComponent(`site:linkedin.com/in "${name}"${company}`)}`;
}

/** Люди компании: сначала с почтой, затем руководители и закупка трафика. */
export function peopleOfCompany(r: CompanyRow): PersonContact[] {
  const emails = r.emails ?? [];
  const personal = emails.filter((e) => e.kind === 'personal');
  const used = new Set<string>();
  const out: PersonContact[] = [];
  const seenProfiles = new Set<string>();

  for (const p of r.linkedin_people ?? []) {
    if (!p.name) continue;
    if (p.url && seenProfiles.has(p.url)) continue;
    if (p.url) seenProfiles.add(p.url);
    const real = personal.find((e) => !e.guessed && !used.has(e.email) && samePerson(e.person, p.name));
    const guess = real ? undefined : personal.find((e) => e.guessed && !used.has(e.email) && samePerson(e.person, p.name));
    if (real) used.add(real.email);
    if (guess) used.add(guess.email);
    out.push({
      name: p.name,
      nameFrom: 'linkedin',
      title: p.title ?? real?.title ?? null,
      linkedin: p.url ?? null,
      linkedinSearch: personSearchLink(p.name, r),
      email: real?.email ?? null,
      otherEmails: [],
      emailFree: real?.free ?? false,
      emailStatus: real?.status ?? null,
      emailSources: real?.sources ?? [],
      emailGuess: guess?.email ?? null,
      emailGuessStatus: guess?.status ?? null,
      rank: rankOf(p.title),
    });
  }

  // личные адреса без профиля: владелец известен провайдеру, читается из адреса или это сам частный разработчик
  // корпоративные первыми: при слиянии адресов одного человека главным становится адрес на домене компании
  for (const e of [...personal].sort((a, b) => Number(a.free) - Number(b.free))) {
    if (e.guessed || used.has(e.email)) continue;
    used.add(e.email);
    const local = e.email.split('@')[0];
    const roleTitle = DECISION_LOCAL[local.replace(/\d+$/, '')] ?? null;
    const fromEmail = roleTitle ? null : nameFromEmail(e.email);
    const individual = r.kind === 'individual';
    const name = e.person ?? fromEmail ?? (individual ? r.name : null);
    const nameFrom: NameFrom | null = e.person ? 'provider' : fromEmail ? 'email' : name ? 'developer' : null;
    const title = e.title ?? roleTitle;
    // тот же человек уже есть строкой без профиля — второй адрес к нему, а не новая строка
    const same = name ? out.find((p) => !p.linkedin && p.email && samePerson(p.name, name)) : undefined;
    if (same) {
      same.otherEmails.push(e.email);
      continue;
    }
    out.push({
      name,
      nameFrom,
      title,
      linkedin: null,
      linkedinSearch: personSearchLink(name, r),
      email: e.email,
      otherEmails: [],
      emailFree: e.free,
      emailStatus: e.status ?? null,
      emailSources: e.sources,
      emailGuess: null,
      emailGuessStatus: null,
      rank: rankOf(title),
    });
  }

  const emailScore = (p: PersonContact) => (p.email ? (p.emailFree ? 2 : 3) : p.emailGuess ? 1 : 0);
  return out
    .map((p, i) => ({ p, i }))
    .sort((a, b) => emailScore(b.p) - emailScore(a.p) || b.p.rank - a.p.rank || a.i - b.i)
    .map(({ p }) => p);
}

/** Общий ящик компании — запасной адрес, если у человека почты нет: корпоративный первым. */
export function companyRoleEmail(r: Pick<CompanyRow, 'emails'>): string | null {
  const role = (r.emails ?? []).filter((e) => e.kind === 'role');
  return (role.find((e) => !e.free) ?? role[0])?.email ?? null;
}

const num = (n: unknown) => Number(n).toLocaleString('ru-RU');
const sentence = (s: string) => {
  const t = s.trim();
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?…]$/.test(t) ? '' : '.'}` : '';
};

/**
 * Контекст компании одним абзацем — для персонализации письма: кто это (оценка модели и как компания
 * описывает себя на сайте), откуда и какого размера, сколько приложений, что сейчас в чартах и почему
 * подходит. Только из собранного, без новых запросов.
 */
export function companyContext(r: CompanyRow): string {
  const apps = r.apps ?? [];
  const best = apps[0];
  const profile = apps.find((a) => a.tier === 'target' && a.reason)?.reason ?? null;

  const facts: string[] = [];
  if (r.kind === 'individual' && !/разработчик|developer/i.test(profile ?? '')) facts.push('частный разработчик');
  const where = r.country ?? r.treg_company?.location ?? null;
  if (where) facts.push(where);
  if (r.employees) facts.push(`${r.employees} сотрудников`);
  if (r.treg_company?.industry) facts.push(String(r.treg_company.industry));
  if (r.treg_company?.founded) facts.push(`основана в ${r.treg_company.founded}`);

  const portfolio: string[] = [];
  if (r.ios_apps) portfolio.push(`App Store — ${num(r.ios_apps)}${r.ios_ratings ? ` (${num(r.ios_ratings)} отзывов)` : ''}`);
  if (r.android_apps) portfolio.push(`Google Play — ${num(r.android_apps)}`);

  const chart = apps.slice(0, 2).map((a) => {
    const where = [a.placement, a.countries && a.countries > 1 ? `в топах ${a.countries} стран` : null].filter(Boolean).join(', ');
    return `«${a.name}»${a.vertical ? ` (${a.vertical})` : ''}${where ? ` — ${where}` : ''}`;
  });
  const moreApps = apps.length > 2 ? `, ещё ${apps.length - 2}` : '';
  const why = (best?.reasons ?? []).slice(0, 3).map((x) => x.replace(/[.;]\s*$/, '')).join('; ');

  return [
    sentence([profile, ...facts].filter(Boolean).join(' · ')),
    r.site_description ? `О себе на сайте: «${r.site_description.replace(/[«»]/g, '"').replace(/\.\s*$/, '')}».` : '',
    portfolio.length ? `Приложений: ${portfolio.join(', ')}.` : '',
    chart.length ? `В чартах: ${chart.join('; ')}${moreApps}.` : '',
    why ? `Почему подходит: ${why}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
