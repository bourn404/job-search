/**
 * Phase 3 — tailoring. Triggered by the "interested" status: for each interested
 * opportunity, the AI authors a tailored selection spec (selecting + truth-preservingly
 * rewording bullets from the pool, choosing a title variant, assembling Key Skills, and
 * drafting a cover letter in Carson's voice), renders it, then attaches the PDFs to the
 * opportunity in Directus and moves it to "pending_approval" for human review.
 *
 * This module provides the deterministic surface: list the queue, assemble the context
 * the AI needs to author a spec, and attach the rendered materials back.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { profile } from "../config/profile.ts";
import {
  fetchAllBullets,
  fetchAllExperiences,
  fetchAllSkills,
  fetchCompanyMaterials,
  fetchInterestedQueue,
  fetchOpportunity,
  updateOpportunity,
  backendName,
  uploadFile,
} from "./db/index.ts";
import { checkPostingLive } from "./intake.ts";
import { buildModel } from "./select.ts";
import type { SelectionSpec } from "./types.ts";

export async function listInterested() {
  return fetchInterestedQueue();
}

/** Everything the AI needs to author a tailored spec for one opportunity. */
export async function buildContext(opportunityId: string) {
  const [opportunity, experiences, bullets, skills] = await Promise.all([
    fetchOpportunity(opportunityId),
    fetchAllExperiences(),
    fetchAllBullets(),
    fetchAllSkills(),
  ]);
  const [postingLive, companyMaterials] = await Promise.all([
    checkPostingLive(opportunity.application_url),
    fetchCompanyMaterials(opportunity.company, opportunityId),
  ]);

  // Letters already written to this company: reuse or adapt a premise, and don't repeat a story unknowingly.
  const priorLetters = companyMaterials.map((o) => {
    const path = join("specs", o.materials_spec);
    const spec = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SelectionSpec) : null;
    return { opportunityId: o.id, job_title: o.job_title, status: o.status, spec: path, coverLetter: spec?.coverLetter ?? null };
  });

  // Bullets grouped under their experience (the pool to select + reword from).
  const experiencesWithBullets = experiences.map((e) => ({
    id: e.id,
    company: e.company,
    location: e.location,
    default_title: e.default_title,
    alt_titles: e.alt_titles,
    start_date: e.start_date,
    end_date: e.end_date,
    bullets: bullets
      .filter((b) => b.experience === e.id)
      .map((b) => ({
        id: b.id,
        text: b.bullet_point,
        credit: b.credit,
        variants: b.variants ?? [],
        themes: b.themes,
        target_role_types: b.target_role_types,
      })),
  }));

  // Skills grouped by category (assemble Key Skills lines from these, weighted by proficiency).
  const byCategory = new Map<string, Array<{ id: string; name: string; proficiency: number | null }>>();
  for (const s of skills) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, []);
    byCategory.get(s.category)!.push({ id: s.id, name: s.name, proficiency: s.proficiency });
  }
  const skillsByCategory = [...byCategory.entries()].map(([category, items]) => ({ category, items }));

  return {
    note: "Author a tailored selection spec for this opportunity by following .claude/skills/tailor/SKILL.md (bullet wording up to Level 4, never Level 5; every bullet anchored to its sourceId; no fabrication; no em dashes).",
    postingLive,
    opportunity,
    priorLetters,
    profile: {
      name: profile.name,
      defaultHeadline: profile.headline,
      contact: profile.contact,
      education: profile.education,
    },
    experiences: experiencesWithBullets,
    skills: skillsByCategory,
  };
}

