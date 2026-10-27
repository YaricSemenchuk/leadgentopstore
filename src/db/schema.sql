CREATE TABLE IF NOT EXISTS leads (
  track_id        TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  developer       TEXT NOT NULL,
  seller_url      TEXT,
  primary_genre   TEXT,
  vertical        TEXT,
  price           NUMERIC DEFAULT 0,
  country_count   INT  NOT NULL DEFAULT 0,
  countries       TEXT[] NOT NULL DEFAULT '{}',
  charts          TEXT[] NOT NULL DEFAULT '{}',
  best_rank       INT,
  in_grossing     BOOLEAN DEFAULT FALSE,
  release_date    TIMESTAMPTZ,
  last_update     TIMESTAMPTZ,
  rating_count    INT,
  -- оценка модели
  fit_score       INT,
  needs_ua        BOOLEAN,
  reasons         TEXT[],
  pitch_hook      TEXT,
  -- служебное
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leads_fit     ON leads (fit_score DESC);
CREATE INDEX IF NOT EXISTS idx_leads_geo     ON leads (country_count DESC);
CREATE INDEX IF NOT EXISTS idx_leads_needsua ON leads (needs_ua);

-- v2: таргетинг по размеру издателя и контакты для холодного питча
ALTER TABLE leads ADD COLUMN IF NOT EXISTS artist_id           BIGINT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS bundle_id           TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS app_store_url       TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS best_placement      TEXT;        -- "de · Health & Fitness · top-free #12"
ALTER TABLE leads ADD COLUMN IF NOT EXISTS publisher_apps      INT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS publisher_ratings   BIGINT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS qualified_at        TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS website             TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS support_url         TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS privacy_url         TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS play_url            TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email               TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_source        TEXT;        -- google_play | support_page | privacy_policy | website
ALTER TABLE leads ADD COLUMN IF NOT EXISTS emails              TEXT[];      -- запасные адреса
ALTER TABLE leads ADD COLUMN IF NOT EXISTS email_personal      BOOLEAN;     -- бесплатный ящик: вероятно, частное лицо
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contacts_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_leads_email ON leads (email) WHERE email IS NOT NULL;

-- кэш чартов: iTunes RSS блокирует IP после сотен запросов подряд
CREATE TABLE IF NOT EXISTS chart_cache (
  key        TEXT PRIMARY KEY,               -- "us/top-free/6014/100"
  entries    JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- v3: уровень лида (target | maybe | skip) вместо одного needs_ua
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tier        TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tier_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_tier ON leads (tier, fit_score DESC);

-- v4: что парсить (страница «Что парсить») и история прогонов
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runs (
  id          SERIAL PRIMARY KEY,
  trigger     TEXT NOT NULL,                 -- ui | api | cli
  status      TEXT NOT NULL,                 -- running | done | failed | interrupted
  params      JSONB,
  result      JSONB,
  error       TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- v5: LinkedIn со страниц разработчика; версия сбора контактов (выросла — перепроверить)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS linkedin_url     TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS linkedin_kind    TEXT;   -- company | person
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contacts_version INT;

-- v6: автопоиск LinkedIn через поисковый API: люди (имя, должность, ссылка) и откуда ссылка на компанию
ALTER TABLE leads ADD COLUMN IF NOT EXISTS linkedin_people      JSONB;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS linkedin_source      TEXT;   -- site | search
ALTER TABLE leads ADD COLUMN IF NOT EXISTS linkedin_searched_at TIMESTAMPTZ;

-- v7: версия правил автопоиска LinkedIn — найденное старыми правилами перепроверяется
ALTER TABLE leads ADD COLUMN IF NOT EXISTS linkedin_search_version INT;

-- v8: компании — иерархия «компания → приложения → люди и почта». Ключ — id разработчика в App Store:
-- у одной компании бывает несколько приложений в чартах, а сайт, люди и почта у них общие.
CREATE TABLE IF NOT EXISTS companies (
  id                       SERIAL PRIMARY KEY,
  artist_id                BIGINT UNIQUE NOT NULL,
  name                     TEXT NOT NULL,          -- юрлицо или имя из App Store
  kind                     TEXT,                   -- company | individual
  -- блок продавца в App Store ЕС (DSA): Apple проверяет юрлицо по D-U-N-S
  is_trader                BOOLEAN,
  duns                     TEXT,
  address                  TEXT,
  country                  TEXT,
  phone                    TEXT,
  website                  TEXT,
  website_ok               BOOLEAN,                -- главная открылась
  support_url              TEXT,
  privacy_url              TEXT,
  -- приложения: все в App Store (портфель издателя) и в Google Play
  ios_apps                 INT,
  ios_ratings              BIGINT,
  ios_app_list             JSONB,                  -- [{id, name, ratings}] — крупнейшие
  play_developer_url       TEXT,
  play_developer_name      TEXT,
  android_apps             INT,
  android_app_list         JSONB,                  -- [{packageId, name}]
  -- размер: LinkedIn («Company size: 51-200 employees») или Hunter
  employees                TEXT,
  employees_min            INT,
  employees_source         TEXT,                   -- linkedin | hunter
  -- LinkedIn: страница компании и люди
  linkedin_url             TEXT,
  linkedin_source          TEXT,                   -- site | search
  linkedin_people          JSONB,                  -- [{name, title, url}]
  linkedin_people_version  INT,
  linkedin_company_version INT,
  linkedin_searched_at     TIMESTAMPTZ,
  -- почта: всё найденное, Hunter и итог
  emails_raw               JSONB,                  -- [{email, source}] — сторы и сайт
  hunter_emails            JSONB,
  hunter_pattern           TEXT,
  hunter_checked_at        TIMESTAMPTZ,
  emails                   JSONB,                  -- [{email, kind, free, sources, person, title, guessed}]
  email                    TEXT,                   -- кому писать первым
  email_pattern            TEXT,                   -- «{first}.{last}@domain»
  personal_emails          INT NOT NULL DEFAULT 0, -- найденные личные (без угаданных)
  guessed_emails           INT NOT NULL DEFAULT 0,
  contacts_version         INT,
  checked_at               TIMESTAMPTZ,
  first_seen               TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id);
CREATE INDEX IF NOT EXISTS idx_leads_company ON leads (company_id);

-- перенос: компания на каждого издателя; LinkedIn, найденный раньше на уровне приложения, — с лучшего лида
INSERT INTO companies (artist_id, name, ios_apps, ios_ratings, website, linkedin_url, linkedin_source,
                       linkedin_people, linkedin_people_version, linkedin_searched_at)
SELECT DISTINCT ON (artist_id) artist_id, developer, publisher_apps, publisher_ratings, COALESCE(website, seller_url),
       linkedin_url, linkedin_source, linkedin_people, linkedin_search_version, linkedin_searched_at
FROM leads
WHERE artist_id IS NOT NULL AND company_id IS NULL
ORDER BY artist_id, (linkedin_searched_at IS NOT NULL) DESC, fit_score DESC NULLS LAST
ON CONFLICT (artist_id) DO NOTHING;
UPDATE leads l SET company_id = c.id FROM companies c WHERE c.artist_id = l.artist_id AND l.company_id IS NULL;

-- v9: страница компании в LinkedIn сверена с доменом разработчика (с сайта или «Website» в карточке)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS linkedin_confirmed BOOLEAN;
