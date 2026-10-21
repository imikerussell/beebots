import { createHash } from "node:crypto";
import { z } from "zod";
import { CATS, type BeeId, type Config } from "./config.js";
import { strategyVersion } from "./decision.js";
import { trainerPrompt, trainerDisplayName, trainerModePrompt, trainerPlaybook } from "./coach-prompt.js";
import type { Db } from "./db.js";
import { aggregateTrades, completedTrades } from "./performance.js";
import { applyParameters, strategyParameters, tunableParameters, PARAMETER_BOUNDS, type ParameterValues, type StrategyParameter } from "./strategy-parameters.js";
import { redactString } from "./redact.js";

const DAY = 86_400_000;
export const COACH_EVIDENCE_WINDOW_MS = 7 * DAY;
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
  unsupported_change: "The proposed change was not supported by completed-trade outcomes and recorded entry blockers.",
  position_open: "The cat holds a position; numeric strategy changes require a flat position.",
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
const ParameterChange = z.object({ field: z.enum(["minConviction", "minActionProbability", "minMomentumPct", "momentumAtrMult", "minTrendScore", "volTargetPct", "trimScoreDrop"]), from: z.number().finite(), to: z.number().finite() }).strict();
export const CoachAnswer = z.object({
  parameterChanges: z.array(ParameterChange).max(1).optional(),
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
    required: ["idea", "rules", "coins", "reason", "quip", "note", "parameterChanges"],
    properties: { parameterChanges: { type: "array", maxItems: 1, items: { type: "object", additionalProperties: false, required: ["field", "from", "to"], properties: { field: {type:"string",enum:Object.keys(PARAMETER_BOUNDS)}, from:{type:"number"}, to:{type:"number"} } } }, ...Object.fromEntries(Object.entries(FIELD_FORMATS).map(([key, description]) => [key, {
      type: "string", description, ...(key === "quip" ? { minLength: 1, maxLength: 90 } : {}),
    }])), },
  } },
};
type Answer = z.infer<typeof CoachAnswer>;
/** Only publish fixed field descriptions, never provider text, unknown keys or Zod messages. */
function responseFormatError(error: z.ZodError): CoachReviewError {
  const fields = [...new Set(error.issues.map(issue => issue.path[0]))];
  const detail = fields.map(field => typeof field === "string" && Object.hasOwn(FIELD_FORMATS, field)
    ? `${field}: ${FIELD_FORMATS[field as keyof typeof FIELD_FORMATS]}`
    : "Return idea, rules, coins, reason, quip and note as strings, plus parameterChanges as an array of at most one {field, from, to} object.").join(" ");
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
// Both current strategies differ from the source engine; do not mix their evidence.
const evidenceVersions = (cfg: Config) => [strategyVersion(cfg)];
const versionFilter = "json_extract(audit_json,'$.strategyVersion') IN (SELECT value FROM json_each(?))";
type LegacyAnswer = z.infer<typeof LegacyCoachAnswer>;
const SavedCoachAnswer = z.union([CoachAnswer, LegacyCoachAnswer]);
type Values = { rules: string; coins: string[]; parameters: ParameterValues };
export const coachValues = (cfg: Config, cat: BeeId): Values => ({ rules: cfg.slots[cat].rules, coins: [...cfg.slots[cat].coins], parameters: strategyParameters(cfg, cat) });
const displayName = trainerDisplayName;
export function coachRevision(cfg: Config, cat: BeeId): string {
  return createHash("sha256").update(JSON.stringify([strategyVersion(cfg), cfg.cats[cat], cfg.strategies[cat], cfg.exits[cat], cfg.slots[cat], cfg.mode, cfg.coach.autoApply])).digest("hex");
}
export interface CoachEntry {
  id: number; cat: BeeId; day: string; createdAt: number; expiresAt: number;
  status: "reviewing" | "pending" | "accepted" | "advisory" | "declined" | "no_change" | "failed" | "expired" | "rolled_back";
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

/** Scheduled evidence reviews; automatic overlays require explicit configuration and validation. */
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
    // Retire incompatible overlays without deleting their review history.
    const previousStrategy = d.db.getMeta("coach_strategy_version");
    if (previousStrategy !== strategyVersion(d.cfg)) {
      d.db.transaction(() => {
        d.db.raw.prepare("UPDATE coach_reviews SET status='rolled_back',resolved_at=? WHERE id IN (SELECT review_id FROM coach_rule_overrides UNION SELECT review_id FROM coach_overrides)").run(this.now());
        d.db.raw.prepare("UPDATE coach_reviews SET status='expired',resolved_at=? WHERE status='pending'").run(this.now());
        d.db.raw.exec("DELETE FROM coach_overrides; DELETE FROM coach_rule_overrides;");
        d.db.setMeta("coach_strategy_version", strategyVersion(d.cfg));
      });
    }
    // Manual-era proposals are historical suggestions, not automatic authorizations.
    if (d.db.getMeta("coach_automation_version") !== "1") {
      d.db.raw.prepare("UPDATE coach_reviews SET status='expired',resolved_at=? WHERE status='pending'").run(this.now());
      d.db.setMeta("coach_automation_version", "1");
    }
    // Advisory mode starts from owner settings, without silently restoring an old automatic experiment.
    // Keep review history and retire the overlay so re-enabling auto-apply cannot resurrect it later.
    if (!d.cfg.coach.autoApply) d.db.transaction(() => {
      d.db.raw.prepare("UPDATE coach_reviews SET status='rolled_back',resolved_at=? WHERE id IN (SELECT review_id FROM coach_rule_overrides UNION SELECT review_id FROM coach_overrides)").run(this.now());
      d.db.raw.prepare("UPDATE coach_reviews SET status='expired',resolved_at=? WHERE status='pending'").run(this.now());
      d.db.raw.exec("DELETE FROM coach_overrides; DELETE FROM coach_rule_overrides;");
    });
    for (const cat of CATS) {
      const row = d.db.raw.prepare("SELECT values_json,baseline_json FROM coach_rule_overrides WHERE cat=?").get(cat) as { values_json: string; baseline_json: string } | undefined;
      if (!row) continue;
      if (row.baseline_json !== JSON.stringify(this.baseline[cat])) {
        d.db.raw.prepare("DELETE FROM coach_rule_overrides WHERE cat=?").run(cat);
        continue;
      }
      const values = z.object({ rules: ascii(400), coins: z.array(z.string()).min(1), parameters: z.record(z.number().finite()) }).strict().parse(JSON.parse(row.values_json));
      this.validateSavedParameters(cat, values.parameters);
      if (values.coins.some(c => !this.baseline[cat].coins.includes(c))) throw new CoachConflict("Saved coach coins are outside the allowed universe.");
      this.apply(cat, values); d.changed(cat);
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
      benched: cfg.strategyEngine === "upstream",
      enabled, canReview: !!cfg.coach.adminToken && !this.d.closed(), model: cfg.coach.model, autoApply: cfg.coach.autoApply,
      message: cfg.strategyEngine === "upstream" ? "Trainer benched. No reviews or strategy changes while the upstream strategies run."
        : this.d.closed() ? "Experiment closed; coaching paused." : !cfg.coach.enabled ? "Coach is off. Enable COACH_ENABLED and configure AI_GATEWAY_API_KEY on the engine."
        : !cfg.coach.apiKey ? "Set AI_GATEWAY_API_KEY on the engine to enable trainer reviews."
        : cfg.coach.autoApply
          ? "Automatic reviews every 4 hours can apply bounded experimental changes. Numeric changes require completed-trade evidence and a flat position; these checks do not establish profitability."
          : "Reviews every 4 hours provide suggestions only. Rules, coins and numeric settings remain under owner control; no suggestion is applied automatically.",
      approvalMessage: null,
      automatic: true, reviewIntervalMs: COACH_INTERVAL_MS, evidenceWindowMs: COACH_EVIDENCE_WINDOW_MS,
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
        return { cat, current: coachValues(cfg, cat), baseline: this.baseline[cat], tunableParameters: tunableParameters(cfg, cat), context: this.d.context(cat),
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
  /** One representative model/rules observation per completed signal-bar episode; pulses never count. */
  private observations(cat: BeeId, since: number, until: number) {
    return this.d.db.raw.prepare(`SELECT MIN(id) AS id, MIN(ts) AS ts FROM decisions
      WHERE bee=? AND ts>=? AND ts<=? AND ${versionFilter}
      AND json_extract(audit_json,'$.source') IN ('model_request','rules','code')
      AND COALESCE(json_extract(audit_json,'$.decisionKind'),'signal') NOT IN ('profit_review','discarded')
      GROUP BY CAST(ts / ? AS INTEGER) ORDER BY ts`)
      .all(cat, since, until, JSON.stringify(evidenceVersions(this.d.cfg)), (cat === "tiger" ? 15 : 240) * 60_000) as Array<{id:number;ts:number}>;
  }
  /** The dashboard and scheduler share evidence and rolling cooldown checks. */
  private readiness(cat: BeeId, now: number, last?: Row) {
    const accepted = this.d.db.raw.prepare("SELECT MAX(resolved_at) AS at FROM coach_reviews WHERE cat=? AND status IN ('accepted','rolled_back')").get(cat) as { at: number | null };
    const observed = this.observations(cat, Math.max(now - COACH_EVIDENCE_WINDOW_MS, accepted.at ?? 0), now);
    const summary = { decisions: observed.length, firstAt: observed[0]?.ts ?? null };
    const observedMs = summary.firstAt === null ? 0 : Math.max(0, now - summary.firstAt);
    const cooldownUntil = last ? Math.max(last.created_at + COACH_INTERVAL_MS, accepted.at === null ? 0 : accepted.at + COACH_INTERVAL_MS) : null;
    const earliestReviewAt = summary.firstAt === null ? cooldownUntil
      : Math.max(summary.firstAt + MIN_OBSERVATION_MS, cooldownUntil ?? 0);
    return { decisions: summary.decisions, observedMs, cooldownUntil, earliestReviewAt,
      ready: last?.status !== "pending" && last?.status !== "reviewing" && summary.decisions >= MIN_OBSERVATIONS && observedMs >= MIN_OBSERVATION_MS && (cooldownUntil === null || now >= cooldownUntil) };
  }
  private evidence(cat: BeeId, now: number) {
    const db = this.d.db.raw;
    const lastChange = db.prepare("SELECT MAX(resolved_at) AS at FROM coach_reviews WHERE cat=? AND status IN ('accepted','rolled_back')").get(cat) as {at: number | null};
    const since = Math.max(now - COACH_EVIDENCE_WINDOW_MS, lastChange.at ?? 0);
    const strategyVersions = evidenceVersions(this.d.cfg), versions = JSON.stringify(strategyVersions);
    const observationIds = JSON.stringify(this.observations(cat, since, now).map(row => row.id));
    const summary = db.prepare(`SELECT COUNT(*) AS decisions, MIN(ts) AS firstAt,
      SUM(CASE WHEN choice='WAIT' OR (choice IS NULL AND (SELECT COUNT(*) FROM json_each(menu_json))=0) THEN 1 ELSE 0 END) AS waits,
      SUM(CASE WHEN choice IN ('HOLD','HOLD_WINNER') THEN 1 ELSE 0 END) AS holds,
      SUM(CASE WHEN (choice='WAIT' AND (SELECT COUNT(*) FROM json_each(menu_json))=1) OR (choice IS NULL AND (SELECT COUNT(*) FROM json_each(menu_json))=0) THEN 1 ELSE 0 END) AS waitOnly,
      SUM(CASE WHEN (vetoed_by='weak_or_invalid_conviction' OR vetoed_by LIKE 'weak_conviction %') AND conviction<COALESCE(json_extract(audit_json,'$.config.openGate.minConviction'),json_extract(audit_json,'$.config.limits.minConviction')) THEN 1 ELSE 0 END) AS weakConviction,
      SUM(CASE WHEN (vetoed_by='weak_or_invalid_conviction' OR vetoed_by LIKE 'weak_conviction %') AND json_extract(probabilities_json,'$.' || choice)<COALESCE(json_extract(audit_json,'$.config.openGate.minProb'),json_extract(audit_json,'$.config.limits.minActionProbability')) THEN 1 ELSE 0 END) AS weakProbability,
      SUM(CASE WHEN jev_error IS NOT NULL THEN 1 ELSE 0 END) AS modelFailures
      FROM decisions WHERE id IN (SELECT value FROM json_each(?))`).get(observationIds) as { decisions: number; firstAt: number | null; waits: number; holds: number; waitOnly: number; weakConviction: number; weakProbability: number; modelFailures: number };
    const outcomes = db.prepare(`SELECT status, vetoed_by AS veto, COUNT(*) AS count FROM decisions WHERE id IN (SELECT value FROM json_each(?)) GROUP BY status,vetoed_by ORDER BY count DESC LIMIT 30`).all(observationIds);
    const blockers = db.prepare(`SELECT b.value AS reason, COUNT(DISTINCT d.id) AS decisions
      FROM decisions d, json_each(d.audit_json,'$.entryDiagnostics') c, json_each(c.value,'$.blockers') b
      WHERE d.id IN (SELECT value FROM json_each(?)) GROUP BY b.value ORDER BY decisions DESC`).all(observationIds);
    const recent = db.prepare(`SELECT ts, choice, status, vetoed_by AS veto, conviction, decided_by AS decidedBy, fallback_reason AS fallbackReason,
      json_extract(audit_json,'$.entryDiagnostics') AS diagnostics
      FROM decisions WHERE id IN (SELECT value FROM json_each(?)) ORDER BY ts DESC,id DESC LIMIT 12`).all(observationIds);
    const entries = db.prepare(`SELECT COUNT(*) AS count FROM orders o JOIN decisions d ON d.id=o.decision_id AND d.bee=o.bee
      WHERE o.bee=? AND o.ts>=? AND o.ts<=? AND ${versionFilter} AND o.purpose='open' AND o.state='filled'`).get(cat, since, now, versions);
    const excluded = db.prepare(`SELECT COUNT(*) AS count FROM decisions WHERE bee=? AND ts>=? AND ts<=?
      AND json_extract(audit_json,'$.source') IN ('model_request','rules','code') AND COALESCE((${versionFilter}),0)=0`).get(cat, since, now, versions) as { count: number };
    const performance = { ...aggregateTrades(completedTrades(this.d.db, cat, { since, until: now, version: strategyVersion(this.d.cfg) })),
      note: "Completed current-version round trips opened within this window; partial, mixed-version and unidentified trades are excluded. Slippage is embedded. Funding and model costs are separate and unallocated; a positive sample is not validated profitability." };
    return { performance, since, until: now, strategyVersions, excludedObservations: excluded.count, summary, outcomes, blockers, recent, entries, current: this.d.context(cat) };
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
          { role: "system", content: `${trainerPrompt(cfg)}\n\n${trainerModePrompt(cfg)}` },
          { role: "user", content: JSON.stringify({ cat: { id: cat, name: displayName(cfg, cat), current: coachValues(cfg, cat), allowedCoins: this.baseline[cat].coins, tunableParameters: tunableParameters(cfg, cat) },
            decisionIntervalMs: cfg.tickMs, trainerPolicy: { autoApply: cfg.coach.autoApply, mode: cfg.coach.autoApply ? "automatic_experiment" : "advisory" }, playbook: trainerPlaybook(cfg),
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
            messages.push({ role: "user", content: `Your response failed validation: ${COACH_ERRORS[err.message]} ${err.detail ?? ""} Return a complete replacement JSON object using the original evidence and the required fields including parameterChanges. Keep it concise. Do not add fields or surrounding prose.` });
          }
        }
        if (!review) continue;
        stage = "change";
        const values = this.validate(cat, review, evidence);
        const current = coachValues(cfg, cat);
        const unchanged = this.sameRules(values.rules, current.rules) && JSON.stringify(values.coins) === JSON.stringify(current.coins) && JSON.stringify(values.parameters) === JSON.stringify(current.parameters);
        const status = this.stopped || this.d.closed() || revision !== coachRevision(cfg, cat) || this.now() >= now + DAY
          ? "expired" : unchanged ? "no_change" : cfg.coach.autoApply ? "accepted" : "advisory";
        db.transaction(() => {
          db.raw.prepare("UPDATE coach_reviews SET status=?,review=?,completed_at=?,resolved_at=? WHERE id=?")
            .run(status, JSON.stringify(review), this.now(), this.now(), id);
          if (status === "accepted") this.saveOverride(cat, id, values);
        });
        if (status === "accepted") { this.apply(cat, values); this.d.changed(cat); }
      } catch (err) {
        // Map errors to a fixed vocabulary; never retain a provider body or credential-bearing message.
        const code = err instanceof CoachReviewError ? err.message
          : err instanceof Error && ["TimeoutError", "AbortError"].includes(err.name) ? "timeout"
          : stage === "request" ? "connection" : stage === "response" ? "invalid_response" : "invalid_change";
        db.raw.prepare("UPDATE coach_reviews SET status='failed', resolved_at=?, completed_at=?, error_code=?, error_detail=? WHERE id=?").run(this.now(), this.now(), code, err instanceof CoachReviewError ? err.detail : null, id);
      }
    }
  }
  private validate(cat: BeeId, review: Answer, evidence = this.evidence(cat, this.now())): Values {
    CoachAnswer.parse(review);
    const allowed = this.baseline[cat].coins;
    const coins = review.coins ? review.coins.split(",").map(c => c.trim()) : [...allowed];
    if (new Set(coins).size !== coins.length || coins.some(c => !allowed.includes(c)))
      throw new CoachConflict("The proposed coin list is outside this cat's allowed universe.");
    if (!review.quip.includes(displayName(this.d.cfg, cat))) throw new CoachConflict("The quip must use the cat's display name.");
    const parameters = strategyParameters(this.d.cfg, cat);
    for (const change of review.parameterChanges ?? []) {
      const bound = PARAMETER_BOUNDS[change.field];
      const context = this.d.context(cat) as { position?: unknown; account?: { position?: unknown }; diagnostics?: Array<{blockers: string[]; indicatorsAgeMs?: number | null; maxIndicatorsAgeMs?: number | null}> };
      if (context?.position || context?.account?.position) throw new CoachConflict("Numeric strategy changes require a flat position.");
      if (parameters[change.field] !== change.from || change.to === change.from || change.to < bound.min || change.to > bound.max ||
        Math.abs(change.to - change.from) > bound.maxStep + 1e-9 ||
        (["minTrendScore", "trimScoreDrop"].includes(change.field) && !Number.isInteger(change.to)))
        throw new CoachConflict("Numeric change exceeds the permitted bounds, step or current revision.");
      const blockers = evidence.blockers as Array<{reason: string; decisions: number}>;
      const blocked = bound.evidence === "weakConviction" ? evidence.summary.weakConviction
        : bound.evidence === "weakProbability" ? evidence.summary.weakProbability
        : blockers.find(b => b.reason === bound.evidence)?.decisions ?? 0;
      // Observed inactivity cannot establish a profitable opportunity. All numeric experiments
      // need complete current-version outcomes; relaxing a gate also requires positive net evidence.
      if (evidence.performance.closedTrades < 5) throw new CoachConflict("Need five completed current-version trades for this numeric change.");
      if (change.to < change.from && bound.evidence !== "closed_trades") {
        if (!(evidence.performance.netClosedPnlAfterFeesUsd > 0)) throw new CoachConflict("Entry relaxation requires positive completed-trade P&L after fees.");
        if (blocked < 30) throw new CoachConflict("Insufficient matching entry-blocker evidence.");
        if (!context.diagnostics?.some(d => d.indicatorsAgeMs != null && d.maxIndicatorsAgeMs != null &&
          d.indicatorsAgeMs >= 0 && d.indicatorsAgeMs <= d.maxIndicatorsAgeMs &&
          d.blockers.every(b => b === bound.evidence))) throw new CoachConflict("No fresh feasible signal supporting this parameter change.");
      }
      parameters[change.field] = change.to;
    }
    return { rules: review.rules, coins: allowed.filter(c => coins.includes(c)), parameters };
  }
  private apply(cat: BeeId, values: Values) {
    Object.assign(this.d.cfg.slots[cat], {rules: values.rules, coins: [...values.coins]});
    applyParameters(this.d.cfg, cat, values.parameters);
  }
  private validateSavedParameters(cat: BeeId, values: ParameterValues) {
    const expected = strategyParameters(this.d.cfg, cat);
    if (Object.keys(values).length !== Object.keys(expected).length) throw new CoachConflict("Incomplete saved parameters");
    for (const [key, value] of Object.entries(values)) {
      const bound = PARAMETER_BOUNDS[key as StrategyParameter];
      if (!Object.hasOwn(expected, key) || !bound || !Number.isFinite(value) ||
        (value !== this.baseline[cat].parameters[key as StrategyParameter] && (value! < bound.min || value! > bound.max)) ||
        (["minTrendScore", "trimScoreDrop"].includes(key) && !Number.isInteger(value))) throw new CoachConflict("Invalid saved parameters");
    }
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
    if (action === "accept" && !cfg.coach.autoApply) throw new CoachConflict("Advisory reviews cannot change strategy settings.");
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
    if (action === "accept") { this.apply(row.cat, values); this.d.changed(row.cat); }
    return this.state();
  }
  reset(cat: BeeId) {
    const { db } = this.d;
    if (this.d.closed()) throw new CoachConflict("The experiment is closed.");
    const row = db.raw.prepare("SELECT review_id FROM coach_rule_overrides WHERE cat=?").get(cat) as { review_id: number } | undefined;
    if (!row) throw new CoachConflict("No active coach changes to reset.");
    db.transaction(() => {
      db.raw.prepare("DELETE FROM coach_rule_overrides WHERE cat=?").run(cat);
      db.raw.prepare("UPDATE coach_reviews SET status='rolled_back',resolved_at=? WHERE id=?").run(this.now(), row.review_id);
      db.raw.prepare("UPDATE coach_reviews SET status='expired',resolved_at=? WHERE cat=? AND status='pending'").run(this.now(), cat);
    });
    this.apply(cat, this.baseline[cat]); this.d.changed(cat);
    return this.state();
  }
}
