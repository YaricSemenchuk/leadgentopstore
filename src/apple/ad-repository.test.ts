import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAppId, summarize, type AdRow } from './ad-repository.js';

const NOW = new Date('2026-11-26T10:00:00Z');

// Даты в ответе реестра приходят с временем: "2026-11-21 00:00:00.0"
const ad = (country: string, placement: string, first: string, last: string, extra: Partial<AdRow> = {}): AdRow => ({
  countryOrRegion: country, placement,
  firstImpressionDate: `${first} 00:00:00.0`, lastImpressionDate: `${last} 00:00:00.0`, ...extra,
});

test('пустой ответ — не замечена в ЕС', () => {
  const s = summarize('1', [], { total: 0, dataStart: '2026-08-23', dataEnd: '2026-11-21' }, NOW);
  assert.equal(s.status, 'none');
  assert.equal(s.lastImpression, null);
  assert.deepEqual(s.countries, []);
  assert.equal(s.dataEnd, '2026-11-21');
});

test('последний показ в пределах недели до конца данных — активна', () => {
  const s = summarize('1', [ad('DE', 'APPSTORE_SEARCH_RESULTS', '2026-11-01', '2026-11-14')],
    { total: 1, dataStart: '2026-08-23', dataEnd: '2026-11-21' }, NOW);
  assert.equal(s.status, 'active');
  assert.equal(s.lastImpression, '2026-11-14');
});

test('последний показ раньше недели до конца данных — была', () => {
  const s = summarize('1', [ad('FR', 'APPSTORE_TODAY_TAB', '2026-09-01', '2026-11-13')],
    { total: 1, dataStart: '2026-08-23', dataEnd: '2026-11-21' }, NOW);
  assert.equal(s.status, 'past');
});

test('без dataEndDate порог считается от сегодняшнего дня', () => {
  const s = summarize('1', [ad('FR', 'APPSTORE_TODAY_TAB', '2026-11-01', '2026-11-20')], { total: 1 }, NOW);
  assert.equal(s.status, 'active');
});

test('разбивка по странам и плейсментам: свежие сверху, счёт объявлений, неизвестный плейсмент сохраняется', () => {
  const rows = [
    ad('de', 'APPSTORE_SEARCH_RESULTS', '2026-10-01', '2026-11-20', { developerName: 'Temu', legalName: 'Whaleco Inc.' }),
    ad('DE', 'APPSTORE_TODAY_TAB', '2026-10-05', '2026-11-10'),
    ad('FR', 'APPSTORE_SEARCH_RESULTS', '2026-09-01', '2026-11-21'),
    ad('IT', 'APPSTORE_PRODUCT_PAGE', '2026-08-10', '2026-09-01'),
  ];
  const s = summarize('1641486558', rows, { total: 4738, dataStart: '2026-08-23', dataEnd: '2026-11-21' }, NOW);
  assert.deepEqual(s.countries, [
    { key: 'FR', ads: 1, last: '2026-11-21' },
    { key: 'DE', ads: 2, last: '2026-11-20' },
    { key: 'IT', ads: 1, last: '2026-09-01' },
  ]);
  assert.deepEqual(s.placements.map((p) => [p.key, p.ads]), [
    ['APPSTORE_SEARCH_RESULTS', 2], ['APPSTORE_TODAY_TAB', 1], ['APPSTORE_PRODUCT_PAGE', 1],
  ]);
  assert.equal(s.firstImpression, '2026-08-10');
  assert.equal(s.adsTotal, 4738);
  assert.equal(s.adsScanned, 4);
  assert.equal(s.developerName, 'Temu');
  assert.equal(s.legalName, 'Whaleco Inc.');
});

test('строки без дат не ломают сводку', () => {
  const s = summarize('1', [{ countryOrRegion: 'DE', placement: 'APPSTORE_SEARCH_TAB', lastImpressionDate: null }],
    { total: 1, dataEnd: '2026-11-21' }, NOW);
  assert.equal(s.status, 'none');
  assert.deepEqual(s.countries, []);
});

test('appId — только цифры', () => {
  assert.ok(isAppId('1641486558'));
  assert.ok(!isAppId('id1641486558'));
  assert.ok(!isAppId('1;type==DEVELOPER'));
  assert.ok(!isAppId(''));
});
