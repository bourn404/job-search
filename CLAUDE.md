# CLAUDE.md — operating guide for the AI

This repo is a **job-application system for Carson Fairbourn**. The design principle: **deterministic
tooling does the mechanical work; the AI ("spine") makes the judgment calls.** Your job is to drive the
tooling, not to reimplement it.

Read `config/job-criteria.md` before any triage or scoring (the source of truth for what jobs Carson
wants) and `config/positioning.md` before any tailoring (how to present him). Read `README.md` for full command/flag details.

## Architecture (5 layers)

| Layer | Who | What |
|------|-----|------|
| 1. Discovery | deterministic | Poll the `job_sites` watchlist via ATS adapters → write candidates to `job_opportunities` as `status: triage` |
| 2. Triage | **AI (you)** | Read each `triage` role + its JD, decide skip/keep, score keepers |
| 3. Tailoring | **AI (you)** | For an `interested` role: author a tailored selection spec → render → attach PDFs to the opportunity → `pending_approval` |
| 4. Render | deterministic | Pinned Typst → byte-identical PDFs |
| 5. Apply | human-gated | Playwright pre-fills; Carson reviews & submits. NEVER auto-submit. *(planned)* |

**Resilience invariant:** discovery persists candidates BEFORE any AI runs, so the `triage` queue is the
durable, resumable work-list. Discovery and triage are separate commands on purpose.

## Commands

```sh
npm run cli -- db       status | import --json <seed.json> | sql "<statement>"   # local SQLite store (see Data store)
npm run cli -- render   --spec <f.json> | --model <f.json> [--out <p>] [--out-dir <slug>]   # resume/cover letter + fill report + voice lint
npm run cli -- discover [--site <name>] [--all] [--dry-run] [--no-filter] [--max-age <days>] [--no-cleanup]
npm run cli -- triage   [--apply <decisions.json>]
npm run cli -- tailor   list | context <id> | attach <id> --resume <pdf> [--cover <pdf>] [--spec <path>] [--export "<Company - Team>"] [--plaintext] [--combined] [--auto]
npm run cli -- assess   list [--rescore] | apply --json <f> [--dry-run]   # /assess surface (materials_confidence)
npm run cli -- intake   fetch <url> | add --json <file> [--force]   # one-off job from a link
npm run cli -- bullets  context [--out <f>] | apply --json <f> [--dry-run]   # /bullet-gaps surface
npm run cli -- bonus    [--dry-run]              # recompute match_bonus (runs after every real discover)
npm run cli -- check-open [--host <substr>] [--dry-run]   # archive rows whose posting has closed
npm run cleanup                                  # check-open → dealbreakers → bonus (auto-runs after every real discover)
npm run cli -- salaries [--include-archived] [--dry-run]   # fill empty salary from pay text in the JD (then bonus)
npm run cli -- dealbreakers [--dry-run]          # ai_skip + archive triage/new rows hitting title exclusions or DESCRIPTION_EXCLUDE
npm run cli -- retro    digest --out <f.md> [--all] [--since <date>] | mark   # /retro surface (conversations + editor feedback)
npm run cli -- review   [--port 4321]            # Carson's keyboard triage UI (localhost)
npm run cli -- edit     --spec <f.json> [--port 4322] [--no-open]   # Carson edits + annotates a spec; notes → specs/feedback/
npm run cli -- enrich   --site <name> | --provider <name> [--include-archived] [--dry-run]   # backfill via detail fetch
```
Run with `npx tsx src/cli.ts <cmd>` to avoid the npm prelude polluting JSON stdout.

## Triage and tailoring: use the project skills

The step-by-step procedures live in project skills, loaded on demand:

- **`/triage [company]`** (`.claude/skills/triage/SKILL.md`): vet + score the `triage` queue, apply in batches.
- **`/interested <url>`** (`.claude/skills/interested/SKILL.md`): add a job Carson found from its link,
  straight to `interested` (ATS API when supported, else WebFetch / Playwright).
- **`/bullet-gaps`** (`.claude/skills/bullet-gaps/SKILL.md`): compare the `interested` (not archived) JDs
  against the bullet + skill pools, ask Carson about gaps, draft truthful bullets, write approved ones.
- **`/tailor [opportunityId]`** (`.claude/skills/tailor/SKILL.md`): build a tailored resume + cover letter
  for one opportunity, render to one full page, attach both PDFs, set `pending_approval`.
- **`/assess [--rescore]`** (`.claude/skills/assess/SKILL.md`): score each `interested` role 0–100 on
  whether materials can be drafted without Carson (`materials_confidence` + `materials_assessment`).
