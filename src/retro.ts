/**
 * Retro digest — the deterministic surface for the /retro skill (the self-improvement loop).
 *
 * Claude Code saves every conversation in this repo as JSONL under ~/.claude/projects/<encoded cwd>/.
 * Those files are mostly tool output (tens of MB); what matters for improving the harness is much smaller:
 * what Carson said, what he was answering, and what he changed by hand. `buildDigest` extracts exactly that:
 * - each of Carson's typed turns (system reminders, slash-command plumbing, and tool results stripped),
 *   paired with the tail of the assistant text he was reacting to;
 * - his AskUserQuestion answers and tool-call rejections (often a correction in disguise);
 * - every spec-editor feedback file (specs/feedback/*.json): his line notes and his before/after edits,
 *   tagged "auto-draft" when the spec was produced without him (it carries `autoNotes`).
 *
 * A ledger (.claude/retro/ledger.json) remembers how far each session and feedback file has been digested,
 * so a run only covers new material; `markDigested` advances it once a retro's suggestions are handled.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sessionsDir = join(homedir(), ".claude", "projects", repoRoot.replace(/[^a-zA-Z0-9]/g, "-"));
const feedbackDir = join(repoRoot, "specs", "feedback");
const ledgerPath = join(repoRoot, ".claude", "retro", "ledger.json");
const pendingPath = join(repoRoot, ".claude", "retro", "pending-cursor.json"); // gitignored

const ASSISTANT_TAIL = 900; // chars of the assistant text Carson was reacting to
const USER_MAX = 2500; // long pastes get truncated; the point is the reaction, not the paste

interface Ledger {
  /** session id → timestamp of the last digested record */
  sessions: Record<string, string>;
  /** feedback file → `round` last digested */
  feedback: Record<string, number>;
  updatedAt?: string;
}

export interface Moment {
  session: string;
  at: string;
  kind: "message" | "answer" | "rejection";
  replyingTo: string;
  text: string;
}

export interface FeedbackDigest {
  file: string;
  round: number;
  autoDraft: boolean;
  notes: Array<{ label: string; text?: string; note: string; reply?: string }>;
  edits: Array<{ label: string; change: string; before?: string; after?: string }>;
  general?: string;
}

export interface Digest {
  generatedAt: string;
  sinceLedger: boolean;
  sessions: Array<{ id: string; started: string; moments: Moment[] }>;
  feedback: FeedbackDigest[];
  trend: Array<{ spec: string; round: number; notes: number; edits: number; autoDraft: boolean; when: string }>;
}

function readLedger(): Ledger {
  if (!existsSync(ledgerPath)) return { sessions: {}, feedback: {} };
  return JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
}

/** Strip harness plumbing from a user turn so only what Carson typed (or pasted) remains. */
function cleanUserText(s: string): string {
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, (m) => (m.startsWith("<command-name>") ? m.replace(/<\/?command-name>/g, "") + " " : ""))
    .replace(/<bash-(stdout|stderr)>[\s\S]*?<\/bash-\1>/g, "")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/^This session is being continued from a previous conversation[\s\S]*/, "") // compaction summary
    .replace(/Note: The user's next message may contain a correction[^\n]*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " […]" : s);
const tail = (s: string, n: number) => (s.length > n ? "[…] " + s.slice(-n) : s);

function textBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

function toolResultText(block: { content?: unknown }): string {
  return typeof block.content === "string" ? block.content : textBlocks(block.content);
}

function digestSession(path: string, since?: string): { id: string; started: string; moments: Moment[]; last: string } {
  const id = basename(path, ".jsonl");
  const moments: Moment[] = [];
  let assistantText = "";
  let started = "";
  let last = since ?? "";
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let r: { type?: string; isMeta?: boolean; isSidechain?: boolean; timestamp?: string; message?: { content?: unknown } };
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.isSidechain || !r.timestamp || !r.message) continue;
    if (!started) started = r.timestamp;
    if (r.timestamp > last) last = r.timestamp;
    if (r.type === "assistant") {
      const t = textBlocks(r.message.content);
      if (t.trim()) assistantText += (assistantText ? "\n" : "") + t;
      continue;
    }
    if (r.type !== "user" || r.isMeta) continue;
    const fresh = !since || r.timestamp > since;
    const content = r.message.content;
    const toolResults = Array.isArray(content) ? content.filter((b) => b?.type === "tool_result") : [];
    if (toolResults.length) {
      for (const b of toolResults) {
        const t = toolResultText(b);
        const answer = /^(Your questions have been answered|User has answered)/.test(t);
        const rejection = (b as { is_error?: boolean }).is_error === true && /^The user (doesn't|does not) want to proceed/.test(t);
        if (fresh && (answer || rejection))
          moments.push({ session: id, at: r.timestamp, kind: answer ? "answer" : "rejection", replyingTo: tail(assistantText, ASSISTANT_TAIL), text: clip(t, USER_MAX) });
      }
      continue;
    }
    const text = cleanUserText(textBlocks(content));
    if (!text) continue;
    if (fresh) moments.push({ session: id, at: r.timestamp, kind: "message", replyingTo: tail(assistantText, ASSISTANT_TAIL), text: clip(text, USER_MAX) });
    assistantText = "";
  }
  return { id, started, moments, last };
}

