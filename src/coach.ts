import { createHash } from "node:crypto";
import { z } from "zod";
import { CATS, type BeeId, type Config } from "./config.js";
import { STRATEGY_VERSION } from "./decision.js";
import { TRAINER_PROMPT, trainerDisplayName, trainerPlaybook } from "./coach-prompt.js";
import type { Db } from "./db.js";
import { redactString } from "./redact.js";

const DAY = 86_400_000;
export const COACH_INTERVAL_MS = 4 * 3_600_000;
const MIN_OBSERVATIONS = 30;
const MIN_OBSERVATION_MS = 3_600_000;
export const COACH_ERRORS: Record<string, string> = {
  engine_restarted: "The engine restarted before the review finished.",
  gateway_auth: "Vercel rejected the gateway credential. Check the engine's AI Gateway key.",
  gateway_credit: "Vercel reported insufficient credit or a billing restriction.",
  gateway_rate_limit: "Vercel rate-limited the review request.",
  gateway_failed: "The review provider returned an unsuccessful response.",
  timeout: "The review provider did not finish within 60 seconds.",
  connection: "The engine could not complete its connection to the review provider.",
  invalid_response: "The model returned an incomplete or invalid structured review.",
  response_truncated: "The review reached the provider's output limit before it was complete.",
  response_envelope: "The provider did not return a completed review message.",
  response_json: "The review message was not valid JSON.",
  response_schema: "The review did not meet the required field format.",
  invalid_change: "The proposed change did not pass the allowed bounds or settings checks.",
  unsupported_change: "The proposed change was not supported by the recorded entry blockers.",
  position_open: "The cat holds a position; the proposed entry change was not offered for approval.",
};
class CoachReviewError extends Error {
  constructor(code: string, readonly detail: string | null = null) { super(code); }
}
export const CoachField = z.enum(["minTrendScore", "minActionProbability", "minConviction"]);
export type CoachField = z.infer<typeof CoachField>;
const Patch = z.object({ field: CoachField, from: z.number().finite(), to: z.number().finite() }).strict();
const LegacyCoachAnswer = z.object({
  diagnosis: z.string().trim().min(1).max(1600),
  rationale: z.string().trim().min(1).max(1600),
  tradeoff: z.string().trim().min(1).max(1000),
  change: Patch.nullable(),
}).strict();
const sentences = (text: string) => text.trim().split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean).length;
const ascii = (max: number) => z.string().trim().min(1).max(max).regex(/^[\x20-\x7E]+$/);
const FIELD_FORMATS = {
  idea: "A nonempty idea name, at most 80 characters.",
  rules: "2 to 4 sentences, plain ASCII, at most 400 characters; no literal prices or dates.",
  coins: "Uppercase coin symbols separated by commas, at most 80 characters; empty means all allowed coins.",
  reason: "Exactly one nonempty sentence, at most 200 characters.",
  quip: "A nonempty plain ASCII line, at most 90 characters, with the cat's display name; no quotation marks or hashtags.",
  note: "Exactly two sentences, at most 800 characters.",
};
export const CoachAnswer = z.object({
  idea: z.string().trim().min(1).max(80),
  rules: ascii(400).refine(s => sentences(s) >= 2 && sentences(s) <= 4, "Use 2 to 4 sentences")
    .refine(s => !/\$|\b\d{4}-\d{2}-\d{2}\b/.test(s), "No literal prices or dates"),
  coins: z.string().trim().max(80).regex(/^(?:[A-Z0-9]+(?:\s*,\s*[A-Z0-9]+)*)?$/),
  reason: z.string().trim().min(1).max(200).refine(s => sentences(s) === 1),
  quip: ascii(90).refine(s => !/["#]/.test(s)),
  note: z.string().trim().min(1).max(800).refine(s => sentences(s) === 2, "Use two sentences"),
}).strict();
const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: { name: "cat_coach_rules", strict: true, schema: {
    type: "object", additionalProperties: false,
    required: ["idea", "rules", "coins", "reason", "quip", "note"],
    properties: Object.fromEntries(Object.entries(FIELD_FORMATS).map(([key, description]) => [key, {
      type: "string", description, ...(key === "quip" ? { minLength: 1, maxLength: 90 } : {}),
    }])),
  } },
};
type Answer = z.infer<typeof CoachAnswer>;
/** Only publish fixed field descriptions, never provider text, unknown keys or Zod messages. */
function responseFormatError(error: z.ZodError): CoachReviewError {
  const fields = [...new Set(error.issues.map(issue => issue.path[0]))];
  const detail = fields.map(field => typeof field === "string" && Object.hasOwn(FIELD_FORMATS, field)
    ? `${field}: ${FIELD_FORMATS[field as keyof typeof FIELD_FORMATS]}`
    : "Return exactly idea, rules, coins, reason, quip and note, all as strings.").join(" ");
  return new CoachReviewError("response_schema", detail);
}
/** A decorative caption must never invalidate otherwise valid strategy fields. */
function formatQuip(text: string, name: string): string {
  const cleaned = redactString(text.normalize("NFKD").replace(/\u2026/g, "...")
    .replace(/[^\x20-\x7E]|["#]/g, "").replace(/\s+/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim());
  return CoachAnswer.shape.quip.safeParse(cleaned).success && cleaned.includes(name)
    ? cleaned : `${name}, keep your paws on the evidence.`;
}
function parseReview(body: string, name: string): Answer {
  if (body.length > 100_000) throw new CoachReviewError("response_envelope");
  let envelope: unknown;
  try { envelope = JSON.parse(body); } catch { throw new CoachReviewError("response_envelope"); }
  const parsed = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }), finish_reason: z.string() })).min(1) }).safeParse(envelope);
  if (!parsed.success) throw new CoachReviewError("response_envelope");
  const choice = parsed.data.choices[0]!;
  if (choice.finish_reason === "length") throw new CoachReviewError("response_truncated");
  if (choice.finish_reason !== "stop" || choice.message.content === null) throw new CoachReviewError("response_envelope");
  let value: unknown;
  // An enclosing JSON fence and typographic punctuation do not change the proposed rules.
  const content = choice.message.content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
  try { value = JSON.parse(content); } catch { throw new CoachReviewError("response_json"); }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const fields = value as Record<string, unknown>;
    for (const field of Object.keys(FIELD_FORMATS)) {
      if (typeof fields[field] === "string") fields[field] = redactString(fields[field]
        .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
        .replace(/[\u2013\u2014]/g, "-").replace(/\u2265/g, ">=").replace(/\u2264/g, "<=").replace(/\s+/g, " ").trim());
    }
    // Keep missing/non-string fields invalid. Only repair this presentation-only string;
    // never truncate or substitute rules, coins, reasons, or evidence.
    if (typeof fields.quip === "string") fields.quip = formatQuip(fields.quip, name);
  }
  const review = CoachAnswer.safeParse(value);
  if (!review.success) throw responseFormatError(review.error);
  return review.data;
}
// Good's source brain was unchanged by the active-momentum upgrade; older engines differ.
const evidenceVersions = (cat: BeeId) => cat === "mochi" ? [STRATEGY_VERSION, "catfolio-5-source-engine"] : [STRATEGY_VERSION];
const versionFilter = "json_extract(audit_json,'$.strategyVersion') IN (SELECT value FROM json_each(?))";
type LegacyAnswer = z.infer<typeof LegacyCoachAnswer>;
const SavedCoachAnswer = z.union([CoachAnswer, LegacyCoachAnswer]);
type Values = { rules: string; coins: string[] };
export const coachValues = (cfg: Config, cat: BeeId): Values => ({ rules: cfg.slots[cat].rules, coins: [...cfg.slots[cat].coins] });
const displayName = trainerDisplayName;
export function coachRevision(cfg: Config, cat: BeeId): string {
  return createHash("sha256").update(JSON.stringify([STRATEGY_VERSION, cfg.cats[cat], cfg.strategies[cat], cfg.slots[cat], cfg.mode])).digest("hex");
}
export interface CoachEntry {
  id: number; cat: BeeId; day: string; createdAt: number; expiresAt: number;
  status: "reviewing" | "pending" | "accepted" | "declined" | "no_change" | "failed" | "expired" | "rolled_back";
  model: string; review: Answer | LegacyAnswer | null; evidence: unknown; resolvedAt: number | null; completedAt: number | null; error: string | null;
}
interface Row { id: number; cat: BeeId; day: string; created_at: number; status: CoachEntry["status"]; model: string; review: string | null; evidence: string; revision: string; resolved_at: number | null; completed_at: number | null; error_code: string | null; error_detail: string | null }
export class CoachConflict extends Error {}
export interface CoachDeps {
  cfg: Config; db: Db;
  context: (cat: BeeId) => unknown;
  universe?: () => unknown;
  closed: () => boolean;
  changed: (cat: BeeId) => void;
  now?: () => number;
  fetch?: typeof fetch;
}

