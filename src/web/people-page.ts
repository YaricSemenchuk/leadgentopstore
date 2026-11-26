import type { CurrentRun } from '../jobs/runner.js';
import type { CompanyFilter, SizeFilter } from '../db/companies.js';
import type { LeadView } from '../db/pool.js';
import {
  companyContext, companyRoleEmail, peopleOfCompany, type CompanyRow, type NameFrom, type PersonContact,
} from '../contacts/people-list.js';
import { SIZE_TABS, SOURCE_LABEL, TIER_LABEL, sizeLabel, statusBadge } from './companies-page.js';
import { esc, fmt, page, safeHref } from './ui.js';

/**
 * «Люди»: строка — человек, кому писать. Корпоративная почта, профиль LinkedIn (если почты нет —
 * по нему ищут адрес сервисами), имя, компания и её контекст для письма.
 */

export interface PeopleFilter {
  view: LeadView;
  size: SizeFilter;
  withEmail: boolean;      // есть найденный адрес (не угаданный)
  corporate: boolean;      // адрес на домене компании, не gmail
  withLinkedIn: boolean;   // есть профиль LinkedIn
}

export function peopleFilterFrom(q: Record<string, unknown>): PeopleFilter {
  const v = String(q.view ?? '');
  const s = String(q.size ?? '');
  return {
    view: v === 'target' || v === 'maybe' || v === 'skip' ? v : 'active',
    size: (SIZE_TABS.some(([k]) => k === s) ? s : 'any') as SizeFilter,
    withEmail: q.email === '1',
    corporate: q.corp === '1',
    withLinkedIn: q.li === '1',
  };
}

