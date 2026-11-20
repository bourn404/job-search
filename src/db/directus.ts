/** Thin Directus REST client (read + the writes discovery/triage/tailor need). */

import { readFile } from "node:fs/promises";
import type {
  BulletVariant,
  JobExperience,
  JobSite,
  NewOpportunity,
  ResumeBullet,
  ResumeSkill,
  TriageItem,
} from "../types.ts";

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in (see README).`,
    );
  }
  return v;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${env("DIRECTUS_TOKEN")}`, ...extra };
}

async function getItems<T>(
  collection: string,
  query: Record<string, string>,
): Promise<T[]> {
  const base = env("DIRECTUS_URL").replace(/\/$/, "");
  const url = new URL(`${base}/items/${collection}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(
      `Directus ${collection} request failed: ${res.status} ${res.statusText}`,
    );
  }
  const json = (await res.json()) as { data: T[] };
  return json.data;
}

async function postItems<T>(collection: string, rows: T[]): Promise<void> {
  if (rows.length === 0) return;
  const base = env("DIRECTUS_URL").replace(/\/$/, "");
  const res = await fetch(`${base}/items/${collection}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    throw new Error(
      `Directus create ${collection} failed: ${res.status} ${res.statusText} ${await res.text()}`,
    );
  }
}

async function patchItem(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
  const base = env("DIRECTUS_URL").replace(/\/$/, "");
  const res = await fetch(`${base}/items/${collection}/${id}`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error(`Directus update ${collection}/${id} failed: ${res.status} ${res.statusText}`);
  }
}

export async function fetchExperiences(ids: string[]): Promise<JobExperience[]> {
  if (ids.length === 0) return [];
  return getItems<JobExperience>("job_experiences", {
    "filter[id][_in]": ids.join(","),
    fields: "id,company,location,default_title,alt_titles,start_date,end_date,sort",
    limit: "-1",
  });
}

export async function fetchBullets(ids: string[]): Promise<ResumeBullet[]> {
  if (ids.length === 0) return [];
  return getItems<ResumeBullet>("resume_bullets", {
    "filter[id][_in]": ids.join(","),
    fields: "id,bullet_point,experience,themes,target_role_types,reviewed,variants,credit",
    limit: "-1",
  });
}

// ── Discovery ───────────────────────────────────────────────────────────────

export async function fetchJobSites(): Promise<JobSite[]> {
  return getItems<JobSite>("job_sites", {
    fields:
      "id,name,url,provider,provider_config,scrape_enabled,scrape_frequency,last_scraped,interest_level,title_filter",
    limit: "-1",
    sort: "name",
  });
}

/** All existing application URLs (archived included, so archived roles aren't re-discovered), for cross-run dedupe. */
export async function fetchExistingOpportunityUrls(): Promise<Set<string>> {
  const rows = await getItems<{ application_url: string | null }>("job_opportunities", {
    fields: "application_url",
    limit: "-1",
  });
  return new Set(rows.map((r) => r.application_url).filter((u): u is string => !!u));
}

/** Opportunities whose application_url matches any of `urls` (archived included). */
export async function findOpportunitiesByUrl(
  urls: string[],
): Promise<Array<{ id: string; job_title: string; company: string; status: string; archived: boolean | null; application_url: string }>> {
  if (urls.length === 0) return [];
  return getItems("job_opportunities", {
    "filter[application_url][_in]": urls.join(","),
    fields: "id,job_title,company,status,archived,application_url",
    limit: "-1",
  });
}

/** Other opportunities at this company that already have materials (for reusing a letter's angle). */
export async function fetchCompanyMaterials(
  company: string,
  excludeId: string,
): Promise<Array<{ id: string; job_title: string; status: string; materials_spec: string }>> {
  return getItems("job_opportunities", {
    "filter[company][_eq]": company,
    "filter[id][_neq]": excludeId,
    "filter[materials_spec][_nnull]": "true",
    fields: "id,job_title,status,materials_spec",
    limit: "-1",
  });
}

/** Rows per POST: one site's full descriptions in one request can exceed Directus' body-size limit (Capital One). */
const CREATE_BATCH = 25;

export async function createOpportunities(rows: NewOpportunity[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CREATE_BATCH) {
    await postItems("job_opportunities", rows.slice(i, i + CREATE_BATCH));
  }
}

/** Create one opportunity with any fields (manual intake carries score/notes discovery doesn't). */
export async function createOpportunity(row: Record<string, unknown> & { id: string }): Promise<void> {
  await postItems("job_opportunities", [row]);
}

export async function touchJobSite(id: string, isoTimestamp: string): Promise<void> {
  await patchItem("job_sites", id, { last_scraped: isoTimestamp });
}

// ── Triage ───────────────────────────────────────────────────────────────────

/** Work-queue filter: rows with `status`, excluding archived ones (`archived` is nullable → null = active). */
function activeWithStatus(status: string): Record<string, string> {
  return {
    "filter[_and][0][status][_eq]": status,
    "filter[_and][1][_or][0][archived][_eq]": "false",
    "filter[_and][1][_or][1][archived][_null]": "true",
  };
}

