import pLimit from 'p-limit';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { fetchAllCharts } from '../apple/charts.js';
import { pgChartCache } from '../apple/chart-cache.js';
import { lookupPublishers, lookupWithFallback } from '../apple/lookup.js';
import { buildCandidates, heuristicSignals, priorityScore, type Candidate } from '../pipeline/aggregate.js';
import { qualifyCandidate } from '../llm/qualify.js';
import { enrichContacts } from '../contacts/enrich.js';
import {
  hideExcludedPublishers, initSchema, leadsForRescore, leadsNeedingContacts, pool, recentlyQualified,
  refreshSignals, saveContacts, saveQualification, upsertLead,
} from '../db/pool.js';

const { targeting } = config;

/**
 * Дешёвый отбор ДО LLM: не гигант по отзывам и есть хоть один признак, что нужен буст.
 * «Недавно обновлялось» само по себе не повод: обновляется почти весь топ.
 */
function isExcludedPublisher(developer: string): boolean {
  const d = developer.toLowerCase();
  return targeting.excludePublishers.some((p) => d.includes(p));
}

function isTarget(c: Candidate): boolean {
  if ((c.ratingCount ?? 0) > targeting.maxAppRatings) return false;
  if (isExcludedPublisher(c.developer)) return false;
  const s = heuristicSignals(c);
  return s.isNew || s.wideGeo || s.isGameOrUtility || s.weakAsoHint || s.lowRatingVolume;
}

function llmKeyMissing(): string | null {
  const { provider } = config.llm;
  const key = provider === 'groq' ? config.llm.groq.apiKey : config.llm.anthropic.apiKey;
  if (key && !key.endsWith('...')) return null;
  return provider === 'groq' ? 'GROQ_API_KEY' : 'ANTHROPIC_API_KEY';
}

export interface PipelineResult {
  scanned: number;
  targets: number;
  qualified: number;
  saved: number;
  contactsChecked: number;
  contactsFound: number;
  failedCharts: string[];
}

/** Контакты для подходящих лидов, которые ещё не проверяли (или давно). */
export async function runContacts(): Promise<{ checked: number; found: number }> {
  const targets = await leadsNeedingContacts(config.contacts.recheckDays);
  if (targets.length === 0) return { checked: 0, found: 0 };
  console.log(`  контакты: проверяю ${targets.length} лидов`);
  const gate = pLimit(config.contacts.concurrency);
  let found = 0;
  await Promise.all(
    targets.map((t) =>
      gate(async () => {
        try {
          const contacts = await enrichContacts(t);
          await saveContacts(t.trackId, contacts);
          if (contacts.email) found++;
          if (contacts.errors.length) console.warn(`  ⚠ контакты ${t.name}: ${contacts.errors.join('; ')}`);
        } catch (e) {
          console.warn(`  ⚠ контакты ${t.name}: ${(e as Error).message}`);
        }
      }),
    ),
  );
  console.log(`  контакты: почта найдена у ${found} из ${targets.length}`);
  return { checked: targets.length, found };
}

/**
 * Переоценка уже сохранённых лидов текущим промптом — без запросов к Apple.
 * По умолчанию только ещё не размеченные по уровням (tier IS NULL), all — все.
 */
export async function runRescore({ all = false } = {}): Promise<{ rescored: number; byTier: Record<string, number> }> {
  const missingKey = llmKeyMissing();
  if (missingKey) throw new Error(`${missingKey} не задан в .env — квалификация невозможна`);

  const hidden = await hideExcludedPublishers(targeting.excludePublishers);
  if (hidden) console.log(`  скрыто лидов по списку исключений: ${hidden}`);

  const leads = (await leadsForRescore(!all)).filter((c) => !isExcludedPublisher(c.developer));
  console.log(`▶ переоценка: ${leads.length} лидов${all ? ' (все)' : ' (без уровня)'}`);
  const gate = pLimit(4);
  const byTier: Record<string, number> = {};
  let rescored = 0;
  await Promise.all(
    leads.map((c) =>
      gate(async () => {
        try {
          const lead = await qualifyCandidate(c);
          await saveQualification(c.trackId, lead);
          byTier[lead.tier] = (byTier[lead.tier] ?? 0) + 1;
          rescored++;
        } catch (e) {
          console.warn(`  ⚠ ${c.name}: ${(e as Error).message}`);
        }
      }),
    ),
  );
  console.log(`  переоценено: ${rescored} / ${leads.length} — ${JSON.stringify(byTier)}`);

  // новым целевым и «под вопросом» нужны контакты
  await runContacts();
  return { rescored, byTier };
}

