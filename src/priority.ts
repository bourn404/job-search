/**
 * Recompute `match_bonus` for every non-archived opportunity (rules in config/priority.ts). Runs at the end
 * of each non-dry-run `discover`, and standalone via `cli bonus`. Writes only rows whose score changed,
 * grouped by score so it's a handful of batch requests.
 */

import { BONUS_RULES, matchBonus } from "../config/priority.ts";
import { fetchBonusRows, updateOpportunities } from "./db/index.ts";

export interface BonusReport {
  scored: number;
  changed: number;
  distribution: Record<number, number>;
  ruleHits: Record<string, number>;
  dryRun: boolean;
}

export async function recomputeMatchBonus(opts: { dryRun?: boolean; now?: Date } = {}): Promise<BonusReport> {
  const now = opts.now ?? new Date();
  const rows = await fetchBonusRows();
  const byScore = new Map<number, string[]>();
  const distribution: Record<number, number> = {};
  const ruleHits: Record<string, number> = Object.fromEntries(BONUS_RULES.map((r) => [r.key, 0]));
  let changed = 0;

  for (const row of rows) {
    const { total, hits } = matchBonus(row, now);
    distribution[total] = (distribution[total] ?? 0) + 1;
    for (const k of Object.keys(hits)) ruleHits[k] = (ruleHits[k] ?? 0) + 1;
    if ((row.match_bonus ?? 0) !== total || row.match_bonus == null) {
      changed++;
      if (!byScore.has(total)) byScore.set(total, []);
      byScore.get(total)!.push(row.id);
    }
  }

  if (!opts.dryRun) {
    for (const [score, ids] of byScore) {
      for (let i = 0; i < ids.length; i += 200) await updateOpportunities(ids.slice(i, i + 200), { match_bonus: score });
    }
  }
  return { scored: rows.length, changed, distribution, ruleHits, dryRun: !!opts.dryRun };
}

export function formatBonusReport(r: BonusReport): string {
  const dist = Object.entries(r.distribution)
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([s, n]) => `+${s}: ${n}`)
    .join(", ");
  const rules = BONUS_RULES.map((rule) => `${rule.key} ${r.ruleHits[rule.key] ?? 0}`).join(", ");
  return (
    `Match bonus: scored ${r.scored} active opportunities, ${r.changed} ${r.dryRun ? "would change" : "updated"}.\n` +
    `  distribution: ${dist}\n  rule hits: ${rules}`
  );
}
