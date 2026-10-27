import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPattern, nameParts, renderPattern } from './names.js';

test('имя и фамилия латиницей: диакритика, регалии, инициалы', () => {
  assert.deepEqual(nameParts('Şule Yıldız'), { first: 'sule', last: 'yildiz' });
  assert.deepEqual(nameParts('Emre Kaya, MBA'), { first: 'emre', last: 'kaya' });
  assert.deepEqual(nameParts('Dr. Ann-Marie Lee'), { first: 'annmarie', last: 'lee' });
  assert.deepEqual(nameParts('Jon J.'), { first: 'jon', last: null });
  assert.equal(nameParts('王伟'), null);
});

test('шаблон почты по адресу и имени', () => {
  const p = nameParts('Emre Kaya')!;
  assert.equal(matchPattern('emre', p), '{first}');
  assert.equal(matchPattern('emre.kaya', p), '{first}.{last}');
  assert.equal(matchPattern('ekaya', p), '{f}{last}');
  assert.equal(matchPattern('kaya.emre', p), '{last}.{first}');
  assert.equal(matchPattern('support', p), null);
  // короткое имя само по себе — не доказательство
  assert.equal(matchPattern('li', nameParts('Li Wei')!), null);
  assert.equal(renderPattern('{first}_{l}', p), 'emre_k');
  assert.equal(renderPattern('{first}.{last}', nameParts('Jon')!), null);
});
