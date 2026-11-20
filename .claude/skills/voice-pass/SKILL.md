---
name: voice-pass
description: Review a tailored spec's cover letter for AI-writing patterns (echo-the-JD-then-claim-it, generic affirmations, abstract bridge lines, hanging maxims, contrast closes, strained callbacks, truth drift in reworded lines) and rewrite the offending sentences in Carson's voice. Runs inside /tailor before the final render (interactive and auto mode). Use when Carson runs /voice-pass <spec> or asks to check a letter for AI-sounding writing.
argument-hint: "<specs/file.json>"
---

# /voice-pass: find and fix AI-writing patterns in a letter

Target: `$ARGUMENTS` (a spec path; inside `/tailor`, the spec you just drafted).

Carson's approved wording is the baseline. The AI patterns live almost entirely in the sentences that were
written fresh or reworded for this letter, so that's where to look and what to fix.

## 1. Know what's his

Read the letter, the voice guide (`config/voice-style-guide.md`), and the approved letters it reused. The
spec's `autoNotes` or your own drafting notes name them, and so does the voice guide's story table. A
sentence copied from an approved letter is **his**: leave it alone, even if it trips a pattern below
(he has approved some "that's the kind of team" lines). Review two kinds of sentence closely:
- **New**: written for this letter.
- **Reworded**: started from an approved line but changed. Compare it with the original: does it still claim
  exactly what the original claimed?

## 2. Check each new or reworded sentence against these patterns

| Pattern | Example from a real draft | Fix |
|---|---|---|
| **Echo the JD, then claim it** | "The team builds foundations engineers and agents build on. That second half is already how I work." | Drop the claim sentence; let the evidence that follows make the point. |
| **Generic affirmation** | "That's the kind of work I enjoy most." | Replace with a concrete fact from the pool that answers the JD (e.g. the shared form-validation tooling for a forms-heavy product). |
| **Abstract bridge line** | "As AI writes more of the interface, holding that standard is what interests me most." | Cut it, or say the concrete thing. Paragraph openings usually make the turn already. |
| **Paragraph ending on a maxim** | "…the model is only as good as the system underneath it." (its payoff was cut) | Put the payoff back (prefer his approved follow-up), or end on the fact before it. |
| **Contrast close** | "…spend less time wrestling with software and more time reaching the right communities." | One plain forward-looking sentence, or his approved close. |
| **Strained callback or repeated word** | "help make sure the experiences AI helps build at Apple are still the ones I point to" | Shorter callback ("help keep Apple the example I point to"), or drop the close (the voice guide makes it optional). |
| **Performed rhythm** | "every line they write is still mine to review and answer for" | His plainer approved line: "Agents multiply what I can ship, but I take accountability for every line." |
| **JD restated in its own words** | "focused on making complex workflows easier to use, with an eye on performance and reliability" | Say what the work actually is, briefly and concretely, in your own words. |
| **Truth drift in a reworded line** | approved "building AI features that help people do their best work" → "building the tools they rely on" (implies he built campaign tools) | Restore the approved claim, or a version that claims no more. |
| **Thesis said twice** | two adjacent sentences making the same AI-is-changing-things point | Keep the more concrete one. |
| **Clichés** | "wrestling with", "landscape", "elevate", "at the end of the day" | The plain word. |

Also run the voice guide's checklist (one point per paragraph, safe company facts, length, greeting).

## 3. Fix

- Rewrite only the flagged sentences. Keep every fact, number, and credit level. Prefer his approved wording
  from other letters (search `specs/*.json` for the idea) over fresh phrasing.
- Each replacement must itself pass the patterns above.
- Render (`--out-dir <slug>` in auto mode) and check the fill and lint. The lint's AI-pattern warnings
  (`config/voice-lint.ts`, `AI_PATTERNS`) must be gone from every sentence that isn't his approved wording.

## 4. Record

- **Interactive:** show Carson each change as before → after with the pattern name, in one message.
- **Auto mode:** add one `autoNotes` entry: `"Voice pass: <n> sentences rewritten (<pattern>: before → after; ...)"`.
- Keep the before/after list short and exact. It's what Carson reviews, and it feeds `/retro`.
