import { z } from "zod";
import { llmJson } from "../llm";
import { systemPrompt } from "../prompt";
import { readOnlyQuery } from "../db/neon";
import { staticCheck, withLimit, planCheck } from "../data/sqlGuard";
import { processRows, unknownCorporateDomains, columnsFor, lookupEmailStates } from "../data/postprocess";
import type { GccInfo } from "../data/gcc";
import { saveResultSet } from "../repo";
import { SpecSchema, type GState, type Row, type Spec, type Validation, type SavedState, type Reply } from "./state";

export const MAX_ATTEMPTS = Math.max(1, Number(process.env.AGENT_MAX_ATTEMPTS || 3));
const SAMPLE_SIZE = 10;
const HARD_ROW_CAP = 5000;

// ---------------------------------------------------------------------------------------------
// route — cheap deterministic shortcut for "how many?" answers; everything else goes to the LLM.
// ---------------------------------------------------------------------------------------------
export async function route(s: GState): Promise<Partial<GState>> {
  const msg = s.userMessage.trim().toLowerCase();
  if (s.saved.stage === "awaiting_count" && s.saved.spec && s.saved.sql && msg.length <= 40) {
    if (/^(all|everything|sab|saare|full|export all|give all)\b/.test(msg)) {
      return { intent: "count_answer", requestedCount: "all", spec: s.saved.spec };
    }
    const n = msg.match(/^(?:export\s+|give\s+(?:me\s+)?|only\s+)?(\d{1,5})(?:\s*(?:records?|rows?|leads?|contacts?|data))?\s*$/);
    if (n) return { intent: "count_answer", requestedCount: Number(n[1]), spec: s.saved.spec };
    if (/^(yes|y|ok|okay|haan|ha|go|go ahead|export|done|confirm|use these( anyway)?|proceed)\b/.test(msg)) {
      const c = s.saved.spec.count_requested;
      if (c) return { intent: "count_answer", requestedCount: c, spec: s.saved.spec };
      return {
        intent: "chitchat",
        chitchatReply: "How many records do you want? Reply with a number (e.g. 100) or \"all\".",
      };
    }
  }
  return {};
}

// ---------------------------------------------------------------------------------------------
// understand — turn the message (+ previous spec) into a structured filter spec.
// ---------------------------------------------------------------------------------------------
const UnderstandSchema = z.object({
  intent: z.enum(["new_request", "refine", "clarification_answer", "chitchat"]),
  chitchat_reply: z.string().nullable().default(null),
  spec: SpecSchema.nullable().default(null),
  missing_essentials: z.array(z.string()).default([]),
  clarification_question: z.string().nullable().default(null),
});

export async function understand(s: GState): Promise<Partial<GState>> {
  const sys = `${systemPrompt()}

---
YOUR JOB IN THIS STEP: read the user's latest message and produce the filter spec (§3.1).
- intent: "new_request" (a fresh data ask), "refine" (change the previous request, e.g. "only Jaipur", "add email"),
  "clarification_answer" (answering your last question), or "chitchat" (greeting/help/non-data question → put a short reply in chitchat_reply, spec = null).
- For "refine" / "clarification_answer": start from PREVIOUS SPEC and apply the change.
- Keep the user's words for functions/seniority/industries (they are expanded to DB values later), but use canonical city / state names (e.g. "Bengaluru", "Rajasthan").
- "valid mobile", "mobile number", "phone" → must_have "mobile" (India) ; "email" → "email" ; "verified/valid email" → "verified_email".
- company_type: "GCC" when they ask for GCCs / global capability / captive centers, else null.
- count_requested: the number of records they asked for, "all", or null.
- missing_essentials: ONLY list what makes the search impossible (e.g. no location AND no industry/title at all). A missing count is NOT essential.
- If missing_essentials is not empty, write ONE short clarification_question.`;

  const user = `CURRENT STAGE: ${s.saved.stage}
LAST QUESTION YOU ASKED: ${s.saved.lastQuestion ?? "none"}
PREVIOUS SPEC: ${s.saved.spec ? JSON.stringify(s.saved.spec) : "none"}

RECENT CONVERSATION:
${s.history || "(none)"}

LATEST USER MESSAGE:
${s.userMessage}

Return JSON exactly in this shape:
{
  "intent": "new_request" | "refine" | "clarification_answer" | "chitchat",
  "chitchat_reply": string | null,
  "spec": {
    "entity": "people" | "companies",
    "summary": "one-line restatement, e.g. Clothing businesses in Rajasthan with valid mobile",
    "job_functions": string[],
    "seniority": string[],
    "industries": string[],
    "company_type": string | null,
    "company_size": string[],
    "cities": string[],
    "states": string[],
    "country": string | null,
    "must_have": ("mobile" | "phone" | "email" | "verified_email" | "linkedin")[],
    "priority_notes": string,
    "count_requested": number | "all" | null
  } | null,
  "missing_essentials": string[],
  "clarification_question": string | null
}`;

  const out = await llmJson(UnderstandSchema, sys, user, "smart");
  if (out.intent === "chitchat" || !out.spec) {
    return { intent: "chitchat", chitchatReply: out.chitchat_reply || "Tell me what data you need — who, where, and any must-haves (mobile/email)." };
  }
  return {
    intent: out.intent,
    spec: out.spec,
    missing: out.missing_essentials,
    clarifyQuestion: out.clarification_question,
    // fresh search → reset the retry loop
    attempt: 0,
    feedback: [],
    attempts: [],
    best: null,
  };
}

