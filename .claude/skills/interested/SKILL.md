---
name: interested
description: Add a job listing Carson found himself to the database as an `interested` opportunity, from just a link. Pulls the posting via the ATS API when supported, otherwise reads the page (WebFetch, then a Playwright browser). Use when Carson runs /interested <url> or shares a job link he wants to pursue.
argument-hint: "<job-listing-url>"
---

# /interested: add a job from a link

Link: `$ARGUMENTS`

Carson found this job and wants to pursue it, so it goes straight to `interested` (skipping triage).
Your job is to get the **real, complete job description** and clean metadata into the database with as
little of his time as possible. Run CLI commands as `npx tsx src/cli.ts ...` from the repo root.

If no link was given, ask for one and stop.

## 1. Try the deterministic fetch

```sh
npx tsx src/cli.ts intake fetch "<url>" > <scratchpad>/intake.json
```

It recognizes Greenhouse, Lever, Ashby, Workday, and Eightfold (`<host>/careers/job/<id>`) links. For a
company careers page it also tries to resolve the ATS behind it automatically: an embedded ATS link on the
page (e.g. a Greenhouse `embed/job_app?for=<board>&token=<id>` form), or, for watchlist Workday companies
on the same domain, a board search for a requisition id in the URL (`.../jr-202618717/...`). When that
happens the result includes `resolvedFrom`. It returns:
- `supported: true` with a normalized `posting` (title, company, location, remote, listingDate,
  salaryMin/Max, description, canonical `url`), or
- `supported: false` with a `reason`, or an error if the API call failed (closed posting, bad link).

Either way it also returns `existing`: rows already in the database for this URL (archived included).

## 2. If it isn't supported, pull the data manually

Only when step 1 didn't produce a posting. Go in this order and stop at the first that gives you the
full description:

1. **Look for an underlying ATS link** that step 1's automatic page scan missed (e.g. it only appears
   after JavaScript runs, or the page lists many jobs so the right one was ambiguous). If you find one (an "Apply" button to `boards.greenhouse.io/...`, `jobs.lever.co/...`,
   `jobs.ashbyhq.com/...`, `*.myworkdayjobs.com/...`), re-run step 1 with that link. It gives cleaner
   data and the canonical URL discovery uses.
2. **Look for the site's own JSON API.** Many career sites render from a JSON endpoint: check the page
   source or `<script>` tags for `/api/...` paths, or try the vendor's known pattern with `curl`. Prefer it
   over scraping HTML: it's structured and complete. Run HTML descriptions through `htmlToText` from
   `src/discovery/adapters.ts` (e.g. a small `npx tsx` script) so entities and markup are cleaned the
   same way discovery does it. If you find a new vendor pattern, mention it in your report: it may be
   worth adding to `intake fetch`.
3. **WebFetch the page** and extract the fields below.
4. **Playwright browser** (the `mcp__playwright__*` tools) when WebFetch comes back without the
   description: JS-rendered boards, bot walls, "enable JavaScript" pages. Navigate to the link, wait for
   the content, and pull the text (`browser_snapshot`, or `browser_evaluate` returning
   `document.body.innerText`). Expand "show more" sections if the description is collapsed. Close the
   browser when done.
5. If it needs a login (LinkedIn and similar) or is still blocked: **never log in or enter credentials.**
   Ask Carson for the original posting link or to paste the description.

Fields to extract: `title`, `company` (the employer, not the job board), `location`, `remote`
(`fully_remote` | `hybrid` | `on_site`, or null if unclear), `listingDate` (YYYY-MM-DD if shown),
salary, and `description`: the **full JD as plain text, verbatim** (responsibilities, requirements,
nice-to-haves, comp/benefits blurb). Don't summarize it; `/tailor` reads it. Drop page chrome
(nav, cookie banners, "similar jobs"). Keep it under ~12,000 characters.

## 3. Handle duplicates

If `existing` has a row:
- `interested`, or earlier statuses (`triage`, `new`, `ai_skipped`, `skipped`), archived or not:
  `intake add` will revive it (set `interested`, unarchive, fill in the fields you provide). Proceed.
- `pending_approval`, `approved`, `applied`, `rejected`: it's already in flight. Tell Carson where it
  stands and only proceed with `--force` if he says to reset it.

## 4. Clean up and assess

- **Company:** when the fetch used a board slug (`openai`, `boxinc`), replace it with the real name.
- **Salary:** if `salaryMin` is null but the description states a base range, extract it (annual base,
  USD integers). Don't guess when none is stated.
- **Remote:** fix it if the description contradicts the inferred value.
- **Quick fit read** against `config/job-criteria.md`: write `chainOfThought` (2 to 4 sentences: fit
  with his focus areas, company, location, comp) and a `matchPercentage` on the same bands triage uses.
  If you spot a dealbreaker, still add it (he chose it) but call it out in your report.
- Optional `summary`: one line on what the role is.

## 5. Write it

Write `<scratchpad>/intake-add.json` and run `npx tsx src/cli.ts intake add --json <that file>`:

```jsonc
{
  "url": "<canonical listing URL: posting.url from step 1, else the page URL minus tracking params>",
  "aliases": ["<the link Carson pasted, if different>"],
  "title": "...", "company": "...", "location": "...", "remote": "fully_remote",
  "listingDate": "2026-09-01", "salaryMin": 185000, "salaryMax": 240000,
  "description": "<full JD text>",
  "matchPercentage": 82, "chainOfThought": "...", "summary": "..."
}
```

It prints whether it **created** a new row or **revived** an existing one, and the opportunity id.

## 6. Report back (short)

- Company, role, id, and whether it was new or revived (and from what status).
- How you got the data (ATS API, WebFetch, or browser), and anything you couldn't get (salary, date).
- Your fit read: score, one line why, and any dealbreaker or concern.
- Next step: `/tailor <id>` to build the resume and cover letter.
