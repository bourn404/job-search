/** Shared types for the resume/cover-letter pipeline. */

import type { SkillLine, EducationEntry } from "../config/profile.ts";

/** ── Directus row shapes (only the fields we read) ──────────────────────── */

export interface JobExperience {
  id: string;
  company: string;
  location: string | null;
  default_title: string;
  alt_titles: string[] | null;
  start_date: string | null; // ISO date
  end_date: string | null; // ISO date, null = "Present"
  sort: number | null;
}

export interface ResumeBullet {
  id: string;
  bullet_point: string;
  experience: string | null; // FK -> JobExperience.id
  themes: string | null; // CSV
  target_role_types: string | null; // CSV
  reviewed: boolean; // have we reviewed/refined this bullet together?
  variants: BulletVariant[] | null; // approved alternate wordings (one-line, angle-specific)
  credit: BulletCredit | null; // Carson's role: led / built / contributed
}

/** Carson's role in a bullet's work; drives the verb ("Led" vs "Built" vs "Helped build"). */
export type BulletCredit = "led" | "built" | "contributed";

/**
 * An approved alternate wording of a pool bullet. Tailoring picks from these before rewording
 * fresh, so approved one-liners and JD-angle rewrites carry over to the next résumé.
 */
export interface BulletVariant {
  text: string;
  kind: "one_line" | "short" | "angle";
  angle?: string; // e.g. "growth", "performance", "design-systems", "ux" (for kind "angle")
  source?: string; // where it was approved, e.g. "specs/ramp-software-engineer-frontend.json"
  approved: string; // YYYY-MM-DD
}

/** A skill in the pool, grouped by category and self-rated 1–5 for per-role weighting. */
export interface ResumeSkill {
  id: string;
  category: string;
  name: string;
  proficiency: number | null;
  target_role_types: string | null; // CSV
  sort: number | null;
}

/** A curated watchlist entry (one company/board to poll for openings). */
export interface JobSite {
  id: string;
  name: string;
  url: string | null;
  provider: string | null; // ATS, e.g. "Greenhouse", "Ashby", "Custom (Greenhouse backend)"
  provider_config: Record<string, unknown> | null; // e.g. { board_token } or { tenant, site, dc }
  scrape_enabled: boolean;
  scrape_frequency: "daily" | "weekly" | "manual" | null;
  last_scraped: string | null; // ISO timestamp
  interest_level: number | null;
  /** Discovery title pre-filter: "standard" (default) or "strict" (no generic "software engineer"). */
  title_filter: "standard" | "strict" | null;
}

/** A job_opportunities row awaiting AI triage. */
export interface TriageItem {
  id: string;
  job_title: string;
  company: string;
  location: string | null;
  remote: string | null;
  application_url: string;
  listing_date: string | null;
  salary_min: number | null;
  salary_max: number | null;
  description: string | null;
}

/** A new job_opportunities row produced by discovery. */
export interface NewOpportunity {
  id: string;
  job_title: string;
  company: string;
  location: string;
  remote: string | null;
  application_url: string;
  status: string;
  archived?: boolean;
  notes?: string;
  date_added: string; // YYYY-MM-DD
  listing_date: string | null;
  salary_min: number | null;
  salary_max: number | null;
  description: string | null;
}

/** ── The selection spec: the AI ⇄ deterministic boundary ────────────────── */

export type RenderKind = "resume" | "cover-letter" | "both";

/**
 * A bullet to render. `text` is what appears (the AI may reword/rephrase it to fit the job,
 * as long as the core truth is unchanged). `sourceId` anchors it to the resume_bullets pool
 * entry it derives from — required, so every rendered bullet is auditable against a real
 * accomplishment and nothing is fabricated. If no suitable source exists, add a bullet to
 * the pool first rather than inventing one here.
 */
export interface SpecBullet {
  sourceId: string;
  text: string;
}

export interface SpecExperience {
  /**
   * One or more job_experiences.id merged into a single block. Multiple ids collapse
   * several stints at one employer into one entry (one title, one bullet set) whose
   * date ranges are all shown (newest first). Most entries list exactly one id.
   */
  experienceIds: string[];
  /** Title for the block; defaults to the first (most recent) experience's default_title. */
  titleOverride?: string;
  /** Shared bullet set, in render order; each anchored to a pool bullet via sourceId.
   *  Leave empty to render the entry as a compact one-liner (header only, no bullets). */
  bullets: SpecBullet[];
  /** Date display granularity. "year" shows year-only ranges (for older roles). Default "month". */
  dateGranularity?: "month" | "year";
}

export interface CoverLetterSpec {
  greeting: string;
  body: string[];
  signoff: string;
}

export interface SelectionSpec {
  kind: RenderKind;
  /** Optional override of the default headline. */
  headline?: string;
  experiences: SpecExperience[];
  /** Optional override of the default Key Skills block. */
  skills?: SkillLine[];
  coverLetter?: CoverLetterSpec;
  /** Auto mode (/autopilot): each question Claude would have asked Carson and the assumption it made instead. Not rendered. */
  autoNotes?: string[];
}

/** ── The render model: fully-resolved, self-contained input to Typst ────── */

/**
 * One résumé experience block, rendered as a single header line —
 * "Title, Company, Location" (title emphasized) with the date range(s) right-aligned —
 * followed by the bullet set. Multiple date ranges = merged stints at one employer.
 */
export interface RenderEntry {
  title: string;
  company: string;
  location: string;
  dateRanges: string[]; // e.g. ["Jul 2019 - Nov 2021", "Jun 2016 - Oct 2016"]
  bullets: string[];
}

export interface RenderModel {
  kind: RenderKind;
  name: string;
  headline: string;
  contact: { email: string; phone: string; links: string[] };
  skills: SkillLine[];
  experiences: RenderEntry[];
  education: EducationEntry[];
  coverLetter?: CoverLetterSpec;
}