// ---------------------------------------------------------------------------------------------
// ask_human (clarify) — pause the graph: reply with a question, wait for the next message.
// ---------------------------------------------------------------------------------------------
export async function clarify(s: GState): Promise<Partial<GState>> {
  const q = s.clarifyQuestion || `I need a bit more detail: ${s.missing.join(", ")}.`;
  return {
    reply: { text: q, stage: "awaiting_clarification" },
    saved: { ...s.saved, stage: "awaiting_clarification", spec: s.spec, lastQuestion: q },
  };
}

export async function chitchat(s: GState): Promise<Partial<GState>> {
  return { reply: { text: s.chitchatReply || "How can I help?", stage: s.saved.stage === "awaiting_count" ? "awaiting_count" : "idle" } };
}

// ---------------------------------------------------------------------------------------------
// write_sql — LLM writes ONE read-only SELECT, using feedback from earlier failed attempts.
// ---------------------------------------------------------------------------------------------
const SqlSchema = z.object({ sql: z.string().min(10), notes: z.string().default("") });

const REQUIRED_COLUMNS = {
  people: `p.uuid, p.full_name, p.job_title, p.city, p.state, p.location, p.emails, p.phones, p.linked_url, p.email_status, p.company_uuid
FROM final.people p WHERE ...  — write ONLY this people query. Do NOT join final.companies: the app adds the company-name lookup itself.`,
  companies: `c.uuid, c.business_name, c.industry, c.city, c.state, c.pincode, c.address, c.website, c.domain, c.phone, c.phones, c.emails, c.email_status, c.rating, c.reviews`,
};

export async function writeSql(s: GState): Promise<Partial<GState>> {
  const spec = s.spec!;
  const attempt = s.attempt + 1;
  const sys = `${systemPrompt()}

---
YOUR JOB IN THIS STEP: write ONE PostgreSQL SELECT for Neon that returns candidate rows for the spec.
- Follow §4 (normalization) and §5 (SQL patterns) exactly. Expand cities/states/titles/industries into real DB values.
- Return these columns (exact names/aliases): ${REQUIRED_COLUMNS[spec.entity]}
- Do NOT add LIMIT, ORDER BY or a trailing ';' — the system wraps your query with its own LIMIT.
- Put the valid-mobile EXISTS check (§5.3) in SQL when "mobile" is a must-have, and the has-email check when "email" or "verified_email" is.
- "verified_email" is checked by the app after the query (against final.email_verifications) — in SQL only require that an email exists; do NOT join email_verifications.
- GCC and company size are NOT columns — do not try to filter them in SQL (they are tagged after the query).
- On people: the query MUST use an indexed filter (job_title ILIKE trigram, city IN exact list, state IN exact list). Never ILIKE on people.city/state/location.`;

  const prev = s.attempts.length
    ? s.attempts
        .map(
          (a) =>
            `Attempt ${a.attempt}:\nSQL:\n${a.sql}\nResult: ${a.error ? "ERROR " + a.error : `fetched ${a.fetched}, kept ${a.kept} after cleaning`}${
              a.validation ? `\nReviewer: ${a.validation.verdict} (score ${a.validation.score}) — ${a.validation.issues.join("; ")}\nFix: ${a.validation.fix_instructions}` : ""
            }`,
        )
        .join("\n\n")
    : "none";

  const user = `SPEC:
${JSON.stringify(spec, null, 2)}

ORIGINAL USER MESSAGE:
${s.userMessage}

PREVIOUS ATTEMPTS (fix what went wrong, do not repeat the same SQL):
${prev}

This is attempt ${attempt} of ${MAX_ATTEMPTS}.
Return JSON: {"sql": "...", "notes": "one line on what you changed"}`;

  const out = await llmJson(SqlSchema, sys, user, "smart");
  return { sql: out.sql, attempt, sqlError: null };
}

