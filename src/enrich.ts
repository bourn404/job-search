/**
 * Backfill existing opportunities with a site's detail fetch (the same one discovery runs on new rows):
 * JSON-LD salary/locations for `detail: "jsonld"` sites like Stripe, Workday descriptions + dates, etc.
 * Only fills gaps and improves location text; never blanks a field.
 */

import { adapterNameFor, getDetailFetcher } from "./discovery/adapters.ts";
import type { JobPosting } from "./discovery/types.ts";
import { fetchCompanyRows, fetchJobSites, updateOpportunity, type EnrichRow } from "./db/index.ts";

export interface EnrichReport {
  site: string;
  rows: number;
  changed: number;
  failed: number;
  samples: Array<{ title: string; changes: Record<string, unknown> }>;
  dryRun: boolean;
}

function toPosting(r: EnrichRow): JobPosting {
  return {
    externalId: r.id,
    title: r.job_title,
    company: r.company,
    location: r.location ?? "",
    url: r.application_url,
    remote: (r.remote as JobPosting["remote"]) ?? null,
    listingDate: r.listing_date,
    salaryMin: r.salary_min,
    salaryMax: r.salary_max,
    description: r.description,
  };
}

/** Only fill what's missing (or replace location text with the richer detail version). */
function diff(r: EnrichRow, p: JobPosting): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (r.salary_min == null && p.salaryMin != null) out.salary_min = p.salaryMin;
  if (r.salary_max == null && p.salaryMax != null) out.salary_max = p.salaryMax;
  if (p.location && p.location !== (r.location ?? "")) out.location = p.location;
  if (r.remote == null && p.remote) out.remote = p.remote;
  if (r.listing_date == null && p.listingDate) out.listing_date = p.listingDate;
  if (!r.description && p.description) out.description = p.description;
  return out;
}

/** Names of enabled sites using a provider (e.g. every Greenhouse board), for `enrich --provider`. */
export async function sitesForProvider(provider: string): Promise<string[]> {
  return (await fetchJobSites()).filter((s) => s.scrape_enabled && adapterNameFor(s.provider) === provider).map((s) => s.name);
}

export async function enrichSite(opts: { site: string; includeArchived?: boolean; dryRun?: boolean }): Promise<EnrichReport> {
  const sites = await fetchJobSites();
  const needle = opts.site.toLowerCase();
  const site = sites.find((s) => s.name.toLowerCase() === needle) ?? sites.find((s) => s.name.toLowerCase().includes(needle));
  if (!site) throw new Error(`No watchlist site matching "${opts.site}"`);
  const adapter = adapterNameFor(site.provider);
  const fetchDetail = adapter ? getDetailFetcher(adapter, site) : undefined;
  if (!fetchDetail) throw new Error(`${site.name}: no detail fetch configured (provider ${site.provider}; set provider_config.detail = "jsonld"?)`);

  const rows = await fetchCompanyRows(site.name, !!opts.includeArchived);
  const report: EnrichReport = { site: site.name, rows: rows.length, changed: 0, failed: 0, samples: [], dryRun: !!opts.dryRun };
  for (const r of rows) {
    try {
      const changes = diff(r, await fetchDetail(toPosting(r), site));
      if (Object.keys(changes).length > 0) {
        report.changed++;
        if (report.samples.length < 5) report.samples.push({ title: r.job_title, changes: { ...changes, description: changes.description ? "(filled)" : undefined } });
        if (!opts.dryRun) await updateOpportunity(r.id, changes);
      }
    } catch {
      report.failed++;
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  return report;
}
