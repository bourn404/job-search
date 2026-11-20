/**
 * Apply the discovery exclusions to rows already in the pipeline: title exclusions (HARD/SOFT_EXCLUDE, e.g.
 * "designer") and description deal-breakers (DESCRIPTION_EXCLUDE, e.g. "Java"). New list entries only
 * affect future discovery otherwise. Only untriaged rows (triage, new) are touched; anything Carson has acted on is left alone.
 * Hits become ai_skipped + archived, with a dated note. Discovery applies the same rule to new postings.
 */

import { descriptionExcludedBy, excludedBy } from "../config/discovery.ts";
import { fetchUntriagedRows, updateOpportunity } from "./db/index.ts";

export async function skipDealBreakers(opts: { dryRun?: boolean } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const hits = (await fetchUntriagedRows())
    .map((r) => {
      const inTitle = excludedBy(r.job_title);
      return { ...r, term: inTitle ?? descriptionExcludedBy(r.description), where: inTitle ? "title" : "description" };
    })
    .filter((r): r is typeof r & { term: string } => !!r.term);
  if (!opts.dryRun) {
    for (const h of hits) {
      const line = `[${today}] Auto-skipped: ${h.where} mentions "${h.term}".`;
      await updateOpportunity(h.id, { status: "ai_skipped", archived: true, notes: h.notes ? `${h.notes}\n\n${line}` : line });
    }
  }
  return hits;
}
