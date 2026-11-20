/**
 * Per-provider ATS adapters. Each turns one watchlist site into normalized JobPostings.
 *
 * Greenhouse / Lever / Ashby expose official no-auth JSON. Workday uses the stable but
 * reverse-engineered CXS endpoint. Eightfold (PCSX or legacy "apply v2") serves JSON behind its
 * career sites. Amazon has its own public search JSON (amazon.jobs/en/search.json). SmartRecruiters, Workable,
 * Rippling ATS, Atlassian, iCIMS career sites, and Oracle Cloud HCM live in ats-more.ts. Anything else (LinkedIn,
 * bespoke career pages like Meta/Uber) has no adapter — add those jobs one at a time with /interested.
 */

import { keywordsFor, titleMatches } from "../../config/discovery.ts";
import type { JobSite } from "../types.ts";
import type { Adapter, JobPosting } from "./types.ts";
import { MORE_ADAPTERS, MORE_DETAIL_FETCHERS } from "./ats-more.ts";

/** Infer remote/hybrid/on-site from a free-text location when no explicit flag exists. */
export function inferRemote(text: string | null | undefined): JobPosting["remote"] {
  const t = (text ?? "").toLowerCase();
  if (t.includes("remote")) return "fully_remote";
  if (t.includes("hybrid")) return "hybrid";
  return null;
}

export async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

const DESCRIPTION_CAP = 12_000;

/** Convert (possibly entity-encoded) HTML to readable plain text, capped for storage. */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  let s = html
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;|&rsquo;|&apos;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&amp;(#x?[0-9a-f]+;)/gi, "&$1") // double-encoded numeric refs (Workday: &amp;#xa;)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, "&");
  s = s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s ? s.slice(0, DESCRIPTION_CAP) : null;
}

function plain(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.trim();
  return t ? t.slice(0, DESCRIPTION_CAP) : null;
}

// Salary that isn't in a clean structured field is parsed from the description by discover()
// (src/discovery/salary.ts) after adapters and detail fetches run.

/** Pull an annual Salary min/max out of an Ashby `compensation` object, if present. */
function ashbySalary(comp: Record<string, any> | null | undefined): { min: number | null; max: number | null } {
  const fromComponents = (arr: any[] | undefined) => {
    const s = (arr ?? []).find(
      (c) =>
        c?.compensationType === "Salary" &&
        /year/i.test(String(c?.interval ?? "")) &&
        (c?.minValue != null || c?.maxValue != null),
    );
    return s ? { min: s.minValue ?? null, max: s.maxValue ?? null } : null;
  };
  if (!comp) return { min: null, max: null };
  const top = fromComponents(comp.summaryComponents);
  if (top) return top;
  for (const t of comp.compensationTiers ?? []) {
    const r = fromComponents(t?.components);
    if (r) return r;
  }
  return { min: null, max: null };
}

/** Read a provider identifier from provider_config, falling back to parsing the site URL. */
function configValue(site: JobSite, key: string): string | undefined {
  const cfg = site.provider_config;
  if (cfg && typeof cfg === "object" && typeof (cfg as Record<string, unknown>)[key] === "string") {
    return (cfg as Record<string, string>)[key];
  }
  return undefined;
}

// ── Greenhouse ────────────────────────────────────────────────────────────
function greenhouseToken(site: JobSite): string {
  const fromCfg = configValue(site, "board_token");
  if (fromCfg) return fromCfg;
  const m = site.url?.match(/greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9_-]+)/i);
  if (m?.[1]) return m[1];
  throw new Error(`${site.name}: no Greenhouse board_token (set provider_config.board_token)`);
}

/**
 * Salary from Greenhouse pay transparency (`?pay_transparency=true`): USD ranges only, widest span across
 * them (boards list one range per location tier). Skips hourly and sales OTE ranges.
 */
function greenhouseSalary(ranges: unknown): { min: number | null; max: number | null } {
  const usd = (Array.isArray(ranges) ? ranges : []).filter(
    (r: any) => r?.currency_type === "USD" && !/hour|\bOTE\b|on[- ]target/i.test(String(r?.title ?? "")),
  ) as Array<{ min_cents?: number; max_cents?: number }>;
  const mins = usd.map((r) => r.min_cents).filter((n): n is number => typeof n === "number" && n > 0);
  const maxs = usd.map((r) => r.max_cents).filter((n): n is number => typeof n === "number" && n > 0);
  return {
    min: mins.length ? Math.round(Math.min(...mins) / 100) : null,
    max: maxs.length ? Math.round(Math.max(...maxs) / 100) : null,
  };
}

/** Normalize one Greenhouse job (board list item or single-job response). */
export function greenhouseJob(j: Record<string, any>, fallbackCompany: string): JobPosting {
  const location = j.location?.name ?? "";
  const pay = greenhouseSalary(j.pay_input_ranges);
  return {
    externalId: String(j.id),
    title: String(j.title ?? "").trim(),
    company: j.company_name || fallbackCompany,
    location,
    url: j.absolute_url,
    remote: inferRemote(location),
    listingDate: (j.first_published ?? j.updated_at ?? "").slice(0, 10) || null,
    salaryMin: pay.min, // pay transparency ranges when the board publishes them; else the AI extracts at triage
    salaryMax: pay.max,
    description: htmlToText(j.content),
  };
}

