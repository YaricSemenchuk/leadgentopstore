import { pool, TIER_SQL, type LeadView } from './pool.js';
import { COMPANY_CONTACTS_VERSION, type CompanyContacts, type CompanyInput, type CompanyKind, type EmailInputs } from '../contacts/company.js';
import type { CompanyEmails, EmailPattern, FoundEmail } from '../contacts/emails.js';
import type { HunterResult } from '../contacts/hunter.js';
import { LINKEDIN_COMPANY_VERSION, LINKEDIN_SEARCH_VERSION, type LinkedInFound } from '../contacts/people-search.js';
import type { PublisherStats } from '../apple/lookup.js';
import { detectCountry } from '../contacts/store-pages.js';

/** Лучший уровень и балл среди приложений компании; в чарте у компании может быть несколько приложений. */
const COMPANY_APPS = `
  SELECT l.company_id,
         min(CASE ${TIER_SQL} WHEN 'target' THEN 0 WHEN 'maybe' THEN 1 ELSE 2 END) AS tier_rank,
         max(l.fit_score) AS best_fit
  FROM leads l WHERE l.company_id IS NOT NULL GROUP BY l.company_id`;

const HAS_PEOPLE = `jsonb_array_length(COALESCE(c.linkedin_people, '[]'::jsonb)) > 0`;

export interface CompanyTarget extends CompanyInput {
  artistId: number;
  hasPortfolio: boolean;
}

/**
 * Компании, которым нужны контакты: есть подходящее приложение (целевое или под вопросом) и
 * компанию не проверяли recheckDays дней или проверяли старой версией сбора. Лучшие первыми.
 */
export async function companiesNeedingContacts(recheckDays: number): Promise<CompanyTarget[]> {
  const { rows } = await pool.query(
    `SELECT c.id, c.artist_id, c.name, c.ios_app_list IS NOT NULL AS has_portfolio, a.apps
     FROM companies c
     JOIN (
       SELECT l.company_id,
              min(CASE ${TIER_SQL} WHEN 'target' THEN 0 ELSE 1 END) AS tier_rank,
              max(l.fit_score) AS best_fit,
              jsonb_agg(jsonb_build_object(
                'trackId', l.track_id, 'name', l.name, 'bundleId', l.bundle_id, 'sellerUrl', l.seller_url,
                'country', COALESCE(CASE WHEN 'us' = ANY(l.countries) THEN 'us' ELSE l.countries[1] END, 'us')
              ) ORDER BY l.fit_score DESC NULLS LAST) AS apps
       FROM leads l WHERE l.company_id IS NOT NULL AND l.needs_ua GROUP BY l.company_id
     ) a ON a.company_id = c.id
     WHERE c.checked_at IS NULL OR c.checked_at < now() - make_interval(days => $1)
        OR COALESCE(c.contacts_version, 0) < $2
     ORDER BY a.tier_rank, a.best_fit DESC NULLS LAST`,
    [recheckDays, COMPANY_CONTACTS_VERSION],
  );
  return rows.map((r) => ({ id: r.id, artistId: Number(r.artist_id), name: r.name, apps: r.apps, hasPortfolio: r.has_portfolio }));
}

/** Все приложения компании в App Store — крупнейшие 30 по отзывам. */
export async function savePortfolio(artistId: number, s: PublisherStats): Promise<void> {
  const list = [...s.list].sort((a, b) => b.ratings - a.ratings).slice(0, 30);
  await pool.query(
    `UPDATE companies SET ios_apps = $2, ios_ratings = $3, ios_app_list = $4 WHERE artist_id = $1`,
    [artistId, s.apps, s.totalRatings, JSON.stringify(list)],
  );
}

