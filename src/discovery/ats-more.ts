/**
 * More ATS adapters (registered in adapters.ts): SmartRecruiters, Workable, Rippling ATS, Atlassian's listings
 * feed, iCIMS career sites ("careers-home" / Jibe JSON), Oracle Cloud HCM, Shopify (Remix payload on its
 * careers page), and two job boards: RemoteOK and a11yjobs.com. All are public and need no auth.
 * Where a listing lacks descriptions, a detail fetcher fills them in for postings that survive the title filter.
 */

import { getJson, htmlToText, inferRemote } from "./adapters.ts";
import type { DetailFetcher } from "./adapters.ts";
import type { JobSite } from "../types.ts";
import type { Adapter, JobPosting } from "./types.ts";

const US = "United States of America";
const cfgString = (site: JobSite, key: string): string | undefined => {
  const v = site.provider_config?.[key];
  return typeof v === "string" && v ? v : undefined;
};
const cfgTerms = (site: JobSite): string[] => {
  const v = site.provider_config?.searchText;
  return Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : [""];
};
const cfgMax = (site: JobSite, dflt: number) => Number(site.provider_config?.maxResults) || dflt;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const joinText = (...parts: Array<string | null | undefined>) => parts.map((p) => htmlToText(p)).filter(Boolean).join("\n\n") || null;
const isoDate = (s: unknown) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const usCountry = (c: unknown) => (/^(us|usa|united states( of america)?)$/i.test(String(c ?? "").trim()) ? US : c ? String(c) : null);

// ── SmartRecruiters ─────────────────────────────────────────────────────────
// provider_config: { company: "Canva" } (the identifier in jobs.smartrecruiters.com/<company>/...).
const smartrecruiters: Adapter = async (site) => {
  const company = cfgString(site, "company");
  if (!company) throw new Error(`${site.name}: SmartRecruiters needs provider_config.company`);
  const out: JobPosting[] = [];
  for (let offset = 0; offset < cfgMax(site, 1000); offset += 100) {
    const d = (await getJson(`https://api.smartrecruiters.com/v1/companies/${company}/postings?limit=100&offset=${offset}`)) as {
      totalFound: number;
      content: Array<Record<string, any>>;
    };
    for (const j of d.content ?? []) {
      const loc = j.location ?? {};
      out.push({
        externalId: String(j.id),
        title: String(j.name ?? "").trim(),
        company: site.name,
        location: String(loc.fullLocation ?? [loc.city, loc.region, loc.country].filter(Boolean).join(", ")).replace(/,\s*,/g, ","),
        url: `https://jobs.smartrecruiters.com/${company}/${j.id}`,
        remote: loc.remote ? "fully_remote" : loc.hybrid ? "hybrid" : "on_site",
        listingDate: isoDate(j.releasedDate),
        salaryMin: null,
        salaryMax: null,
        description: null,
        country: usCountry(loc.country),
      });
    }
    if (offset + 100 >= (d.totalFound ?? 0)) break;
  }
  return out;
};

const smartrecruitersDetail: DetailFetcher = async (p, site) => {
  const company = site && cfgString(site, "company");
  if (!company) return p;
  const d = (await getJson(`https://api.smartrecruiters.com/v1/companies/${company}/postings/${p.externalId}`)) as Record<string, any>;
  const s = d.jobAd?.sections ?? {};
  return {
    ...p,
    description: joinText(s.jobDescription?.text, s.qualifications?.text, s.additionalInformation?.text) ?? p.description,
  };
};

