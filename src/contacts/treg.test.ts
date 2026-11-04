import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeVerdict, parseEmailFind, parseEmployees, parseVerify, SIZE_PROVIDERS, startTregBudget, toCompanyEnrich, tregCall,
  tregCompanySize, TregBudget, TregError,
} from './treg.js';
import { buildCompanyEmails } from './emails.js';

// Ответы в форме маршрутизируемых инструментов Treg {output, raw, _treg}; люди и компании вымышленные.

test('Treg: размер компании в разных записях', () => {
  assert.deepEqual(parseEmployees('51-200'), { range: '51-200', min: 51 });
  assert.deepEqual(parseEmployees('51-200 employees'), { range: '51-200', min: 51 });
  assert.deepEqual(parseEmployees('1,001-5,000'), { range: '1001-5000', min: 1001 });
  assert.deepEqual(parseEmployees('10001+'), { range: '10001+', min: 10001 });
  assert.deepEqual(parseEmployees('1K-5K'), { range: '1000-5000', min: 1000 });
  assert.deepEqual(parseEmployees('201 – 500'), { range: '201-500', min: 201 });
  assert.deepEqual(parseEmployees(64), { range: '64', min: 64 });
  assert.deepEqual(parseEmployees('120'), { range: '120', min: 120 });
  assert.equal(parseEmployees('unknown'), null);
  assert.equal(parseEmployees(''), null);
  assert.equal(parseEmployees(null), null);
  assert.equal(parseEmployees('500-50'), null);
});

test('Treg: размер из ответов провайдеров; на чужом домене не берём', () => {
  const [leadocean, tca, hunter] = SIZE_PROVIDERS;
  const lo = toCompanyEnrich(leadocean.parse({ data: { company_data: { company_name: 'Fuse Games', company_domain: 'fusegames.io', company_employees: 64 } } })!, 'fusegames.io', leadocean.id);
  assert.deepEqual(lo.size, { range: '64', min: 64 });
  const t = toCompanyEnrich(tca.parse({ about: { name: 'Fuse', totalEmployees: '51-200', totalEmployeesExact: 120 }, domain: { domain: 'fusegames.io' } })!, 'fusegames.io', tca.id);
  assert.deepEqual(t.size, { range: '51-200', min: 51 });
  const h = toCompanyEnrich(hunter.parse({ data: { name: 'Fuse', domain: 'www.fusegames.io', metrics: { employees: '10K-50K' }, linkedin: { handle: 'company/fuse' } } })!, 'fusegames.io', hunter.id);
  assert.deepEqual(h.size, { range: '10000-50000', min: 10000 });
  assert.equal(h.linkedinUrl, 'https://www.linkedin.com/company/fuse');
  const other = toCompanyEnrich(tca.parse({ about: { name: 'Fuse Bank', totalEmployees: '5k-10k' }, domain: { domain: 'fusebank.com' } })!, 'fusegames.io', tca.id);
  assert.equal(other.size, null);
  assert.equal(other.foreign, true);
  // компании нет
  assert.equal(leadocean.parse({ data: {} }), null);
  assert.equal(tca.parse({}), null);
  assert.equal(hunter.parse({ errors: [] }), null);
});

test('Treg: размер — провайдеры по очереди до первого ответа с численностью, 404 бесплатный и не ошибка', async () => {
  startTregBudget(1);
  const seen: string[] = [];
  const replies: Record<string, { status: number; body: unknown; cost?: string }> = {
    'leadocean.companies.enrich': { status: 404, body: { error: 'not found' } },
    // нашлась, но без численности — платим и идём дальше
    'thecompaniesapi.companies.enrich': { status: 200, body: { about: { name: 'Fuse' }, domain: { domain: 'fusegames.io' } }, cost: '1900' },
    'hunter.companies.enrich': { status: 200, body: { data: { name: 'Fuse', domain: 'fusegames.io', metrics: { employees: '11-50' } } }, cost: '4900' },
  };
  const f = (async (url: string | URL) => {
    const id = new URL(String(url)).pathname.replace('/call/', '');
    seen.push(String(url));
    const r = replies[id];
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'x-treg-cost-micro': r.cost ?? '0' } });
  }) as typeof fetch;
  const { result, costUsd } = await tregCompanySize('fusegames.io', 't', f);
  assert.deepEqual(result?.size, { range: '11-50', min: 11 });
  assert.equal(result?.servedBy, 'hunter.companies.enrich');
  assert.equal(Math.round(costUsd * 1e6), 6800);
  assert.equal(seen.length, 3);
  assert.equal(seen[1], 'https://treg.to/call/thecompaniesapi.companies.enrich?domain=fusegames.io');
});

