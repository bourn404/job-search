/**
 * Is each non-archived opportunity's posting still open? Deterministic, per provider, keyed off the
 * row's application_url (rows don't record their watchlist site):
 *   Greenhouse (gh_jid, greenhouse.io, careerpuck)  job id present on the company's current board
 *   Lever                                           per-posting API: 200 open / 404 closed
 *   Ashby                                           job id present on the org's current board
 *   Workday                                         CXS detail: 200 open / 404 closed
 *   Eightfold (/careers/job/<id>)                   PCSX position_details, else apply-v2: 200 / 404
 *   Amazon                                          job page: 200 open / 404 closed
 *   Apple                                           jobDetails API: posting present or not
 *   Google                                          the page's 'ds:0' block holds the job, or an error
 *   anything else                                   plain GET: 404/410 closed, otherwise unknown
 * "unknown" (errors, throttling, a board we can't pin down) is never archived.
 */

import { appleHeaders } from "./discovery/adapters.ts";
import { fetchJobSites, fetchLivenessRows, updateOpportunity, type LivenessRow } from "./db/index.ts";
import type { JobSite } from "./types.ts";

export type Verdict = "open" | "closed" | "unknown";
export interface LivenessResult {
  row: LivenessRow;
  verdict: Verdict;
  reason: string;
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET with backoff on 429/403 (Eightfold/Workday front doors answer bursts that way). Returns the response.
 * `browserUA` adds a Chrome User-Agent for HTML pages; leave it off for APIs, because Workday's Akamai
 * blocks a Chrome UA arriving with Node's TLS fingerprint (403) but allows Node's default.
 */
async function get(url: string, headers: Record<string, string> = {}, browserUA = false): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { ...(browserUA ? { "User-Agent": UA } : {}), ...headers }, redirect: "follow" });
    const permanent403 = res.status === 403 && res.headers.get("content-type")?.includes("json");
    if ((res.status === 429 || (res.status === 403 && !permanent403)) && attempt < 3) {
      await sleep(Number(res.headers.get("retry-after")) * 1000 || 2000 * 2 ** attempt);
      continue;
    }
    return res;
  }
}

const byStatus = (res: Response, what: string): [Verdict, string] =>
  res.status === 404 || res.status === 410
    ? ["closed", `${what}: ${res.status}`]
    : res.ok
      ? ["open", `${what}: ${res.status}`]
      : ["unknown", `${what}: ${res.status}`];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const cfg = (s: JobSite, k: string) => (typeof s.provider_config?.[k] === "string" ? (s.provider_config[k] as string) : null);

// ── Greenhouse: one board fetch per token, then membership ────────────────────