export async function fetchTriageQueue(): Promise<TriageItem[]> {
  return getItems<TriageItem>("job_opportunities", {
    ...activeWithStatus("triage"),
    fields: "id,job_title,company,location,remote,application_url,listing_date,salary_min,salary_max,description",
    limit: "-1",
    sort: "company,job_title",
  });
}

export async function updateOpportunity(id: string, data: Record<string, unknown>): Promise<void> {
  await patchItem("job_opportunities", id, data);
}

// ── Tailoring (Phase 3) ──────────────────────────────────────────────────────

/** An interested row plus what /assess and /autopilot track on it. */
export type InterestedItem = TriageItem & { materials_confidence: number | null; auto_drafted: boolean | null };

/** Opportunities the human flagged "interested" — i.e. asking for tailored materials. */
export async function fetchInterestedQueue(): Promise<InterestedItem[]> {
  return getItems<InterestedItem>("job_opportunities", {
    ...activeWithStatus("interested"),
    fields:
      "id,job_title,company,location,remote,application_url,listing_date,salary_min,salary_max,description,materials_confidence,auto_drafted",
    limit: "-1",
    sort: "-match_percentage",
  });
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
  const rows = await getItems<OpportunityDetail>(
    "job_opportunities",
    {
      "filter[id][_eq]": id,
      fields:
        "id,job_title,company,location,remote,application_url,listing_date,salary_min,salary_max,description,chain_of_thought,match_percentage,status,notes,materials_confidence,materials_assessment",
      limit: "1",
    },
  );
  const opp = rows[0];
  if (!opp) throw new Error(`No opportunity ${id}`);
  return opp;
}

export async function fetchAllExperiences(): Promise<JobExperience[]> {
  return getItems<JobExperience>("job_experiences", {
    fields: "id,company,location,default_title,alt_titles,start_date,end_date,sort",
    limit: "-1",
    sort: "sort",
  });
}

export async function fetchAllBullets(): Promise<ResumeBullet[]> {
  return getItems<ResumeBullet>("resume_bullets", {
    fields: "id,bullet_point,experience,themes,target_role_types,reviewed,variants,credit",
    limit: "-1",
  });
}

export async function fetchAllSkills(): Promise<ResumeSkill[]> {
  return getItems<ResumeSkill>("resume_skills", {
    fields: "id,category,name,proficiency,target_role_types,sort",
    limit: "-1",
    sort: "category,sort",
  });
}

// ── Bullet-gap analysis ──────────────────────────────────────────────────────

export interface ScopeOpportunity {
  id: string;
  company: string;
  job_title: string;
  status: string;
  match_percentage: number | null;
  archived: boolean | null;
  description: string | null;
}

/** Opportunities for gap analysis: status `interested`, not archived (null archived counts as active). */
export async function fetchGapScope(): Promise<ScopeOpportunity[]> {
  return getItems<ScopeOpportunity>("job_opportunities", {
    ...activeWithStatus("interested"),
    fields: "id,company,job_title,status,match_percentage,archived,description",
    limit: "-1",
    sort: "-match_percentage",
  });
}

// ── Manual review (cli review) ─────────────────────────────────────────────────

export interface ReviewItem {
  id: string;
  job_title: string;
  company: string;
  location: string | null;
  remote: string | null;
  salary_min: number | null;
  salary_max: number | null;
  listing_date: string | null;
  date_added: string | null;
  application_url: string | null;
  match_bonus: number | null;
  description: string | null;
  status: string;
  /** AI triage score (0-100), set on keeps. */
  match_percentage: number | null;
  /** AI triage reasoning. */
  chain_of_thought: string | null;
  summary: string | null;
}

/**
 * The manual review queue: un-archived `triage` rows (not yet AI-triaged) and `new` rows (kept + scored by
 * AI triage, awaiting Carson's human review). The review server orders them (see src/review/server.ts).
 */
export async function fetchReviewQueue(): Promise<ReviewItem[]> {
  return getItems<ReviewItem>("job_opportunities", {
    "filter[_and][0][status][_in]": "triage,new",
    "filter[_and][1][_or][0][archived][_eq]": "false",
    "filter[_and][1][_or][1][archived][_null]": "true",
    fields:
      "id,job_title,company,location,remote,salary_min,salary_max,listing_date,date_added,application_url,match_bonus,description,status,match_percentage,chain_of_thought,summary",
    limit: "-1",
    sort: "-match_bonus,-listing_date",
  });
}

// ── Enrichment backfill (cli enrich) ─────────────────────────────────────────────

export interface EnrichRow {
  id: string;
  job_title: string;
  company: string;
  location: string | null;
  remote: string | null;
  salary_min: number | null;
  salary_max: number | null;
  listing_date: string | null;
  description: string | null;
  application_url: string;
}

