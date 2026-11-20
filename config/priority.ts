/**
 * Match bonus: a deterministic priority score for job_opportunities (`match_bonus`), recomputed from
 * scratch after every discovery run (so time-based rules like "listed in the last 7 days" decay, and
 * re-running never double-counts). One point per rule that applies; remote and very fresh listings are
 * worth two.
 */

/** Base salary a posted minimum must exceed to earn the salary point (job-criteria.md floor). */
export const SALARY_BENCHMARK = 175_000;

/** "Recently listed" window for the freshness point. */
export const RECENT_DAYS = 7;

/** Postings younger than this get a second freshness point (+2 total). */
export const FRESH_DAYS = 5;

/** Whole-ish days since the listing date (UTC midnight), or null if unknown. */
function ageDays(listingDate: string | null, now: Date): number | null {
  if (!listingDate) return null;
  const t = Date.parse(`${listingDate}T00:00:00Z`);
  return Number.isNaN(t) ? null : (now.getTime() - t) / 86_400_000;
}

export interface BonusInput {
  location: string | null;
  description: string | null;
  salary_min: number | null;
  listing_date: string | null; // YYYY-MM-DD
  remote: string | null; // fully_remote | hybrid | on_site
}

export interface BonusRule {
  key: string;
  label: string;
  /** Short label for UI chips (the review page). */
  chip: string | ((o: BonusInput) => string);
  /** "keyword" = matched in the description text; "badge" = a fact about the posting (location, pay, date, mode). */
  group: "keyword" | "badge";
  points: (o: BonusInput, now: Date) => number;
}

export const BONUS_RULES: BonusRule[] = [
  {
    key: "utah",
    group: "badge",
    chip: "Utah",
    label: "Utah location (UT, Utah, Salt Lake)",
    // "UT" is case-sensitive and whole-word so it can't match "out"/"Utility"; "Salt Lake City,UT" works.
    points: (o) => (o.location && (/\bUT\b/.test(o.location) || /\butah\b|salt lake/i.test(o.location)) ? 1 : 0),
  },
  {
    key: "wcag",
    group: "keyword",
    chip: "WCAG",
    label: "WCAG in the description",
    points: (o) => (o.description && /\bWCAG\b/i.test(o.description) ? 1 : 0),
  },
  {
    key: "salary",
    group: "badge",
    chip: `Salary > $${SALARY_BENCHMARK / 1000}k`,
    label: `salary_min above $${SALARY_BENCHMARK.toLocaleString("en-US")}`,
    points: (o) => (o.salary_min != null && o.salary_min > SALARY_BENCHMARK ? 1 : 0),
  },
  {
    key: "recent",
    group: "badge",
    chip: (o) => (Number(ageDays(o.listing_date, new Date())) < FRESH_DAYS ? `Listed < ${FRESH_DAYS}d` : `Listed ≤ ${RECENT_DAYS}d`),
    label: `listed less than ${FRESH_DAYS} days ago (+2) or in the last ${RECENT_DAYS} days (+1)`,
    points: (o, now) => {
      const age = ageDays(o.listing_date, now);
      if (age == null) return 0;
      return age < FRESH_DAYS ? 2 : age <= RECENT_DAYS ? 1 : 0;
    },
  },
  {
    key: "workMode",
    group: "badge",
    chip: (o) => (o.remote === "fully_remote" ? "Remote" : "Hybrid"),
    label: "remote (+2) or hybrid (+1)",
    points: (o) => (o.remote === "fully_remote" ? 2 : o.remote === "hybrid" ? 1 : 0),
  },
  {
    key: "designSystem",
    group: "keyword",
    chip: "Design system",
    label: "design system in the description",
    points: (o) => (o.description && /design[- ]systems?\b/i.test(o.description) ? 1 : 0),
  },
  {
    key: "react",
    group: "keyword",
    chip: "React",
    label: "React in the description",
    // Capitalized so "react to feedback" doesn't count; React Native (mobile) doesn't count.
    points: (o) => (o.description && /\bReact(?:\.js|JS)?\b(?!\s*Native)/.test(o.description) ? 1 : 0),
  },
  {
    key: "typescript",
    group: "keyword",
    chip: "TypeScript",
    label: "TypeScript in the description",
    points: (o) => (o.description && /\bTypeScript\b/i.test(o.description) ? 1 : 0),
  },
  {
    key: "nextjs",
    group: "keyword",
    chip: "Next.js",
    label: "Next.js in the description",
    // Needs the "js" so the plain word "next" never counts.
    points: (o) => (o.description && /\bNext\.?js\b/i.test(o.description) ? 1 : 0),
  },
  {
    key: "llmAgentic",
    chip: "LLM / Agentic",
    group: "keyword",
    label: "LLM / agentic work in the description (LLMs, agentic, AI agents, MCP, evals)",
    // Plain "AI" is in ~65% of JDs, so it doesn't discriminate; these terms (~25-30%) track building AI
    // products the way Carson has (agentic frameworks, evaluation pipelines, MCP).
    points: (o) =>
      o.description && /\bLLMs?\b|\bagentic\b|\bAI agents?\b|\bMCP\b|model context protocol|\bevals\b|evaluation pipelines?/i.test(o.description)
        ? 1
        : 0,
  },
];

/** The rules a posting matched, as UI chips: [{ key, chip, points }]. */
export function bonusChips(
  o: BonusInput,
  now: Date = new Date(),
): Array<{ key: string; chip: string; points: number; group: BonusRule["group"] }> {
  return BONUS_RULES.flatMap((r) => {
    const points = r.points(o, now);
    return points ? [{ key: r.key, chip: typeof r.chip === "function" ? r.chip(o) : r.chip, points, group: r.group }] : [];
  });
}

export function matchBonus(o: BonusInput, now: Date = new Date()): { total: number; hits: Record<string, number> } {
  const hits: Record<string, number> = {};
  let total = 0;
  for (const r of BONUS_RULES) {
    const p = r.points(o, now);
    if (p) (hits[r.key] = p), (total += p);
  }
  return { total, hits };
}
