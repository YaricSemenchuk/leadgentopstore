import pLimit from 'p-limit';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { fetchAllCharts } from '../apple/charts.js';
import { pgChartCache } from '../apple/chart-cache.js';
import { lookupPublishers, lookupWithFallback } from '../apple/lookup.js';
import { buildCandidates, heuristicSignals, priorityScore, type Candidate } from '../pipeline/aggregate.js';
import { llmErrorText, qualifyCandidate } from '../llm/qualify.js';
import { developerDomains, enrichCompanyContacts, finalizeEmails } from '../contacts/company.js';
import { isFreeMailDomain, type CompanyEmails } from '../contacts/emails.js';
import { hunterDomainSearch, HunterError } from '../contacts/hunter.js';
import { findLinkedIn, SearchApiError } from '../contacts/people-search.js';
import {
  hideExcludedPublishers, initSchema, leadsForRescore, pool, recentlyQualified, refreshSignals, saveQualification, upsertLead,
} from '../db/pool.js';
import {
  companiesNeedingContacts, companiesNeedingHunter, companiesNeedingLinkedIn, emailInputs, saveCompanyContacts,
  saveCompanyEmails, saveHunter, saveLinkedIn, savePortfolio,
} from '../db/companies.js';
import { getParseSettings, type ParseSettings } from '../settings.js';

/** Отчёт о ходе прохода: этап и счётчик — дашборд показывает его, пока проход идёт. */
export type Report = (stage: string) => void;
const silent: Report = () => {};

function isExcludedPublisher(developer: string, excluded: string[]): boolean {
  const d = developer.toLowerCase();
  return excluded.some((p) => d.includes(p));
}

/**
 * Дешёвый отбор ДО LLM: не гигант по отзывам, не из списка исключений и есть хоть один
 * признак, что нужен буст. «Недавно обновлялось» само по себе не повод: обновляется почти весь топ.
 */
function isTarget(c: Candidate, s: ParseSettings): boolean {
  if ((c.ratingCount ?? 0) > s.maxAppRatings) return false;
  if (isExcludedPublisher(c.developer, s.excludePublishers)) return false;
  const h = heuristicSignals(c);
  return h.isNew || h.wideGeo || h.isGameOrUtility || h.weakAsoHint || h.lowRatingVolume;
}

export function llmKeyMissing(): string | null {
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
  contactsChecked: number;    // компаний проверено
  contactsFound: number;      // из них с почтой
  personalFound?: number;     // из них с личной почтой
  llmErrors: number;
  failedCharts: string[];
  linkedin?: LinkedInSearchResult;
  hunter?: HunterRunResult;
}

export interface LinkedInSearchResult {
  searched: number;
  companies: number;
  people: number;
  sized?: number;             // у скольких нашёлся размер компании
  error?: string;
  skipped?: string;
}

export interface HunterRunResult {
  searched: number;
  emails: number;
  error?: string;
  skipped?: string;
}

/** Все оценки упали — это не «оценено 0», а сломанный ключ, лимит или недоступный API. */
function assertLlmWorked(total: number, ok: number, failed: number, firstError: string): void {
  if (total > 0 && ok === 0 && failed > 0) throw new Error(`оценка моделью не прошла: ${firstError}`);
}

/** Пересобирает почту компании из всего собранного (сторы, сайт, люди из LinkedIn, Hunter). */
async function refreshEmails(companyId: number): Promise<CompanyEmails | null> {
  const inputs = await emailInputs(companyId);
  if (!inputs) return null;
  const emails = finalizeEmails(inputs);
  await saveCompanyEmails(companyId, emails);
  return emails;
}

/**
 * Автопоиск LinkedIn через поисковый API для целевых компаний (затем под вопросом): страница компании
 * с размером и люди. Без ключа — пропуск. Если API отклонил ключ или кончились кредиты — останавливаемся,
 * прогон при этом не падает: почта и остальное уже собраны.
 */
