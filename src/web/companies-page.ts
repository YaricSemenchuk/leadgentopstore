import type { CurrentRun } from '../jobs/runner.js';
import type { CompanyFilter, SizeFilter } from '../db/companies.js';
import type { CompanyEmail, EmailSource } from '../contacts/emails.js';
import { linkedinSearchLinks } from '../contacts/linkedin.js';
import type { LeadView } from '../db/pool.js';
import { esc, fmt, page, safeHref } from './ui.js';

export const TIER_LABEL: Record<string, string> = { target: 'целевой', maybe: 'под вопросом', skip: 'мимо' };

export const SOURCE_LABEL: Record<EmailSource, string> = {
  google_play: 'Google Play',
  play_developer: 'аккаунт Google Play',
  app_store_trader: 'App Store ЕС',
  support_page: 'поддержка',
  privacy_policy: 'политика',
  website: 'сайт',
  hunter: 'Hunter',
};

const SIZE_TABS: Array<[SizeFilter, string]> = [
  ['any', 'Любой размер'],
  ['50', 'От 50 сотрудников'],
  ['11', '11–50'],
  ['10', 'До 10 и частные лица'],
  ['unknown', 'Размер неизвестен'],
];

export function companyFilterFrom(q: Record<string, unknown>): CompanyFilter {
  const v = String(q.view ?? '');
  const s = String(q.size ?? '');
  return {
    view: v === 'target' || v === 'maybe' || v === 'skip' ? v : 'active',
    size: (SIZE_TABS.some(([k]) => k === s) ? s : 'any') as SizeFilter,
    withEmail: q.email === '1',
    withPersonal: q.personal === '1',
    withPlay: q.play === '1',
    withLinkedIn: q.li === '1',
  };
}

export function companyQuery(f: CompanyFilter): string {
  const p = new URLSearchParams();
  if (f.view !== 'active') p.set('view', f.view);
  if (f.size !== 'any') p.set('size', f.size);
  if (f.withPersonal) p.set('personal', '1');
  if (f.withEmail) p.set('email', '1');
  if (f.withPlay) p.set('play', '1');
  if (f.withLinkedIn) p.set('li', '1');
  const s = p.toString();
  return s ? `?${s}` : '';
}

const link = (href: unknown, label: string) => {
  const h = safeHref(href);
  return h ? `<a href="${h}" target="_blank" rel="noopener noreferrer">${label}</a>` : '';
};

export function sizeLabel(r: any): string {
  if (r.kind === 'individual') return 'частное лицо';
  if (r.employees) return `${esc(r.employees)} сотрудников <span class="mut">(${r.employees_source === 'hunter' ? 'Hunter' : 'LinkedIn'})</span>`;
  return '<span class="mut">размер неизвестен</span>';
}

/** Проверка компании: D-U-N-S из App Store ЕС — Apple подтвердила юрлицо. */
export function verifyLabel(r: any): string {
  if (!r.checked_at) return '<span class="mut">не проверена</span>';
  if (r.duns) return `<span class="ok" title="D-U-N-S ${esc(r.duns)} — Apple проверила юрлицо">✓ юрлицо (D-U-N-S)</span>`;
  if (r.is_trader) return '<span class="ok">торговец в ЕС</span>';
  if (r.kind === 'individual') return '<span class="warn">частное лицо</span>';
  return '<span class="mut">юрлицо не подтверждено</span>';
}

function emailLine(e: CompanyEmail): string {
  const who = e.person ? `<div class="small">${esc(e.person)}${e.title ? ` · <span class="mut">${esc(e.title)}</span>` : ''}</div>` : '';
  const src = e.sources.map((s) => SOURCE_LABEL[s] ?? s).join(', ');
  return `<div class="em"><a class="mail" href="mailto:${esc(e.email)}">${esc(e.email)}</a>${who}
    <div class="small mut">${esc(src)}${e.free ? ' · бесплатный ящик' : ''}</div></div>`;
}

