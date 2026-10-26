import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candidate } from './aggregate.js';
import { decideTier, objectiveDowngrade, scoreInTier, type TierFlags, type TierInput } from './tier.js';

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    trackId: '1', name: 'Puzzle', developer: 'Indie Co', primaryGenre: 'Games', genres: ['Games'],
    price: 0, countries: ['us', 'de', 'jp'], countryCount: 3, charts: ['top-free'], bestRank: 12,
    bestPlacement: { country: 'us', genre: 'Games / Puzzle', chart: 'top-free', rank: 12 },
    inGrossing: false, ratingCount: 4_000, publisher: { apps: 3, totalRatings: 9_000 },
    ...over,
  };
}

const noFlags: TierFlags = {
  nonProfit: false, corporate: false, hardwareCompanion: false,
  largePublisher: false, sensitive: false, localNiche: false,
};

function input(flags: Partial<TierFlags> = {}, strength = 50): TierInput {
  return { flags: { ...noFlags, ...flags }, strength, profile: 'инди-студия казуальных игр' };
}

test('независимая студия без флагов — целевая, причина = профиль', () => {
  assert.deepEqual(decideTier(candidate(), input()), { tier: 'target', tierReason: 'инди-студия казуальных игр', fitScore: 80 });
});

test('некоммерческий проект — мимо, даже с сильными сигналами (случай Lichess)', () => {
  const d = decideTier(candidate(), input({ nonProfit: true }, 90));
  assert.equal(d.tier, 'skip');
  assert.equal(d.tierReason, 'некоммерческий проект');
});

test('skip-флаг важнее maybe-флага и объективных признаков', () => {
  const d = decideTier(candidate({ countries: ['cn'] }), input({ corporate: true, largePublisher: true }));
  assert.equal(d.tier, 'skip');
  assert.equal(d.tierReason, 'корпорация или её дочка');
});

test('флаг крупного издателя или чувствительной категории — под вопросом', () => {
  assert.equal(decideTier(candidate(), input({ largePublisher: true })).tier, 'maybe');
  assert.equal(decideTier(candidate(), input({ sensitive: true })).tierReason, 'чувствительная категория');
});

test('объективные признаки: Китай, крупный портфель, платная игра, крошечный проект', () => {
  assert.equal(objectiveDowngrade(candidate({ countries: ['cn'], countryCount: 1 })), 'только китайский стор');
  assert.equal(objectiveDowngrade(candidate({ publisher: { apps: 10, totalRatings: 785_581 } })), 'крупный издатель');
  assert.equal(objectiveDowngrade(candidate({ price: 4.99 })), 'платная игра');
  assert.equal(objectiveDowngrade(candidate({ ratingCount: 3, countries: ['kr'], countryCount: 1 })), 'совсем маленький проект');
  assert.equal(decideTier(candidate({ price: 4.99 }), input()).tier, 'maybe');
});

test('2 отзыва, но топы 15 стран — не «крошечный», а быстро растущий', () => {
  assert.equal(objectiveDowngrade(candidate({ ratingCount: 2, countryCount: 15 })), null);
});

test('сила переводится в диапазон уровня и не смешивает уровни', () => {
  assert.equal(scoreInTier('target', 0), 60);
  assert.equal(scoreInTier('target', 100), 100);
  assert.equal(scoreInTier('maybe', 100), 59);
  assert.equal(scoreInTier('skip', 100), 29);
  assert.equal(scoreInTier('target', NaN), 80);
});
