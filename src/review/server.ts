/**
 * Manual triage review: a tiny local web app (localhost only) for swiping through the `triage` queue with
 * the keyboard. The Directus token stays in this process; the page only talks to these endpoints:
 *   GET  /              the page (src/review/index.html)
 *   GET  /api/queue     un-archived triage + new rows, ranked by rankScore (AI-scored first)
 *   POST /api/decide    { id, action: "archive" | "new" | "interested" | "restore", previous? }
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { bonusChips } from "../../config/priority.ts";
import { fetchReviewQueue, updateOpportunity } from "../db/index.ts";

/** What each key does to a row. "restore" (undo) puts back the status/archived the page remembered. */
const ACTIONS: Record<string, Record<string, unknown>> = {
  archive: { status: "skipped", archived: true }, // Carson: not interested
  new: { status: "new", archived: false }, // keep (an AI-kept `new` row stays `new`)
  interested: { status: "interested", archived: false }, // make me materials
};

const PAGE = join(import.meta.dirname, "index.html");

/** How much each match-bonus point is worth next to the 0-100 AI triage score (bonus max 12 → +36). */
export const BONUS_WEIGHT = 3;

/** Review order: AI score + BONUS_WEIGHT × match bonus. Rows AI triage hasn't scored have no rank score. */
export function rankScore(o: { match_percentage: number | null; match_bonus: number | null }): number | null {
  return o.match_percentage == null ? null : o.match_percentage + BONUS_WEIGHT * (o.match_bonus ?? 0);
}

function json(res: import("node:http").ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: import("node:http").IncomingMessage): Promise<any> {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : {};
}

export function startReviewServer(port = 4321): void {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(readFileSync(PAGE, "utf8")); // re-read each load so edits show up on refresh
        return;
      }
      if (req.method === "GET" && req.url === "/api/queue") {
        const now = new Date();
        const rows = (await fetchReviewQueue()).map((o) => ({ ...o, rankScore: rankScore(o), bonusChips: bonusChips(o, now) }));
        // Scored rows first by rank score; unscored (untriaged) rows after, by match bonus.
        rows.sort((a, b) =>
          a.rankScore != null && b.rankScore != null
            ? b.rankScore - a.rankScore
            : a.rankScore != null
              ? -1
              : b.rankScore != null
                ? 1
                : (b.match_bonus ?? 0) - (a.match_bonus ?? 0),
        );
        return json(res, 200, rows);
      }
      if (req.method === "POST" && req.url === "/api/decide") {
        const { id, action, previous } = await readBody(req);
        if (typeof id !== "string" || !id) return json(res, 400, { error: "id required" });
        let data: Record<string, unknown>;
        if (action === "restore") {
          if (!previous || typeof previous.status !== "string") return json(res, 400, { error: "previous required" });
          data = { status: previous.status, archived: previous.archived ?? false };
        } else if (ACTIONS[action]) {
          data = ACTIONS[action]!;
        } else {
          return json(res, 400, { error: `unknown action ${action}` });
        }
        await updateOpportunity(id, data);
        return json(res, 200, { ok: true, id, ...data });
      }
      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Triage review running at http://localhost:${port}  (Ctrl+C to stop)`);
  });
}