function peopleQuery(f: PeopleFilter): string {
  const p = new URLSearchParams();
  if (f.view !== 'active') p.set('view', f.view);
  if (f.size !== 'any') p.set('size', f.size);
  if (f.withEmail) p.set('email', '1');
  if (f.corporate) p.set('corp', '1');
  if (f.withLinkedIn) p.set('li', '1');
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Компании по уровню и размеру; фильтры по человеку применяются к списку людей. */
export function companyFilterOf(f: PeopleFilter): CompanyFilter {
  return { view: f.view, size: f.size, asa: 'any', withEmail: false, withPersonal: false, withPlay: false, withLinkedIn: false };
}

export interface PersonRow {
  person: PersonContact;
  company: CompanyRow & Record<string, any>;
  context: string;
  roleEmail: string | null;
}

export function buildPeopleRows(companies: any[]): PersonRow[] {
  const rows: PersonRow[] = [];
  for (const c of companies) {
    const people = peopleOfCompany(c);
    if (people.length === 0) continue;
    const context = companyContext(c);
    const roleEmail = companyRoleEmail(c);
    for (const person of people) rows.push({ person, company: c, context, roleEmail });
  }
  return rows;
}

export function filterPeople(rows: PersonRow[], f: PeopleFilter): PersonRow[] {
  return rows.filter(({ person: p }) =>
    (!f.withEmail || !!p.email) && (!f.corporate || (!!p.email && !p.emailFree)) && (!f.withLinkedIn || !!p.linkedin));
}

export function peopleStats(rows: PersonRow[]) {
  const companies = new Set(rows.map((r) => r.company.id));
  const p = rows.map((r) => r.person);
  return {
    people: p.length,
    companies: companies.size,
    withEmail: p.filter((x) => x.email).length,
    corporate: p.filter((x) => x.email && !x.emailFree).length,
    verified: p.filter((x) => x.email && x.emailStatus === 'valid').length,
    guessed: p.filter((x) => !x.email && x.emailGuess).length,
    withLinkedIn: p.filter((x) => x.linkedin).length,
    linkedinNoEmail: p.filter((x) => x.linkedin && !x.email).length,
  };
}

const NAME_FROM: Record<NameFrom, string> = {
  linkedin: 'LinkedIn',
  provider: 'по данным Hunter/Treg',
  email: 'имя по адресу',
  developer: 'частный разработчик',
};

const link = (href: unknown, label: string, cls = '') => {
  const h = safeHref(href);
  return h ? `<a${cls ? ` class="${cls}"` : ''} href="${h}" target="_blank" rel="noopener noreferrer">${label}</a>` : '';
};

function personCell(p: PersonContact): string {
  const name = p.name ? `<b>${esc(p.name)}</b>` : '<span class="mut">имя неизвестно</span>';
  const from = p.nameFrom && p.nameFrom !== 'linkedin' ? `<div class="small mut">${esc(NAME_FROM[p.nameFrom])}</div>` : '';
  return `${name}${p.title ? `<div class="small">${esc(p.title)}</div>` : ''}${from}`;
}

function emailCell(r: PersonRow): string {
  const p = r.person;
  if (p.email) {
    const src = p.emailSources.map((s) => SOURCE_LABEL[s] ?? s).join(', ');
    const type = p.emailFree ? '<span class="warn">gmail и т.п.</span>' : '<span class="ok">корпоративная</span>';
    const more = p.otherEmails.length ? `<div class="small">ещё: ${p.otherEmails.map((e) => `<a href="mailto:${esc(e)}">${esc(e)}</a>`).join(', ')}</div>` : '';
    return `<a class="mail" href="mailto:${esc(p.email)}">${esc(p.email)}</a>
      <div class="small mut">${type}${src ? ` · ${esc(src)}` : ''}${statusBadge({ status: p.emailStatus })}</div>${more}`;
  }
  const guess = p.emailGuess
    ? `<div><span class="guess">${esc(p.emailGuess)}</span><div class="small warn">по шаблону домена — не проверен${statusBadge({ status: p.emailGuessStatus })}</div></div>`
    : '<span class="mut">не найдена</span>';
  const fallback = r.roleEmail ? `<div class="small mut">общая: <a href="mailto:${esc(r.roleEmail)}">${esc(r.roleEmail)}</a></div>` : '';
  return guess + fallback;
}

function linkedinCell(p: PersonContact): string {
  if (p.linkedin) return `<b>${link(p.linkedin, 'Профиль')}</b>`;
  return `<span class="mut">нет</span><div class="small">${link(p.linkedinSearch, 'найти профиль')}</div>`;
}

function companyCell(c: PersonRow['company']): string {
  const links = [link(c.website, 'сайт'), link(c.linkedin_url, 'LinkedIn компании')].filter(Boolean).join(' · ');
  return `<b>${esc(c.name)}</b>
    <div class="small"><span class="tier t-${esc(c.tier)}">${esc(TIER_LABEL[c.tier] ?? c.tier)}</span> <span class="fit">${esc(c.best_fit ?? '')}</span></div>
    <div class="small">${sizeLabel(c)}${c.country ? ` · ${esc(c.country)}` : ''}</div>
    ${links ? `<div class="small">${links}</div>` : ''}`;
}

export function renderPeoplePage(o: { rows: PersonRow[]; all: PersonRow[]; filter: PeopleFilter; run: CurrentRun | null }): string {
  const { rows, filter } = o;
  const s = peopleStats(o.all);
  // люди одной компании идут подряд: компания и её контекст — одной ячейкой на всех
  const tr = rows.map((r, i) => {
    const first = i === 0 || rows[i - 1].company.id !== r.company.id;
    let span = 1;
    if (first) while (rows[i + span]?.company.id === r.company.id) span++;
    const company = first
      ? `<td class="co"${span > 1 ? ` rowspan="${span}"` : ''}>${companyCell(r.company)}</td>
      <td class="ctx small"${span > 1 ? ` rowspan="${span}"` : ''}>${esc(r.context)}${r.company.pitch_hook ? `<div class="hook"><span class="mut">Зацепка:</span> ${esc(r.company.pitch_hook)}</div>` : ''}</td>`
      : '';
    return `<tr class="${first ? 'first' : 'same'}">
      <td class="person">${personCell(r.person)}</td>
      <td class="contact">${emailCell(r)}</td>
      <td class="li">${linkedinCell(r.person)}</td>
      ${company}
    </tr>`;
  }).join('');

  const tab = (on: boolean, f: PeopleFilter, label: string) =>
    `<a class="tab${on ? ' on' : ''}" href="/people${peopleQuery(f)}">${label}</a>`;
  const viewTab = (view: LeadView, label: string) => tab(filter.view === view, { ...filter, view }, label);
  const sizeTabs = SIZE_TABS.map(([size, label]) => tab(filter.size === size, { ...filter, size }, label)).join('');
  const toggle = (key: 'withEmail' | 'corporate' | 'withLinkedIn', label: string) =>
    tab(filter[key], { ...filter, [key]: !filter[key] }, label);

  return page({
    title: 'Люди',
    active: 'people',
    run: o.run,
    body: `
  <h1>Люди</h1>
  <p class="sub">Людей: <b>${fmt(s.people)}</b> в ${fmt(s.companies)} компаниях · с почтой ${fmt(s.withEmail)} (корпоративной ${fmt(s.corporate)}, проверено ${fmt(s.verified)})${s.guessed ? ` · ещё ${fmt(s.guessed)} — адрес по шаблону, не проверен` : ''} · с профилем LinkedIn ${fmt(s.withLinkedIn)}, из них без почты ${fmt(s.linkedinNoEmail)} — адрес можно найти сервисами по профилю
    <br>Строка — человек. Общие ящики (info@, support@) людьми не считаются: они показаны запасным адресом компании и есть на странице <a href="/">Компании</a>.</p>
  <div class="bar">${viewTab('active', 'Целевые и под вопросом')}${viewTab('target', 'Только целевые')}${viewTab('maybe', 'Под вопросом')}${viewTab('skip', 'Мимо')}</div>
  <div class="bar">${sizeTabs}</div>
  <div class="bar">
    ${toggle('withEmail', 'С почтой')}${toggle('corporate', 'Только корпоративная почта')}${toggle('withLinkedIn', 'С профилем LinkedIn')}
    <a class="tab csv" href="/api/people.csv${peopleQuery(filter)}">Скачать CSV</a>
  </div>
  <div class="wrap"><table class="leads">
    <thead><tr><th>Человек</th><th>Почта</th><th>LinkedIn</th><th>Компания</th><th>Контекст компании</th></tr></thead>
    <tbody>${tr || `<tr><td colspan="5" style="text-align:center;color:var(--mut);padding:40px">Нет людей под этот фильтр</td></tr>`}</tbody>
  </table></div>`,
    css: `
  table.leads{min-width:1200px}
  td.person{min-width:180px} td.contact{min-width:230px} td.li{min-width:110px} td.co{min-width:200px} td.ctx{min-width:360px;max-width:560px}
  .mail{font-weight:600;overflow-wrap:anywhere} .guess{overflow-wrap:anywhere;color:var(--warn)}
  .fit{font-weight:700;color:var(--acc)} .hook{margin-top:6px}
  tr.first td{border-top:2px solid var(--line)} td.co,td.ctx{border-left:1px solid var(--line)}
  .tier{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid var(--line)}
  .t-target{color:#4cc38a;border-color:#2b6b4d} .t-maybe{color:var(--warn);border-color:#6b5428} .t-skip{color:var(--mut)}`,
  });
}

// CSV для рассылки: строка — человек. Поля пишут сторонние разработчики — формулы экранирует sendCsv.
export const PEOPLE_CSV: Array<[string, (r: PersonRow) => unknown]> = [
  ['name', (r) => r.person.name],
  ['name_source', (r) => r.person.nameFrom],
  ['title', (r) => r.person.title],
  ['email', (r) => r.person.email],
  ['email_type', (r) => (r.person.email ? (r.person.emailFree ? 'free' : 'corporate') : '')],
  ['email_status', (r) => r.person.emailStatus],
  ['email_source', (r) => r.person.emailSources.join(' ')],
  ['other_emails', (r) => r.person.otherEmails.join(' ')],
  ['email_guess_unverified', (r) => r.person.emailGuess],
  ['linkedin_profile', (r) => r.person.linkedin],
  ['linkedin_profile_search', (r) => (r.person.linkedin ? '' : r.person.linkedinSearch)],
  ['company', (r) => r.company.name],
  ['company_tier', (r) => r.company.tier],
  ['company_fit', (r) => r.company.best_fit],
  ['company_size', (r) => (r.company.kind === 'individual' ? 'individual' : r.company.employees)],
  ['country', (r) => r.company.country],
  ['company_email', (r) => r.roleEmail],
  ['company_linkedin', (r) => r.company.linkedin_url],
  ['website', (r) => r.company.website],
  ['company_context', (r) => r.context],
  ['company_apple_ads_eu', (r) => r.company.asa_status],
  ['company_apple_ads_eu_last_shown', (r) => r.company.asa_last],
  ['pitch_hook', (r) => r.company.pitch_hook],
  ['app_store', (r) => r.company.apps?.[0]?.url],
];
