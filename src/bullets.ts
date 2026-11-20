/**
 * Bullet-gap analysis — the deterministic surface for the /bullet-gaps skill.
 *
 * `buildGapsContext` gathers what the AI needs to compare what employers ask for against what the
 * résumé pool shows: the descriptions of the roles Carson marked `interested` (not archived) and the
 * full bullet + skill pools with their tagging vocabulary. The AI reads the descriptions itself; nothing
 * about requirements is persisted.
 *
 * `applyBulletChanges` writes the changes Carson approved, validating them first so the skill never
 * has to hand-roll Directus writes: new bullets (explicit UUID, linked experience, tags, credit),
 * rewordings of existing bullets (old wording kept in `notes`), approved variants (one-line or
 * angle-specific wordings, appended to `variants`), credit levels, and new skills.
 */

import { randomUUID } from "node:crypto";
import type { BulletCredit, BulletVariant } from "./types.ts";
import {
  createBullets,
  createSkills,
  fetchAllBullets,
  fetchAllExperiences,
  fetchAllSkills,
  fetchBulletNotes,
  fetchGapScope,
  updateBullet,
} from "./db/index.ts";

const csv = (s: string | null | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

function tally(values: string[]): Array<{ value: string; count: number }> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
}

export async function buildGapsContext() {
  const [scope, experiences, bullets, skills] = await Promise.all([
    fetchGapScope(),
    fetchAllExperiences(),
    fetchAllBullets(),
    fetchAllSkills(),
  ]);

  const withDesc = scope.filter((o) => o.description && o.description.trim().length > 200);
  const opportunities = withDesc.map((o) => ({
    id: o.id,
    company: o.company,
    title: o.job_title,
    matchPercentage: o.match_percentage,
    description: o.description,
  }));

  return {
    note:
      "Follow .claude/skills/bullet-gaps/SKILL.md. Only real, confirmed experience becomes a bullet; " +
      "write changes with `bullets apply`.",
    scope: {
      criteria: { status: "interested", archived: false },
      counts: { inScope: scope.length, withDescription: opportunities.length, skippedNoDescription: scope.length - withDesc.length },
    },
    opportunities,
    experiences: experiences.map((e) => ({
      id: e.id,
      company: e.company,
      default_title: e.default_title,
      alt_titles: e.alt_titles,
      start_date: e.start_date,
      end_date: e.end_date,
      bullets: bullets
        .filter((b) => b.experience === e.id)
        .map((b) => ({ id: b.id, text: b.bullet_point, themes: csv(b.themes), targetRoleTypes: csv(b.target_role_types), reviewed: b.reviewed })),
    })),
    skills: tally(skills.map((s) => s.category)).map(({ value: category }) => ({
      category,
      items: skills.filter((s) => s.category === category).map((s) => ({ id: s.id, name: s.name, proficiency: s.proficiency })),
    })),
    vocabulary: {
      themes: tally(bullets.flatMap((b) => csv(b.themes))),
      targetRoleTypes: tally([...bullets, ...skills].flatMap((b) => csv(b.target_role_types))),
      skillCategories: tally(skills.map((s) => s.category)).map((t) => t.value),
    },
  };
}

// ── Applying approved changes ───────────────────────────────────────────────────

const CREDITS: BulletCredit[] = ["led", "built", "contributed"];
const VARIANT_KINDS: BulletVariant["kind"][] = ["one_line", "short", "angle"];

export interface BulletChanges {
  addBullets?: Array<{
    experience: string;
    text: string;
    themes?: string[];
    targetRoleTypes?: string[];
    notes?: string;
    credit?: BulletCredit;
    reviewed?: boolean; // default true (approved in /bullet-gaps); tailoring passes false
  }>;
  /** Approved alternate wordings to keep with a bullet (deduped by text). */
  addVariants?: Array<{ id: string; text: string; kind: BulletVariant["kind"]; angle?: string; source?: string }>;
  /** Carson's role in a bullet's work. */
  setCredit?: Array<{ id: string; credit: BulletCredit }>;
  updateBullets?: Array<{ id: string; text: string; themes?: string[]; targetRoleTypes?: string[]; reason?: string }>;
  addSkills?: Array<{ category: string; name: string; proficiency?: number; targetRoleTypes?: string[] }>;
}

