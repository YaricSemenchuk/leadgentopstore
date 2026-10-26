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
