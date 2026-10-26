import express, { type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { initSchema, leadStats, topLeads, pool, type LeadFilter, type LeadView } from './db/pool.js';
import { currentRun, markInterruptedRuns, recentRuns, startRun } from './jobs/runner.js';
import { getParseSettings, ParseSettingsSchema, saveParseSettings } from './settings.js';
import { renderSettingsPage, type Flash } from './web/settings-page.js';
import { esc, fmt, page, safeHref } from './web/ui.js';
import { linkedinSearchLinks } from './contacts/linkedin.js';

const app = express();

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD ?? '';
const INGEST_TOKEN = process.env.INGEST_TOKEN ?? '';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

// Health — без авторизации, для проверок Railway
app.get('/health', (_req, res) => res.json({ ok: true }));

// Запуск прохода по API (cron): по токену; отвечаем сразу, проход идёт в фоне с выборкой со страницы «Что парсить»
app.post('/ingest', wrap(async (req, res) => {
  const auth = req.get('authorization') ?? '';
  if (!INGEST_TOKEN || !safeEqual(auth, `Bearer ${INGEST_TOKEN}`)) {
    res.status(401).json({ ok: false, error: 'нужен заголовок Authorization: Bearer <INGEST_TOKEN>' });
    return;
  }
  const r = await startRun('api');
  if (r.started) res.status(202).json({ ok: true, runId: r.id });
  else res.status(409).json({ ok: false, error: r.reason });
}));

// Всё остальное (лиды с контактами) — под паролем, если он задан
app.use((req, res, next) => {
  if (!DASHBOARD_PASSWORD) return next();
  const [scheme, value] = (req.get('authorization') ?? '').split(' ');
  const password = scheme === 'Basic' && value ? Buffer.from(value, 'base64').toString().split(':').slice(1).join(':') : '';
  if (safeEqual(password, DASHBOARD_PASSWORD)) return next();
  res.set('WWW-Authenticate', 'Basic realm="leads"').status(401).send('auth required');
});

// Формы дашборда. Запросы с чужих сайтов отбрасываем: браузер подставил бы сохранённый пароль (CSRF).
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const from = req.get('origin') ?? req.get('referer') ?? '';
  const host = req.get('x-forwarded-host') ?? req.get('host');
  let sameOrigin = false;
  try {
    sameOrigin = !!from && new URL(from).host === host;
  } catch {
    /* битый Origin */
  }
  if (sameOrigin) return next();
  res.status(403).send('запрос не со страницы дашборда');
});

/** Фильтр из query: view=target|maybe|skip (по умолчанию целевые + под вопросом), with=email. */
function filterFrom(req: Request): Required<LeadFilter> {
  const v = String(req.query.view ?? '');
  const view: LeadView = v === 'target' || v === 'maybe' || v === 'skip' ? v : 'active';
  return { view, withEmail: req.query.with === 'email' };
}

function query({ view, withEmail }: Required<LeadFilter>): string {
  const params = new URLSearchParams();
  if (view !== 'active') params.set('view', view);
  if (withEmail) params.set('with', 'email');
  const q = params.toString();
  return q ? `?${q}` : '';
}

// JSON-список лидов
app.get('/api/leads', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100) || 100, 1000);
  res.json(await topLeads(limit, filterFrom(req)));
}));

// CSV для рассылки. Поля приходят от сторонних разработчиков — экранируем формулы Excel.
const CSV_COLUMNS: Array<[string, (r: any) => unknown]> = [
  ['tier', (r) => r.tier],
  ['tier_reason', (r) => r.tier_reason],
  ['fit_score', (r) => r.fit_score],
  ['app', (r) => r.name],
  ['developer', (r) => r.developer],
  ['email', (r) => r.email],
  ['email_source', (r) => r.email_source],
  ['email_personal', (r) => (r.email_personal ? 'yes' : '')],
  ['other_emails', (r) => (r.emails ?? []).join(' ')],
  ['linkedin', (r) => r.linkedin_url],
  ['linkedin_kind', (r) => r.linkedin_kind],
  ['linkedin_company_search', (r) => linkedinSearchLinks(r.developer).company],
  ['linkedin_people_search', (r) => linkedinSearchLinks(r.developer).people],
  ['website', (r) => r.website],
  ['support_url', (r) => r.support_url],
  ['google_play', (r) => r.play_url],
  ['app_store', (r) => r.app_store_url],
  ['vertical', (r) => r.vertical ?? r.primary_genre],
  ['best_placement', (r) => r.best_placement],
  ['countries_in_top', (r) => r.country_count],
  ['ratings', (r) => r.rating_count],
  ['publisher_apps', (r) => r.publisher_apps],
  ['publisher_ratings', (r) => r.publisher_ratings],
  ['pitch_hook', (r) => r.pitch_hook],
  ['reasons', (r) => (r.reasons ?? []).join(' | ')],
];

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

