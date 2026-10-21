# CONTEXT — Doott Data Bot (`doottt-internal-chat-bot`)

Analysis snapshot: 2026-10-21 · branch state: `c0660e8` (merge of PR #1 `feat/data-bot`).

## 1. What it is
Internal ChatGPT-style tool for the Doott sales team. A user pastes a lead request (often from WhatsApp, e.g. *"clothes businesses in Rajasthan with valid mobile"*). The bot:
1. turns it into a structured filter spec (LLM),
2. writes a read-only SQL query against Doott's Neon Postgres (LLM),
3. guards + runs it, cleans the rows (mobile / email / GCC / dedupe),
4. has an LLM reviewer check the rows actually match the request (retries up to 3×),
5. shows a 10-row sample + estimated total, asks "how many?",
6. re-runs the approved SQL for that count and serves a CSV.

Read-only towards Neon. Sibling repos: `Leader-Backend` (owns Neon data), `ETL_Scraper` (fills it).

## 2. Stack
| Part | Tech |
|---|---|
| App | Next.js **16.4** App Router, React 19, TypeScript (strict), single app = UI + API, port **3100** |
| Agent | LangGraph.js 1.5 (`@langchain/langgraph`) |
| LLM | Google Gemini via `@langchain/openai` `ChatOpenAI` (baseURL `generativelanguage.googleapis.com/v1beta/openai/`, override `GEMINI_BASE_URL`), temp 0 |
| Models | `LLM_MODEL_FAST` (default `gemini-flash-lite-latest`), `LLM_MODEL_SMART` (default `gemini-3.5-flash`) |
| Data source | Neon Postgres via `pg` (pool max 3, READ ONLY tx, `statement_timeout`) |
| Conversation store | libSQL / SQLite (`@libsql/client`): `data/chat.db` locally, Turso on Vercel |
| Validation | zod 4 |
| Deploy | Vercel (Fluid compute, chat route `maxDuration = 300`) |

`AGENTS.md`: Next 16 has breaking changes — read `node_modules/next/dist/docs/` before writing Next code.

## 3. File map
```
prompts/system_prompt.md      ← THE knowledge prompt: schema, indexes, city/state/industry spellings,
                                title synonyms, SQL patterns, GCC domain list, reply format. Most quality fixes go here.
src/lib/prompt.ts             loads + caches system_prompt.md (shipped via next.config outputFileTracingIncludes)
src/lib/llm.ts                llmJson(schema, system, user, "fast"|"smart"): JSON-only + zod parse + 1 repair retry
src/lib/auth.ts               shared-password gate, HMAC-signed cookie `dbot_session` (7 days)
src/lib/repo.ts               all SQLite CRUD (conversations, messages, state, result_sets, agent_runs)
src/lib/db/neon.ts            readOnlyQuery(sql, params, timeoutMs=25s)
src/lib/db/sqlite.ts          libSQL client + auto-created schema
src/lib/agent/state.ts        SpecSchema, Stage, SavedState, Reply, LangGraph GraphState
src/lib/agent/nodes.ts        every graph node (route, understand, clarify, chitchat, writeSql, execute,
                              enrich, validate, presentSample, giveUp, deliver)
src/lib/agent/graph.ts        edges + NODE_LABELS (UI step text)
src/lib/agent/run.ts          runTurn(): one user message → stream graph → save reply/state/trace
src/lib/data/*                ⚠ MISSING — see §9
src/app/page.tsx              chat UI (sidebar history, SSE step list, sample table, chips, CSV link)
src/app/login/page.tsx        password form
src/app/api/...               routes, see §6
```

## 4. Agent graph (one run per user message)
```
START → route ─┬─ count answer ("100"/"all"/"yes")  ─► deliver → END
               ├─ "yes" but no count known          ─► chitchat ("how many?") → END
               └─► understand ─┬─ chitchat           ─► chitchat → END
                               ├─ missing essentials ─► clarify → END   (stage awaiting_clarification)
                               └─► write_sql → execute ─┬─ SQL error, tries left ─► write_sql
                                                        ├─ SQL error, no tries   ─► present_sample(best) | give_up
                                                        └─► enrich → validate ─┬─ pass             ─► present_sample → END (awaiting_count)
                                                                               ├─ retry, tries left ─► write_sql (with reviewer feedback)
                                                                               └─ out of tries      ─► present_sample(best) | give_up
```
- **route**: deterministic regex, only when `stage === awaiting_count` and msg ≤ 40 chars. Understands `all/sab/saare`, numbers (`100`, `give me 50 leads`), `yes/haan/ok/proceed`.
- **understand** (smart LLM): intent `new_request | refine | clarification_answer | chitchat` + spec. Resets attempt loop.
- **write_sql** (smart LLM): one SELECT, no LIMIT/ORDER BY/`;`. Gets all previous attempts (SQL, error, reviewer verdict).
- **execute**: `staticCheck` → reject people queries that reference `final.companies` → `withLimit` → `planCheck` (EXPLAIN) → run (25s). If cap hit, `cappedCount` (≤ 20001, 15s).
  Fetch limit: `all` → 5000; number → max(1500, n×3×gccBoost) capped 5000; none → 1500×gccBoost (gccBoost = 2 if company_type set).
- **enrich**: for people / GCC requests, classify unknown corporate domains with fast LLM (≤ 40/turn, cached in `saved.gccCache`), then `processRows`.
- **validate**: 0 rows → deterministic "retry/broaden"; else smart LLM reviews 25 evenly-spread rows → `pass | retry | ask_human` + score. Reviewer failure → pass with score 60. Best attempt kept by score.
- **present_sample**: 10 rows, total estimate = `rawTotal × kept / fetched` (or "20,000+"), notes on GCC/size/mobile caveats, chips `25/100/500/all` (or `yes/50/100/all`).
- **deliver**: re-runs saved SQL with fetch limit for wanted count, re-cleans, slices to count (cap 5000), saves `result_sets`, reply has `resultId` → CSV link.
- Limits: `AGENT_MAX_ATTEMPTS` (3), `AGENT_RECURSION_LIMIT` (30).

### Spec (zod `SpecSchema`)
`entity (people|companies), summary, job_functions[], seniority[], industries[], company_type, company_size[], cities[], states[], country ("India"), must_have[mobile|phone|email|verified_email|linkedin], priority_notes, count_requested (int|"all"|null)`

### Human-in-the-loop across serverless requests
`SavedState { stage, spec, sql, total, totalIsLowerBound, gccCache, lastQuestion }` stored in SQLite `conversation_state`. Stages: `idle → awaiting_clarification | awaiting_count → done`. Next message re-enters at `route`.

## 5. Neon data (schema `final`, read-only)
- **people** ~45M rows / 93 GB. No industry, no size, no GCC column. `company_uuid` is text, ~21% filled, **not indexed**. Indexes: `job_title` (trigram + FTS + btree), `city` btree (exact only), `state` btree (exact only), `email_status`, `uuid`, has-LinkedIn partial.
- **companies** ~1.57M rows / 7 GB. `industry` btree + trigram, `city`, `state`, `uuid`, HNSW `embedding`.
- `email_verifications` (~1.1M), `domain_cache`, `disposable_domains`.
- Empty values appear as `''`, `'{}'`, `'.'`, NULL. List columns are strings like `'{a@x.com,b@y.com}'`.

Hard rules (prompt + guard):
- Every people query needs an indexed filter. Never `ILIKE` on people.city/state/location → timeout.
- Seniority words not inside `ILIKE ANY` → use `lower(job_title) ~ '(manager|lead|head)'`.
- Never `c.uuid::text = p.company_uuid`; for people the LLM writes only the people query and `withLimit()` adds a LATERAL company lookup.
- `+91-80-xxxx-xxxx` style = landline → `other_phone`, not mobile.
- Indian state codes that collide with US codes (`IN, GA, MP, TN…`) → full names only. US 2-letter states excluded for India.
- Max 5000 rows per query / export.

## 6. API routes (all `runtime = "nodejs"`, all behind `isAuthed()`)
| Route | Method | Purpose |
|---|---|---|
| `/api/login` | POST `{password}` | sets cookie (no-op if auth disabled) |
| `/api/logout` | POST | deletes cookie |
| `/api/conversations` | GET / POST | list (200 latest) / create |
| `/api/conversations/[id]` | GET / PATCH `{title}` / DELETE | messages / rename / delete (+ children) |
| `/api/conversations/[id]/chat` | POST `{message}` | SSE: `{type:"step",node,label,detail}`… then `{type:"final",message}` or `{type:"error"}`. Message trimmed to 8000 chars |
| `/api/results/[id]/csv` | GET | CSV with BOM, CRLF, formula-injection guard (`=+-@` prefixed with `'`, except `+digits`) |

## 7. SQLite tables
`conversations`, `messages` (`data_json` = table/options/resultId/stage/total), `conversation_state`, `result_sets` (full rows JSON for CSV), `agent_runs` (trace: visited nodes + ms, spec, every SQL attempt + verdict).
Debug last run: `sqlite3 data/chat.db "select trace_json from agent_runs order by created_at desc limit 1"`

## 8. Env vars
| Var | Notes |
|---|---|
| `NEON_DATABASE_URL` (or `NEON_DIRECT_URL`) | required |
| `GEMINI_API_KEY` | required |
| `LLM_MODEL_FAST`, `LLM_MODEL_SMART`, `LLM_MAX_TOKENS` (4000) | optional |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | required on Vercel, else `/tmp/chat.db` (lost) |
| `APP_PASSWORD`, `AUTH_SECRET` | required in production. No password: dev = open, prod = everything 401 |
| `AGENT_MAX_ATTEMPTS` (3), `AGENT_RECURSION_LIMIT` (30) | optional |

## 9. ⚠ Known issues found in this analysis
1. **`src/lib/data/` is missing** — `nodes.ts` imports `../data/sqlGuard` (`staticCheck`, `withLimit`, `planCheck`), `../data/postprocess` (`processRows`, `unknownCorporateDomains`, `columnsFor`), `../data/gcc` (`GccInfo`). Root cause: `.gitignore` line `data/` matches *any* `data` dir, so these files were never committed. `npm run typecheck` / `build` will fail in this checkout.
   Fix: change `.gitignore` `data/` → `/data/`, then recover the 3 files from the original author's machine (or rewrite them) and commit.
2. CSV `result_sets` are not tied to a user — anyone with the password and a result id can download (fine for a single shared password, note if multi-user is added).
3. `neon.ts` uses `ssl: { rejectUnauthorized: false }`.
4. No test suite; verification = chatting via UI or `curl -N -X POST /api/conversations/<id>/chat`.

## 10. Running
```bash
npm install
npm run dev            # http://localhost:3100, reads .env
npm run typecheck
npm run build
# cheap testing
LLM_MODEL_FAST=gemini-flash-lite-latest LLM_MODEL_SMART=gemini-flash-lite-latest LLM_MAX_TOKENS=1200 npm run dev
```
A turn takes ~20–60 s (2–7 LLM calls + Neon queries).

## 11. Conventions (from `claude.md`)
- Git identity for this repo: **Parvpaigwar / parvpaigwar@gmail.com**, repo-local config only, push over SSH to `git@github.com:jaqyi-com/doottt-internal-chat-bot.git`. Never touch global git/SSH config; never use the `epparvpaigwar` account.
- Conventional commits (`feat:`, `fix:`). Never commit `.env`, `/data/`, CSVs. Never print secrets.
- Never write to Neon. All LLM SQL must pass `staticCheck` + `planCheck`.
- Bad results for a request type → read `agent_runs` trace → fix `prompts/system_prompt.md` first, code second.
- Replies to the user: short, simple, one line unless detail is asked.
