/**
 * Spec editor: a local page (localhost only) where Carson edits a tailored spec inline and leaves notes,
 * and the AI reads them back to produce the next version. One file per spec carries the conversation:
 *   specs/feedback/<spec-name>.json   (gitignored; see FeedbackFile)
 *
 *   GET  /                the page (src/editor/index.html)
 *   GET  /api/state       { spec, labels, feedback, mtime }
 *   POST /api/save        { spec, general, notes } → writes the spec + feedback (status "submitted")
 *   POST /api/render      { spec } → renders out/resume.pdf + out/cover-letter.pdf (spec file untouched)
 *   GET  /out/<file>.pdf  the rendered PDFs, for the preview
 *
 * Round protocol: while feedback.status is not "submitted", the page's baseline is the spec on disk. On
 * save, Carson's direct edits are diffed against that baseline into `edits`, so the AI sees exactly what
 * he changed. The AI then updates the spec, writes a `reply` on each note it handled (and a `summary`),
 * and sets status "addressed"; the page picks up the new version automatically.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, join, relative, resolve } from "node:path";
import { lastFillReport, renderModel } from "../render.ts";
import { buildModel } from "../select.ts";
import type { SelectionSpec } from "../types.ts";

const PAGE = join(import.meta.dirname, "index.html");
const REPO = resolve(import.meta.dirname, "../..");

export interface FeedbackNote {
  label: string; // human-readable location, e.g. "SchoolAI bullet 3"
  text: string; // the line's text when the note was saved
  note: string; // Carson's request
  reply?: string; // the AI's answer, written when it addresses the round
}

export interface FeedbackEdit {
  key: string;
  label: string;
  change: "edited" | "removed" | "reordered";
  before?: string;
  after?: string;
}

export interface FeedbackFile {
  spec: string; // repo-relative spec path
  round: number; // increments on each submitted round
  status: "draft" | "submitted" | "addressed";
  submittedAt?: string;
  addressedAt?: string;
  general?: string; // Carson's note on the whole thing
  summary?: string; // the AI's summary of what it changed
  notes: Record<string, FeedbackNote>; // keyed by line key (see flatten)
  edits: FeedbackEdit[]; // Carson's direct edits this round, vs. the baseline
  baseline?: Record<string, string>; // flattened spec at the start of the round
  baselineOrder?: Record<string, string[]>; // bullet keys per experience at the start of the round
  baselineLabels?: Record<string, string>; // labels for the baseline lines (so removals read well)
  autoDraft?: boolean; // the spec was drafted by /autopilot (sticky, so /retro can tag these edits after approval)
}

/**
 * Every editable line in a spec, with a stable key. Bullets are keyed by sourceId so notes survive
 * reordering; everything else is positional.
 */
export function flatten(spec: SelectionSpec, expLabels: string[]): Array<{ key: string; label: string; text: string }> {
  const out: Array<{ key: string; label: string; text: string }> = [];
  if (spec.headline !== undefined) out.push({ key: "headline", label: "Headline", text: spec.headline });
  (spec.skills ?? []).forEach((s, i) => out.push({ key: `skills.${i}`, label: `Skills line ${i + 1}`, text: `${s.label}: ${s.items}` }));
  spec.experiences.forEach((e, i) => {
    const name = expLabels[i] ?? `Experience ${i + 1}`;
    out.push({ key: `exp.${i}.title`, label: `${name} title`, text: e.titleOverride ?? "" });
    e.bullets.forEach((b, j) => out.push({ key: `bullet.${b.sourceId}`, label: `${name} bullet ${j + 1}`, text: b.text }));
  });
  const cl = spec.coverLetter;
  if (cl) {
    out.push({ key: "cover.greeting", label: "Cover letter greeting", text: cl.greeting });
    cl.body.forEach((p, i) => out.push({ key: `cover.body.${i}`, label: `Cover letter paragraph ${i + 1}`, text: p }));
    out.push({ key: "cover.signoff", label: "Cover letter sign-off", text: cl.signoff });
  }
  return out;
}

function bulletOrder(spec: SelectionSpec): Record<string, string[]> {
  return Object.fromEntries(spec.experiences.map((e, i) => [`exp.${i}`, e.bullets.map((b) => `bullet.${b.sourceId}`)]));
}

function diff(fb: FeedbackFile, spec: SelectionSpec, expLabels: string[]): FeedbackEdit[] {
  const base = fb.baseline ?? {};
  const now = flatten(spec, expLabels);
  const nowMap = new Map(now.map((l) => [l.key, l]));
  const edits: FeedbackEdit[] = [];
  for (const l of now) {
    if (l.key in base && base[l.key] !== l.text) edits.push({ key: l.key, label: l.label, change: "edited", before: base[l.key], after: l.text });
  }
  for (const [key, text] of Object.entries(base)) {
    if (!nowMap.has(key)) edits.push({ key, label: fb.baselineLabels?.[key] ?? key, change: "removed", before: text });
  }
  const order = bulletOrder(spec);
  for (const [exp, keys] of Object.entries(fb.baselineOrder ?? {})) {
    const kept = keys.filter((k) => (order[exp] ?? []).includes(k));
    const nowKept = (order[exp] ?? []).filter((k) => kept.includes(k));
    if (kept.join() !== nowKept.join()) {
      const i = Number(exp.split(".")[1]);
      edits.push({ key: exp, label: `${expLabels[i] ?? exp} bullet order`, change: "reordered", after: nowKept.map((k) => nowMap.get(k)?.text.slice(0, 60) ?? k).join(" | ") });
    }
  }
  return edits;
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : {};
}

