/**
 * Manual intake: Carson pastes a job link, it becomes an `interested` opportunity.
 *
 * `fetchPosting` is the deterministic half: recognize the ATS from the URL and pull that one
 * posting through the provider's public API (same normalization as discovery). Links it can't
 * resolve come back `supported: false`, and the /interested skill reads the page itself.
 * `addInterested` writes the (AI-reviewed) posting: create it, or revive the existing row.
 */

import { randomUUID } from "node:crypto";
import {
  ashbyJob,
  eightfoldJob,
  fetchAshbyBoard,
  getJson,
  greenhouseJob,
  htmlToText,
  leverJob,
  workdayJob,
} from "./discovery/adapters.ts";
import type { JobPosting } from "./discovery/types.ts";
import { createOpportunity, fetchJobSites, findOpportunitiesByUrl, updateOpportunity } from "./db/index.ts";
import type { JobSite } from "./types.ts";

type Source = "greenhouse" | "lever" | "ashby" | "workday" | "eightfold";

type Parsed =
  | { source: "greenhouse"; token: string | null; jobId: string }
  | { source: "lever"; site: string; postingId: string; eu: boolean }
  | { source: "ashby"; org: string | null; jobId: string }
  | { source: "workday"; tenant: string; dc: string; site: string; jobPath: string }
  | { source: "eightfold"; host: string; jobId: string };

/** Recognize a supported ATS job link. Tokens left null are resolved from the watchlist. */
export function parseJobUrl(raw: string): Parsed | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);

  if (host.endsWith("greenhouse.io")) {
    // boards.greenhouse.io/<token>/jobs/<id>, job-boards(.eu).greenhouse.io/<token>/jobs/<id>
    const i = parts.indexOf("jobs");
    if (i > 0 && parts[i + 1]) return { source: "greenhouse", token: parts[i - 1]!, jobId: parts[i + 1]! };
    // embed: /embed/job_app?for=<token>&token=<id>
    const forTok = u.searchParams.get("for");
    const id = u.searchParams.get("token") ?? u.searchParams.get("gh_jid");
    if (forTok && id) return { source: "greenhouse", token: forTok, jobId: id };
  }
  if (host.endsWith("lever.co") && parts[0] && parts[1]) {
    return { source: "lever", site: parts[0], postingId: parts[1], eu: host.includes(".eu.") };
  }
  if (host.endsWith("ashbyhq.com") && parts[0] && parts[1]) {
    return { source: "ashby", org: parts[0], jobId: parts[1] };
  }
  const wd = host.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/);
  if (wd) {
    const j = parts.indexOf("job");
    // [<locale>/]<site>/job/<location>/<slug>
    if (j >= 1 && parts.length > j + 1) {
      return { source: "workday", tenant: wd[1]!, dc: wd[2]!, site: parts[j - 1]!, jobPath: parts.slice(j + 1).join("/") };
    }
  }
  // Eightfold career sites: <any host>/careers/job/<numeric id>
  const ef = u.pathname.match(/^\/careers\/job\/(\d{6,})\/?$/);
  if (ef) return { source: "eightfold", host, jobId: ef[1]! };
  // Company-hosted pages that embed an ATS (e.g. careers.example.com/jobs?gh_jid=123).
  const ghJid = u.searchParams.get("gh_jid");
  if (ghJid) return { source: "greenhouse", token: null, jobId: ghJid };
  const ashbyJid = u.searchParams.get("ashby_jid");
  if (ashbyJid) return { source: "ashby", org: null, jobId: ashbyJid };
  return null;
}

function cfg(site: JobSite, key: string): string | undefined {
  const v = site.provider_config?.[key];
  return typeof v === "string" ? v : undefined;
}

