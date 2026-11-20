# job-search

A job-hunting system run from [Claude Code](https://claude.com/claude-code). It polls the careers pages
of companies you care about, has Claude triage and score what it finds against your criteria, and builds
a tailored one-page résumé and cover letter for each role you pick. It renders them as PDFs that come out
byte-identical every time. You review everything and submit applications yourself; nothing is ever
auto-submitted.

**The design rule:** deterministic code does the mechanical work (polling job boards, deduping, scoring
rules, rendering PDFs, linting prose), and Claude makes the judgment calls (is this job a fit, which
bullets to use, what the letter says). The repo's skills (`.claude/skills/`) tell Claude how to drive the
code.

> **Borrowing this from Carson?** Everything personal (his criteria, his voice guide, his résumé, his
> research and past applications) is left in place as a worked example. [Make it yours](#make-it-yours)
> lists the files to replace. The skills say "Carson" throughout; Claude reads that as "the user," so you
> can leave it or find-and-replace your own name.

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Make it yours](#make-it-yours)
- [Your data (SQLite)](#your-data-sqlite)
- [The workflow](#the-workflow): watchlist → discover → triage → review → tailor → submit
- [Changing the résumé template](#changing-the-résumé-template)
- [Reference](#reference): commands, job boards, cleanup rules, the render report and lint
- [Repo layout](#repo-layout)

## How it works

| Layer | Who | What |
|------|-----|------|
| 1. Discovery | code | Poll the `job_sites` watchlist through per-ATS adapters (Greenhouse, Lever, Ashby, Workday, …) → new rows in `job_opportunities` with status `triage` |
| 2. Triage | Claude (`/triage`) | Read each job description, skip it (`ai_skipped`) or keep and score it (`new`) |
| 3. Review | you (`cli review`) | Keyboard UI: mark roles `interested` or skip them |
| 4. Tailoring | Claude (`/tailor`) | For an `interested` role: choose bullets, write the letter → a JSON **selection spec** |
| 5. Render | code | Spec + your bullet pool → Typst → PDFs, plus a page-fill report and a prose lint |
| 6. Apply | you | Edit in `cli edit`, export to a folder, submit by hand |

The **selection spec** (`specs/*.json`) is the boundary between Claude and the code. Every bullet in it
cites a `sourceId` from your bullet pool, so nothing on a résumé is invented. Specs are committed, which
gives you a record of exactly what you sent each company.

Status flow on `job_opportunities.status`:

```
triage ──(Claude)──► ai_skipped
   └────(Claude)──► new ──(you)──► skipped
                       └──(you)──► interested ──(/tailor)──► pending_approval ──► approved ──► applied / rejected
```

`archived` is a separate flag that hides a row from every queue without losing its history. Discovery
still dedupes against archived rows, so they never come back.

## Quick start

**You need:**
- **Node 22.13 or newer** (for the built-in `node:sqlite`). `nvm use` picks it up from `.nvmrc`.
- **[Typst](https://typst.app)** (tested with 0.14): `brew install typst`
- **Arial**, which macOS ships with. On Linux, install `ttf-mscorefonts` or swap the font (see
  [templates](#changing-the-résumé-template)).
- **[Claude Code](https://claude.com/claude-code)** for the triage and tailoring skills.
- Optional: `qpdf` (combined résumé + letter PDFs; macOS falls back to a built-in tool) and the Playwright
  MCP (for `/interested` on job pages that need a browser).

```sh
npm install
cp .env.example .env                                            # add your email + phone
npx tsx src/cli.ts db status                                    # creates data/job-search.db and shows row counts
npx tsx src/cli.ts db import --json examples/seed.example.json  # load the fictional sample person
npx tsx src/cli.ts render --model specs/example.model.json      # render a résumé with no database at all
open out/resume.pdf
```

Use `npx tsx src/cli.ts <command>` rather than `npm run cli -- <command>` when you'll pipe the output:
npm prints a header that breaks JSON. Every command is listed in the [reference](#commands).

## Make it yours

| What | File | Notes |
|------|------|-------|
| Name, education, links, default skills, default headline | `config/profile.ts` | Static résumé identity; a spec can override headline and skills per job |
| Email and phone | `.env` (`PROFILE_EMAIL`, `PROFILE_PHONE`) | Kept out of git; `config/profile.ts` reads them at render time |
| Work history, bullets, skills, watchlist | the database | Write a seed file; see [Your data](#your-data-sqlite) |
| What jobs you want (triage rules) | `config/job-criteria.md` | Read by `/triage`. Role focus, level, location, comp floor, deal-breakers, dream companies |
| How to present you (tailoring rules) | `config/positioning.md` | Read by `/tailor`. Your angle, truth guardrails, what to emphasize |
| Your writing voice | `config/voice-style-guide.md` | Cover letter tone, banned phrases, openers |
| Lint word lists | `config/voice-lint.ts` | Banned phrases, letter length, and the headline shape (Carson's `HEADLINE` regex requires `Sr. Software Engineer \| …`; change it to match yours) |
| Stock application answers | `config/stock-answers.md` | Not included; `/answers` creates it the first time you approve an answer, then starts from it |
| Title keywords and exclusions | `config/discovery.ts` | Which titles discovery keeps (`TITLE_KEYWORDS`), drops (`HARD_EXCLUDE`, `SOFT_EXCLUDE`), and description deal-breakers (`DESCRIPTION_EXCLUDE`) |
| Priority bonus rules | `config/priority.ts` | Location, remote, salary, and tech-keyword points that sort the review queue |
| Résumé and cover letter look | `templates/*.typ` | See [Changing the résumé template](#changing-the-résumé-template) |

Carson's outputs (a few specs in `specs/` and their company briefs in `research/companies/`) are good references for
what finished work looks like. Delete them whenever you like; new runs just add files beside them.

`/retro` reads your Claude Code transcripts for this repo and suggests edits to these files when you keep
correcting the same thing, so they get better the more you use them.

## Your data (SQLite)

All data goes through `src/db/index.ts`, which picks a backend for each call:

- **SQLite (default):** a local file at `data/job-search.db` (gitignored). It's created on first use from
  [`src/db/schema.sql`](src/db/schema.sql), which documents every column.
- **Directus:** a hosted alternative with an admin UI (Carson's setup). Used automatically when
  `DIRECTUS_URL` and `DIRECTUS_TOKEN` are set in `.env`. Force either one with `DB_BACKEND=sqlite|directus`.

Both backends expose the same functions, so every command and skill works the same on either.

**Tables**

| Table | Holds | Who writes it |
|-------|-------|---------------|
| `job_experiences` | One row per job you've held: company, location, `default_title`, truthful `alt_titles`, dates, `sort` (1 = newest) | you (seed) |
| `resume_bullets` | The bullet pool: `bullet_point`, `experience` (FK), `themes`, `credit` (`led` / `built` / `contributed`), `notes` (context for Claude, never rendered), `variants` (approved alternate wordings) | you (seed), `/bullet-gaps`, `/tailor` |
| `resume_skills` | The skill pool: `category`, `name`, `proficiency` 1–5 | you (seed), `/bullet-gaps` |
| `job_sites` | The watchlist: `name`, `provider`, `provider_config`, `title_filter`, `scrape_enabled` | you (seed) |
| `job_opportunities` | The pipeline: every role found, its description, status, AI score and reasoning, `match_bonus`, attached files | discovery, triage, review, tailor |
| `files` | Attached PDFs (copied to `data/files/`) | `tailor attach` |

**Loading your résumé content.** Copy `examples/seed.example.json` to `data/seed.json` (gitignored),
replace the sample person with your history, and import it:

```sh
npx tsx src/cli.ts db import --json data/seed.json
```

Import is an upsert by `id`, so edit the file and re-run it as often as you like. Experiences and bullets
need an explicit `id` (any unique string such as `"exp-acme"`); bullets point at their experience by that
id, and specs cite bullets by theirs. Skills and sites get stable ids from their names when you leave
`id` off. `themes` can be an array or a comma-separated string.

Tips for the bullet pool:
- Write more bullets than fit on a page (Carson's pool has ~45 for four jobs). Tailoring picks the best
  4–6 per role for each job description.
- Set `credit` honestly. It decides the verb: "Led", "Built", or "Helped build".
- Put the backstory in `notes` (numbers, scope, what you actually did). Claude reads it when rewording; it
  never appears on the page.
- `/bullet-gaps` compares the jobs you've marked `interested` against your pool, asks you about what's
  missing, and writes the bullets you approve.

**Looking at and editing data.** Ask Claude, use any SQLite browser (e.g. [DB Browser for
SQLite](https://sqlitebrowser.org), TablePlus), or run SQL from the CLI:

```sh
npx tsx src/cli.ts db sql "select company, job_title, status from job_opportunities where status = 'interested'"
npx tsx src/cli.ts db sql "update job_opportunities set status = 'applied', applied_at = date('now') where id = '<id>'"
```

## The workflow

A normal week: add companies to the watchlist once, then run discover → `/triage` → `cli review` every
few days, and `/tailor` the roles you mark interested.

### 1. Build your watchlist

Each `job_sites` row is one company's job board. Add them to your seed file (or with `db sql`):

```json
{ "id": "site-figma", "name": "Figma", "provider": "Greenhouse", "provider_config": { "board_token": "figma" } }
```

To find the provider and its config, open a job posting from the company's careers page and look at the
URL:

| Posting URL looks like | `provider` | `provider_config` |
|---|---|---|
| `job-boards.greenhouse.io/figma/jobs/…` | `Greenhouse` | `{ "board_token": "figma" }` |
| `jobs.lever.co/netlify/…` | `Lever` | `{ "site": "netlify" }` |
| `jobs.ashbyhq.com/linear/…` | `Ashby` | `{ "org": "linear" }` |
| `adobe.wd5.myworkdayjobs.com/external_experienced/…` | `Workday` | `{ "tenant": "adobe", "site": "external_experienced", "dc": "wd5" }` |
| `…/careers/job/<id>` (Netflix, Microsoft) | `Eightfold` | `{ "host": "explore.jobs.netflix.net", "domain": "netflix.com" }` |

There are adapters for many more (Amazon, Apple, Google, SmartRecruiters, Workable, Rippling, iCIMS,
Oracle HCM, sitemaps, RemoteOK, …); see [Supported job boards](#supported-job-boards). Or paste the
careers URL to Claude and ask it to add the site; `CLAUDE.md` gives it the full config for each provider.

Useful options: `title_filter: "strict"` for huge boards (the title must name your area, not just
"Software Engineer"), `provider_config.keywords` to replace the title keyword list for one site, and
`scrape_enabled: false` to pause a site.

### 2. Discover

```sh
npx tsx src/cli.ts discover --site Figma --dry-run   # preview one site, no writes
npx tsx src/cli.ts discover --site Figma             # write new openings for one site
npx tsx src/cli.ts discover                          # every enabled site that's due
npx tsx src/cli.ts discover --all                    # every enabled site, due or not
```

Discovery fetches each board, keeps titles that match `config/discovery.ts`, drops postings older than 90
days and ones already in the database, fills in descriptions and pay where the board needs a second
request, and saves the survivors as `triage`. It then runs **cleanup**: it archives postings that have
closed, auto-skips deal-breakers, and recomputes `match_bonus`.

Discovery writes everything before any AI runs, so the `triage` queue is a durable work list. If triage
stops halfway, the next run picks up what's left.

### 3. Triage (Claude)

In Claude Code:

```
/triage            # the whole queue
/triage Figma      # one company
```

Claude reads each description against `config/job-criteria.md`. A skip gets a reason and no score; a keep
gets a 0–100 score, a one-line summary, and its reasoning. Decisions are applied in batches through
`cli triage --apply`, so an interruption loses nothing.

### 4. Review (you)

```sh
npx tsx src/cli.ts review     # http://localhost:4321
```

A keyboard UI for everything Claude kept, best first (AI score + 3 × match bonus), with Claude's
summary and reasoning beside the description. Rows Claude hasn't triaged come after.

| Key | Action |
|-----|--------|
| ↑ | `interested`: make me materials |
| → | keep as `new` (decide later) |
| ↓ | skip for now |
| ← | archive (`skipped` and hidden) |
| Z | undo · O open the posting · J/K scroll · T back to top |

**Found a job somewhere else?** Give Claude the link: `/interested <url>`. It pulls the posting through
the ATS API when it can (otherwise it reads the page, with a browser if needed) and adds it as
`interested`.

### 5. Tailor (Claude + you)

```
/tailor                # pick from the interested queue
/tailor <opportunityId>
```

For one role, Claude:

1. Checks the posting is still open, then researches the company (saved to `research/companies/`).
2. Asks you a short round of questions: anything the bullet pool doesn't cover, the angle, why this
   company.
3. Writes a selection spec under `specs/`: headline, skills, which experiences and bullets (reworded to
   fit, each still citing its `sourceId`), and the cover letter.
4. Renders it, reads the page-fill report, and adjusts until the résumé fills exactly one page. It runs
   `/voice-pass` on the letter to rewrite anything that sounds machine-written.
5. Attaches the PDFs to the opportunity and sets it to `pending_approval`.

Then iterate in the **spec editor**:

```sh
npx tsx src/cli.ts edit --spec specs/<file>.json
```

Edit any line inline (headline, skills, titles, bullets, letter), reorder or drop bullets, render a
preview, and leave a note on any line. **Save for Claude** (⌘S) writes your edits and notes to
`specs/feedback/`. Tell Claude to address them; it replies under each note and re-renders, and the open
page reloads.

### 6. Submit (you)

When you're happy, have Claude attach and export the final version (or run it yourself):

```sh
npx tsx src/cli.ts tailor attach <id> --resume out/resume.pdf --cover out/cover-letter.pdf \
  --spec specs/<file>.json --export "Figma - Design Systems" --plaintext
```

This copies the PDFs to `~/resumes/Figma - Design Systems/` (change the root with `RESUMES_DIR`) with a
bookmark to the posting. `--plaintext` adds text versions of your bullets and letter for application forms
that want pasted text, and `--combined` adds a single PDF with the résumé on page 1 and the letter on page
2.

`/answers <id>` drafts the form's free-text questions ("Why this company?") in your voice from the spec,
letter, and company research.

Submit the application yourself, then mark it `applied` (ask Claude, or use `db sql` as shown above).

### Optional extras

- **`/assess` and `/autopilot [threshold]`**: `/assess` scores how confidently Claude could draft each
  interested role without asking you anything. `/autopilot` then drafts every role above the threshold
  (default 70) in parallel. It records each question it would have asked, and the assumption it made, in
  the spec's `autoNotes`, and the spec editor shows them at the top. Review each draft before submitting.
- **`/bullet-gaps`**: find what your interested roles ask for that your bullet pool doesn't cover.
- **`/retro`**: mine past conversations and spec-editor notes for corrections you keep making, and propose
  changes to the config and skills so you stop having to make them.

## Changing the résumé template

Rendering is three steps:

```
selection spec (specs/x.json)
   └─ src/select.ts ── looks up bullets/experiences in the DB, adds config/profile.ts ──► RenderModel
        └─ src/render.ts ── writes build/data.json, runs `typst compile` ──► out/resume.pdf
             └─ templates/resume.typ  #let resume(data) = { ... }   reads data.json
```

The template only ever sees the **RenderModel** (`src/types.ts`):

```ts
{ name, headline, contact: { email, phone, links[] },
  skills: [{ label, items }],
  experiences: [{ title, company, location, dateRanges[], bullets[] }],
  education: [{ school, degree }],
  coverLetter?: { greeting, body[], signoff } }
```

To iterate on design without a database or Claude, render a saved model directly. Copy
`specs/example.model.json`, put your content in it, and re-run while you edit the template:

```sh
npx tsx src/cli.ts render --model specs/example.model.json            # → out/resume.pdf
npx tsx src/cli.ts render --model specs/example-cover.model.json      # → out/cover-letter.pdf
```

**Where things live**

| Change | Edit |
|--------|------|
| Font, text and rule colors | `templates/lib.typ`: `FONT`, `INK`, `MUTED`, `COMPANY`, `RULE` |
| Body size, line spacing | `templates/lib.typ`: `setup(size:, leading:)` defaults |
| Paper size, margins | `templates/resume.typ`: the `setup(paper: "us-letter", margin: …)` call (use `"a4"` for A4) |
| Name / headline / contact header | `templates/lib.typ`: `masthead` (shared with the cover letter) |
| Section headings and their rules | `templates/lib.typ`: `section` |
| Bullet marker and spacing | `templates/lib.typ`: `bullets` |
| Section order, adding or removing a section | `templates/resume.typ`: the body of `resume(data)` (Key Skills → Experience → Education) |
| Experience header line (title, company, dates) | `templates/resume.typ`: the `grid(...)` inside the experience loop |
| Cover letter layout | `templates/cover-letter.typ` |
| Education, contact, default skills (content) | `config/profile.ts` |

**Adding a new field** (say, a Projects section): add it to `RenderModel` in `src/types.ts`, fill it in
`buildModel` in `src/select.ts` (from `config/profile.ts` for static content, or from the spec), then
render it in `templates/resume.typ`.

**Replacing the template entirely:** write your own `templates/resume.typ` that exports
`#let resume(data) = { ... }` and reads the same fields. `src/render.ts` calls the function by name
(`TEMPLATE` maps document kinds to file and function).

**Things to keep working:**
- **The layout probes.** `line-probe`, `line-stats`, and the final `fill-probe` in `resume.typ` are
  invisible metadata that power the page-fill report (lines over or under one page, bullets ending on
  a one-word line). `/tailor` relies on that report to fit exactly one page. If you restructure, keep
  calling them around each skills line and bullet, and keep `fill-probe` at the end. If you remove them,
  rendering still works but the report goes blank.
- **Determinism.** Keep `set document(date: none)` in `setup`, so the same model renders byte-identical
  PDFs (check with `shasum out/resume.pdf`).
- **Fonts on Linux.** If Arial isn't installed, Typst silently falls back to another font. Change `FONT`
  to something you have, or use Arimo (metrically identical to Arial, open license).

The headline and skills shape rules in the lint (`config/voice-lint.ts`) are Carson's taste, not the
template's. Loosen them if your headline is different.

## Reference

### Commands

```sh
npx tsx src/cli.ts <command>   # or: npm run cli -- <command>
```

| Command | What it does |
|---------|--------------|
| `db status` | Create the SQLite file if needed; show row counts |
| `db import --json <seed.json>` | Upsert experiences, bullets, skills, sites, opportunities |
| `db sql "<statement>"` | Run SQL against the local database; prints rows as JSON |
| `discover [--site <name>] [--all] [--dry-run] [--no-filter] [--max-age <days>] [--no-cleanup]` | Poll the watchlist; real runs end with cleanup |
| `triage [--apply <decisions.json>]` | Print the triage queue as JSON, or apply decisions |
| `review [--port 4321]` | Keyboard review UI |
| `intake fetch <url>` / `intake add --json <f> [--force]` | One-off job from a link (behind `/interested`) |
| `tailor list` / `context <id>` / `attach <id> …` | Interested queue; everything `/tailor` needs; attach + export PDFs |
| `render --spec <f.json> \| --model <f.json> [--out <p>] [--out-dir <slug>]` | Render PDFs + fill report + lint |
| `edit --spec <f.json> [--port 4322] [--no-open]` | Spec editor |
| `bullets context [--out <f>]` / `apply --json <f> [--dry-run]` | Bullet-gap context; write approved bullets (behind `/bullet-gaps`) |
| `assess list [--rescore]` / `apply --json <f> [--dry-run]` | Materials confidence (behind `/assess`) |
| `cleanup [--dry-run]` | check-open → dealbreakers → bonus |
| `check-open [--host <substr>] [--dry-run]` | Archive rows whose posting has closed |
| `dealbreakers [--dry-run]` | Skip + archive `triage`/`new` rows hitting title exclusions or description deal-breakers |
| `bonus [--dry-run]` | Recompute `match_bonus` |
| `salaries [--include-archived] [--dry-run]` | Fill empty salaries from pay text in descriptions |
| `enrich --site <name> \| --provider <name> [--include-archived] [--dry-run]` | Backfill descriptions / pay / dates by refetching postings |
| `retro digest --out <f.md> [--all] [--since <date>]` / `retro mark` | Behind `/retro` |

`decisions.json` for `triage --apply`:
`{ "decisions": [ { "id", "decision": "skip", "chainOfThought" } | { "id", "decision": "keep", "matchPercentage", "chainOfThought", "summary"?, "remote"?, "notes"? } ] }`

### Claude Code skills

| Skill | Use |
|-------|-----|
| `/triage [company]` | Vet and score the triage queue |
| `/interested <url>` | Add a job from a link straight to `interested` |
| `/tailor [id]` | Tailored résumé + cover letter for one role |
| `/voice-pass <spec>` | Rewrite AI-sounding sentences in a letter (runs inside `/tailor`) |
| `/answers [id]` | Draft application-form answers |
| `/bullet-gaps` | Find and fill gaps in the bullet pool |
| `/assess [--rescore]` | Score how well Claude could draft each interested role alone |
| `/autopilot [threshold]` | Draft every role above the confidence threshold in parallel |
| `/retro` | Turn repeated corrections into config and skill changes |

### Environment (`.env`)

| Variable | Default | Meaning |
|----------|---------|---------|
| `DB_BACKEND` | auto | `sqlite` or `directus`; auto = directus when both Directus vars are set |
| `SQLITE_PATH` | `data/job-search.db` | SQLite file (relative to the repo root) |
| `DIRECTUS_URL`, `DIRECTUS_TOKEN` | – | Only for the Directus backend |
| `PROFILE_EMAIL`, `PROFILE_PHONE` | placeholders | Contact details on the résumé and letter |
| `RESUMES_DIR` | `~/resumes` | Where `tailor attach --export` copies final PDFs |

### Supported job boards

Adapters in `src/discovery/adapters.ts`: Greenhouse, Lever, Ashby (official no-auth JSON; Ashby falls back
to its GraphQL API when the public one is off), Workday (CXS endpoint, with per-job detail fetch),
Eightfold, Amazon, Apple, Google. In `src/discovery/ats-more.ts`: SmartRecruiters, Workable, Rippling ATS,
iCIMS career sites, Oracle Cloud HCM, Atlassian's listings feed, Shopify's careers page, RemoteOK,
a11yjobs.com, and career-site sitemaps (JSON-LD or SuccessFactors pages). `CLAUDE.md` documents each
provider's `provider_config`. Boards that only work in a browser (LinkedIn, Meta, Uber, Tesla, …) have no
adapter; add their jobs one at a time with `/interested`.

Large boards can be narrowed server-side: Workday and Eightfold take `searchText` (string or array),
`maxResults`, and Workday `appliedFacets`; `countries` drops postings from other countries after the detail
fetch; `detail: "jsonld"` reads each posting page's schema.org `JobPosting` for pay, location, and date.

### Filters and cleanup rules

- **Title filter** (`config/discovery.ts`): a broad include list, then whole-word exclusions.
  `HARD_EXCLUDE` (backend, hardware) always drops a title; `SOFT_EXCLUDE` (infra, data/ML, mobile,
  security, QA, …) drops it unless the title also says frontend.
- **Age:** postings older than 90 days are dropped.
- **Pay from descriptions** (`src/discovery/salary.ts`): when a board gives no salary, discovery parses
  pay-transparency text ("$150,000 - $200,000", "$150K–$200K", "USD 129,300 - 223,600", …), taking the
  widest span across locations or levels and skipping hourly, OTE/commission, and non-USD. It never
  overwrites a salary.
- **Description deal-breakers:** `DESCRIPTION_EXCLUDE` terms (whole word, so "Java" never matches
  "JavaScript"). A mention inside a list of languages ("Java, Python, Go, or TypeScript") is ignored as
  boilerplate. Matches are saved as `ai_skipped` + archived so they dedupe and never surface.
- **Closed postings** (`src/liveness.ts`): Greenhouse and Ashby rows must still be on the board; Lever,
  Workday, Eightfold, and Amazon 404 when closed; Apple and Google have their own checks. Closed rows are
  archived with a dated note. Anything throttled or unrecognized comes back `unknown` and is left alone.
- **`match_bonus`** (`config/priority.ts`): Carson's defaults are +1 Utah, +1 WCAG in the description, +1
  `salary_min` above $175k, +2 listed under 5 days ago (+1 under 7), +2 remote / +1 hybrid, +1 design system,
  +1 React, +1 TypeScript, +1 Next.js, +1 LLM / agentic. Recomputed from scratch each time, so freshness
  points decay.

### Render report and lint

Rendering a résumé prints a **fill report**: how many lines the page is over or under, bullets that end on
a near-empty last line, skills lines that wrap, and, when over, the cheapest bullets to trim. It also
writes `build/layout.json`.

Every render also runs a **voice/spec lint** (`src/lint.ts`, word lists in `config/voice-lint.ts`): em
dashes; colons, quotes and "&" in letter prose; banned phrases from the voice guide; headline shape; skills
that should never be listed; letter length (190–320 words); sentences over 40 words; a 4-word phrase used
twice; generic greetings; time-sensitive company claims ("recently launched"); and common AI-writing
patterns. `/voice-pass` is the judgment half that rewrites what the lint flags.

### Tailoring details

`tailor context <id>` prints what `/tailor` needs: the opportunity, the bullet and skill pools (each
bullet with its `credit` and approved `variants`), whether the posting is still open, and earlier letters
to the same company. Specs can merge several stints at one employer (`experienceIds: [a, b]`), render an
old role as a compact one-liner (`bullets: []`), and show year-only dates (`dateGranularity: "year"`).

## Repo layout

```
.claude/skills/     the Claude Code skills (triage, tailor, interested, …)
CLAUDE.md           operating guide Claude reads every session
config/             your preferences: profile, criteria, positioning, voice, discovery + priority rules
src/
  cli.ts            command entry point
  db/               index.ts (backend switch) · sqlite.ts · schema.sql · directus.ts
  discovery/        ATS adapters, salary parsing, discover loop
  select.ts         spec + DB → RenderModel
  render.ts         RenderModel → Typst → PDF, fill report
  lint.ts           voice/spec lint
  review/ editor/   local web UIs (cli review, cli edit)
  tailor.ts triage.ts intake.ts bullets.ts assess.ts liveness.ts priority.ts …
templates/          lib.typ · resume.typ · cover-letter.typ
specs/              selection specs (one per application) + example render models
research/           company briefs (/tailor) and retro reports (/retro)
examples/           seed.example.json (put reference PDFs of your own here; *.pdf is gitignored)
data/               SQLite database + attached files (gitignored)
build/ out/         render scratch + PDFs (gitignored)
```