function personalCell(r: any): string {
  const emails = (r.emails ?? []) as CompanyEmail[];
  const real = emails.filter((e) => e.kind === 'personal' && !e.guessed);
  const guessed = emails.filter((e) => e.guessed);
  if (!r.checked_at) return '<span class="mut">ещё не проверяли</span>';
  const pattern = r.email_pattern ? String(r.email_pattern).split('@')[0] : null;
  const guessedHtml = guessed.length
    ? `<details class="guess"><summary class="warn small">по шаблону ${esc(pattern ?? '')}: ${guessed.length} — не проверены</summary>
        ${guessed.map((e) => `<div class="em"><a class="mail" href="mailto:${esc(e.email)}">${esc(e.email)}</a>
          <div class="small">${esc(e.person)}${e.title ? ` · <span class="mut">${esc(e.title)}</span>` : ''}</div></div>`).join('')}</details>`
    : '';
  return (real.length ? real.map(emailLine).join('') : '<span class="mut">не найдено</span>') + guessedHtml;
}

function roleCell(r: any): string {
  const emails = ((r.emails ?? []) as CompanyEmail[]).filter((e) => e.kind === 'role');
  const phone = r.phone ? `<div class="small">☎ ${esc(r.phone)}</div>` : '';
  if (!r.checked_at) return '<span class="mut">ещё не проверяли</span>';
  const shown = emails.slice(0, 4).map(emailLine).join('');
  const more = emails.length > 4 ? `<div class="small mut">ещё ${emails.length - 4}: ${esc(emails.slice(4).map((e) => e.email).join(', '))}</div>` : '';
  return (shown || '<span class="mut">не найдено</span>') + more + phone;
}