const greenhouse: Adapter = async (site) => {
  const token = greenhouseToken(site);
  const data = (await getJson(
    `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true&pay_transparency=true`,
  )) as { jobs?: Array<Record<string, any>> };
  return (data.jobs ?? []).map((j) => greenhouseJob(j, site.name));
};

// ── Lever ─────────────────────────────────────────────────────────────────
function leverSite(site: JobSite): string {
  const fromCfg = configValue(site, "site");
  if (fromCfg) return fromCfg;
  const m = site.url?.match(/lever\.co\/([A-Za-z0-9_-]+)/i);
  if (m?.[1]) return m[1];
  throw new Error(`${site.name}: no Lever site (set provider_config.site)`);
}

/** Normalize one Lever posting (board list item or single-posting response). */
export function leverJob(j: Record<string, any>, company: string): JobPosting {
  const location = j.categories?.location ?? "";
  const wt = String(j.workplaceType ?? "").toLowerCase();
  const remote =
    wt === "remote" ? "fully_remote" : wt === "hybrid" ? "hybrid" : wt === "on-site" || wt === "onsite" ? "on_site" : inferRemote(location);
  return {
    externalId: String(j.id ?? ""),
    title: String(j.text ?? "").trim(),
    company,
    location,
    url: j.hostedUrl,
    remote,
    listingDate: typeof j.createdAt === "number" ? new Date(j.createdAt).toISOString().slice(0, 10) : null,
    salaryMin: j.salaryRange?.min ?? null,
    salaryMax: j.salaryRange?.max ?? null,
    description: leverDescription(j),
  };
}

/**
 * Lever splits a posting into an intro (`description`), titled `lists` (responsibilities,
 * requirements; HTML `<li>` content), and a closing `additional` block (often pay and benefits).
 * Join all three so the description is the full JD, not just the intro.
 */
function leverDescription(j: Record<string, any>): string {
  const parts: string[] = [];
  const intro = plain(j.descriptionPlain) ?? htmlToText(j.description);
  if (intro) parts.push(intro);
  for (const l of (j.lists ?? []) as Array<{ text?: string; content?: string }>) {
    const body = (htmlToText(l.content ?? "") ?? "").replace(/•\s*\n\s*/g, "• ");
    if (l.text || body) parts.push([l.text?.trim(), body].filter(Boolean).join("\n"));
  }
  const closing = plain(j.additionalPlain) ?? htmlToText(j.additional ?? "");
  if (closing) parts.push(closing);
  return parts.join("\n\n");
}

const lever: Adapter = async (site) => {
  const data = await getJson(`https://api.lever.co/v0/postings/${leverSite(site)}?mode=json`);
  if (!Array.isArray(data)) return []; // error payloads come back as an object
  return (data as Array<Record<string, any>>).map((j) => leverJob(j, site.name));
};

// ── Ashby ─────────────────────────────────────────────────────────────────
function ashbyOrg(site: JobSite): string {
  const fromCfg = configValue(site, "org") ?? configValue(site, "board");
  if (fromCfg) return fromCfg;
  const m = site.url?.match(/ashbyhq\.com\/([A-Za-z0-9_-]+)/i);
  if (m?.[1]) return m[1];
  throw new Error(`${site.name}: no Ashby org (set provider_config.org)`);
}

/** Normalize one Ashby job-board entry. */
export function ashbyJob(j: Record<string, any>, company: string): JobPosting {
  const sal = ashbySalary(j.compensation);
  const wt = String(j.workplaceType ?? "").toLowerCase();
  const remote =
    j.isRemote === true || wt === "remote"
      ? "fully_remote"
      : wt === "hybrid"
        ? "hybrid"
        : wt === "onsite" || wt === "inperson"
          ? "on_site"
          : inferRemote(j.location);
  return {
    externalId: String(j.id ?? ""),
    title: String(j.title ?? "").trim(),
    company,
    location: j.location ?? "",
    url: j.jobUrl ?? j.applyUrl,
    remote,
    listingDate: j.publishedAt ? String(j.publishedAt).slice(0, 10) : null,
    salaryMin: sal.min,
    salaryMax: sal.max,
    description: plain(j.descriptionPlain) ?? htmlToText(j.descriptionHtml),
  };
}

/** Fetch an Ashby org's listed jobs (raw). There's no public single-job endpoint. */
export async function fetchAshbyBoard(org: string): Promise<Array<Record<string, any>>> {
  const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${org}?includeCompensation=true`);
  if (res.status === 404) return fetchAshbyBoardGraphql(org); // org has the public posting API turned off
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for Ashby board ${org}`);
  const data = (await res.json()) as { jobs?: Array<Record<string, any>> };
  return (data.jobs ?? []).filter((j) => j.isListed !== false);
}

