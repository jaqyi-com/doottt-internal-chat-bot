import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { z } from "zod";

// OpenRouter speaks the OpenAI API, so LangChain's ChatOpenAI works with a different baseURL.

export const MODELS = {
  fast: process.env.LLM_MODEL_FAST || "anthropic/claude-haiku-5.5",
  smart: process.env.LLM_MODEL_SMART || "anthropic/claude-sonnet-5.5",
};

const cache = new Map<string, ChatOpenAI>();

function model(name: string): ChatOpenAI {
  let m = cache.get(name);
  if (!m) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
    m = new ChatOpenAI({
      model: name,
      apiKey,
      temperature: 0,
      maxTokens: Number(process.env.LLM_MAX_TOKENS || 4000),
      timeout: 60_000,
      maxRetries: 1,
      configuration: {
        baseURL: "https://openrouter.ai/api/v1",
        defaultHeaders: { "X-Title": "Doott Data Bot" },
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
  const llm = model(MODELS[which]);
  const messages = [
    new SystemMessage(system + "\n\nReply with ONE JSON object only. No prose outside the JSON."),
    new HumanMessage(user),
  ];
  let lastErr: unknown;
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    const res = await llm.invoke(messages);
    console.log(`[llm] ${MODELS[which]} ${Date.now() - t0}ms`);
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
