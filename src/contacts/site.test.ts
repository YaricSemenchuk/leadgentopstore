import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteDescription } from './site.js';

test('описание компании — meta description, затем og:description', () => {
  assert.equal(
    siteDescription('<head><meta name="description" content="  We build   casual puzzle games played by 20M people. "></head>'),
    'We build casual puzzle games played by 20M people.',
  );
  assert.equal(
    siteDescription('<head><meta name="description" content="Home"><meta property="og:description" content="Indie studio from Warsaw making idle games."></head>'),
    'Indie studio from Warsaw making idle games.',
  );
});

test('заглушки конструкторов и пустые страницы — без описания', () => {
  assert.equal(siteDescription('<head><meta name="description" content="Just another WordPress site"></head>'), null);
  assert.equal(siteDescription('<head><title>Studio</title></head>'), null);
  assert.equal(siteDescription(''), null);
});

test('длинное описание обрезается по слову', () => {
  const long = 'word '.repeat(100);
  const d = siteDescription(`<meta name="description" content="${long}">`)!;
  assert.ok(d.length <= 300 && d.endsWith('word…'), d);
});
