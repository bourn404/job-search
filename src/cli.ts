#!/usr/bin/env tsx
/**
 * CLI entrypoint.
 *
 *   render --spec <file.json> [--out <path>] [--out-dir <slug>]  Resolve a selection spec against the
 *                                                database, then render PDF(s).
 *   render --model <file.json> [--out <path>]   Render a pre-built RenderModel
 *                                                directly (no database; for tests).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { buildModel } from "./select.ts";
import { renderModel } from "./render.ts";
import { discover, type DiscoverProgress, type SiteResult } from "./discovery/discover.ts";
import { applyDecisions, listTriage, type Decision } from "./triage.ts";
import { attachMaterials, buildContext, listInterested } from "./tailor.ts";
import { addInterested, fetchPosting, type IntakeInput } from "./intake.ts";
import { applyBulletChanges, buildGapsContext, type BulletChanges } from "./bullets.ts";
import { formatBonusReport, recomputeMatchBonus } from "./priority.ts";
import { startReviewServer } from "./review/server.ts";
import { startEditorServer } from "./editor/server.ts";
import { enrichSite, sitesForProvider } from "./enrich.ts";
import { archiveClosed, checkOpen } from "./liveness.ts";
import { skipDealBreakers } from "./dealbreakers.ts";
import { backfillSalaries } from "./salaries.ts";
import { buildDigest, digestMarkdown, markDigested, savePendingCursor } from "./retro.ts";
import { applyAssessments, listAssessQueue, type Assessment } from "./assess.ts";
import { backendName } from "./db/index.ts";
import { dbPath, dbStatus, importSeed, runSql } from "./db/sqlite.ts";
import type { RenderModel, SelectionSpec } from "./types.ts";

// Load .env if present (Node >= 20.6 has process.loadEnvFile).
try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env");
} catch {
  // No .env file; rely on ambient environment. Only needed for --spec.
}

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    }
  }
  return flags;
}

async function cmdRender(flags: Record<string, string>): Promise<void> {
  let model: RenderModel;
  if (flags.model) {
    model = JSON.parse(readFileSync(flags.model, "utf8")) as RenderModel;
  } else if (flags.spec) {
    const spec = JSON.parse(readFileSync(flags.spec, "utf8")) as SelectionSpec;
    model = await buildModel(spec);
  } else {
    throw new Error("render requires --spec <file> or --model <file>");
  }
  const written = renderModel(model, { out: flags.out, outDir: flags["out-dir"] });
  for (const p of written) console.log(`Wrote ${p}`);
}

function formatSiteResult(r: SiteResult): string {
  if (r.error) return `✗ ${r.site} [${r.adapter ?? r.provider}] — error: ${r.error}`;
  if (r.skipped) return `– ${r.site} — skipped: ${r.skipped}`;
  const dropped = [r.agedOut && `${r.agedOut} older than max age`, r.wrongCountry && `${r.wrongCountry} outside allowed countries`].filter(Boolean).join(", ");
  const pay = r.payParsed ? `, pay parsed for ${r.payParsed}` : "";
  const dealBreakers = r.descExcluded ? ` (+${r.descExcluded} auto-skipped for description deal-breakers)` : "";
  const detail = r.detailed ? ` → ${r.detailed} detailed${dropped ? ` (${dropped})` : ""}` : "";
  return `✓ ${r.site} [${r.adapter}] — ${r.found} found → ${r.matched} matched${detail} → ${r.created} new${dealBreakers}${pay}`;
}

/** Live discover progress: a rewritten status line on a TTY (stderr), one result line per site as it finishes. */
function discoverProgressPrinter(): (e: DiscoverProgress) => void {
  const tty = process.stderr.isTTY;
  const status = (text: string) => {
    if (tty) process.stderr.write(`\r\x1b[2K${text}`);
  };
  return (e) => {
    const step = `[${e.index + 1}/${e.total}]`;
    if (e.kind === "site") status(`${step} ${e.site}: fetching postings…`);
    else if (e.kind === "detail") status(`${step} ${e.site}: details ${e.done}/${e.of}`);
    else {
      status("");
      console.log(`${step} ${formatSiteResult(e.result)}`);
    }
  };
}

