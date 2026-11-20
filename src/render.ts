/** Deterministic render: write the model to JSON, then shell out to a pinned Typst. */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lintModel } from "./lint.ts";
import type { RenderKind, RenderModel } from "./types.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where one render writes its scratch files and PDFs. A slug gives build/<slug>/ + out/<slug>/, so parallel renders don't collide. */
interface Dirs { build: string; out: string; data: string }

function dirsFor(slug?: string): Dirs {
  if (slug && !/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`--out-dir must be a kebab-case slug, got "${slug}"`);
  const sub = slug ? [slug] : [];
  return {
    build: join(repoRoot, "build", ...sub),
    out: join(repoRoot, "out", ...sub),
    data: ["", "build", ...sub, "data.json"].join("/"), // root-relative path the template reads
  };
}

type DocKind = "resume" | "cover-letter";

const TEMPLATE: Record<DocKind, { path: string; fn: string }> = {
  resume: { path: "/templates/resume.typ", fn: "resume" },
  "cover-letter": { path: "/templates/cover-letter.typ", fn: "coverLetter" },
};

function compileDoc(docKind: DocKind, model: RenderModel, outPath: string, dirs: Dirs): string {
  mkdirSync(dirs.build, { recursive: true });
  mkdirSync(dirname(outPath), { recursive: true });

  // Single shared data file; templates read it via an absolute (root-relative) path.
  writeFileSync(join(dirs.build, "data.json"), JSON.stringify(model, null, 2));

  const t = TEMPLATE[docKind];
  const main = `#import "${t.path}": ${t.fn}\n#${t.fn}(json("${dirs.data}"))\n`;
  writeFileSync(join(dirs.build, "main.typ"), main);

  execFileSync(
    "typst",
    ["compile", "--root", repoRoot, join(dirs.build, "main.typ"), outPath],
    { stdio: "inherit" },
  );
  if (docKind === "resume") reportFill(outPath, model, dirs);
  return outPath;
}

/** PDF MediaBox height in points (from the just-rendered file). */
function pdfHeightPt(path: string): number | null {
  const m = readFileSync(path, "latin1").match(/\/MediaBox\s*\[([^\]]+)\]/);
  if (!m) return null;
  const n = m[1]!.trim().split(/\s+/).map(Number);
  return n.length === 4 ? n[3]! - n[1]! : null;
}

/**
 * Space-fill + layout feedback for the resume. Reads three invisible probes from the template:
 * - <fill-probe>: page and y where content ends (vertical room left, or how far it spills);
 * - <line-probe>: where each skills line / bullet starts and ends (real line counts);
 * - <line-stats>: a replay of Typst's greedy wrapping giving each item's last line and how full
 *   it is, so we can flag one- or two-word last lines and wrapped skills lines.
 * Prints a short report and writes build/layout.json for tooling.
 */
let lastFill: string | null = null;

/** The most recent resume fill report (for the spec editor), without the leading arrow. */
export function lastFillReport(): string | null {
  return lastFill;
}

interface LineProbe { edge: "start" | "end"; i: number; j: number; page: number; y: number }
interface LineStat { i: number; j: number; lines: number; last: string; frac: number }
export interface LayoutItem {
  section: "skills" | "bullet";
  i: number; // experience index (-1 for skills)
  j: number; // item index within the section/experience
  lines: number;
  lastLine: string;
  lastLineFill: number; // 0..1 share of the line width the last line uses
  orphan: boolean; // multi-line with a near-empty last line (one or two words)
  savable: boolean; // multi-line whose last line is short enough that a small trim saves a line
}

// Last-line fill below this reads as an orphan (about two short words on an 11pt line).
const ORPHAN_FILL = 0.2;
// Last-line fill below this means trimming a few words would save a whole line.
const SAVABLE_FILL = 0.35;

function query<T>(label: string, dirs: Dirs): T[] {
  const out = execFileSync(
    "typst",
    ["query", "--root", repoRoot, join(dirs.build, "main.typ"), label, "--field", "value"],
    { encoding: "utf8" },
  );
  return JSON.parse(out) as T[];
}