export async function saveCompanyContacts(id: number, cc: CompanyContacts): Promise<void> {
  const t = cc.trader;
  // страна — последняя строка адреса из App Store ЕС или Google Play
  const country = t?.country ?? detectCountry(cc.playDeveloper?.address);
  await pool.query(
    `UPDATE companies SET
       kind = $2, is_trader = $3, duns = $4, address = COALESCE($5, $19), country = $6, phone = COALESCE($7, $20),
       website = $8, website_ok = $9, support_url = $10, privacy_url = $11,
       play_developer_url = $12, play_developer_name = $13, android_apps = $14, android_app_list = $15,
       emails_raw = $16,
       -- ссылка с сайта важнее; если на сайте нет — оставляем найденную поиском
       linkedin_url = CASE WHEN $17::text IS NOT NULL THEN $17 WHEN linkedin_source = 'search' THEN linkedin_url END,
       linkedin_source = CASE WHEN $17::text IS NOT NULL THEN 'site' WHEN linkedin_source = 'search' THEN 'search' END,
       linkedin_confirmed = CASE WHEN $17::text IS NOT NULL THEN true WHEN linkedin_source = 'search' THEN linkedin_confirmed END,
       contacts_version = $18, checked_at = now()
     WHERE id = $1`,
    [
      id, cc.kind, t?.isTrader ?? null, t?.duns ?? null, t?.address ?? null, country, t?.phone ?? null,
      cc.website, cc.websiteOk, cc.supportUrl, cc.privacyUrl,
      cc.playDeveloperUrl, cc.playDeveloper?.name ?? null, cc.androidApps?.length ?? null,
      cc.androidApps ? JSON.stringify(cc.androidApps.slice(0, 50)) : null,
      JSON.stringify(cc.emailsRaw), cc.linkedinSite?.url ?? null, COMPANY_CONTACTS_VERSION,
      cc.playDeveloper?.address ?? null, cc.playDeveloper?.phone ?? null,
    ],
  );
  for (const a of cc.appPlayUrls) {
    await pool.query(`UPDATE leads SET play_url = $2 WHERE track_id = $1`, [a.trackId, a.playUrl]);
  }
}

export interface LinkedInTarget {
  id: number;
  name: string;
  kind: CompanyKind | null;
  website: string | null;
  email: string | null;
  supportUrl: string | null;
  privacyUrl: string | null;
  linkedinUrl: string | null;
  linkedinSource: string | null;
  needCompany: boolean;  // страница компании и размер (1 запрос)
  needPeople: boolean;   // люди (1 запрос)
}

/**
 * Компании для автопоиска LinkedIn — целевые, затем под вопросом, лучшие первыми. Люди ищутся
 * один раз (повторно — только если старые правила что-то нашли); страница компании — заново,
 * если её искали без размера (до v4).
 */
export async function companiesNeedingLinkedIn(limit: number): Promise<LinkedInTarget[]> {
  const needPeople = `(c.linkedin_searched_at IS NULL OR (COALESCE(c.linkedin_people_version, 1) < $2
                       AND (${HAS_PEOPLE} OR c.linkedin_source = 'search')))`;
  const needCompany = `(COALESCE(c.kind, '') <> 'individual' AND COALESCE(c.linkedin_company_version, 0) < $3)`;
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.kind, c.website, c.email, c.support_url, c.privacy_url, c.linkedin_url, c.linkedin_source,
            ${needPeople} AS need_people, ${needCompany} AS need_company
     FROM companies c JOIN (${COMPANY_APPS}) a ON a.company_id = c.id
     WHERE a.tier_rank <= 1 AND c.checked_at IS NOT NULL AND (${needPeople} OR ${needCompany})
     ORDER BY a.tier_rank, a.best_fit DESC NULLS LAST, (c.email IS NOT NULL) DESC
     LIMIT $1`,
    [limit, LINKEDIN_SEARCH_VERSION, LINKEDIN_COMPANY_VERSION],
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, kind: r.kind, website: r.website, email: r.email, supportUrl: r.support_url,
    privacyUrl: r.privacy_url, linkedinUrl: r.linkedin_url, linkedinSource: r.linkedin_source,
    needCompany: r.need_company, needPeople: r.need_people,
  }));
}

export async function saveLinkedIn(id: number, found: LinkedInFound, did: { company: boolean; people: boolean }): Promise<void> {
  await pool.query(
    `UPDATE companies SET
       linkedin_people = CASE WHEN $3 THEN $4::jsonb ELSE linkedin_people END,
       linkedin_people_version = CASE WHEN $3 THEN $8 ELSE linkedin_people_version END,
       linkedin_company_version = $9,
       -- ссылка с сайта разработчика не трогается; найденная поиском заменяется новым результатом
       linkedin_url = CASE WHEN linkedin_source = 'site' OR NOT $2 THEN linkedin_url ELSE $5 END,
       linkedin_source = CASE WHEN linkedin_source = 'site' OR NOT $2 THEN linkedin_source WHEN $5::text IS NOT NULL THEN 'search' END,
       linkedin_confirmed = CASE WHEN linkedin_source = 'site' OR NOT $2 THEN linkedin_confirmed ELSE $10 END,
       employees = CASE WHEN $6::text IS NOT NULL THEN $6 ELSE employees END,
       employees_min = CASE WHEN $6::text IS NOT NULL THEN $7 ELSE employees_min END,
       employees_source = CASE WHEN $6::text IS NOT NULL THEN 'linkedin' ELSE employees_source END,
       linkedin_searched_at = now()
     WHERE id = $1`,
    [
      id, did.company, did.people, JSON.stringify(found.people), found.companyUrl,
      found.companySize?.range ?? null, found.companySize?.min ?? null, LINKEDIN_SEARCH_VERSION, LINKEDIN_COMPANY_VERSION,
      found.companyUrl ? found.companyConfirmed : null,
    ],
  );
}

export interface HunterTarget {
  id: number;
  website: string | null;
  supportUrl: string | null;
  privacyUrl: string | null;
  email: string | null;
}

/** Компании для Hunter: целевые, затем под вопросом; частные лица — нет (у них нет сотрудников). */
export async function companiesNeedingHunter(limit: number): Promise<HunterTarget[]> {
  const { rows } = await pool.query(
    `SELECT c.id, c.website, c.support_url, c.privacy_url, c.email
     FROM companies c JOIN (${COMPANY_APPS}) a ON a.company_id = c.id
     WHERE a.tier_rank <= 1 AND c.checked_at IS NOT NULL AND c.hunter_checked_at IS NULL
       AND COALESCE(c.kind, 'company') = 'company'
     ORDER BY a.tier_rank, a.best_fit DESC NULLS LAST
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ id: r.id, website: r.website, supportUrl: r.support_url, privacyUrl: r.privacy_url, email: r.email }));
}