// ── Workable ────────────────────────────────────────────────────────────────
// provider_config: { account: "huggingface" } (apply.workable.com/<account>/).
const workable: Adapter = async (site) => {
  const account = cfgString(site, "account");
  if (!account) throw new Error(`${site.name}: Workable needs provider_config.account`);
  const out: JobPosting[] = [];
  let token: string | undefined;
  do {
    const d = (await getJson(`https://apply.workable.com/api/v3/accounts/${account}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: "", location: [], department: [], worktype: [], remote: [], ...(token ? { token } : {}) }),
    })) as { results: Array<Record<string, any>>; nextPage?: string };
    for (const j of d.results ?? []) {
      const loc = j.location ?? {};
      const where = [loc.city, loc.region, loc.country].filter(Boolean).join(", ");
      out.push({
        externalId: String(j.shortcode),
        title: String(j.title ?? "").trim(),
        company: site.name,
        location: j.remote ? `Remote${where ? ` (${where})` : ""}` : where,
        url: `https://apply.workable.com/${account}/j/${j.shortcode}/`,
        remote: j.workplace === "hybrid" ? "hybrid" : j.remote ? "fully_remote" : "on_site",
        listingDate: isoDate(j.published),
        salaryMin: null,
        salaryMax: null,
        description: null,
        country: usCountry(loc.countryCode === "US" ? "US" : loc.country),
      });
    }
    token = d.nextPage;
  } while (token && out.length < cfgMax(site, 1000));
  return out;
};

const workableDetail: DetailFetcher = async (p, site) => {
  const account = site && cfgString(site, "account");
  if (!account) return p;
  const d = (await getJson(`https://apply.workable.com/api/v2/accounts/${account}/jobs/${p.externalId}`)) as Record<string, any>;
  return { ...p, description: joinText(d.description, d.requirements, d.benefits) ?? p.description };
};

// ── Rippling ATS ────────────────────────────────────────────────────────────
// provider_config: { board: "rippling" } (ats.rippling.com/<board>/jobs). The list has no dates or text;
// the detail call carries the description and createdOn.
const rippling: Adapter = async (site) => {
  const board = cfgString(site, "board");
  if (!board) throw new Error(`${site.name}: Rippling ATS needs provider_config.board`);
  const list = (await getJson(`https://api.rippling.com/platform/api/ats/v1/board/${board}/jobs`)) as Array<Record<string, any>>;
  return list.map((j) => {
    const location = String(j.workLocation?.label ?? "");
    return {
      externalId: String(j.uuid),
      title: String(j.name ?? "").trim(),
      company: site.name,
      location,
      url: String(j.url ?? `https://ats.rippling.com/${board}/jobs/${j.uuid}`),
      remote: inferRemote(location),
      listingDate: null,
      salaryMin: null,
      salaryMax: null,
      description: null,
    };
  });
};

const ripplingDetail: DetailFetcher = async (p, site) => {
  const board = site && cfgString(site, "board");
  if (!board) return p;
  const d = (await getJson(`https://api.rippling.com/platform/api/ats/v1/board/${board}/jobs/${p.externalId}`)) as Record<string, any>;
  const desc = d.description && typeof d.description === "object" ? Object.values(d.description).map(String) : [String(d.description ?? "")];
  const locs: string[] = (d.workLocations ?? []).map((l: any) => String(l?.label ?? l)).filter(Boolean);
  return {
    ...p,
    description: joinText(...desc) ?? p.description,
    listingDate: isoDate(d.createdOn) ?? p.listingDate,
    location: locs.join("; ") || p.location,
    remote: inferRemote(locs.join(" ")) ?? p.remote,
  };
};

// ── Atlassian (careers listings feed, iCIMS-backed) ─────────────────────────
// No config. One call returns every posting with its full text.
const atlassian: Adapter = async (site) => {
  const list = (await getJson("https://www.atlassian.com/endpoint/careers/listings")) as Array<Record<string, any>>;
  return list.map((j) => {
    const locs: string[] = (j.locations ?? []).map((l: string) => l.replace(/\s+/g, " ").trim());
    const us = locs.some((l) => /united states|\bUSA\b|- US -|San Francisco|New York|Seattle|Austin|Mountain View/i.test(l));
    const updated = String(j.portalJobPost?.updatedDate ?? "");
    return {
      externalId: String(j.id),
      title: String(j.title ?? "").trim(),
      company: site.name,
      location: locs.join("; "),
      url: String(j.portalJobPost?.portalUrl ?? j.applyUrl ?? ""),
      remote: inferRemote(locs.join(" ")),
      listingDate: isoDate(updated),
      salaryMin: null,
      salaryMax: null,
      description: joinText(j.overview, j.responsibilities, j.qualifications),
      country: us ? US : locs.length ? "Other" : null,
    };
  });
};

