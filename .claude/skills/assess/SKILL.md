---
name: assess
description: Score each `interested` job opportunity 0–100 on how confident Claude is that it could produce a tailored résumé + cover letter Carson would approve without his input, and store the score and reasoning in the database (materials_confidence, materials_assessment). Use when Carson runs /assess, asks which interested roles can be drafted without him, or before /autopilot.
argument-hint: "[--rescore]"
---

# /assess: materials confidence for interested roles

Arguments: `$ARGUMENTS` (`--rescore` re-scores every interested role, not just unscored ones).

The question for each role: **if I ran `/tailor` in auto mode now, with no questions to Carson, would he
approve the result after at most one light round in the spec editor?** Score that, honestly, and say why.
`/autopilot` drafts every role at or above its threshold (default 70), so a high score is a promise.

Run CLI commands as `npx tsx src/cli.ts ...` from the repo root.

## 1. Gather

1. `assess list $ARGUMENTS > <scratchpad>/assess-queue.json`.
2. One `tailor context` covers the shared pools: run `tailor context <first id> > <scratchpad>/ctx.json` and
   read `experiences`, `skills`, and `profile` once. Then for each role, run `tailor context <id>` and read only
   its `opportunity` (full JD), `postingLive`, and `priorLetters`.
3. Read `config/positioning.md` (truth guardrails, what to lead with), `config/job-criteria.md` (level and
   location context), and the "Default story by role type" table in `config/voice-style-guide.md`.
4. List what exists to reuse: `ls specs/` (approved specs; see `/tailor` for which to skip) and
   `ls research/companies/` (briefs; note each one's date).

**Liveness first.** `postingLive.live === false` → archive the role (step 3, `archive`), no score. `null` →
score it, but say "liveness unknown" in the assessment; autopilot re-checks before drafting.

## 2. Score each role (rubric)

Start from 0 and add, then subtract:

**Résumé coverage (0–40).** List the JD's 5 to 8 key asks. How many does the pool back truthfully, with
bullets at the right credit level and skills in the pool? 40 = every must-have is covered and several are
backed by metric bullets; 25 = must-haves covered, preferred ones thin; 10 = a core must-have is missing.

**Letter starting point (0–30).**
- An approved letter to the **same company** whose story fits this role: 25 to 30. Same-company reuse is fine.
- An approved letter for the **same role type** (the voice guide's story table): 18 to 24.
- Only loosely related letters: 8 to 15.
- Add up to 3 for a company brief under ~3 months old.

**Why-this-company grounding (0–30).** Can the why-them paragraph be written from the brief, the
careers/mission/values pages, and Carson's stated convictions (positioning's mission thread, past approved
reasons) without inventing his feelings? A mission that connects to education, accessibility, belonging, or
his craft convictions: 22 to 30. A company he has written to before: 20+. A neutral company with a clear
mission: 12 to 20. Nothing to go on: under 10.

**Subtract for decisions only Carson can make** (each, as it applies):
- Level above his (Staff, Principal, Manager, Lead of a team): −15 to −25
- A required skill the pool lacks (native mobile, Java/C#/Python-primary backend, search/indexing infra): −10 to −20
- A non-engineering role (program manager, designer): −20
- A required portfolio or work sample: −15
- A template, near-empty, or boilerplate JD: −15
- Listed more than ~4 months ago, or evergreen: −5 to −10
- Relocation or in-office where job-criteria marks it a dealbreaker: flag it; don't subtract (Carson already marked it interested)

Clamp to 0–100. Calibration: the 2026-11-03 pass scored Apple AI Experiences 88 (pool near 1:1, same-org
approved letter), Reddit Ads Campaign Manager 86, LangChain DS 80, Toast Consumer 70, Vanta AI DX 62 (eval
leadership would overstate his credit), Pinterest UX Engineer 50 (native mobile required).

## 3. Write and apply

Write `<scratchpad>/assessments.json`:

```json
{ "assessments": [
  { "id": "<uuid>", "confidence": 82,
    "assessment": "Résumé 34/40: ... Letter 24/30: start from <spec>, story <row>. Why-them 24/30: .... Minus: none. Open questions for Carson: none / <list>. Liveness: open|unknown." },
  { "id": "<uuid>", "archive": "posting closed (Greenhouse 404, 2026-11-03)" }
] }
```

The `assessment` text is what auto mode reads before drafting, so name: the story and reference spec to
start from, the JD asks the pool can't cover, and any question that would have gone to Carson.

```sh
npx tsx src/cli.ts assess apply --json <scratchpad>/assessments.json --dry-run
npx tsx src/cli.ts assess apply --json <scratchpad>/assessments.json
```

## 4. Report

A table sorted by score: role, id, score, the one-line reason, and a mark at the autopilot threshold
(default 70). End with the roles below the threshold and the one question that would most raise each one's
score. Carson can answer it, and re-running `/assess --rescore` picks the answer up.