async function cmdDiscover(flags: Record<string, string>): Promise<void> {
  const results = await discover({
    site: flags.site,
    all: flags.all === "true",
    dryRun: flags["dry-run"] === "true",
    noFilter: flags["no-filter"] === "true",
    maxAgeDays: flags["max-age"] ? Number(flags["max-age"]) : undefined,
    onProgress: discoverProgressPrinter(),
  });
  if (results.length === 0) {
    console.log("No sites matched (none enabled+due, or no name match).");
    return;
  }
  const totalCreated = results.reduce((n, r) => n + (r.error || r.skipped ? 0 : r.created), 0);
  const failed = results.filter((r) => r.error).length;
  const errors = failed ? `, ${failed} site${failed === 1 ? "" : "s"} errored` : "";
  console.log(`\n${totalCreated} new opportunit${totalCreated === 1 ? "y" : "ies"} from ${results.length} site${results.length === 1 ? "" : "s"}${errors}${flags["dry-run"] === "true" ? " (dry run, not written)" : ""}.`);
  if (flags["dry-run"] === "true") return;
  // After every real run: archive closed postings + deal-breakers, then re-score priority
  // (new rows + time-based rules like "listed in the last 7 days"). --no-cleanup skips the first two.
  if (flags["no-cleanup"] === "true") console.log(formatBonusReport(await recomputeMatchBonus()));
  else {
    console.log("\nCleanup:");
    await cmdCleanup({});
  }
}

async function cmdCheckOpen(flags: Record<string, string>): Promise<void> {
  const results = await checkOpen({
    hostFilter: flags.host,
    onProgress: (d, t) => d % 50 === 0 && console.error(`  checked ${d}/${t}`),
  });
  const count = (v: string) => results.filter((r) => r.verdict === v).length;
  console.log(`Checked ${results.length}: ${count("open")} open, ${count("closed")} closed, ${count("unknown")} unknown.`);
  for (const v of ["closed", "unknown"] as const) {
    const rows = results.filter((r) => r.verdict === v);
    if (rows.length) console.log(`\n${v.toUpperCase()}:`);
    for (const r of rows) console.log(`  [${r.row.status}] ${r.row.company}: ${r.row.job_title}  (${r.reason})`);
  }
  if (flags["dry-run"] === "true") console.log("\nDry run: nothing archived.");
  else console.log(`\nArchived ${await archiveClosed(results)} closed posting(s).`);
}

async function cmdDealbreakers(flags: Record<string, string>): Promise<void> {
  const dry = flags["dry-run"] === "true";
  const hits = await skipDealBreakers({ dryRun: dry });
  for (const h of hits) console.log(`  [${h.status}] ${h.company}: ${h.job_title}  (${h.where}: "${h.term}")`);
  console.log(`${hits.length} untriaged row(s) ${dry ? "would be" : ""} auto-skipped + archived by title exclusions / description deal-breakers.`.replace("  ", " "));
}

/** check-open → dealbreakers → bonus. Runs at the end of every real discover too. */
async function cmdCleanup(flags: Record<string, string>): Promise<void> {
  await cmdCheckOpen(flags);
  await cmdDealbreakers(flags);
  console.log(formatBonusReport(await recomputeMatchBonus({ dryRun: flags["dry-run"] === "true" })));
}

async function cmdTriage(flags: Record<string, string>): Promise<void> {
  if (flags.apply) {
    const parsed = JSON.parse(readFileSync(flags.apply, "utf8")) as { decisions: Decision[] };
    const r = await applyDecisions(parsed.decisions ?? []);
    console.log(`Applied: ${r.kept} kept (→ new, scored), ${r.skipped} skipped (→ ai_skipped).`);
    for (const e of r.errors) console.log(`  ✗ ${e}`);
  } else {
    // List the queue as JSON for assessment.
    const queue = await listTriage();
    console.log(JSON.stringify(queue, null, 2));
    console.error(`\n${queue.length} opportunit${queue.length === 1 ? "y" : "ies"} awaiting triage.`);
  }
}

