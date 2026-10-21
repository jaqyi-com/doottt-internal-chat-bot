import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { z } from "zod";

// Gemini has an OpenAI-compatible endpoint, so LangChain's ChatOpenAI works with a different baseURL.

export const MODELS = {
  fast: process.env.LLM_MODEL_FAST || "gemini-flash-lite-latest",
  smart: process.env.LLM_MODEL_SMART || "gemini-3.5-flash",
};

// Tried in order when a model is overloaded (503) or out of quota (429).
const FALLBACKS = (process.env.LLM_MODEL_FALLBACKS || "gemini-3.5-flash-lite,gemini-flash-lite-latest")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isCapacityError(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return e?.status === 503 || e?.status === 429 || /\b(503|429)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|quota/i.test(String(e?.message ?? err));
}

// Invoke the first model that has capacity.
async function invokeWithFallback(primary: string, messages: (SystemMessage | HumanMessage)[]) {
  const chain = [primary, ...FALLBACKS.filter((m) => m !== primary)];
  let lastErr: unknown;
  for (const name of chain) {
    try {
      const t0 = Date.now();
      const res = await model(name).invoke(messages);
      console.log(`[llm] ${name} ${Date.now() - t0}ms`);
      return res;
    } catch (err) {
      if (!isCapacityError(err)) throw err;
      console.warn(`[llm] ${name} unavailable, trying next model`);
      lastErr = err;
    }
  }
  throw new Error(`All models are busy or out of quota right now — please try again in a minute. (${String((lastErr as Error)?.message ?? lastErr).slice(0, 160)})`);
}

const cache = new Map<string, ChatOpenAI>();

function model(name: string): ChatOpenAI {
  let m = cache.get(name);
  if (!m) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    m = new ChatOpenAI({
      model: name,
      apiKey,
      temperature: 0,
      maxTokens: Number(process.env.LLM_MAX_TOKENS || 4000),
      timeout: 60_000,
      // Capacity errors fall through to the next model (invokeWithFallback) instead of long retries.
      maxRetries: 1,
      configuration: {
        baseURL: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai/",
      },
    });
    cache.set(name, m);
  }
  return m;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(body.slice(start, end + 1));
}

// Ask for a JSON object and validate it with zod. Provider-agnostic (no tool-calling needed);
// on a bad answer we retry once with the parse error.
export async function llmJson<T>(
  schema: z.ZodType<T>,
  system: string,
  user: string,
  which: keyof typeof MODELS = "fast",
): Promise<T> {
  const messages = [
    new SystemMessage(system + "\n\nReply with ONE JSON object only. No prose outside the JSON."),
    new HumanMessage(user),
  ];
  let lastErr: unknown;
  for (let i = 0; i < 2; i++) {
    const res = await invokeWithFallback(MODELS[which], messages);
    const text = typeof res.content === "string" ? res.content : res.content.map((p) => ("text" in p ? p.text : "")).join("");
    try {
      return schema.parse(extractJson(text));
    } catch (err) {
      lastErr = err;
      messages.push(new HumanMessage(`Your reply was not valid: ${String(err).slice(0, 500)}. Reply again with the JSON object only.`));
    }
  }
  throw new Error(`LLM JSON failed: ${String(lastErr)}`);
}
