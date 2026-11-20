/**
 * Local SQLite backend (node:sqlite, no dependencies). Same exported functions and signatures as
 * ./directus.ts, so src/db/index.ts can swap one for the other. The schema lives in ./schema.sql and
 * is applied on every open, so a fresh clone just works: the first command creates data/job-search.db.
 */

import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { BulletVariant, JobExperience, JobSite, NewOpportunity, ResumeBullet, ResumeSkill, TriageItem } from "../types.ts";
import type {
  BonusRow,
  EnrichRow,
  InterestedItem,
  LivenessRow,
  ReviewItem,
  ScopeOpportunity,
} from "./directus.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

/** The database file: $SQLITE_PATH (relative to the repo root) or data/job-search.db. */
export function dbPath(): string {
  return resolve(REPO_ROOT, process.env.SQLITE_PATH ?? "data/job-search.db");
}

/** Where attached PDFs are copied (next to the database file). */
function filesDir(): string {
  return join(dirname(dbPath()), "files");
}

export const TABLES = ["job_sites", "job_opportunities", "job_experiences", "resume_bullets", "resume_skills", "files"] as const;
export type Table = (typeof TABLES)[number];

const BOOL_COLS = new Set(["scrape_enabled", "archived", "auto_drafted", "reviewed"]);
const JSON_COLS = new Set(["provider_config", "alt_titles", "variants"]);
const CSV_COLS = new Set(["themes", "target_role_types"]);

let db: DatabaseSync | undefined;

function open(): DatabaseSync {
  if (db) return db;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(join(HERE, "schema.sql"), "utf8"));
  return db;
}

const columnCache = new Map<string, Set<string>>();
function columns(table: Table): Set<string> {
  let cols = columnCache.get(table);
  if (!cols) {
    const rows = open().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    cols = new Set(rows.map((r) => r.name));
    columnCache.set(table, cols);
  }
  return cols;
}

/** SQLite row → the shape the Directus backend returns (real booleans, parsed JSON). */
function decode<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (BOOL_COLS.has(k)) out[k] = v === null ? null : Boolean(v);
    else if (JSON_COLS.has(k) && typeof v === "string") out[k] = JSON.parse(v);
    else out[k] = v;
  }
  return out as T;
}

/** A JS value → something SQLite can bind. */
function encode(col: string, v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (CSV_COLS.has(col) && Array.isArray(v)) return v.join(",");
  if (JSON_COLS.has(col) || typeof v === "object") return JSON.stringify(v);
  return v as SQLInputValue;
}

function select<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return (open().prepare(sql).all(...params) as Record<string, unknown>[]).map((r) => decode<T>(r));
}