/** Upload rendered PDFs, attach them to the opportunity, and move it to pending_approval. */
export async function attachMaterials(
  opportunityId: string,
  opts: {
    resumePath: string;
    coverPath?: string;
    specPath?: string;
    exportName?: string;
    combined?: boolean; // also export one PDF: resume on page 1, cover letter after
    plaintext?: boolean; // also export the resume bullets (and cover letter) as plain text for application forms
    autoDrafted?: boolean; // drafted by /autopilot without Carson: flag the row and note it for review
  },
): Promise<{ resumeFile: string; coverFile?: string; exportDir?: string; exported: string[] }> {
  const opp = await fetchOpportunity(opportunityId);
  const safeCo = opp.company.replace(/[^A-Za-z0-9 &+-]/g, "").trim();

  const resumeFile = await uploadFile(
    opts.resumePath,
    `${profile.name} - Resume - ${safeCo}.pdf`,
    `${profile.name} — Resume — ${opp.company} (${opp.job_title})`,
  );
  let coverFile: string | undefined;
  if (opts.coverPath) {
    coverFile = await uploadFile(
      opts.coverPath,
      `${profile.name} - Cover Letter - ${safeCo}.pdf`,
      `${profile.name} — Cover Letter — ${opp.company} (${opp.job_title})`,
    );
  }

  const patch: Record<string, unknown> = {
    resume_file: resumeFile,
    cover_letter_file: coverFile ?? null,
    materials_spec: opts.specPath ? basename(opts.specPath) : null,
    status: "pending_approval",
    auto_drafted: opts.autoDrafted ?? false,
  };
  if (opts.autoDrafted) {
    const note = `[${new Date().toISOString().slice(0, 10)}] Materials auto-drafted by /autopilot; review with cli edit --spec specs/${opts.specPath ? basename(opts.specPath) : "<spec>"} before submitting.`;
    // Re-attaching a corrected draft shouldn't stack duplicate notes.
    if (!opp.notes?.includes(note.slice(13))) patch.notes = [opp.notes?.trim(), note].filter(Boolean).join("\n\n");
  }
  await updateOpportunity(opportunityId, patch);

  // Local copies for submitting: <RESUMES_DIR or ~/resumes>/<Company - Team>/.
  let exportDir: string | undefined;
  const exported: string[] = [];
  if (opts.exportName) {
    exportDir = join(process.env.RESUMES_DIR ?? join(homedir(), "resumes"), opts.exportName.replace(/[\/:]/g, "-").trim());
    mkdirSync(exportDir, { recursive: true });
    if (opp.application_url) {
      const linkOut = join(exportDir, `Apply - ${safeCo}.webloc`);
      writeFileSync(linkOut, webloc(opp.application_url));
      exported.push(basename(linkOut));
    }
    if (backendName() === "directus") {
      const recordOut = join(exportDir, `Directus - ${safeCo}.webloc`);
      writeFileSync(recordOut, webloc(directusItemUrl(opportunityId)));
      exported.push(basename(recordOut));
    }
    const resumeOut = join(exportDir, `${profile.name} - Resume.pdf`);
    copyFileSync(opts.resumePath, resumeOut);
    exported.push(basename(resumeOut));
    const coverOut = join(exportDir, `${profile.name} - Cover Letter - ${safeCo}.pdf`);
    if (opts.coverPath) {
      copyFileSync(opts.coverPath, coverOut);
      exported.push(basename(coverOut));
    }
    if (opts.combined) {
      if (!opts.coverPath) throw new Error("--combined needs --cover");
      const combinedOut = join(exportDir, `${profile.name} - Resume & Cover Letter - ${safeCo}.pdf`);
      combinePdfs([resumeOut, coverOut], combinedOut);
      exported.push(basename(combinedOut));
    }
    if (opts.plaintext) {
      if (!opts.specPath) throw new Error("--plaintext needs --spec");
      const textOut = join(exportDir, "experience-plaintext.txt");
      writeFileSync(textOut, await bulletsPlaintext(opts.specPath));
      exported.push(basename(textOut));
      const letter = coverLetterPlaintext(opts.specPath);
      if (letter) {
        const letterOut = join(exportDir, "cover-letter.txt");
        writeFileSync(letterOut, letter);
        exported.push(basename(letterOut));
      }
    }
  }
  return { resumeFile, coverFile, exportDir, exported };
}

/** The opportunity's page in the Directus admin app. */
export function directusItemUrl(opportunityId: string): string {
  return `${(process.env.DIRECTUS_URL ?? "").replace(/\/+$/, "")}/admin/content/job_opportunities/${opportunityId}`;
}

/** A macOS bookmark file (.webloc): double-click opens the URL in the default browser. */
export function webloc(url: string): string {
  const esc = url.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>URL</key>
  <string>${esc}</string>
</dict>
</plist>
`;
}

/** Concatenate PDFs in order. Uses qpdf when installed, else macOS's built-in Automator join tool. */
const MAC_JOIN = "/System/Library/Automator/Combine PDF Pages.action/Contents/MacOS/join";
export function combinePdfs(inputs: string[], out: string): void {
  try {
    execFileSync("qpdf", ["--empty", "--pages", ...inputs, "--", out], { stdio: "ignore" });
    return;
  } catch {
    // qpdf not installed; fall through
  }
  if (!existsSync(MAC_JOIN)) throw new Error("Can't combine PDFs: install qpdf (brew install qpdf).");
  execFileSync(MAC_JOIN, ["--output", out, ...inputs], { stdio: "ignore" });
}

/** The spec's cover letter as plain text (greeting, paragraphs, sign-off, name), or null if it has none. */
export function coverLetterPlaintext(specPath: string): string | null {
  const cl = (JSON.parse(readFileSync(specPath, "utf8")) as SelectionSpec).coverLetter;
  if (!cl) return null;
  return [cl.greeting, ...cl.body, `${cl.signoff}\n${profile.name}`].join("\n\n") + "\n";
}

/** The spec's resume bullets as plain text, grouped "Title | Company" (for pasting into forms). */
export async function bulletsPlaintext(specPath: string): Promise<string> {
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as SelectionSpec;
  const model = await buildModel(spec);
  return (
    model.experiences
      .filter((e) => e.bullets.length > 0)
      .map((e) => [`${e.title} | ${e.company}`, ...e.bullets.map((b) => `- ${b}`)].join("\n"))
      .join("\n\n") + "\n"
  );
}
