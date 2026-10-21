import { createClient } from "@libsql/client";
import { Pool } from "pg";
import fs from "node:fs";
import path from "node:path";

// Conversation store. Three backends behind one tiny interface:
// - CHAT_DATABASE_URL set → Postgres (Neon), tables in their own schema (CHAT_DB_SCHEMA, default "chatbot"),
//   never in "final". Use the direct (unpooled) URL: the pooler rejects the search_path startup option.
// - TURSO_DATABASE_URL set → Turso (hosted SQLite).
// - otherwise → local SQLite file data/chat.db (on Vercel: /tmp, wiped between cold starts — don't).

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS conversations (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     role TEXT NOT NULL CHECK (role IN ('user','assistant')),
     content TEXT NOT NULL,
     data_json TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at)`,
  // Agent memory between turns (stage, last spec, last SQL, GCC cache) — this is what lets the
  // graph "pause" for a human answer and continue on the next request.
  `CREATE TABLE IF NOT EXISTS conversation_state (
     conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
     state_json TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  // Final delivered record sets (CSV download reads from here).
  `CREATE TABLE IF NOT EXISTS result_sets (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     entity TEXT NOT NULL,
     spec_json TEXT NOT NULL,
     sql TEXT NOT NULL,
     columns_json TEXT NOT NULL,
     rows_json TEXT NOT NULL,
     row_count INTEGER NOT NULL,
     created_at TEXT NOT NULL
   )`,
  // Per-turn trace of the graph (nodes visited, SQL attempts, validator verdicts).
  `CREATE TABLE IF NOT EXISTS agent_runs (
     id TEXT PRIMARY KEY,
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     message_id TEXT,
     trace_json TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
];

type Stmt = string | { sql: string; args?: unknown[] };
export type Store = {
  execute(stmt: Stmt): Promise<{ rows: Record<string, unknown>[] }>;
  batch(stmts: Stmt[], mode?: "write"): Promise<unknown>;
};

let client: Store | null = null;
let ready: Promise<void> | null = null;

// Postgres adapter: SQLite-style "?" placeholders → $1..$n; batch = one transaction.
function pgStore(url: string, schema: string): Store {
  const pool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10_000, ssl: { rejectUnauthorized: false }, options: `-c search_path=${schema}` });
  const toPg = (s: Stmt) => {
    let i = 0;
    const sql = typeof s === "string" ? s : s.sql;
    return { text: sql.replace(/\?/g, () => `$${++i}`), values: typeof s === "string" ? [] : (s.args ?? []) };
  };
  return {
    async execute(s) {
      const r = await pool.query(toPg(s));
      return { rows: r.rows };
    },
    async batch(stmts) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        for (const s of stmts) await c.query(toPg(s));
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    },
  };
}

function resolveUrl(): { url: string; authToken?: string } {
  if (process.env.TURSO_DATABASE_URL) {
    return { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN || undefined };
  }
  if (process.env.VERCEL) {
    console.warn("[sqlite] TURSO_DATABASE_URL not set on Vercel — using /tmp (data is NOT persistent)");
    return { url: "file:/tmp/chat.db" };
  }
  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return { url: `file:${path.join(dir, "chat.db")}` };
}

export async function db(): Promise<Store> {
  if (!client) {
    const pgUrl = process.env.CHAT_DATABASE_URL;
    if (pgUrl) {
      const schema = (process.env.CHAT_DB_SCHEMA || "chatbot").replace(/[^a-zA-Z0-9_]/g, "");
      if (schema.toLowerCase() === "final") throw new Error("CHAT_DB_SCHEMA must not be the read-only data schema");
      const store = pgStore(pgUrl, schema);
      client = store;
      ready = (async () => {
        await store.execute(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
        for (const stmt of SCHEMA) await store.execute(stmt);
      })();
    } else {
      const lite = createClient(resolveUrl());
      client = lite as unknown as Store;
      ready = (async () => {
        await lite.execute("PRAGMA foreign_keys = ON");
        for (const stmt of SCHEMA) await lite.execute(stmt);
      })();
    }
  }
  await ready;
  return client!;
}