app.get('/api/leads.csv', wrap(async (req, res) => {
  const rows = await topLeads(5000, filterFrom(req));
  const lines = [CSV_COLUMNS.map(([h]) => h).join(','), ...rows.map((r) => CSV_COLUMNS.map(([, f]) => csvCell(f(r))).join(','))];
  res.type('text/csv; charset=utf-8').attachment('leads.csv').send('﻿' + lines.join('\r\n'));
}));

const TIER_LABEL: Record<string, string> = { target: 'целевой', maybe: 'под вопросом', skip: 'мимо' };

const SOURCE_LABEL: Record<string, string> = {
  google_play: 'Google Play',
  support_page: 'поддержка',
  privacy_policy: 'политика',
  website: 'сайт',
};

// HTML-дашборд
app.get('/', wrap(async (req, res) => {
  const filter = filterFrom(req);
  const [rows, stats] = await Promise.all([topLeads(300, filter), leadStats()]);

  const link = (href: unknown, label: string) => {
    const h = safeHref(href);
    return h ? `<a href="${h}" target="_blank" rel="noopener noreferrer">${label}</a>` : '';
  };

  const tr = rows
    .map((r) => {
      const contact = r.email
        ? `<a class="mail" href="mailto:${esc(r.email)}">${esc(r.email)}</a>
           <div class="src">${esc(SOURCE_LABEL[r.email_source] ?? r.email_source)}${r.email_personal ? ' · <span class="warn">личный ящик</span>' : ''}</div>`
        : `<span class="mut">${r.contacts_checked_at ? 'почта не найдена' : 'ещё не проверяли'}</span>`;
      const links = [
        r.linkedin_url ? `<b>${link(r.linkedin_url, r.linkedin_kind === 'person' ? 'LinkedIn (профиль)' : 'LinkedIn')}</b>` : '',
        link(r.website, 'сайт'),
        link(r.support_url, 'поддержка'),
        link(r.play_url, 'Google Play'),
      ]
        .filter(Boolean)
        .join(' · ');
      const li = linkedinSearchLinks(r.developer);
      const liSearch = `<div class="small mut">найти в LinkedIn: ${link(li.company, 'компания')} · ${link(li.people, 'люди')} · ${link(li.google, 'Google')}</div>`;
      const publisher =
        r.publisher_apps !== null && r.publisher_apps !== undefined
          ? `издатель: ${fmt(r.publisher_apps)} прил. · ${fmt(r.publisher_ratings)} отзывов`
          : '';
      return `<tr>
        <td class="fit-cell"><div class="fit">${esc(r.fit_score)}</div>
          <span class="tier t-${esc(r.tier)}">${esc(TIER_LABEL[r.tier] ?? r.tier)}</span>
          ${r.tier_reason ? `<div class="mut small">${esc(r.tier_reason)}</div>` : ''}</td>
        <td><b>${link(r.app_store_url, esc(r.name)) || esc(r.name)}</b>
          <div class="dev">${esc(r.developer)}</div>
          <div class="mut small">${esc(publisher)}</div></td>
        <td>${esc(r.vertical ?? r.primary_genre)}</td>
        <td>${esc(r.best_placement)}<div class="mut small">в топах ${esc(r.country_count)} стран</div></td>
        <td class="num">${fmt(r.rating_count)}</td>
        <td class="contact">${contact}${links ? `<div class="small">${links}</div>` : ''}${liSearch}</td>
        <td>${esc(r.pitch_hook)}</td>
      </tr>`;
    })
    .join('');

  const tab = (active: boolean, href: string, label: string) =>
    `<a class="tab${active ? ' on' : ''}" href="/${href}">${label}</a>`;
  const viewTab = (view: LeadView, label: string) =>
    tab(filter.view === view, query({ ...filter, view }), label);

  res.type('html').send(
    page({
      title: 'Лиды',
      active: 'leads',
      run: currentRun(),
      body: `
  <h1>Лиды</h1>
  <p class="sub">Целевых: ${stats.target} (с почтой ${stats.target_with_email}) · под вопросом: ${stats.maybe} · мимо: ${stats.skip} (скрыты)${stats.unscored ? ` · без уровня: ${stats.unscored}` : ''}${stats.unchecked ? ` · контакты не проверены: ${stats.unchecked}` : ''}</p>
  <div class="bar">
    ${viewTab('active', 'Целевые и под вопросом')}
    ${viewTab('target', 'Только целевые')}
    ${viewTab('maybe', 'Под вопросом')}
    ${viewTab('skip', 'Мимо')}
    <span class="sep"></span>
    ${tab(filter.withEmail, query({ ...filter, withEmail: !filter.withEmail }), 'Только с почтой')}
    <a class="tab csv" href="/api/leads.csv${query(filter)}">Скачать CSV</a>
  </div>
  <div class="wrap"><table class="leads">
    <thead><tr><th>Уровень</th><th>Приложение</th><th>Вертикаль</th><th>Где в топе</th><th>Отзывы</th><th>Контакт</th><th>Зацепка</th></tr></thead>
    <tbody>${tr || '<tr><td colspan="7" style="text-align:center;color:var(--mut);padding:40px">Пусто — выбери, <a href="/settings">что парсить</a>, и запусти сбор</td></tr>'}</tbody>
  </table></div>`,
      css: `
  table.leads{min-width:960px}
  .fit{font-weight:700;color:var(--acc);font-size:16px} .num{text-align:right;font-variant-numeric:tabular-nums}
  .dev{color:var(--mut);font-size:12px} .src{font-size:12px;color:var(--mut)}
  .mail{font-weight:600;overflow-wrap:anywhere} td.contact{min-width:240px} td.fit-cell{min-width:110px}
  .tier{display:inline-block;margin-top:4px;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid var(--line)}
  .t-target{color:#4cc38a;border-color:#2b6b4d} .t-maybe{color:var(--warn);border-color:#6b5428} .t-skip{color:var(--mut)}`,
    }),
  );
}));