// ---------------------------------------------------------------------------------------------
// execute — guard (static + EXPLAIN) then run read-only with a LIMIT; also a capped total count.
// ---------------------------------------------------------------------------------------------
function fetchLimit(spec: Spec, requested: number | "all" | null): number {
  // GCC-only and verified-email filters drop most rows after the query, so fetch more.
  const gccBoost = (spec.company_type ? 2 : 1) * (spec.must_have.includes("verified_email") ? 2 : 1);
  if (requested === "all") return HARD_ROW_CAP;
  if (typeof requested === "number") return Math.min(HARD_ROW_CAP, Math.max(1500, requested * 3 * gccBoost));
  return Math.min(HARD_ROW_CAP, 1500 * gccBoost);
}

async function runGuarded(rawSql: string, limit: number, entity: Spec["entity"]) {
  const st = staticCheck(rawSql);
  if (!st.ok) throw new Error(`SQL rejected: ${st.reason}`);
  if (entity === "people" && /\bfinal\.companies\b/i.test(st.sql)) {
    throw new Error("SQL rejected: for people, query ONLY final.people — the app joins companies itself.");
  }
  const limited = withLimit(st.sql, limit, entity);
  const plan = await planCheck(limited);
  if (!plan.ok) throw new Error(`SQL rejected: ${plan.reason}`);
  const rows = await readOnlyQuery<Row>(limited, [], 25_000);
  return { sql: st.sql, rows };
}

async function cappedCount(sql: string): Promise<number | null> {
  try {
    const r = await readOnlyQuery<{ n: string }>(`SELECT count(*)::text AS n FROM (SELECT 1 FROM (\n${sql}\n) q LIMIT 20001) c`, [], 15_000);
    return Number(r[0].n);
  } catch {
    return null;
  }
}

export async function execute(s: GState): Promise<Partial<GState> & { _raw?: Row[] }> {
  const spec = s.spec!;
  const limit = fetchLimit(spec, spec.count_requested);
  try {
    const { sql, rows } = await runGuarded(s.sql!, limit, spec.entity);
    const rawTotal = rows.length < limit ? rows.length : await cappedCount(sql);
    return { sql, sqlError: null, rows, fetched: rows.length, hitCap: rows.length >= limit, rawTotal };
  } catch (err) {
    let msg = String((err as Error).message || err).slice(0, 600);
    if (/statement timeout/i.test(msg)) {
      msg += " — the query was too slow. Check: no c.uuid::text join (use LATERAL §5.5), seniority words not inside ILIKE ANY (use lower(job_title) ~ '...'), exact city/state IN lists, fewer generic keywords.";
    }
    const attempts = [...s.attempts, { attempt: s.attempt, sql: s.sql || "", error: msg }];
    return {
      sqlError: msg,
      rows: [],
      fetched: 0,
      attempts,
      feedback: [...s.feedback, `Attempt ${s.attempt} failed: ${msg}`],
    };
  }
}

// ---------------------------------------------------------------------------------------------
// enrich — GCC tagging for unknown corporate domains (LLM), then deterministic cleaning.
// ---------------------------------------------------------------------------------------------
const GccSchema = z.object({
  domains: z.array(
    z.object({
      domain: z.string(),
      gcc: z.enum(["yes", "likely", "no", "unknown"]),
      company: z.string().nullable().default(null),
      sector: z.string().nullable().default(null),
    }),
  ),
});