test('Treg: почта по имени — только на домене компании, вердикт проверки Treg важнее отметки провайдера', () => {
  const hit = parseEmailFind(200, {
    output: { email: 'Emre.Kaya@FuseGames.io', verified: false },
    _treg: { served_by: 'blitzapi', domain_match: true, verification: { verdict: 'valid' } },
  }, ['fusegames.io']);
  assert.deepEqual(hit, { email: 'emre.kaya@fusegames.io', status: 'valid', servedBy: 'blitzapi', foreign: false, pending: false });

  // прошлый работодатель из LinkedIn — адрес не берём (вызов всё равно оплачен)
  const former = parseEmailFind(200, { output: { email: 'emre@oldstudio.com' }, _treg: { domain_match: false } }, ['fusegames.io']);
  assert.equal(former.email, null);
  assert.equal(former.foreign, true);

  // поддомен почты — тот же регистрируемый домен
  const sub = parseEmailFind(200, { output: { email: 'emre@mail.fusegames.io', verified: true } }, ['fusegames.io']);
  assert.equal(sub.email, 'emre@mail.fusegames.io');
  assert.equal(sub.status, 'valid');

  const miss = parseEmailFind(200, { output: { email: null }, _treg: { served_by: 'trykitt' } }, ['fusegames.io']);
  assert.equal(miss.email, null);
  assert.equal(miss.foreign, false);

  const pending = parseEmailFind(202, { _treg: { outcome: 'pending' } }, ['fusegames.io']);
  assert.equal(pending.pending, true);
  assert.equal(parseEmailFind(502, { detail: 'route_failed' }, ['fusegames.io']).email, null);
});

test('Treg: вердикты проверки приводятся к четырём словам', () => {
  assert.equal(normalizeVerdict('Deliverable'), 'valid');
  assert.equal(normalizeVerdict('undeliverable'), 'invalid');
  assert.equal(normalizeVerdict('catch-all'), 'accept_all');
  assert.equal(normalizeVerdict('accept_all'), 'accept_all');
  assert.equal(normalizeVerdict('risky'), 'accept_all');
  assert.equal(normalizeVerdict('something'), 'unknown');
  assert.equal(normalizeVerdict(null, true), 'valid');
  assert.equal(normalizeVerdict(null, null), null);
  assert.deepEqual(parseVerify({ output: { valid: false, status: 'invalid' }, _treg: { served_by: 'contactout' } }), { status: 'invalid', servedBy: 'contactout' });
  assert.deepEqual(parseVerify({ output: { status: null } }), { status: null, servedBy: null });
});

test('Treg: бюджет прогона резервирует максимум вызова и списывает факт', () => {
  const b = new TregBudget(0.05);
  assert.equal(b.reserve(0.04), true);
  assert.equal(b.reserve(0.02), false);       // 0.04 в резерве + 0.02 > 0.05
  b.settle(0.04, 0.005);
  assert.equal(b.reserve(0.04), true);        // 0.005 потрачено + 0.04
  b.settle(0.04, 0);
  assert.equal(b.spentUsd, 0.005);
  assert.equal(b.calls, 2);
});