function greenhouseRef(url: string): { id: string; token: string | null } | null {
  const id = url.match(/[?&]gh_jid=(\d+)/)?.[1] ?? url.match(/greenhouse\.io\/[\w-]+\/jobs\/(\d+)/)?.[1] ?? url.match(/careerpuck\.com\/job-board\/[\w-]+\/job\/(\d+)/)?.[1];
  if (!id) return null;
  const token = url.match(/greenhouse\.io\/([\w-]+)\/jobs\//)?.[1] ?? url.match(/careerpuck\.com\/job-board\/([\w-]+)\//)?.[1] ?? null;
  return { id, token };
}

async function greenhouseBoards(tokens: string[]): Promise<Map<string, Set<string> | null>> {
  const boards = new Map<string, Set<string> | null>();
  for (const t of tokens) {
    try {
      const res = await get(`https://boards-api.greenhouse.io/v1/boards/${t}/jobs`, { Accept: "application/json" });
      boards.set(t, res.ok ? new Set(((await res.json()) as { jobs: Array<{ id: number }> }).jobs.map((j) => String(j.id))) : null);
    } catch {
      boards.set(t, null);
    }
  }
  return boards;
}

// ── Per-row checks ───────────────────────────────────────────────────────────

async function eightfold(host: string, id: string, domain: string): Promise<[Verdict, string]> {
  const pcsx = await get(`https://${host}/api/pcsx/position_details?position_id=${id}`, { Accept: "application/json" });
  if (pcsx.ok) {
    const d = ((await pcsx.json()) as { data?: { name?: string } }).data;
    if (d?.name) return ["open", "Eightfold PCSX: 200"];
  } else if (pcsx.status === 404) {
    const body = await pcsx.text();
    if (/position not found/i.test(body)) return ["closed", "Eightfold PCSX: Position not found"];
  }
  // Legacy apply-v2 hosts (PayPal, Qualcomm) don't serve PCSX.
  return byStatus(await get(`https://${host}/api/apply/v2/jobs/${id}?domain=${domain}`, { Accept: "application/json" }), "Eightfold v2");
}

async function checkRow(
  row: LivenessRow,
  ctx: { boards: Map<string, Set<string> | null>; ghTokensFor: (company: string) => string[]; ashby: Map<string, Set<string> | null>; eightfoldDomain: (host: string) => string },
): Promise<[Verdict, string]> {
  const url = row.application_url;
  if (!url) return ["unknown", "no application_url"];
  const host = new URL(url).host;

  const gh = greenhouseRef(url);
  if (gh) {
    const tokens = [...new Set([...(gh.token ? [gh.token] : []), ...ctx.ghTokensFor(row.company)])];
    for (const b of ctx.boards.values()) if (b?.has(gh.id)) return ["open", "on the Greenhouse board"];
    const fetched = tokens.filter((t) => ctx.boards.get(t));
    if (fetched.length) return ["closed", `not on the ${fetched.join("/")} Greenhouse board`];
    return ["unknown", "Greenhouse board unknown or unreachable"];
  }
  if (host === "jobs.lever.co") {
    const [, site, id] = new URL(url).pathname.split("/");
    return byStatus(await get(`https://api.lever.co/v0/postings/${site}/${id}`), "Lever API");
  }
  if (host === "jobs.ashbyhq.com") {
    const [, org, id] = new URL(url).pathname.split("/");
    const board = ctx.ashby.get(org!);
    if (!board) return ["unknown", `Ashby board ${org} unreachable`];
    return board.has(id!) ? ["open", "on the Ashby board"] : ["closed", `not on the ${org} Ashby board`];
  }
  const wd = url.match(/^(https:\/\/([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com)\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)\/job\/(.+)$/);
  if (wd) {
    const res = await get(`${wd[1]}/wday/cxs/${wd[2]}/${wd[3]}/job/${wd[4]}`, { Accept: "application/json" });
    // Workday answers an unposted (closed) job with 403 + errorCode S22 "permission denied"; a job that
    // never existed is 404 S21. Verified 2026-09-29: S22 postings are gone from the board's own search.
    if (res.status === 403 && /"errorCode":"S22"/.test(await res.text())) return ["closed", "Workday CXS: unposted (S22)"];
    return byStatus(res, "Workday CXS");
  }
  const ef = url.match(/\/careers\/job\/(\d+)/);
  if (ef) return eightfold(host, ef[1]!, ctx.eightfoldDomain(host));
  if (host.endsWith("amazon.jobs")) return byStatus(await get(url, {}, true), "Amazon page");
  if (host === "jobs.apple.com") {
    const id = url.match(/\/details\/([\w-]+)/)?.[1];
    const res = await get(`https://jobs.apple.com/api/v1/jobDetails/${id}`, await appleHeaders());
    if (res.status === 404) return ["closed", "Apple jobDetails: 404"];
    if (!res.ok) return ["unknown", `Apple jobDetails: ${res.status}`];
    const r = ((await res.json()) as { res?: { postingTitle?: string } }).res;
    return r?.postingTitle ? ["open", "Apple jobDetails: posting present"] : ["closed", "Apple jobDetails: no posting"];
  }
  if (host === "www.google.com" && url.includes("/careers/")) {
    const id = url.match(/\/results\/(\d+)/)?.[1];
    const res = await get(url, {}, true);
    if (!res.ok) return byStatus(res, "Google page");
    const ds0 = (await res.text()).match(/AF_initDataCallback\(\{key: 'ds:0'.*?data:(.{0,120})/s)?.[1] ?? "";
    if (id && ds0.startsWith(`[["${id}"`)) return ["open", "Google: job data present"];
    if (/ErrorDetails/.test(ds0)) return ["closed", "Google: job not found"];
    return ["unknown", "Google: unrecognized page"];
  }
  return byStatus(await get(url, {}, true), "page");
}

/** Hosts get their own serial queue (politeness); different hosts run in parallel. */
export async function checkOpen(opts: { hostFilter?: string; onProgress?: (done: number, total: number) => void } = {}): Promise<LivenessResult[]> {
  const [rows, sites] = await Promise.all([fetchLivenessRows(), fetchJobSites()]);
  const todo = rows.filter((r) => !opts.hostFilter || (r.application_url ?? "").includes(opts.hostFilter));

  const ghSites = sites.filter((s) => /greenhouse/i.test(s.provider ?? "") && cfg(s, "board_token"));
  const ghTokensFor = (company: string) =>
    ghSites.filter((s) => norm(s.name).includes(norm(company)) || norm(company).includes(norm(s.name))).map((s) => cfg(s, "board_token")!);
  const needTokens = new Set<string>();
  for (const r of todo) {
    const gh = r.application_url ? greenhouseRef(r.application_url) : null;
    if (gh) for (const t of [...(gh.token ? [gh.token] : []), ...ghTokensFor(r.company)]) needTokens.add(t);
  }
  const boards = await greenhouseBoards([...needTokens]);

  const ashby = new Map<string, Set<string> | null>();
  for (const r of todo) {
    const m = r.application_url?.match(/jobs\.ashbyhq\.com\/([^/]+)\//);
    if (!m || ashby.has(m[1]!)) continue;
    try {
      const res = await get(`https://api.ashbyhq.com/posting-api/job-board/${m[1]}`, { Accept: "application/json" });
      ashby.set(m[1]!, res.ok ? new Set(((await res.json()) as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id)) : null);
    } catch {
      ashby.set(m[1]!, null);
    }
  }

  const efDomains = new Map(sites.filter((s) => cfg(s, "host")).map((s) => [cfg(s, "host")!, cfg(s, "domain") ?? cfg(s, "host")!.split(".").slice(-2).join(".")]));
  const eightfoldDomain = (h: string) => efDomains.get(h) ?? h.split(".").slice(-2).join(".");
  const ctx = { boards, ghTokensFor, ashby, eightfoldDomain };

  const queues = new Map<string, LivenessRow[]>();
  for (const r of todo) {
    const key = r.application_url ? new URL(r.application_url).host : "none";
    queues.set(key, [...(queues.get(key) ?? []), r]);
  }
  const results: LivenessResult[] = [];
  let done = 0;
  await Promise.all(
    [...queues.values()].map(async (q) => {
      for (const row of q) {
        let verdict: Verdict, reason: string;
        try {
          [verdict, reason] = await checkRow(row, ctx);
        } catch (err) {
          [verdict, reason] = ["unknown", err instanceof Error ? err.message : String(err)];
        }
        results.push({ row, verdict, reason });
        opts.onProgress?.(++done, todo.length);
        await sleep(250);
      }
    }),
  );
  // Second pass, slow and serial: most "unknown"s are front doors (Workday's Akamai) throttling a burst.
  for (const r of results.filter((x) => x.verdict === "unknown")) {
    await sleep(1500);
    try {
      [r.verdict, r.reason] = await checkRow(r.row, ctx);
    } catch (err) {
      r.reason = err instanceof Error ? err.message : String(err);
    }
  }
  return results;
}

/** Archive the closed rows, appending a dated line to each row's notes. */
export async function archiveClosed(results: LivenessResult[]): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  let n = 0;
  for (const r of results.filter((x) => x.verdict === "closed")) {
    const line = `[${today}] Archived: posting closed (${r.reason}).`;
    await updateOpportunity(r.row.id, { archived: true, notes: r.row.notes ? `${r.row.notes}\n\n${line}` : line });
    n++;
  }
  return n;
}
