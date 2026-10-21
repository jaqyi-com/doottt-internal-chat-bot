# Git / GitHub account rules (MANDATORY)

This repo must ALWAYS use the **Parvpaigwar** GitHub account (`parvpaigwar@gmail.com`).

- Commit identity for this repo is set in the **repo-local** git config only:
  - `user.name = Parvpaigwar`
  - `user.email = parvpaigwar@gmail.com`
- Before any commit/push, verify with `git config user.email` → must print `parvpaigwar@gmail.com`. If not, fix it with `git config user.email "parvpaigwar@gmail.com"` (local, no `--global`).
- Push/pull only over SSH: `git@github.com:jaqyi-com/doottt-internal-chat-bot.git` (authenticates via `~/.ssh/id_ed25519_abc`, the Parvpaigwar key). `ssh -T git@github.com` should greet "Hi Parvpaigwar!".
- NEVER use the `epparvpaigwar` account (`parv@engineerphilosophy.com`) for this repo — not for commits, author/committer, pushes, or PRs.
- NEVER modify the global git config (`git config --global ...`), `~/.gitconfig`, `~/.ssh/config`, SSH keys, or GitHub Desktop settings. The epparvpaigwar setup used by GitHub Desktop must stay untouched.
- Do not pass `--author` or set `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars to any other identity.

---
# Project overview — Doott Data Bot (repo: doottt-internal-chat-bot)

Internal ChatGPT-style chatbot for the Doott sales team: paste a lead request (often from WhatsApp) → bot pulls matching records from Doott's Neon Postgres (`final.people` ~45M rows, `final.companies` ~1.6M rows), **checks the data really fits the request**, shows a 10-row sample + total, asks how many, then gives a CSV.
Sibling repos: `Leader-Backend` (Doott app, owns the Neon data) and `ETL_Scraper` (fills the data). This repo is **read-only** towards Neon.

Stack: Next.js 16 (App Router, TypeScript) — UI + API routes in one app, deployed on Vercel. LangGraph.js for the agent, Google Gemini API (OpenAI-compatible endpoint) via `@langchain/openai`, `pg` for Neon, `@libsql/client` (SQLite) for conversations.

## Layout
- `prompts/system_prompt.md` — **the DB knowledge prompt** (schema, indexes, real spelling lists for cities/states/industries, title synonyms, fast SQL patterns, GCC domain list, reply format). Loaded at runtime by every LLM step. Most quality fixes go here.
- `src/lib/agent/` — LangGraph agent: `state.ts` (spec schema, graph state, saved state), `nodes.ts` (all nodes), `graph.ts` (edges + diagram comment), `run.ts` (one user turn: load state → stream graph → save reply/state/trace).
- `src/lib/data/` — `sqlGuard.ts` (static SQL checks + EXPLAIN plan check + LIMIT wrapper + app-owned company join for people), `postprocess.ts` (parse list strings, Indian mobile vs landline, email cleanup, GCC tag, must-haves, dedupe, ranking), `gcc.ts` (GCC / IT-vendor / free-mail domain lists).
- `src/lib/db/neon.ts` (read-only tx + statement_timeout), `src/lib/db/sqlite.ts` (schema auto-created), `src/lib/repo.ts` (all SQLite CRUD), `src/lib/llm.ts` (`llmJson`: JSON-only output + zod validation + 1 repair retry), `src/lib/auth.ts` (password gate).
- `src/app/page.tsx` (chat UI: sidebar, history, live step list, sample table, quick-reply chips, CSV download), `src/app/login/page.tsx`.
- API: `/api/login`, `/api/logout`, `/api/conversations` (GET list, POST new), `/api/conversations/[id]` (GET messages, PATCH rename, DELETE), `/api/conversations/[id]/chat` (POST → SSE stream of `step` events then `final`), `/api/results/[id]/csv`.

## Agent graph (one run per user message)
```
START → route ─┬─ count answer ("100"/"all"/"yes") ─► deliver → END
               └─► understand ─┬─ chitchat ─► END
                               ├─ missing essentials ─► clarify (ask human) → END
                               └─► write_sql → execute ─┬─ error/rejected & tries left ─► write_sql (error fed back)
                                                        └─► enrich → validate ─┬─ pass ─► present_sample → END (stage awaiting_count)
                                                                               ├─ retry & tries left ─► write_sql (reviewer feedback)
                                                                               └─ out of tries ─► present_sample(best) | give_up (ask human)
