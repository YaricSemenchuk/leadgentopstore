import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandFrom, brandFromWebsite, companyName, extractLinkedIn, linkedinSearchLinks, looksLikePerson } from './linkedin.js';

test('ссылка на компанию из подвала сайта нормализуется', () => {
  const html = '<footer><a href="https://tr.linkedin.com/company/fusegamestr?trk=footer">in</a></footer>';
  assert.deepEqual(extractLinkedIn(html), [{ url: 'https://www.linkedin.com/company/fusegamestr/', kind: 'company' }]);
});

test('компания идёт раньше личного профиля, share-ссылки не берутся', () => {
  const html = `<a href="https://www.linkedin.com/in/jane-doe/">Jane</a>
    <a href="https://www.linkedin.com/shareArticle?url=x">share</a>
    <a href="https://linkedin.com/company/playdigious/">Playdigious</a>`;
  assert.deepEqual(
    extractLinkedIn(html).map((l) => l.kind),
    ['company', 'person'],
  );
});

test('ссылка из встроенного JSON (экранированные слэши)', () => {
  const html = '<script>{"social":"https:\\/\\/www.linkedin.com\\/company\\/lava-games"}</script>';
  assert.equal(extractLinkedIn(html)[0]?.url, 'https://www.linkedin.com/company/lava-games/');
});

test('юридический хвост снимается, название остаётся', () => {
  assert.equal(companyName('HURELAX PTE. LTD.'), 'HURELAX');
  assert.equal(companyName('Combo Yazilim Anonim Sirketi'), 'Combo');
  assert.equal(companyName('Chengdu Runyou Technology Co., Ltd'), 'Chengdu Runyou Technology');
  assert.equal(companyName('PT SANDI DAYA GUNA'), 'SANDI DAYA GUNA');
  assert.equal(companyName('Limited'), 'Limited');
  assert.equal(companyName('ALAR INVEST SP Z O O'), 'ALAR INVEST');
  assert.equal(companyName('LAVA LABS OYUN YAZILIM VE PAZARLAMA ANONIM SIRKETI'), 'LAVA LABS');
  assert.equal(companyName('PAWNESE HK LIMITED'), 'PAWNESE');
});

test('частное лицо распознаётся, компания — нет', () => {
  assert.equal(looksLikePerson('Luong Vuong'), true);
  assert.equal(looksLikePerson('Antoine Munch'), true);
  assert.equal(looksLikePerson('Fuse Entertainment INC'), false);
  assert.equal(looksLikePerson('5minlab'), false);
});

test('бренд берётся из домена сайта, платформы — нет', () => {
  assert.equal(brandFromWebsite('https://www.lastshelter.net/'), 'lastshelter');
  assert.equal(brandFromWebsite('https://muza-technologies.com/vpn'), 'muza technologies');
  assert.equal(brandFromWebsite('https://www.neptunecompany.co.kr'), 'neptunecompany');
  assert.equal(brandFromWebsite('https://foo.github.io/app'), null);
  assert.equal(brandFromWebsite('https://sites.google.com/view/x'), null);
  assert.equal(brandFromWebsite(null), null);
});

test('ссылки поиска: бренд и юрлицо точной фразой, люди через Google с ролями', () => {
  const l = linkedinSearchLinks('LAST ORIGIN STUDIO LIMITED', 'https://www.lastshelter.net/');
  assert.match(decodeURIComponent(l.company), /companies\/\?keywords="lastshelter"$/);
  const people = decodeURIComponent(l.people);
  assert.match(people, /google\.com\/search\?q=site:linkedin\.com\/in \("lastshelter" OR "LAST ORIGIN STUDIO"\)/);
  assert.match(people, /CEO OR founder/);
  assert.match(decodeURIComponent(l.google), /site:linkedin\.com\/company \("lastshelter" OR "LAST ORIGIN STUDIO"\)/);
});

test('без сайта — по юрлицу; частное лицо — профиль по имени', () => {
  const company = linkedinSearchLinks('GAME SPARK PTE. LTD.');
  assert.match(decodeURIComponent(company.company), /keywords="GAME SPARK"$/);
  assert.match(decodeURIComponent(company.google), /site:linkedin\.com\/company "GAME SPARK"$/);
  const person = linkedinSearchLinks('Luong Vuong');
  assert.match(decodeURIComponent(person.people), /site:linkedin\.com\/in "Luong Vuong"$/);
});

test('без сайта бренд берётся из домена почты, но не из gmail', () => {
  assert.equal(brandFrom({ email: 'service@lastshelter.net' }), 'lastshelter');
  assert.equal(brandFrom({ email: 'novaskygames1977@gmail.com', supportUrl: 'https://help.novasky.games/x' }), 'novasky');
  assert.equal(brandFrom({ email: 'dev@gmail.com' }), null);
});