export async function runLinkedInSearch(report: Report = silent): Promise<LinkedInSearchResult> {
  if (!config.search.apiKey) return { searched: 0, companies: 0, people: 0, skipped: 'SERPER_API_KEY не задан' };
  const targets = await companiesNeedingLinkedIn(config.search.maxPerRun);
  if (targets.length === 0) return { searched: 0, companies: 0, people: 0, sized: 0 };
  console.log(`  LinkedIn: ищу для ${targets.length} компаний`);
  const gate = pLimit(2);
  const result: LinkedInSearchResult = { searched: 0, companies: 0, people: 0, sized: 0 };
  let stop = false;
  report(`LinkedIn 0/${targets.length}`);
  await Promise.all(
    targets.map((t) =>
      gate(async () => {
        if (stop) return;
        try {
          const found = await findLinkedIn(
            t.name,
            { website: t.website, email: t.email, supportUrl: t.supportUrl, privacyUrl: t.privacyUrl },
            undefined,
            { company: t.needCompany, people: t.needPeople, knownCompanyUrl: t.linkedinSource === 'site' ? t.linkedinUrl : null },
          );
          await saveLinkedIn(t.id, found, { company: t.needCompany, people: t.needPeople });
          // люди дают имена: личные адреса привязываются к ним, по шаблону домена составляются остальные
          if (t.needPeople) await refreshEmails(t.id);
          result.searched++;
          if (found.companyUrl) result.companies++;
          if (found.companySize) result.sized!++;
          result.people += found.people.length;
        } catch (e) {
          if (e instanceof SearchApiError && e.fatal) {
            stop = true;
            result.error = e.message;
          }
          console.warn(`  ⚠ LinkedIn ${t.name}: ${(e as Error).message}`);
        }
        report(`LinkedIn ${result.searched}/${targets.length}, компаний ${result.companies}, с размером ${result.sized}, людей ${result.people}`);
      }),
    ),
  );
  console.log(`  LinkedIn: страницы у ${result.companies}, размер у ${result.sized}, людей ${result.people} из ${result.searched} компаний${result.error ? ` — остановлено: ${result.error}` : ''}`);
  return result;
}

/** Hunter.io для целевых компаний со своим доменом: личная почта сотрудников, шаблон, размер. Без ключа — пропуск. */
export async function runHunter(report: Report = silent): Promise<HunterRunResult> {
  if (!config.hunter.apiKey) return { searched: 0, emails: 0, skipped: 'HUNTER_API_KEY не задан' };
  const targets = await companiesNeedingHunter(config.hunter.maxPerRun);
  const result: HunterRunResult = { searched: 0, emails: 0 };
  for (const t of targets) {
    const emailDomain = t.email?.split('@')[1];
    const domain =
      developerDomains([t.website, t.supportUrl, t.privacyUrl])[0] ??
      (emailDomain && !isFreeMailDomain(emailDomain) ? emailDomain : null);
    try {
      if (!domain) {
        await saveHunter(t.id, null, null);
        continue;
      }
      const found = await hunterDomainSearch(domain);
      await saveHunter(t.id, domain, found);
      await refreshEmails(t.id);
      result.searched++;
      result.emails += found.emails.length;
      report(`Hunter ${result.searched}/${targets.length}, адресов ${result.emails}`);
    } catch (e) {
      console.warn(`  ⚠ Hunter ${domain}: ${(e as Error).message}`);
      if (e instanceof HunterError && e.fatal) {
        result.error = e.message;
        break;
      }
    }
  }
  if (targets.length) console.log(`  Hunter: ${result.searched} доменов, адресов ${result.emails}${result.error ? ` — остановлено: ${result.error}` : ''}`);
  return result;
}

/** Все приложения компаний в App Store — пачками по 20 издателей за запрос (iTunes Lookup лимитирован). */
async function fillPortfolios(artistIds: number[], report: Report): Promise<void> {
  if (artistIds.length === 0) return;
  report(`приложения компаний в App Store (${artistIds.length})`);
  const stats = await lookupPublishers(artistIds);
  for (const [artistId, s] of stats) await savePortfolio(artistId, s);
}

export interface CompaniesResult {
  checked: number;
  withEmail: number;
  withPersonal: number;
  linkedinSite: number;
  linkedin: LinkedInSearchResult;
  hunter: HunterRunResult;
}

/**
 * Контакты на уровне компаний: для компаний с подходящими приложениями, которые ещё не проверяли
 * (или давно), — сторы и сайт; затем LinkedIn (люди и размер) и Hunter, у каждого свой лимит.
 */
