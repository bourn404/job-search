---
name: triage
description: Work the job_opportunities triage queue. Read each discovered role's JD, skip or keep it, score keepers against Carson's profile, and apply decisions in batches. Use when Carson runs /triage or asks to triage/score newly discovered roles.
argument-hint: "[company]"
---

# /triage: vet and score the triage queue

Optional scope: `$ARGUMENTS` (a company name to triage just that company; empty = whole queue).

Run CLI commands as `npx tsx src/cli.ts ...` from the repo root (not `npm run`, whose prelude pollutes
JSON on stdout).

## 1. Read the criteria first

Read `config/job-criteria.md` in full. It defines focus areas, dealbreakers, location and comp rules,
the AI-forward bonus, the name-recognition bar, and the scoring bands. Apply it literally.

## 2. Pull the queue

```sh
npx tsx src/cli.ts triage > <scratchpad>/triage-queue.json
```

Unarchived `status: triage` rows as JSON, each with the full JD in `description` and any structured
`salary_min/max`. If it's empty, say so and stop (suggest `discover` if Carson wants fresh roles).
If `$ARGUMENTS` names a company, work only those rows.

## 3. Decide each role: skip or keep

**Read the description, not just the title.** Title-only triage is too coarse.

- **Gate before score.** A `skip` gets `chainOfThought` and **no** `matchPercentage`. A `keep` gets both.
  (Enforced by `triage --apply`.)
- **Always write `chainOfThought`**, including skips. Carson audits why things were dropped, so name the
  specific reason (the dealbreaker, the level, the comp, the stack).
- **Salary is already filled deterministically** (discovery parses pay text from the JD; see
  `src/discovery/salary.ts`), so judge comp from `salary_min/max` and don't extract it yourself.
- Optional on keeps: `summary` (one or two lines on the role), `remote` (`fully_remote` | `hybrid` |
  `on_site`), `notes`.

## 4. Apply in batches (per company)

Write one decisions file per batch to the scratchpad (`specs/triage/` also works; it's gitignored), then:

```sh
npx tsx src/cli.ts triage --apply <decisions.json>
```

Each applied batch moves rows out of `triage` (skips become `ai_skipped`, keeps become `new`), so if
you're interrupted the queue shows exactly what's left. Don't save everything for one file at the end.

```jsonc
{ "decisions": [
  { "id": "...", "decision": "skip", "chainOfThought": "why it was dropped" },
  { "id": "...", "decision": "keep", "matchPercentage": 86, "chainOfThought": "...",
    "summary": "...", "remote": "fully_remote", "notes": "..." }
] }
```

## 5. Report back (short)

Counts (kept / skipped), then the keepers sorted by score: company, role, score, comp if known, and a
one-line why. Mention any skip that was a close call. Carson picks from the keepers by setting them to
`interested`, then runs `/tailor <id>`.
