import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCountry, parsePlayDeveloper, parsePlayDeveloperPage, parseTrader, packageCandidates } from './store-pages.js';
import { companyKind, developerDomains } from './company.js';

// Фикстуры повторяют форму реальных страниц (октябрь 2026); телефоны, адреса и имена людей вымышленные.

const text = (rawText: string) => ({ $kind: 'linkableText', linkableText: { styledText: { rawText } } });

test('App Store ЕС: блок продавца — D-U-N-S, адрес, телефон, почта', () => {
  const items = [
    { title: 'Category', summary: 'Puzzle', items: [] },
    {
      title: 'Provider',
      summary: 'Fuse Entertainment INC',
      items: [
        text('Fuse Entertainment INC has identified itself as a trader for this app and confirmed that this product or service complies with European Union law.'),
        { $kind: 'spacer' },
        text('**DUNS Number**\n123456789'),
        text('**Address**\n100 Example St\nWilmington Delaware 19806\nUnited States'),
        text('**Phone Number**\n+1 5550000000'),
        text('**Email**\nlegal@fusegames.io'),
      ],
    },
  ];
  assert.deepEqual(parseTrader(items), {
    isTrader: true,
    duns: '123456789',
    address: '100 Example St, Wilmington Delaware 19806, United States',
    country: 'United States',
    phone: '+1 5550000000',
    email: 'legal@fusegames.io',
  });
});

test('App Store ЕС: локализованные подписи (Anbieter) и частное лицо без статуса торговца', () => {
  const de = parseTrader([{ title: 'Anbieter', items: [
    text('X Ltd hat sich als Händler für diese App ausgewiesen.'),
    text('**D-U-N-S-Nummer**\n987654321'),
    text('**E-Mail**\ndev@x.games'),
  ] }]);
  assert.equal(de?.duns, '987654321');
  assert.equal(de?.email, 'dev@x.games');
  const person = parseTrader([{ title: 'Provider', items: [
    text('Ana Lima has not identified itself as a trader for this app. If you are a consumer in the European Economic Area, consumer rights do not apply.'),
  ] }]);
  assert.equal(person?.isTrader, false);
  assert.equal(person?.duns, null);
  assert.equal(companyKind('Ana Maria de Lima', person), 'individual');
  assert.equal(companyKind('Ana Lima', de), 'company');
});

test('страна ищется в любом месте адреса: в Гонконге она первой строкой', () => {
  assert.equal(detectCountry('Hong Kong, Causeway Bay, Rm 1450 14/F EXAMPLE TWR, 8 EXAMPLE AVE'), 'Hong Kong');
  assert.equal(detectCountry('1 Example Rd, Atlanta Georgia 30303, United States'), 'United States');
  assert.equal(detectCountry('Mustafa Kemal Mah., Ankara Türkiye'), 'Türkiye');
  assert.equal(detectCountry('Somewhere 5'), null);
});

test('Google Play: «About the developer» — юрлицо, почта аккаунта, адрес, телефон', () => {
  const html = `<body><div><h2>App support</h2><a href="mailto:support@fusegames.io"><div>Support email</div><div>support@fusegames.io</div></a></div>
    <div><header><h2>About the developer</h2></header><div><div>Fuse Entertainment Inc.</div><div>deniz@fusegames.io</div>
    <div>100 Example St Ste 1
Wilmington, DE 19806
United States</div><div>+1 555-000-0000</div></div></div><div><h2>Similar games</h2></div></body>`;
  assert.deepEqual(parsePlayDeveloper(html), {
    name: 'Fuse Entertainment Inc.',
    email: 'deniz@fusegames.io',
    address: '100 Example St Ste 1, Wilmington, DE 19806, United States',
    phone: '+1 555-000-0000',
  });
  assert.equal(parsePlayDeveloper('<body><h2>About this game</h2></body>'), null);
  // без телефона: блок кончается на «More by …», а не забирает названия приложений
  const noPhone = `<body><h2>About the developer</h2><div>Ana Lima</div><div>dev.ana@gmail.com</div><div>R. Exemplo, 1
Suzano - SP, Brazil</div><div><h2>More by Insanity Group</h2><i>arrow_forward</i></div><div>Projeto Grau</div></body>`;
  assert.deepEqual(parsePlayDeveloper(noPhone), { name: 'Ana Lima', email: 'dev.ana@gmail.com', address: 'R. Exemplo, 1, Suzano - SP, Brazil', phone: null });
});

test('Google Play: приложения разработчика со страницы developer?id=', () => {
  const card = (id: string, name: string) =>
    `<a href="/store/apps/details?id=${id}"><img><div><span class="DdYX5">${name}</span></div><div><span>DRAGONVALE LIMITED</span></div></a>`;
  const html = `<body>${card('com.dvgame.hotpottm', 'Happy&nbsp;Restaurant®3D')}${card('com.dvg.colorarrow', 'Happy Arrow Master')}${card('com.dvgame.hotpottm', 'dup')}</body>`;
  assert.deepEqual(parsePlayDeveloperPage(html), [
    { packageId: 'com.dvgame.hotpottm', name: 'Happy Restaurant®3D' },
    { packageId: 'com.dvg.colorarrow', name: 'Happy Arrow Master' },
  ]);
});

test('Android-пакет из bundleId: целиком и без сегмента ios', () => {
  assert.deepEqual(packageCandidates('ios.busjam.traffic.puzzle'), ['ios.busjam.traffic.puzzle', 'busjam.traffic.puzzle']);
});

test('домены разработчика: платформы поддержки и политик не считаются', () => {
  assert.deepEqual(
    developerDomains(['https://games.playchamps.com/', 'https://playchamp.zohodesk.com/portal', 'https://www.termly.io/policy/x', null]),
    ['playchamps.com'],
  );
});
