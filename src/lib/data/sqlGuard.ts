import { readOnlyQuery } from "../db/neon";

// Guards for LLM-written SQL. Neon access is already a READ ONLY transaction with a timeout;
// these checks reject unsafe statements and queries that would scan the 45M-row people table.

type Check = { ok: true; sql: string } | { ok: false; reason: string };

const FORBIDDEN =
  /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|analyze|reindex|cluster|lock|listen|notify|refresh|set|reset|discard|prepare|execute|deallocate|pg_sleep|pg_read_file|pg_ls_dir|lo_import|lo_export|dblink|pg_terminate_backend|pg_cancel_backend|set_config)\b/i;

const SENIORITY = /^%?\s*(senior\s+|sr\.?\s+|assistant\s+|associate\s+)?(manager|managers|lead|leads|head|heads|director|directors|vp|vice president|executive|officer|senior|sr|associate|assistant|chief)\s*%?$/i;

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

// Remove string literals so keyword checks don't fire on values like '%update%'.
function withoutStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

export function staticCheck(raw: string): Check {
  let sql = stripComments(raw).trim().replace(/;+\s*$/, "").trim();
  if (!sql) return { ok: false, reason: "empty SQL" };
  const bare = withoutStrings(sql);
  if (bare.includes(";")) return { ok: false, reason: "only ONE statement is allowed" };
  if (!/^\s*(select|with)\b/i.test(bare)) return { ok: false, reason: "only SELECT queries are allowed" };
  const bad = bare.match(FORBIDDEN);
  if (bad) return { ok: false, reason: `forbidden keyword "${bad[1]}"` };
  if (/\binto\b/i.test(bare)) return { ok: false, reason: "SELECT INTO is not allowed" };
  if (/\b(pg_catalog|information_schema|pg_shadow|pg_authid)\b/i.test(bare)) {
    return { ok: false, reason: "system catalogs are not allowed" };
  }

  const usesPeople = /\bfinal\.people\b/i.test(bare);
  if (usesPeople) {
    if (/\buuid\s*::\s*text\s*=\s*\w*\.?company_uuid\b|\bcompany_uuid\s*=\s*\w*\.?uuid\s*::\s*text\b/i.test(bare)) {
      return { ok: false, reason: "never join companies with c.uuid::text = p.company_uuid (seq-scans companies); query only final.people" };
    }
    if (/\b(?:\w+\.)?(city|state|location|emails|phones)\s+(not\s+)?i?like\b/i.test(bare)) {
      return { ok: false, reason: "no ILIKE/LIKE on people.city/state/location/emails/phones — use exact IN (...) lists" };
    }
    // Seniority words inside ILIKE ANY(ARRAY[...]) make the trigram index scan millions of rows.
    for (const m of sql.matchAll(/ilike\s+any\s*\(\s*array\s*\[([^\]]*)\]/gi)) {
      const values = [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((v) => v[1]);
      const generic = values.filter((v) => SENIORITY.test(v.trim()));
      if (generic.length) {
        return {
          ok: false,
          reason: `seniority words (${generic.join(", ")}) must not be inside ILIKE ANY — use lower(p.job_title) ~ '(manager|lead|head)' instead`,
        };
      }
    }
    if (/\bselect\s+\*\s+from\s+final\.people\b/i.test(bare)) return { ok: false, reason: "no SELECT * on final.people" };
  }
  return { ok: true, sql };
}

const UUID_RE = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

// Wrap the query with our LIMIT. For people, also add the company lookup through the uuid index
// (the LLM must not write that join itself — company_uuid is text and not indexed).
export function withLimit(sql: string, limit: number, entity: "people" | "companies"): string {
  const n = Math.max(1, Math.floor(limit));
  if (entity === "companies") return `SELECT * FROM (\n${sql}\n) q LIMIT ${n}`;
  return `SELECT q.*, co.company_name, co.company_industry, co.company_website, co.company_domain
FROM (
${sql}
LIMIT ${n}
) q
LEFT JOIN LATERAL (
  SELECT c.business_name AS company_name, c.industry AS company_industry, c.website AS company_website, c.domain AS company_domain
  FROM final.companies c
  WHERE c.uuid = CASE WHEN q.company_uuid ~ '${UUID_RE}' THEN q.company_uuid::uuid END
  LIMIT 1
) co ON true`;
}

type PlanNode = { "Node Type"?: string; "Relation Name"?: string; Plans?: PlanNode[] };

function walk(node: PlanNode, out: PlanNode[]) {
  out.push(node);
  for (const p of node.Plans ?? []) walk(p, out);
}

// EXPLAIN (no ANALYZE) and reject plans that seq-scan people, or companies when joined with people.
export async function planCheck(sql: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  let plan: PlanNode;
  try {
    const rows = await readOnlyQuery<Record<string, unknown>>(`EXPLAIN (FORMAT JSON) ${sql}`, [], 10_000);
    const raw = rows[0]?.["QUERY PLAN"];
    const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as { Plan: PlanNode }[];
    plan = parsed[0].Plan;
  } catch (err) {
    return { ok: false, reason: `EXPLAIN failed: ${String((err as Error).message || err).slice(0, 300)}` };
  }
  const nodes: PlanNode[] = [];
  walk(plan, nodes);
  const seq = (rel: string) => nodes.some((n) => /Seq Scan/.test(n["Node Type"] ?? "") && n["Relation Name"] === rel);
  const touches = (rel: string) => nodes.some((n) => n["Relation Name"] === rel);
  if (seq("people")) {
    return { ok: false, reason: "plan does a full scan of final.people (45M rows) — add an indexed filter: job_title ILIKE ANY, city IN (...), or state IN (...)" };
  }
  if (touches("people") && seq("companies")) {
    return { ok: false, reason: "plan does a full scan of final.companies joined with people — do not join companies in a people query" };
  }
  return { ok: true };
}
