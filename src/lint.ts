/**
 * Voice + spec lint: deterministic checks for the rules Carson has already stated, run on every render so
 * they don't depend on anyone remembering them. Each warning names the line it found and why; the lists
 * live in config/voice-lint.ts and the reasons in config/voice-style-guide.md.
 */

import { AI_PATTERNS, AI_TROPES, HEADLINE, LETTER_WORDS, LONG_SENTENCE_WORDS, NEVER_SKILLS, TEMPLATED, TIME_SENSITIVE } from "../config/voice-lint.ts";
import type { RenderModel } from "./types.ts";

const words = (s: string) => s.split(/\s+/).filter(Boolean);
const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);
const phrase = (p: string) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");

export function lintModel(model: RenderModel): string[] {
  const out: string[] = [];

  // Everywhere: em dashes.
  const all: Array<[string, string]> = [
    ["Headline", model.headline],
    ...model.skills.map((s): [string, string] => [`Skills "${s.label}"`, `${s.label}: ${s.items}`]),
    ...model.experiences.flatMap((e) => e.bullets.map((b, j): [string, string] => [`${e.company} bullet ${j + 1}`, b])),
  ];
  const cl = model.coverLetter;
  if (cl) {
    all.push(["Greeting", cl.greeting], ...cl.body.map((p, i): [string, string] => [`Letter paragraph ${i + 1}`, p]), ["Sign-off", cl.signoff]);
  }
  for (const [where, text] of all) if (text.includes("—")) out.push(`${where} has an em dash`);

  // Résumé.
  if (!HEADLINE.test(model.headline)) out.push(`Headline "${model.headline}" isn't "Sr. Software Engineer | <1 to 2 focus areas>"`);
  if (/\bstaff\b/i.test(model.headline)) out.push(`Headline claims "Staff"`);
  for (const s of model.skills) {
    const items = s.items.split(",").map((x) => x.trim().toLowerCase());
    for (const bad of NEVER_SKILLS) if (items.includes(bad)) out.push(`Skills "${s.label}" lists "${bad}" (never-list)`);
    const labelParts = s.label.toLowerCase().split(/\s*(?:&|,|and)\s*/).filter(Boolean);
    for (const item of items) if (labelParts.includes(item)) out.push(`Skills "${s.label}" repeats its label as the item "${item}"`);
  }
  for (const e of model.experiences)
    e.bullets.forEach((b, j) => {
      for (const p of [...AI_TROPES, ...TEMPLATED]) if (phrase(p).test(b)) out.push(`${e.company} bullet ${j + 1} uses "${p}"`);
    });

  // Cover letter.
  if (cl) {
    if (/hiring team|to whom it may concern/i.test(cl.greeting)) out.push(`Greeting "${cl.greeting}" is generic; use "Dear <Company> Team,"`);
    if (words(cl.greeting).length > 6 && /^Dear\b/.test(cl.greeting)) out.push(`Greeting "${cl.greeting}" is long; default to "Dear <Company> Team,"`);
    const prose = cl.body.join(" ");
    const n = words(prose).length;
    if (n < LETTER_WORDS.min || n > LETTER_WORDS.max) out.push(`Letter is ${n} words (aim ${LETTER_WORDS.min} to ${LETTER_WORDS.max})`);
    cl.body.forEach((p, i) => {
      const where = `Letter paragraph ${i + 1}`;
      if (/:\s/.test(p)) out.push(`${where} has a colon`);
      if (/["“”]/.test(p)) out.push(`${where} has quotation marks`);
      if (/ & /.test(p)) out.push(`${where} uses "&" (write "and")`);
      for (const p2 of [...AI_TROPES, ...TEMPLATED]) if (phrase(p2).test(p)) out.push(`${where} uses "${p2}"`);
      for (const { re, why } of AI_PATTERNS) {
        const m = p.match(re);
        if (m) out.push(`${where}: "${m[0]}" (${why})`);
      }
      for (const re of TIME_SENSITIVE) {
        const m = p.match(re);
        if (m) out.push(`${where} makes a time-sensitive claim ("${m[0]}"); use only JD, careers, or values-page facts`);
      }
      for (const s of p.split(/(?<=[.!?])\s+/))
        if (words(s).length > LONG_SENTENCE_WORDS) out.push(`${where} has a ${words(s).length}-word sentence: "${short(s)}"`);
    });
    // The same distinctive 4-word phrase twice in one letter.
    const grams = new Map<string, number>();
    const w = words(prose.toLowerCase().replace(/[^a-z0-9' ]/g, " "));
    for (let i = 0; i + 4 <= w.length; i++) {
      const g = w.slice(i, i + 4).join(" ");
      grams.set(g, (grams.get(g) ?? 0) + 1);
    }
    for (const [g, c] of grams) if (c > 1 && !/^(i|the|and|of|to|a|in|that|it) /.test(g)) out.push(`Letter repeats "${g}"`);
  }
  return out;
}
