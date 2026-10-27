import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import type { Candidate } from '../pipeline/aggregate.js';
import type { Lead } from '../llm/qualify.js';
import { CONTACTS_VERSION, type Contacts } from '../contacts/enrich.js';
import { LINKEDIN_SEARCH_VERSION } from '../contacts/people-search.js';
import type { Tier } from '../pipeline/tier.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export async function initSchema(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

export function placementLabel(c: Candidate): string {
  const p = c.bestPlacement;
  return `${p.country} · ${p.genre} · ${p.chart} #${p.rank}`;
}

/** Сигналы из чартов — общие для полного апсерта и для обновления без LLM. */
function signalParams(c: Candidate) {
  return [
    c.trackId, c.name, c.developer, c.sellerUrl ?? null, c.primaryGenre, c.price,
    c.countryCount, c.countries, c.charts, c.bestRank, c.inGrossing,
    c.releaseDate ?? null, c.lastUpdate ?? null, c.ratingCount ?? null,
    c.artistId ?? null, c.bundleId ?? null, c.appStoreUrl ?? null, placementLabel(c),
    c.publisher?.apps ?? null, c.publisher?.totalRatings ?? null,
  ];
}

/** Апсертит лид после LLM: свежие сигналы + оценка модели, first_seen сохраняется. */
export async function upsertLead(c: Candidate, lead: Lead): Promise<void> {
  await pool.query(
    `INSERT INTO leads (
       track_id, name, developer, seller_url, primary_genre, price,
       country_count, countries, charts, best_rank, in_grossing,
       release_date, last_update, rating_count,
       artist_id, bundle_id, app_store_url, best_placement, publisher_apps, publisher_ratings,
       vertical, fit_score, needs_ua, reasons, pitch_hook, tier, tier_reason, qualified_at, last_seen
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
       $21,$22,$23,$24,$25,$26,$27, now(), now()
     )
     ON CONFLICT (track_id) DO UPDATE SET
       name=$2, developer=$3, seller_url=$4, primary_genre=$5, price=$6,
       country_count=$7, countries=$8, charts=$9, best_rank=$10, in_grossing=$11,
       release_date=$12, last_update=$13, rating_count=$14,
       artist_id=$15, bundle_id=$16, app_store_url=$17, best_placement=$18,
       publisher_apps=COALESCE($19, leads.publisher_apps), publisher_ratings=COALESCE($20, leads.publisher_ratings),
       vertical=$21, fit_score=$22, needs_ua=$23, reasons=$24, pitch_hook=$25, tier=$26, tier_reason=$27,
       qualified_at=now(), last_seen=now()`,
    [...signalParams(c), ...qualificationParams(lead)],
  );
}

function qualificationParams(lead: Lead) {
  return [lead.vertical, lead.fitScore, lead.needsUA, lead.reasons, lead.pitchHook, lead.tier, lead.tierReason];
}

/** Переоценка без сигналов из чартов (режим --rescore): только ответ модели. */
export async function saveQualification(trackId: string, lead: Lead): Promise<void> {
  await pool.query(
    `UPDATE leads SET vertical=$2, fit_score=$3, needs_ua=$4, reasons=$5, pitch_hook=$6,
       tier=$7, tier_reason=$8, qualified_at=now()
     WHERE track_id=$1`,
    [trackId, ...qualificationParams(lead)],
  );
}

/** Сохранённые лиды как кандидаты — для переоценки новым промптом без запросов к Apple. */
export async function leadsForRescore(onlyUnscored: boolean): Promise<Candidate[]> {
  const { rows } = await pool.query(
    `SELECT * FROM leads ${onlyUnscored ? 'WHERE tier IS NULL' : ''} ORDER BY fit_score DESC NULLS LAST`,
  );
  return rows.map((r) => {
    // best_placement: "de · Health & Fitness · top-free #12"
    const [country = '', genre = '', chartRank = ''] = String(r.best_placement ?? '').split(' · ');
    const [chart = '', rank = ''] = chartRank.split(' #');
    return {
      trackId: r.track_id,
      name: r.name,
      developer: r.developer,
      artistId: r.artist_id ? Number(r.artist_id) : undefined,
      bundleId: r.bundle_id ?? undefined,
      sellerUrl: r.seller_url ?? undefined,
      appStoreUrl: r.app_store_url ?? undefined,
      primaryGenre: r.primary_genre ?? 'Unknown',
      genres: r.primary_genre ? [r.primary_genre] : [],
      price: Number(r.price ?? 0),
      countries: r.countries ?? [],
      countryCount: r.country_count,
      charts: r.charts ?? [],
      bestRank: r.best_rank,
      bestPlacement: { country, genre, chart, rank: Number(rank) || r.best_rank },
      inGrossing: !!r.in_grossing,
      releaseDate: r.release_date?.toISOString(),
      lastUpdate: r.last_update?.toISOString(),
      ratingCount: r.rating_count ?? undefined,
      publisher:
        r.publisher_apps !== null
          ? { apps: r.publisher_apps, totalRatings: Number(r.publisher_ratings ?? 0) }
          : undefined,
    } satisfies Candidate;
  });
}

