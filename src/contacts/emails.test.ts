import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseDomain, buildCompanyEmails, classifyEmail, extractEmails, firstMailto, type EmailContext, type FoundEmail } from './emails.js';

// Фикстуры повторяют реальные случаи со страниц разработчиков (октябрь 2026).

test('текст соседних элементов не склеивается с адресом', () => {
  const html = '<body><div><span>toplords-support@gamespark.net</span><span>Address</span></div></body>';
  assert.deepEqual(extractEmails(html), ['toplords-support@gamespark.net']);
});

test('адрес из встроенного JSON (сайты на Next.js)', () => {
  const html = '<body><div id="root"></div><script id="__NEXT_DATA__" type="application/json">{"c":"\\u003efeedback@pure.app"}</script></body>';
  assert.deepEqual(extractEmails(html), ['feedback@pure.app']);
});

test('mailto с параметрами и несколькими адресами', () => {
  const html = '<a href="mailto:hello@studio.io,bd@studio.io?subject=Hi">write</a>';
  assert.deepEqual(extractEmails(html).sort(), ['bd@studio.io', 'hello@studio.io']);
});

test('noreply, картинки и заглушки отбрасываются', () => {
  const html = '<body>store-noreply@plaud.ai logo@2x.png you@example.com support@plaud.ai</body>';
  assert.deepEqual(extractEmails(html), ['support@plaud.ai']);
});

test('Google Play: берётся первый mailto — контакт разработчика', () => {
  const html = '<a href="mailto:contact@zeta-ai.io">contact@zeta-ai.io</a><a href="mailto:other@similar.app">x</a>';
  assert.equal(firstMailto(html), 'contact@zeta-ai.io');
});

test('baseDomain снимает поддомены и понимает co.kr', () => {
  assert.equal(baseDomain('https://help.plaud.ai/x'), 'plaud.ai');
  assert.equal(baseDomain('www.nexon.co.kr'), 'nexon.co.kr');
});

const ctx = (over: Partial<EmailContext> = {}): EmailContext => ({ company: null, domains: [], people: [], individual: false, ...over });
const build = (found: FoundEmail[], over: Partial<EmailContext> = {}) => buildCompanyEmails(found, ctx(over));

test('маскировка «name [at] domain [dot] com» распознаётся', () => {
  assert.deepEqual(extractEmails('<body>Write to anna [at] studio [dot] io</body>'), ['anna@studio.io']);
});

test('юрфирма, GDPR-представитель и регулятор из политики отсекаются', () => {
  const r = build(
    [
      { email: 'ady.vannieuwenhuizen@fieldfisher.com', source: 'privacy_policy' },
      { email: 'rep_deepseek@prighter.com', source: 'privacy_policy' },
      { email: 'casework@ico.org.uk', source: 'privacy_policy' },
    ],
    { domains: ['centurygames.com'] },
  );
  assert.equal(r.best, null);
  assert.deepEqual(r.emails, []);
});

test('личный адрес и общий ящик: имя — личный, роль или бренд — общий', () => {
  const c = { company: 'Fuse Entertainment INC', domains: ['fusegames.io'], individual: false };
  assert.equal(classifyEmail('deniz@fusegames.io', c), 'personal');
  assert.equal(classifyEmail('ann.lee@fusegames.io', c), 'personal');
  assert.equal(classifyEmail('ceo@fusegames.io', c), 'personal');
  assert.equal(classifyEmail('support@fusegames.io', c), 'role');
  assert.equal(classifyEmail('fusedelaware@fusegames.io', c), 'role');
  assert.equal(classifyEmail('developergame@dragonvalegames.com', c), 'role');
  assert.equal(classifyEmail('fingerrush.customerservice@outlook.com', c), 'role');
  assert.equal(classifyEmail('244contato@gmail.com', c), 'role');
  // «mail» внутри имени — не роль
  assert.equal(classifyEmail('ismail@fusegames.io', c), 'personal');
});

