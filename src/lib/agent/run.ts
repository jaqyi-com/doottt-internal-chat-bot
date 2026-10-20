import { buildGraph, NODE_LABELS } from "./graph";
import { emptySaved, type GState, type Reply, type SavedState } from "./state";
import { addMessage, listMessages, loadState, renameConversation, saveAgentRun, saveState, getConversation } from "../repo";

const RECURSION_LIMIT = Number(process.env.AGENT_RECURSION_LIMIT || 30);
const graph = buildGraph();

export type StepEvent = { type: "step"; node: string; label: string; detail?: string };

function historyText(msgs: { role: string; content: string }[]): string {
  return msgs
    .slice(-8)
    .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, m.role === "assistant" ? 400 : 1500)}`)
    .join("\n");
}

function stepDetail(node: string, update: Partial<GState>): string | undefined {
  if (node === "write_sql" && update.attempt) return `attempt ${update.attempt}`;
  if (node === "execute") return update.sqlError ? `query rejected: ${update.sqlError.slice(0, 120)}` : `${update.fetched ?? 0} rows fetched`;
  if (node === "enrich") return `${update.rows?.length ?? 0} rows after cleaning`;
  if (node === "validate" && update.validation) {
    const v = update.validation;
    return `${v.verdict} (score ${v.score})${v.issues.length ? " — " + v.issues[0].slice(0, 120) : ""}`;
  }
  return undefined;
}

// One user turn: persist the message, run the graph, persist reply + state + trace.
export async function runTurn(conversationId: string, userMessage: string, emit: (e: StepEvent) => void) {
  const prior = await listMessages(conversationId);
  await addMessage(conversationId, "user", userMessage);
  if (prior.length === 0) {
    const conv = await getConversation(conversationId);
    if (conv && conv.title === "New chat") await renameConversation(conversationId, userMessage.replace(/\s+/g, " ").slice(0, 60));
  }

  const saved: SavedState = (await loadState(conversationId)) ?? emptySaved();
  const input: Partial<GState> = { conversationId, userMessage, history: historyText(prior), saved };

  let final: Partial<GState> = { ...input };
  const visited: { node: string; detail?: string; ms?: number }[] = [];
  let reply: Reply;
  try {
    const stream = await graph.stream(input, { streamMode: "updates", recursionLimit: RECURSION_LIMIT });
    let t = Date.now();
    for await (const chunk of stream) {
      for (const [node, update] of Object.entries(chunk as Record<string, Partial<GState>>)) {
        final = { ...final, ...(update ?? {}) };
        const detail = stepDetail(node, update ?? {});
        const ms = Date.now() - t;
        t = Date.now();
        console.log(`[agent] ${node} ${ms}ms ${detail ?? ""}`);
        visited.push({ node, detail, ms });
        emit({ type: "step", node, label: NODE_LABELS[node] ?? node, detail });
      }
    }
    reply = final.reply ?? { text: "Sorry, I couldn't produce an answer. Please rephrase.", stage: saved.stage };
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    console.error("[agent] run failed:", err);
    reply = {
      text: /recursion/i.test(msg)
        ? "I hit the step limit while searching. Please narrow the request a little and try again."
        : `Something went wrong: ${msg.slice(0, 200)}`,
      stage: saved.stage,
    };
  }

  const nextSaved = final.saved ?? saved;
  await saveState(conversationId, { ...nextSaved, stage: reply.stage });
  const { text, ...data } = reply;
  const message = await addMessage(conversationId, "assistant", text, data as Record<string, unknown>);
  await saveAgentRun(conversationId, message.id, {
    visited,
    spec: final.spec ?? null,
    attempts: final.attempts ?? [],
    requestedCount: final.requestedCount ?? null,
  });
  return message;
}