// Fallback for orgs whose public posting API is off (EvenUp): the GraphQL API behind jobs.ashbyhq.com pages.
// The list has no text, so each posting is fetched once for its description and date; results are shaped
// like the posting API's jobs so ashbyJob() normalizes both.
const ASHBY_GQL = "https://jobs.ashbyhq.com/api/non-user-graphql";
async function ashbyGql(op: string, query: string, variables: Record<string, string>): Promise<any> {
  const d = (await getJson(`${ASHBY_GQL}?op=${op}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationName: op, variables, query }),
  })) as { data?: any; errors?: unknown };
  if (!d.data) throw new Error(`Ashby GraphQL ${op} failed for ${variables.organizationHostedJobsPageName}`);
  return d.data;
}

async function fetchAshbyBoardGraphql(org: string): Promise<Array<Record<string, any>>> {
  const board = await ashbyGql(
    "ApiJobBoardWithTeams",
    `query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) { jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) { jobPostings { id title locationName workplaceType } } }`,
    { organizationHostedJobsPageName: org },
  );
  const out: Array<Record<string, any>> = [];
  for (const p of board.jobBoard?.jobPostings ?? []) {
    const { jobPosting: j } = await ashbyGql(
      "ApiJobPosting",
      `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { id title descriptionHtml publishedDate locationName workplaceType } }`,
      { organizationHostedJobsPageName: org, jobPostingId: p.id },
    );
    out.push({
      id: p.id,
      title: p.title,
      location: p.locationName,
      workplaceType: p.workplaceType,
      jobUrl: `https://jobs.ashbyhq.com/${org}/${p.id}`,
      publishedAt: j?.publishedDate ?? null,
      descriptionHtml: j?.descriptionHtml ?? null,
    });
    await new Promise((r) => setTimeout(r, 150));
  }
  return out;
}

const ashby: Adapter = async (site) =>
  (await fetchAshbyBoard(ashbyOrg(site))).map((j) => ashbyJob(j, site.name));

// ── Workday (reverse-engineered CXS endpoint; Akamai-protected, poll politely) ──
const workday: Adapter = async (site) => {
  const tenant = configValue(site, "tenant");
  const wsite = configValue(site, "site");
  const dc = configValue(site, "dc"); // e.g. "wd1", "wd5"
  if (!tenant || !wsite || !dc) {
    throw new Error(`${site.name}: Workday needs provider_config {tenant, site, dc}`);
  }
  // Per-site server-side narrowing (esp. for huge multinational boards): optional
  // provider_config.searchText (string or string[]) and appliedFacets (Workday facet object,
  // e.g. {"locationCountry":["<id>"]}). maxResults caps the fetch (default 400).
  const cfg = (site.provider_config ?? {}) as Record<string, unknown>;
  const facets = cfg.appliedFacets && typeof cfg.appliedFacets === "object" ? cfg.appliedFacets : {};
  const rawSearch = cfg.searchText;
  const terms = Array.isArray(rawSearch)
    ? rawSearch.filter((t): t is string => typeof t === "string")
    : typeof rawSearch === "string" && rawSearch
      ? [rawSearch]
      : [""]; // no searchText → whole board
  const MAX = typeof cfg.maxResults === "number" ? cfg.maxResults : 400;

  const base = `https://${tenant}.${dc}.myworkdayjobs.com`;
  const endpoint = `${base}/wday/cxs/${tenant}/${wsite}/jobs`;
  const PAGE = 20; // Workday's max page size

  const seen = new Set<string>();
  const postings: JobPosting[] = [];
  let capped = false;

  for (const term of terms) {
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      if (postings.length >= MAX) { capped = true; break; }
      const data = (await getJson(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ appliedFacets: facets, limit: PAGE, offset, searchText: term }),
      })) as { total?: number; jobPostings?: Array<Record<string, any>> };
      if (offset === 0) total = data.total ?? 0; // Workday reports total only on the first page
      const page = data.jobPostings ?? [];
      if (page.length === 0) break;
      for (const j of page) {
        const url = `${base}/${wsite}${j.externalPath ?? ""}`;
        if (seen.has(url)) continue; // dedup across search terms
        seen.add(url);
        postings.push({
          externalId: String(j.bulletFields?.[0] ?? j.externalPath ?? ""),
          title: String(j.title ?? "").trim(),
          company: site.name,
          location: j.locationsText ?? "",
          url,
          remote: inferRemote(j.locationsText),
          listingDate: null, // postedOn is relative ("Posted 3 days ago"); skip
          salaryMin: null,
          salaryMax: null,
          description: null, // listing has no description; discover() calls fetchDetails for survivors
        });
      }
      offset += PAGE;
      await new Promise((r) => setTimeout(r, 300)); // polite; ease Akamai throttling
    }
    if (capped) break;
  }
  if (capped) {
    console.error(`  ! ${site.name}: hit the ${MAX}-result cap; narrow via provider_config.searchText / appliedFacets / maxResults.`);
  }
  return postings;
};

// ── Eightfold (career sites like careers.<company>.com/careers/job/<id>) ─────────
// Two API generations: PCSX (newer; search needs ?domain=) and legacy "apply v2". A site answers
// one or the other. Listings carry no description, so details are fetched per job.

const eightfoldHeaders = { Accept: "application/json", "User-Agent": "Mozilla/5.0" };

/** GET with backoff on 429/403: Eightfold rate-limits bursts, and some front doors (Microsoft's WAF)
 *  answer a burst with an intermittent 403 block page rather than a 429. */
async function eightfoldGet(url: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: eightfoldHeaders });
    if ((res.status === 429 || res.status === 403) && attempt < 6) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || Math.min(3000 * 2 ** attempt, 60_000);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return res.json();
  }
}

