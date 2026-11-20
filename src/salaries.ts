/** Backfill empty salary_min/max from pay-transparency text in the description (never overwrites). */

import { parseSalaryRange } from "./discovery/salary.ts";
import { fetchRowsMissingSalary, updateOpportunity } from "./db/index.ts";

export async function backfillSalaries(opts: { dryRun?: boolean; includeArchived?: boolean } = {}) {
  const rows = await fetchRowsMissingSalary(!!opts.includeArchived);
  const filled = rows.flatMap((r) => {
    const pay = parseSalaryRange(r.description);
    return pay ? [{ ...r, ...pay }] : [];
  });
  if (!opts.dryRun) for (const f of filled) await updateOpportunity(f.id, { salary_min: f.min, salary_max: f.max });
  return filled;
}
