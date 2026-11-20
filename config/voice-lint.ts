/**
 * Lint vocabulary: the mechanical half of config/voice-style-guide.md and the /tailor skill's résumé rules,
 * checked on every render by src/lint.ts. Edit these lists when Carson bans (or un-bans) a phrase; the
 * prose rules and the reasons behind them stay in the voice guide.
 */

/** AI-trope metaphors and filler (voice guide, "Hard rules"). Matched case-insensitively as phrases. */
export const AI_TROPES = [
  "north star",
  "tapestry",
  "navigate",
  "at the intersection of",
  "synergy",
  "passionate about",
  "results-driven",
  "leverage cutting-edge",
  "seamless",
  "seamlessly",
  "robust",
  "world-class",
  "delve",
];

/** Templated cover-letter phrases (voice guide, "Hard rules"). */
export const TEMPLATED = [
  "i am writing to express my interest",
  "i am excited to apply",
  "proven track record",
  "detail-oriented",
  "team player",
  "fast-paced environment",
  "hit the ground running",
  "i believe i would be a great fit",
  "leverage my skills",
  "thank you for considering my application",
  "responsible for",
];

/** Time-sensitive company claims he asked to avoid ("we could be wrong and making assumptions"). */
export const TIME_SENSITIVE = [/\brecent(ly)?\b/i, /\bnew(ly)? (launched|released|update)/i, /\bjust (launched|shipped|released)\b/i];

/** Skills never to list (tailor skill, "Key Skills"). Exact item match, case-insensitive. */
export const NEVER_SKILLS = ["component libraries", "design tokens", "figma"];

/** Headline shape: "Sr. Software Engineer | <area>" with one or two areas joined by "&". */
export const HEADLINE = /^Sr\. Software Engineer \| [^|&]+?( & [^|&]+)?$/;

export const LETTER_WORDS = { min: 190, max: 320 }; // his approved finals run 200 to 260 after his cuts
export const LONG_SENTENCE_WORDS = 40;

/**
 * AI-writing patterns in letter prose (found in /voice-pass reviews, 2026-11-03). Each is a construction,
 * not a word: echoing the JD and then claiming it, generic affirmations, contrast closes, stock clichés.
 */
export const AI_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\b(that'?s|this is|it'?s) (exactly |just )?the (kind|sort|type) of (work|problem|team|place|thing)\b/i, why: "generic affirmation after a JD echo; replace with evidence" },
  { re: /\b(is|are) (already|exactly) (how|what) I\b/i, why: "echo the JD, then claim it" },
  { re: /\bthat'?s exactly what I\b/i, why: "echo the JD, then claim it" },
  { re: /\bwhat (interests|excites|draws|motivates) me (the )?most\b/i, why: "abstract bridge line; say the concrete thing" },
  { re: /\b(work|problems?) I (enjoy|love) (the )?most\b/i, why: "generic affirmation; replace with evidence" },
  { re: /\bless time\b[^.!?]*\bmore time\b/i, why: "'less X, more Y' contrast close" },
  { re: /\bnot just\b[^.!?]*,? but\b/i, why: "'not just X, but Y' contrast" },
  { re: /\b(wrestling with|at the end of the day|game[- ]changer|ever[- ]evolving|in today'?s|landscape|elevate|unlock(s|ing)? the)\b/i, why: "stock cliché" },
];