type Reply = { status: number; body: unknown; headers?: Record<string, string> };
function fakeFetch(replies: Reply[], seen: Array<{ url: string; init: RequestInit }> = []): typeof fetch {
  let i = 0;
  return (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    const r = replies[Math.min(i++, replies.length - 1)];
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as typeof fetch;
}

test('Treg: вызов — токен в X-Treg-Token, потолок цены, цена из X-Treg-Cost-Micro', async () => {
  const budget = startTregBudget(1);
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const r = await tregCall(
    'treg.people.email.verify',
    { method: 'POST', body: { email: 'a@b.io' }, maxCostUsd: 0.015 },
    'trg_test',
    fakeFetch([{ status: 200, body: { output: { valid: true, status: 'valid' } }, headers: { 'x-treg-cost-micro': '1500', 'x-treg-served-by': 'orbisearch' } }], seen),
  );
  assert.equal(seen[0].url, 'https://treg.to/call/treg.people.email.verify');
  const h = seen[0].init.headers as Record<string, string>;
  assert.equal(h['X-Treg-Token'], 'trg_test');
  assert.equal(h['X-Treg-Route-Max-Cost'], '0.015');
  assert.ok(h['Idempotency-Key']);
  assert.equal(seen[0].init.body, '{"email":"a@b.io"}');
  assert.equal(r.costUsd, 0.0015);
  assert.equal(r.servedBy, 'orbisearch');
  assert.equal(budget.spentUsd, 0.0015);
});

test('Treg: GET с параметрами (Hunter через Treg)', async () => {
  startTregBudget(1);
  const seen: Array<{ url: string; init: RequestInit }> = [];
  await tregCall('hunter.companies.emails', { method: 'GET', query: { domain: 'studio.io', limit: 10 }, maxCostUsd: 0.03 }, 't',
    fakeFetch([{ status: 200, body: { data: {} } }], seen));
  assert.equal(seen[0].url, 'https://treg.to/call/hunter.companies.emails?domain=studio.io&limit=10');
  assert.equal(seen[0].init.method, 'GET');
  assert.equal(seen[0].init.body, undefined);
});

test('Treg: кончился баланс и отклонённый токен — фатально, потолок цены — нет', async () => {
  startTregBudget(1);
  await assert.rejects(
    tregCall('x', { body: {}, maxCostUsd: 0.01 }, 't', fakeFetch([{ status: 402, body: { detail: { error: 'insufficient_balance', balance_micro: 0 } }, headers: { 'x-treg-error': '1' } }])),
    (e: unknown) => e instanceof TregError && e.fatal && e.code === 'insufficient_balance',
  );
  await assert.rejects(
    tregCall('x', { body: {}, maxCostUsd: 0.01 }, 't', fakeFetch([{ status: 401, body: { detail: 'invalid token' }, headers: { 'x-treg-error': '1' } }])),
    (e: unknown) => e instanceof TregError && e.fatal && e.code === 'auth',
  );
  await assert.rejects(
    tregCall('x', { body: {}, maxCostUsd: 0.01 }, 't', fakeFetch([{ status: 402, body: { detail: 'route_max_cost' }, headers: { 'x-treg-error': '1' } }])),
    (e: unknown) => e instanceof TregError && !e.fatal,
  );
  // 401 провайдера (без X-Treg-Error) — ошибка этого вызова, а не токена Treg
  await assert.rejects(
    tregCall('x', { body: {}, maxCostUsd: 0.01 }, 't', fakeFetch([{ status: 401, body: { message: 'provider says no' } }])),
    (e: unknown) => e instanceof TregError && !e.fatal,
  );
});

test('Treg: промах всего маршрута (502 route_failed) — не ошибка, цена промаха из тела', async () => {
  const budget = startTregBudget(1);
  const r = await tregCall('treg.people.email.find', { body: {}, maxCostUsd: 0.04 }, 't',
    fakeFetch([{ status: 502, body: { detail: 'route_failed', tried: ['a', 'b'], charged_micro: 300 }, headers: { 'x-treg-error': '1' } }]));
  assert.equal(r.status, 502);
  assert.equal(r.costUsd, 0.0003);
  assert.equal(budget.spentUsd, 0.0003);
});

test('Treg: бюджет прогона исчерпан — вызова нет', async () => {
  startTregBudget(0.01);
  const seen: Array<{ url: string; init: RequestInit }> = [];
  await assert.rejects(
    tregCall('x', { body: {}, maxCostUsd: 0.04 }, 't', fakeFetch([{ status: 200, body: {} }], seen)),
    (e: unknown) => e instanceof TregError && e.fatal && e.code === 'run_budget',
  );
  assert.equal(seen.length, 0);
});

test('Treg: повтор после сетевого сбоя — с тем же Idempotency-Key', async () => {
  startTregBudget(1);
  const keys: string[] = [];
  let n = 0;
  const flaky = (async (_u: string | URL, init?: RequestInit) => {
    keys.push((init?.headers as Record<string, string>)['Idempotency-Key']);
    if (n++ === 0) throw new Error('socket hang up');
    return new Response('{"output":{}}', { status: 200 });
  }) as typeof fetch;
  await tregCall('x', { body: {}, maxCostUsd: 0.01 }, 't', flaky);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

const ctx = { company: 'Fuse Games', domains: ['fusegames.io'], people: [{ name: 'Emre Kaya', title: 'CEO' }, { name: 'Ayse Demir', title: 'Marketing' }], individual: false };

test('почта: проверка подтвердила адрес по шаблону — он становится обычным личным', () => {
  const r = buildCompanyEmails(
    [{ email: 'support@fusegames.io', source: 'google_play' }],
    ctx,
    { pattern: '{first}.{last}', domain: 'fusegames.io' },
    { 'emre.kaya@fusegames.io': { status: 'valid', at: '2026-11-04T00:00:00Z' }, 'ayse.demir@fusegames.io': { status: 'invalid', at: '2026-11-04T00:00:00Z' } },
  );
  const emre = r.emails.find((e) => e.email === 'emre.kaya@fusegames.io');
  assert.equal(emre?.guessed, false);
  assert.equal(emre?.status, 'valid');
  assert.deepEqual(emre?.sources, ['pattern']);
  assert.equal(r.best?.email, 'emre.kaya@fusegames.io');
  // несуществующий ящик выброшен
  assert.equal(r.emails.some((e) => e.email === 'ayse.demir@fusegames.io'), false);
});

test('почта: несуществующий опубликованный адрес выпадает, адрес из Treg привязан к человеку', () => {
  const r = buildCompanyEmails(
    [
      { email: 'old.ceo@fusegames.io', source: 'website' },
      { email: 'emre@fusegames.io', source: 'treg', person: 'Emre Kaya', title: 'CEO' },
      { email: 'info@fusegames.io', source: 'website' },
    ],
    ctx,
    null,
    { 'old.ceo@fusegames.io': { status: 'invalid', at: '2026-11-04T00:00:00Z' }, 'info@fusegames.io': { status: 'accept_all', at: '2026-11-04T00:00:00Z' } },
  );
  assert.deepEqual(r.emails.filter((e) => !e.guessed).map((e) => e.email), ['emre@fusegames.io', 'info@fusegames.io']);
  // emre@ у Emre Kaya — шаблон {first}: Ayse получает адрес на проверку
  assert.deepEqual(r.emails.filter((e) => e.guessed).map((e) => e.email), ['ayse@fusegames.io']);
  assert.equal(r.best?.person, 'Emre Kaya');
  assert.equal(r.emails[1].status, 'accept_all');
  // без проверок поле status не появляется
  assert.equal('status' in r.emails[0], false);
});

test('почтовые домены компании: сначала из адресов в сторах, хостинг app-ads.txt и соцсети — не её', async () => {
  const { mailDomains, developerDomains } = await import('./company.js');
  assert.deepEqual(
    mailDomains(
      [
        { email: 'thanhlx@roosterx.vn', sources: ['app_store_trader'], free: false },
        { email: 'dev@gmail.com', sources: ['google_play'], free: true },
        { email: 'ann@guessed.io', sources: [], guessed: true },
        { email: 'info@agency.com', sources: ['website'] },
      ],
      ['https://x5dfde4eb.app-ads-txt.com', 'https://sites.google.com/roosterx.vn/privacy', 'https://roosterx.vn/terms'],
    ),
    ['roosterx.vn'],
  );
  assert.deepEqual(developerDomains(['https://www.facebook.com/studio', 'https://studio.games/']), ['studio.games']);
});

test('Treg: бюджет ждёт резерв параллельных вызовов и отказывает только по факту расходов', async () => {
  const b = new TregBudget(0.05);
  assert.equal(await b.acquire(0.03), true);
  const second = b.acquire(0.03);              // 0.03 в резерве + 0.03 > 0.05 — ждёт
  setTimeout(() => b.settle(0.03, 0.001), 150); // первый вызов стоил $0.001
  assert.equal(await second, true);
  b.settle(0.03, 0.03);
  assert.equal(await b.acquire(0.03), false);  // 0.031 потрачено + 0.03 > 0.05
});

test('почта: адрес из Treg даёт шаблон домена — остальным людям составляются адреса на проверку', () => {
  const r = buildCompanyEmails([{ email: 'emre.kaya@fusegames.io', source: 'treg', person: 'Emre Kaya', title: 'CEO' }], ctx);
  assert.deepEqual(r.pattern, { pattern: '{first}.{last}', domain: 'fusegames.io' });
  assert.deepEqual(r.emails.filter((e) => e.guessed).map((e) => e.email), ['ayse.demir@fusegames.io']);
});
