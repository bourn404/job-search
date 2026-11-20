-- Local SQLite schema. Mirrors the Directus collections field-for-field, so either backend can sit
-- behind src/db/index.ts. Applied idempotently on every open (CREATE ... IF NOT EXISTS).
--
-- Conventions:
--   * ids are TEXT (UUIDs from crypto.randomUUID(), or any unique string you like in a seed file)
--   * booleans are INTEGER 0/1 (the backend converts to true/false on read)
--   * JSON columns hold JSON text (the backend parses them on read, stringifies on write)
--   * dates are ISO text: 'YYYY-MM-DD' for dates, full ISO for timestamps
--   * CSV columns (themes, target_role_types) are comma-separated text, e.g. 'AI,Accessibility'

-- The watchlist: one row per company/board that `discover` polls.
CREATE TABLE IF NOT EXISTS job_sites (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  url                     TEXT,
  provider                TEXT,               -- ATS name, matched by substring: Greenhouse, Lever, Ashby, Workday, ...
  provider_config         TEXT,               -- JSON, e.g. {"board_token":"anthropic"}
  scrape_enabled          INTEGER NOT NULL DEFAULT 1,
  scrape_frequency        TEXT DEFAULT 'daily' CHECK (scrape_frequency IN ('daily','weekly','manual')),
  last_scraped            TEXT,               -- ISO timestamp, set by discover
  notes                   TEXT,
  interest_level          INTEGER,            -- 1-5, informational
  navigation_instructions TEXT,
  title_filter            TEXT DEFAULT 'standard' CHECK (title_filter IN ('standard','strict'))
);

-- The pipeline: every role discover/intake has found, through applied/rejected.
CREATE TABLE IF NOT EXISTS job_opportunities (
  id                   TEXT PRIMARY KEY,
  job_title            TEXT,
  company              TEXT,
  location             TEXT,
  remote               TEXT CHECK (remote IN ('fully_remote','hybrid','on_site')),
  salary_min           INTEGER,
  salary_max           INTEGER,
  summary              TEXT,                -- one-line AI summary (triage)
  match_percentage     INTEGER,             -- AI triage score 0-100
  chain_of_thought     TEXT,                -- AI triage reasoning
  application_url      TEXT,
  status               TEXT CHECK (status IN ('triage','new','interested','pending_approval','approved',
                                              'applied','interviewing','rejected','skipped','ai_skipped')),
  date_added           TEXT DEFAULT (date('now')),
  notes                TEXT,
  applied_at           TEXT,
  listing_date         TEXT,
  description          TEXT,                -- full job description (plain text / markdown)
  resume_file          TEXT REFERENCES files(id),
  cover_letter_file    TEXT REFERENCES files(id),
  materials_spec       TEXT,                -- spec filename under specs/
  archived             INTEGER NOT NULL DEFAULT 0,
  match_bonus          INTEGER DEFAULT 0,   -- deterministic priority (config/priority.ts)
  materials_confidence INTEGER,             -- /assess score 0-100
  materials_assessment TEXT,
  auto_drafted         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS job_opportunities_status ON job_opportunities (status, archived);
CREATE INDEX IF NOT EXISTS job_opportunities_url ON job_opportunities (application_url);
CREATE INDEX IF NOT EXISTS job_opportunities_company ON job_opportunities (company);

-- Résumé content: one row per job you've held.
CREATE TABLE IF NOT EXISTS job_experiences (
  id            TEXT PRIMARY KEY,
  company       TEXT NOT NULL,
  location      TEXT,
  default_title TEXT NOT NULL,
  alt_titles    TEXT,                       -- JSON array of truthful alternate titles a spec may pick from
  start_date    TEXT,                       -- 'YYYY-MM-DD'
  end_date      TEXT,                       -- NULL = Present
  sort          INTEGER                     -- 1 = most recent
);

-- Résumé content: the bullet pool tailoring selects from. Every rendered bullet cites one of these.
CREATE TABLE IF NOT EXISTS resume_bullets (
  id                TEXT PRIMARY KEY,
  bullet_point      TEXT,
  themes            TEXT,                   -- CSV, e.g. 'Accessibility,Design Systems'
  target_role_types TEXT,                   -- CSV
  notes             TEXT,                   -- background/context for the AI, never rendered
  experience        TEXT REFERENCES job_experiences(id),
  reviewed          INTEGER NOT NULL DEFAULT 0,
  variants          TEXT,                   -- JSON array of approved alternate wordings (see BulletVariant)
  credit            TEXT CHECK (credit IN ('led','built','contributed'))
);
CREATE INDEX IF NOT EXISTS resume_bullets_experience ON resume_bullets (experience);

-- Résumé content: the skill pool (grouped by category, self-rated 1-5).
CREATE TABLE IF NOT EXISTS resume_skills (
  id                TEXT PRIMARY KEY,
  category          TEXT NOT NULL,
  name              TEXT NOT NULL,
  proficiency       INTEGER,
  target_role_types TEXT,                   -- CSV
  sort              INTEGER
);

-- Attached PDFs (tailor attach). The file itself is copied to data/files/.
CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  filename   TEXT NOT NULL,                 -- download name, e.g. 'Jane Doe - Resume - Acme.pdf'
  title      TEXT,
  path       TEXT NOT NULL,                 -- relative to the repo root, e.g. 'data/files/<id>.pdf'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