/** Opportunities for one company (exact name), non-archived unless includeArchived. */
export async function fetchCompanyRows(company: string, includeArchived: boolean): Promise<EnrichRow[]> {
  const q: Record<string, string> = includeArchived
    ? { "filter[company][_eq]": company }
    : {
        "filter[_and][0][company][_eq]": company,
        "filter[_and][1][_or][0][archived][_eq]": "false",
        "filter[_and][1][_or][1][archived][_null]": "true",
      };
  return getItems<EnrichRow>("job_opportunities", {
    ...q,
    fields: "id,job_title,company,location,remote,salary_min,salary_max,listing_date,description,application_url",
    limit: "-1",
  });
}

// ── Match bonus ──────────────────────────────────────────────────────────────

export interface BonusRow {
  id: string;
  location: string | null;
  description: string | null;
  salary_min: number | null;
  listing_date: string | null;
  remote: string | null;
  match_bonus: number | null;
}

/** Every non-archived opportunity, with the fields the match bonus reads. */
export async function fetchBonusRows(): Promise<BonusRow[]> {
  return getItems<BonusRow>("job_opportunities", {
    "filter[_or][0][archived][_eq]": "false",
    "filter[_or][1][archived][_null]": "true",
    fields: "id,location,description,salary_min,listing_date,remote,match_bonus",
    limit: "-1",
  });
}

/** Batch-update many opportunities with the same data (one request). */
export async function updateOpportunities(ids: string[], data: Record<string, unknown>): Promise<void> {
  if (ids.length === 0) return;
  const base = env("DIRECTUS_URL").replace(/\/$/, "");
  const res = await fetch(`${base}/items/job_opportunities`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ keys: ids, data }),
  });
  if (!res.ok) throw new Error(`Directus batch update job_opportunities failed: ${res.status} ${res.statusText}`);
}

export async function fetchBulletNotes(id: string): Promise<{ id: string; bullet_point: string; notes: string | null; experience: string | null; variants: BulletVariant[] | null } | null> {
  const rows = await getItems<{ id: string; bullet_point: string; notes: string | null; experience: string | null; variants: BulletVariant[] | null }>("resume_bullets", {
    "filter[id][_eq]": id,
    fields: "id,bullet_point,notes,experience,variants",
    limit: "1",
  });
  return rows[0] ?? null;
}

export async function createBullets(rows: Array<Record<string, unknown> & { id: string }>): Promise<void> {
  await postItems("resume_bullets", rows);
}

export async function updateBullet(id: string, data: Record<string, unknown>): Promise<void> {
  await patchItem("resume_bullets", id, data);
}

export async function createSkills(rows: Array<Record<string, unknown>>): Promise<void> {
  await postItems("resume_skills", rows);
}

/** Upload a local file to Directus (directus_files) and return its id. */
export async function uploadFile(filePath: string, filename: string, title?: string): Promise<string> {
  const base = env("DIRECTUS_URL").replace(/\/$/, "");
  const buf = await readFile(filePath);
  const form = new FormData();
  if (title) form.append("title", title);
  form.append("file", new Blob([buf], { type: "application/pdf" }), filename);
  const res = await fetch(`${base}/files`, {
    method: "POST",
    headers: authHeaders(), // do NOT set Content-Type; fetch adds the multipart boundary
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Directus file upload failed: ${res.status} ${res.statusText} ${await res.text()}`);
  }
  return ((await res.json()) as { data: { id: string } }).data.id;
}

// ── Liveness check ───────────────────────────────────────────────────────────

export interface LivenessRow {
  id: string;
  job_title: string;
  company: string;
  status: string;
  application_url: string | null;
  notes: string | null;
}

/** Every non-archived opportunity, with what the open/closed check needs. */
export async function fetchLivenessRows(): Promise<LivenessRow[]> {
  return getItems<LivenessRow>("job_opportunities", {
    "filter[_or][0][archived][_eq]": "false",
    "filter[_or][1][archived][_null]": "true",
    fields: "id,job_title,company,status,application_url,notes",
    limit: "-1",
  });
}

/** Non-archived rows still waiting on a decision (triage or new), with their descriptions. */
export async function fetchUntriagedRows(): Promise<Array<{ id: string; job_title: string; company: string; status: string; description: string | null; notes: string | null }>> {
  return getItems("job_opportunities", {
    "filter[_and][0][status][_in]": "triage,new",
    "filter[_and][1][_or][0][archived][_eq]": "false",
    "filter[_and][1][_or][1][archived][_null]": "true",
    fields: "id,job_title,company,status,description,notes",
    limit: "-1",
  });
}

/** Rows with no salary at all (non-archived unless includeArchived), with their descriptions. */
export async function fetchRowsMissingSalary(includeArchived: boolean): Promise<Array<{ id: string; job_title: string; company: string; description: string | null }>> {
  const q: Record<string, string> = {
    "filter[_and][0][salary_min][_null]": "true",
    "filter[_and][1][salary_max][_null]": "true",
    ...(includeArchived ? {} : { "filter[_and][2][_or][0][archived][_eq]": "false", "filter[_and][2][_or][1][archived][_null]": "true" }),
  };
  return getItems("job_opportunities", { ...q, fields: "id,job_title,company,description", limit: "-1" });
}