async function cmdTailor(rest: string[]): Promise<void> {
  const action = rest[0];
  const id = rest[1] && !rest[1].startsWith("--") ? rest[1] : undefined;
  const flags = parseFlags(rest);
  switch (action) {
    case "list": {
      const q = await listInterested();
      for (const o of q) {
        const conf = o.materials_confidence === null ? "  –" : String(o.materials_confidence).padStart(3);
        console.log(`${o.id}  ${conf}${o.auto_drafted ? " auto" : ""}  ${o.company} — ${o.job_title}`);
      }
      console.error(`\n${q.length} opportunit${q.length === 1 ? "y" : "ies"} flagged interested (awaiting materials).`);
      break;
    }
    case "context": {
      if (!id) throw new Error("tailor context <opportunity-id>");
      const ctx = await buildContext(id);
      console.log(JSON.stringify(ctx, null, 2));
      if (ctx.postingLive.live === false) console.error(`\n⚠ Posting looks CLOSED (${ctx.postingLive.detail}). Confirm with Carson before tailoring.`);
      else if (ctx.postingLive.live === null) console.error(`\nPosting liveness unknown (${ctx.postingLive.detail ?? ctx.postingLive.via}).`);
      if (ctx.priorLetters.length) console.error(`${ctx.priorLetters.length} earlier letter(s) to ${ctx.opportunity.company}: see priorLetters.`);
      break;
    }
    case "attach": {
      if (!id) throw new Error("tailor attach <opportunity-id> --resume <pdf> [--cover <pdf>] [--spec <path>]");
      if (!flags.resume) throw new Error("tailor attach requires --resume <pdf>");
      const r = await attachMaterials(id, {
        resumePath: flags.resume,
        coverPath: flags.cover,
        specPath: flags.spec,
        exportName: flags.export,
        combined: flags.combined === "true",
        plaintext: flags.plaintext === "true",
        autoDrafted: flags.auto === "true",
      });
      console.log(`Attached resume${r.coverFile ? " + cover letter" : ""} → opportunity ${id} set to pending_approval${flags.auto === "true" ? " (auto-drafted)" : ""}.`);
      if (r.exportDir) console.log(`Copied to ${r.exportDir}: ${r.exported.join(", ")}`);
      break;
    }
    default:
      console.error("Usage: cli tailor list | context <id> | attach <id> --resume <pdf> [--cover <pdf>] [--spec <path>] [--export <Company - Team>] [--combined] [--plaintext] [--auto]");
      process.exit(1);
  }
}

async function cmdIntake(rest: string[]): Promise<void> {
  const action = rest[0];
  const flags = parseFlags(rest);
  switch (action) {
    case "fetch": {
      const url = rest[1];
      if (!url || url.startsWith("--")) throw new Error("intake fetch <job-listing-url>");
      console.log(JSON.stringify(await fetchPosting(url), null, 2));
      break;
    }
    case "add": {
      if (!flags.json) throw new Error("intake add --json <file> [--force]");
      const input = JSON.parse(readFileSync(flags.json, "utf8")) as IntakeInput;
      const r = await addInterested(input, { force: flags.force === "true" });
      console.log(
        r.action === "created"
          ? `Created opportunity ${r.id} as interested.`
          : `Revived existing opportunity ${r.id} (was ${r.previousStatus}) → interested, unarchived.`,
      );
      break;
    }
    default:
      console.error("Usage: cli intake fetch <url> | add --json <file> [--force]");
      process.exit(1);
  }
}

async function cmdBullets(rest: string[]): Promise<void> {
  const action = rest[0];
  const flags = parseFlags(rest);
  switch (action) {
    case "context": {
      const ctx = await buildGapsContext();
      const json = JSON.stringify(ctx, null, 2);
      if (flags.out) {
        writeFileSync(flags.out, json);
        const c = ctx.scope.counts;
        console.log(
          `Wrote ${flags.out}: ${c.withDescription} interested opportunities with descriptions, ` +
            `${c.skippedNoDescription} skipped without a description; ${ctx.experiences.reduce((n, e) => n + e.bullets.length, 0)} bullets, ` +
            `${ctx.skills.reduce((n, g) => n + g.items.length, 0)} skills.`,
        );
      } else {
        console.log(json);
      }
      break;
    }
    case "apply": {
      if (!flags.json) throw new Error("bullets apply --json <file> [--dry-run]");
      const changes = JSON.parse(readFileSync(flags.json, "utf8")) as BulletChanges;
      const r = await applyBulletChanges(changes, { dryRun: flags["dry-run"] === "true" });
      for (const w of r.warnings) console.log(`  ! ${w}`);
      for (const e of r.errors) console.log(`  ✗ ${e}`);
      if (r.errors.length) {
        console.log("Nothing written (fix the errors above).");
        process.exit(1);
      }
      console.log(
        r.dryRun
          ? "Dry run OK: nothing written."
          : `Wrote ${r.added} new bullet(s), ${r.updated} reworded bullet(s), ${r.variantsAdded} variant(s), ${r.creditsSet} credit(s), ${r.skillsAdded} new skill(s).`,
      );
      break;
    }
    default:
      console.error("Usage: cli bullets context [--out <file>] | apply --json <file> [--dry-run]");
      process.exit(1);
  }
}