async function classifyUnknownDomains(domains: string[], cache: Record<string, GccInfo>): Promise<Record<string, GccInfo>> {
  const todo = domains.filter((d) => !cache[d]).slice(0, 40);
  if (!todo.length) return cache;
  const sys = `You classify company email/web domains for India GCC (Global Capability Center) detection.
A GCC = a multinational's own in-house India center (captive): e.g. Goldman Sachs, Target, SAP Labs, Bosch.
NOT GCC: IT services/outsourcing vendors (TCS, Infosys, Wipro, HCL, Accenture, Cognizant, Capgemini...), Indian domestic companies, small local businesses, recruitment agencies.
Use "likely" when the parent is a large multinational that is known to run India centers but you are not sure about this one; "unknown" if you don't recognise the domain.`;
  const out = await llmJson(GccSchema, sys, `Domains:\n${todo.join("\n")}\n\nReturn {"domains":[{"domain","gcc","company","sector"}]}`, "fast");
  const next = { ...cache };
  for (const d of out.domains) {
    next[d.domain.toLowerCase()] = { gcc: d.gcc, company: d.company ?? undefined, sector: d.sector ?? undefined };
  }
  for (const d of todo) if (!next[d]) next[d] = { gcc: "unknown" };
  return next;
}

export async function enrich(s: GState): Promise<Partial<GState>> {
  const spec = s.spec!;
  let cache = s.saved.gccCache || {};
  const needGcc = Boolean(spec.company_type) || spec.entity === "people";
  if (needGcc && s.rows.length) {
    try {
      cache = await classifyUnknownDomains(unknownCorporateDomains(s.rows, spec, cache), cache);
    } catch (err) {
      console.warn("[enrich] GCC classification failed:", err);
    }
  }
  const emailStates = s.rows.length ? await lookupEmailStates(s.rows).catch((err) => (console.warn("[enrich] email lookup failed:", err), {})) : {};
  const processed = processRows(s.rows, spec, cache, emailStates);
  // No verified emails exist for this segment: don't burn retries on SQL — show unverified ones and say so.
  if (!processed.length && spec.must_have.includes("verified_email")) {
    const relaxedSpec = { ...spec, summary: spec.summary.replace(/\b(verified|valid|deliverable)\s+(?=emails?)/i, ""), must_have: spec.must_have.map((m) => (m === "verified_email" ? "email" : m)) as Spec["must_have"] };
    const relaxed = processRows(s.rows, relaxedSpec, cache, emailStates);
    if (relaxed.length) {
      const checked = Object.keys(emailStates).length;
      const emailNote = `⚠️ None of these emails are verified yet (${checked ? `${checked} were checked, none deliverable` : "none of them are in our verification table"}). Showing unverified emails instead.`;
      return { rows: relaxed, spec: relaxedSpec, emailNote, saved: { ...s.saved, gccCache: cache } };
    }
  }
  return { rows: processed, saved: { ...s.saved, gccCache: cache } };
}

// ---------------------------------------------------------------------------------------------
// validate — does the data actually fulfil the request? deterministic checks + LLM reviewer.
// ---------------------------------------------------------------------------------------------
const ValidationSchema = z.object({
  verdict: z.enum(["pass", "retry", "ask_human"]),
  score: z.number().min(0).max(100),
  issues: z.array(z.string()).default([]),
  fix_instructions: z.string().default(""),
  question: z.string().nullable().default(null),
});

function spread<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
}

