import type { CurrentRun } from '../jobs/runner.js';

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Только http(s) в href — ссылки пишут сторонние разработчики. */
export const safeHref = (u: unknown) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? esc(u) : '');

export const fmt = (n: unknown) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('ru-RU'));

export function ago(d: Date): string {
  const min = Math.round((Date.now() - d.getTime()) / 60_000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} ч ${min % 60} мин назад` : d.toLocaleString('ru-RU');
}

const CSS = `
  :root{--bg:#0f1115;--card:#171a21;--line:#262b36;--fg:#e8eaed;--mut:#9aa3b2;--acc:#5b8cff;--warn:#e0a84a;--ok:#4cc38a;--bad:#e06c6c}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;padding:0 24px 40px}
  a{color:var(--acc)}
  nav{display:flex;gap:18px;align-items:center;padding:14px 0;margin-bottom:18px;border-bottom:1px solid var(--line);flex-wrap:wrap}
  nav .brand{font-weight:700} nav a{color:var(--mut);text-decoration:none} nav a.on{color:var(--fg)}
  nav .run{margin-left:auto;color:var(--warn);font-size:13px}
  h1{font-size:18px;margin:0 0 4px} h2{font-size:15px;margin:0 0 10px} .sub{color:var(--mut);margin:0 0 14px}
  .bar{display:flex;gap:8px;align-items:center;margin:0 0 14px;flex-wrap:wrap}
  .tab,button,.btn{padding:6px 12px;border:1px solid var(--line);border-radius:8px;color:var(--fg);text-decoration:none;background:transparent;font:inherit;cursor:pointer}
  .tab.on{border-color:var(--acc);color:var(--acc)} .csv{margin-left:auto}
  button.primary{background:var(--acc);border-color:var(--acc);color:#fff} button:disabled{opacity:.5;cursor:not-allowed}
  .wrap{overflow-x:auto;border-radius:10px}
  table{width:100%;border-collapse:collapse;background:var(--card)}
  th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
  tr:last-child td{border-bottom:none}
  .mut{color:var(--mut)} .small{font-size:12px;margin-top:2px} .warn{color:var(--warn)} .ok{color:var(--ok)} .bad{color:var(--bad)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
  .flash{padding:10px 14px;border-radius:8px;margin-bottom:16px;border:1px solid var(--line)}
  .flash.ok{border-color:#2b6b4d} .flash.bad{border-color:#7a3434}
  .sep{width:1px;height:22px;background:var(--line);margin:0 4px}
`;

export function page(opts: { title: string; active: 'leads' | 'settings'; run: CurrentRun | null; body: string; css?: string }): string {
  const navLink = (href: string, key: string, label: string) =>
    `<a href="${href}" class="${opts.active === key ? 'on' : ''}">${label}</a>`;
  const run = opts.run
    ? `<a class="run" href="/settings">● идёт сбор #${opts.run.id}: ${esc(opts.run.stage)}</a>`
    : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
<style>${CSS}${opts.css ?? ''}</style></head><body>
<nav><span class="brand">App Store Leads</span>${navLink('/', 'leads', 'Лиды')}${navLink('/settings', 'settings', 'Что парсить')}${run}</nav>
${opts.body}
</body></html>`;
}