export async function runCompanies(report: Report = silent): Promise<CompaniesResult> {
  const targets = await companiesNeedingContacts(config.contacts.recheckDays);
  const result = { checked: 0, withEmail: 0, withPersonal: 0, linkedinSite: 0 };
  if (targets.length) {
    console.log(`  компании: проверяю ${targets.length}`);
    await fillPortfolios(targets.filter((t) => !t.hasPortfolio).map((t) => t.artistId), report);
    const gate = pLimit(config.contacts.concurrency);
    report(`компании 0/${targets.length}`);
    await Promise.all(
      targets.map((t) =>
        gate(async () => {
          try {
            const contacts = await enrichCompanyContacts(t);
            await saveCompanyContacts(t.id, contacts);
            const emails = await refreshEmails(t.id);
            if (emails?.best) result.withEmail++;
            if (emails?.emails.some((e) => e.kind === 'personal' && !e.guessed)) result.withPersonal++;
            if (contacts.linkedinSite) result.linkedinSite++;
            if (contacts.errors.length) console.warn(`  ⚠ ${t.name}: ${contacts.errors.join('; ')}`);
          } catch (e) {
            console.warn(`  ⚠ ${t.name}: ${(e as Error).message}`);
          }
          report(`компании ${++result.checked}/${targets.length}, с почтой ${result.withEmail}, с личной ${result.withPersonal}`);
        }),
      ),
    );
    console.log(`  компании: почта у ${result.withEmail} из ${targets.length}, личная у ${result.withPersonal}, LinkedIn на сайте у ${result.linkedinSite}`);
  }
  const linkedin = await runLinkedInSearch(report);
  const hunter = await runHunter(report);
  // правила разбора почты могли поменяться — пересобираем у всех проверенных компаний (без сети)
  report('пересборка почты компаний');
  await refreshAllEmails();
  return { ...result, linkedin, hunter };
}

