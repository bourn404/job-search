---
name: tailor
description: Build a tailored resume + cover letter for one job_opportunities row and attach both PDFs to it in the database (sets pending_approval). Use when Carson runs /tailor <opportunityId>, or asks to "make materials" / "tailor" for a role he marked interested.
argument-hint: "[opportunityId] [--auto]"
---

# /tailor: tailored resume + cover letter for one opportunity

Target opportunity: `$ARGUMENTS`

Gather the data yourself: the opportunity, the JD, and the candidate pools are all reachable from the id,
so never ask Carson for anything stored in this repo or the database. But Carson **wants** to be asked
questions that would make the materials better (step 3). He's available while you work. Run all CLI
commands as `npx tsx src/cli.ts ...` from the repo root (not `npm run`, whose prelude pollutes JSON on
stdout).

**`--auto` in the arguments means auto mode** (used by `/autopilot`, usually inside a subagent): Carson is
*not* available. Follow every step below, with the substitutions in **"Auto mode"** at the end of this
file. Read that section before starting.

## 1. Resolve the opportunity

- **No id given:** run `tailor list`. If exactly one row, use it. If several, show them and ask which.
  If none, say the interested queue is empty and stop.
- **Id given:** run `tailor context <id> > <scratchpad>/context-<id>.json` (it's large; save it, then read it).
- **Check `postingLive` first.** The context asks the ATS whether the posting is still open (Greenhouse /
  Lever answer 404 for a closed job; a closed Ashby job drops off the board). If `live: false`, stop and tell
  Carson before any research or drafting. If `live: null` (Workday, Eightfold, other links), open
  `application_url` (WebFetch, or Playwright if it's blocked) and confirm it's still accepting applications.
- Check `opportunity.status`:
  - `interested`: proceed.
  - `pending_approval` / `approved` / `applied`: materials already exist. Ask before regenerating (attach
    overwrites the files and resets status to `pending_approval`).
  - anything else (`new`, `skipped`, ...): proceed, but mention it in your final summary.
- If `opportunity.description` is empty, fetch the posting from `application_url` (WebFetch) so you're
  working from the real JD. Never tailor from the title alone.

## 2. Read the inputs (every time; they change)

- The JD (`opportunity.description`), start to finish. Note the must-haves, the hooks worth leading
  with, stated tech, seniority, and anything specific about the company/team.
- `config/positioning.md`: who Carson is, what to lead with, and the **truth guardrails** (obey them).
- `config/voice-style-guide.md`: cover-letter voice. Also skim the real letters in `examples/`.
- The pools in the context JSON: `experiences[]` (each with `alt_titles` and its `bullets[]`: `id`, `text`,
  `themes`, `target_role_types`) and `skills[]` (by category, with `proficiency` 1 to 5).

**Past specs are references, not templates.** Every spec Carson approved and applied with (from
2026-09-29 on) is a worked example of his taste: how bullets were reworded for a JD, how skills lines were
grouped, and the final cover letters. `specs/feedback/<spec>.json` (gitignored, local) records his actual
edits and notes, before and after, which is the clearest signal of what he changes. Skim 2 or 3 recent
ones that fit the role (the voice guide's "Reference letters" section lists them). Don't use
`example*.json`, `generic-*.json`, `anthropic-design-engineer.json` (June 2026, predates the bullet review),
or `netflix-senior-software-engineer-design-systems.json` (too narrow, he said). Build bullets from the
current pool text and variants, not from old spec text.

**Reuse approved letter paragraphs, across companies and within one.** When a past approved letter already
tells the story this role needs (e.g. the Pinterest growth paragraph for another growth role), start from
Carson's approved wording and adapt it lightly; he worked hard on those lines and wants the same things
highlighted for similar jobs. Write fresh only what must be company-specific: the why-this-company
paragraph, its company fact, and any callback close. This holds for a second letter to the **same** company
too: if the earlier story still fits the new role, reuse it (see `priorLetters` below).
When you reuse a paragraph, re-check every claim in it against the **current** pool text and credit: later
corrections win over the old letter (e.g. "founding member" became "founding engineer" in the pool after the
Reddit Ads Creative letter was approved), and the voice guide's newer rules apply to old wording too.

## 3. Ask Carson (one round, before writing)

Once you've read the JD against the pools, ask Carson the questions whose answers would most improve
the materials. Ask them together in one round (AskUserQuestion for choices, plain questions for open
answers), usually 2 to 5. Good questions:
- **Gaps:** the JD asks for X and the pool doesn't show it. Has he done X? Where, with what result?
- **Angle:** when the JD supports more than one pitch (e.g. design systems vs. AI product), which to lead with.
- **Why this company:** what genuinely draws him to it, any connection to its product or people. The cover
  letter depends on a real answer here; don't invent one.
- **Unverified specifics:** a detail or metric you'd like to use that the pool only hints at.

Don't ask what the data already answers, and don't ask for approval of routine choices. If his answers
surface a new, true accomplishment, add it to `resume_bullets` (see Hard rules) so future tailoring can
use it too. If something comes up mid-draft that only he can answer, ask then rather than guessing.

## 4. Write the spec

Path: `specs/<company>-<role>.json`, kebab-case (e.g. `specs/anthropic-design-engineer-web.json`).
If that file exists for a different opportunity, add a disambiguator.

Shape (`SelectionSpec` in `src/types.ts`):

```jsonc
{
  "kind": "both",
  "headline": "Sr. Software Engineer | <1 to 2 focus areas>",
  "experiences": [                          // newest first; include every experience in the pool
    {
      "experienceIds": ["<job_experiences.id>"],  // >1 id merges stints at one employer
      "titleOverride": "<one of that experience's alt_titles, or omit for default_title>",
      "bullets": [ { "sourceId": "<resume_bullets.id>", "text": "<tailored text>" } ],
      "dateGranularity": "year"             // optional; for older roles
    }
  ],
  "skills": [ { "label": "Frontend", "items": "React, TypeScript, ..." } ],   // 3 to 4 lines
  "coverLetter": {
    "greeting": "Dear <name or company-wide greeting>,",
    "body": ["<paragraph>", "<paragraph>", "<paragraph>"],
    "signoff": "Thank you for your time & consideration,"
  }
}
```

### Bullets: select first, then adjust wording up to Level 4

Selection (which bullets, what order, which title) does most of the work. Then adjust wording:

| Level | What it allows | |
|---|---|---|
| L1 | Verbatim | ok |
| L2 | Swap/add a keyword, shift emphasis | ok |
| L3 | Reframe and reorder to foreground the JD-relevant angle | ok |
| L4 | Restructure the sentence to lead with the JD's hook, rephrasing freely | ok (the ceiling) |
| L5 | Mirror the JD so heavily the real domain/specifics drop out or go generic; any puffery | **never** |

Worked example (pool bullet, JD stressing cross-functional leadership):
- **L1:** Drove a company-critical accessibility initiative across 6 teams, closing 480 WCAG 2.1 issues and delivering SchoolAI's first VPAT, which unlocked major higher-ed and statewide deals.
- **L4 (fine):** Led cross-functional execution across 6 teams to close 480 WCAG 2.1 accessibility issues, shipping SchoolAI's first VPAT and unblocking major higher-ed and statewide deals.
- **L5 (never):** Spearheaded cross-functional quality initiatives at scale, driving measurable business impact and accelerating revenue growth.

Test: if the bullet could sit on anyone's resume, it's L5. L4 keeps every fact (domain, numbers, named
outcome) attached to the same accomplishment.

**JD hook pass (required, after selecting bullets).** Pool text verbatim is rarely the best version; don't
stop at selection and order. Before the first render:
1. List the JD's 5 to 8 key phrases: what it says the work is and what it values, in its words (e.g.
   "performant, beautiful, and usable interfaces", "scale the code base", "turn product ideas into
   engineering solutions", "mentor").
2. Map each phrase to the bullet that answers it. A phrase with no bullet is a gap (ask, or leave it).
3. Reword those bullets at L3/L4 so they lead with the JD's concern (the outcome it cares about) and keep
   every fact: "Kept streaming AI chat fast and responsive, cutting re-renders over 85% by..." rather than
   "Cut re-renders over 85%..." for a role that stresses performant UX.
4. **Every bullet says why it mattered**, not just what was built: a metric, who it served, or what it
   made possible ("…generates Figma components straight from production code, so designers and engineers
   always work from the same implementation"). A bullet that only names the artifact reads as a task.
5. Show Carson the before/after for anything beyond light L2 changes, and flag any wording that leans on a
   fact the pool only implies.
Bullets that already answer the JD in their pool wording can stay as they are.

**Start from approved variants.** Each pool bullet in the context carries `variants` (wordings Carson
already approved: `one_line`, `short`, or `angle` with an angle tag like "growth" or "design-systems")
and a `credit` level. Prefer a fitting variant over rewording fresh: a `one_line` variant when the page is
tight, an `angle` variant when its angle matches the JD. Match verbs to `credit`: "Led/Drove" only for
`led`, hands-on verbs for `built`, "Helped/Contributed to" for `contributed`. If `credit` is empty and the
verb matters, ask.

Hard rules:
- Every bullet's `sourceId` must be a real bullet id **from that same experience** in the context JSON.
- Never change the core truth, inflate scope, or move a metric to a different accomplishment (see the
  truth guardrails in `config/positioning.md`).
- If the JD needs something the pool doesn't cover, **don't invent it.** Ask Carson (step 3); if it's true,
  add it with `npx tsx src/cli.ts bullets apply --json <f>` (`addBullets` entry with `experience`,
  `credit`, and `"reviewed": false`), re-run `tailor context`, then use it.
- Lead with concrete doing verbs (Developed, Built, Led, Drove, Architected); vary openers. Reserve "Own"
  for genuine program/process ownership, not code/UI he built.
- No filler adjectives (robust, seamless, world-class), no "responsible for", no parenthetical asides.
- Don't name internal tools a reader won't know (e.g. Sentinel) outside the one bullet that introduces them.
- Current role: present tense for ongoing responsibilities, past tense for completed achievements.
- Older / less relevant roles: `bullets: []` (one-liner) and `dateGranularity: "year"`, unless the page
  has room (step 5).

**Lead SchoolAI with metrics.** The first 3 SchoolAI bullets are the metric-bearing ones that fit the JD
best: 7% activation and doubled adoption from experimentation, 80% fewer accessibility violations in new
PRs, 85% fewer re-renders while chat streams, 480 WCAG issues and the first VPAT. Then the JD-specific
bullets. (He reordered five résumés this way and asked for it outright on Atlassian, 2026-10.)

**Stay well-rounded.** After the metric bullets, lead with the bullets the JD cares about most, but don't dig so deep into its one
theme (e.g. design systems) that Carson reads as narrow. Every résumé also shows:
- **~2 standout SchoolAI bullets outside the JD's theme** that show end-to-end features and ownership, e.g.
  the real-time AI analysis layer over 17k+ daily student chats, the founding-growth-team activation result,
  the 6-team VPAT initiative, or RAG chat memory. Pick the ones closest to the role.
- **Canyons School District (Web Manager) with 1 to 2 bullets**, not a one-liner. Pair the page-load rebuild
  with the permissions/LDAP bullet by default (Carson picked it over the Vue migration for Amazon and Ramp,
  2026-10); use the ColdFusion to Vue.js migration only when a JD names Vue or legacy modernization. Use the news publishing dashboard only for content/publishing-tool roles; it
  used to win by default and Carson wants to lean away from it.
- Team-lead bullets for SchoolAI and Lucid when the role values leadership.

**Marketing, Marcom, and e-commerce web roles:** lead Lucid with its marketing-site work (headless CMS
site, Core Web Vitals tooling, caching and static generation, immersive campaign experiences, the Lucidspark
SEO redesign) and list "Headless CMS" in Key Skills.

### Titles and headline
- `titleOverride`: pick the `alt_titles` entry that best matches the JD's framing. Only use listed titles.
  SchoolAI keeps "Sr. Fullstack Engineer" at its core (e.g. "Sr. Fullstack Engineer, Design Systems &
  Accessibility Lead" for DS/a11y roles). Keep title adjusting light: older roles (Canyons, BYU-Idaho) keep
  their default titles, so omit `titleOverride` for them. One exception: BYU-Idaho's department was
  literally "Marcom", so "Web Analytics Integration Engineer, Marcom" is fine for marketing-communications roles.
- `headline`: exactly `Sr. Software Engineer | <1 to 2 focus areas>`, where the focus areas are real areas
  of his work named plainly (e.g. "Design Systems & Accessibility"). No invented flourishes ("AI-Accelerated
  Workflows"), and never "Staff" or another level he hasn't held.

### Key Skills
Map skills to the description, don't just sort the pool:
1. List what the JD actually asks for (required tech, "experience with…" lines, named practices such as
   "client-side instrumentation" or "AI solutions for design workflows").
2. For each, find the pool skills that genuinely back it. Skip requirements the pool can't support; never
   add a skill he doesn't have.
3. Group into 3 to 4 lines, required tech first. `items` come from the `skills` pool only; `label` may
   combine categories when that reads better (e.g. "Design Systems & Accessibility", "APIs, Tooling &
   Instrumentation"). Each line should fit on one line.
- **Don't repeat the label as an item** (e.g. "Design Systems" under a "Design Systems & A11y" label reads
  oddly); list the concrete tools and practices instead.
- **Never list:** "Component libraries" (that's what a design system is), "Design tokens", "Figma" (he
  doesn't do Figma design work; "Figma Code Connect" is fine).
- **Niche skills** (see `config/positioning.md`): include ONLY if the JD explicitly calls them out.
- **Check skills against the company's values, not just the JD.** Drop tools that clash with what the
  company stands for (e.g. Google Tag Manager or PostHog for a privacy company like DuckDuckGo).

### Cover letter
Follow `config/voice-style-guide.md` exactly (hard rules, opener, structure, checklist): a conviction or
real motivation, one story from his work told in depth, why this company in plain words, a short close.
3 to 4 short paragraphs, about 200 to 300 words. No em dashes, colons, or quotation marks.

Before drafting:
- **Research the company first: write or reuse its brief** at `research/companies/<company>.md` (template
  in `research/companies/README.md`; reuse it if it exists and is under ~3 months old, adding a section for
  this team). Use WebSearch / WebFetch to capture, **each with a source link**: mission; stated values and
  culture (culture memo, values page, operating principles); engineering and design values and practices
  (eng/design blog, talks, their design system, open source); team context; and the **1 to 2 genuine
  overlaps** between their values and Carson's real convictions and work. Only verified facts; if nothing
  honestly overlaps, say so rather than forcing it. The overlaps drive the letter's conviction and
  why-this-company paragraph. Commit the brief with the spec.
- **Check `priorLetters` (earlier letters to this company).** When Carson has already written to this
  company, start from that letter: its premise, opener, story, greeting, and sign-off. If its story still
  applies to the new role, reuse it and adapt lightly (he doesn't mind the same recruiters seeing it, 2026-11-03);
  write a new story only where the old one doesn't fit the role. Show him what you reused.
- **Offer "why this company" approaches.** In step 3, give Carson 3 to 4 angles grounded in what he cares
  about (each with a sample opening line) and let him pick or combine. Don't invent his reasons.
- **Use one real fact from the brief** beyond the JD (a product decision, what the team owns, a value
  paraphrased), stated plainly: no quotes, no "[Company] has said". Prefer recent facts; skip old blog posts.
- **Workshop the opener with Carson before writing the letter.** Offer 3 to 4 conviction-led openers built
  from his signature ideas and the company overlap, plus at most one light-humor option (see the voice
  guide's opener section). He picks, edits, or asks for new directions; only then draft the full letter.
- **Pick the story from the role type** (voice guide, "Default story by role type") and propose it in
  step 3 along with the approved letter you'd start from, so Carson doesn't have to ask which story fits.
- **Greeting:** a named person only if found with confidence (never guess); otherwise `Dear <Company> Team,`
  (a one-word team at a huge company); never a full department name, never "Dear Hiring Team,". With the
  openers, also offer one company-flavored greeting and one sign-off (voice guide, "Greeting and sign-off").

While drafting: tell **one** story in depth rather than listing accomplishments; if the JD centers
leadership, show him leading; make the first two lines sell him alone; reuse his approved paragraphs
from similar roles where they fit, but never another company's name, facts, or why-them reasons. Before
rendering, run the voice guide's checklist.

Working with Carson on the letter:
- It's collaborative and often goes a section at a time; offer a few options when he's choosing, and when
  he writes his own line, polish it lightly rather than replacing it.
- Iterate in chat, then **render and attach once** after he approves (each attach uploads new files).
- In company research, note each source's date and prefer recent ones; search listings can misdate pages,
  so confirm the date on the page itself.

### Everywhere
**No em dashes (—)** in any generated text (bullets, headline, skills, cover letter), and **no colons in
cover-letter prose** and no quotation marks there (see the voice guide).

## 5. Render, check, and fill the page

```sh
grep -n '—' specs/<file>.json    # must print nothing
npx tsx src/cli.ts render --spec specs/<file>.json
```

`both` always writes `out/resume.pdf` and `out/cover-letter.pdf` (overwriting prior renders). The output
includes a **fill + layout report** for the resume (also written to `build/layout.json`, with each item's
line count, last line, and how full that line is). Iterate until it says **"nicely filled"** on one page
with **no layout issues**, and the **lint** line (`↳ lint`, from `src/lint.ts`) is clean or every remaining
warning is one you'd defend to Carson (e.g. an opener callback that repeats a phrase on purpose):
- "runs onto 2 pages, about N lines over": it lists the `✂` trim candidates (bullets whose last line is
  nearly empty, so a few words saves a whole line). Prefer a `one_line` variant, else trim those.
- "room for ~N more lines": add a bullet (thin/one-liner roles first) or use a longer variant.
- `⚠ … ends on a near-empty line`: reword so the last line isn't one or two words (shorten or lengthen).
- `⚠ Skills "…" wraps`: drop or swap an item so each skills line fits on one row.

**Voice pass (required, before showing Carson anything):** follow `.claude/skills/voice-pass/SKILL.md` on
the spec. It reviews every new or reworded letter sentence for AI-writing patterns and rewrites the offenders.
Re-render after it.

Then **read both PDFs** (Read tool) and check them like a hiring manager would: nothing cut off, the top
third of the resume sells this JD, the cover letter reads like Carson.

## 5b. Carson's feedback (when he reviews and asks for changes)

**The spec editor** is the main way to iterate. After the first render, start it in the background
(it opens Carson's browser itself) and give him the link it prints:

```sh
pkill -f "cli.ts edit --spec specs/<file>.json"     # stop a stale editor for this same spec, if any
npx tsx src/cli.ts edit --spec specs/<file>.json    # http://localhost:4322, or the next free port
```

If 4322 is busy (another spec's editor), it moves up to the next free port, so read the URL from its
output rather than assuming 4322.

He edits lines inline, reorders or removes bullets, leaves a note on any line plus an optional general
note, previews the PDFs, and clicks **Save for Claude**. That writes his edits straight into the spec and
his requests to `specs/feedback/<file>.json` (gitignored). When he says the notes are in:
1. Read the feedback file: `general`, `notes` (keyed by line, each with `label`, the line's `text`, and his
   `note`), and `edits` (what he changed directly: `edited` with before/after, `removed`, `reordered`).
   His edits are already in the spec; keep them unless a note says otherwise, and treat them as signals
   (e.g. a cut phrase he may want gone everywhere).
2. Update the spec for each note (same rules as step 4), then render and check the fill.
3. Write back to the feedback file: a short `reply` on each note you handled (what you changed, or the
   question you need answered), a one-to-three-sentence `summary`, `"status": "addressed"`, and
   `addressedAt`. Leave `round` and his notes alone. The page reloads with your replies under his notes.
4. Reply in chat briefly too. Attach only once he approves the final version (step 6).

- **Ask when feedback is ambiguous.** If a request could mean two things (e.g. "fix the headline"), ask
  which he means before changing anything. One quick question beats another render-and-attach round.
- **Save approved wordings back to the pool.** At attach time, every bullet whose text differs from the
  pool becomes an approved **variant**: add them with `bullets apply` (`addVariants`: `id`, `text`, `kind`
  `one_line` / `short` / `angle` + `angle`, `source` = the spec path). When Carson rewrites a bullet's core
  wording (not just for this JD), offer `updateBullets` instead so the main text changes (the old text is
  kept in `notes`). Record any credit he clarifies with `setCredit`.

## 6. Attach

Attach only after Carson's final review in the spec editor (he saves with no new notes, or says it's
approved). Render once more first so `out/` holds the approved version.

```sh
npx tsx src/cli.ts render --spec specs/<file>.json
npx tsx src/cli.ts tailor attach <id> --resume out/resume.pdf --cover out/cover-letter.pdf \
  --spec specs/<file>.json --export "<Company> - <Team or role>" --plaintext --combined
```

Uploads both PDFs to the database (Directus files, or data/files/ on SQLite), attaches them to the opportunity, records the spec filename, and sets
status `pending_approval`. `--export` also copies them to `~/resumes/<Company> - <Team>/` as
`Carson Fairbourn - Resume.pdf` and `Carson Fairbourn - Cover Letter - <Company>.pdf`, the folder
Carson submits from. It also gets bookmarks to the posting (`Apply - <Company>.webloc`) and, on the Directus backend, the record (`Directus - <Company>.webloc`). Name it the way the existing folders are named: company, then the team or
role's short name (e.g. `Reddit - Ads Creative`, `Netflix - TV UI`, `Beast Industries - Full Stack`).
- `--plaintext` (use by default) writes `experience-plaintext.txt` there: the bullets grouped
  "Title | Company", for application forms that ask for pasted experience.
- `--combined` also writes `Carson Fairbourn - Resume & Cover Letter - <Company>.pdf` (résumé first, cover
  letter on page 2), for applications that take a single upload. Use it by default (he has asked for it on Ramp, ClickUp, Podium, and ElevenLabs).

Then save the approved wordings as variants (step 5b).

**Reviewing an auto-draft.** When Carson reviews a row `/autopilot` drafted (`auto_drafted`, spec has
`autoNotes`), go through 5b as usual. Once he approves, delete `autoNotes` from the spec, render to the
default `out/`, and attach **without** `--auto` (that clears `auto_drafted`). Then save the variants. His
edits on auto-drafts are the best input for the next `/retro`.

Then stop the editor (`pkill -f "cli.ts edit --spec specs/<file>.json"`) and commit the spec and any
brief (`git add specs/<file>.json research/companies/<company>.md` + a short commit).

**Never submit an application.** Carson reviews and submits.

## 7. Report back (short)

- Company, role, and the opportunity id; status is now `pending_approval`.
- The angle you led with, and 2 to 3 of the biggest tailoring choices (e.g. which title, what went first).
- Any gap: a JD must-have the pool couldn't support, a bullet you added, a status that wasn't `interested`.
- Spec path.

## Auto mode (`--auto`)

Same procedure and same quality bar. Carson reviews the result later in the spec editor, so every choice
you'd normally ask him about becomes a recorded assumption. Substitutions:

- **Step 1.** `postingLive.live === false` → stop and report `closed`. `null` → check `application_url`
  (WebFetch); if it's clearly closed, stop and report `closed`. If the status isn't `interested`, stop and
  report it (never regenerate attached materials in auto mode).
- **Step 2.** Also read `opportunity.materials_assessment` from the context. `/assess` wrote it, and it names
  the reference spec, the story, and the gaps it found.
- **Step 3 (questions).** Don't ask. For each question you would have asked, decide from the data and record
  `"<question>: assumed <answer>, because <evidence>"` in the spec's `autoNotes` array (top level of the spec
  JSON). Gaps: leave them uncovered and note them; never add bullets to the pool. Angle: pick the one the
  JD's title and first responsibilities lead with. Why-this-company: only reasons grounded in the brief and
  his stated convictions (positioning's mission thread, reasons he gave for similar companies). Note which.
- **Opener and story.** Take the story from the voice guide's "Default story by role type" table. Start from
  the approved paragraphs of its reference spec (a same-company letter first, if its story fits). Pick the
  opener yourself: reuse the reference letter's opener premise when it fits, else write one conviction-led
  opener from his signature ideas. No humor unless the reference letter's humor transfers. Greeting
  `Dear <Company> Team,` and the default sign-off unless an earlier letter to this company has an approved
  flavored pair. Record the opener choice in `autoNotes`.
- **Truth is stricter, not looser.** No unverified specifics, no metric the pool doesn't have, credit verbs
  exactly per `credit`. When unsure, use the plainer claim and note it.
- **Step 5 (render).** Render with `--out-dir <spec-slug>` (the spec filename without `.json`). Parallel
  drafts share the repo, so never use the default `out/`. Iterate until "nicely filled", no layout issues,
  and **zero lint warnings** (the one allowed exception is a phrase repeated on purpose for a callback; note
  it). Read both PDFs.
- **Voice pass.** Required in auto mode too; record its changes in `autoNotes` as the voice-pass skill says.
- **Step 5b (editor).** Skip it. Don't start the editor.
- **Step 6 (attach).**
  `tailor attach <id> --resume out/<slug>/resume.pdf --cover out/<slug>/cover-letter.pdf --spec specs/<file>.json --export "<Company> - <Team>" --plaintext --combined --auto`.
  `--auto` sets `auto_drafted` and adds a review note. **Don't** save variants (wordings aren't approved
  until Carson reviews). **Don't** commit (the orchestrator commits all drafts together).
- **Step 7 (report).** Return exactly this JSON as your final message, nothing else:

```json
{ "id": "<opportunityId>", "status": "attached | closed | skipped | error",
  "spec": "specs/<file>.json", "brief": "research/companies/<company>.md", "export": "<Company> - <Team>",
  "angle": "<one line>", "story": "<table row + reference spec>",
  "fill": "<fill summary>", "lint": "clean | <remaining warnings>",
  "autoNotes": 0, "gaps": ["<JD must-have the pool couldn't support>"], "error": null }
```