export interface ApplyReport {
  errors: string[];
  warnings: string[];
  added: number;
  updated: number;
  variantsAdded: number;
  creditsSet: number;
  skillsAdded: number;
  dryRun: boolean;
}

export async function applyBulletChanges(changes: BulletChanges, opts: { dryRun?: boolean } = {}): Promise<ApplyReport> {
  const [experiences, bullets, skills] = await Promise.all([fetchAllExperiences(), fetchAllBullets(), fetchAllSkills()]);
  const errors: string[] = [];
  const warnings: string[] = [];
  const expIds = new Set(experiences.map((e) => e.id));
  const knownThemes = new Set(bullets.flatMap((b) => csv(b.themes)));
  const knownRoles = new Set([...bullets, ...skills].flatMap((b) => csv(b.target_role_types)));
  const knownCategories = new Set(skills.map((s) => s.category));
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const existingText = new Set(bullets.map((b) => norm(b.bullet_point)));

  const checkText = (label: string, text: string) => {
    if (!text || text.trim().length < 20) errors.push(`${label}: text is empty or too short`);
    if (text.includes("—")) errors.push(`${label}: contains an em dash (house rule)`);
  };
  const checkTags = (label: string, themes: string[] = [], roles: string[] = []) => {
    for (const t of themes) if (!knownThemes.has(t)) warnings.push(`${label}: new theme "${t}" (not in the existing vocabulary)`);
    for (const r of roles) if (!knownRoles.has(r)) warnings.push(`${label}: new target role type "${r}"`);
  };

  const newBullets = (changes.addBullets ?? []).map((b, i) => {
    const label = `addBullets[${i}]`;
    if (!expIds.has(b.experience)) errors.push(`${label}: unknown experience id ${b.experience}`);
    checkText(label, b.text);
    if (existingText.has(norm(b.text))) errors.push(`${label}: duplicates an existing bullet`);
    checkTags(label, b.themes, b.targetRoleTypes);
    if (b.credit && !CREDITS.includes(b.credit)) errors.push(`${label}: credit must be one of ${CREDITS.join(", ")}`);
    return {
      id: randomUUID(),
      bullet_point: b.text.trim(),
      experience: b.experience,
      themes: (b.themes ?? []).join(",") || null,
      target_role_types: (b.targetRoleTypes ?? []).join(",") || null,
      notes: b.notes ?? `Added via /bullet-gaps on ${new Date().toISOString().slice(0, 10)}.`,
      credit: b.credit ?? null,
      reviewed: b.reviewed ?? true, // /bullet-gaps: Carson approved the wording; /tailor passes false
    };
  });

  const byId = new Map(bullets.map((b) => [b.id, b]));
  for (const [i, u] of (changes.updateBullets ?? []).entries()) {
    const label = `updateBullets[${i}]`;
    if (!byId.has(u.id)) errors.push(`${label}: unknown bullet id ${u.id}`);
    checkText(label, u.text);
    checkTags(label, u.themes, u.targetRoleTypes);
  }

  for (const [i, v] of (changes.addVariants ?? []).entries()) {
    const label = `addVariants[${i}]`;
    if (!byId.has(v.id)) errors.push(`${label}: unknown bullet id ${v.id}`);
    checkText(label, v.text);
    if (!VARIANT_KINDS.includes(v.kind)) errors.push(`${label}: kind must be one of ${VARIANT_KINDS.join(", ")}`);
    if (v.kind === "angle" && !v.angle) errors.push(`${label}: kind "angle" needs an angle (e.g. "growth")`);
  }
  for (const [i, c] of (changes.setCredit ?? []).entries()) {
    const label = `setCredit[${i}]`;
    if (!byId.has(c.id)) errors.push(`${label}: unknown bullet id ${c.id}`);
    if (!CREDITS.includes(c.credit)) errors.push(`${label}: credit must be one of ${CREDITS.join(", ")}`);
  }

  const skillKey = (c: string, n: string) => `${c.toLowerCase()}|${n.toLowerCase()}`;
  const existingSkills = new Set(skills.map((s) => skillKey(s.category, s.name)));
  const newSkills = (changes.addSkills ?? []).map((s, i) => {
    const label = `addSkills[${i}]`;
    if (!s.category || !s.name) errors.push(`${label}: category and name are required`);
    if (existingSkills.has(skillKey(s.category, s.name))) errors.push(`${label}: skill already exists`);
    if (!knownCategories.has(s.category)) warnings.push(`${label}: new skill category "${s.category}"`);
    if (s.proficiency != null && (s.proficiency < 1 || s.proficiency > 5)) errors.push(`${label}: proficiency must be 1-5`);
    checkTags(label, [], s.targetRoleTypes);
    return { category: s.category, name: s.name, proficiency: s.proficiency ?? null, target_role_types: (s.targetRoleTypes ?? []).join(",") || null };
  });

  const report: ApplyReport = { errors, warnings, added: 0, updated: 0, variantsAdded: 0, creditsSet: 0, skillsAdded: 0, dryRun: !!opts.dryRun };
  if (errors.length > 0 || opts.dryRun) return report;

  if (newBullets.length) await createBullets(newBullets);
  report.added = newBullets.length;

  for (const u of changes.updateBullets ?? []) {
    const current = await fetchBulletNotes(u.id);
    const stamp = new Date().toISOString().slice(0, 10);
    const history = `[${stamp}] Reworded via /bullet-gaps${u.reason ? ` (${u.reason})` : ""}. Previous: "${current?.bullet_point ?? ""}"`;
    const data: Record<string, unknown> = {
      bullet_point: u.text.trim(),
      notes: current?.notes ? `${current.notes}\n${history}` : history,
      reviewed: true,
    };
    if (u.themes) data.themes = u.themes.join(",");
    if (u.targetRoleTypes) data.target_role_types = u.targetRoleTypes.join(",");
    await updateBullet(u.id, data);
    report.updated++;
  }

  // Variants: append per bullet, skipping wordings already stored (or equal to the main text).
  const stamp = new Date().toISOString().slice(0, 10);
  const variantsById = new Map<string, NonNullable<BulletChanges["addVariants"]>>();
  for (const v of changes.addVariants ?? []) {
    if (!variantsById.has(v.id)) variantsById.set(v.id, []);
    variantsById.get(v.id)!.push(v);
  }
  for (const [id, adds] of variantsById) {
    const current = await fetchBulletNotes(id);
    const existing: BulletVariant[] = current?.variants ?? [];
    const seen = new Set([norm(current?.bullet_point ?? ""), ...existing.map((v) => norm(v.text))]);
    const fresh: BulletVariant[] = [];
    for (const a of adds) {
      if (seen.has(norm(a.text))) continue;
      seen.add(norm(a.text));
      fresh.push({ text: a.text.trim(), kind: a.kind, ...(a.angle ? { angle: a.angle } : {}), ...(a.source ? { source: a.source } : {}), approved: stamp });
    }
    if (fresh.length) await updateBullet(id, { variants: [...existing, ...fresh] });
    report.variantsAdded += fresh.length;
  }

  for (const c of changes.setCredit ?? []) {
    await updateBullet(c.id, { credit: c.credit });
    report.creditsSet++;
  }

  if (newSkills.length) await createSkills(newSkills);
  report.skillsAdded = newSkills.length;
  return report;
}