function reportFill(outPath: string, model: RenderModel, dirs: Dirs): void {
  lastFill = null;
  try {
    const probe = query<{ page: number; y: number }>("<fill-probe>", dirs).at(-1);
    if (!probe) return;

    const h = pdfHeightPt(outPath);
    // Line advance (pt) from the probes: a single-line item spans dmin; each extra line adds `step`.
    const probes = query<LineProbe>("<line-probe>", dirs);
    const stats = query<LineStat>("<line-stats>", dirs);
    const key = (i: number, j: number) => `${i}:${j}`;
    const span = new Map<string, number>();
    for (const p of probes) {
      const k = key(p.i, p.j);
      if (p.edge === "start") span.set(k, -p.y - p.page * 10000);
      else span.set(k, (span.get(k) ?? 0) + p.y + p.page * 10000);
    }
    const spans = [...span.values()].filter((d) => d >= 0 && d < 1000);
    const dmin = Math.min(...spans);
    const extras = spans.map((d) => d - dmin).filter((d) => d > 3);
    const step = extras.length ? Math.min(...extras) : 13;

    const items: LayoutItem[] = stats.map((s) => {
      const d = span.get(key(s.i, s.j));
      const measured = d != null && d >= 0 && d < 1000 ? 1 + Math.round((d - dmin) / step) : s.lines;
      const lines = Math.max(measured, s.lines);
      return {
        section: s.i < 0 ? "skills" : "bullet",
        i: s.i,
        j: s.j,
        lines,
        lastLine: s.last,
        lastLineFill: Number(s.frac.toFixed(2)),
        orphan: lines > 1 && s.frac < ORPHAN_FILL,
        savable: lines > 1 && s.frac < SAVABLE_FILL,
      };
    });

    let summary: string;
    let linesOff = 0; // >0: room for this many more lines; <0: this many lines over
    if (probe.page > 1) {
      // Spill ≈ content height on page 2. Trailing sections move as a block, so this can run a line
      // high, which is the safer direction (trim, re-render, and the report updates).
      const topMargin = 0.4 * 72;
      linesOff = -Math.max(1, Math.ceil((probe.y - topMargin) / step) + (probe.page - 2) * 50);
      summary = `⚠ runs onto ${probe.page} pages, about ${-linesOff} line${linesOff === -1 ? "" : "s"} over (an estimate; trim the top candidates and re-render).`;
    } else if (h) {
      const gapIn = (h - probe.y) / 72; // empty space below content
      const freeIn = gapIn - 0.4; // beyond the ~0.4in target bottom margin
      let hint = " — nicely filled.";
      if (freeIn > 0.25) {
        linesOff = Math.max(1, Math.floor((freeIn * 72) / step));
        hint = ` — room for ~${linesOff} more line${linesOff === 1 ? "" : "s"}; add a bullet or lengthen one.`;
      } else if (freeIn < -0.05) {
        hint = " — tight; trim a line if anything spills.";
      }
      summary = `1 page, ${gapIn.toFixed(2)} in below content${hint}`;
    } else {
      summary = `1 page.`;
    }

    const orphans = items.filter((x) => x.orphan && x.section === "bullet");
    const wrappedSkills = items.filter((x) => x.section === "skills" && x.lines > 1);
    // When over the page, the cheapest lines to win back: multi-line bullets with the emptiest last lines.
    const trimCandidates = items
      .filter((x) => x.section === "bullet" && x.lines > 1 && !x.orphan)
      .sort((a, b) => a.lastLineFill - b.lastLineFill)
      .slice(0, Math.max(0, -linesOff) + 1);
    const issues = orphans.length + wrappedSkills.length;
    if (issues) summary += ` ⚠ ${issues} layout issue${issues === 1 ? "" : "s"} (see below).`;
    lastFill = summary;
    console.log(`  ↳ fill: ${summary}`);

    const label = (x: LayoutItem) => {
      if (x.section === "skills") return `Skills "${model.skills[x.j]?.label ?? x.j + 1}"`;
      const e = model.experiences[x.i];
      const text = e?.bullets[x.j] ?? "";
      return `${e?.company ?? `experience ${x.i + 1}`} bullet ${x.j + 1} ("${text.split(/\s+/).slice(0, 5).join(" ")}...")`;
    };
    for (const x of wrappedSkills) console.log(`    ⚠ ${label(x)} wraps to ${x.lines} lines (last: "${x.lastLine}")`);
    for (const x of orphans)
      console.log(`    ⚠ ${label(x)} ends on a near-empty line (${Math.round(x.lastLineFill * 100)}%): "${x.lastLine}"`);
    if (linesOff < 0)
      for (const x of trimCandidates)
        console.log(`    ✂ ${label(x)}: trim ~${x.lastLine.split(/\s+/).length} words to save a line (last line: "${x.lastLine}")`);

    writeFileSync(join(dirs.build, "layout.json"), JSON.stringify({ summary, linesOff, lineStepPt: Number(step.toFixed(2)), items }, null, 2));
  } catch {
    // probes are optional; ignore if a query fails
  }
}

function kindsFor(kind: RenderKind): DocKind[] {
  if (kind === "both") return ["resume", "cover-letter"];
  return [kind];
}

/**
 * Render the model to one or more PDFs. Returns the written file paths.
 * For `both`, always writes out/resume.pdf and out/cover-letter.pdf (out/<outDir>/… with `outDir`).
 * For a single kind, honors `out` if provided, else out/<kind>.pdf.
 */
export function renderModel(model: RenderModel, opts: { out?: string; outDir?: string } = {}): string[] {
  const dirs = dirsFor(opts.outDir);
  const kinds = kindsFor(model.kind);
  if (kinds.includes("cover-letter") && !model.coverLetter) {
    throw new Error("kind requires a cover letter, but model.coverLetter is missing");
  }
  const written = kinds.map((k) => {
    const single = model.kind !== "both" && opts.out;
    const outPath = single ? resolve(opts.out!) : join(dirs.out, `${k}.pdf`);
    return compileDoc(k, model, outPath, dirs);
  });
  lastLint = lintModel(model);
  console.log(lastLint.length ? `  ↳ lint: ${lastLint.length} warning(s)` : "  ↳ lint: clean");
  for (const w of lastLint) console.log(`    ⚠ ${w}`);
  return written;
}

let lastLint: string[] = [];

/** Voice/spec lint warnings from the most recent render (for the spec editor). */
export function lastLintWarnings(): string[] {
  return lastLint;
}
