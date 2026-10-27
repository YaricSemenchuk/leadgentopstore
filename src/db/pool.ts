import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import type { Candidate } from '../pipeline/aggregate.js';
import type { Lead } from '../llm/qualify.js';
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
  await ensureCompany(c);
}

/**
 * Компания разработчика для лида: создаётся по id разработчика в App Store, лид привязывается к ней.
 * Размер портфеля обновляется, если его только что посчитали.
 */
export async function ensureCompany(c: Candidate): Promise<void> {
  if (!c.artistId) return;
  const { rows } = await pool.query(
    `INSERT INTO companies (artist_id, name, ios_apps, ios_ratings) VALUES ($1, $2, $3, $4)
     ON CONFLICT (artist_id) DO UPDATE SET name = $2,
       ios_apps = COALESCE($3, companies.ios_apps), ios_ratings = COALESCE($4, companies.ios_ratings)
     RETURNING id`,
    [c.artistId, c.developer, c.publisher?.apps ?? null, c.publisher?.totalRatings ?? null],
  );
  await pool.query(`UPDATE leads SET company_id = $2 WHERE track_id = $1 AND company_id IS DISTINCT FROM $2`, [c.trackId, rows[0].id]);
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
          ? { apps: r.publisher_apps, totalRatings: Number(r.publisher_ratings ?? 0), list: [] }
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
  await ensureCompany(c);
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

/** Вид таблицы: active — целевые и под вопросом (целевые первыми), либо один уровень. */
export type LeadView = 'active' | Tier;

export interface LeadFilter {
  view?: LeadView;
  withEmail?: boolean;
  withLinkedIn?: boolean;
}

// Строки до появления уровней (tier IS NULL) считаем «под вопросом», пока их не переоценят.
export const TIER_SQL = `COALESCE(l.tier, CASE WHEN l.needs_ua THEN 'maybe' ELSE 'skip' END)`;

// Контакты — у компании; старые поля лида остаются запасным вариантом, пока компанию не проверили.
const LEAD_EMAIL = `COALESCE(c.email, l.email)`;
const LEAD_HAS_LINKEDIN = `(COALESCE(c.linkedin_url, l.linkedin_url) IS NOT NULL
  OR jsonb_array_length(COALESCE(c.linkedin_people, l.linkedin_people, '[]'::jsonb)) > 0)`;

/** Приложения (вид «Приложения»): одна строка — одно приложение, контакты — его компании. */
export async function topLeads(limit = 100, { view = 'active', withEmail = false, withLinkedIn = false }: LeadFilter = {}) {
  const where = [view === 'active' ? `${TIER_SQL} IN ('target','maybe')` : `${TIER_SQL} = $2`];
  if (withEmail) where.push(`${LEAD_EMAIL} IS NOT NULL`);
  if (withLinkedIn) where.push(LEAD_HAS_LINKEDIN);
  const { rows } = await pool.query(
    `SELECT l.track_id, l.name, l.developer, l.vertical, l.primary_genre, l.app_store_url, l.best_placement,
            l.country_count, l.countries, l.best_rank, l.in_grossing, l.rating_count,
            l.publisher_apps, l.publisher_ratings,
            ${TIER_SQL} AS tier, l.tier_reason, l.fit_score, l.pitch_hook, l.reasons,
            ${LEAD_EMAIL} AS email, l.email_source, COALESCE(c.emails, '[]'::jsonb) AS company_emails,
            l.emails AS legacy_emails, l.email_personal,
            COALESCE(c.linkedin_url, l.linkedin_url) AS linkedin_url,
            CASE WHEN c.linkedin_url IS NOT NULL THEN 'company' ELSE l.linkedin_kind END AS linkedin_kind,
            COALESCE(c.linkedin_people, l.linkedin_people) AS linkedin_people,
            COALESCE(c.website, l.website, l.seller_url) AS website, COALESCE(c.support_url, l.support_url) AS support_url,
            COALESCE(c.privacy_url, l.privacy_url) AS privacy_url, l.play_url,
            c.id AS company_id, c.name AS company_name, c.employees, c.kind AS company_kind, c.personal_emails,
            COALESCE(c.checked_at, l.contacts_checked_at) AS contacts_checked_at, l.qualified_at, l.last_seen
     FROM leads l LEFT JOIN companies c ON c.id = l.company_id
     WHERE ${where.join(' AND ')}
     ORDER BY CASE ${TIER_SQL} WHEN 'target' THEN 0 WHEN 'maybe' THEN 1 ELSE 2 END,
              l.fit_score DESC NULLS LAST, (${LEAD_EMAIL} IS NOT NULL) DESC, l.country_count DESC
     LIMIT $1`,
    view === 'active' ? [limit] : [limit, view],
  );
  return rows;
}