- **`/autopilot [threshold]`** (`.claude/skills/autopilot/SKILL.md`): for roles at or above the threshold
  (default 70), one subagent per role runs `/tailor <id> --auto` (no questions; assumptions recorded in the
  spec's `autoNotes`), attaches with `--auto` (`auto_drafted: true`), then the main session verifies and
  commits. Carson reviews each draft in `cli edit` before submitting.
- **`/voice-pass <spec>`** (`.claude/skills/voice-pass/SKILL.md`): review a letter's new and reworded
  sentences for AI-writing patterns and rewrite them; `/tailor` runs it before every final render.
- **`/answers [opportunityId]`** (`.claude/skills/answers/SKILL.md`): draft application-form answers in his
  voice from the role's spec, letter, and brief, starting from `config/stock-answers.md`.
- **`/retro`** (`.claude/skills/retro/SKILL.md`): the self-improvement loop. Digest new conversations and
  spec-editor feedback (`cli retro digest`), find corrections Carson had to make, propose harness changes,
  apply the approved ones, `cli retro mark`. Reports live in `research/retro/`.

When Carson asks for either task in plain words, invoke the matching skill. Triage criteria live in
`config/job-criteria.md`; résumé positioning + truth guardrails in `config/positioning.md`; cover-letter
voice in `config/voice-style-guide.md`.

## Status taxonomy (`job_opportunities.status`)

`triage` (just discovered) → AI sets `ai_skipped` (no score) or `new` (vetted + scored) → Carson sets
`interested` (= "make me materials") or `skipped` → tailor generates + attaches materials and sets
`pending_approval` → Carson sets `approved` (ready to submit) → `applied` / `rejected`. `auto_drafted`
(boolean) marks `pending_approval` rows whose materials `/autopilot` drafted without him; attaching again
without `--auto` (after his review) clears it.

`match_bonus` (integer) is a deterministic priority score (rules in `config/priority.ts`), recomputed from
scratch for all non-archived rows at the end of every non-dry-run `discover`: +1 Utah location, +1 WCAG in
the JD, +1 `salary_min` above $175k, +2 listed less than 5 days ago (+1 if 5 to 7 days), +2 remote / +1 hybrid, +1 design system,
+1 React (capital R, not React Native), +1 TypeScript, +1 Next.js, +1 LLM / agentic (LLMs, agentic, AI agents,
MCP, evals). Max 12. Plain "AI" is deliberately not a rule: it's in ~65% of JDs.

`cli review` serves a local page (src/review/) for Carson's human review of un-archived `triage` and `new`
rows. AI-kept `new` rows come first, ranked by AI score + 3 × match_bonus, with the AI score, summary, and
reasoning shown on the left; untriaged rows follow by match_bonus. Keys: ← archive (`skipped` + archived), → `new`, ↑ `interested`, ↓ skip, Z undo. The description
auto-scrolls to its first list line or "qualifications" (T jumps back to the top).

`cli edit` serves a local page (src/editor/) where Carson edits a tailored spec inline and leaves notes per
line; saving writes the spec plus `specs/feedback/<spec>.json`, which you read, address (replies + status
`addressed`), and re-render. See `/tailor` step 5b.

`cli check-open` (src/liveness.ts) checks every non-archived row's posting per provider (Greenhouse/Ashby
board membership; Lever/Workday/Eightfold/Amazon 404s; Apple jobDetails; Google's 'ds:0' block) and
archives the closed ones, appending a dated reason to `notes`. Throttled or unrecognized checks come back
`unknown` and are never archived.

`archived` (boolean) is separate from status: it hides a row from the work queues (`triage`, `tailor list`)
without erasing its status history. Discovery still dedupes against archived rows, so they never resurface.

## Adding a watchlist company (discovery)

`job_sites` rows drive discovery. Set `provider` (matched by substring, so "Custom (Greenhouse backend)"
→ greenhouse) and `provider_config`:
- Greenhouse: `{ "board_token": "anthropic" }`. Salaries come from Greenhouse pay transparency
  (`pay_input_ranges`; USD only, widest span, no hourly/OTE) when the board publishes them.
- Lever: `{ "site": "..." }`
- Ashby: `{ "org": "openai" }`. If the org has the public posting API turned off (404, e.g. EvenUp), the
  adapter falls back to the GraphQL API behind jobs.ashbyhq.com pages (one detail call per posting).
- Workday: `{ "tenant": "...", "site": "...", "dc": "wd1" }`
- Eightfold (career sites with `/careers/job/<id>` URLs, e.g. Netflix, Applied Materials):
  `{ "host": "explore.jobs.netflix.net", "domain": "netflix.com" }` (`domain` defaults to the host's last two
  labels; PCSX-generation sites need it right). Supports `searchText` / `maxResults` like Workday plus
  `location` (e.g. `"United States"`); only title-matched jobs get a detail fetch, and it backs off on 429/403
  (Microsoft's WAF answers bursts with intermittent 403s).
- **`title_filter`** (a `job_sites` column, dropdown): `standard` (default) or `strict`. Strict drops the
  generic `software engineer` keyword so a title must name the area ("Software Engineer - Frontend" passes,
  plain "Staff, Software Engineer" doesn't). Use it for huge boards (Walmart).
- Amazon (`provider: "Amazon"`): `{ "categories": ["software-development"], "countries": ["USA"] }`, optional
  `searchText` / `maxResults`. amazon.jobs' public search JSON includes descriptions (no detail fetch).
- Apple (`provider: "Apple"`): `{ "locations": ["postLocation-USA"], "teams": ["teamsAndSubTeams-SFTWR", ...] }`.
  Uses a CSRF token + session cookie; survivors get a detail fetch (summary, responsibilities, quals, pay).
- Google (`provider: "Google"`): `{ "location": "United States", "searchText": [...] }`. Parses the job data
  embedded in google.com/about/careers pages (AF_initDataCallback 'ds:1', positional arrays); a layout change
  surfaces as an error. Search is fuzzy, so pair it with `title_filter: strict`.
- More providers (src/discovery/ats-more.ts), set `provider` to the name in bold:
  - **SmartRecruiters**: `{ "company": "Canva" }` (the id in jobs.smartrecruiters.com/<company>/…).
  - **Workable**: `{ "account": "huggingface" }`.
  - **Rippling ATS**: `{ "board": "rippling" }` (ats.rippling.com/<board>/jobs; dates come from the detail call).
  - **iCIMS** career sites with a `/careers-home/jobs` page (GitHub, Rivian): `{ "host": "www.github.careers" }`,
    optional `searchText` / `maxResults`.
  - **Oracle Cloud HCM** (Ford, Oracle): `{ "host": "eeho.fa.us2.oraclecloud.com", "siteNumber": "CX_45001",
    "searchText": [...] }` (find both in the CandidateExperience URL).
  - **Atlassian** (its listings feed) and **Shopify** (decodes the Remix payload on shopify.com/careers): no config.
  - **Sitemap** (career sites with no API that publish a job sitemap: Intuit, Etsy, Carnival via JSON-LD;
    Paramount, McDonald's via SuccessFactors microdata): `{ "sitemap": "https://jobs.intuit.com/sitemap.xml",
    "jobPattern": "^/job/" }` (regex on the URL path). The pre-filter title is guessed from the URL slug; each
    survivor's page then supplies the real title, date, location, pay, description. Pair with `countries`; for
    SuccessFactors sites whose non-US pages lack a location, restrict `jobPattern` to US state-zip URLs
    (`^/job/[^/]*-[A-Z]{2}-[0-9]{5}/`).
  - Job boards: **RemoteOK** (no config; company comes from each job) and **a11yjobs** (pair with
    `provider_config.keywords`, since accessibility titles don't match the default keywords).
- Eightfold `delayMs` (default 500) slows paging for WAF-guarded hosts (Microsoft uses 1500); a throttled search
  term keeps what earlier terms found instead of failing the site.
- Browser-only boards (Uber, Meta, Tesla, LinkedIn, Wellfound, Best Buy, EA, IBM): no adapter; each disabled row
  says why in `notes`. Add individual jobs via `/interested` (Playwright fallback).
- Optional `{ "keywords": [...] }` in `provider_config` overrides the include list entirely (beats `title_filter`). The exclusion list in
  `config/discovery.ts` (backend/hardware always; infra/data/ML/mobile/security/QA unless the title is
  clearly frontend) applies regardless. Carson never wants backend-titled roles.
- **Workday server-side narrowing (for huge multinational boards):** add to its `provider_config`
  `"searchText"` (a string or array of strings — runs one search per term, deduped), `"appliedFacets"`
  (a Workday facet object, e.g. `{"locationCountry":["<facet-id>"]}` — facet ids are instance-specific;
  grab them from the board's CXS response), and/or `"maxResults"` (fetch cap, default 400). The adapter
  paginates (20/page); Workday reports `total` only on page 1. Descriptions and real posting dates come
  from a per-job detail fetch that `discover` runs only for postings surviving the title filter + dedupe.
- **`detail: "jsonld"`** (any provider): after the title filter, fetch each posting's own page and read its
  schema.org `JobPosting` (salary, locations, remote, date, country) to fill gaps. Stripe uses it: its
  Greenhouse API has no pay or detailed locations, but stripe.com's pages do.
- **`countries`** (any provider whose postings report a country; today Workday via the detail fetch):
  `"countries": ["United States of America"]` drops postings from other countries after the detail fetch
  (unknown country passes). Use it on Workday boards that have no country facet.
**Pay from descriptions:** when a provider gives no salary, discovery parses the description's
pay-transparency text (`src/discovery/salary.ts`: USD annual ranges, widest span across locations/levels;
skips hourly, OTE/commission/sign-on, non-USD). It only fills empty fields; `cli salaries` backfills.

**Description deal-breakers:** `DESCRIPTION_EXCLUDE` in `config/discovery.ts` (today: "Java", whole word, so
never "JavaScript"). A mention only counts when it stands alone; one within ~50 chars of another language
("languages like Java, Scala, Python, Go, Node.js, JavaScript and TypeScript", "Java or Kotlin") is list
boilerplate and is ignored (Capital One's standard quals hid dozens of frontend roles before this). Discovery saves matching postings as `ai_skipped` + archived (so they dedupe, never
surface), and `cli dealbreakers` applies it (plus the title exclusions, e.g. "designer") to existing `triage`/`new` rows.
Then `discover --site <name>`. The broad keyword filter + 90-day recency filter trim the firehose before
you triage. 90 days (not 30) so evergreen postings on boards like Ashby/WorkOS still surface; Carson doesn't
want anything older (diminishing returns), so don't widen `--max-age` past that, even for a new site.

## Data store (SQLite or Directus)

All code reads and writes through `src/db/index.ts`, which routes each call to one of two backends with
identical functions: **SQLite** (`src/db/sqlite.ts`, file `data/job-search.db`, schema in
`src/db/schema.sql`) or **Directus** (`src/db/directus.ts`). `DB_BACKEND=sqlite|directus` forces one;
unset, it's Directus when `DIRECTUS_URL` + `DIRECTUS_TOKEN` are in `.env`, else SQLite. Check which with
`npx tsx src/cli.ts db status`. Carson's own checkout uses Directus; a fresh clone uses SQLite.

- **Prefer the CLI commands** (`triage --apply`, `intake add`, `bullets apply`, `assess apply`, `tailor
  attach`, …) for every write: they validate and work on both backends.
- **Ad-hoc reads/writes on SQLite:** `npx tsx src/cli.ts db sql "<statement>"` (prints rows as JSON). Seed or
  bulk-edit résumé content and the watchlist with `db import --json <file>` (upsert by id; format in
  `examples/seed.example.json`).
- **Ad-hoc on Directus:** REST at `DIRECTUS_URL` with `DIRECTUS_TOKEN`, or the `directus` MCP.
- Tables/collections: `job_sites` (watchlist), `job_opportunities` (pipeline), `job_experiences` +
  `resume_bullets` (résumé content; each bullet has `credit` led/built/contributed and `variants`, approved
  alternate wordings that `/tailor` reuses), `resume_skills`, and `files` (SQLite only; attached PDFs live
  in `data/files/`). `job-criteria.md` / `positioning.md` live in repo (`config/`), not the database.
- **Schema changes go in both places:** add the column to `src/db/schema.sql` (plus an `ALTER TABLE` for
  existing SQLite files, since `CREATE TABLE IF NOT EXISTS` won't add it) and to the Directus collection.
  JSON columns are listed in `JSON_COLS` and booleans in `BOOL_COLS` in `src/db/sqlite.ts`.

Directus gotchas:
- **New `resume_bullets` and `job_sites` rows REQUIRE an explicit `id`** (UUID) — generate one
  (`crypto.randomUUID()`); `job_experiences`/`job_opportunities` auto-generate. (SQLite generates any missing id.)
- **Updating a field's schema/display:** the `directus` MCP `fields` *update* action rejects the payload —
  use REST `PATCH /fields/<collection>/<field>` with the token instead. (Create works via MCP.)

## Determinism (render layer)

- `render --out-dir <slug>` writes to `build/<slug>/` and `out/<slug>/` instead of the shared `build/` and
  `out/`, so parallel renders (autopilot subagents) don't collide; output is byte-identical either way.
- Every render also runs the voice/spec lint (`src/lint.ts`, lists in `config/voice-lint.ts`): em dashes,
  colons/quotes in letters, banned phrases, headline shape, never-list skills, letter length, repeats,
  time-sensitive company claims. The prose rules and their reasons stay in `config/voice-style-guide.md`.

- Pinned Typst + Arial. `set document(date: none)` → re-rendering the same model is byte-identical
  (verify with `shasum`). Resume = US Letter; templates in `templates/`. The selection spec is the only
  non-deterministic input.

## Working norms

- Commit on `main`; never auto-submit applications.
- After schema/preference changes, update the relevant doc (`README.md`, `config/*.md`, the skills, this file).
- Keep deterministic where data is structured; use AI judgment where data is messy or evaluative.