function digestFeedback(file: string): FeedbackDigest & { when: string } {
  const j = JSON.parse(readFileSync(join(feedbackDir, file), "utf8")) as {
    spec?: string;
    round?: number;
    general?: string;
    notes?: Record<string, { label?: string; text?: string; note?: string; reply?: string }>;
    edits?: Array<{ key?: string; label?: string; change?: string; before?: string; after?: string }>;
    addressedAt?: string;
    autoDraft?: boolean;
  };
  const specPath = join(repoRoot, j.spec ?? join("specs", file));
  let autoDraft = j.autoDraft === true;
  if (existsSync(specPath)) {
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as { autoNotes?: unknown };
    autoDraft ||= Array.isArray(spec.autoNotes);
  }
  return {
    file,
    round: j.round ?? 0,
    autoDraft,
    general: j.general || undefined,
    notes: Object.entries(j.notes ?? {}).map(([k, n]) => ({ label: n.label ?? k, text: n.text, note: n.note ?? "", reply: n.reply })),
    edits: (Array.isArray(j.edits) ? j.edits : []).map((e) => ({ label: e.label ?? e.key ?? "?", change: e.change ?? "?", before: e.before, after: e.after })),
    when: j.addressedAt ?? statSync(join(feedbackDir, file)).mtime.toISOString(),
  };
}

export function buildDigest(opts: { all?: boolean; since?: string } = {}): Digest & { cursor: Ledger } {
  const ledger = opts.all ? { sessions: {}, feedback: {} } : readLedger();
  const cursor: Ledger = { sessions: { ...ledger.sessions }, feedback: { ...ledger.feedback } };
  const sessions: Digest["sessions"] = [];
  const files = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")) : [];
  for (const f of files) {
    const id = basename(f, ".jsonl");
    const since = [ledger.sessions[id], opts.since].filter(Boolean).sort().at(-1);
    const s = digestSession(join(sessionsDir, f), since);
    cursor.sessions[id] = s.last;
    if (s.moments.length) sessions.push({ id: s.id, started: s.started, moments: s.moments });
  }
  sessions.sort((a, b) => a.started.localeCompare(b.started));

  const feedback: FeedbackDigest[] = [];
  const trend: Digest["trend"] = [];
  const fbFiles = existsSync(feedbackDir) ? readdirSync(feedbackDir).filter((f) => f.endsWith(".json")) : [];
  for (const f of fbFiles) {
    let d;
    try {
      d = digestFeedback(f);
    } catch {
      continue;
    }
    trend.push({ spec: f.replace(/\.json$/, ""), round: d.round, notes: d.notes.length, edits: d.edits.length, autoDraft: d.autoDraft, when: d.when });
    cursor.feedback[f] = d.round;
    if (ledger.feedback[f] !== undefined && ledger.feedback[f] >= d.round) continue;
    if (!d.notes.length && !d.edits.length && !d.general) continue;
    const { when: _when, ...rest } = d;
    feedback.push(rest);
  }
  trend.sort((a, b) => a.when.localeCompare(b.when));
  return { generatedAt: new Date().toISOString(), sinceLedger: !opts.all, sessions, feedback, trend, cursor };
}

/** Render the digest as compact markdown for the /retro skill to read. */
export function digestMarkdown(d: Digest): string {
  const out: string[] = [`# Retro digest (${d.generatedAt.slice(0, 10)}${d.sinceLedger ? ", new since last retro" : ", everything"})`, ""];
  const quote = (s: string) => s.split("\n").map((l) => `> ${l}`).join("\n");
  out.push(`## Conversations (${d.sessions.reduce((n, s) => n + s.moments.length, 0)} moments in ${d.sessions.length} sessions)`, "");
  for (const s of d.sessions) {
    out.push(`### Session ${s.id} (started ${s.started.slice(0, 16).replace("T", " ")})`, "");
    for (const m of s.moments) {
      out.push(`**${m.at.slice(0, 16).replace("T", " ")} · ${m.kind}**`);
      if (m.replyingTo) out.push("Claude said:", quote(m.replyingTo));
      out.push("Carson:", quote(m.text), "");
    }
  }
  out.push(`## Spec-editor feedback (${d.feedback.length} files with new notes or edits)`, "");
  for (const f of d.feedback) {
    out.push(`### ${f.file} (round ${f.round}${f.autoDraft ? ", AUTO-DRAFT corrections" : ""})`);
    if (f.general) out.push(`General note: ${f.general}`);
    for (const n of f.notes) out.push(`- NOTE on ${n.label}: ${n.note}${n.reply ? ` (Claude replied: ${clip(n.reply, 300)})` : ""}`);
    for (const e of f.edits) {
      out.push(`- EDIT ${e.change} ${e.label}`);
      if (e.before !== undefined) out.push(`  - before: ${e.before}`);
      if (e.after !== undefined) out.push(`  - after: ${e.after}`);
    }
    out.push("");
  }
  out.push("## Trend (feedback per tailored spec, oldest first)", "", "| spec | when | rounds | notes | edits | auto |", "|---|---|---|---|---|---|");
  for (const t of d.trend) out.push(`| ${t.spec} | ${t.when.slice(0, 10)} | ${t.round} | ${t.notes} | ${t.edits} | ${t.autoDraft ? "yes" : ""} |`);
  return out.join("\n") + "\n";
}

/** Remember how far a digest reached, so `markDigested` advances the ledger to exactly what was reviewed. */
export function savePendingCursor(cursor: Ledger): void {
  mkdirSync(dirname(pendingPath), { recursive: true });
  writeFileSync(pendingPath, JSON.stringify(cursor, null, 2) + "\n");
}

/** Advance the ledger to the last digest's cursor (run after the retro's suggestions are handled). */
export function markDigested(): Ledger {
  if (!existsSync(pendingPath)) throw new Error("No pending retro digest: run `retro digest` first.");
  const cursor = JSON.parse(readFileSync(pendingPath, "utf8")) as Ledger;
  writeFileSync(ledgerPath, JSON.stringify({ ...cursor, updatedAt: new Date().toISOString() }, null, 2) + "\n");
  return cursor;
}
