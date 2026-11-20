/**
 * Deterministic pay-range extraction from job-description text (pay-transparency boilerplate is formulaic).
 * Returns the widest USD annual span across every range found (same rule as Greenhouse pay data), or null.
 *
 * Handles "$150,000 - $200,000", "$150K–$200K", "$150,000.00 to $200,000.00", "$207000 - $300000",
 * "$149,365.00-198,500.00", "between $184,700 and $324,800", "USD 129,300 - 223,600",
 * and Amazon's trailing-currency "143,700.00 - 194,400.00 USD annually" / single "148,400.00 USD Annually".
 * Skips ranges that read as hourly, OTE/commission/sign-on, or non-USD, and any value outside
 * $30k to $2M (hourly rates, bonuses, typos).
 */

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d{5,7}|\d{2,3}(?:\.\d+)?\s?[kK])(?:\.\d{2})?`;
const CUR = String.raw`(?:US\$|\$|USD\s?)`;
const RANGE = new RegExp(String.raw`${CUR}\s?${NUM}\s*(?:-|–|—|to|and)\s*${CUR}?\s?${NUM}`, "g");
/** Currency after the numbers (Amazon): "143,700.00 - 194,400.00 USD annually", or one figure "148,400.00 USD Annually". */
const TRAILING = new RegExp(String.raw`(?<![\d,.$])${NUM}(?:\s*(?:-|–|—|to)\s*${NUM})?\s*USD\b(?=\s*(?:annual|per year|\/\s?y(?:ea)?r))`, "gi");

const MIN_ANNUAL = 30_000;
const MAX_ANNUAL = 2_000_000;

function toNumber(raw: string): number {
  const s = raw.replace(/[,\s]/g, "");
  return /k$/i.test(s) ? Math.round(parseFloat(s) * 1000) : parseFloat(s);
}

export interface PayRange {
  min: number;
  max: number;
  /** The matched text, for logging and notes. */
  source: string;
}

export function parseSalaryRange(text: string | null | undefined): PayRange | null {
  if (!text) return null;
  const t = text.replace(/ /g, " ");
  const found: PayRange[] = [];
  const matches = [...t.matchAll(RANGE), ...t.matchAll(TRAILING)];
  for (const m of matches) {
    const [whole, a, b = a] = m;
    const at = m.index ?? 0;
    const before = t.slice(Math.max(0, at - 80), at);
    const after = t.slice(at + whole.length, at + whole.length + 40);
    if (/per hour|\/\s?h(ou)?r\b|hourly|an hour/i.test(after)) continue;
    if (/\bOTE\b|on[- ]target|commission|sign[- ]on|relocation|stipend/i.test(before)) continue;
    if (/\b(CAD|CA\$|C\$|AUD|GBP|EUR|MXN|SGD|INR)\b|£|€/.test(`${before.slice(-12)}${whole}${after.slice(0, 12)}`)) continue;
    const min = toNumber(a!);
    const max = toNumber(b!);
    if (!(min >= MIN_ANNUAL && max <= MAX_ANNUAL && max >= min && max <= min * 8)) continue;
    found.push({ min, max, source: whole.trim() });
  }
  if (found.length === 0) return null;
  const min = Math.min(...found.map((r) => r.min));
  const max = Math.max(...found.map((r) => r.max));
  return { min, max, source: found.length === 1 ? found[0]!.source : `${found.length} ranges, widest span` };
}