test('личный адрес идёт первым, затем партнёрский ящик, поддержка, юридический', () => {
  const r = build(
    [
      { email: 'support@fusegames.io', source: 'google_play' },
      { email: 'privacy@fusegames.io', source: 'privacy_policy' },
      { email: 'partners@fusegames.io', source: 'website' },
      { email: 'deniz@fusegames.io', source: 'play_developer' },
    ],
    { company: 'Fuse Entertainment INC', domains: ['fusegames.io'] },
  );
  assert.deepEqual(r.emails.map((e) => e.email), ['deniz@fusegames.io', 'partners@fusegames.io', 'support@fusegames.io', 'privacy@fusegames.io']);
  assert.equal(r.best?.kind, 'personal');
});

test('одинаковый адрес из разных источников — одна запись со всеми источниками', () => {
  const r = build(
    [
      { email: 'info@lava.gs', source: 'app_store_trader' },
      { email: 'info@lava.gs', source: 'google_play' },
      { email: 'info@lava.gs', source: 'website' },
    ],
    { domains: ['lava.gs'] },
  );
  assert.equal(r.emails.length, 1);
  assert.deepEqual(r.emails[0].sources, ['app_store_trader', 'google_play', 'website']);
});

test('домен адреса из стора считается доменом разработчика: адрес с сайта на нём берётся', () => {
  const r = build(
    [
      { email: 'support@studio.io', source: 'google_play' },
      { email: 'maria@studio.io', source: 'website' },
    ],
    { domains: ['studio-games.com'] },
  );
  assert.ok(r.emails.some((e) => e.email === 'maria@studio.io' && e.kind === 'personal'));
});

test('адрес привязывается к человеку из LinkedIn, по шаблону составляются адреса остальных', () => {
  const r = build(
    [
      { email: 'emre.kaya@fusegames.io', source: 'website' },
      { email: 'support@fusegames.io', source: 'google_play' },
    ],
    {
      company: 'Fuse Entertainment INC',
      domains: ['fusegames.io'],
      people: [
        { name: 'Emre Kaya', title: 'Co-Founder' },
        { name: 'Şule Yıldız', title: 'Head of Marketing' },
        { name: 'Li', title: 'CEO' },
      ],
    },
  );
  const emre = r.emails.find((e) => e.email === 'emre.kaya@fusegames.io');
  assert.equal(emre?.person, 'Emre Kaya');
  assert.deepEqual(r.pattern, { pattern: '{first}.{last}', domain: 'fusegames.io' });
  const guess = r.emails.find((e) => e.guessed);
  assert.equal(guess?.email, 'sule.yildiz@fusegames.io');
  assert.equal(guess?.person, 'Şule Yıldız');
  // угаданный адрес не бывает лучшим
  assert.equal(r.best?.email, 'emre.kaya@fusegames.io');
});

test('без подтверждённого шаблона адреса не угадываются', () => {
  const r = build([{ email: 'deniz@fusegames.io', source: 'play_developer' }], {
    domains: ['fusegames.io'],
    people: [{ name: 'Ann Lee', title: 'CEO' }],
  });
  assert.equal(r.pattern, null);
  assert.equal(r.emails.filter((e) => e.guessed).length, 0);
});

test('gmail частного разработчика из стора — личный и лучший', () => {
  const r = build([{ email: 'indie.dev@gmail.com', source: 'google_play' }], { individual: true });
  assert.equal(r.best?.email, 'indie.dev@gmail.com');
  assert.equal(r.best?.kind, 'personal');
  assert.equal(r.best?.free, true);
});

test('личный gmail со сторонней страницы без роли не берётся', () => {
  const r = build([{ email: 'globallaas@gmail.com', source: 'privacy_policy' }], { domains: ['37games.com'] });
  assert.equal(r.best, null);
});

test('ящики команды и отдела — общие, даже без слова support', () => {
  const c = { company: 'EVISTA PTE. LTD.', domains: ['yg.ltd'], individual: false };
  for (const e of ['devteam@yg.ltd', 'engineering@venice.ai', 'labs@pawnese.com', 'evitechnology2022@gmail.com', 'supoprt@gryphon.games']) {
    assert.equal(classifyEmail(e, c), 'role', e);
  }
  assert.equal(classifyEmail('robert.vigafun95@gmail.com', c), 'personal');
  assert.equal(classifyEmail('huanqing.liu@dongzhougame.com', c), 'personal');
});
