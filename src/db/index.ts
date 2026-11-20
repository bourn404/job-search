/**
 * The data layer. Every read/write in the app goes through these functions; which store backs them
 * is picked per call:
 *
 *   DB_BACKEND=sqlite | directus    explicit choice
 *   (unset)                         directus when DIRECTUS_URL + DIRECTUS_TOKEN are set, else sqlite
 *
 * SQLite (src/db/sqlite.ts) is a local file at data/job-search.db and needs no setup. Directus
 * (src/db/directus.ts) is the hosted option with an admin UI. Both expose identical functions.
 */

import * as directus from "./directus.ts";
import * as sqlite from "./sqlite.ts";

type Backend = typeof directus;

// Compile-time check: the SQLite backend implements every Directus function with the same signature.
const _sqliteMatches: Backend = sqlite;
void _sqliteMatches;

export type BackendName = "sqlite" | "directus";

export function backendName(): BackendName {
  const b = process.env.DB_BACKEND?.trim().toLowerCase();
  if (b === "sqlite" || b === "directus") return b;
  if (b) throw new Error(`DB_BACKEND must be "sqlite" or "directus" (got "${process.env.DB_BACKEND}")`);
  return process.env.DIRECTUS_URL && process.env.DIRECTUS_TOKEN ? "directus" : "sqlite";
}

function impl(): Backend {
  return backendName() === "directus" ? directus : sqlite;
}

/** Resolve the backend at call time (the CLI loads .env after modules are imported). */
function route<K extends keyof Backend>(name: K): Backend[K] {
  return ((...args: unknown[]) => (impl()[name] as (...a: unknown[]) => unknown)(...args)) as Backend[K];
}

export type { BonusRow, EnrichRow, InterestedItem, LivenessRow, ReviewItem, ScopeOpportunity } from "./directus.ts";

export const fetchExperiences = route("fetchExperiences");
export const fetchBullets = route("fetchBullets");
export const fetchAllExperiences = route("fetchAllExperiences");
export const fetchAllBullets = route("fetchAllBullets");
export const fetchAllSkills = route("fetchAllSkills");
export const fetchBulletNotes = route("fetchBulletNotes");
export const createBullets = route("createBullets");
export const updateBullet = route("updateBullet");
export const createSkills = route("createSkills");

export const fetchJobSites = route("fetchJobSites");
export const fetchExistingOpportunityUrls = route("fetchExistingOpportunityUrls");
export const findOpportunitiesByUrl = route("findOpportunitiesByUrl");
export const fetchCompanyMaterials = route("fetchCompanyMaterials");
export const createOpportunities = route("createOpportunities");
export const createOpportunity = route("createOpportunity");
export const touchJobSite = route("touchJobSite");

export const fetchTriageQueue = route("fetchTriageQueue");
export const updateOpportunity = route("updateOpportunity");
export const updateOpportunities = route("updateOpportunities");
export const fetchInterestedQueue = route("fetchInterestedQueue");
export const fetchOpportunity = route("fetchOpportunity");
export const fetchGapScope = route("fetchGapScope");
export const fetchReviewQueue = route("fetchReviewQueue");
export const fetchCompanyRows = route("fetchCompanyRows");
export const fetchBonusRows = route("fetchBonusRows");
export const fetchLivenessRows = route("fetchLivenessRows");
export const fetchUntriagedRows = route("fetchUntriagedRows");
export const fetchRowsMissingSalary = route("fetchRowsMissingSalary");

export const uploadFile = route("uploadFile");
