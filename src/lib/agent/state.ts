import { Annotation } from "@langchain/langgraph";
import { z } from "zod";
import type { GccInfo } from "../data/gcc";

// ---- Filter spec: what the user asked for, in structured form ----
export const SpecSchema = z.object({
  entity: z.enum(["people", "companies"]),
  summary: z.string().default("Data request"),
  job_functions: z.array(z.string()).default([]),
  seniority: z.array(z.string()).default([]),
  industries: z.array(z.string()).default([]),
  company_type: z.string().nullable().default(null),
  company_size: z.array(z.string()).default([]),
  cities: z.array(z.string()).default([]),
  states: z.array(z.string()).default([]),
  country: z.string().nullable().default("India"),
  must_have: z.array(z.enum(["mobile", "phone", "email", "verified_email", "linkedin"])).default([]),
  priority_notes: z.string().default(""),
  count_requested: z.union([z.number().int().positive(), z.literal("all")]).nullable().default(null),
});
export type Spec = z.infer<typeof SpecSchema>;

export type Stage = "idle" | "awaiting_clarification" | "awaiting_count" | "done";

export type Validation = {
  verdict: "pass" | "retry" | "ask_human";
  score: number;
  issues: string[];
  fix_instructions: string;
  question: string | null;
};

export type Attempt = {
  attempt: number;
  sql: string;
  error?: string;
  fetched?: number;
  kept?: number;
  validation?: Validation;
};

// ---- What survives between HTTP requests (stored in SQLite conversation_state) ----
export type SavedState = {
  stage: Stage;
  spec: Spec | null;
  sql: string | null;
  total: number | null;
  totalIsLowerBound: boolean;
  gccCache: Record<string, GccInfo>;
  lastQuestion: string | null;
};

export const emptySaved = (): SavedState => ({
  stage: "idle",
  spec: null,
  sql: null,
  total: null,
  totalIsLowerBound: false,
  gccCache: {},
  lastQuestion: null,
});

export type Row = Record<string, unknown>;

export type Reply = {
  text: string;
  stage: Stage;
  table?: { columns: string[]; rows: Row[] };
  total?: number | null;
  totalIsLowerBound?: boolean;
  resultId?: string;
  options?: string[];
};

const last = <T>(init: () => T) => Annotation<T>({ reducer: (_a, b) => b, default: init });

// ---- LangGraph state for one turn ----
export const GraphState = Annotation.Root({
  conversationId: last<string>(() => ""),
  userMessage: last<string>(() => ""),
  history: last<string>(() => ""),
  saved: last<SavedState>(emptySaved),

  intent: last<"new_request" | "refine" | "clarification_answer" | "count_answer" | "chitchat">(() => "new_request"),
  chitchatReply: last<string | null>(() => null),
  spec: last<Spec | null>(() => null),
  missing: last<string[]>(() => []),
  clarifyQuestion: last<string | null>(() => null),
  requestedCount: last<number | "all" | null>(() => null),

  attempt: last<number>(() => 0),
  feedback: last<string[]>(() => []),
  sql: last<string | null>(() => null),
  sqlError: last<string | null>(() => null),
  rows: last<Row[]>(() => []),
  fetched: last<number>(() => 0),
  hitCap: last<boolean>(() => false),
  rawTotal: last<number | null>(() => null),
  validation: last<Validation | null>(() => null),
  best: last<{ sql: string; rows: Row[]; fetched: number; hitCap: boolean; rawTotal: number | null; score: number; validation: Validation } | null>(() => null),
  attempts: last<Attempt[]>(() => []),

  reply: last<Reply | null>(() => null),
});

export type GState = typeof GraphState.State;
