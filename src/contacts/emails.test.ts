import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseDomain, extractEmails, firstMailto, rankEmails } from './emails.js';

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

test('юрфирма, GDPR-представитель и регулятор из политики отсекаются', () => {
  const r = rankEmails(
    [
      { email: 'ady.vannieuwenhuizen@fieldfisher.com', source: 'privacy_policy' },
      { email: 'rep_deepseek@prighter.com', source: 'privacy_policy' },
      { email: 'dpo@centurygame.com', source: 'privacy_policy' },
    ],
    ['https://www.centurygames.com/'],
  );
  assert.equal(r.best, null);
});

test('почта из Google Play важнее адресов со страниц', () => {
  const r = rankEmails(
    [
      { email: 'hello@studio.io', source: 'website' },
      { email: 'support@studio.io', source: 'google_play' },
    ],
    ['https://studio.io'],
  );
  assert.equal(r.best?.email, 'support@studio.io');
  assert.deepEqual(r.others, ['hello@studio.io']);
});

test('обычный адрес на домене разработчика лучше privacy@', () => {
  const r = rankEmails(
    [
      { email: 'privacy@amo.co', source: 'support_page' },
      { email: 'love@amo.co', source: 'support_page' },
    ],
    ['https://www.amo.co/privacy-policy/'],
  );
  assert.equal(r.best?.email, 'love@amo.co');
});

test('бесплатный ящик помечается как личный', () => {
  const r = rankEmails([{ email: 'indie.dev@gmail.com', source: 'google_play' }], []);
  assert.equal(r.best?.email, 'indie.dev@gmail.com');
  assert.equal(r.personal, true);
});

test('личный gmail со сторонней страницы без роли не берётся', () => {
  const r = rankEmails([{ email: 'globallaas@gmail.com', source: 'privacy_policy' }], ['https://37games.com']);
  assert.equal(r.best, null);
});
