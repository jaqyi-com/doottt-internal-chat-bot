import { createClient, type Client } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";

// Conversation store. libSQL = SQLite: a local file in dev, Turso (hosted SQLite) on Vercel.
// Without TURSO_DATABASE_URL on Vercel we fall back to /tmp, which is wiped between cold starts.

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

let client: Client | null = null;
let ready: Promise<void> | null = null;

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

export async function db(): Promise<Client> {
  if (!client) {
    client = createClient(resolveUrl());
    ready = (async () => {
      await client!.execute("PRAGMA foreign_keys = ON");
      for (const stmt of SCHEMA) await client!.execute(stmt);
    })();
  }
  await ready;
  return client;
}
