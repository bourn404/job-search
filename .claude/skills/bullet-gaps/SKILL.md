---
name: bullet-gaps
description: Compare what Carson's `interested` job descriptions ask for against his résumé bullet and skill pools, find what's missing or weakly covered, ask him about it, draft truthful bullets, and write the approved ones to the database. Use when Carson runs /bullet-gaps or asks for a gap analysis of his bullets.
---

# /bullet-gaps: find and fill gaps in the bullet pool

The bullet pool (`resume_bullets`) was built from Carson's own history. This skill checks it against what
the roles he actually wants are asking for, so experience he has but never wrote down gets captured. The
job listings decide **which true experiences are worth a bullet**; they never decide what to claim.

Run CLI commands as `npx tsx src/cli.ts ...` from the repo root.

## 1. Gather

```sh
npx tsx src/cli.ts bullets context --out <scratchpad>/gaps-context.json
```

Scope is every `job_opportunities` row with status `interested` that isn't archived. The file holds each
role's full `description`, every experience with its bullets (`id`, `text`, `themes`, `targetRoleTypes`,
`reviewed`), the skills pool by category, and the existing tag `vocabulary`. If the scope is empty, say
so and stop (Carson marks roles `interested`, or adds them with `/interested <url>`).

Also read `config/positioning.md` (who Carson is + **truth guardrails**).

## 2. Analyze

Read every description in full. For each role, pull out its requirements: must-haves, nice-to-haves, and
the themes it keeps returning to (e.g. "design tokens", "Figma-to-code", "mentoring", "WCAG", "AI-assisted
workflows", "web components"). Normalize near-duplicates into one requirement.

Then classify each requirement against the pools:
- **Covered**: a bullet (or skill) clearly shows it, in words a recruiter or ATS would recognize. Note which.
- **Weak**: the experience is there but the wording hides it (e.g. the bullet says "theming" and every JD
  says "design tokens"), or it's buried in a bullet about something else. Candidate for rewording.
- **Missing**: nothing in the pools shows it. Carson may or may not have done it; only he knows.
- **Skill only**: belongs in `resume_skills`, not a bullet (a tool or technology rather than an outcome).

Rank by how many of the roles ask for it, and how central it is to each (must-have > nice-to-have).

## 3. Report, then ask

Show Carson a short coverage report: a table of requirements (how many roles mention it, which roles,
status, and the covering bullet if any). Keep **Covered** brief; the point is the gaps.

Then ask about the top gaps, **2 to 5 at a time** (AskUserQuestion for yes/no or choices, plain questions
for details). For each **Missing** item: has he done it, where (which experience), what exactly, and any
real result or number. For **Weak** items: confirm the underlying fact so the rewording stays true. Don't
ask about things the pools already answer, and don't lead him toward a yes.

Only what Carson confirms becomes a bullet. "No, I haven't" is a fine answer: note it as a genuine gap
(something to learn or avoid pitching) and move on.

## 4. Draft

For each confirmed item, draft **2 to 3 wording options** and let Carson pick or edit. Write pool bullets
at the **neutral, untailored level** (what `/tailor` treats as L1): the durable truth of the accomplishment,
not phrased for one listing. `/tailor` adjusts wording per job later.

Bullet style (from the reviewed pool):
- Plain, confident, concrete. Facts carry the weight. No filler adjectives (robust, seamless, world-class),
  no "responsible for", no buzzwords.
- **No em dashes (—).** No parenthetical asides; for a short tool list use "such as X and Y".
- Open with a strong, concrete verb (Developed, Built, Led, Drove, Architected); vary openers across the
  experience. Reserve "Own" for genuine program/process ownership.
- Current role (SchoolAI): present tense for ongoing responsibilities, past tense for completed results.
- Quantify only when the number is genuinely impressive, and only with a number Carson gave you.
- Don't reference internal context a reader won't know or name internal tools (e.g. Sentinel) outside
  the bullet that introduces them. Respect the truth guardrails in `config/positioning.md`.
- Use the language employers use when it's accurate (that's the point of the exercise): if Carson built
  design tokens, say "design tokens".

For **Weak** items, propose a reworded version of the existing bullet (same accomplishment, same facts,
clearer terms) rather than adding a near-duplicate. For **Skill only** items, propose the skill with a
category from the existing `vocabulary.skillCategories` and a 1 to 5 proficiency Carson confirms.

Tag each new bullet with `themes` and `targetRoleTypes` from the existing `vocabulary`; introduce a new
tag only when nothing fits, and mention it.

## 5. Write

Put the approved changes in `<scratchpad>/bullet-changes.json`:

```jsonc
{
  "addBullets": [
    { "experience": "<job_experiences.id>", "text": "...", "themes": ["Design Systems"], "targetRoleTypes": ["Staff FE"] }
  ],
  "updateBullets": [
    { "id": "<resume_bullets.id>", "text": "<reworded>", "reason": "JDs say 'design tokens'" }
  ],
  "addSkills": [
    { "category": "Design Systems", "name": "Style Dictionary", "proficiency": 3 }
  ],
  // optional: approved alternate wordings, and Carson's role in the work
  "addVariants": [ { "id": "<resume_bullets.id>", "text": "<one-line version>", "kind": "one_line" } ],
  "setCredit": [ { "id": "<resume_bullets.id>", "credit": "led" } ]   // led | built | contributed
}
```

Validate first, then write:

```sh
npx tsx src/cli.ts bullets apply --json <scratchpad>/bullet-changes.json --dry-run
npx tsx src/cli.ts bullets apply --json <scratchpad>/bullet-changes.json
```

`apply` rejects unknown experience/bullet ids, em dashes, duplicate bullets, and duplicate skills, and
warns on new tags or skill categories. It gives new bullets an explicit UUID and `reviewed: true` (Carson
approved the wording), and keeps a reworded bullet's previous text in its `notes`.

## 6. Report back (short)

- What changed: bullets added (with experience), bullets reworded, skills added.
- Genuine gaps Carson confirmed he doesn't have (useful for triage and for what not to pitch).
- Anything left for next time.
