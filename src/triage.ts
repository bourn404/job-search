/**
 * AI triage gatekeeper.
 *
 * `listTriage` surfaces the queue (status "triage") for the AI to assess. `applyDecisions`
 * writes the AI's verdicts back. Every decision MUST carry chain_of_thought (the reasoning,
 * including why something was skipped); only keeps additionally get a match_percentage —
 * no fit score is computed for a role you're not pursuing.
 *
 *   skip → status "ai_skipped" + chain_of_thought (why), no match_percentage
 *   keep → status "new" + chain_of_thought + match_percentage (vetted & scored)
 */

import { fetchTriageQueue, updateOpportunity } from "./db/index.ts";
import type { TriageItem } from "./types.ts";

export interface Decision {
  id: string;
  decision: "skip" | "keep";
  /** Required for ALL decisions: the reasoning (for a skip, why it was dropped). */
  chainOfThought?: string;
  /** Required for "keep" only: 0–100 fit score. Never set for a skip. */
  matchPercentage?: number;
  /** Optional extras for kept roles. */
  summary?: string;
  remote?: "fully_remote" | "hybrid" | "on_site";
  /** Annual salary range read from the JD when not already populated (structured ATS fields
   *  fill it at discovery; for Greenhouse/prose salary the AI extracts it here). */
  salaryMin?: number;
  salaryMax?: number;
  notes?: string;
}

export interface ApplyResult {
  kept: number;
  skipped: number;
  errors: string[];
}

export async function listTriage(): Promise<TriageItem[]> {
  return fetchTriageQueue();
}

export async function applyDecisions(decisions: Decision[]): Promise<ApplyResult> {
  const result: ApplyResult = { kept: 0, skipped: 0, errors: [] };

  for (const d of decisions) {
    try {
      if (!d.chainOfThought?.trim()) {
        throw new Error("every decision requires chainOfThought");
      }
      if (d.decision === "skip") {
        // Reasoning, yes; fit score, no (clear any prior score).
        await updateOpportunity(d.id, {
          status: "ai_skipped",
          chain_of_thought: d.chainOfThought,
          match_percentage: null,
        });
        result.skipped++;
      } else if (d.decision === "keep") {
        if (typeof d.matchPercentage !== "number" || d.matchPercentage < 0 || d.matchPercentage > 100) {
          throw new Error("keep requires matchPercentage (0–100)");
        }
        const patch: Record<string, unknown> = {
          status: "new",
          match_percentage: Math.round(d.matchPercentage),
          chain_of_thought: d.chainOfThought,
        };
        if (d.summary) patch.summary = d.summary;
        if (d.remote) patch.remote = d.remote;
        if (typeof d.salaryMin === "number") patch.salary_min = Math.round(d.salaryMin);
        if (typeof d.salaryMax === "number") patch.salary_max = Math.round(d.salaryMax);
        if (d.notes) patch.notes = d.notes;
        await updateOpportunity(d.id, patch);
        result.kept++;
      } else {
        throw new Error(`unknown decision "${(d as { decision: string }).decision}"`);
      }
    } catch (err) {
      result.errors.push(`${d.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
