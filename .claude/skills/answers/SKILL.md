---
name: answers
description: Draft answers to an application form's free-text questions (why this company, most impactful work, AI disclosure, languages used) in Carson's voice, from the role's tailored spec, cover letter, company brief, and approved stock answers; save them to the export folder. Use when Carson runs /answers or pastes application questions for a role.
argument-hint: "[opportunityId]"
---

# /answers: application-form answers

Target: `$ARGUMENTS` (an opportunity id; if missing, use the role Carson is applying to in this
conversation, or ask which).

Carson pastes form questions one or several at a time (word limits included when the form has them).
The answers must sound like him and match what his résumé and cover letter already claim.

## 1. Gather (don't ask for what's stored)

- `npx tsx src/cli.ts tailor context <id> > <scratchpad>/context-<id>.json`: the JD, the bullet pool with
  credit levels, and `opportunity.materials_spec`.
- The tailored spec `specs/<materials_spec>`: the bullets and the cover letter he approved for this role.
- The company brief `research/companies/<company>.md`.
- `config/stock-answers.md`: approved answers to common questions. Start from these. (It's kept out of git, so a
  fresh clone won't have it; if it's missing, draft from the other sources and create it on the first approval.)
- `config/voice-style-guide.md`: the voice rules (hard rules, voice and wording) apply to answers too.

## 2. Draft

- **Start from what's approved.** Reuse wording from this role's cover letter and from stock answers before
  writing fresh. The answers must agree with the letter: same story, same reasons for the company.
- **Fit the box.** Respect the word or sentence limit; "1-2 sentences" means 1 to 2 sentences.
- **Plain and human.** Carson flagged a drafted answer as "very ai-written" (ElevenLabs, 2026-10-14). Use
  short sentences, contractions, no setup-colon-reveal, no tool lists, none of the voice guide's banned
  phrases. Read it aloud in your head: would he say it like that?
- **Truth.** Every claim comes from the pool, the spec, or the brief, with credit matching the pool's
  `credit` level. If a question asks about something he hasn't done (e.g. "have you used our product?"),
  say so honestly and turn it into real interest. He asked for that on ElevenLabs.
- **Questions only he can answer** (salary expectations, start date, visa or relocation, references): don't
  draft them. List them for him.
- Give one answer per question. Offer a second version only when the question invites a real choice of
  angle.

## 3. Save and report

Append the questions and the final answers to `~/resumes/<export folder>/application-answers.md`. The export
folder is the one `tailor attach --export` made; find it by company under `~/resumes/`. Show the answers in
chat, ready to paste.

When Carson edits an answer to a question that recurs (AI disclosure, languages, impact, why now), update
its entry in `config/stock-answers.md` (create the file if it doesn't exist) with his wording and the date.