async function cmdAssess(rest: string[]): Promise<void> {
  const action = rest[0];
  const flags = parseFlags(rest);
  switch (action) {
    case "list": {
      const q = await listAssessQueue({ rescore: flags.rescore === "true" });
      console.log(JSON.stringify(q.map(({ description: _d, ...r }) => r), null, 2));
      console.error(`\n${q.length} interested role(s) to assess.`);
      break;
    }
    case "apply": {
      if (!flags.json) throw new Error("assess apply --json <file> [--dry-run]");
      const parsed = JSON.parse(readFileSync(flags.json, "utf8")) as { assessments: Assessment[] };
      const r = await applyAssessments(parsed.assessments ?? [], { dryRun: flags["dry-run"] === "true" });
      console.log(`${flags["dry-run"] === "true" ? "Dry run: would score" : "Scored"} ${r.scored}, archived ${r.archived}.`);
      for (const e of r.errors) console.log(`  ✗ ${e}`);
      if (r.errors.length) process.exit(1);
      break;
    }
    default:
      console.error("Usage: cli assess list [--rescore] | apply --json <file> [--dry-run]");
      process.exit(1);
  }
}

function cmdRetro(rest: string[]): void {
  const action = rest[0];
  const flags = parseFlags(rest);
  switch (action) {
    case "digest": {
      if (!flags.out) throw new Error("retro digest --out <file.md> [--all] [--since <YYYY-MM-DD>]");
      const d = buildDigest({ all: flags.all === "true", since: flags.since });
      writeFileSync(flags.out, digestMarkdown(d));
      savePendingCursor(d.cursor);
      const moments = d.sessions.reduce((n, s) => n + s.moments.length, 0);
      console.log(`Wrote ${flags.out}: ${moments} conversation moment(s) in ${d.sessions.length} session(s), ${d.feedback.length} feedback file(s) with new notes/edits.`);
      break;
    }
    case "mark": {
      const c = markDigested();
      console.log(`Ledger advanced: ${Object.keys(c.sessions).length} session(s), ${Object.keys(c.feedback).length} feedback file(s).`);
      break;
    }
    default:
      console.error("Usage: cli retro digest --out <file.md> [--all] [--since <YYYY-MM-DD>] | mark");
      process.exit(1);
  }
}

