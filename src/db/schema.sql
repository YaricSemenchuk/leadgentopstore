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