function appsCell(r: any): string {
  const apps = (r.apps ?? []) as Array<{ name: string; url: string; play: string | null; tier: string; fit: number; placement: string; countries: number }>;
  const counts = [
    r.ios_apps !== null && r.ios_apps !== undefined ? `iOS: <b>${fmt(r.ios_apps)}</b>${r.ios_ratings ? ` <span class="mut">(${fmt(r.ios_ratings)} отз.)</span>` : ''}` : '',
    r.android_apps ? `Google Play: <b>${fmt(r.android_apps)}</b>` : r.checked_at ? '<span class="mut">нет в Google Play</span>' : '',
  ].filter(Boolean).join(' · ');
  const chart = apps.slice(0, 4).map((a) => `<div class="app"><span class="dot t-${esc(a.tier)}" title="${esc(TIER_LABEL[a.tier] ?? a.tier)}">●</span>
      ${link(a.url, esc(a.name)) || esc(a.name)} <span class="mut small">${esc(a.fit ?? '')}</span>
      <div class="small mut">${esc(a.placement ?? '')}${a.countries ? ` · в топах ${esc(a.countries)} стран` : ''}${a.play ? ` · ${link(a.play, 'Google Play')}` : ''}</div></div>`).join('');
  const moreChart = apps.length > 4 ? `<div class="small mut">ещё в чартах: ${apps.length - 4}</div>` : '';
  const ios = (r.ios_app_list ?? []) as Array<{ id: string; name: string; ratings: number }>;
  const android = (r.android_app_list ?? []) as Array<{ packageId: string; name: string }>;
  const all = ios.length || android.length
    ? `<details><summary class="small">все приложения</summary>
        ${ios.length ? `<div class="small"><b>App Store</b>: ${ios.map((a) => `${link(`https://apps.apple.com/app/id${a.id}`, esc(a.name))} <span class="mut">${fmt(a.ratings)}</span>`).join(', ')}</div>` : ''}
        ${android.length ? `<div class="small"><b>Google Play</b>: ${android.map((a) => link(`https://play.google.com/store/apps/details?id=${encodeURIComponent(a.packageId)}`, esc(a.name || a.packageId))).join(', ')}</div>` : ''}
      </details>`
    : '';
  return `<div class="small">${counts}</div>${chart}${moreChart}${all}`;
}

function linkedinCell(r: any): string {
  const people = (r.linkedin_people ?? []) as Array<{ name: string; title: string | null; url: string }>;
  // найдена только по названию — бывают однофамильцы (ром «Takamaka», студия VFX с тем же именем)
  const company = r.linkedin_url
    ? `<div><b>${link(r.linkedin_url, 'Страница компании')}</b>${r.linkedin_confirmed === false ? '<div class="small warn">по названию, не сверена с сайтом</div>' : ''}</div>`
    : '';
  const peopleHtml = people.length
    ? `<div class="people">${people.map((p) => `${link(p.url, esc(p.name))}${p.title ? `<div class="small mut">${esc(p.title)}</div>` : ''}`).join('')}</div>`
    : '';
  const li = linkedinSearchLinks(r.name, { website: r.website, email: r.email, supportUrl: r.support_url, privacyUrl: r.privacy_url });
  const found = company || peopleHtml ? `${company}${peopleHtml}` : '<span class="mut">не найдено</span>';
  return `${found}<div class="small mut search">искать: ${link(li.company, 'компания')} · ${link(li.google, 'через Google')} · ${link(li.people, 'люди')}</div>`;
}

export function renderCompaniesPage(o: {
  rows: any[];
  stats: Awaited<ReturnType<typeof import('../db/companies.js').companyStats>>;
  filter: CompanyFilter;
  run: CurrentRun | null;
}): string {
  const { rows, stats, filter } = o;
  const tr = rows.map((r) => `<tr>
      <td class="fit-cell"><div class="fit">${esc(r.best_fit ?? '')}</div>
        <span class="tier t-${esc(r.tier)}">${esc(TIER_LABEL[r.tier] ?? r.tier)}</span></td>
      <td class="co"><b>${esc(r.name)}</b>
        <div class="small">${verifyLabel(r)}${r.country ? ` · ${esc(r.country)}` : ''}</div>
        <div class="small">${sizeLabel(r)}</div>
        <div class="small">${[link(r.website, 'сайт') + (r.website_ok === false ? ' <span class="warn">не открылся</span>' : ''), link(r.support_url, 'поддержка'), link(r.play_developer_url, 'Google Play')].filter((x) => x && !x.startsWith(' ')).join(' · ')}</div></td>
      <td class="apps">${appsCell(r)}</td>
      <td class="contact">${personalCell(r)}</td>
      <td class="contact">${roleCell(r)}</td>
      <td class="linkedin">${linkedinCell(r)}</td>
      <td class="small">${esc(r.pitch_hook ?? '')}</td>
    </tr>`).join('');

  const tab = (on: boolean, f: CompanyFilter, label: string, cls = '') =>
    `<a class="tab${on ? ' on' : ''}${cls}" href="/${companyQuery(f)}">${label}</a>`;
  const viewTab = (view: LeadView, label: string) => tab(filter.view === view, { ...filter, view }, label);
  const sizeTabs = SIZE_TABS.map(([size, label]) => tab(filter.size === size, { ...filter, size }, label)).join('');
  const toggle = (key: 'withPersonal' | 'withEmail' | 'withPlay' | 'withLinkedIn', label: string) =>
    tab(filter[key], { ...filter, [key]: !filter[key] }, label);
  const filtered = filter.view !== 'active' || filter.size !== 'any' || filter.withEmail || filter.withPersonal || filter.withPlay || filter.withLinkedIn;

  return page({
    title: 'Компании',
    active: 'companies',
    run: o.run,
    body: `
  <h1>Компании</h1>
  <p class="sub">Целевых компаний: <b>${stats.target}</b> (их приложений в чартах: ${stats.target_apps}) · с личной почтой ${stats.target_with_personal} · с любой почтой ${stats.target_with_email} · от 50 сотрудников ${stats.target_50} (вместе с «под вопросом» — ${stats.active_50}) · юрлицо подтверждено ${stats.target_verified} · в Google Play ${stats.target_on_play} · с LinkedIn ${stats.target_with_linkedin}
    <br>Под вопросом: ${stats.maybe} · мимо: ${stats.skip} (скрыты)${stats.unchecked ? ` · <span class="warn">контакты не проверены: ${stats.unchecked}</span> — «Дособрать контакты» на странице <a href="/settings">Что парсить</a>` : ''}</p>
  <div class="bar">
    ${viewTab('active', 'Целевые и под вопросом')}${viewTab('target', 'Только целевые')}${viewTab('maybe', 'Под вопросом')}${viewTab('skip', 'Мимо')}
  </div>
  <div class="bar">${sizeTabs}</div>
  <div class="bar">
    ${toggle('withPersonal', 'С личной почтой')}${toggle('withEmail', 'С почтой')}${toggle('withPlay', 'Есть в Google Play')}${toggle('withLinkedIn', 'С LinkedIn')}
    <a class="tab csv" href="/api/companies.csv${companyQuery(filter)}">Скачать CSV</a>
  </div>
  <div class="wrap"><table class="leads">
    <thead><tr><th>Уровень</th><th>Компания</th><th>Приложения</th><th>Личная почта</th><th>Общая почта</th><th>LinkedIn</th><th>Зацепка</th></tr></thead>
    <tbody>${tr || `<tr><td colspan="7" style="text-align:center;color:var(--mut);padding:40px">${
      filtered ? 'Нет компаний под этот фильтр' : 'Пусто — выбери, <a href="/settings">что парсить</a>, и запусти сбор'
    }</td></tr>`}</tbody>
  </table></div>`,
    css: `
  table.leads{min-width:1200px}
  .fit{font-weight:700;color:var(--acc);font-size:16px}
  .mail{font-weight:600;overflow-wrap:anywhere} td.contact{min-width:210px} td.fit-cell{min-width:100px}
  td.co{min-width:200px} td.apps{min-width:240px} td.linkedin{min-width:200px} td.linkedin .search{margin-top:6px}
  .em{margin-bottom:6px} .app{margin-top:4px} details{margin-top:6px} summary{cursor:pointer;color:var(--mut)}
  details.guess summary{color:var(--warn)}
  .tier{display:inline-block;margin-top:4px;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid var(--line)}
  .t-target{color:#4cc38a;border-color:#2b6b4d} .t-maybe{color:var(--warn);border-color:#6b5428} .t-skip{color:var(--mut)}
  .dot{font-size:10px} .people{margin-top:4px;line-height:1.5}`,
  });
}

// CSV для рассылки: одна строка — одна компания. Поля пишут сторонние разработчики — формулы Excel экранируются.
const personalList = (r: any, guessed: boolean) =>
  ((r.emails ?? []) as CompanyEmail[])
    .filter((e) => e.kind === 'personal' && e.guessed === guessed)
    .map((e) => `${e.email}${e.person ? ` (${e.person}${e.title ? `, ${e.title}` : ''})` : ''}`)
    .join(' | ');

export const COMPANY_CSV: Array<[string, (r: any) => unknown]> = [
  ['tier', (r) => r.tier],
  ['best_fit', (r) => r.best_fit],
  ['company', (r) => r.name],
  ['kind', (r) => r.kind],
  ['duns', (r) => r.duns],
  ['country', (r) => r.country],
  ['employees', (r) => r.employees],
  ['employees_source', (r) => r.employees_source],
  ['best_email', (r) => r.email],
  ['personal_emails', (r) => personalList(r, false)],
  ['guessed_emails', (r) => personalList(r, true)],
  ['email_pattern', (r) => r.email_pattern],
  ['role_emails', (r) => ((r.emails ?? []) as CompanyEmail[]).filter((e) => e.kind === 'role').map((e) => e.email).join(' ')],
  ['phone', (r) => r.phone],
  ['address', (r) => r.address],
  ['website', (r) => r.website],
  ['linkedin', (r) => r.linkedin_url],
  ['linkedin_confirmed', (r) => (r.linkedin_url ? (r.linkedin_confirmed === false ? 'no' : 'yes') : '')],
  ['linkedin_people', (r) => (r.linkedin_people ?? []).map((p: any) => `${p.name}${p.title ? ` (${p.title})` : ''} ${p.url}`).join(' | ')],
  ['ios_apps', (r) => r.ios_apps],
  ['android_apps', (r) => r.android_apps],
  ['google_play_developer', (r) => r.play_developer_url],
  ['apps_in_charts', (r) => (r.apps ?? []).map((a: any) => `${a.name} [${a.tier}, ${a.fit ?? ''}]`).join(' | ')],
  ['app_store_urls', (r) => (r.apps ?? []).map((a: any) => a.url).join(' ')],
  ['pitch_hook', (r) => r.pitch_hook],
];