/** dryRun: сбор + отбор без LLM, без контактов и без записи в БД — проверить фиды и объём работы. */
export async function runPipeline({ dryRun = false } = {}): Promise<PipelineResult> {
  const missingKey = dryRun ? null : llmKeyMissing();
  if (missingKey) throw new Error(`${missingKey} не задан в .env — квалификация невозможна`);

  const t0 = Date.now();
  console.log(
    `▶ countries=${config.countries.length} genres=${config.genres.length} charts=${config.charts.join(',')} limit=${config.chartLimit}${dryRun ? ' (dry run)' : ''}`,
  );

  // 1. Сбор чартов (с кэшем: iTunes RSS блокирует IP после сотен запросов подряд)
  const charts = await fetchAllCharts(config.countries, config.genres, config.charts, {
    limit: config.chartLimit,
    concurrency: config.concurrency,
    cache: pgChartCache(),
    cacheTtlHours: config.chartCacheHours,
  });
  const { appearances, total, failed } = charts;
  console.log(
    `  чартов: ${total - failed.length}/${total} (из фида ${charts.fetched}, из кэша ${charts.fromCache}, устаревших ${charts.stale}), появлений: ${appearances.length}`,
  );
  if (charts.rateLimited) {
    console.warn('  ⚠ iTunes RSS ограничил частоту — часть чартов из старого кэша или пропущена; следующий проход доберёт');
  }
  if (appearances.length === 0) throw new Error('Фиды Apple не вернули ни одного чарта, кэша нет');

  // 2. Метаданные: US-стор, затем локальные сторы для того, чего в US нет
  const firstCountry = new Map<string, string>();
  for (const a of appearances) if (!firstCountry.has(a.entry.id)) firstCountry.set(a.entry.id, a.country);
  const meta = await lookupWithFallback(firstCountry);
  console.log(`  уникальных приложений: ${firstCountry.size}, с метаданными: ${meta.size}`);

  // 3. Агрегация и отбор по приложению
  const candidates = buildCandidates(appearances, meta);
  const targets = candidates.filter(isTarget).sort((a, b) => priorityScore(b) - priorityScore(a));
  console.log(`  целевых (≤${targeting.maxAppRatings} отзывов и есть сигнал): ${targets.length} / ${candidates.length}`);

  // 4. Недавно оценённых не гоняем через модель повторно — только обновляем сигналы
  let pending = targets;
  if (!dryRun) {
    // список исключений мог поменяться — убираем таких издателей и из уже сохранённых лидов
    const hidden = await hideExcludedPublishers(targeting.excludePublishers);
    if (hidden) console.log(`  скрыто лидов по списку исключений: ${hidden}`);
    const fresh = await recentlyQualified(targets.map((c) => c.trackId), targeting.requalifyDays);
    for (const c of targets) if (fresh.has(c.trackId)) await refreshSignals(c);
    pending = targets.filter((c) => !fresh.has(c.trackId));
    if (fresh.size) console.log(`  уже оценены за ${targeting.requalifyDays} дн.: ${fresh.size}`);
  }

  // 5. Размер издателя — только для верха очереди (iTunes Lookup лимитирован)
  const shortlist = pending.slice(0, Math.ceil(targeting.maxLlmPerRun * 1.5));
  const publishers = await lookupPublishers(
    shortlist.map((c) => c.artistId).filter((id): id is number => !!id),
  );
  for (const c of shortlist) if (c.artistId) c.publisher = publishers.get(c.artistId);
  const small = shortlist.filter((c) => (c.publisher?.totalRatings ?? 0) <= targeting.maxPublisherRatings);
  const toQualify = small.slice(0, targeting.maxLlmPerRun);
  console.log(
    `  без крупных издателей (≤${targeting.maxPublisherRatings} отзывов на портфель): ${small.length} / ${shortlist.length}, в LLM: ${toQualify.length}`,
  );

  if (dryRun) {
    console.log('\n  топ-20 в очереди (гео · лучшее место · отзывы · издатель: приложений/отзывов):');
    for (const c of toQualify.slice(0, 20)) {
      const p = c.bestPlacement;
      console.log(
        `   ${String(c.countryCount).padStart(2)} · ${`${p.country} ${p.genre} #${p.rank}`.padEnd(30)} · ${String(c.ratingCount ?? '—').padStart(6)} · ${c.publisher?.apps ?? '?'}/${c.publisher?.totalRatings ?? '?'} · ${c.name} (${c.developer})`,
      );
    }
    console.log(`\n✅ dry run за ${((Date.now() - t0) / 1000).toFixed(1)}s — в LLM ушло бы ${toQualify.length} запросов`);
    return {
      scanned: candidates.length, targets: targets.length, qualified: toQualify.length, saved: 0,
      contactsChecked: 0, contactsFound: 0, failedCharts: failed,
    };
  }

  // 6. Квалификация через LLM (с лимитом параллелизма и мягкой обработкой ошибок)
  const gate = pLimit(4);
  let saved = 0;
  await Promise.all(
    toQualify.map((c) =>
      gate(async () => {
        try {
          const lead = await qualifyCandidate(c);
          await upsertLead(c, lead);
          saved++;
        } catch (e) {
          console.warn(`  ⚠ ${c.name}: ${(e as Error).message}`);
        }
      }),
    ),
  );
  console.log(`  оценено моделью: ${saved} / ${toQualify.length}`);

  // 7. Контакты для подходящих лидов
  const contacts = await runContacts();

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`✅ готово за ${dt}s — просканировано ${candidates.length}, оценено ${saved}, с почтой +${contacts.found}`);
  return {
    scanned: candidates.length, targets: targets.length, qualified: toQualify.length, saved,
    contactsChecked: contacts.checked, contactsFound: contacts.found, failedCharts: failed,
  };
}

// Прямой запуск: npm run ingest [-- --dry-run | --contacts-only | --rescore | --rescore-all]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (flag: string) => process.argv.includes(flag);
  try {
    // схема нужна и dry run'у: он пишет только в кэш чартов
    if (config.databaseUrl) await initSchema();
    if (arg('--contacts-only')) await runContacts();
    else if (arg('--rescore') || arg('--rescore-all')) await runRescore({ all: arg('--rescore-all') });
    else await runPipeline({ dryRun: arg('--dry-run') });
  } catch (e) {
    console.error(`✖ ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
