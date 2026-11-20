---
name: retro
description: Self-improvement loop. Mine Carson's past conversations in this repo and his spec-editor feedback for corrections he had to make, then propose concrete edits to the skills, config docs, CLAUDE.md, memory, or deterministic tooling so the same feedback isn't needed again. Use when Carson runs /retro or asks how to make the harness need less of his input.
argument-hint: "[--all | --since YYYY-MM-DD]"
---

# /retro: turn Carson's corrections into harness changes

Arguments: `$ARGUMENTS` (default: only material new since the last retro).

The goal is fewer corrections from Carson over time. Every time he pushes back, redoes something, edits a
draft, or answers a question the data could have answered, the harness (prompts, docs, tooling) had a gap.
Find those gaps, propose the smallest durable fix for each, apply what he approves.

Run CLI commands as `npx tsx src/cli.ts ...` from the repo root.

## 1. Build the digest

```sh
npx tsx src/cli.ts retro digest --out <scratchpad>/retro-digest.md $ARGUMENTS
```

It extracts (`src/retro.ts`), from every session transcript under `~/.claude/projects/<this repo>/`:
each of Carson's typed turns with the tail of the assistant text he was reacting to, his AskUserQuestion
answers, and tool-call rejections. It adds every `specs/feedback/*.json` note and before/after edit, and a
trend table (notes + edits per tailored spec). Specs drafted by `/autopilot` are tagged **AUTO-DRAFT
corrections**: those edits are the highest-value signal, since they show exactly what Claude got wrong alone.

Read the whole digest. If it's empty, say so and stop.

## 2. Read the current harness

So you can tell what's already encoded: `CLAUDE.md`, every `.claude/skills/*/SKILL.md`, `config/*.md`, the
memory index (`MEMORY.md`) and any memory files a moment touches.

## 3. Find correction moments

Go through the digest and list every moment where Carson:
- **pushed back** on content (wording, tone, a claim, a choice of bullet/skill/title, a letter line);
- **redid** Claude's work by hand (editor edits, rewriting a line in chat);
- **repeated** an instruction he'd given before (strongest signal: the first fix didn't stick);
- **answered a question the data could have answered**, or was asked something routine;
- **rejected a tool call** or interrupted (look at what Claude was about to do);
- **approved without changes** something Claude was unsure about (a signal to stop asking).

Skip pure task requests ("run discovery", "/tailor") unless the way he phrased them reveals a default
Claude should already have.

## 4. Cluster, check, and pick a fix target

Group moments that share a root cause. For each cluster:
1. **Check whether it's already encoded.** Grep the harness for the rule. If it's encoded and he still had
   to correct it later, the fix is to make it more prominent or more concrete (an example, a checklist item,
   a deterministic check), not to restate it.
2. **Choose the fix target**, preferring the most deterministic one that works:
   - **Tooling / lint** (code in `src/`): mechanical rules a script can check every time, e.g. banned
     characters, banned skills, page fill, a JD keyword the résumé never mentions.
   - **Skill prompt** (`.claude/skills/*/SKILL.md`): procedure or judgment rules for one workflow.
   - **Config doc** (`config/positioning.md`, `config/voice-style-guide.md`, `config/job-criteria.md`):
     standing preferences about how Carson is presented or what he wants.
   - **CLAUDE.md**: cross-cutting operating norms.
   - **Memory**: context about Carson that doesn't belong in a repo doc.
   - **Keep asking**: genuinely his call each time (why this company, whether to apply despite a level gap).
     Say so explicitly; don't encode a guess.
3. **Generalize only as far as the evidence goes.** One letter's fix is a candidate rule; the same fix on
   three letters is a rule.

## 5. Write the report

Write `research/retro/<YYYY-MM-DD>.md`:

```md
# Retro <date>
Digest: <N> moments in <M> sessions, <K> feedback files. Trend: <one line on whether feedback per role is falling>.

## 1. <short title>  (impact: high|med|low, target: tooling|skill|config|CLAUDE.md|memory|keep asking)
Evidence: <2 to 4 short quotes, each with session date and context>
Already encoded? <where, or no>
Proposed change: <exact file + the text to add/replace, or the code change in one paragraph>
Expected effect: <which corrections this prevents>
```

Order by impact: how often it recurred × how much of Carson's time it cost. Keep it to the 5 to 12 strongest
items; list weaker ones in a final "Watch list" section, one line each.

Summarize the items in chat (one line each) and point to the file; offer to publish it as a page if he'd rather read it there.

## 6. Get approval, apply, close the loop

1. Ask Carson which items to apply (AskUserQuestion, multiSelect, up to 4 per question; batch the rest).
   He may edit a proposal; use his wording.
2. Apply approved changes. Tooling changes get a quick test (run the command on a real spec/row). Follow the
   repo norm: update `README.md` / `CLAUDE.md` when commands or behavior change.
3. `npx tsx src/cli.ts retro mark` to advance the ledger (`.claude/retro/ledger.json`) to this digest, so the
   next retro only sees new material. Run it even when he approves nothing, so the same moments aren't
   re-proposed (rejected items go in the report's "Declined" section instead).
4. Commit the report, the ledger, and the harness changes together (`retro: <date>` + a one-line summary).

## Rules

- Quote Carson exactly in evidence; don't paraphrase sentiment into something stronger.
- Never weaken a truth guardrail to reduce feedback. If his feedback conflicts with a guardrail, flag it.
- Prefer editing an existing rule over adding a new one beside it; delete rules that his later feedback
  reversed (e.g. humor-first openers became conviction-first).
- Don't put personal details about Carson into repo docs beyond what's needed to apply a rule.