// ── iCIMS career sites ("careers-home", Jibe JSON) ──────────────────────────
// provider_config: { host: "careers.rivian.com", searchText?: string | string[], maxResults?: number }.
// Descriptions come in the listing.
const icims: Adapter = async (site) => {
  const host = cfgString(site, "host");
  if (!host) throw new Error(`${site.name}: iCIMS career site needs provider_config.host`);
  const byId = new Map<string, JobPosting>();
  for (const term of cfgTerms(site)) {
    for (let page = 1; byId.size < cfgMax(site, 1000); page++) {
      const d = (await getJson(`https://${host}/api/jobs?page=${page}&limit=100${term ? `&keywords=${encodeURIComponent(term)}` : ""}`)) as {
        jobs: Array<{ data: Record<string, any> }>;
        totalCount: number;
      };
      for (const { data: j } of d.jobs ?? []) {
        const location = String(j.full_location ?? j.location_name ?? "");
        byId.set(String(j.slug), {
          externalId: String(j.req_id ?? j.slug),
          title: String(j.title ?? "").trim(),
          company: site.name,
          location,
          url: `https://${host}/careers-home/jobs/${j.slug}`,
          remote: inferRemote(`${location} ${j.location_type ?? ""}`),
          listingDate: isoDate(j.posted_date),
          salaryMin: null,
          salaryMax: null,
          description: joinText(j.description, j.responsibilities, j.qualifications),
          country: usCountry(j.country_code === "US" ? "US" : j.country),
        });
      }
      if ((d.jobs ?? []).length < 100 || page * 100 >= (d.totalCount ?? 0)) break;
      await sleep(300);
    }
  }
  return [...byId.values()];
};

// ── Oracle Cloud HCM (Candidate Experience) ─────────────────────────────────
// provider_config: { host: "efds.fa.em5.oraclecloud.com", siteNumber: "CX_1", searchText?, maxResults? }.
const oracleList = (host: string, site: string, term: string, offset: number) =>
  `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations` +
  `&finder=findReqs;siteNumber=${site},limit=25,offset=${offset},sortBy=POSTING_DATES_DESC${term ? `,keyword=%22${encodeURIComponent(term)}%22` : ""}`;

const oracle: Adapter = async (site) => {
  const host = cfgString(site, "host");
  const siteNumber = cfgString(site, "siteNumber");
  if (!host || !siteNumber) throw new Error(`${site.name}: Oracle HCM needs provider_config {host, siteNumber}`);
  const byId = new Map<string, JobPosting>();
  for (const term of cfgTerms(site)) {
    for (let offset = 0; byId.size < cfgMax(site, 400); offset += 25) {
      const d = (await getJson(oracleList(host, siteNumber, term, offset), { headers: { Accept: "application/json" } })) as {
        items: Array<{ TotalJobsCount: number; requisitionList: Array<Record<string, any>> }>;
      };
      const it = d.items?.[0];
      for (const j of it?.requisitionList ?? []) {
        const location = [j.PrimaryLocation, ...(j.secondaryLocations ?? []).map((l: any) => l?.Name)].filter(Boolean).join("; ");
        const mode = String(j.WorkplaceTypeCode ?? "");
        byId.set(String(j.Id), {
          externalId: String(j.Id),
          title: String(j.Title ?? "").trim(),
          company: site.name,
          location,
          url: `https://${host}/hcmUI/CandidateExperience/en/sites/${siteNumber}/job/${j.Id}`,
          remote: /REMOTE/.test(mode) ? "fully_remote" : /HYBRID/.test(mode) ? "hybrid" : /ON_SITE|ONSITE/.test(mode) ? "on_site" : inferRemote(location),
          listingDate: isoDate(j.PostedDate),
          salaryMin: null,
          salaryMax: null,
          description: joinText(j.ShortDescriptionStr, j.ExternalResponsibilitiesStr, j.ExternalQualificationsStr),
          country: usCountry(j.PrimaryLocationCountry),
        });
      }
      if (!it || (it.requisitionList ?? []).length < 25 || offset + 25 >= (it.TotalJobsCount ?? 0)) break;
      await sleep(300);
    }
  }
  return [...byId.values()];
};

