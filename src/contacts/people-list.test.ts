import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CompanyEmail } from './emails.js';
import { companyContext, companyRoleEmail, nameFromEmail, peopleOfCompany, type CompanyRow } from './people-list.js';

const email = (e: Partial<CompanyEmail> & { email: string }): CompanyEmail => ({
  kind: 'personal', free: false, sources: ['website'], person: null, title: null, guessed: false, ...e,
});

const company = (over: Partial<CompanyRow> = {}): CompanyRow => ({
  name: 'Fuse Entertainment INC', kind: 'company', tier: 'target', best_fit: 80, emails: [], linkedin_people: [],
  linkedin_url: null, website: 'https://fusegames.io', support_url: null, privacy_url: null, email: null, country: null,
  employees: null, ios_apps: null, ios_ratings: null, android_apps: null, treg_company: null, site_description: null,
  apps: [], pitch_hook: null, ...over,
});

test('имя из адреса — только из разделённых частей', () => {
  assert.equal(nameFromEmail('li.wei@quvideo.com'), 'Li Wei');
  assert.equal(nameFromEmail('huanqing.liu@dongzhougame.com'), 'Huanqing Liu');
  assert.equal(nameFromEmail('robert.vigafun95@gmail.com'), 'Robert Vigafun');
  assert.equal(nameFromEmail('thanhlx@roosterx.vn'), null);
  assert.equal(nameFromEmail('yavuz@fusegames.io'), null);
  assert.equal(nameFromEmail('a.b@x.io'), null);
});

test('человек из LinkedIn получает свой адрес и угаданный по шаблону — отдельно', () => {
  const people = peopleOfCompany(company({
    linkedin_people: [
      { name: 'Deniz Aydin', title: 'Head of UA at Fuse', url: 'https://www.linkedin.com/in/deniz' },
      { name: 'Emre Kaya', title: 'CEO at Fuse', url: 'https://www.linkedin.com/in/emre' },
      { name: 'Ann Lee', title: 'Artist', url: 'https://www.linkedin.com/in/ann' },
    ],
    emails: [
      email({ email: 'emre.kaya@fusegames.io', person: 'Emre Kaya', status: 'valid' }),
      email({ email: 'deniz.aydin@fusegames.io', person: 'Deniz Aydin', guessed: true, sources: [] }),
      email({ email: 'support@fusegames.io', kind: 'role' }),
    ],
  }));
  assert.deepEqual(people.map((p) => [p.name, p.email, p.emailGuess]), [
    ['Emre Kaya', 'emre.kaya@fusegames.io', null],
    ['Deniz Aydin', null, 'deniz.aydin@fusegames.io'],
    ['Ann Lee', null, null],
  ]);
  assert.equal(people[0].emailStatus, 'valid');
  assert.equal(people[0].linkedin, 'https://www.linkedin.com/in/emre');
  // общий ящик — не человек
  assert.ok(!people.some((p) => p.email === 'support@fusegames.io'));
});

test('адрес без профиля — своя строка: имя от провайдера, из адреса или ceo@ как должность', () => {
  const people = peopleOfCompany(company({
    emails: [
      email({ email: 'ceo@fusegames.io' }),
      email({ email: 'li.wei@fusegames.io' }),
      email({ email: 'mehmet@fusegames.io', person: 'Mehmet Oz', title: 'CTO', sources: ['hunter'] }),
      email({ email: 'yavuz@fusegames.io' }),
    ],
  }));
  const by = Object.fromEntries(people.map((p) => [p.email, p]));
  assert.equal(by['ceo@fusegames.io'].name, null);
  assert.equal(by['ceo@fusegames.io'].title, 'CEO');
  assert.equal(by['li.wei@fusegames.io'].name, 'Li Wei');
  assert.equal(by['li.wei@fusegames.io'].nameFrom, 'email');
  assert.equal(by['mehmet@fusegames.io'].name, 'Mehmet Oz');
  assert.equal(by['mehmet@fusegames.io'].nameFrom, 'provider');
  assert.equal(by['yavuz@fusegames.io'].name, null);
  // без профиля — ссылка на поиск: по имени, если оно есть, иначе людей компании
  assert.match(decodeURIComponent(by['li.wei@fusegames.io'].linkedinSearch), /site:linkedin\.com\/in "Li Wei"/);
});

