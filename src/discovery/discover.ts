/** Discovery orchestrator: walk the watchlist, run adapters, dedupe, write new openings. */

import { randomUUID } from "node:crypto";
import { parseSalaryRange } from "./salary.ts";
import { MAX_LISTING_AGE_DAYS, descriptionExcludedBy, keywordsFor, titleMatches } from "../../config/discovery.ts";
import {
  createOpportunities,
  fetchExistingOpportunityUrls,
  fetchJobSites,
  touchJobSite,
} from "../db/index.ts";
import type { JobSite, NewOpportunity } from "../types.ts";
import { adapterNameFor, getAdapter, getDetailFetcher } from "./adapters.ts";

/** True if the posting is recent enough (or its date is unknown). */
function withinAge(listingDate: string | null, now: Date, maxDays: number): boolean {
  if (!listingDate) return true; // unknown age → keep rather than wrongly drop
  const t = Date.parse(listingDate);
  if (Number.isNaN(t)) return true;
  return t >= now.getTime() - maxDays * 86_400_000;
}

/** Freshly discovered openings land in "triage" — awaiting the AI gatekeeper, which will
 *  either mark them "ai_skipped" (no score) or promote to "new" (vetted + scored). */
const DISCOVERED_STATUS = "triage";

export interface SiteResult {
  site: string;
  provider: string | null;
  adapter: string | null;
  found: number; // total postings the adapter returned
  matched: number; // postings passing the keyword pre-filter
  /** Detail fetches for providers whose listings lack descriptions (Workday). */
  detailed?: number;
  /** Dropped after the detail fetch revealed a posting date older than the age limit. */
  agedOut?: number;
  /** Dropped because the reported country isn't in provider_config.countries. */
  wrongCountry?: number;
  /** Saved archived + ai_skipped because the description hit DESCRIPTION_EXCLUDE (e.g. "Java"). */
  descExcluded?: number;
  /** Postings whose salary came from parsing the description. */
  payParsed?: number;
  created: number; // new (deduped) opportunities written
  skipped?: string;
  error?: string;
}

export interface DiscoverOptions {
  /** Only this site (by name, case-insensitive substring). Bypasses enabled/due checks. */
  site?: string;
  /** All enabled sites, regardless of due-ness. */
  all?: boolean;
  /** Fetch + dedupe but don't write to Directus. */
  dryRun?: boolean;
  /** Skip the keyword pre-filter (capture every role). */
  noFilter?: boolean;
  /** Max listing age in days (older postings are dropped). Default MAX_LISTING_AGE_DAYS. */
  maxAgeDays?: number;
  /** Current time (injected for determinism/testing). */
  now?: Date;
  /** Called as each site starts, during its detail fetches, and when it finishes. */
  onProgress?: (event: DiscoverProgress) => void;
}

export type DiscoverProgress =
  | { kind: "site"; index: number; total: number; site: string }
  | { kind: "detail"; index: number; total: number; site: string; done: number; of: number }
  | { kind: "result"; index: number; total: number; result: SiteResult };

function isDue(site: JobSite, now: Date): boolean {
  if (site.scrape_frequency === "manual") return false;
  if (!site.last_scraped) return true;
  const days = (now.getTime() - Date.parse(site.last_scraped)) / 86_400_000;
  if (site.scrape_frequency === "weekly") return days >= 7;
  return days >= 1; // daily (and any unset cadence)
}

function selectSites(sites: JobSite[], opts: DiscoverOptions, now: Date): JobSite[] {
  if (opts.site) {
    const needle = opts.site.toLowerCase();
    return sites.filter((s) => s.name.toLowerCase().includes(needle));
  }
  const enabled = sites.filter((s) => s.scrape_enabled);
  return opts.all ? enabled : enabled.filter((s) => isDue(s, now));
}