/** "Lucid Software: Sr. Frontend Engineer, Team Lead" style labels, from the resolved model. */
async function experienceLabels(spec: SelectionSpec): Promise<string[]> {
  const model = await buildModel(spec);
  return model.experiences.map((e) => `${e.company} (${e.dateRanges.join(", ")})`);
}

export function feedbackPathFor(specPath: string): string {
  return join(REPO, "specs", "feedback", basename(specPath));
}

export function startEditorServer(specArg: string, port = 4322, opts: { open?: boolean } = {}): void {
  const specPath = resolve(specArg);
  if (!existsSync(specPath)) throw new Error(`No spec at ${specArg}`);
  if (relative(join(REPO, "specs"), specPath).startsWith("..")) throw new Error("The spec must live under specs/");
  const fbPath = feedbackPathFor(specPath);
  mkdirSync(dirname(fbPath), { recursive: true });

  const readSpec = () => JSON.parse(readFileSync(specPath, "utf8")) as SelectionSpec;
  const readFeedback = (): FeedbackFile =>
    existsSync(fbPath)
      ? (JSON.parse(readFileSync(fbPath, "utf8")) as FeedbackFile)
      : { spec: relative(REPO, specPath), round: 0, status: "draft", notes: {}, edits: [] };
  const writeFeedback = (fb: FeedbackFile) => writeFileSync(fbPath, JSON.stringify(fb, null, 2) + "\n");
  const mtime = () => Math.max(statSync(specPath).mtimeMs, existsSync(fbPath) ? statSync(fbPath).mtimeMs : 0);

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(readFileSync(PAGE, "utf8"));
        return;
      }
      if (req.method === "GET" && req.url === "/api/mtime") return json(res, 200, { mtime: mtime() });
      if (req.method === "GET" && req.url === "/api/state") {
        const spec = readSpec();
        const labels = await experienceLabels(spec);
        const fb = readFeedback();
        // A new round starts from whatever is on disk now.
        if (fb.status !== "submitted") {
          fb.baseline = Object.fromEntries(flatten(spec, labels).map((l) => [l.key, l.text]));
          fb.baselineOrder = bulletOrder(spec);
          fb.baselineLabels = Object.fromEntries(flatten(spec, labels).map((l) => [l.key, l.label]));
          writeFeedback(fb);
        }
        const { baseline, baselineOrder, baselineLabels, ...visible } = fb;
        return json(res, 200, { spec, labels, feedback: visible, specName: relative(REPO, specPath), mtime: mtime() });
      }
      if (req.method === "POST" && req.url === "/api/save") {
        const { spec, general, notes, baseMtime } = (await readBody(req)) as {
          spec: SelectionSpec;
          general?: string;
          notes?: Record<string, string>;
          baseMtime?: number;
        };
        // Don't overwrite a version Claude wrote after this page loaded (Carson lost edits that way, 2026-10-06).
        if (typeof baseMtime === "number" && mtime() > baseMtime + 1)
          return json(res, 409, { error: "Claude saved a newer version after you loaded this page. Your edits are still here, unsaved." });
        const labels = await experienceLabels(spec); // also validates the spec
        const fb = readFeedback();
        const lines = new Map(flatten(spec, labels).map((l) => [l.key, l]));
        const wasSubmitted = fb.status === "submitted";
        fb.round = wasSubmitted ? fb.round : fb.round + 1;
        fb.status = "submitted";
        fb.submittedAt = new Date().toISOString();
        delete fb.summary;
        delete fb.addressedAt;
        fb.general = general?.trim() || undefined;
        fb.notes = {};
        for (const [key, note] of Object.entries(notes ?? {})) {
          if (!note?.trim()) continue;
          const l = lines.get(key);
          fb.notes[key] = { label: l?.label ?? key, text: l?.text ?? "", note: note.trim() };
        }
        fb.edits = diff(fb, spec, labels);
        if (Array.isArray(spec.autoNotes)) fb.autoDraft = true;
        writeFileSync(specPath, JSON.stringify(spec, null, 2) + "\n");
        writeFeedback(fb);
        const warnings = [...lines.values()].filter((l) => l.text.includes("—")).map((l) => `${l.label} has an em dash`);
        return json(res, 200, { ok: true, round: fb.round, notes: Object.keys(fb.notes).length, edits: fb.edits.length, warnings, mtime: mtime() });
      }
      if (req.method === "POST" && req.url === "/api/render") {
        const { spec } = (await readBody(req)) as { spec: SelectionSpec };
        renderModel(await buildModel(spec));
        return json(res, 200, { ok: true, fill: lastFillReport() });
      }
      const pdf = req.url?.match(/^\/out\/(resume|cover-letter)\.pdf/);
      if (req.method === "GET" && pdf) {
        const p = join(REPO, "out", `${pdf[1]}.pdf`);
        if (!existsSync(p)) return json(res, 404, { error: "not rendered yet" });
        res.writeHead(200, { "Content-Type": "application/pdf", "Cache-Control": "no-store" });
        res.end(readFileSync(p));
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  // A busy port (usually another spec's editor) falls through to the next one.
  const maxPort = port + 10;
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && port < maxPort) {
      console.error(`Port ${port} is busy; trying ${port + 1}.`);
      server.listen(++port, "127.0.0.1");
    } else throw err;
  });
  server.on("listening", () => {
    const url = `http://localhost:${port}`;
    console.log(`Spec editor for ${relative(REPO, specPath)} at ${url}  (Ctrl+C to stop)`);
    console.log(`Feedback file: ${relative(REPO, fbPath)}`);
    if (opts.open !== false && process.platform === "darwin") execFile("open", [url]);
  });
  server.listen(port, "127.0.0.1");
}