function eightfoldRemote(option: unknown, location: string): JobPosting["remote"] {
  // The location text wins when it's explicit: Netflix tags "California - Remote" roles as "onsite".
  const fromText = inferRemote(location);
  if (fromText) return fromText;
  const o = String(option ?? "").toLowerCase();
  if (o === "remote") return "fully_remote";
  if (o === "hybrid") return "hybrid";
  if (o === "onsite" || o === "on-site") return "on_site";
  return inferRemote(location);
}

const tsDate = (ts: unknown) => (typeof ts === "number" && ts > 0 ? new Date(ts * 1000).toISOString().slice(0, 10) : null);

/** Fetch + normalize one Eightfold job by id (tries PCSX, then legacy v2). */
export async function eightfoldJob(host: string, id: string, company: string): Promise<JobPosting> {
  const url = `https://${host}/careers/job/${id}`;
  try {
    const r = (await eightfoldGet(`https://${host}/api/pcsx/position_details?position_id=${id}`)) as {
      data?: Record<string, any>;
    };
    const d = r.data;
    if (d?.name) {
      // Raw locations keep qualifiers like "California - Remote"; standardized ones drop them.
      const locations: string[] = d.locations ?? d.standardizedLocations ?? [];
      const location = locations.join("; ") || String(d.location ?? "");
      return {
        externalId: String(d.id ?? id),
        title: String(d.name).trim(),
        company,
        location,
        url: d.publicUrl ?? url,
        remote: eightfoldRemote(d.workLocationOption, location),
        listingDate: tsDate(d.postedTs) ?? tsDate(d.creationTs),
        salaryMin: null, // prose only; the AI extracts it from the description
        salaryMax: null,
        description: htmlToText(d.jobDescription),
      };
    }
  } catch {
    // Not a PCSX site; fall through to legacy v2.
  }
  const d = (await eightfoldGet(`https://${host}/api/apply/v2/jobs/${id}`)) as Record<string, any>;
  const locations: string[] = d.locations ?? [];
  const location = locations.join("; ") || String(d.location ?? "");
  return {
    externalId: String(d.id ?? id),
    title: String(d.name ?? "").trim(),
    company,
    location,
    url: d.canonicalPositionUrl ?? url,
    remote: eightfoldRemote(d.work_location_option, location),
    listingDate: tsDate(d.t_create),
    salaryMin: null,
    salaryMax: null,
    description: htmlToText(d.job_description),
  };
}

/** Eightfold site host: provider_config.host, else the watchlist url's host. */
function eightfoldHost(site: JobSite): string {
  const h = configValue(site, "host") ?? (site.url ? new URL(site.url).hostname : undefined);
  if (!h) throw new Error(`${site.name}: Eightfold needs provider_config.host (e.g. "explore.jobs.netflix.net")`);
  return h;
}

/** Which search API each host speaks, learned this run (a host answers PCSX or legacy v2, not both). */
const searchApi = new Map<string, "pcsx" | "v2">();

async function eightfoldSearchPage(
  host: string,
  domain: string,
  term: string,
  start: number,
  location?: string,
): Promise<{ ids: Array<{ id: string; title: string }>; total: number }> {
  const q = encodeURIComponent(term) + (location ? `&location=${encodeURIComponent(location)}` : "");
  const pcsx = async () => {
    const r = (await eightfoldGet(`https://${host}/api/pcsx/search?domain=${domain}&query=${q}&start=${start}`)) as {
      data?: { positions?: Array<Record<string, any>>; count?: number };
    };
    if (!r.data?.positions) throw new Error(`PCSX search returned no positions for ${host}`);
    return { ids: r.data.positions.map((p) => ({ id: String(p.id), title: String(p.name ?? "") })), total: r.data.count ?? 0 };
  };
  const v2 = async () => {
    const r = (await eightfoldGet(`https://${host}/api/apply/v2/jobs?domain=${domain}&query=${q}&start=${start}&num=10`)) as {
      positions?: Array<Record<string, any>>;
      count?: number;
    };
    return { ids: (r.positions ?? []).map((p) => ({ id: String(p.id), title: String(p.name ?? "") })), total: r.count ?? 0 };
  };

  const known = searchApi.get(host);
  if (known === "pcsx") return pcsx(); // a transient failure surfaces instead of silently switching APIs
  if (known === "v2") return v2();
  try {
    const r = await pcsx();
    searchApi.set(host, "pcsx");
    return r;
  } catch (pcsxErr) {
    try {
      const r = await v2();
      searchApi.set(host, "v2");
      return r;
    } catch {
      throw pcsxErr;
    }
  }
}