/** Durable automatic overlays, applied only after schema, universe and revision validation. */
export class CatCoach {
  private now: () => number;
  private fetcher: typeof fetch;
  private baseline: Record<BeeId, Values>;
  private stopped = false;
  private lastCheckAt: number | null = null;
  private running: Promise<void> | null = null;
  constructor(private d: CoachDeps) {
    this.now = d.now ?? Date.now;
    this.fetcher = d.fetch ?? fetch;
    this.baseline = Object.fromEntries(CATS.map((id) => [id, coachValues(d.cfg, id)])) as Record<BeeId, Values>;
    d.db.raw.exec(`CREATE TABLE IF NOT EXISTS coach_reviews (
      id INTEGER PRIMARY KEY, cat TEXT NOT NULL, day TEXT NOT NULL, created_at INTEGER NOT NULL,
      status TEXT NOT NULL, model TEXT NOT NULL, review TEXT, evidence TEXT NOT NULL,
      revision TEXT NOT NULL, resolved_at INTEGER, UNIQUE(cat, created_at));
      CREATE TABLE IF NOT EXISTS coach_overrides (cat TEXT PRIMARY KEY, review_id INTEGER NOT NULL, values_json TEXT NOT NULL, baseline_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coach_rule_overrides (cat TEXT PRIMARY KEY, review_id INTEGER NOT NULL, values_json TEXT NOT NULL, baseline_json TEXT NOT NULL);`);
    const columns = d.db.raw.prepare("PRAGMA table_info(coach_reviews)").all() as Array<{ name: string }>;
    for (const [name, definition] of [["completed_at", "INTEGER"], ["error_code", "TEXT"], ["error_detail", "TEXT"]])
      if (!columns.some((column) => column.name === name)) d.db.raw.exec(`ALTER TABLE coach_reviews ADD COLUMN ${name} ${definition}`);
    // Preserve review IDs/history while removing the old UTC-day uniqueness constraint.
    const schema = d.db.raw.prepare("SELECT sql FROM sqlite_master WHERE name='coach_reviews'").get() as { sql: string };
    if (/UNIQUE\s*\(cat,\s*day\)/i.test(schema.sql)) d.db.transaction(() => {
      d.db.raw.exec(`CREATE TABLE coach_reviews_v2 (
        id INTEGER PRIMARY KEY, cat TEXT NOT NULL, day TEXT NOT NULL, created_at INTEGER NOT NULL,
        status TEXT NOT NULL, model TEXT NOT NULL, review TEXT, evidence TEXT NOT NULL,
        revision TEXT NOT NULL, resolved_at INTEGER, completed_at INTEGER, error_code TEXT, error_detail TEXT, UNIQUE(cat,created_at));
        INSERT INTO coach_reviews_v2 SELECT id,cat,day,created_at,status,model,review,evidence,revision,resolved_at,completed_at,error_code,error_detail FROM coach_reviews;
        DROP TABLE coach_reviews; ALTER TABLE coach_reviews_v2 RENAME TO coach_reviews;`);
    });
    // Old threshold proposals remain history, but can no longer mutate the engine.
    d.db.raw.prepare("UPDATE coach_reviews SET status='expired',resolved_at=? WHERE status='pending' AND json_extract(review,'$.rules') IS NULL").run(this.now());
    d.db.raw.prepare("UPDATE coach_reviews SET status='failed', completed_at=?, resolved_at=?, error_code='engine_restarted' WHERE status='reviewing'").run(this.now(), this.now());
    // Retire incompatible overlays, preserving Good Wall-E when only Dark's strategy changes.
    const previousStrategy = d.db.getMeta("coach_strategy_version");
    if (previousStrategy !== STRATEGY_VERSION) {
      const scope = previousStrategy === "catfolio-5-source-engine" ? " WHERE cat='tiger'" : "";
      d.db.transaction(() => {
        d.db.raw.prepare(`UPDATE coach_reviews SET status='rolled_back',resolved_at=? WHERE id IN (SELECT review_id FROM coach_rule_overrides${scope} UNION SELECT review_id FROM coach_overrides${scope})`).run(this.now());
        d.db.raw.prepare("UPDATE coach_reviews SET status='expired',resolved_at=? WHERE status='pending'").run(this.now());
        d.db.raw.exec(`DELETE FROM coach_overrides${scope}; DELETE FROM coach_rule_overrides${scope};`);
        d.db.setMeta("coach_strategy_version", STRATEGY_VERSION);
      });
    }
    // Manual-era proposals are historical suggestions, not automatic authorizations.
    if (d.db.getMeta("coach_automation_version") !== "1") {
      d.db.raw.prepare("UPDATE coach_reviews SET status='expired',resolved_at=? WHERE status='pending'").run(this.now());
      d.db.setMeta("coach_automation_version", "1");
    }
    for (const cat of CATS) {
      const row = d.db.raw.prepare("SELECT values_json,baseline_json FROM coach_rule_overrides WHERE cat=?").get(cat) as { values_json: string; baseline_json: string } | undefined;
      if (!row) continue;
      if (row.baseline_json !== JSON.stringify(this.baseline[cat])) {
        d.db.raw.prepare("DELETE FROM coach_rule_overrides WHERE cat=?").run(cat);
        continue;
      }
      const values = z.object({ rules: ascii(400), coins: z.array(z.string()).min(1) }).strict().parse(JSON.parse(row.values_json));
      if (values.coins.some(c => !this.baseline[cat].coins.includes(c))) throw new CoachConflict("Saved coach coins are outside the allowed universe.");
      Object.assign(d.cfg.slots[cat], values); d.changed(cat);
    }
  }