/** Пересобирает почту всех проверенных компаний из сохранённых данных: после правки правил личная/общая. */
export async function refreshAllEmails(): Promise<number> {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE checked_at IS NOT NULL`);
  for (const r of rows) await refreshEmails(r.id);
  return rows.length;
}

/**
 * Переоценка уже сохранённых лидов текущим промптом — без запросов к Apple.
 * По умолчанию только ещё не размеченные по уровням (tier IS NULL), all — все.
 */
export async function runRescore({ all = false } = {}): Promise<{ rescored: number; byTier: Record<string, number> }> {
  const missingKey = llmKeyMissing();
  if (missingKey) throw new Error(`${missingKey} не задан в .env — квалификация невозможна`);
  const settings = await getParseSettings();

  const hidden = await hideExcludedPublishers(settings.excludePublishers);
  if (hidden) console.log(`  скрыто лидов по списку исключений: ${hidden}`);

  const leads = (await leadsForRescore(!all)).filter((c) => !isExcludedPublisher(c.developer, settings.excludePublishers));
  console.log(`▶ переоценка: ${leads.length} лидов${all ? ' (все)' : ' (без уровня)'}`);
  const gate = pLimit(4);
  const byTier: Record<string, number> = {};
  let rescored = 0;
  let failedLlm = 0;
  let firstLlmError = '';
  await Promise.all(
    leads.map((c) =>
      gate(async () => {
        try {
          const lead = await qualifyCandidate(c);
          await saveQualification(c.trackId, lead);
          byTier[lead.tier] = (byTier[lead.tier] ?? 0) + 1;
          rescored++;
        } catch (e) {
          failedLlm++;
          firstLlmError ||= llmErrorText(e);
          console.warn(`  ⚠ ${c.name}: ${llmErrorText(e)}`);
        }
      }),
    ),
  );
  console.log(`  переоценено: ${rescored} / ${leads.length} — ${JSON.stringify(byTier)}`);
  assertLlmWorked(leads.length, rescored, failedLlm, firstLlmError);

  // новым целевым и «под вопросом» нужны контакты
  await runCompanies();
  return { rescored, byTier };
}

export interface RunOptions {
  dryRun?: boolean;
  /** что парсить; по умолчанию — сохранённое на странице «Что парсить» (или .env) */
  settings?: ParseSettings;
  report?: Report;
}

/** dryRun: сбор + отбор без LLM, без контактов и без записи лидов — проверить фиды и объём работы. */
export async function runPipeline({ dryRun = false, settings, report = silent }: RunOptions = {}): Promise<PipelineResult> {
  const missingKey = dryRun ? null : llmKeyMissing();
  if (missingKey) throw new Error(`${missingKey} не задан — квалификация невозможна`);
  const s = settings ?? (await getParseSettings());

  const t0 = Date.now();
  console.log(
    `▶ countries=${s.countries.length} genres=${s.genres.length} charts=${s.charts.join(',')} limit=${s.chartLimit}${dryRun ? ' (dry run)' : ''}`,
  );

  // 1. Сбор чартов (с кэшем: iTunes RSS блокирует IP после сотен запросов подряд)
  const charts = await fetchAllCharts(s.countries, s.genres, s.charts, {
    limit: s.chartLimit,
    concurrency: config.concurrency,
    cache: pgChartCache(),
    cacheTtlHours: config.chartCacheHours,
    onProgress: (done, total) => report(`чарты ${done}/${total}`),
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
  report('метаданные приложений');
  const firstCountry = new Map<string, string>();
  for (const a of appearances) if (!firstCountry.has(a.entry.id)) firstCountry.set(a.entry.id, a.country);
  const meta = await lookupWithFallback(firstCountry);
  console.log(`  уникальных приложений: ${firstCountry.size}, с метаданными: ${meta.size}`);

  // 3. Агрегация и отбор по приложению
  const candidates = buildCandidates(appearances, meta);
  const targets = candidates.filter((c) => isTarget(c, s)).sort((a, b) => priorityScore(b) - priorityScore(a));
  console.log(`  целевых (≤${s.maxAppRatings} отзывов и есть сигнал): ${targets.length} / ${candidates.length}`);

  // 4. Недавно оценённых не гоняем через модель повторно — только обновляем сигналы
  let pending = targets;
  if (!dryRun) {
    // список исключений мог поменяться — убираем таких издателей и из уже сохранённых лидов
    const hidden = await hideExcludedPublishers(s.excludePublishers);
    if (hidden) console.log(`  скрыто лидов по списку исключений: ${hidden}`);
    const fresh = await recentlyQualified(targets.map((c) => c.trackId), config.targeting.requalifyDays);
    for (const c of targets) if (fresh.has(c.trackId)) await refreshSignals(c);
    pending = targets.filter((c) => !fresh.has(c.trackId));
    if (fresh.size) console.log(`  уже оценены за ${config.targeting.requalifyDays} дн.: ${fresh.size}`);
  }

  // 5. Размер издателя — только для верха очереди (iTunes Lookup лимитирован)
  report('размер издателей');
  const shortlist = pending.slice(0, Math.ceil(s.maxLlmPerRun * 1.5));
  const publishers = await lookupPublishers(
    shortlist.map((c) => c.artistId).filter((id): id is number => !!id),
  );
  for (const c of shortlist) if (c.artistId) c.publisher = publishers.get(c.artistId);
  const small = shortlist.filter((c) => (c.publisher?.totalRatings ?? 0) <= s.maxPublisherRatings);
  const toQualify = small.slice(0, s.maxLlmPerRun);
  console.log(
    `  без крупных издателей (≤${s.maxPublisherRatings} отзывов на портфель): ${small.length} / ${shortlist.length}, в LLM: ${toQualify.length}`,
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
      contactsChecked: 0, contactsFound: 0, llmErrors: 0, failedCharts: failed,
    };
  }

  // 6. Квалификация через LLM (с лимитом параллелизма и мягкой обработкой ошибок)
  const gate = pLimit(4);
  let saved = 0;
  let done = 0;
  let failedLlm = 0;
  let firstLlmError = '';
  report(`оценка 0/${toQualify.length}`);
  await Promise.all(
    toQualify.map((c) =>
      gate(async () => {
        try {
          const lead = await qualifyCandidate(c);
          await upsertLead(c, lead);
          saved++;
        } catch (e) {
          failedLlm++;
          firstLlmError ||= llmErrorText(e);
          console.warn(`  ⚠ ${c.name}: ${llmErrorText(e)}`);
        }
        report(`оценка ${++done}/${toQualify.length}`);
      }),
    ),
  );
  console.log(`  оценено моделью: ${saved} / ${toQualify.length}`);
  assertLlmWorked(toQualify.length, saved, failedLlm, firstLlmError);

  // 7. Контакты компаний (сторы, сайт), затем LinkedIn и Hunter
  const companies = await runCompanies(report);

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`✅ готово за ${dt}s — просканировано ${candidates.length}, оценено ${saved}, компаний с почтой +${companies.withEmail}`);
  return {
    scanned: candidates.length, targets: targets.length, qualified: toQualify.length, saved,
    contactsChecked: companies.checked, contactsFound: companies.withEmail, personalFound: companies.withPersonal,
    llmErrors: failedLlm, failedCharts: failed, linkedin: companies.linkedin, hunter: companies.hunter,
  };
}

// Прямой запуск: npm run ingest [-- --dry-run | --contacts-only | --linkedin | --hunter | --refresh-emails | --rescore | --rescore-all]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (flag: string) => process.argv.includes(flag);
  try {
    // схема нужна и dry run'у: он пишет только в кэш чартов
    if (config.databaseUrl) await initSchema();
    if (arg('--contacts-only')) await runCompanies();
    else if (arg('--linkedin')) await runLinkedInSearch();
    else if (arg('--hunter')) await runHunter();
    else if (arg('--refresh-emails')) console.log(`  почта пересобрана у ${await refreshAllEmails()} компаний`);
    else if (arg('--rescore') || arg('--rescore-all')) await runRescore({ all: arg('--rescore-all') });
    else await runPipeline({ dryRun: arg('--dry-run') });
  } catch (e) {
    console.error(`✖ ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