function sameHost(a: string | null, b: string): boolean {
  if (!a) return false;
  try {
    return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
}

/** A company-hosted page whose domain contains the ATS board name (redditinc.com ↔ "reddit"). */
function tokenInHost(token: string | undefined, url: string): boolean {
  if (!token || token.length < 4) return false;
  try {
    return new URL(url).hostname.toLowerCase().includes(token.toLowerCase());
  } catch {
    return false;
  }
}

/** The watchlist site this link belongs to, if any (gives the real company name + missing tokens). */
function matchSite(sites: JobSite[], p: Parsed, url: string): JobSite | undefined {
  return sites.find((s) => {
    const provider = (s.provider ?? "").toLowerCase();
    if (!provider.includes(p.source)) return false;
    switch (p.source) {
      case "greenhouse":
        return p.token
          ? cfg(s, "board_token") === p.token || !!s.url?.includes(`/${p.token}`)
          : sameHost(s.url, url) || tokenInHost(cfg(s, "board_token"), url);
      case "lever":
        return cfg(s, "site") === p.site || !!s.url?.includes(`/${p.site}`);
      case "ashby":
        return p.org
          ? (cfg(s, "org") ?? cfg(s, "board")) === p.org || !!s.url?.includes(`/${p.org}`)
          : sameHost(s.url, url) || tokenInHost(cfg(s, "org"), url);
      case "workday":
        return cfg(s, "tenant") === p.tenant && cfg(s, "site") === p.site;
      case "eightfold":
        return cfg(s, "host") === p.host || sameHost(s.url, url);
    }
  });
}

type Existing = Awaited<ReturnType<typeof findOpportunitiesByUrl>>;

export type FetchResult =
  | {
      supported: true;
      source: Source;
      watchlistSite: string | null;
      posting: JobPosting;
      existing: Existing;
      /** Set when the pasted link was a company page resolved to an ATS link. */
      resolvedFrom?: { url: string; via: "page-embed" | "workday-req-search" };
    }
  | { supported: false; reason: string; existing: Existing };

// ── Resolving company career pages to their ATS ─────────────────────────────

const ATS_LINK_PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  // Greenhouse embedded application form: job-boards.greenhouse.io/embed/job_app?for=<board>&token=<id>
  [/(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/embed\/job_app\?for=([\w-]+)(?:&amp;|&)token=(\d+)/g, (m) => `https://job-boards.greenhouse.io/${m[1]}/jobs/${m[2]}`],
  [/https?:\/\/(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/([\w-]+)\/jobs\/(\d+)/g, (m) => `https://job-boards.greenhouse.io/${m[1]}/jobs/${m[2]}`],
  [/https?:\/\/jobs(?:\.eu)?\.lever\.co\/[\w-]+\/[0-9a-f-]{36}/g, (m) => m[0]],
  [/https?:\/\/jobs\.ashbyhq\.com\/[\w-]+\/[0-9a-f-]{36}/g, (m) => m[0]],
  [/https?:\/\/[\w-]+\.wd\d+\.myworkdayjobs\.com\/[^"'\s<>]*\/job\/[^"'\s<>]+/g, (m) => m[0]],
];

/** Digit/uuid runs in a URL, used to pick the ATS link that's about THIS job. */
function idTokens(url: string): string[] {
  return (url.match(/[0-9a-f]{8}-[0-9a-f-]{27}|\d{5,}/gi) ?? []).map((t) => t.toLowerCase());
}

/** Scan a company career page's HTML for the ATS job link behind it. */
async function resolveViaPage(url: string): Promise<string | null> {
  let html: string;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" }, redirect: "follow" });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }
  const found = new Set<string>();
  for (const [re, build] of ATS_LINK_PATTERNS) {
    for (const m of html.matchAll(re)) found.add(build(m).replace(/&amp;/g, "&"));
  }
  const candidates = [...found].filter((c) => parseJobUrl(c));
  // Prefer a link carrying this job's id; a page listing many jobs is otherwise ambiguous.
  const ids = idTokens(url);
  const matching = candidates.filter((c) => ids.some((id) => c.toLowerCase().includes(id)));
  if (matching.length > 0) return matching[0]!;
  return candidates.length === 1 ? candidates[0]! : null;
}

/** Last two hostname labels (search-careers.gm.com → gm.com). Good enough for matching. */
function baseDomain(u: string | null): string | null {
  if (!u) return null;
  try {
    return new URL(u).hostname.toLowerCase().split(".").slice(-2).join(".");
  } catch {
    return null;
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Company pages fronting Workday often carry the requisition id (…/jobs/jr-202618717/…). For a
 * watchlist Workday site on the same domain, search its board for that req id.
 */
async function resolveViaWorkdayReq(url: string, sites: JobSite[]): Promise<string | null> {
  const reqs = (new URL(url).pathname.match(/\b(?:jr|r|req)-?\d{5,}\b/gi) ?? []).map((r) => r.toUpperCase());
  if (reqs.length === 0) return null;
  const domain = baseDomain(url);
  const boards = sites.filter(
    (s) => (s.provider ?? "").toLowerCase().includes("workday") && cfg(s, "tenant") && cfg(s, "site") && cfg(s, "dc") && baseDomain(s.url) === domain,
  );
  for (const s of boards) {
    const base = `https://${cfg(s, "tenant")}.${cfg(s, "dc")}.myworkdayjobs.com`;
    for (const req of reqs) {
      try {
        const data = (await getJson(`${base}/wday/cxs/${cfg(s, "tenant")}/${cfg(s, "site")}/jobs`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: req }),
        })) as { jobPostings?: Array<Record<string, any>> };
        const hit = (data.jobPostings ?? []).find(
          (j) => (j.bulletFields ?? []).some((b: unknown) => norm(String(b)) === norm(req)) || norm(String(j.externalPath ?? "")).endsWith(norm(req)),
        );
        if (hit?.externalPath) return `${base}/${cfg(s, "site")}${hit.externalPath}`;
      } catch {
        // try the next board / req id
      }
    }
  }
  return null;
}

/**
 * Fetch one posting from a pasted link. ATS links go straight to the provider API; anything
 * else (a company careers page) is resolved to its ATS link first, via an embedded link on the
 * page or a Workday requisition search, then fetched the same way.
 */
export async function fetchPosting(url: string): Promise<FetchResult> {
  const sites = await fetchJobSites();
  const direct = await fetchDirect(url, sites);
  if (direct.supported) return direct;

  const viaPage = await resolveViaPage(url);
  const resolved = viaPage
    ? { url: viaPage, via: "page-embed" as const }
    : await resolveViaWorkdayReq(url, sites).then((u) => (u ? { url: u, via: "workday-req-search" as const } : null));
  if (!resolved) return direct;

  const r = await fetchDirect(resolved.url, sites);
  if (!r.supported) return direct;
  // Dedupe against the pasted link too, in case a row was stored under it.
  const existing = await findOpportunitiesByUrl([...new Set([url, resolved.url, r.posting.url])]);
  return { ...r, existing, resolvedFrom: { url, via: resolved.via } };
}

async function fetchDirect(url: string, sites: JobSite[]): Promise<FetchResult> {
  const parsed = parseJobUrl(url);
  if (!parsed) {
    return { supported: false, reason: "not a recognized Greenhouse/Lever/Ashby/Workday/Eightfold job link", existing: await findOpportunitiesByUrl([url]) };
  }
  const site = matchSite(sites, parsed, url);
  const company = site?.name;
  let posting: JobPosting;

  switch (parsed.source) {
    case "greenhouse": {
      const token = parsed.token ?? (site && cfg(site, "board_token"));
      if (!token) {
        return { supported: false, reason: "Greenhouse job id found but no board token (company isn't on the watchlist)", existing: await findOpportunitiesByUrl([url]) };
      }
      const j = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${parsed.jobId}?pay_transparency=true`)) as Record<string, any>;
      posting = greenhouseJob(j, company ?? token);
      break;
    }
    case "lever": {
      const api = parsed.eu ? "api.eu.lever.co" : "api.lever.co";
      const j = (await getJson(`https://${api}/v0/postings/${parsed.site}/${parsed.postingId}`)) as Record<string, any>;
      posting = leverJob(j, company ?? parsed.site);
      break;
    }
    case "ashby": {
      const org = parsed.org ?? (site && (cfg(site, "org") ?? cfg(site, "board")));
      if (!org) {
        return { supported: false, reason: "Ashby job id found but no org (company isn't on the watchlist)", existing: await findOpportunitiesByUrl([url]) };
      }
      const j = (await fetchAshbyBoard(org)).find((x) => String(x.id) === parsed.jobId);
      if (!j) throw new Error(`Ashby job ${parsed.jobId} not found on the ${org} board (closed or unlisted?)`);
      posting = ashbyJob(j, company ?? org);
      break;
    }
    case "workday": {
      posting = await workdayJob(
        `https://${parsed.tenant}.${parsed.dc}.myworkdayjobs.com/${parsed.site}/job/${parsed.jobPath}`,
        company ?? null,
      );
      break;
    }
    case "eightfold": {
      // Company name falls back to the host (e.g. careers.appliedmaterials.com); the skill cleans it up.
      posting = await eightfoldJob(parsed.host, parsed.jobId, company ?? parsed.host);
      break;
    }
  }

  const existing = await findOpportunitiesByUrl([...new Set([url, posting.url])]);
  return { supported: true, source: parsed.source, watchlistSite: site?.name ?? null, posting, existing };
}

/** What the /interested skill hands to `intake add` after reviewing the fetched posting. */
export interface IntakeInput {
  url: string; // canonical listing URL (the dedupe key)
  aliases?: string[]; // other URLs for the same job (e.g. the link Carson pasted)
  title: string;
  company: string;
  location?: string | null;
  remote?: "fully_remote" | "hybrid" | "on_site" | null;
  listingDate?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  description?: string | null;
  matchPercentage?: number | null;
  chainOfThought?: string | null;
  summary?: string | null;
  notes?: string | null;
}

/** Statuses past `interested`: materials exist or it's in flight, so don't silently reset it. */
const PAST_INTERESTED = new Set(["pending_approval", "approved", "applied", "rejected"]);

export async function addInterested(
  input: IntakeInput,
  opts: { force?: boolean } = {},
): Promise<{ action: "created" | "revived"; id: string; previousStatus?: string }> {
  if (!input.url || !input.title || !input.company) throw new Error("intake add needs url, title, and company");

  const fields: Record<string, unknown> = {
    job_title: input.title,
    company: input.company,
    location: input.location ?? null,
    remote: input.remote ?? null,
    listing_date: input.listingDate ?? null,
    salary_min: input.salaryMin ?? null,
    salary_max: input.salaryMax ?? null,
    description: input.description ?? null,
    match_percentage: input.matchPercentage ?? null,
    chain_of_thought: input.chainOfThought ?? null,
    summary: input.summary ?? null,
    notes: input.notes ?? null,
  };

  const [existing] = await findOpportunitiesByUrl([...new Set([input.url, ...(input.aliases ?? [])])]);
  if (existing) {
    if (PAST_INTERESTED.has(existing.status) && !opts.force) {
      throw new Error(
        `Already tracked as ${existing.status} (${existing.id}: ${existing.company}, ${existing.job_title}). ` +
          `Re-run with --force to reset it to interested.`,
      );
    }
    // Only overwrite fields we actually have, so a thin manual intake can't blank out discovered data.
    const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== ""));
    await updateOpportunity(existing.id, { ...patch, status: "interested", archived: false });
    return { action: "revived", id: existing.id, previousStatus: existing.status };
  }

  const id = randomUUID();
  await createOpportunity({
    id,
    ...fields,
    application_url: input.url,
    status: "interested",
    archived: false,
    date_added: new Date().toISOString().slice(0, 10),
  });
  return { action: "created", id };
}

export interface PostingLiveness {
  live: boolean | null; // null = couldn't tell (unsupported ATS or a network error)
  via: string;
  detail?: string;
}

/**
 * Is the posting still open? Asks the ATS API directly: Greenhouse and Lever answer 404 for a
 * closed job, and a closed Ashby job drops off its org's board. Other links report `live: null`.
 * `/tailor` runs this first so a closed role doesn't get research and drafting.
 */
export async function checkPostingLive(url: string | null | undefined): Promise<PostingLiveness> {
  if (!url) return { live: null, via: "none", detail: "no application_url" };
  const parsed = parseJobUrl(url);
  const status = async (api: string): Promise<PostingLiveness> => {
    const res = await fetch(api);
    if (res.ok) return { live: true, via: parsed!.source };
    if (res.status === 404 || res.status === 410) return { live: false, via: parsed!.source, detail: `${res.status} from ${api}` };
    return { live: null, via: parsed!.source, detail: `${res.status} from ${api}` };
  };
  try {
    if (parsed?.source === "greenhouse" && parsed.token) {
      return await status(`https://boards-api.greenhouse.io/v1/boards/${parsed.token}/jobs/${parsed.jobId}`);
    }
    if (parsed?.source === "lever") {
      return await status(`https://${parsed.eu ? "api.eu.lever.co" : "api.lever.co"}/v0/postings/${parsed.site}/${parsed.postingId}`);
    }
    if (parsed?.source === "ashby" && parsed.org) {
      const jobs = await fetchAshbyBoard(parsed.org);
      return jobs.some((x) => String(x.id) === parsed.jobId)
        ? { live: true, via: "ashby" }
        : { live: false, via: "ashby", detail: `job ${parsed.jobId} is not on the ${parsed.org} board` };
    }
  } catch (err) {
    return { live: null, via: parsed?.source ?? "unknown", detail: err instanceof Error ? err.message : String(err) };
  }
  return { live: null, via: parsed?.source ?? "unknown", detail: "no liveness check for this link; open it to confirm" };
}