```
- Human-in-the-loop works across serverless requests by saving `SavedState` (stage, spec, approved SQL, total, GCC cache) in SQLite `conversation_state`; the next message re-enters at `route`.
- Loop limits: `AGENT_MAX_ATTEMPTS` (default 3) SQL attempts per request + `AGENT_RECURSION_LIMIT` (default 30) LangGraph hard stop.
- Validation = deterministic (0 rows → broaden) + LLM reviewer on 25 spread-out rows; best attempt kept by score.
- `deliver` re-runs the approved SQL with LIMIT ≈ 3× requested (cap 5000), cleans, saves rows in `result_sets`; CSV is served from there.

## SQLite tables (conversation store)
`conversations`, `messages` (data_json = table/options/resultId/stage), `conversation_state`, `result_sets`, `agent_runs` (trace: nodes visited, ms, every SQL attempt + verdict — first place to look when a run misbehaves: `sqlite3 data/chat.db "select trace_json from agent_runs order by created_at desc limit 1"`).

## Neon rules learned the hard way (also in the prompt)
- people: every query needs an indexed filter — `job_title ILIKE ANY(...)` (trigram), `city IN (exact list)`, `state IN (exact list)`. `ILIKE` on people.city/state/location = timeout.
- Seniority words (manager/lead/head) must NOT be inside `ILIKE ANY` (trigram scans millions) → use `lower(job_title) ~ '(manager|lead|head)'`. The guard rejects it.
- Never `c.uuid::text = p.company_uuid` (seq-scans 7 GB companies). For people the LLM writes only the people query; `withLimit()` adds a LATERAL uuid lookup. The guard rejects seq scans on people, and on companies when joined with people.
- No GCC / company-size / people-industry columns: GCC comes from email/website domain (`gcc.ts` + LLM classification of unknown domains); size is not filtered (reported as "not in DB").
- `+91-80-xxxx-xxxx` style numbers are landlines (→ `other_phone`), not mobiles.

## Running
- Local: `npm install`, then `npm run dev` → http://localhost:3100. Next reads `.env` (needs `NEON_DATABASE_URL`, `GEMINI_API_KEY`). SQLite file = `data/chat.db`. No `APP_PASSWORD` locally = open.
- Cheap testing: `LLM_MODEL_FAST=gemini-flash-lite-latest LLM_MODEL_SMART=gemini-flash-lite-latest LLM_MAX_TOKENS=1200 npm run dev` (cheap models break SQL rules more often; the guard + retry loop covers it).
- Checks: `npm run typecheck`, `npm run build`. No test suite — verify by chatting (UI or `curl -N POST /api/conversations/<id>/chat`).

## Deploy (Vercel)
- Import repo as a Next.js project. Env vars: `NEON_DATABASE_URL`, `GEMINI_API_KEY`, `CHAT_DATABASE_URL`, `APP_PASSWORD`, `AUTH_SECRET`, optional `LLM_MODEL_FAST`, `LLM_MODEL_SMART`, `LLM_MAX_TOKENS`, `AGENT_MAX_ATTEMPTS`, `AGENT_RECURSION_LIMIT`.
- Vercel's filesystem is not persistent → conversations are stored in Neon via `CHAT_DATABASE_URL` (direct/unpooled URL), in their own schema `chatbot` (`CHAT_DB_SCHEMA`). This is the ONLY place the app writes to Neon; `final` stays read-only. Turso also works. With neither, it falls back to `/tmp/chat.db` and chats break ("not found").
- Chat route has `maxDuration = 300` (needs Fluid compute). A turn takes ~20–60s.
- Production without `APP_PASSWORD` is locked (all API → 401). This app exposes contact data — never deploy it open.

## Working conventions
- Commit messages: conventional style (`feat: ...`, `fix: ...`).
- Never commit `.env`, `data/`, CSV exports. Never print secret values.
- Never write to Neon's `final` schema (only the separate `chatbot` schema for conversations). All data access goes through `readOnlyQuery` (READ ONLY tx + timeout) and SQL from the LLM must pass `staticCheck` + `planCheck`.
- When a request type gives bad results: look at `agent_runs` trace, then fix `prompts/system_prompt.md` (spellings, synonyms, SQL pattern) before touching code.

# Response style (MANDATORY)
- Always reply in very simple, short language — ideally one line.
- Give a detailed explanation only when the user explicitly asks for detail.
