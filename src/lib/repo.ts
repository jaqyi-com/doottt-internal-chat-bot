import { randomUUID } from "node:crypto";
import { db } from "./db/sqlite";
import type { SavedState } from "./agent/state";

export type Conversation = { id: string; title: string; created_at: string; updated_at: string };
export type Message = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  data: Record<string, unknown> | null;
  created_at: string;
};

const now = () => new Date().toISOString();

export async function listConversations(): Promise<Conversation[]> {
  const c = await db();
  const r = await c.execute("SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 200");
  return r.rows as unknown as Conversation[];
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const c = await db();
  const r = await c.execute({ sql: "SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?", args: [id] });
  return (r.rows[0] as unknown as Conversation) ?? null;
}

export async function createConversation(title = "New chat"): Promise<Conversation> {
  const c = await db();
  const conv = { id: randomUUID(), title, created_at: now(), updated_at: now() };
  await c.execute({
    sql: "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    args: [conv.id, conv.title, conv.created_at, conv.updated_at],
  });
  return conv;
}

export async function renameConversation(id: string, title: string) {
  const c = await db();
  await c.execute({ sql: "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?", args: [title.slice(0, 120), now(), id] });
}

export async function touchConversation(id: string) {
  const c = await db();
  await c.execute({ sql: "UPDATE conversations SET updated_at = ? WHERE id = ?", args: [now(), id] });
}

export async function deleteConversation(id: string) {
  const c = await db();
  // libSQL remote connections don't keep PRAGMA foreign_keys per request, so delete children explicitly.
  await c.batch(
    [
      { sql: "DELETE FROM messages WHERE conversation_id = ?", args: [id] },
      { sql: "DELETE FROM conversation_state WHERE conversation_id = ?", args: [id] },
      { sql: "DELETE FROM result_sets WHERE conversation_id = ?", args: [id] },
      { sql: "DELETE FROM agent_runs WHERE conversation_id = ?", args: [id] },
      { sql: "DELETE FROM conversations WHERE id = ?", args: [id] },
    ],
    "write",
  );
}

export async function listMessages(conversationId: string): Promise<Message[]> {
  const c = await db();
  const r = await c.execute({
    sql: "SELECT id, conversation_id, role, content, data_json, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
    args: [conversationId],
  });
  return r.rows.map((row) => ({
    id: row.id as string,
    conversation_id: row.conversation_id as string,
    role: row.role as "user" | "assistant",
    content: row.content as string,
    data: row.data_json ? JSON.parse(row.data_json as string) : null,
    created_at: row.created_at as string,
  }));
}

export async function addMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  data: Record<string, unknown> | null = null,
): Promise<Message> {
  const c = await db();
  const msg = { id: randomUUID(), conversation_id: conversationId, role, content, data, created_at: now() };
  await c.execute({
    sql: "INSERT INTO messages (id, conversation_id, role, content, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    args: [msg.id, conversationId, role, content, data ? JSON.stringify(data) : null, msg.created_at],
  });
  await touchConversation(conversationId);
  return msg;
}

export async function loadState(conversationId: string): Promise<SavedState | null> {
  const c = await db();
  const r = await c.execute({ sql: "SELECT state_json FROM conversation_state WHERE conversation_id = ?", args: [conversationId] });
  return r.rows[0] ? (JSON.parse(r.rows[0].state_json as string) as SavedState) : null;
}

export async function saveState(conversationId: string, state: SavedState) {
  const c = await db();
  await c.execute({
    sql: `INSERT INTO conversation_state (conversation_id, state_json, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(conversation_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    args: [conversationId, JSON.stringify(state), now()],
  });
}

export async function saveResultSet(input: {
  conversationId: string;
  entity: string;
  spec: unknown;
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
}): Promise<string> {
  const c = await db();
  const id = randomUUID();
  await c.execute({
    sql: `INSERT INTO result_sets (id, conversation_id, entity, spec_json, sql, columns_json, rows_json, row_count, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      input.conversationId,
      input.entity,
      JSON.stringify(input.spec),
      input.sql,
      JSON.stringify(input.columns),
      JSON.stringify(input.rows),
      input.rows.length,
      now(),
    ],
  });
  return id;
}

export async function getResultSet(id: string) {
  const c = await db();
  const r = await c.execute({ sql: "SELECT * FROM result_sets WHERE id = ?", args: [id] });
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    conversation_id: row.conversation_id as string,
    entity: row.entity as string,
    columns: JSON.parse(row.columns_json as string) as string[],
    rows: JSON.parse(row.rows_json as string) as Record<string, unknown>[],
    created_at: row.created_at as string,
  };
}

export async function saveAgentRun(conversationId: string, messageId: string | null, trace: unknown) {
  const c = await db();
  await c.execute({
    sql: "INSERT INTO agent_runs (id, conversation_id, message_id, trace_json, created_at) VALUES (?, ?, ?, ?, ?)",
    args: [randomUUID(), conversationId, messageId, JSON.stringify(trace), now()],
  });
}
