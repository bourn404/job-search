/**
 * Static résumé content that does NOT live in Directus.
 *
 * Per the project's data-modeling decision: contact/headline, education, and the
 * default Key Skills block are kept here as repo config (they rarely change), while
 * experience bullets + job metadata come from Directus. A selection spec may override
 * `headline` and `skills` per application; everything else here is the fixed identity.
 */

export interface SkillLine {
  /** Bolded category label, e.g. "Fullstack". */
  label: string;
  /** Comma-separated items rendered after the label. */
  items: string;
}

export interface EducationEntry {
  school: string;
  degree: string;
}

export const profile = {
  name: "Carson Fairbourn",
  /** Default headline; a spec may override per application. */
  headline: "Sr. Fullstack Engineer | Accessibility Program Owner",
  /**
   * Email and phone come from .env (PROFILE_EMAIL, PROFILE_PHONE) so they stay out of git. A getter, because
   * the CLI loads .env after this module is imported.
   */
  get contact() {
    return {
      email: process.env.PROFILE_EMAIL ?? "you@example.com",
      phone: process.env.PROFILE_PHONE ?? "555-555-5555",
      links: ["linkedin.com/in/cfairb"],
    };
  },
  /** Default Key Skills; a spec may override per application. */
  skills: [
    { label: "Fullstack", items: "TypeScript, React, Next.js, Node.js, SQL, Docker, Vitest, Bash, PHP" },
    { label: "Accessibility", items: "WCAG 2.1/2.2, program management, VoiceOver, NVDA, automation" },
    { label: "AI", items: "agentic frameworks, evaluation pipelines, MCP integration, structured output" },
  ] satisfies SkillLine[],
  education: [
    {
      school: "Brigham Young University - Idaho",
      degree: "Bachelor of Science, Web Design & Development",
    },
  ] satisfies EducationEntry[],
} as const;