/** Недавно оценённый лид: обновляем только сигналы из чартов, модель не трогаем. */
export async function refreshSignals(c: Candidate): Promise<void> {
  await pool.query(
    `UPDATE leads SET
       name=$2, developer=$3, seller_url=$4, primary_genre=$5, price=$6,
       country_count=$7, countries=$8, charts=$9, best_rank=$10, in_grossing=$11,
       release_date=$12, last_update=$13, rating_count=$14,
       artist_id=$15, bundle_id=$16, app_store_url=$17, best_placement=$18,
       publisher_apps=COALESCE($19, publisher_apps), publisher_ratings=COALESCE($20, publisher_ratings),
       last_seen=now()
     WHERE track_id=$1`,
    signalParams(c),
  );
}

/** Снимает пометку needs_ua с лидов издателей из списка исключений (подстрока, без регистра). */
export async function hideExcludedPublishers(patterns: string[]): Promise<number> {
  if (patterns.length === 0) return 0;
  const likes = patterns.map((p) => `%${p.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
  const { rowCount } = await pool.query(
    `UPDATE leads SET needs_ua = false, tier = 'skip', tier_reason = 'крупная группа (список исключений)',
       fit_score = LEAST(fit_score, 29)
     WHERE COALESCE(tier, '') <> 'skip' AND lower(developer) LIKE ANY($1)`,
    [likes],
  );
  return rowCount ?? 0;
}

/** track_id лидов, оценённых моделью за последние days дней. */
export async function recentlyQualified(trackIds: string[], days: number): Promise<Set<string>> {
  if (trackIds.length === 0) return new Set();
  const { rows } = await pool.query(
    `SELECT track_id FROM leads
     WHERE track_id = ANY($1) AND tier IS NOT NULL AND qualified_at > now() - make_interval(days => $2)`,
    [trackIds, days],
  );
  return new Set(rows.map((r) => r.track_id as string));
}

export interface ContactTarget {
  trackId: string;
  name: string;
  bundleId: string | null;
  sellerUrl: string | null;
  country: string;
}

/**
 * Лиды, которым нужны контакты: подходят (needs_ua) и не проверялись recheckDays дней
 * или проверялись старой версией сбора (например, ещё без LinkedIn).
 */
export async function leadsNeedingContacts(recheckDays: number): Promise<ContactTarget[]> {
  const { rows } = await pool.query(
    `SELECT track_id, name, bundle_id, seller_url,
            CASE WHEN 'us' = ANY(countries) THEN 'us' ELSE countries[1] END AS country
     FROM leads
     WHERE needs_ua = true
       AND (contacts_checked_at IS NULL OR contacts_checked_at < now() - make_interval(days => $1)
            OR COALESCE(contacts_version, 1) < $2)
     ORDER BY fit_score DESC NULLS LAST`,
    [recheckDays, CONTACTS_VERSION],
  );
  return rows.map((r) => ({
    trackId: r.track_id,
    name: r.name,
    bundleId: r.bundle_id,
    sellerUrl: r.seller_url,
    country: r.country ?? 'us',
  }));
}

export async function saveContacts(trackId: string, c: Contacts): Promise<void> {
  await pool.query(
    `UPDATE leads SET
       website=$2, support_url=$3, privacy_url=$4, play_url=$5,
       email=$6, email_source=$7, emails=$8, email_personal=$9,
       -- ссылка с сайта важнее; если на сайте нет — оставляем найденную поиском
       linkedin_url = CASE WHEN $10::text IS NOT NULL THEN $10 WHEN linkedin_source = 'search' THEN linkedin_url END,
       linkedin_kind = CASE WHEN $10::text IS NOT NULL THEN $11 WHEN linkedin_source = 'search' THEN linkedin_kind END,
       linkedin_source = CASE WHEN $10::text IS NOT NULL THEN 'site' WHEN linkedin_source = 'search' THEN 'search' END,
       contacts_version=$12, contacts_checked_at=now()
     WHERE track_id=$1`,
    [
      trackId, c.website, c.supportUrl, c.privacyUrl, c.playUrl, c.email, c.emailSource, c.emails, c.emailPersonal,
      c.linkedinUrl, c.linkedinKind, CONTACTS_VERSION,
    ],
  );
}

/** Вид таблицы: active — целевые и под вопросом (целевые первыми), либо один уровень. */
export type LeadView = 'active' | Tier;

export interface LinkedInSearchTarget {
  trackId: string;
  name: string;
  developer: string;
  website: string | null;
  email: string | null;
  supportUrl: string | null;
  privacyUrl: string | null;
}

/**
 * Целевые лиды для автопоиска LinkedIn — лучшие первыми: где ещё не искали, и где старые
 * правила что-то нашли (их перепроверяем; где не нашли — новые, более строгие, тоже не найдут).
 */
export async function leadsNeedingLinkedInSearch(limit: number): Promise<LinkedInSearchTarget[]> {
  const { rows } = await pool.query(
    `SELECT track_id, name, developer, COALESCE(website, seller_url) AS website, email, support_url, privacy_url
     FROM leads
     WHERE tier = 'target'
       AND (linkedin_searched_at IS NULL
            OR (COALESCE(linkedin_search_version, 1) < $2
                AND (jsonb_array_length(COALESCE(linkedin_people, '[]'::jsonb)) > 0 OR linkedin_source = 'search')))
     ORDER BY fit_score DESC NULLS LAST, (email IS NOT NULL) DESC
     LIMIT $1`,
    [limit, LINKEDIN_SEARCH_VERSION],
  );
  return rows.map((r) => ({
    trackId: r.track_id, name: r.name, developer: r.developer, website: r.website,
    email: r.email, supportUrl: r.support_url, privacyUrl: r.privacy_url,
  }));
}

export async function saveLinkedInSearch(
  trackId: string,
  found: { companyUrl: string | null; people: Array<{ name: string; title: string | null; url: string }> },
): Promise<void> {
  await pool.query(
    `UPDATE leads SET
       linkedin_people = $2, linkedin_searched_at = now(), linkedin_search_version = $4,
       -- ссылка с сайта разработчика не трогается; найденная поиском заменяется новым результатом
       linkedin_url = CASE WHEN linkedin_source = 'site' THEN linkedin_url ELSE $3 END,
       linkedin_kind = CASE WHEN linkedin_source = 'site' THEN linkedin_kind WHEN $3::text IS NOT NULL THEN 'company' END,
       linkedin_source = CASE WHEN linkedin_source = 'site' THEN 'site' WHEN $3::text IS NOT NULL THEN 'search' END
     WHERE track_id = $1`,
    [trackId, JSON.stringify(found.people), found.companyUrl, LINKEDIN_SEARCH_VERSION],
  );
}

export interface LeadFilter {
  view?: LeadView;
  withEmail?: boolean;
  withLinkedIn?: boolean;
}

// Есть что-то из LinkedIn: страница компании или найденные люди.
const HAS_LINKEDIN = `(linkedin_url IS NOT NULL OR jsonb_array_length(COALESCE(linkedin_people, '[]'::jsonb)) > 0)`;

// Строки до появления уровней (tier IS NULL) считаем «под вопросом», пока их не переоценят.
const TIER_SQL = `COALESCE(tier, CASE WHEN needs_ua THEN 'maybe' ELSE 'skip' END)`;

export async function topLeads(limit = 100, { view = 'active', withEmail = false, withLinkedIn = false }: LeadFilter = {}) {
  const where = [view === 'active' ? `${TIER_SQL} IN ('target','maybe')` : `${TIER_SQL} = $2`];
  if (withEmail) where.push('email IS NOT NULL');
  if (withLinkedIn) where.push(HAS_LINKEDIN);
  const { rows } = await pool.query(
    `SELECT track_id, name, developer, vertical, primary_genre, app_store_url, best_placement,
            country_count, countries, best_rank, in_grossing, rating_count,
            publisher_apps, publisher_ratings,
            ${TIER_SQL} AS tier, tier_reason, fit_score, pitch_hook, reasons,
            email, email_source, emails, email_personal, linkedin_url, linkedin_kind, linkedin_people, linkedin_source,
            COALESCE(website, seller_url) AS website, support_url, privacy_url, play_url,
            contacts_checked_at, qualified_at, last_seen
     FROM leads
     WHERE ${where.join(' AND ')}
     ORDER BY CASE ${TIER_SQL} WHEN 'target' THEN 0 WHEN 'maybe' THEN 1 ELSE 2 END,
              fit_score DESC NULLS LAST, (email IS NOT NULL) DESC, country_count DESC
     LIMIT $1`,
    view === 'active' ? [limit] : [limit, view],
  );
  return rows;
}

export async function leadStats() {
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE ${TIER_SQL} = 'target')::int AS target,
            count(*) FILTER (WHERE ${TIER_SQL} = 'target' AND email IS NOT NULL)::int AS target_with_email,
            count(*) FILTER (WHERE ${TIER_SQL} = 'target' AND ${HAS_LINKEDIN})::int AS target_with_linkedin,
            count(*) FILTER (WHERE ${TIER_SQL} = 'target'
              AND jsonb_array_length(COALESCE(linkedin_people, '[]'::jsonb)) > 0)::int AS target_with_people,
            count(*) FILTER (WHERE ${TIER_SQL} = 'maybe')::int AS maybe,
            count(*) FILTER (WHERE ${TIER_SQL} = 'skip')::int AS skip,
            count(*) FILTER (WHERE tier IS NULL)::int AS unscored,
            count(*) FILTER (WHERE needs_ua AND contacts_checked_at IS NULL)::int AS unchecked
     FROM leads`,
  );
  return rows[0] as {
    target: number; target_with_email: number; target_with_linkedin: number; target_with_people: number;
    maybe: number; skip: number; unscored: number; unchecked: number;
  };
}