export async function validate(s: GState): Promise<Partial<GState>> {
  const spec = s.spec!;
  const kept = s.rows.length;
  let v: Validation;

  if (kept === 0) {
    v = {
      verdict: "retry",
      score: 0,
      issues: [s.fetched ? `SQL returned ${s.fetched} rows but none survived cleaning (must-haves / GCC / names).` : "SQL returned 0 rows."],
      fix_instructions:
        "Broaden: add more spelling variants for city/state (case variants, old names), more job-title synonyms, also match business_name for industry, use OR between state list and major-city list, and push must-have checks (mobile/email) into SQL so more matching rows are fetched.",
      question: null,
    };
  } else {
    const sys = `You are a strict data QA reviewer for a B2B lead database bot. Decide if the returned records fulfil the user's request.
Judge relevance of each sample row against the spec: job function, seniority, location, industry, GCC, must-haves.
- "pass": >= 80% of sample rows clearly match AND there are enough rows (or the data simply has no more).
- "retry": rows are wrong/irrelevant in a way a better SQL could fix (wrong city, unrelated titles, wrong industry, too few rows because filters were too narrow). Give precise fix_instructions for the SQL writer.
- "ask_human": the request cannot be met with this database (needed field doesn't exist, contradictory ask) — write a short question offering options.
Missing GCC/size columns are known gaps: GCC is tagged from email domains, size is not available — do NOT fail only because of that.`;
    const user = `SPEC: ${JSON.stringify(spec)}
SQL: ${s.sql}
STATS: fetched ${s.fetched} rows (cap hit: ${s.hitCap}), kept ${kept} after cleaning, raw total ~${s.rawTotal ?? "unknown"}, requested: ${spec.count_requested ?? "not given"}
SAMPLE ROWS (${Math.min(25, kept)} of ${kept}):
${JSON.stringify(spread(s.rows, 25), null, 0)}

Return {"verdict","score","issues":[...],"fix_instructions","question"}`;
    try {
      v = await llmJson(ValidationSchema, sys, user, "smart");
    } catch (err) {
      v = { verdict: "pass", score: 60, issues: [`Reviewer unavailable: ${String(err).slice(0, 120)}`], fix_instructions: "", question: null };
    }
  }

  const attempts = [...s.attempts, { attempt: s.attempt, sql: s.sql || "", fetched: s.fetched, kept, validation: v }];
  const best =
    kept > 0 && (!s.best || v.score > s.best.score)
      ? { sql: s.sql!, rows: s.rows, fetched: s.fetched, hitCap: s.hitCap, rawTotal: s.rawTotal, score: v.score, validation: v }
      : s.best;
  const feedback = v.verdict === "pass" ? s.feedback : [...s.feedback, `Attempt ${s.attempt}: ${v.issues.join("; ")} → ${v.fix_instructions}`];
  return { validation: v, attempts, best, feedback };
}

// ---------------------------------------------------------------------------------------------
// present_sample — show 10 rows + total, then pause for "how many?"
// ---------------------------------------------------------------------------------------------
function estimateTotal(b: NonNullable<GState["best"]>): { total: number; lowerBound: boolean } {
  const kept = b.rows.length;
  if (!b.hitCap) return { total: kept, lowerBound: false };
  if (b.rawTotal && b.fetched) {
    const est = Math.round((b.rawTotal * kept) / b.fetched);
    return { total: Math.max(est, kept), lowerBound: b.rawTotal >= 20001 };
  }
  return { total: kept, lowerBound: true };
}

function describeSpec(spec: Spec): string {
  const parts = [
    spec.job_functions.length && `functions: ${spec.job_functions.join(", ")}`,
    spec.seniority.length && `seniority: ${spec.seniority.join(", ")}`,
    spec.industries.length && `industry: ${spec.industries.join(", ")}`,
    spec.company_type && `type: ${spec.company_type}`,
    (spec.cities.length || spec.states.length) && `location: ${[...spec.cities, ...spec.states].join(", ")}`,
    spec.must_have.length && `must have: ${spec.must_have.join(", ")}`,
  ].filter(Boolean);
  return parts.join(" · ");
}

