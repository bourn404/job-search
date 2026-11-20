/** Resolve a SelectionSpec + Directus data + static profile into a RenderModel. */

import { profile } from "../config/profile.ts";
import { fetchBullets, fetchExperiences } from "./db/index.ts";
import type {
  JobExperience,
  RenderEntry,
  RenderModel,
  ResumeBullet,
  SelectionSpec,
} from "./types.ts";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2025-05-01" -> "May 2025"; null -> "Present". */
function formatMonthYear(iso: string | null): string {
  if (!iso) return "Present";
  const [y, m] = iso.split("-");
  const monthIdx = Number(m) - 1;
  const month = MONTHS[monthIdx] ?? "";
  return `${month} ${y}`.trim();
}

function formatDateRange(exp: JobExperience): string {
  return `${formatMonthYear(exp.start_date)} - ${formatMonthYear(exp.end_date)}`;
}

/** Year-only range: "2016" if same year, else "2019 - 2021", or "2019 - Present". */
function formatYearRange(exp: JobExperience): string {
  const start = exp.start_date ? (exp.start_date.split("-")[0] ?? "") : "";
  const end = exp.end_date ? (exp.end_date.split("-")[0] ?? "") : "Present";
  return start === end ? start : `${start} - ${end}`;
}

/**
 * Build the fully-resolved render model. Experiences are rendered in the order
 * given by the spec (the AI decides ordering); bullets within an experience are
 * rendered in the order their IDs appear in `bulletIds`.
 */
export async function buildModel(spec: SelectionSpec): Promise<RenderModel> {
  const expIds = [...new Set(spec.experiences.flatMap((e) => e.experienceIds))];
  const bulletIds = spec.experiences.flatMap((e) => e.bullets.map((b) => b.sourceId));

  const [experiences, bullets] = await Promise.all([
    fetchExperiences(expIds),
    fetchBullets(bulletIds),
  ]);

  const expById = new Map(experiences.map((e) => [e.id, e]));
  const bulletById = new Map(bullets.map((b) => [b.id, b]));

  const entries: RenderEntry[] = spec.experiences.map((se) => {
    if (se.experienceIds.length === 0) {
      throw new Error("Spec entry has no experienceIds");
    }
    const exps = se.experienceIds.map((id) => {
      const e = expById.get(id);
      if (!e) throw new Error(`Unknown experienceId: ${id}`);
      return e;
    });

    // Newest stint first, by start date.
    const sorted = [...exps].sort((a, b) =>
      (b.start_date ?? "").localeCompare(a.start_date ?? ""),
    );
    const primary = sorted[0]!;

    const idSet = new Set(se.experienceIds);
    // Render the spec's (possibly reworded) text, but validate each bullet anchors to a
    // real pool entry belonging to this entry's experience(s) — truth anchor, no fabrication.
    const resolvedBullets = se.bullets.map((sb) => {
      const b: ResumeBullet | undefined = bulletById.get(sb.sourceId);
      if (!b) throw new Error(`Unknown bullet sourceId: ${sb.sourceId}`);
      if (b.experience && !idSet.has(b.experience)) {
        throw new Error(
          `Bullet ${sb.sourceId} belongs to experience ${b.experience}, not referenced by this entry`,
        );
      }
      if (!sb.text?.trim()) throw new Error(`Bullet ${sb.sourceId} has empty text`);
      return sb.text;
    });

    const fmt = se.dateGranularity === "year" ? formatYearRange : formatDateRange;
    return {
      title: se.titleOverride ?? primary.default_title,
      company: primary.company,
      location: primary.location ?? "",
      dateRanges: sorted.map(fmt),
      bullets: resolvedBullets,
    };
  });

  return {
    kind: spec.kind,
    name: profile.name,
    headline: spec.headline ?? profile.headline,
    contact: { ...profile.contact, links: [...profile.contact.links] },
    skills: spec.skills ?? profile.skills.map((s) => ({ ...s })),
    experiences: entries,
    education: profile.education.map((e) => ({ ...e })),
    coverLetter: spec.coverLetter,
  };
}