/** `cli db`: the local SQLite store (status, seed import, ad-hoc SQL). */
function cmdDb(rest: string[]): void {
  const action = rest[0];
  const flags = parseFlags(rest);
  const requireSqlite = () => {
    if (backendName() !== "sqlite") throw new Error(`cli db ${action} works on the SQLite backend; this environment uses ${backendName()} (unset DIRECTUS_URL or set DB_BACKEND=sqlite).`);
  };
  switch (action) {
    case "status":
    case "init": {
      if (backendName() !== "sqlite") {
        console.log(`Backend: ${backendName()} (cli db only manages the SQLite store at ${dbPath()}).`);
        break;
      }
      const s = dbStatus();
      console.log(`Backend: sqlite  ${s.path}`);
      for (const [t, n] of Object.entries(s.counts)) console.log(`  ${t.padEnd(18)} ${n}`);
      break;
    }
    case "import": {
      requireSqlite();
      if (!flags.json) throw new Error("db import --json <seed.json>");
      const loaded = importSeed(JSON.parse(readFileSync(flags.json, "utf8")) as Record<string, unknown>);
      const parts = Object.entries(loaded).map(([t, n]) => `${n} ${t}`);
      console.log(parts.length ? `Upserted ${parts.join(", ")}.` : "Nothing to import.");
      break;
    }
    case "sql": {
      requireSqlite();
      const sql = rest.slice(1).filter((a) => !a.startsWith("--")).join(" ");
      if (!sql) throw new Error('db sql "<statement>"');
      console.log(JSON.stringify(runSql(sql), null, 2));
      break;
    }
    default:
      console.error('Usage: cli db status | import --json <seed.json> | sql "<statement>"');
      process.exit(1);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (command) {
    case "render":
      await cmdRender(flags);
      break;
    case "discover":
      await cmdDiscover(flags);
      break;
    case "triage":
      await cmdTriage(flags);
      break;
    case "tailor":
      await cmdTailor(rest);
      break;
    case "intake":
      await cmdIntake(rest);
      break;
    case "bullets":
      await cmdBullets(rest);
      break;
    case "retro":
      cmdRetro(rest);
      break;
    case "assess":
      await cmdAssess(rest);
      break;
    case "review":
      startReviewServer(flags.port ? Number(flags.port) : undefined);
      return; // keep the process alive for the server
    case "edit":
      if (!flags.spec) throw new Error("edit --spec <specs/file.json> [--port 4322] [--no-open]");
      startEditorServer(flags.spec, flags.port ? Number(flags.port) : undefined, { open: flags["no-open"] !== "true" });
      return;
    case "enrich": {
      if (!flags.site && !flags.provider) throw new Error("enrich --site <name> | --provider <greenhouse|workday|...> [--include-archived] [--dry-run]");
      const names = flags.site ? [flags.site] : await sitesForProvider(flags.provider!);
      let total = 0;
      for (const name of names) {
        try {
          const r = await enrichSite({ site: name, includeArchived: flags["include-archived"] === "true", dryRun: flags["dry-run"] === "true" });
          total += r.changed;
          console.log(`${r.site}: ${r.rows} rows, ${r.changed} ${r.dryRun ? "would change" : "updated"}, ${r.failed} failed.`);
          for (const smp of r.samples.slice(0, flags.site ? 5 : 1)) console.log(`  ${smp.title}: ${JSON.stringify(smp.changes)}`);
        } catch (err) {
          console.log(`${name}: ✗ ${err instanceof Error ? err.message : err}`);
        }
      }
      if (flags["dry-run"] !== "true" && total > 0) console.log(formatBonusReport(await recomputeMatchBonus()));
      break;
    }
    case "check-open":
      await cmdCheckOpen(flags);
      break;
    case "dealbreakers":
      await cmdDealbreakers(flags);
      break;
    case "cleanup":
      await cmdCleanup(flags);
      break;
    case "salaries": {
      const dry = flags["dry-run"] === "true";
      const filled = await backfillSalaries({ dryRun: dry, includeArchived: flags["include-archived"] === "true" });
      for (const f of filled.slice(0, 40)) console.log(`  ${f.company}: ${f.job_title}  $${f.min.toLocaleString()} - $${f.max.toLocaleString()}  (${f.source})`);
      if (filled.length > 40) console.log(`  … and ${filled.length - 40} more`);
      console.log(`${dry ? "Would fill" : "Filled"} salary on ${filled.length} row(s) from description text.`);
      if (!dry && filled.length) console.log(formatBonusReport(await recomputeMatchBonus()));
      break;
    }
    case "db":
      cmdDb(rest);
      break;
    case "bonus":
      console.log(formatBonusReport(await recomputeMatchBonus({ dryRun: flags["dry-run"] === "true" })));
      break;
    default:
      console.error(
        "Usage:\n" +
          "  cli db       status | import --json <seed.json> | sql \"<statement>\"   # local SQLite store\n" +
          "  cli render   --spec <file.json> | --model <file.json> [--out <path>] [--out-dir <slug>]\n" +
          "  cli discover [--site <name>] [--all] [--dry-run] [--no-filter] [--no-cleanup]   # real runs end with cleanup\n" +
          "  cli triage   [--apply <decisions.json>]\n" +
          "  cli tailor   list | context <id> | attach <id> --resume <pdf> [--cover <pdf>] [--spec <path>] [--export <Company - Team>] [--combined] [--plaintext] [--auto]\n" +
          "  cli assess   list [--rescore] | apply --json <f> [--dry-run]   # /assess: materials confidence for interested roles\n" +
          "  cli intake   fetch <url> | add --json <file> [--force]\n" +
          "  cli bullets  context [--out <file>] | apply --json <file> [--dry-run]\n" +
          "  cli check-open [--host <substr>] [--dry-run]   # archive opportunities whose posting has closed\n" +
          "  cli dealbreakers [--dry-run]   # archive triage/new rows hitting title exclusions or DESCRIPTION_EXCLUDE\n" +
          "  cli cleanup  [--dry-run]   # check-open → dealbreakers → bonus (also runs after every discover)\n" +
          "  cli salaries [--include-archived] [--dry-run]   # fill empty salary_min/max from pay text in the JD\n" +
          "  cli bonus    [--dry-run]   # recompute match_bonus (also runs after every discover)\n" +
          "  cli retro    digest --out <f.md> [--all] [--since <date>] | mark   # /retro: conversations + editor feedback\n" +
          "  cli review   [--port 4321] # local keyboard triage UI: ← archive, → new, ↑ interested\n" +
          "  cli edit     --spec <file.json> [--port 4322] [--no-open]   # edit + annotate a spec; notes → specs/feedback/\n" +
          "  cli enrich   --site <name> | --provider <name> [--include-archived] [--dry-run]   # backfill via detail fetch",
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
