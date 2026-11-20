/** Discovery layer types: normalized postings + the per-provider adapter contract. */

import type { JobSite } from "../types.ts";

/** A job posting normalized across ATS providers, before it becomes a job_opportunity. */
export interface JobPosting {
  /** Provider-native id (for logging/debugging; dedupe is by URL). */
  externalId: string;
  title: string;
  company: string;
  location: string;
  /** Canonical application/listing URL — the dedupe key. */
  url: string;
  remote: "fully_remote" | "hybrid" | "on_site" | null;
  /** ISO date (YYYY-MM-DD) the posting went live, if known. */
  listingDate: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  /** Plain-text job description (capped), for AI triage/scoring. Null if unavailable. */
  description: string | null;
  /** Country name when the provider reports one (Workday detail: "United States of America"). */
  country?: string | null;
}

/** An adapter fetches and normalizes postings for one watchlist site. */
export type Adapter = (site: JobSite) => Promise<JobPosting[]>;