test('частный разработчик: gmail — его адрес, имя — имя разработчика, несколько адресов — одна строка', () => {
  const people = peopleOfCompany(company({
    name: 'Ivan Petrov', kind: 'individual',
    emails: [email({ email: 'petrovapps@gmail.com', free: true }), email({ email: 'petrovgames@gmail.com', free: true })],
  }));
  assert.equal(people.length, 1);
  const [p] = people;
  assert.equal(p.name, 'Ivan Petrov');
  assert.equal(p.nameFrom, 'developer');
  assert.equal(p.emailFree, true);
  assert.equal(p.email, 'petrovapps@gmail.com');
  assert.deepEqual(p.otherEmails, ['petrovgames@gmail.com']);
});

test('корпоративный адрес выше gmail, руководитель выше остальных', () => {
  const people = peopleOfCompany(company({
    linkedin_people: [
      { name: 'Ann Lee', title: 'Artist', url: 'https://www.linkedin.com/in/ann' },
      { name: 'Bob Stone', title: 'Founder', url: 'https://www.linkedin.com/in/bob' },
    ],
    emails: [email({ email: 'tom.ji@gmail.com', free: true }), email({ email: 'tom.ji@fusegames.io' })],
  }));
  assert.deepEqual(people.map((p) => p.email ?? p.name), ['tom.ji@fusegames.io', 'Bob Stone', 'Ann Lee']);
  // gmail того же человека — запасным адресом в той же строке
  assert.deepEqual(people[0].otherEmails, ['tom.ji@gmail.com']);
});

test('общий ящик компании: корпоративный, а не gmail', () => {
  assert.equal(
    companyRoleEmail({ emails: [email({ email: 'studio.support@gmail.com', kind: 'role', free: true }), email({ email: 'info@fusegames.io', kind: 'role' })] }),
    'info@fusegames.io',
  );
});

test('контекст компании — кто, где, размер, приложения, чарты и почему', () => {
  const text = companyContext(company({
    country: 'Singapore', employees: '201-500', ios_apps: 3, ios_ratings: 12000, android_apps: 5,
    treg_company: { founded: 2015, industry: 'Computer Games' },
    site_description: 'We build AI video apps for creators.',
    apps: [
      { name: 'AI Catch', tier: 'target', vertical: 'AI video generator', placement: 'ua · Photo & Video · top-free #30', countries: 19,
        reason: 'сингапурская студия AI-видеоприложений', reasons: ['в топе 19 стран', 'мало отзывов при высокой позиции.'] },
      { name: 'Other', tier: 'maybe', placement: 'us · Games · top-free #90', countries: 1 },
      { name: 'Third', tier: 'maybe' },
    ],
  }));
  assert.equal(
    text,
    'Сингапурская студия AI-видеоприложений · Singapore · 201-500 сотрудников · Computer Games · основана в 2015. ' +
      'О себе на сайте: «We build AI video apps for creators». ' +
      `Приложений: App Store — 3 (${(12000).toLocaleString('ru-RU')} отзывов), Google Play — 5. ` +
      'В чартах: «AI Catch» (AI video generator) — ua · Photo & Video · top-free #30, в топах 19 стран; «Other» — us · Games · top-free #90, ещё 1. ' +
      'Почему подходит: в топе 19 стран; мало отзывов при высокой позиции.',
  );
});

test('контекст: Apple Ads в ЕС — идёт или была, со странами; «не замечена» не пишем', () => {
  const active = companyContext(company({ asa_status: 'active', asa_last: '2026-11-21', asa_countries: ['NL', 'BE'] }));
  assert.ok(active.endsWith('Apple Ads в ЕС: реклама идёт, последний показ 21 ноября (NL, BE).'), active);
  const past = companyContext(company({
    asa_status: 'past', asa_last: '2026-11-10', asa_countries: ['DE', 'ES', 'FR', 'CZ', 'BE', 'DK', 'AT'],
  }));
  assert.ok(past.includes('реклама была, последний показ 10 ноября (DE, ES, FR, CZ, BE и ещё 2).'), past);
  assert.ok(!companyContext(company({ asa_status: 'none', asa_last: null })).includes('Apple Ads'));
  assert.ok(!companyContext(company()).includes('Apple Ads'));
});