  private expire() {
    this.d.db.raw.prepare("UPDATE coach_reviews SET status='expired', resolved_at=? WHERE status='pending' AND created_at<=?").run(this.now(), this.now() - DAY);
  }
  private rows(): Row[] {
    return this.d.db.raw.prepare("SELECT * FROM coach_reviews ORDER BY id DESC LIMIT 20").all() as unknown as Row[];
  }
  state() {
    this.expire();
    const { cfg, db } = this.d;
    const enabled = cfg.coach.enabled && !!cfg.coach.apiKey && !this.d.closed();
    return {
      enabled, canReview: !!cfg.coach.adminToken && !this.d.closed(), model: cfg.coach.model,
      message: this.d.closed() ? "Experiment closed; coaching paused." : !cfg.coach.enabled ? "Coach is off. Enable COACH_ENABLED and configure AI_GATEWAY_API_KEY on the engine."
        : !cfg.coach.apiKey ? "Set AI_GATEWAY_API_KEY on the engine to enable trainer reviews."
        : "Automatic rules-and-coins reviews every 4 hours per cat, after at least one hour and 30 observations. Validated changes apply immediately.",
      approvalMessage: null,
      automatic: true, reviewIntervalMs: COACH_INTERVAL_MS,
      checkedAt: this.lastCheckAt,
      checkIntervalMs: 60_000,
      cats: CATS.map((cat) => {
        const last = db.raw.prepare("SELECT * FROM coach_reviews WHERE cat=? ORDER BY id DESC LIMIT 1").get(cat) as unknown as Row | undefined;
        const readiness = this.readiness(cat, this.now(), last);
        const phase = !enabled ? "paused" : last?.status === "reviewing" ? "reviewing"
          : last?.status === "pending" ? "awaiting_approval"
          : readiness.cooldownUntil !== null && readiness.cooldownUntil > this.now() ? "scheduled"
          : readiness.ready ? "queued" : "gathering";
        const counts = db.raw.prepare("SELECT COUNT(*) AS reviews, SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) AS accepted FROM coach_reviews WHERE cat=?").get(cat) as { reviews: number; accepted: number | null };
        return { cat, current: coachValues(cfg, cat), baseline: this.baseline[cat], context: this.d.context(cat),
          activeReviewId: (db.raw.prepare("SELECT review_id FROM coach_rule_overrides WHERE cat=?").get(cat) as { review_id: number } | undefined)?.review_id ?? null,
          nextReviewAt: readiness.earliestReviewAt, phase,
          observations: readiness.decisions, requiredObservations: MIN_OBSERVATIONS,
          observedMinutes: Math.floor(readiness.observedMs / 60_000), requiredMinutes: MIN_OBSERVATION_MS / 60_000,
          lastReviewAt: last?.created_at ?? null, reviewCount: counts.reviews, acceptedCount: counts.accepted ?? 0,
        };
      }),
      entries: this.rows().map((r): CoachEntry => ({ id: r.id, cat: r.cat, day: r.day, createdAt: r.created_at, expiresAt: r.created_at + DAY, status: r.status, model: r.model,
        review: r.review ? SavedCoachAnswer.parse(JSON.parse(r.review)) : null, evidence: JSON.parse(r.evidence), resolvedAt: r.resolved_at, completedAt: r.completed_at, error: r.error_code ? [COACH_ERRORS[r.error_code] ?? "The review could not be completed.", r.error_detail].filter(Boolean).join(" ") : null })),
    };
  }
  /** The dashboard and scheduler share evidence and rolling cooldown checks. */
  private readiness(cat: BeeId, now: number, last?: Row) {
    const summary = this.d.db.raw.prepare(`SELECT COUNT(*) AS decisions, MIN(ts) AS firstAt
      FROM decisions WHERE bee=? AND ts>=? AND ts<=? AND ${versionFilter} AND json_extract(audit_json,'$.source') IN ('model_request','rules')`)
      .get(cat, now - DAY, now, JSON.stringify(evidenceVersions(cat))) as { decisions: number; firstAt: number | null };
    const observedMs = summary.firstAt === null ? 0 : Math.max(0, now - summary.firstAt);
    const accepted = this.d.db.raw.prepare("SELECT MAX(resolved_at) AS at FROM coach_reviews WHERE cat=? AND status IN ('accepted','rolled_back')").get(cat) as { at: number | null };
    const cooldownUntil = last ? Math.max(last.created_at + COACH_INTERVAL_MS, accepted.at === null ? 0 : accepted.at + COACH_INTERVAL_MS) : null;
    const earliestReviewAt = summary.firstAt === null ? cooldownUntil
      : Math.max(summary.firstAt + MIN_OBSERVATION_MS, cooldownUntil ?? 0);
    return { decisions: summary.decisions, observedMs, cooldownUntil, earliestReviewAt,
      ready: last?.status !== "pending" && last?.status !== "reviewing" && summary.decisions >= MIN_OBSERVATIONS && observedMs >= MIN_OBSERVATION_MS && (cooldownUntil === null || now >= cooldownUntil) };
  }
  private evidence(cat: BeeId, now: number) {
    const db = this.d.db.raw, since = now - DAY;
    const strategyVersions = evidenceVersions(cat), versions = JSON.stringify(strategyVersions);
    const summary = db.prepare(`SELECT COUNT(*) AS decisions, MIN(ts) AS firstAt,
      SUM(CASE WHEN choice='WAIT' OR (choice IS NULL AND (SELECT COUNT(*) FROM json_each(menu_json))=0) THEN 1 ELSE 0 END) AS waits,
      SUM(CASE WHEN choice IN ('HOLD','HOLD_WINNER') THEN 1 ELSE 0 END) AS holds,
      SUM(CASE WHEN (choice='WAIT' AND (SELECT COUNT(*) FROM json_each(menu_json))=1) OR (choice IS NULL AND (SELECT COUNT(*) FROM json_each(menu_json))=0) THEN 1 ELSE 0 END) AS waitOnly,
      SUM(CASE WHEN (vetoed_by='weak_or_invalid_conviction' OR vetoed_by LIKE 'weak_conviction %') AND conviction<COALESCE(json_extract(audit_json,'$.config.openGate.minConviction'),json_extract(audit_json,'$.config.limits.minConviction')) THEN 1 ELSE 0 END) AS weakConviction,
      SUM(CASE WHEN (vetoed_by='weak_or_invalid_conviction' OR vetoed_by LIKE 'weak_conviction %') AND json_extract(probabilities_json,'$.' || choice)<COALESCE(json_extract(audit_json,'$.config.openGate.minProb'),json_extract(audit_json,'$.config.limits.minActionProbability')) THEN 1 ELSE 0 END) AS weakProbability,
      SUM(CASE WHEN jev_error IS NOT NULL THEN 1 ELSE 0 END) AS modelFailures
      FROM decisions WHERE bee=? AND ts>=? AND ts<=? AND ${versionFilter} AND json_extract(audit_json,'$.source') IN ('model_request','rules')`).get(cat, since, now, versions) as { decisions: number; firstAt: number | null; waits: number; holds: number; waitOnly: number; weakConviction: number; weakProbability: number; modelFailures: number };
    const outcomes = db.prepare(`SELECT status, vetoed_by AS veto, COUNT(*) AS count FROM decisions WHERE bee=? AND ts>=? AND ts<=? AND ${versionFilter} GROUP BY status,vetoed_by ORDER BY count DESC LIMIT 30`).all(cat, since, now, versions);
    const blockers = db.prepare(`SELECT b.value AS reason, COUNT(DISTINCT d.id) AS decisions
      FROM decisions d, json_each(d.audit_json,'$.entryDiagnostics') c, json_each(c.value,'$.blockers') b
      WHERE d.bee=? AND d.ts>=? AND d.ts<=? AND ${versionFilter} AND json_extract(d.audit_json,'$.source') IN ('model_request','rules')
      GROUP BY b.value ORDER BY decisions DESC`).all(cat, since, now, versions);
    const recent = db.prepare(`SELECT ts, choice, status, vetoed_by AS veto, conviction,
      json_extract(audit_json,'$.entryDiagnostics') AS diagnostics
      FROM decisions WHERE bee=? AND ts>=? AND ts<=? AND ${versionFilter} AND json_extract(audit_json,'$.source') IN ('model_request','rules') ORDER BY id DESC LIMIT 12`).all(cat, since, now, versions);
    const entries = db.prepare(`SELECT COUNT(*) AS count FROM orders o JOIN decisions d ON d.id=o.decision_id AND d.bee=o.bee
      WHERE o.bee=? AND o.ts>=? AND o.ts<=? AND ${versionFilter} AND o.purpose='open' AND o.state='filled'`).get(cat, since, now, versions);
    const excluded = db.prepare(`SELECT COUNT(*) AS count FROM decisions WHERE bee=? AND ts>=? AND ts<=?
      AND json_extract(audit_json,'$.source') IN ('model_request','rules') AND COALESCE((${versionFilter}),0)=0`).get(cat, since, now, versions) as { count: number };
    return { since, until: now, strategyVersions, excludedObservations: excluded.count, summary, outcomes, blockers, recent, entries, current: this.d.context(cat) };
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  async stop() { this.stopped = true; await this.running; }
  private async run() {
    const { cfg, db } = this.d;
    this.lastCheckAt = this.now();
    if (this.stopped || this.d.closed() || !cfg.coach.enabled || !cfg.coach.apiKey) return;
    this.expire();
    for (const cat of CATS) {
      if (this.stopped || this.d.closed()) return;
      const now = this.now(), day = new Date(now).toISOString().slice(0, 10);
      const last = db.raw.prepare("SELECT * FROM coach_reviews WHERE cat=? ORDER BY id DESC LIMIT 1").get(cat) as unknown as Row | undefined;
      if (!this.readiness(cat, now, last).ready) continue;
      const evidence = this.evidence(cat, now);
      const revision = coachRevision(cfg, cat);
      const result = db.raw.prepare("INSERT OR IGNORE INTO coach_reviews(cat,day,created_at,status,model,evidence,revision) VALUES(?,?,?,'reviewing',?,?,?)")
        .run(cat, day, now, cfg.coach.model, JSON.stringify(evidence), revision);
      if (!result.changes) continue;
      const id = Number(result.lastInsertRowid);
      let stage: "request" | "response" | "change" = "request";
      try {
        const messages = [
          { role: "system", content: TRAINER_PROMPT },
          { role: "user", content: JSON.stringify({ cat: { id: cat, name: displayName(cfg, cat), current: coachValues(cfg, cat), allowedCoins: this.baseline[cat].coins },
            decisionIntervalMs: cfg.tickMs, playbook: trainerPlaybook(cfg),
            scorecard: CATS.map(id => ({ cat: id, name: displayName(cfg, id), current: coachValues(cfg, id), evidence: id === cat ? evidence : this.evidence(id, now) })),
            viewerCats: null, universe: this.d.universe?.() ?? { available: false },
          }) },
        ];
        let review: Answer | undefined;
        // One repair within the same review, never an unbounded provider retry loop.
        const signal = AbortSignal.timeout(60_000);
        for (let attempt = 0; attempt < 2; attempt++) {
          stage = "request";
          const response = await this.fetcher("https://ai-gateway.vercel.sh/v1/chat/completions", {
            method: "POST", redirect: "error", signal,
            headers: { "content-type": "application/json", authorization: `Bearer ${cfg.coach.apiKey}` },
            body: JSON.stringify({ model: cfg.coach.model, max_tokens: attempt === 0 ? 2000 : 3200, response_format: RESPONSE_FORMAT, messages }),
          });
          if (!response.ok) throw new CoachReviewError(response.status === 401 || response.status === 403 ? "gateway_auth"
            : response.status === 402 ? "gateway_credit" : response.status === 429 ? "gateway_rate_limit" : "gateway_failed");
          stage = "response";
          try { review = parseReview(await response.text(), displayName(cfg, cat)); break; }
          catch (err) {
            if (!(err instanceof CoachReviewError) || !["response_truncated", "response_json", "response_schema"].includes(err.message)) throw err;
            if (attempt === 1) throw new CoachReviewError(err.message, [err.detail, "The automatic repair attempt also failed; no changes were applied."].filter(Boolean).join(" "));
            if (this.stopped || this.d.closed() || revision !== coachRevision(cfg, cat)) {
              db.raw.prepare("UPDATE coach_reviews SET status='expired',resolved_at=?,completed_at=? WHERE id=?").run(this.now(), this.now(), id);
              break;
            }
            messages.push({ role: "user", content: `Your response failed validation: ${COACH_ERRORS[err.message]} ${err.detail ?? ""} Return a complete replacement JSON object using the original evidence and the six required fields. Keep it concise. Do not add fields or surrounding prose.` });
          }
        }
        if (!review) continue;
        stage = "change";
        const values = this.validate(cat, review);
        const current = coachValues(cfg, cat);
        const unchanged = this.sameRules(values.rules, current.rules) && JSON.stringify(values.coins) === JSON.stringify(current.coins);
        const status = this.stopped || this.d.closed() || revision !== coachRevision(cfg, cat) || this.now() >= now + DAY
          ? "expired" : unchanged ? "no_change" : "accepted";
        db.transaction(() => {
          db.raw.prepare("UPDATE coach_reviews SET status=?,review=?,completed_at=?,resolved_at=? WHERE id=?")
            .run(status, JSON.stringify(review), this.now(), this.now(), id);
          if (status === "accepted") this.saveOverride(cat, id, values);
        });
        if (status === "accepted") { Object.assign(cfg.slots[cat], values); this.d.changed(cat); }
      } catch (err) {
        // Map errors to a fixed vocabulary; never retain a provider body or credential-bearing message.
        const code = err instanceof CoachReviewError ? err.message
          : err instanceof Error && ["TimeoutError", "AbortError"].includes(err.name) ? "timeout"
          : stage === "request" ? "connection" : stage === "response" ? "invalid_response" : "invalid_change";
        db.raw.prepare("UPDATE coach_reviews SET status='failed', resolved_at=?, completed_at=?, error_code=?, error_detail=? WHERE id=?").run(this.now(), this.now(), code, err instanceof CoachReviewError ? err.detail : null, id);
      }
    }
  }
  private validate(cat: BeeId, review: Answer): Values {
    CoachAnswer.parse(review);
    const allowed = this.baseline[cat].coins;
    const coins = review.coins ? review.coins.split(",").map(c => c.trim()) : [...allowed];
    if (new Set(coins).size !== coins.length || coins.some(c => !allowed.includes(c)))
      throw new CoachConflict("The proposed coin list is outside this cat's allowed universe.");
    if (!review.quip.includes(displayName(this.d.cfg, cat))) throw new CoachConflict("The quip must use the cat's display name.");
    return { rules: review.rules, coins: allowed.filter(c => coins.includes(c)) };
  }
  private sameRules(a: string, b: string) { return a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim(); }
  private saveOverride(cat: BeeId, id: number, values: Values) {
    this.d.db.raw.prepare("INSERT INTO coach_rule_overrides(cat,review_id,values_json,baseline_json) VALUES(?,?,?,?) ON CONFLICT(cat) DO UPDATE SET review_id=excluded.review_id,values_json=excluded.values_json,baseline_json=excluded.baseline_json")
      .run(cat, id, JSON.stringify(values), JSON.stringify(this.baseline[cat]));
  }
  resolve(id: number, action: "accept" | "decline") {
    this.expire();
    if (this.d.closed()) throw new CoachConflict("The experiment is closed.");
    const { cfg, db } = this.d;
    const row = db.raw.prepare("SELECT * FROM coach_reviews WHERE id=?").get(id) as unknown as Row | undefined;
    if (!row || row.status !== "pending") throw new CoachConflict("This suggestion is no longer awaiting approval.");
    const review = CoachAnswer.parse(JSON.parse(row.review!));
    if (action === "accept") {
      if (row.revision !== coachRevision(cfg, row.cat)) throw new CoachConflict("Settings changed since this review; wait for the next review.");
      this.validate(row.cat, review);
      const previous = db.raw.prepare("SELECT MAX(resolved_at) AS at FROM coach_reviews WHERE cat=? AND status IN ('accepted','rolled_back')").get(row.cat) as { at: number | null };
      if (previous.at !== null && this.now() < previous.at + COACH_INTERVAL_MS) throw new CoachConflict("Wait 4 hours between trainer changes.");
    }
    const values = action === "accept" ? this.validate(row.cat, review) : coachValues(cfg, row.cat);
    db.transaction(() => {
      db.raw.prepare("UPDATE coach_reviews SET status=?,resolved_at=? WHERE id=?").run(action === "accept" ? "accepted" : "declined", this.now(), id);
      if (action === "accept") db.raw.prepare("INSERT INTO coach_rule_overrides(cat,review_id,values_json,baseline_json) VALUES(?,?,?,?) ON CONFLICT(cat) DO UPDATE SET review_id=excluded.review_id,values_json=excluded.values_json,baseline_json=excluded.baseline_json")
        .run(row.cat, id, JSON.stringify(values), JSON.stringify(this.baseline[row.cat]));
    });
    if (action === "accept") { Object.assign(cfg.slots[row.cat], values); this.d.changed(row.cat); }
    return this.state();
  }
  reset(cat: BeeId) {
    const { cfg, db } = this.d;
    if (this.d.closed()) throw new CoachConflict("The experiment is closed.");
    const row = db.raw.prepare("SELECT review_id FROM coach_rule_overrides WHERE cat=?").get(cat) as { review_id: number } | undefined;
    if (!row) throw new CoachConflict("No active coach changes to reset.");
    db.transaction(() => {
      db.raw.prepare("DELETE FROM coach_rule_overrides WHERE cat=?").run(cat);
      db.raw.prepare("UPDATE coach_reviews SET status='rolled_back',resolved_at=? WHERE id=?").run(this.now(), row.review_id);
      db.raw.prepare("UPDATE coach_reviews SET status='expired',resolved_at=? WHERE cat=? AND status='pending'").run(this.now(), cat);
    });
    Object.assign(cfg.slots[cat], { ...this.baseline[cat], coins: [...this.baseline[cat].coins] }); this.d.changed(cat);
    return this.state();
  }
}
