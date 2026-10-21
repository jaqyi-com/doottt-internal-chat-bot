import type { Spec, Row } from "../agent/state";
import { readOnlyQuery } from "../db/neon";
import { FREE_MAIL_DOMAINS, knownDomain, type GccInfo } from "./gcc";

// Deterministic cleaning of raw DB rows: parse list strings, split Indian mobiles from landlines,
// clean emails, tag GCC, apply must-haves, dedupe and rank. Output rows use columnsFor(spec).

const ROLE_MAILBOX = /^(info|sales|admin|support|contact|hr|careers|career|jobs|noreply|no-reply|enquiry|enquiries|office|mail|hello|accounts|billing|marketing|team|help|service|customercare)@/i;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

// US 2-letter codes, minus those that are also used for Indian states (GA Goa, TN Tamil Nadu, …).
const US_STATES = new Set(
  "AL AK AZ CA CO DE FL HI ID IL IA KS KY ME MD MA MI MS MO MT NE NV NH NJ NM NY NC ND OH OK PA RI SC SD TX UT VT VA WA WV WI WY DC".split(" "),
);

export function parseList(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  const s = String(v).trim().replace(/^\{|\}$/g, "");
  return s
    .split(",")
    .map((x) => x.trim().replace(/^"|"$/g, "").trim())
    .filter((x) => x && x !== "." && x !== "{}" && x.toLowerCase() !== "null");
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

// Indian mobile: 10 digits starting 6–9 (optional 91 / 0 prefix). "+91-80-4127-1000" style
// numbers (a 2–4 digit STD group after the country code) are landlines even though the digits pass.
export function classifyPhone(raw: string): { mobile?: string; other?: string } {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return {};
  const m = digits.match(/^(?:91|0)?([6-9]\d{9})$/);
  if (m) {
    const groups = raw.replace(/^\s*(\+?91|0)[\s-]*/, "").split(/[\s\-().]+/).filter(Boolean);
    const std = groups.length > 1 && /^[1-8]\d{1,3}$/.test(groups[0]);
    if (!std) return { mobile: `+91${m[1]}` };
  }
  return { other: raw.trim() };
}

export function domainOf(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  const host = v.includes("@") ? v.split("@").pop()! : v.replace(/^[a-z]+:\/\//, "").split(/[/?#:]/)[0];
  const d = host.replace(/^www\./, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

function cleanEmails(v: unknown, preferPersonal: boolean): string[] {
  const list = parseList(v)
    .map((e) => e.toLowerCase())
    .filter((e) => EMAIL_RE.test(e) && !e.endsWith("@example.com"));
  const uniq = [...new Set(list)];
  if (!preferPersonal) return uniq;
  return [...uniq.filter((e) => !ROLE_MAILBOX.test(e)), ...uniq.filter((e) => ROLE_MAILBOX.test(e))];
}

function cleanUrl(v: unknown): string {
  const s = str(v);
  return s === "{}" || s === "." ? "" : s.replace(/^\{|\}$/g, "");
}

// Real SMTP verification results (final.email_verifications, unique index on email; stored lower-case).
// people.email_status is "pending" for ~99% of rows, so this is the main source of "verified".
export async function lookupEmailStates(rows: Row[]): Promise<Record<string, string>> {
  const emails = [...new Set(rows.flatMap((r) => parseList(r.emails).map((e) => e.toLowerCase())).filter((e) => EMAIL_RE.test(e)))];
  const out: Record<string, string> = {};
  for (let i = 0; i < emails.length; i += 2000) {
    const res = await readOnlyQuery<{ email: string; state: string }>(
      "SELECT email, state FROM final.email_verifications WHERE email = ANY($1::text[])",
      [emails.slice(i, i + 2000)],
      15_000,
    );
    for (const r of res) out[r.email] = r.state;
  }
  return out;
}

// Domains that need the LLM GCC classifier: corporate, not in our lists, not cached yet.
export function unknownCorporateDomains(rows: Row[], spec: Spec, cache: Record<string, GccInfo>): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const candidates =
      spec.entity === "people"
        ? [...parseList(r.emails), str(r.company_website), str(r.company_domain)]
        : [str(r.website), str(r.domain), ...parseList(r.emails)];
    for (const c of candidates) {
      const d = domainOf(c);
      if (!d || FREE_MAIL_DOMAINS.has(d) || knownDomain(d) || cache[d]) continue;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
}

function gccFor(domains: string[], cache: Record<string, GccInfo>): GccInfo {
  let best: GccInfo = { gcc: "unknown" };
  const rank = { yes: 3, likely: 2, no: 1, unknown: 0 };
  for (const d of domains) {
    const info = knownDomain(d) ?? cache[d];
    if (info && rank[info.gcc] > rank[best.gcc]) best = info;
  }
  return best;
}

export function columnsFor(spec: Spec): string[] {
  const gcc = spec.entity === "people" || spec.company_type ? ["gcc", "gcc_company", "gcc_sector"] : [];
  if (spec.entity === "people") {
    return ["full_name", "job_title", "company_name", "company_industry", ...gcc, "city", "state", "mobile", "other_phone", "email", "email_status", "linkedin"];
  }
  return ["business_name", "industry", ...gcc, "city", "state", "pincode", "mobile", "other_phone", "email", "email_status", "website", "rating", "reviews", "address"];
}

const EMAIL_RANK: Record<string, number> = { deliverable: 3, risky: 1, unknown: 0 };

export function processRows(rows: Row[], spec: Spec, cache: Record<string, GccInfo>, emailStates: Record<string, string> = {}): Row[] {
  const people = spec.entity === "people";
  const india = !spec.country || /india/i.test(spec.country);
  const wantGccOnly = Boolean(spec.company_type && /gcc|capability|captive/i.test(spec.company_type));
  const techPriority = /tech|data|analytic|engineer|digital/i.test(spec.priority_notes);

  const out: (Row & { _score: number })[] = [];
  const seenUuid = new Set<string>();
  const seenKey = new Set<string>();

  for (const r of rows) {
    const uuid = str(r.uuid);
    if (uuid) {
      if (seenUuid.has(uuid)) continue;
      seenUuid.add(uuid);
    }

    const state = str(r.state);
    if (india && US_STATES.has(state.toUpperCase()) && state.length === 2) continue;

    const phones = people ? parseList(r.phones) : [...parseList(r.phones), str(r.phone)].filter(Boolean);
    let mobile = "";
    const others: string[] = [];
    for (const p of phones) {
      const c = classifyPhone(p);
      if (c.mobile && !mobile) mobile = c.mobile;
      else if (c.other && !others.includes(c.other)) others.push(c.other);
    }

    // Drop emails proven undeliverable; prefer deliverable > risky > not checked (stable, so personal-first order is kept).
    const rowDeliverable = str(r.email_status).toLowerCase() === "deliverable";
    const stateOf = (e: string) => emailStates[e] ?? (rowDeliverable ? "deliverable" : "");
    const emails = cleanEmails(r.emails, people)
      .filter((e) => stateOf(e) !== "undeliverable")
      .sort((a, b) => (EMAIL_RANK[stateOf(b)] ?? 0) - (EMAIL_RANK[stateOf(a)] ?? 0));
    const email = emails[0] ?? "";
    const st = stateOf(email);
    const emailStatus = !email ? "" : st === "deliverable" ? "verified" : st === "risky" ? "risky" : "unverified";
    const linkedin = people ? cleanUrl(r.linked_url) : "";
    const website = people ? cleanUrl(r.company_website) : cleanUrl(r.website);

    const domains = (people ? [...emails, website, str(r.company_domain)] : [website, str(r.domain), ...emails])
      .map((x) => domainOf(x))
      .filter((d): d is string => Boolean(d) && !FREE_MAIL_DOMAINS.has(d!));
    const g = gccFor(domains, cache);

    if (people && !str(r.full_name)) continue;
    if (!people && !str(r.business_name)) continue;
    if (wantGccOnly && g.gcc !== "yes" && g.gcc !== "likely") continue;

    const must = new Set(spec.must_have);
    if (must.has("mobile") && !mobile) continue;
    if (must.has("phone") && !mobile && !others.length) continue;
    if (must.has("email") && !email) continue;
    if (must.has("verified_email") && emailStatus !== "verified") continue;
    if (must.has("linkedin") && !linkedin) continue;

    const key = people ? `${str(r.full_name).toLowerCase()}|${email}` : `${str(r.business_name).toLowerCase()}|${mobile || others[0] || ""}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);

    let score = 0;
    if (g.gcc === "yes") score += 4;
    else if (g.gcc === "likely") score += 2;
    if (mobile) score += 2;
    if (email) score += emailStatus === "verified" ? 2 : 1;
    if (linkedin) score += 1;
    if (techPriority && people && /tech|data|analytic|engineer|digital|software|IT\b/i.test(str(r.job_title))) score += 2;

    const base: Row = people
      ? {
          full_name: str(r.full_name),
          job_title: str(r.job_title),
          company_name: str(r.company_name) || g.company || "",
          company_industry: str(r.company_industry) || g.sector || "",
          linkedin,
        }
      : {
          business_name: str(r.business_name),
          industry: str(r.industry),
          pincode: str(r.pincode),
          website,
          rating: str(r.rating),
          reviews: str(r.reviews),
          address: str(r.address),
        };

    out.push({
      ...base,
      gcc: g.gcc,
      gcc_company: g.company ?? "",
      gcc_sector: g.sector ?? "",
      city: str(r.city),
      state,
      mobile,
      other_phone: others.join(" / "),
      email,
      email_status: emailStatus,
      _score: score,
    });
  }

  out.sort((a, b) => b._score - a._score);
  return out.map(({ _score, ...row }) => row);
}
