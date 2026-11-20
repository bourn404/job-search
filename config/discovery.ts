/**
 * Discovery pre-filter config.
 *
 * A BROAD, high-recall title keyword filter — its job is to drop obvious non-matches
 * (marketing, sales, finance, recruiting, etc.), NOT to make fine applicability calls.
 * The AI gatekeeper does the precise filtering downstream. A job_site may override these
 * via `provider_config.keywords`.
 *
 * Titles are then run through an EXCLUDE list (whole-word matches), so roles Carson never wants
 * don't cost an AI triage pass. Exclusions apply to every site, including keyword overrides.
 */

/** Drop postings whose listing date is older than this many days. Postings with an
 *  unknown listing date are kept (we can't prove they're stale). */
export const MAX_LISTING_AGE_DAYS = 90;

export const TITLE_KEYWORDS: string[] = [
  // Design systems / engineering
  "design system",
  "design engineer",
  "design technologist",
  // Frontend / UI
  "frontend",
  "front-end",
  "front end",
  "ui engineer",
  "ui platform",
  "ui infrastructure",
  "web engineer",
  "web developer",
  "ui developer",
  "ui/ux",
  // UX / product / creative engineering
  "ux engineer",
  "user experience engineer", // Google
  "ux developer",
  "product engineer",
  "growth engineer",
  "creative technologist",
  "member of technical staff", // Salesforce MTS/SMTS/PMTS, AI labs
  // Accessibility
  "accessibility",
  "a11y",
  // Fullstack / software engineering (broad)
  "fullstack",
  "full-stack",
  "full stack",
  "software engineer",
];

/** Keywords too generic for huge boards: `job_sites.title_filter = "strict"` drops them, so a title
 *  must name the area ("Software Engineer - Frontend" passes, plain "Staff, Software Engineer" doesn't). */
export const GENERIC_KEYWORDS: string[] = ["software engineer"];

export const STRICT_TITLE_KEYWORDS: string[] = TITLE_KEYWORDS.filter((k) => !GENERIC_KEYWORDS.includes(k));

/** Always excluded, whatever else the title says ("Backend / Full Stack" is still out). */
export const HARD_EXCLUDE: string[] = [
  "backend", "back-end", "back end",
  // Hardware / embedded ("ASIC Design Engineer" must not slip in via "design engineer")
  "hardware", "embedded", "firmware", "asic", "fpga", "silicon", "pcb", "photonics", "photonic",
  // Chip / electrical / mechanical design (NVIDIA, SpaceX, GM "... Design Engineer")
  "mixed signal", "mixed-signal", "analog", "circuit", "physical design", "logic design", "digital design",
  "soc", "cpu", "gpu design", "board design", "mask layout", "layout design", "thermal", "power delivery",
  "rfic", "mmic", "rf", "baw", "electrical", "mechanical", "hvac", "harness", "propulsion", "structures",
  "tooling design", "avionics", "emulation", "interconnect", "vlsi", "circuits", "rcdd", "system design engineer", "dft",
  "rtl", "tpu", "package design", "codesign", "product design engineer",
  // Design (not engineering) roles: "Product Designer", "UX Designer / Engineer"
  "designer", "designers",
];

/** Excluded unless the title also carries a clear frontend signal (FRONTEND_SIGNALS). */
export const SOFT_EXCLUDE: string[] = [
  // Infra / ops
  "infrastructure", "infra", "sre", "site reliability", "reliability", "devops", "observability",
  "distributed systems", "database", "storage", "networking", "network", "kernel", "compiler",
  "systems software", "system software", "host systems", "gpu",
  // Data / ML
  "data engineer", "data engineering", "data platform", "data infrastructure", "data scientist",
  "data science", "analytics engineer", "machine learning", "ml", "mlops", "research engineer",
  // Mobile-only
  "ios", "android", "mobile", "react native",
  // Security, test / QA
  "security", "sdet", "qa", "in test", "test engineer",
  // Early career
  "intern", "internship", "new grad",
];

/** A soft-excluded title survives if it also says one of these ("Frontend Engineer, Networking Platform"). */
export const FRONTEND_SIGNALS: string[] = [
  "frontend", "front-end", "front end", "ui", "ux", "web", "design system", "design systems",
  "design engineer", "design technologist", "accessibility", "a11y",
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Whole-word match where "_" also separates words (\b treats it as a word char: "Engineer_BACKEND").
const wordRe = (list: string[]) =>
  new RegExp(`(?<![a-z0-9])(?:${list.map(escapeRe).join("|")})(?![a-z0-9])`, "i");
const HARD_RE = wordRe(HARD_EXCLUDE);
const SOFT_RE = wordRe(SOFT_EXCLUDE);
const FRONTEND_RE = wordRe(FRONTEND_SIGNALS);

/** The exclusion term that knocks this title out, or null if it isn't excluded. */
export function excludedBy(title: string): string | null {
  const hard = title.match(HARD_RE);
  if (hard) return hard[0];
  const soft = title.match(SOFT_RE);
  return soft && !FRONTEND_RE.test(title) ? soft[0] : null;
}

/**
 * Description deal-breakers: a posting whose description mentions any of these (whole word, any case)
 * is auto-skipped. "Java" can't match "JavaScript" (the next character is a letter).
 *
 * A mention only counts when it stands alone: one inside a language list ("languages like Java, Scala,
 * Python, Go, Node.js, JavaScript and TypeScript", "Java or Kotlin") is boilerplate, not a Java role.
 * Capital One's standard qualifications list Java that way and hid ~50 frontend/full-stack roles.
 */
export const DESCRIPTION_EXCLUDE: string[] = ["Java"];
const DESC_RE = new RegExp(wordRe(DESCRIPTION_EXCLUDE).source, "gi");

/** Other languages that, near a deal-breaker term, mark the mention as one entry in a list. */
const LIST_LANGUAGES = wordRe([
  "javascript", "typescript", "python", "golang", "go", "node", "node.js", "nodejs", "scala", "kotlin",
  "c#", "c++", "ruby", "rust", "php", "swift", "elixir", "clojure", "groovy",
]);
const LIST_WINDOW = 50;

/** The deal-breaker term in this description (a standalone mention, not a language-list entry), or null. */
export function descriptionExcludedBy(description: string | null | undefined): string | null {
  if (!description) return null;
  const text = description.replace(/<[^>]+>/g, " ");
  for (const m of text.matchAll(DESC_RE)) {
    const at = m.index ?? 0;
    const around = text.slice(Math.max(0, at - LIST_WINDOW), at) + " " + text.slice(at + m[0].length, at + m[0].length + LIST_WINDOW);
    if (!LIST_LANGUAGES.test(around)) return m[0];
  }
  return null;
}

export function titleMatches(title: string, keywords: string[] = TITLE_KEYWORDS): boolean {
  const t = title.toLowerCase();
  return keywords.some((k) => t.includes(k)) && !excludedBy(title);
}

/** Include keywords for a site: provider_config.keywords if set, else by job_sites.title_filter. */
export function keywordsFor(site: {
  provider_config: Record<string, unknown> | null;
  title_filter?: string | null;
}): string[] {
  const k = site.provider_config?.keywords;
  if (Array.isArray(k) && k.every((x) => typeof x === "string")) return k as string[];
  return site.title_filter === "strict" ? STRICT_TITLE_KEYWORDS : TITLE_KEYWORDS;
}