const eightfold: Adapter = async (site) => {
  const host = eightfoldHost(site);
  // PCSX search requires the company domain; default to the host's last two labels.
  const domain = configValue(site, "domain") ?? host.split(".").slice(-2).join(".");
  const cfg = (site.provider_config ?? {}) as Record<string, unknown>;
  const rawSearch = cfg.searchText;
  const terms = Array.isArray(rawSearch)
    ? rawSearch.filter((t): t is string => typeof t === "string")
    : typeof rawSearch === "string" && rawSearch
      ? [rawSearch]
      : [""];
  const MAX = typeof cfg.maxResults === "number" ? cfg.maxResults : 400;
  const delayMs = typeof cfg.delayMs === "number" ? cfg.delayMs : 500; // raise for WAF-guarded hosts (Microsoft)
  const keywords = keywordsFor(site);

  // Collect ids, then fetch details only for titles that pass the keyword filter
  // (listings have no description, and a detail call per irrelevant job is wasted traffic).
  const hits = new Map<string, string>();
  let seen = 0;
  outer: for (const term of terms) {
    for (let start = 0; ; start += 10) {
      let page: Awaited<ReturnType<typeof eightfoldSearchPage>>;
      try {
        page = await eightfoldSearchPage(host, domain, term, start, configValue(site, "location"));
      } catch (err) {
        // Throttled even after retries: keep what earlier terms/pages found and move on.
        if (hits.size === 0 && term === terms[terms.length - 1]) throw err;
        console.error(`  ! ${site.name}: search "${term}" stopped at ${start} (${err instanceof Error ? err.message : err}); continuing.`);
        break;
      }
      const { ids, total } = page;
      for (const { id, title } of ids) {
        if (++seen > MAX) break outer;
        if (titleMatches(title, keywords)) hits.set(id, title);
      }
      if (ids.length === 0 || start + 10 >= total) break;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  if (seen > MAX) console.error(`  ! ${site.name}: hit the ${MAX}-result cap; narrow via provider_config.searchText / maxResults.`);

  const postings: JobPosting[] = [];
  for (const id of hits.keys()) {
    postings.push(await eightfoldJob(host, id, site.name));
    await new Promise((r) => setTimeout(r, Math.max(200, delayMs / 2)));
  }
  return postings;
};

/** Split a Workday job URL (as stored) into its detail-API parts. */
function workdayUrlParts(url: string): { base: string; tenant: string; site: string; jobPath: string } | null {
  const m = url.match(/^(https:\/\/([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com)\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)\/job\/(.+)$/);
  return m ? { base: m[1]!, tenant: m[2]!, site: m[3]!, jobPath: m[4]! } : null;
}

/** Fetch + normalize one Workday job from its detail endpoint (description, posting date, remote type). */
export async function workdayJob(url: string, company: string | null): Promise<JobPosting> {
  const p = workdayUrlParts(url);
  if (!p) throw new Error(`Not a Workday job URL: ${url}`);
  const data = (await getJson(`${p.base}/wday/cxs/${p.tenant}/${p.site}/job/${p.jobPath}`, {
    headers: { Accept: "application/json" },
  })) as { jobPostingInfo?: Record<string, any>; hiringOrganization?: { name?: string } };
  const info = data.jobPostingInfo ?? {};
  const location = String(info.location ?? "");
  return {
    externalId: String(info.jobReqId ?? p.jobPath),
    title: String(info.title ?? "").trim(),
    company: company ?? data.hiringOrganization?.name ?? p.tenant,
    location,
    url: `${p.base}/${p.site}/job/${p.jobPath}`, // same canonical form discovery stores
    remote: inferRemote(`${location} ${info.remoteType ?? ""}`),
    listingDate: typeof info.startDate === "string" ? info.startDate.slice(0, 10) : null,
    salaryMin: null,
    salaryMax: null,
    description: htmlToText(info.jobDescription),
    country: typeof info.country?.descriptor === "string" ? info.country.descriptor : null,
  };
}

/**
 * Per-provider detail fetch, run by discover() only for postings that survived the title filter,
 * age filter, and dedupe (so a big board costs one detail call per real candidate). Keeps the
 * listing's title/company/url; takes description, posting date, and remote type from the detail.
 */
export type DetailFetcher = (posting: JobPosting, site?: JobSite) => Promise<JobPosting>;

// ── Apple (jobs.apple.com JSON API; needs a CSRF token + session cookie) ─────
// provider_config: { locations?: string[] (default ["postLocation-USA"]), teams?: string[] (e.g.
// "teamsAndSubTeams-SFTWR"), searchText?: string, maxResults?: number }. The listing has no description;
// discover() calls the "apple" detail fetcher for survivors.

let appleSession: Promise<Record<string, string>> | null = null;

export function appleHeaders(): Promise<Record<string, string>> {
  appleSession ??= (async () => {
    const res = await fetch("https://jobs.apple.com/api/v1/CSRFToken", { headers: { "User-Agent": "Mozilla/5.0" } });
    const token = res.headers.get("x-apple-csrf-token");
    if (!token) throw new Error("Apple: no CSRF token in /api/v1/CSRFToken response");
    return {
      "User-Agent": "Mozilla/5.0",
      "Content-Type": "application/json",
      "x-apple-csrf-token": token,
      Cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "),
    };
  })();
  return appleSession;
}

const appleUrl = (positionId: string, slug: string) => `https://jobs.apple.com/en-us/details/${positionId}/${slug}`;

const apple: Adapter = async (site) => {
  const cfg = (site.provider_config ?? {}) as Record<string, unknown>;
  const strs = (k: string) => (Array.isArray(cfg[k]) ? (cfg[k] as unknown[]).filter((x): x is string => typeof x === "string") : []);
  const locations = strs("locations").length ? strs("locations") : ["postLocation-USA"];
  const teams = strs("teams");
  const query = typeof cfg.searchText === "string" ? cfg.searchText : "";
  const MAX = typeof cfg.maxResults === "number" ? cfg.maxResults : 3000;
  const headers = await appleHeaders();
  const format = { longDate: "MMMM D, YYYY", mediumDate: "MMM D, YYYY" };

  const byPosition = new Map<string, JobPosting>();
  let fetched = 0;
  for (let page = 1; fetched < MAX; page++) {
    const filters: Record<string, unknown> = { locations };
    if (teams.length) filters.teams = teams.map((team) => ({ team }));
    const d = (await getJson("https://jobs.apple.com/api/v1/search", {
      method: "POST",
      headers,
      body: JSON.stringify({ query, filters, page, locale: "en-us", sort: "newest", format }),
    })) as { res?: { searchResults?: Array<Record<string, any>>; totalRecords?: number } };
    const rows = d.res?.searchResults ?? [];
    fetched += rows.length;
    for (const j of rows) {
      const id = String(j.positionId ?? "");
      if (!id || byPosition.has(id)) continue; // one result per location; keep the first
      const locs: Array<Record<string, any>> = j.locations ?? [];
      const location = locs.map((l) => l.name || [l.city, l.stateProvince].filter(Boolean).join(", ") || l.countryName).filter(Boolean).join("; ");
      byPosition.set(id, {
        externalId: id,
        title: String(j.postingTitle ?? "").trim(),
        company: "Apple",
        location,
        url: appleUrl(id, String(j.transformedPostingTitle ?? "")),
        remote: j.homeOffice === true ? "fully_remote" : inferRemote(location),
        listingDate: typeof j.postDateInGMT === "string" ? j.postDateInGMT.slice(0, 10) : null,
        salaryMin: null,
        salaryMax: null,
        description: null,
      });
    }
    if (rows.length === 0 || fetched >= (d.res?.totalRecords ?? 0)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return [...byPosition.values()];
};

/** Full Apple posting text: summary, description, responsibilities, qualifications, pay footer. */
async function appleDetail(p: JobPosting): Promise<JobPosting> {
  const id = p.url.match(/\/details\/(\d+)/)?.[1];
  if (!id) return p;
  const d = (await getJson(`https://jobs.apple.com/api/v1/jobDetails/${id}`, { headers: await appleHeaders() })) as {
    res?: Record<string, any>;
  };
  const r = d.res ?? {};
  const footers: string[] = (r.postingFooters ?? []).flatMap((f: any) =>
    Object.values(f.localizations ?? {}).flat().map((x: any) => `${x.name ?? ""}\n${htmlToText(x.content) ?? ""}`),
  );
  const text = [
    r.jobSummary,
    r.description && `Description:\n${r.description}`,
    r.responsibilities && `Responsibilities:\n${r.responsibilities}`,
    r.minimumQualifications && `Minimum qualifications:\n${r.minimumQualifications}`,
    r.preferredQualifications && `Preferred qualifications:\n${r.preferredQualifications}`,
    footers[0], // Pay & Benefits (identical per location; keep one)
  ].filter(Boolean).join("\n\n");
  return {
    ...p,
    description: (htmlToText(text) ?? text).slice(0, DESCRIPTION_CAP) || p.description,
    listingDate: typeof r.postingDateMeta === "string" ? r.postingDateMeta : p.listingDate,
    remote: r.homeOffice === true ? "fully_remote" : p.remote,
  };
}

const DETAIL_FETCHERS: Record<string, DetailFetcher> = {
  apple: appleDetail,
  // Backfill only (discovery already gets pay ranges from the list call): refetch one job's pay ranges.
  greenhouse: async (p, site) => {
    const id = p.url.match(/[?&]gh_jid=(\d+)/)?.[1] ?? p.url.match(/\/jobs\/(\d+)/)?.[1];
    const token = (site && configValue(site, "board_token")) ?? p.url.match(/greenhouse\.io\/([\w-]+)\/jobs\//)?.[1];
    if (!id || !token) return p;
    const j = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${id}?pay_transparency=true`)) as Record<string, any>;
    const pay = greenhouseSalary(j.pay_input_ranges);
    return { ...p, salaryMin: p.salaryMin ?? pay.min, salaryMax: p.salaryMax ?? pay.max, description: p.description ?? htmlToText(j.content) };
  },
  workday: async (p) => {
    const d = await workdayJob(p.url, p.company);
    return {
      ...p,
      description: d.description ?? p.description,
      listingDate: d.listingDate ?? p.listingDate,
      remote: d.remote ?? p.remote,
      location: p.location && !/^\d+ Locations?$/i.test(p.location) ? p.location : d.location || p.location,
      country: d.country ?? p.country ?? null,
    };
  },
};

// ── schema.org JobPosting (JSON-LD) on the posting's own page ───────────────────────
// Many company career pages embed a JobPosting for Google Jobs (Stripe: salary + locations that the
// Greenhouse API omits). Opt in per site with provider_config.detail = "jsonld".

const COUNTRY_NAMES: Record<string, string> = { US: "United States of America", USA: "United States of America" };

function findJobPosting(node: unknown): Record<string, any> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findJobPosting(n);
      if (hit) return hit;
    }
    return null;
  }
  const o = node as Record<string, any>;
  const type = o["@type"];
  if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) return o;
  return findJobPosting(o["@graph"]);
}

/** Pull salary / locations / remote / date / country from a page's JSON-LD JobPosting. Fills gaps only. */
async function jsonLdDetail(p: JobPosting): Promise<JobPosting> {
  const res = await fetch(p.url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" }, redirect: "follow" });
  if (!res.ok) return p;
  const html = await res.text();
  let jp: Record<string, any> | null = null;
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      jp = findJobPosting(JSON.parse(m[1]!));
    } catch {
      continue;
    }
    if (jp) break;
  }
  if (!jp) return p;

  // Salary: annual USD only (hourly/other currencies aren't comparable to the salary fields).
  let salaryMin = p.salaryMin;
  let salaryMax = p.salaryMax;
  const sal = jp.baseSalary;
  const val = sal?.value;
  const unit = String(val?.unitText ?? sal?.unitText ?? "YEAR").toUpperCase();
  if ((sal?.currency ?? "USD") === "USD" && unit === "YEAR") {
    const min = Number(val?.minValue ?? (typeof val?.value === "number" ? val.value : NaN));
    const max = Number(val?.maxValue ?? (typeof val?.value === "number" ? val.value : NaN));
    if (salaryMin == null && Number.isFinite(min) && min > 0) salaryMin = Math.round(min);
    if (salaryMax == null && Number.isFinite(max) && max > 0) salaryMax = Math.round(max);
  }

  const places: any[] = Array.isArray(jp.jobLocation) ? jp.jobLocation : jp.jobLocation ? [jp.jobLocation] : [];
  const addrs = places.map((pl) => pl?.address ?? {}).filter((a) => a && typeof a === "object");
  const locText = addrs
    .map((a) => [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(", "))
    .filter(Boolean)
    .join("; ");
  const countries = [...new Set(addrs.map((a) => String(a.addressCountry ?? "").toUpperCase()).filter(Boolean))];
  const telecommute = /TELECOMMUTE/i.test(String(jp.jobLocationType ?? ""));

  return {
    ...p,
    salaryMin,
    salaryMax,
    location: locText || p.location,
    remote: telecommute ? "fully_remote" : p.remote ?? (locText ? inferRemote(locText) : null),
    listingDate: p.listingDate ?? (typeof jp.datePosted === "string" ? jp.datePosted.slice(0, 10) : null),
    country: p.country ?? (countries.length === 1 ? COUNTRY_NAMES[countries[0]!] ?? countries[0]! : null),
    description: p.description ?? (typeof jp.description === "string" ? htmlToText(jp.description) : null),
  };
}

/** The detail fetcher for a site: provider_config.detail ("jsonld") if set, else the provider's own. */
export function getDetailFetcher(name: string, site?: { provider_config: Record<string, unknown> | null }): DetailFetcher | undefined {
  if (site?.provider_config?.detail === "jsonld") return jsonLdDetail;
  return DETAIL_FETCHERS[name] ?? MORE_DETAIL_FETCHERS[name];
}

// ── Amazon (amazon.jobs public search JSON) ────────────────────────────────
// provider_config: { categories?: string[] (e.g. "software-development"), countries?: string[] (ISO3, "USA"),
//                    searchText?: string | string[], maxResults?: number }. Descriptions come in the listing.

/** Normalize one amazon.jobs search result. */
export function amazonJob(j: Record<string, any>): JobPosting {
  const posted = typeof j.posted_date === "string" ? new Date(`${j.posted_date.replace(/\s+/g, " ")} UTC`) : null;
  const sections = [
    htmlToText(j.description),
    j.basic_qualifications ? `Basic qualifications:\n${htmlToText(j.basic_qualifications)}` : null,
    j.preferred_qualifications ? `Preferred qualifications:\n${htmlToText(j.preferred_qualifications)}` : null,
  ].filter(Boolean);
  const location = String(j.normalized_location ?? j.location ?? "");
  return {
    externalId: String(j.id_icims ?? j.id ?? ""),
    title: String(j.title ?? "").trim(),
    company: j.company_name && !/^amazon/i.test(j.company_name) ? `Amazon (${j.company_name})` : "Amazon",
    location,
    url: `https://www.amazon.jobs${j.job_path}`,
    remote: inferRemote(`${location} ${j.title ?? ""}`),
    listingDate: posted && !Number.isNaN(posted.getTime()) ? posted.toISOString().slice(0, 10) : null,
    salaryMin: null, // pay ranges are in the description prose; the AI extracts them at triage
    salaryMax: null,
    description: sections.join("\n\n").slice(0, DESCRIPTION_CAP) || null,
  };
}

const amazon: Adapter = async (site) => {
  const cfg = (site.provider_config ?? {}) as Record<string, unknown>;
  const list = (k: string) => (Array.isArray(cfg[k]) ? (cfg[k] as unknown[]).filter((x): x is string => typeof x === "string") : []);
  const raw = cfg.searchText;
  const terms = Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : typeof raw === "string" && raw ? [raw] : [""];
  const MAX = typeof cfg.maxResults === "number" ? cfg.maxResults : 3000;
  const PAGE = 100;

  const seen = new Set<string>();
  const postings: JobPosting[] = [];
  for (const term of terms) {
    for (let offset = 0; offset < MAX; offset += PAGE) {
      const qs = new URLSearchParams({ result_limit: String(PAGE), offset: String(offset), sort: "recent" });
      if (term) qs.set("base_query", term);
      for (const c of list("categories")) qs.append("category[]", c);
      for (const c of list("countries")) qs.append("normalized_country_code[]", c);
      const d = (await getJson(`https://www.amazon.jobs/en/search.json?${qs}`, {
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      })) as { hits?: number; jobs?: Array<Record<string, any>> };
      const page = d.jobs ?? [];
      for (const j of page) {
        const p = amazonJob(j);
        if (!seen.has(p.url)) (seen.add(p.url), postings.push(p));
      }
      if (page.length < PAGE || offset + PAGE >= (d.hits ?? 0)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return postings;
};

// ── Google (google.com/about/careers; server-rendered, job data embedded as AF_initDataCallback 'ds:1') ──
// provider_config: { location?: string (default "United States"), searchText?: string | string[],
// maxResults?: number }. Each page is ~1MB of HTML with 20 jobs; search terms narrow for real here, so use
// them rather than paging the whole board. The embedded rows are positional arrays (Google's internal
// shape), so parsing is defensive: a layout change yields an error, not bad rows.

const GOOGLE_BASE = "https://www.google.com/about/careers/applications/jobs/results";
const GOOGLE_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

function googlePage(html: string): { rows: any[][]; total: number } {
  const m = html.match(/AF_initDataCallback\(\{key: 'ds:1', hash: '[^']*', data:([\s\S]*?), sideChannel: \{\}\}\);<\/script>/);
  if (!m) throw new Error("Google careers: ds:1 job data not found (page layout changed?)");
  const data = JSON.parse(m[1]!) as unknown[];
  return { rows: Array.isArray(data[0]) ? (data[0] as any[][]) : [], total: typeof data[2] === "number" ? data[2] : 0 };
}

const slugify = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const htmlAt = (row: any[], i: number) => (Array.isArray(row[i]) ? htmlToText(row[i][1]) : null);

/** Normalize one embedded Google job row. Indices verified 2026-09: 0 id, 1 title, 3 responsibilities,
 *  4 qualifications, 7 company, 9 locations, 10 about, 12/14 created/published [seconds, nanos]. */
export function googleJob(row: any[]): JobPosting {
  const id = String(row[0] ?? "");
  const title = String(row[1] ?? "").trim();
  if (!id || !title) throw new Error("Google careers: unexpected job row shape");
  const locs: any[] = Array.isArray(row[9]) ? row[9] : [];
  const location = locs.map((l) => (Array.isArray(l) ? l[0] : "")).filter(Boolean).join("; ");
  const ts = (Array.isArray(row[14]) && row[14][0]) || (Array.isArray(row[12]) && row[12][0]);
  const description = [
    htmlAt(row, 10),
    htmlAt(row, 3) && `Responsibilities:\n${htmlAt(row, 3)}`,
    htmlAt(row, 4) && `Qualifications:\n${htmlAt(row, 4)}`,
  ].filter(Boolean).join("\n\n");
  return {
    externalId: id,
    title,
    company: typeof row[7] === "string" && row[7] ? row[7] : "Google",
    location,
    url: `${GOOGLE_BASE}/${id}-${slugify(title)}`,
    remote: inferRemote(location),
    listingDate: typeof ts === "number" ? new Date(ts * 1000).toISOString().slice(0, 10) : null,
    salaryMin: null, // US ranges are in the description prose; the AI extracts them at triage
    salaryMax: null,
    description: description.slice(0, DESCRIPTION_CAP) || null,
  };
}

const google: Adapter = async (site) => {
  const cfg = (site.provider_config ?? {}) as Record<string, unknown>;
  const location = typeof cfg.location === "string" ? cfg.location : "United States";
  const raw = cfg.searchText;
  const terms = Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : typeof raw === "string" && raw ? [raw] : [""];
  const MAX = typeof cfg.maxResults === "number" ? cfg.maxResults : 600;

  const byId = new Map<string, JobPosting>();
  for (const term of terms) {
    let seenForTerm = 0;
    for (let page = 1; seenForTerm < MAX; page++) {
      const qs = new URLSearchParams({ location, page: String(page) });
      if (term) qs.set("q", term);
      const res = await fetch(`${GOOGLE_BASE}?${qs}`, { headers: { "User-Agent": GOOGLE_UA, Accept: "text/html" } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${GOOGLE_BASE}?${qs}`);
      const { rows, total } = googlePage(await res.text());
      for (const row of rows) {
        const p = googleJob(row);
        if (!byId.has(p.externalId)) byId.set(p.externalId, p);
      }
      seenForTerm += rows.length;
      if (rows.length === 0 || seenForTerm >= total) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return [...byId.values()];
};

const ADAPTERS: Record<string, Adapter> = { greenhouse, lever, ashby, workday, eightfold, amazon, apple, google };
// Merged at call time, not module load: ats-more.ts imports helpers from this file (a cycle).
const allAdapters = (): Record<string, Adapter> => ({ ...ADAPTERS, ...MORE_ADAPTERS });

/** Map a (messy) provider string to an adapter name, or null if unsupported. */
export function adapterNameFor(provider: string | null | undefined): string | null {
  const p = (provider ?? "").toLowerCase();
  for (const name of Object.keys(allAdapters())) {
    if (p.includes(name)) return name;
  }
  return null;
}

export function getAdapter(name: string): Adapter {
  const a = allAdapters()[name];
  if (!a) throw new Error(`No adapter "${name}"`);
  return a;
}