/** `?, ?, ?` for an IN list. */
function marks(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

function checkColumns(table: Table, keys: string[]): void {
  const cols = columns(table);
  const bad = keys.filter((k) => !cols.has(k));
  if (bad.length) throw new Error(`Unknown ${table} column(s): ${bad.join(", ")} (see src/db/schema.sql)`);
}

/** Insert rows (ids generated when missing). `upsert` replaces the listed columns of an existing id. */
export function insertRows(table: Table, rows: Array<Record<string, unknown>>, opts: { upsert?: boolean } = {}): number {
  const d = open();
  d.exec("BEGIN");
  try {
    for (const raw of rows) {
      const row: Record<string, unknown> = { ...raw, id: (raw.id as string | undefined) ?? randomUUID() };
      const keys = Object.keys(row).filter((k) => row[k] !== undefined);
      checkColumns(table, keys);
      const conflict = opts.upsert
        ? ` ON CONFLICT(id) DO UPDATE SET ${keys.filter((k) => k !== "id").map((k) => `${k} = excluded.${k}`).join(", ") || "id = id"}`
        : "";
      d.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${marks(keys.length)})${conflict}`).run(
        ...keys.map((k) => encode(k, row[k])),
      );
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return rows.length;
}

function updateRows(table: Table, ids: string[], data: Record<string, unknown>): void {
  if (ids.length === 0) return;
  const keys = Object.keys(data).filter((k) => data[k] !== undefined && k !== "id");
  if (keys.length === 0) return;
  checkColumns(table, keys);
  open()
    .prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id IN (${marks(ids.length)})`)
    .run(...keys.map((k) => encode(k, data[k])), ...ids);
}

/** Not archived (null counts as active, matching the Directus filters). */
const ACTIVE = "(archived = 0 OR archived IS NULL)";

// ── Résumé content ───────────────────────────────────────────────────────────

const EXPERIENCE_COLS = "id, company, location, default_title, alt_titles, start_date, end_date, sort";
const BULLET_COLS = "id, bullet_point, experience, themes, target_role_types, reviewed, variants, credit";

export async function fetchExperiences(ids: string[]): Promise<JobExperience[]> {
  if (ids.length === 0) return [];
  return select(`SELECT ${EXPERIENCE_COLS} FROM job_experiences WHERE id IN (${marks(ids.length)})`, ...ids);
}

export async function fetchBullets(ids: string[]): Promise<ResumeBullet[]> {
  if (ids.length === 0) return [];
  return select(`SELECT ${BULLET_COLS} FROM resume_bullets WHERE id IN (${marks(ids.length)})`, ...ids);
}

export async function fetchAllExperiences(): Promise<JobExperience[]> {
  return select(`SELECT ${EXPERIENCE_COLS} FROM job_experiences ORDER BY sort NULLS LAST`);
}

export async function fetchAllBullets(): Promise<ResumeBullet[]> {
  return select(`SELECT ${BULLET_COLS} FROM resume_bullets`);
}

export async function fetchAllSkills(): Promise<ResumeSkill[]> {
  return select(
    "SELECT id, category, name, proficiency, target_role_types, sort FROM resume_skills ORDER BY category, sort NULLS LAST",
  );
}

export async function fetchBulletNotes(
  id: string,
): Promise<{ id: string; bullet_point: string; notes: string | null; experience: string | null; variants: BulletVariant[] | null } | null> {
  const rows = select<{ id: string; bullet_point: string; notes: string | null; experience: string | null; variants: BulletVariant[] | null }>(
    "SELECT id, bullet_point, notes, experience, variants FROM resume_bullets WHERE id = ?",
    id,
  );
  return rows[0] ?? null;
}

export async function createBullets(rows: Array<Record<string, unknown> & { id: string }>): Promise<void> {
  insertRows("resume_bullets", rows);
}

export async function updateBullet(id: string, data: Record<string, unknown>): Promise<void> {
  updateRows("resume_bullets", [id], data);
}

export async function createSkills(rows: Array<Record<string, unknown>>): Promise<void> {
  insertRows("resume_skills", rows);
}

// ── Discovery ────────────────────────────────────────────────────────────────

export async function fetchJobSites(): Promise<JobSite[]> {
  return select(
    "SELECT id, name, url, provider, provider_config, scrape_enabled, scrape_frequency, last_scraped, interest_level, title_filter FROM job_sites ORDER BY name",
  );
}

export async function fetchExistingOpportunityUrls(): Promise<Set<string>> {
  const rows = select<{ application_url: string }>(
    "SELECT application_url FROM job_opportunities WHERE application_url IS NOT NULL",
  );
  return new Set(rows.map((r) => r.application_url));
}

export async function findOpportunitiesByUrl(
  urls: string[],
): Promise<Array<{ id: string; job_title: string; company: string; status: string; archived: boolean | null; application_url: string }>> {
  if (urls.length === 0) return [];
  return select(
    `SELECT id, job_title, company, status, archived, application_url FROM job_opportunities WHERE application_url IN (${marks(urls.length)})`,
    ...urls,
  );
}

export async function fetchCompanyMaterials(
  company: string,
  excludeId: string,
): Promise<Array<{ id: string; job_title: string; status: string; materials_spec: string }>> {
  return select(
    "SELECT id, job_title, status, materials_spec FROM job_opportunities WHERE company = ? AND id != ? AND materials_spec IS NOT NULL",
    company,
    excludeId,
  );
}

export async function createOpportunities(rows: NewOpportunity[]): Promise<void> {
  insertRows("job_opportunities", rows as unknown as Array<Record<string, unknown>>);
}

export async function createOpportunity(row: Record<string, unknown> & { id: string }): Promise<void> {
  insertRows("job_opportunities", [row]);
}

export async function touchJobSite(id: string, isoTimestamp: string): Promise<void> {
  updateRows("job_sites", [id], { last_scraped: isoTimestamp });
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

const TRIAGE_COLS =
  "id, job_title, company, location, remote, application_url, listing_date, salary_min, salary_max, description";

export async function fetchTriageQueue(): Promise<TriageItem[]> {
  return select(
    `SELECT ${TRIAGE_COLS} FROM job_opportunities WHERE status = 'triage' AND ${ACTIVE} ORDER BY company, job_title`,
  );
}

export async function updateOpportunity(id: string, data: Record<string, unknown>): Promise<void> {
  updateRows("job_opportunities", [id], data);
}

export async function updateOpportunities(ids: string[], data: Record<string, unknown>): Promise<void> {
  updateRows("job_opportunities", ids, data);
}

export async function fetchInterestedQueue(): Promise<InterestedItem[]> {
  return select(
    `SELECT ${TRIAGE_COLS}, materials_confidence, auto_drafted FROM job_opportunities
     WHERE status = 'interested' AND ${ACTIVE} ORDER BY match_percentage DESC NULLS LAST`,
  );
}

type OpportunityDetail = TriageItem & {
  chain_of_thought: string | null;
  match_percentage: number | null;
  status: string;
  notes: string | null;
  materials_confidence: number | null;
  materials_assessment: string | null;
};

export async function fetchOpportunity(id: string): Promise<OpportunityDetail> {
  const rows = select<OpportunityDetail>(
    `SELECT ${TRIAGE_COLS}, chain_of_thought, match_percentage, status, notes, materials_confidence, materials_assessment
     FROM job_opportunities WHERE id = ?`,
    id,
  );
  const opp = rows[0];
  if (!opp) throw new Error(`No opportunity ${id}`);
  return opp;
}

export async function fetchGapScope(): Promise<ScopeOpportunity[]> {
  return select(
    `SELECT id, company, job_title, status, match_percentage, archived, description FROM job_opportunities
     WHERE status = 'interested' AND ${ACTIVE} ORDER BY match_percentage DESC NULLS LAST`,
  );
}

export async function fetchReviewQueue(): Promise<ReviewItem[]> {
  return select(
    `SELECT id, job_title, company, location, remote, salary_min, salary_max, listing_date, date_added, application_url,
            match_bonus, description, status, match_percentage, chain_of_thought, summary
     FROM job_opportunities WHERE status IN ('triage', 'new') AND ${ACTIVE}
     ORDER BY match_bonus DESC NULLS LAST, listing_date DESC NULLS LAST`,
  );
}

export async function fetchCompanyRows(company: string, includeArchived: boolean): Promise<EnrichRow[]> {
  return select(
    `SELECT id, job_title, company, location, remote, salary_min, salary_max, listing_date, description, application_url
     FROM job_opportunities WHERE company = ?${includeArchived ? "" : ` AND ${ACTIVE}`}`,
    company,
  );
}

export async function fetchBonusRows(): Promise<BonusRow[]> {
  return select(
    `SELECT id, location, description, salary_min, listing_date, remote, match_bonus FROM job_opportunities WHERE ${ACTIVE}`,
  );
}

export async function fetchLivenessRows(): Promise<LivenessRow[]> {
  return select(`SELECT id, job_title, company, status, application_url, notes FROM job_opportunities WHERE ${ACTIVE}`);
}

export async function fetchUntriagedRows(): Promise<
  Array<{ id: string; job_title: string; company: string; status: string; description: string | null; notes: string | null }>
> {
  return select(
    `SELECT id, job_title, company, status, description, notes FROM job_opportunities WHERE status IN ('triage', 'new') AND ${ACTIVE}`,
  );
}

export async function fetchRowsMissingSalary(
  includeArchived: boolean,
): Promise<Array<{ id: string; job_title: string; company: string; description: string | null }>> {
  return select(
    `SELECT id, job_title, company, description FROM job_opportunities
     WHERE salary_min IS NULL AND salary_max IS NULL${includeArchived ? "" : ` AND ${ACTIVE}`}`,
  );
}

// ── Files ────────────────────────────────────────────────────────────────────

/** Copy a PDF into data/files/ and record it; returns the file id (stored on resume_file / cover_letter_file). */
export async function uploadFile(filePath: string, filename: string, title?: string): Promise<string> {
  const id = randomUUID();
  const dir = filesDir();
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${id}.pdf`);
  copyFileSync(filePath, dest);
  insertRows("files", [{ id, filename, title: title ?? null, path: dest.startsWith(REPO_ROOT) ? relative(REPO_ROOT, dest) : dest }]);
  return id;
}

// ── `cli db` helpers (SQLite only) ───────────────────────────────────────────

/** Open (creating if needed) and report row counts per table. */
export function dbStatus(): { path: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    counts[t] = (open().prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  return { path: dbPath(), counts };
}

/**
 * Upsert a seed file: `{ "job_experiences": [...], "resume_bullets": [...], ... }`. Tables load in
 * dependency order (experiences before the bullets that reference them). Rows without an id get one.
 */
export function importSeed(seed: Record<string, unknown>): Record<string, number> {
  const order: Table[] = ["job_experiences", "resume_bullets", "resume_skills", "job_sites", "job_opportunities"];
  const unknown = Object.keys(seed).filter((k) => !k.startsWith("_") && !order.includes(k as Table));
  if (unknown.length) throw new Error(`Unknown seed table(s): ${unknown.join(", ")}. Expected: ${order.join(", ")}`);
  const loaded: Record<string, number> = {};
  for (const t of order) {
    const rows = seed[t];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const withIds = (rows as Array<Record<string, unknown>>).map((r, i) => ({ ...r, id: r.id ?? seedId(t, r, i) }));
    loaded[t] = insertRows(t, withIds, { upsert: true });
  }
  return loaded;
}

/**
 * A stable id for a seed row that has none, so re-importing updates instead of duplicating. Experiences
 * and bullets need explicit ids (bullets reference experiences, and specs reference bullets).
 */
function seedId(table: Table, r: Record<string, unknown>, index: number): string {
  const key =
    table === "resume_skills" ? `skill:${r.category}:${r.name}`
    : table === "job_sites" ? `site:${r.name}`
    : table === "job_opportunities" && r.application_url ? `opp:${r.application_url}`
    : undefined;
  if (!key) throw new Error(`${table}[${index}] needs an "id" (any unique string, e.g. "exp-acme").`);
  return key;
}

/** Run one SQL statement; returns its rows (empty for writes). */
export function runSql(sql: string): Array<Record<string, unknown>> {
  return select(sql);
}