export async function presentSample(s: GState): Promise<Partial<GState>> {
  const spec = s.spec!;
  const b = s.best!;
  const { total, lowerBound } = estimateTotal(b);
  const passed = b.validation.verdict === "pass";
  const lines: string[] = [];
  lines.push(`**${spec.summary}**`);
  lines.push(`Found ${lowerBound ? "20,000+" : (b.hitCap ? "~" : "") + total.toLocaleString("en-IN")} matching ${spec.entity === "people" ? "people" : "companies"}. Here are ${Math.min(SAMPLE_SIZE, b.rows.length)} samples.`);
  lines.push(`Filters: ${describeSpec(spec)}`);
  const notes: string[] = [];
  if (spec.company_type) notes.push("GCC is detected from email/website domains (no GCC column in DB)");
  if (spec.company_size.length) notes.push("company size is not in the DB — not filtered");
  if (spec.must_have.includes("mobile")) notes.push("mobile = valid Indian mobile format, not live-checked");
  if (spec.must_have.includes("verified_email")) notes.push("verified email = passed the SMTP check in our email_verifications table");
  if (notes.length) lines.push(`Note: ${notes.join("; ")}.`);
  if (s.emailNote) lines.push(s.emailNote);
  if (!passed) {
    lines.push(`⚠️ Quality check after ${s.attempts.length} attempt(s): ${b.validation.issues.join("; ") || "partial match"}.`);
    if (b.validation.question) lines.push(b.validation.question);
  }
  const n = spec.count_requested;
  lines.push(n ? `You asked for ${n === "all" ? "all" : n} — reply **yes** to export, or send another number.` : "How many records do you want?");

  const reply: Reply = {
    text: lines.join("\n\n"),
    stage: "awaiting_count",
    table: { columns: columnsFor(spec), rows: b.rows.slice(0, SAMPLE_SIZE) },
    total,
    totalIsLowerBound: lowerBound,
    options: n ? ["yes", "50", "100", "all"] : ["25", "100", "500", "all"],
  };
  const saved: SavedState = {
    ...s.saved,
    stage: "awaiting_count",
    spec,
    sql: b.sql,
    total,
    totalIsLowerBound: lowerBound,
    lastQuestion: "How many records do you want?",
  };
  return { reply, saved };
}

// Max attempts used and nothing usable → hand back to the human.
export async function giveUp(s: GState): Promise<Partial<GState>> {
  const last = s.attempts[s.attempts.length - 1];
  const why = last?.error || last?.validation?.issues.join("; ") || "no matching rows";
  const text = `I tried ${s.attempts.length} different searches but couldn't find records that match.\n\nLast problem: ${why}\n\nCan you loosen something? For example a nearby city / whole state, broader job titles, or drop a must-have (mobile/email).`;
  return {
    reply: { text, stage: "awaiting_clarification", options: ["Use whole state", "Broader job titles", "Drop mobile requirement"] },
    saved: { ...s.saved, stage: "awaiting_clarification", spec: s.spec, lastQuestion: text },
  };
}

// ---------------------------------------------------------------------------------------------
// deliver — re-run the approved SQL for the requested count, clean, save the result set.
// ---------------------------------------------------------------------------------------------
export async function deliver(s: GState): Promise<Partial<GState>> {
  const spec = s.saved.spec!;
  const sql = s.saved.sql!;
  const want = s.requestedCount === "all" ? Math.min(s.saved.total ?? HARD_ROW_CAP, HARD_ROW_CAP) : Math.min(Number(s.requestedCount), HARD_ROW_CAP);
  const limit = fetchLimit(spec, s.requestedCount === "all" ? "all" : want);

  let rows: Row[];
  let cache = s.saved.gccCache || {};
  try {
    const res = await runGuarded(sql, limit, spec.entity);
    if (spec.company_type || spec.entity === "people") {
      cache = await classifyUnknownDomains(unknownCorporateDomains(res.rows, spec, cache), cache).catch(() => cache);
    }
    const emailStates = await lookupEmailStates(res.rows).catch(() => ({}));
    rows = processRows(res.rows, spec, cache, emailStates).slice(0, want);
  } catch (err) {
    return {
      reply: { text: `Export failed: ${String((err as Error).message).slice(0, 300)}. Try a smaller number or refine the request.`, stage: "awaiting_count" },
    };
  }

  const columns = columnsFor(spec);
  const resultId = await saveResultSet({ conversationId: s.conversationId, entity: spec.entity, spec, sql, columns, rows });
  const withMobile = rows.filter((r) => r.mobile).length;
  const verified = rows.filter((r) => r.email_status === "verified").length;
  const withEmail = rows.filter((r) => r.email).length;
  const short = rows.length < want;
  const text = [
    `✅ **${rows.length.toLocaleString("en-IN")} records ready**${short ? ` (only ${rows.length} matched — you asked for ${want})` : ""}.`,
    `${withMobile} with mobile · ${withEmail} with email (${verified} verified)`,
    `Download the CSV below. You can also refine (e.g. "only Jaipur", "add email") and I'll search again.`,
  ].join("\n\n");

  return {
    reply: { text, stage: "done", table: { columns, rows: rows.slice(0, SAMPLE_SIZE) }, total: rows.length, resultId },
    saved: { ...s.saved, stage: "done", gccCache: cache, lastQuestion: null },
  };
}
