import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHunter } from './hunter.js';

// Форма ответа Hunter Domain Search v2; люди вымышленные.
test('Hunter: личные адреса с именами, общие без имени, недействительные отброшены', () => {
  const r = parseHunter({
    data: {
      domain: 'studio.io',
      pattern: '{first}.{last}',
      headcount: '51-200',
      emails: [
        { value: 'Ann.Lee@studio.io', type: 'personal', confidence: 94, first_name: 'Ann', last_name: 'Lee', position: 'Head of Growth' },
        { value: 'press@studio.io', type: 'generic', confidence: 90, first_name: null, last_name: null },
        { value: 'old.guy@studio.io', type: 'personal', confidence: 80, first_name: 'Old', last_name: 'Guy', verification: { status: 'invalid' } },
        { value: 'maybe@studio.io', type: 'personal', confidence: 20, first_name: 'May', last_name: 'Be' },
      ],
    },
    meta: { results: 4 },
  });
  assert.deepEqual(r.emails, [
    { email: 'ann.lee@studio.io', source: 'hunter', person: 'Ann Lee', title: 'Head of Growth' },
    { email: 'press@studio.io', source: 'hunter', person: null, title: null },
  ]);
  assert.equal(r.pattern, '{first}.{last}');
  assert.deepEqual(r.size, { range: '51-200', min: 51 });
});

test('Hunter: странный шаблон и пустой ответ', () => {
  const r = parseHunter({ data: { pattern: 'random', emails: [] } });
  assert.equal(r.pattern, null);
  assert.equal(r.size, null);
  assert.throws(() => parseHunter({ errors: [{ id: 'x' }] }));
});
