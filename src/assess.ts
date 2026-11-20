/**
 * Materials-confidence assessment — the deterministic surface for the /assess skill (and /autopilot).
 *
 * The AI reads each `interested` role against the bullet pool, past approved letters, and company briefs,
 * and scores 0–100 how confident it is that it could produce materials Carson would approve without his
 * input. `listAssessQueue` surfaces the rows to score; `applyAssessments` writes the scores and reasoning
 * back (`materials_confidence`, `materials_assessment`), or archives a row whose posting has closed.
 */

import { fetchInterestedQueue, fetchOpportunity, updateOpportunity, type InterestedItem } from "./db/index.ts";

export interface Assessment {
  id: string;
  /** 0–100. Omit only with `archive`. */
  confidence?: number;
  /** Rubric breakdown, gaps, and the questions only Carson can answer. */
  assessment?: string;
  /** Set to archive the row instead (e.g. "posting closed"); recorded in notes. */
  archive?: string;
}

export interface AssessResult {
  scored: number;
  archived: number;
  errors: string[];
}

/** Interested, unarchived rows still without a score (all of them with `rescore`), highest score first. */
export async function listAssessQueue(opts: { rescore?: boolean } = {}): Promise<InterestedItem[]> {
  const rows = await fetchInterestedQueue();
  return opts.rescore ? rows : rows.filter((r) => r.materials_confidence === null);
}

export async function applyAssessments(items: Assessment[], opts: { dryRun?: boolean } = {}): Promise<AssessResult> {
  const result: AssessResult = { scored: 0, archived: 0, errors: [] };
  const today = new Date().toISOString().slice(0, 10);
  for (const a of items) {
    try {
      if (a.archive) {
        const opp = await fetchOpportunity(a.id);
        const notes = [opp.notes?.trim(), `[${today}] Archived by /assess: ${a.archive}`].filter(Boolean).join("\n\n");
        if (!opts.dryRun) await updateOpportunity(a.id, { status: "skipped", archived: true, notes });
        result.archived++;
        continue;
      }
      if (typeof a.confidence !== "number" || a.confidence < 0 || a.confidence > 100) throw new Error("confidence (0–100) required");
      if (!a.assessment?.trim()) throw new Error("assessment (the reasoning) required");
      if (!opts.dryRun)
        await updateOpportunity(a.id, { materials_confidence: Math.round(a.confidence), materials_assessment: `[${today}] ${a.assessment.trim()}` });
      result.scored++;
    } catch (err) {
      result.errors.push(`${a.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