export async function discover(opts: DiscoverOptions = {}): Promise<SiteResult[]> {
  const now = opts.now ?? new Date();
  const dateAdded = now.toISOString().slice(0, 10);

  const [sites, seenUrls] = await Promise.all([
    fetchJobSites(),
    fetchExistingOpportunityUrls(),
  ]);

  const targets = selectSites(sites, opts, now);
  const results: SiteResult[] = [];
  const progress = opts.onProgress ?? (() => {});
  const total = targets.length;

  for (const [index, site] of targets.entries()) {
    progress({ kind: "site", index, total, site: site.name });
    const adapterName = adapterNameFor(site.provider);
    const base: SiteResult = {
      site: site.name,
      provider: site.provider,
      adapter: adapterName,
      found: 0,
      matched: 0,
      created: 0,
    };

    if (!adapterName) {
      const result = { ...base, skipped: `unsupported provider "${site.provider}"` };
      results.push(result);
      progress({ kind: "result", index, total, result });
      continue;
    }

    try {
      const postings = await getAdapter(adapterName)(site);
      base.found = postings.length;

      const keywords = keywordsFor(site);
      const maxAge = opts.maxAgeDays ?? MAX_LISTING_AGE_DAYS;
      const candidates = postings.filter(
        (p) => withinAge(p.listingDate, now, maxAge) && (opts.noFilter || titleMatches(p.title, keywords)),
      );
      base.matched = candidates.length;

      // Dedupe first, so detail fetches only hit postings we'd actually write.
      let unseen = candidates.filter((p) => p.url && !seenUrls.has(p.url));

      // Providers whose listings lack descriptions (Workday): fetch details for the survivors,
      // then re-apply the age filter now that the real posting date is known.
      // Greenhouse's fetcher is for backfill only; its list call already carries pay ranges.
      const fetchDetail = adapterName === "greenhouse" && site.provider_config?.detail !== "jsonld" ? undefined : getDetailFetcher(adapterName, site);
      if (fetchDetail && unseen.length > 0) {
        const detailed: typeof unseen = [];
        for (const p of unseen) {
          try {
            detailed.push(await fetchDetail(p, site));
          } catch {
            detailed.push(p); // keep it; triage can still judge by title, and a re-run can't refetch
          }
          progress({ kind: "detail", index, total, site: site.name, done: detailed.length, of: unseen.length });
          await new Promise((r) => setTimeout(r, 300)); // polite; Workday sits behind Akamai
        }
        base.detailed = detailed.length;
        const before = detailed.length;
        unseen = detailed.filter((p) => withinAge(p.listingDate, now, maxAge));
        base.agedOut = before - unseen.length;
      }

      // Optional country allow-list (provider_config.countries, e.g. ["United States of America"]) for boards
      // with no country facet. Applies wherever a country is known (Workday detail); unknown countries pass.
      const countries = site.provider_config?.countries;
      if (Array.isArray(countries) && countries.length > 0) {
        const allow = new Set(countries.map((c) => String(c).toLowerCase()));
        const before = unseen.length;
        unseen = unseen.filter((p) => !p.country || allow.has(p.country.toLowerCase()));
        base.wrongCountry = before - unseen.length;
      }

      // Pay from the description text when the provider gave none (pay-transparency boilerplate).
      for (const p of unseen) {
        if (p.salaryMin != null || p.salaryMax != null) continue;
        const pay = parseSalaryRange(p.description);
        if (pay) {
          p.salaryMin = pay.min;
          p.salaryMax = pay.max;
          base.payParsed = (base.payParsed ?? 0) + 1;
        }
      }

      const fresh: NewOpportunity[] = [];
      for (const p of unseen) {
        seenUrls.add(p.url); // dedupe within this run too
        // Description deal-breakers are still saved (archived) so later runs dedupe instead of refetching.
        const dealBreaker = opts.noFilter ? null : descriptionExcludedBy(p.description);
        if (dealBreaker) base.descExcluded = (base.descExcluded ?? 0) + 1;
        fresh.push({
          ...(dealBreaker
            ? { status: "ai_skipped", archived: true, notes: `[${dateAdded}] Auto-skipped at discovery: description mentions "${dealBreaker}".` }
            : { status: DISCOVERED_STATUS }),
          id: randomUUID(),
          job_title: p.title,
          company: p.company,
          location: p.location,
          remote: p.remote,
          application_url: p.url,
          date_added: dateAdded,
          listing_date: p.listingDate,
          salary_min: p.salaryMin,
          salary_max: p.salaryMax,
          description: p.description,
        });
      }

      if (!opts.dryRun) {
        await createOpportunities(fresh);
        await touchJobSite(site.id, now.toISOString());
      }
      base.created = fresh.length - (base.descExcluded ?? 0);
    } catch (err) {
      base.error = err instanceof Error ? err.message : String(err);
    }
    results.push(base);
    progress({ kind: "result", index, total, result: base });
  }

  return results;
}