// --- Что парсить ---

const FLASH: Record<string, Flash> = {
  saved: { kind: 'ok', text: 'Сохранено. Новая выборка применится к следующему сбору.' },
};

function list(v: unknown): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map(String);
}

app.get('/settings', wrap(async (req, res) => {
  const [settings, runs] = await Promise.all([getParseSettings(), recentRuns()]);
  let flash = FLASH[String(req.query.ok ?? '')];
  if (req.query.started) flash = { kind: 'ok', text: `Сбор #${Number(req.query.started)} запущен — статус обновляется на этой странице.` };
  res.type('html').send(renderSettingsPage({ settings, run: currentRun(), runs, flash }));
}));

app.post('/settings', wrap(async (req, res) => {
  const b = req.body ?? {};
  const parsed = ParseSettingsSchema.safeParse({
    countries: list(b.countries),
    genres: list(b.genres),
    charts: list(b.charts),
    chartLimit: Number(b.chartLimit),
    maxLlmPerRun: Number(b.maxLlmPerRun),
    maxAppRatings: Number(b.maxAppRatings),
    maxPublisherRatings: Number(b.maxPublisherRatings),
    excludePublishers: String(b.excludePublishers ?? '').split(/\r?\n/),
  });
  if (!parsed.success) {
    const text = parsed.error.issues.map((i) => i.message).join('; ');
    const [settings, runs] = await Promise.all([getParseSettings(), recentRuns()]);
    res.status(400).type('html').send(renderSettingsPage({ settings, run: currentRun(), runs, flash: { kind: 'bad', text: `Не сохранено: ${text}` } }));
    return;
  }
  await saveParseSettings(parsed.data);
  if (b.action !== 'run') {
    res.redirect(303, '/settings?ok=saved');
    return;
  }
  const r = await startRun('ui');
  if (r.started) {
    res.redirect(303, `/settings?started=${r.id}`);
    return;
  }
  const runs = await recentRuns();
  res.status(409).type('html').send(renderSettingsPage({ settings: parsed.data, run: currentRun(), runs, flash: { kind: 'bad', text: `Сохранено, но сбор не запущен: ${r.reason}` } }));
}));

app.post('/runs/contacts', wrap(async (_req, res) => {
  const r = await startRun('ui', 'contacts');
  if (r.started) {
    res.redirect(303, `/settings?started=${r.id}`);
    return;
  }
  const [settings, runs] = await Promise.all([getParseSettings(), recentRuns()]);
  res.status(409).type('html').send(renderSettingsPage({ settings, run: currentRun(), runs, flash: { kind: 'bad', text: `Не запущено: ${r.reason}` } }));
}));

app.get('/api/run-status', wrap(async (_req, res) => {
  res.json({ current: currentRun(), runs: await recentRuns(5) });
}));

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ ok: false, error: 'internal error' });
});

if (!DASHBOARD_PASSWORD && process.env.NODE_ENV === 'production') {
  console.warn('⚠ DASHBOARD_PASSWORD не задан — лиды с контактами открыты всем, у кого есть URL');
}

await initSchema();
await markInterruptedRuns();
const server = app.listen(config.port, () => console.log(`🚀 http://localhost:${config.port}`));

// Деплой/перезапуск: сначала перестаём принимать запросы, потом закрываем БД и выходим.
// (Если только закрыть пул, процесс продолжит отвечать — и каждым запросом с ошибкой.)
process.on('SIGTERM', () => {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10_000).unref();
});
