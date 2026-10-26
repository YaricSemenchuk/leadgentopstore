import express, { type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { initSchema, leadStats, topLeads, pool, type LeadFilter, type LeadView } from './db/pool.js';
import { runPipeline } from './jobs/run-pipeline.js';

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

// Запуск прохода: по токену; отвечаем сразу, проход идёт в фоне (с контактами он дольше HTTP-таймаута)
let running: Promise<unknown> | null = null;
app.post('/ingest', (req, res) => {
  const auth = req.get('authorization') ?? '';
  if (!INGEST_TOKEN || !safeEqual(auth, `Bearer ${INGEST_TOKEN}`)) {
    res.status(401).json({ ok: false, error: 'нужен заголовок Authorization: Bearer <INGEST_TOKEN>' });
    return;
  }
  if (running) {
    res.status(409).json({ ok: false, error: 'проход уже идёт' });
    return;
  }
  running = runPipeline()
    .then((r) => console.log('ingest done', r))
    .catch((e) => console.error('ingest failed', (e as Error).message))
    .finally(() => (running = null));
  res.status(202).json({ ok: true, started: true });
});

// Всё остальное (лиды с контактами) — под паролем, если он задан
app.use((req, res, next) => {
  if (!DASHBOARD_PASSWORD) return next();
  const [scheme, value] = (req.get('authorization') ?? '').split(' ');
  const password = scheme === 'Basic' && value ? Buffer.from(value, 'base64').toString().split(':').slice(1).join(':') : '';
  if (safeEqual(password, DASHBOARD_PASSWORD)) return next();
  res.set('WWW-Authenticate', 'Basic realm="leads"').status(401).send('auth required');
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

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Только http(s) в href — ссылки пишут сторонние разработчики. */
const safeHref = (u: unknown) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? esc(u) : '');

const fmt = (n: unknown) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('ru-RU'));

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
      const links = [link(r.website, 'сайт'), link(r.support_url, 'поддержка'), link(r.play_url, 'Google Play')]
        .filter(Boolean)
        .join(' · ');
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
        <td class="contact">${contact}${links ? `<div class="small">${links}</div>` : ''}</td>
        <td>${esc(r.pitch_hook)}</td>
      </tr>`;
    })
    .join('');

  const tab = (active: boolean, href: string, label: string) =>
    `<a class="tab${active ? ' on' : ''}" href="/${href}">${label}</a>`;
  const viewTab = (view: LeadView, label: string) =>
    tab(filter.view === view, query({ ...filter, view }), label);

  res.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>App Store Leads</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--line:#262b36;--fg:#e8eaed;--mut:#9aa3b2;--acc:#5b8cff;--warn:#e0a84a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;padding:24px}
  h1{font-size:18px;margin:0 0 4px} .sub{color:var(--mut);margin:0 0 14px}
  .bar{display:flex;gap:8px;align-items:center;margin:0 0 14px;flex-wrap:wrap}
  .tab{padding:6px 12px;border:1px solid var(--line);border-radius:8px;color:var(--fg);text-decoration:none}
  .tab.on{border-color:var(--acc);color:var(--acc)} .csv{margin-left:auto}
  .wrap{overflow-x:auto;border-radius:10px}
  table{width:100%;border-collapse:collapse;background:var(--card);min-width:960px}
  th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
  tr:last-child td{border-bottom:none}
  .fit{font-weight:700;color:var(--acc);font-size:16px} .num{text-align:right;font-variant-numeric:tabular-nums}
  .dev{color:var(--mut);font-size:12px} .mut{color:var(--mut)} .small{font-size:12px;margin-top:2px}
  .src{font-size:12px;color:var(--mut)} .warn{color:var(--warn)}
  .mail{font-weight:600;overflow-wrap:anywhere} td.contact{min-width:240px} td.fit-cell{min-width:110px}
  .tier{display:inline-block;margin-top:4px;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid var(--line)}
  .t-target{color:#4cc38a;border-color:#2b6b4d} .t-maybe{color:var(--warn);border-color:#6b5428} .t-skip{color:var(--mut)}
  .sep{width:1px;height:22px;background:var(--line);margin:0 4px}
  a{color:var(--acc)}
</style></head><body>
  <h1>App Store Leads</h1>
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
  <div class="wrap"><table>
    <thead><tr><th>Уровень</th><th>Приложение</th><th>Вертикаль</th><th>Где в топе</th><th>Отзывы</th><th>Контакт</th><th>Зацепка</th></tr></thead>
    <tbody>${tr || '<tr><td colspan="7" style="text-align:center;color:var(--mut);padding:40px">Пусто — запусти проход: npm run ingest</td></tr>'}</tbody>
  </table></div>
</body></html>`);
}));

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ ok: false, error: 'internal error' });
});

if (!DASHBOARD_PASSWORD && process.env.NODE_ENV === 'production') {
  console.warn('⚠ DASHBOARD_PASSWORD не задан — лиды с контактами открыты всем, у кого есть URL');
}

await initSchema();
const server = app.listen(config.port, () => console.log(`🚀 http://localhost:${config.port}`));

// Деплой/перезапуск: сначала перестаём принимать запросы, потом закрываем БД и выходим.
// (Если только закрыть пул, процесс продолжит отвечать — и каждым запросом с ошибкой.)
process.on('SIGTERM', () => {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10_000).unref();
});