/** Результат Hunter; null — проверять нечего (нет своего домена). Размер — только если LinkedIn его не дал. */
export async function saveHunter(id: number, domain: string | null, r: HunterResult | null): Promise<void> {
  await pool.query(
    `UPDATE companies SET
       hunter_emails = $2, hunter_pattern = $3, hunter_checked_at = now(),
       employees = CASE WHEN employees IS NULL AND $4::text IS NOT NULL THEN $4 ELSE employees END,
       employees_min = CASE WHEN employees IS NULL AND $4::text IS NOT NULL THEN $5 ELSE employees_min END,
       employees_source = CASE WHEN employees IS NULL AND $4::text IS NOT NULL THEN 'hunter' ELSE employees_source END
     WHERE id = $1`,
    [
      id, JSON.stringify(r?.emails ?? []), r?.pattern && domain ? `${r.pattern}@${domain}` : null,
      r?.size?.range ?? null, r?.size?.min ?? null,
    ],
  );
}

function parsePattern(v: string | null): EmailPattern | null {
  const m = v?.match(/^(.+)@([^@]+)$/);
  return m ? { pattern: m[1], domain: m[2] } : null;
}

/** Всё, из чего складывается итоговая почта компании. */
export async function emailInputs(id: number): Promise<EmailInputs | null> {
  const { rows } = await pool.query(
    `SELECT name, kind, website, support_url, privacy_url, emails_raw, hunter_emails, hunter_pattern, linkedin_people
     FROM companies WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    name: r.name,
    kind: r.kind ?? 'company',
    website: r.website,
    supportUrl: r.support_url,
    privacyUrl: r.privacy_url,
    emailsRaw: (r.emails_raw ?? []) as FoundEmail[],
    hunterEmails: (r.hunter_emails ?? []) as FoundEmail[],
    hunterPattern: parsePattern(r.hunter_pattern),
    people: ((r.linkedin_people ?? []) as Array<{ name: string; title: string | null }>).map((p) => ({ name: p.name, title: p.title })),
  };
}

export async function saveCompanyEmails(id: number, e: CompanyEmails): Promise<void> {
  await pool.query(
    `UPDATE companies SET emails = $2, email = $3, email_pattern = $4, personal_emails = $5, guessed_emails = $6 WHERE id = $1`,
    [
      id, JSON.stringify(e.emails), e.best?.email ?? null, e.pattern ? `${e.pattern.pattern}@${e.pattern.domain}` : null,
      e.emails.filter((x) => x.kind === 'personal' && !x.guessed).length, e.emails.filter((x) => x.guessed).length,
    ],
  );
}

// --- Вид «Компании» ---

/** Размер: от 50 сотрудников (LinkedIn «51-200» и выше), 11–50, до 10 и частные лица, неизвестно. */
export type SizeFilter = 'any' | '50' | '11' | '10' | 'unknown';

export interface CompanyFilter {
  view: LeadView;
  size: SizeFilter;
  withEmail: boolean;
  withPersonal: boolean;
  withPlay: boolean;
  withLinkedIn: boolean;
}

const SIZE_SQL: Record<SizeFilter, string | null> = {
  any: null,
  '50': `c.employees_min >= 51`,
  '11': `c.employees_min BETWEEN 11 AND 50`,
  '10': `(c.employees_min <= 10 OR c.kind = 'individual')`,
  unknown: `(c.employees_min IS NULL AND COALESCE(c.kind, '') <> 'individual')`,
};

const TIER_RANK: Record<string, number> = { target: 0, maybe: 1, skip: 2 };

export async function topCompanies(limit: number, f: CompanyFilter) {
  const where: string[] = [];
  const params: unknown[] = [limit];
  if (f.view === 'active') where.push('a.tier_rank <= 1');
  else {
    params.push(TIER_RANK[f.view]);
    where.push(`a.tier_rank = $${params.length}`);
  }
  const size = SIZE_SQL[f.size];
  if (size) where.push(size);
  if (f.withEmail) where.push('c.email IS NOT NULL');
  if (f.withPersonal) where.push('c.personal_emails > 0');
  if (f.withPlay) where.push('c.android_apps > 0');
  if (f.withLinkedIn) where.push(`(c.linkedin_url IS NOT NULL OR ${HAS_PEOPLE})`);
  const { rows } = await pool.query(
    `SELECT c.*, a.tier_rank, a.best_fit, a.chart_apps, a.apps, a.pitch_hook,
            (ARRAY['target','maybe','skip'])[a.tier_rank + 1] AS tier
     FROM companies c
     JOIN (
       SELECT l.company_id,
              min(CASE ${TIER_SQL} WHEN 'target' THEN 0 WHEN 'maybe' THEN 1 ELSE 2 END) AS tier_rank,
              max(l.fit_score) AS best_fit,
              count(*)::int AS chart_apps,
              (array_agg(l.pitch_hook ORDER BY l.fit_score DESC NULLS LAST))[1] AS pitch_hook,
              jsonb_agg(jsonb_build_object(
                'name', l.name, 'url', l.app_store_url, 'play', l.play_url, 'tier', ${TIER_SQL}, 'fit', l.fit_score,
                'placement', l.best_placement, 'countries', l.country_count, 'ratings', l.rating_count,
                'vertical', COALESCE(l.vertical, l.primary_genre), 'reason', l.tier_reason
              ) ORDER BY l.fit_score DESC NULLS LAST) AS apps
       FROM leads l WHERE l.company_id IS NOT NULL GROUP BY l.company_id
     ) a ON a.company_id = c.id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.tier_rank, a.best_fit DESC NULLS LAST, c.personal_emails DESC, (c.email IS NOT NULL) DESC
     LIMIT $1`,
    params,
  );
  return rows;
}

export async function companyStats() {
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE a.tier_rank = 0)::int AS target,
            count(*) FILTER (WHERE a.tier_rank = 0 AND c.email IS NOT NULL)::int AS target_with_email,
            count(*) FILTER (WHERE a.tier_rank = 0 AND c.personal_emails > 0)::int AS target_with_personal,
            count(*) FILTER (WHERE a.tier_rank = 0 AND c.employees_min >= 51)::int AS target_50,
            count(*) FILTER (WHERE a.tier_rank <= 1 AND c.employees_min >= 51)::int AS active_50,
            count(*) FILTER (WHERE a.tier_rank = 0 AND c.android_apps > 0)::int AS target_on_play,
            count(*) FILTER (WHERE a.tier_rank = 0 AND (c.linkedin_url IS NOT NULL OR ${HAS_PEOPLE}))::int AS target_with_linkedin,
            count(*) FILTER (WHERE a.tier_rank = 0 AND c.duns IS NOT NULL)::int AS target_verified,
            count(*) FILTER (WHERE a.tier_rank = 1)::int AS maybe,
            count(*) FILTER (WHERE a.tier_rank = 2)::int AS skip,
            count(*) FILTER (WHERE a.tier_rank <= 1 AND c.checked_at IS NULL)::int AS unchecked,
            (SELECT count(*)::int FROM leads l WHERE ${TIER_SQL} = 'target') AS target_apps
     FROM companies c JOIN (${COMPANY_APPS}) a ON a.company_id = c.id`,
  );
  return rows[0] as {
    target: number; target_with_email: number; target_with_personal: number; target_50: number; active_50: number;
    target_on_play: number; target_with_linkedin: number; target_verified: number; maybe: number; skip: number;
    unchecked: number; target_apps: number;
  };
}