const oracleDetail: DetailFetcher = async (p, site) => {
  const host = site && cfgString(site, "host");
  const siteNumber = site && cfgString(site, "siteNumber");
  if (!host || !siteNumber) return p;
  const d = (await getJson(
    `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${p.externalId}%22,siteNumber=${siteNumber}`,
    { headers: { Accept: "application/json" } },
  )) as { items: Array<Record<string, any>> };
  const j = d.items?.[0];
  if (!j) return p;
  return {
    ...p,
    description: joinText(j.ExternalDescriptionStr, j.ExternalResponsibilitiesStr, j.ExternalQualificationsStr, j.CorporateDescriptionStr) ?? p.description,
  };
};

// ── Shopify (Ashby data embedded in shopify.com/careers as a Remix turbo-stream) ──
// No public Ashby board; the careers page server-renders every posting. No config.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

/** Decode the root of a Remix turbo-stream (flat array; objects map "_<keyIdx>" → valueIdx; negatives are null-ish). */
function decodeTurboStream(html: string): unknown {
  const m = html.match(/streamController\.enqueue\(("(?:[^"\\]|\\.)*")\)/);
  if (!m) throw new Error("no turbo-stream payload on the page (layout changed?)");
  const arr = JSON.parse((JSON.parse(m[1]!) as string).split("\n")[0]!) as unknown[];
  const memo = new Map<number, unknown>();
  const decode = (i: number): unknown => {
    if (i < 0) return null;
    if (memo.has(i)) return memo.get(i);
    const v = arr[i];
    if (Array.isArray(v)) {
      if (typeof v[0] === "string" && v.length <= 3 && /^[A-Z]$/.test(v[0])) return v[1] ?? null; // typed scalar (date, etc.)
      const out: unknown[] = [];
      memo.set(i, out);
      for (const x of v) out.push(typeof x === "number" ? decode(x) : x);
      return out;
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      memo.set(i, out);
      for (const [k, idx] of Object.entries(v)) out[String(arr[Number(k.slice(1))])] = decode(idx as number);
      return out;
    }
    return v;
  };
  return decode(0);
}

function findObjects(root: unknown, test: (o: Record<string, any>) => boolean): Array<Record<string, any>> {
  const found: Array<Record<string, any>> = [];
  const seen = new Set<unknown>();
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    if (!Array.isArray(n) && test(n as Record<string, any>)) found.push(n as Record<string, any>);
    for (const x of Object.values(n)) walk(x);
  };
  walk(root);
  return found;
}

const shopify: Adapter = async (site) => {
  const html = await (await fetch("https://www.shopify.com/careers", { headers: { "User-Agent": UA } })).text();
  const jobs = findObjects(decodeTurboStream(html), (o) => "externalLink" in o && "title" in o && "publishedDate" in o);
  return jobs
    .filter((j) => j.isListed !== false)
    .map((j) => {
      const location = String(j.locationExternalName ?? j.locationName ?? "");
      const mode = String(j.workplaceType ?? "");
      return {
        externalId: String(j.id),
        title: String(j.title ?? "").trim(),
        company: site.name,
        location: mode === "Remote" ? `Remote (${location})` : location,
        url: String(j.externalLink),
        remote: mode === "Remote" ? "fully_remote" : mode === "Hybrid" ? "hybrid" : mode ? "on_site" : inferRemote(location),
        listingDate: isoDate(j.publishedDate),
        salaryMin: null,
        salaryMax: null,
        description: null,
        // Shopify's regions are coarse ("Americas", "United States", "Canada"); only a clear non-US region is excluded.
        country: /united states|\bUS\b|americas/i.test(location) ? US : location ? location : null,
      };
    });
};

