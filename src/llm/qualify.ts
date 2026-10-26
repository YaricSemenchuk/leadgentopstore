import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { generateObject, jsonSchema } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod/v4';
import { config } from '../config.js';
import type { Candidate } from '../pipeline/aggregate.js';
import { heuristicSignals } from '../pipeline/aggregate.js';
import { decideTier, type Tier } from '../pipeline/tier.js';

/**
 * Что модель возвращает по каждому приложению. Уровень (target/maybe/skip) модель не выбирает:
 * она отвечает на вопросы да/нет, а уровень по рубрике считает код (pipeline/tier.ts).
 */
export const ModelLeadSchema = z.object({
  flags: z.object({
    nonProfit: z.boolean().describe('Некоммерческий, open-source или государственный проект'),
    corporate: z
      .boolean()
      .describe('Корпорация, её дочка или студия крупной группы (Alibaba, ByteDance, Krafton, Naver, LINE, Take-Two и т.п.); известная франшиза крупной студии; банк, ритейл или бренд офлайн-бизнеса'),
    hardwareCompanion: z.boolean().describe('Приложение-компаньон к устройству (сканер авто, умный дом, камера бренда)'),
    largePublisher: z
      .boolean()
      .describe('Средне-крупный издатель со своим отделом закупки трафика или лицензионный IP (аниме, спорт-лиги, ТВ-шоу)'),
    sensitive: z
      .boolean()
      .describe('Чувствительная категория: форекс, крипто, азартные, «взрослые», IPTV и риск пиратства. Обычные VPN, очистка, трекеры — не чувствительные'),
    localNiche: z.boolean().describe('Локальный нишевый сервис, где установки не главный рычаг роста'),
  }),
  strength: z
    .number()
    .describe('Сила лида от 0 до 100 по сигналам: гео, монетизация, рост, позиция, слабое ASO. Используй всю шкалу'),
  profile: z.string().describe('Кто это, 2–6 слов на русском: «инди-студия казуальных игр», «студия VPN-утилит»'),
  vertical: z.string().describe('Короткая вертикаль: hypercasual game, strategy game, VPN utility, AI photo, dating, ...'),
  reasons: z.array(z.string()).describe('2–4 коротких обоснования на русском'),
  pitchHook: z
    .string()
    .describe('Одно предложение-зацепка для холодного питча promobile Ads этому клиенту, на русском'),
});

type ModelLead = z.infer<typeof ModelLeadSchema>;

/** Итог квалификации: факты от модели + уровень по рубрике. needsUA = не skip. */
export interface Lead extends Pick<ModelLead, 'vertical' | 'reasons' | 'pitchHook'> {
  tier: Tier;
  tierReason: string;
  fitScore: number;
  needsUA: boolean;
}

export class RefusalError extends Error {}

const SYSTEM = `Ты — аналитик лидогенерации для promobile Ads: сервиса мотивированного трафика (incentivized installs), продвижения по ключевым словам и рейтингов в App Store и Google Play. Клиент promobile — независимая небольшая или средняя студия/компания, чей доход зависит от установок и позиций в сторе: мобильные игры, утилиты, потребительские стартапы.

По данным о приложении из топ-чартов:
1. Ответь да/нет на каждый вопрос в flags. Отвечай true, только если это следует из данных или ты уверенно знаешь издателя (в том числе чьей дочкой он является); если издатель незнаком — суди по размеру портфеля (publisherApps, publisherTotalRatings) и названию. Если сам называешь проект некоммерческим, корпоративным и т.п. — ставь соответствующий флаг true.
2. Оцени силу лида (strength, 0–100) по сигналам, не глядя на флаги: выше — топы многих стран, монетизация (top-grossing), свежий релиз, высокое место в категории, признаки слабого ASO (мало отзывов при высокой позиции); ниже — одна страна, низкие места, нет монетизации. Используй всю шкалу, не ставь всем одинаковый балл.
3. Кратко опиши, кто это (profile), вертикаль, 2–4 обоснования и одну зацепку для холодного письма.

Тексты — на русском, кратко. Не выдумывай фактов сверх данных.`;

// --- Claude (официальный SDK, структурированный вывод) ---

let client: Anthropic | null = null;

// Серверный фолбэк при отказе модели и параметр effort есть не у всех моделей.
const FALLBACK_MODELS = /^claude-(sonnet-5-5|opus-5|opus-5-5|fable-5-1)$/;
const NO_EFFORT_MODELS = /^claude-(haiku-4-5|sonnet-4-5)/;

async function askClaude(prompt: string): Promise<ModelLead> {
  client ??= new Anthropic({ apiKey: config.llm.anthropic.apiKey, maxRetries: 4 });
  const { model, effort } = config.llm.anthropic;
  const fallback = FALLBACK_MODELS.test(model);

  const response = await client.beta.messages.parse({
    model,
    // ответ ~400 токенов; запас на короткое размышление (adaptive thinking включено по умолчанию)
    max_tokens: 4_000,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    output_config: {
      format: betaZodOutputFormat(ModelLeadSchema),
      ...(NO_EFFORT_MODELS.test(model) ? {} : { effort }),
    },
    // если модель откажется, сервер повторит запрос на запасной модели (только Claude API)
    ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  });

  if (response.stop_reason === 'refusal') {
    throw new RefusalError(`модель отказалась (${response.stop_details?.category ?? 'без категории'})`);
  }
  if (response.stop_reason === 'max_tokens') throw new Error('ответ обрезан по max_tokens');
  if (!response.parsed_output) throw new Error('ответ модели не по схеме');
  return response.parsed_output;
}

// --- Groq (OpenAI-совместимый endpoint через AI SDK) ---

async function askGroq(prompt: string): Promise<ModelLead> {
  const groq = createOpenAI({ apiKey: config.llm.groq.apiKey, baseURL: config.llm.groq.baseURL });
  const { object } = await generateObject({
    model: groq(config.llm.groq.model),
    schema: jsonSchema(z.toJSONSchema(ModelLeadSchema) as Parameters<typeof jsonSchema>[0]),
    system: SYSTEM,
    prompt,
    temperature: 0.2,
  });
  return ModelLeadSchema.parse(object);
}

/** Квалифицирует одного кандидата. Эвристики считаются заранее и передаются модели как подсказки. */
export async function qualifyCandidate(c: Candidate): Promise<Lead> {
  const sig = heuristicSignals(c);
  const p = c.bestPlacement;
  const facts = {
    name: c.name,
    developer: c.developer,
    primaryGenre: c.primaryGenre,
    genres: c.genres.slice(0, 5),
    price: c.price,
    countriesInTop: c.countryCount,
    sampleCountries: c.countries.slice(0, 10),
    charts: c.charts,
    bestPlacement: `${p.country} · ${p.genre} · ${p.chart} #${p.rank}`,
    inGrossing: c.inGrossing,
    publisherApps: c.publisher?.apps,
    publisherTotalRatings: c.publisher?.totalRatings,
    releaseDate: c.releaseDate,
    lastUpdate: c.lastUpdate,
    ratingCount: c.ratingCount,
    heuristics: sig,
  };
  const prompt = `Данные приложения (JSON):\n${JSON.stringify(facts, null, 2)}\n\nОцени этот лид.`;

  const answer = config.llm.provider === 'groq' ? await askGroq(prompt) : await askClaude(prompt);
  const decided = decideTier(c, answer);
  return {
    vertical: answer.vertical,
    reasons: answer.reasons,
    pitchHook: answer.pitchHook,
    ...decided,
    needsUA: decided.tier !== 'skip',
  };
}
