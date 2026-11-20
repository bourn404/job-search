---
name: autopilot
description: Draft tailored résumés + cover letters without Carson for every `interested` role whose materials confidence meets a threshold (default 70), one subagent per role running /tailor in auto mode, then attach (pending_approval, auto_drafted), export, and commit. Use when Carson runs /autopilot or asks to draft materials for the interested queue without him.
argument-hint: "[threshold=70] [--ids <id,id,...>] [--dry-run]"
---

# /autopilot: draft materials for the confident roles

Arguments: `$ARGUMENTS`. A bare number is the threshold (default **70**). `--ids` limits the run to those
opportunities (still subject to the threshold unless Carson named them himself). `--dry-run` only shows
what would be drafted.

Carson isn't in the loop while this runs; he reviews each draft afterward in the spec editor. **Never
submit an application.** Run CLI commands as `npx tsx src/cli.ts ...` from the repo root.

## 1. Make sure every interested role is scored

`npx tsx src/cli.ts assess list`. If it lists any role, run the `/assess` procedure for those first
(`.claude/skills/assess/SKILL.md`). Scores from earlier runs stand. Carson re-scores with `/assess --rescore`.

## 2. Select

`npx tsx src/cli.ts tailor list` shows each interested role's confidence (`–` = unscored) and `auto` when
it's already drafted. Select roles with confidence ≥ threshold that aren't auto-drafted. Show Carson the list
(role, id, score) before launching. In `--dry-run`, stop there.

## 3. Draft, one subagent per role

Launch with the Agent tool (`general-purpose`), **at most 3 at a time**. Start the next as each finishes.
Roles at the **same company** go to one agent, sequentially, so two agents never write the same company
brief at once. Prompt for each agent (fill in the ids):

> You are drafting job-application materials in auto mode. Carson is not available. Do not ask questions.
> Working directory: `<repo root>` (this repo's absolute path). Read `.claude/skills/tailor/SKILL.md` in full and
> follow it for opportunity `<id>` (then `<id2>`, if given) **in auto mode** (its "Auto mode" section
> overrides the interactive steps). Keep every scratch file (tailor context, drafts) under
> `<scratchpad>/<opportunityId>/`, never a shared filename, because other agents run at the same time. Render only with `--out-dir <spec-slug>`. Attach with `--auto`. Do not
> save variants, do not commit, do not start the spec editor. Your final message must be only the JSON
> report the skill specifies (one object per opportunity, in an array if you drafted two).

While agents run, don't do other work in the same files. Collect each JSON report. (Pilot, 2026-11-03: two
agents sharing a scratch filename let one read the other's `tailor context`; the per-id directory prevents it.)

## 4. Verify and commit (main session)

For each `attached` report:
- `grep -n '—' specs/<file>.json` prints nothing, and the spec has a non-empty `autoNotes`.
- `npx tsx src/cli.ts render --spec specs/<file>.json --out-dir <slug>`: "nicely filled" and lint clean
  (or only the one noted exception). If not, fix the spec yourself, re-render, and re-attach with `--auto`.
- The export folder exists under `~/resumes/`.
- `autoNotes` has a "Voice pass:" entry. If it's missing, run `/voice-pass` on the spec yourself, re-render,
  and re-attach with `--auto`.

Then one commit with every new spec and brief:
`git add specs/<files> research/companies/<briefs>` and commit `autopilot: <N> drafts (<companies>)`.

## 5. Report to Carson

A table: role, confidence, angle/story, autoNotes count, gaps, export folder, status (attached / closed /
error). Then:
- **How to review:** `npx tsx src/cli.ts edit --spec specs/<file>.json` per draft. The editor shows the
  auto-draft assumptions at the top. Approving goes through `/tailor` step 5b/6 (attach without `--auto`,
  save variants).
- Closed postings and errors, with what happened.
- A reminder that his edits on these drafts feed the next `/retro`.