const shopifyDetail: DetailFetcher = async (p) => {
  const html = await (await fetch(p.url, { headers: { "User-Agent": UA } })).text();
  const [d] = findObjects(decodeTurboStream(html), (o) => typeof o.descriptionPlain === "string" || typeof o.descriptionHtml === "string");
  return d ? { ...p, description: (htmlToText(d.descriptionHtml) ?? String(d.descriptionPlain)) || p.description } : p;
};

// ── RemoteOK (aggregator, remoteok.com/api) ─────────────────────────────────
// No config. Latest ~100 remote jobs across companies; the title filter does the narrowing. Company comes
// from each job, so rows land under the hiring company's name.
const remoteok: Adapter = async () => {
  const data = (await getJson("https://remoteok.com/api", { headers: { "User-Agent": UA, Accept: "application/json" } })) as Array<Record<string, any>>;
  return data
    .filter((j) => j.id && j.position)
    .map((j) => ({
      externalId: String(j.id),
      title: String(j.position).trim(),
      company: String(j.company ?? "Unknown"),
      location: j.location ? `Remote (${j.location})` : "Remote",
      url: String(j.url ?? `https://remoteok.com/remote-jobs/${j.id}`),
      remote: "fully_remote" as const,
      listingDate: isoDate(j.date),
      salaryMin: Number(j.salary_min) > 0 ? Number(j.salary_min) : null,
      salaryMax: Number(j.salary_max) > 0 ? Number(j.salary_max) : null,
      description: htmlToText(j.description),
    }));
};

// ── a11yjobs.com (accessibility job board) ──────────────────────────────────
// No config. The homepage lists the newest postings; each job page carries a schema.org JobPosting, read by
// the detail fetcher (company, description, date, location, salary). Pair with provider_config.keywords.
const a11yjobs: Adapter = async () => {
  const html = await (await fetch("https://www.a11yjobs.com/", { headers: { "User-Agent": UA } })).text();
  const seen = new Map<string, string>();
  for (const [, href, inner] of html.matchAll(/<a[^>]*href="(\/jobs\/[^"]+)"[^>]*>([\s\S]{0,400}?)<\/a>/gi)) {
    const title = inner!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (title && !seen.has(href!)) seen.set(href!, title);
  }
  return [...seen].map(([href, title]) => ({
    externalId: href.split("-").pop() ?? href,
    title,
    company: "a11yjobs",
    location: "",
    url: `https://www.a11yjobs.com${href}`,
    remote: null,
    listingDate: null,
    salaryMin: null,
    salaryMax: null,
    description: null,
  }));
};

const a11yjobsDetail: DetailFetcher = async (p) => {
  const html = await (await fetch(p.url, { headers: { "User-Agent": UA } })).text();
  const m = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return p;
  const jp = JSON.parse(m[1]!) as Record<string, any>;
  const addr = (Array.isArray(jp.jobLocation) ? jp.jobLocation[0] : jp.jobLocation)?.address ?? {};
  const location = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(", ");
  const remote = /TELECOMMUTE/i.test(String(jp.jobLocationType ?? "")) ? "fully_remote" : inferRemote(location);
  const sal = jp.baseSalary?.value ?? {};
  const yearly = /YEAR/i.test(String(sal.unitText ?? jp.baseSalary?.unitText ?? "")) && (jp.baseSalary?.currency ?? "USD") === "USD";
  return {
    ...p,
    company: String(jp.hiringOrganization?.name ?? p.company),
    location: remote === "fully_remote" ? `Remote${location ? ` (${location})` : ""}` : location,
    remote,
    listingDate: isoDate(jp.datePosted),
    salaryMin: yearly && Number(sal.minValue) > 0 ? Number(sal.minValue) : p.salaryMin,
    salaryMax: yearly && Number(sal.maxValue) > 0 ? Number(sal.maxValue) : p.salaryMax,
    description: htmlToText(jp.description) ?? p.description,
    country: usCountry(addr.addressCountry),
  };
};

