import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLinkedIn, parseProfileTitle, pickCompany, pickPeople, type SearchHit } from './people-search.js';

// Фикстуры в форме ответа Serper (organic: title, link, snippet).
const companyHits: SearchHit[] = [
  { title: 'Last Origin Games | LinkedIn', link: 'https://www.linkedin.com/company/last-origin-games', snippet: 'Developer of mobile survival games' },
  { title: 'LastShelter Studio | LinkedIn', link: 'https://sg.linkedin.com/company/lastshelter-studio?trk=x', snippet: 'Makers of Last Shelter: War Z' },
];

const peopleHits: SearchHit[] = [
  { title: 'Wei Zhang - Head of Marketing - LastShelter Studio | LinkedIn', link: 'https://sg.linkedin.com/in/wei-zhang-123', snippet: 'Marketing at LastShelter Studio' },
  { title: 'John Smith - CEO - Unrelated Corp | LinkedIn', link: 'https://www.linkedin.com/in/john-smith', snippet: 'CEO at Unrelated Corp' },
  { title: 'Anna Lee – Founder – lastshelter | LinkedIn', link: 'https://www.linkedin.com/in/anna-lee/', snippet: '' },
  { title: 'Wei Zhang - Head of Marketing | LinkedIn', link: 'https://www.linkedin.com/in/wei-zhang-123?originalSubdomain=sg', snippet: 'LastShelter' },
  { title: 'Not a profile', link: 'https://www.linkedin.com/posts/xyz', snippet: 'lastshelter' },
];

test('страница компании — только совпадающая по бренду, адрес нормализуется', () => {
  assert.equal(pickCompany(companyHits, ['lastshelter', 'LAST ORIGIN STUDIO']), 'https://www.linkedin.com/company/lastshelter-studio/');
});

test('люди: только упоминающие компанию, без дублей и не-профилей', () => {
  const people = pickPeople(peopleHits, ['lastshelter']);
  assert.deepEqual(people, [
    { name: 'Wei Zhang', title: 'Head of Marketing · LastShelter Studio', url: 'https://www.linkedin.com/in/wei-zhang-123/' },
    { name: 'Anna Lee', title: 'Founder · lastshelter', url: 'https://www.linkedin.com/in/anna-lee/' },
  ]);
});

test('заголовок без должности', () => {
  assert.deepEqual(parseProfileTitle('Luong Vuong | LinkedIn'), { name: 'Luong Vuong', title: null });
});

test('findLinkedIn: два запроса по бренду и юрлицу', async () => {
  const queries: string[] = [];
  const found = await findLinkedIn('LAST ORIGIN STUDIO LIMITED', { email: 'service@lastshelter.net' }, async (q) => {
    queries.push(q);
    return q.includes('/company') ? companyHits : peopleHits;
  });
  assert.equal(queries.length, 2);
  assert.match(queries[0], /^site:linkedin\.com\/company \("lastshelter" OR "LAST ORIGIN STUDIO"\)$/);
  assert.match(queries[1], /^site:linkedin\.com\/in .*CEO OR founder/);
  assert.equal(found.companyUrl, 'https://www.linkedin.com/company/lastshelter-studio/');
  assert.equal(found.people.length, 2);
});

test('частное лицо: один запрос — его профиль', async () => {
  const queries: string[] = [];
  const found = await findLinkedIn('Luong Vuong', {}, async (q) => {
    queries.push(q);
    return [{ title: 'Luong Vuong - Indie Game Developer | LinkedIn', link: 'https://vn.linkedin.com/in/luongvuong', snippet: '' }];
  });
  assert.deepEqual(queries, ['site:linkedin.com/in "Luong Vuong"']);
  assert.equal(found.companyUrl, null);
  assert.equal(found.people[0]?.name, 'Luong Vuong');
});
