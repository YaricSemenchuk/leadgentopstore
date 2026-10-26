import type { Candidate } from './aggregate.js';

/**
 * Уровень лида:
 *  target — независимая небольшая/средняя студия игр или утилит, доход зависит от установок;
 *  maybe  — крупноват, крошечный, только китайский стор, премиум, ниша или чувствительная категория;
 *  skip   — корпорации и их дочки, некоммерческие, компаньоны к устройствам, известные франшизы.
 */
export type Tier = 'target' | 'maybe' | 'skip';

/** Диапазон fit score для уровня: сортировка по баллу не смешивает уровни. */
export const TIER_RANGE: Record<Tier, [number, number]> = {
  target: [60, 100],
  maybe: [30, 59],
  skip: [0, 29],
};

/** Порог «крупноват»: суммарно отзывов на портфель издателя. */
export const LARGE_PUBLISHER_RATINGS = 250_000;

/**
 * Факты, которые модель отмечает да/нет. Уровень из них считает код: многоступенчатую
 * рубрику модель применяет ненадёжно (пишет «некоммерческий», но ставит target),
 * а на прямые вопросы отвечает стабильно.
 */
export interface TierFlags {
  nonProfit: boolean;          // некоммерческий, open-source, госпроект
  corporate: boolean;          // корпорация, её дочка, студия крупной группы, франшиза крупной студии, банк/ритейл/офлайн-бренд
  hardwareCompanion: boolean;  // приложение к устройству
  largePublisher: boolean;     // средне-крупный издатель со своей закупкой трафика или лицензионный IP
  sensitive: boolean;          // форекс, крипто, азартные, «взрослые», риск пиратства
  localNiche: boolean;         // локальный нишевый сервис, где установки не главное
}

const SKIP_FLAGS: Array<[keyof TierFlags, string]> = [
  ['nonProfit', 'некоммерческий проект'],
  ['corporate', 'корпорация или её дочка'],
  ['hardwareCompanion', 'приложение к устройству'],
];

const MAYBE_FLAGS: Array<[keyof TierFlags, string]> = [
  ['largePublisher', 'крупноватый издатель'],
  ['sensitive', 'чувствительная категория'],
  ['localNiche', 'локальная ниша'],
];

export interface TierInput {
  flags: TierFlags;
  strength: number;   // 0–100: сила сигналов роста/монетизации, без учёта уровня
  profile: string;    // кто это, 2–6 слов
}

export interface TierDecision {
  tier: Tier;
  tierReason: string;
  fitScore: number;
}

/** Объективные признаки «под вопросом», проверяемые по данным без модели. */
export function objectiveDowngrade(c: Candidate): string | null {
  if (c.countries.length > 0 && c.countries.every((cc) => cc === 'cn')) return 'только китайский стор';
  if ((c.publisher?.totalRatings ?? 0) > LARGE_PUBLISHER_RATINGS) return 'крупный издатель';
  if (c.price > 0 && /game/i.test(c.primaryGenre)) return 'платная игра';
  if ((c.ratingCount ?? 0) <= 20 && c.countryCount <= 2) return 'совсем маленький проект';
  return null;
}

/** Сила 0–100 → балл внутри диапазона уровня. */
export function scoreInTier(tier: Tier, strength: number): number {
  const [lo, hi] = TIER_RANGE[tier];
  const s = Math.min(100, Math.max(0, Number.isFinite(strength) ? strength : 50));
  return Math.round(lo + (s / 100) * (hi - lo));
}

/** Уровень по рубрике: skip-флаги → maybe-флаги и объективные признаки → иначе target. */
export function decideTier(c: Candidate, input: TierInput): TierDecision {
  const skip = SKIP_FLAGS.find(([flag]) => input.flags[flag]);
  if (skip) return { tier: 'skip', tierReason: skip[1], fitScore: scoreInTier('skip', input.strength) };

  const maybe = MAYBE_FLAGS.find(([flag]) => input.flags[flag])?.[1] ?? objectiveDowngrade(c);
  if (maybe) return { tier: 'maybe', tierReason: maybe, fitScore: scoreInTier('maybe', input.strength) };

  return { tier: 'target', tierReason: input.profile.trim(), fitScore: scoreInTier('target', input.strength) };
}