// ── Career-site sitemaps (Radancy/TMP, SuccessFactors Recruiting Marketing, custom sites) ──────────
// provider_config: { sitemap: "https://jobs.intuit.com/sitemap.xml" (string or string[]),
//                    jobPattern?: regex source a job URL must match (default "/jobs?/") }.
// The sitemap only has URLs, so the listing title is a guess from the URL slug (good enough for the
// keyword pre-filter; it can carry city/state words). Survivors get sitemapDetail, which reads the page's
// schema.org JobPosting (JSON-LD: Intuit, Etsy, Carnival) or microdata (SuccessFactors: Paramount,
// McDonald's) and replaces the guess with the real title, date, location, pay, and description.
const SITEMAP_HEADERS = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", Accept: "text/html,application/xml" };

async function sitemapUrls(url: string, depth = 0): Promise<string[]> {
  const res = await fetch(url, { headers: SITEMAP_HEADERS, redirect: "follow" });
  if (!res.ok) throw new Error(`sitemap ${res.status} for ${url}`);
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!.replace(/&amp;/g, "&"));
  if (!/<sitemapindex/i.test(xml) || depth > 0) return locs;
  const nested: string[] = [];
  for (const child of locs.slice(0, 25)) {
    nested.push(...(await sitemapUrls(child, depth + 1)));
    await sleep(200);
  }
  return nested;
}

/** "San-Francisco-Sr-Software-Engineer-Core-Web-CA-94107" → "San Francisco Sr Software Engineer Core Web CA 94107". */
function titleFromJobUrl(url: string): string {
  const segs = new URL(url).pathname.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const longest = segs.reduce((a, b) => ((b.match(/[-_]/g)?.length ?? 0) > (a.match(/[-_]/g)?.length ?? 0) ? b : a), "");
  return longest.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

const sitemap: Adapter = async (site) => {
  const raw = site.provider_config?.sitemap;
  const maps = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" && raw ? [raw] : [];
  if (maps.length === 0) throw new Error(`${site.name}: sitemap provider needs provider_config.sitemap`);
  const jobRe = new RegExp(cfgString(site, "jobPattern") ?? "/jobs?/", "i");
  const urls = new Set<string>();
  for (const m of maps) for (const u of await sitemapUrls(m)) if (jobRe.test(new URL(u).pathname)) urls.add(u);
  return [...urls].map((url) => ({
    externalId: url,
    title: titleFromJobUrl(url),
    company: site.name,
    location: "",
    url,
    remote: null,
    listingDate: null,
    salaryMin: null,
    salaryMax: null,
    description: null,
  }));
};

/** The schema.org JobPosting in a page's JSON-LD, if any. */
function jsonLdJobPosting(html: string): Record<string, any> | null {
  const find = (node: unknown): Record<string, any> | null => {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const n of node) {
        const hit = find(n);
        if (hit) return hit;
      }
      return null;
    }
    const o = node as Record<string, any>;
    const t = o["@type"];
    if (t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"))) return o;
    return find(o["@graph"]);
  };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const hit = find(JSON.parse(m[1]!));
      if (hit) return hit;
    } catch {
      /* malformed block; try the next */
    }
  }
  return null;
}

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** schema.org microdata (SuccessFactors pages): itemprop content= values, plus the description element's inner HTML. */
function microdataJobPosting(html: string): Record<string, string> | null {
  if (!/itemtype=["']https?:\/\/schema\.org\/JobPosting["']/i.test(html)) return null;
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<(\w+)[^>]*\sitemprop="(\w+)"[^>]*>/g)) {
    const [tag, el, prop] = [m[0], m[1]!, m[2]!];
    if (out[prop]) continue;
    const content = tag.match(/\scontent="([^"]*)"/)?.[1];
    if (content != null) {
      out[prop] = decodeEntities(content);
      continue;
    }
    // No content attribute: take the element's inner HTML, matching nested tags of the same name.
    const start = (m.index ?? 0) + tag.length;
    const re = new RegExp(`<(/?)${el}\\b[^>]*>`, "gi");
    re.lastIndex = start;
    let depth = 1;
    let end = html.length;
    for (let t = re.exec(html); t; t = re.exec(html)) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) {
        end = t.index;
        break;
      }
    }
    out[prop] = html.slice(start, end);
  }
  return out.title ? out : null;
}

const sitemapDetail: DetailFetcher = async (p) => {
  const res = await fetch(p.url, { headers: SITEMAP_HEADERS, redirect: "follow" });
  if (!res.ok) return p;
  const html = await res.text();
  const jp = jsonLdJobPosting(html);
  if (jp) {
    const places: any[] = Array.isArray(jp.jobLocation) ? jp.jobLocation : jp.jobLocation ? [jp.jobLocation] : [];
    const addrs = places.map((pl) => pl?.address ?? {});
    const location = addrs.map((a) => [a.addressLocality, a.addressRegion].filter(Boolean).join(", ")).filter(Boolean).join("; ");
    const countries = [...new Set(addrs.map((a) => usCountry(a.addressCountry)).filter(Boolean))];
    const sal = jp.baseSalary?.value ?? {};
    const yearly = (jp.baseSalary?.currency ?? "USD") === "USD" && /YEAR/i.test(String(sal.unitText ?? jp.baseSalary?.unitText ?? "YEAR"));
    return {
      ...p,
      title: String(jp.title ?? p.title).trim(),
      location: location || p.location,
      remote: /TELECOMMUTE/i.test(String(jp.jobLocationType ?? "")) ? "fully_remote" : inferRemote(location),
      listingDate: isoDate(jp.datePosted) ?? p.listingDate,
      salaryMin: yearly && Number(sal.minValue) > 0 ? Math.round(Number(sal.minValue)) : p.salaryMin,
      salaryMax: yearly && Number(sal.maxValue) > 0 ? Math.round(Number(sal.maxValue)) : p.salaryMax,
      description: htmlToText(jp.description) ?? p.description,
      country: countries.length === 1 ? countries[0]! : p.country ?? null,
    };
  }
  const md = microdataJobPosting(html);
  if (!md) return p;
  const location = [md.addressLocality, md.addressRegion].filter(Boolean).join(", ");
  const posted = md.datePosted ? new Date(md.datePosted) : null;
  return {
    ...p,
    title: md.title!.trim(),
    location: location || p.location,
    remote: inferRemote(location),
    listingDate: posted && !Number.isNaN(posted.getTime()) ? posted.toISOString().slice(0, 10) : p.listingDate,
    description: htmlToText(md.description) ?? p.description,
    country: usCountry(md.addressCountry) ?? p.country ?? null,
  };
};

/** Registered by name; adapterNameFor() matches these keys as substrings of job_sites.provider. */
export const MORE_ADAPTERS: Record<string, Adapter> = { smartrecruiters, workable, rippling, atlassian, icims, oracle, shopify, remoteok, a11yjobs, sitemap };
export const MORE_DETAIL_FETCHERS: Record<string, DetailFetcher> = {
  smartrecruiters: smartrecruitersDetail,
  workable: workableDetail,
  rippling: ripplingDetail,
  oracle: oracleDetail,
  shopify: shopifyDetail,
  a11yjobs: a11yjobsDetail,
  sitemap: sitemapDetail,
};
