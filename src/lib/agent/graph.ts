import { StateGraph, START, END } from "@langchain/langgraph";
import { GraphState, type GState } from "./state";
import {
  MAX_ATTEMPTS,
  route,
  understand,
  clarify,
  chitchat,
  writeSql,
  execute,
  enrich,
  validate,
  presentSample,
  giveUp,
  deliver,
} from "./nodes";

/*
  START → route ─┬─ count answer ───────────────────────────────────────────► deliver → END
                 ├─ "how many?" nudge ─────────────────────────────────────► chitchat → END
                 └─► understand ─┬─ chitchat ───────────────────────────────► chitchat → END
                                 ├─ missing info ───────────────────────────► clarify (ask human) → END
                                 └─► write_sql → execute ─┬─ SQL error, tries left ─► write_sql
                                                          ├─ SQL error, no tries ───► give_up (ask human) → END
                                                          └─► enrich → validate ─┬─ pass ───────────────► present_sample → END
                                                                                 ├─ retry, tries left ──► write_sql (with feedback)
                                                                                 └─ out of tries ───────► present_sample (best) | give_up
  Loop limit: AGENT_MAX_ATTEMPTS SQL attempts per request + LangGraph recursionLimit as a hard stop.
*/

const afterRoute = (s: GState) => (s.intent === "count_answer" ? "deliver" : s.intent === "chitchat" ? "chitchat" : "understand");

const afterUnderstand = (s: GState) => {
  if (s.intent === "chitchat") return "chitchat";
  if (s.missing.length) return "clarify";
  return "write_sql";
};

const afterExecute = (s: GState) => {
  if (!s.sqlError) return "enrich";
  if (s.attempt < MAX_ATTEMPTS) return "write_sql";
  return s.best ? "present_sample" : "give_up";
};

const afterValidate = (s: GState) => {
  if (s.validation?.verdict === "pass") return "present_sample";
  if (s.validation?.verdict === "retry" && s.attempt < MAX_ATTEMPTS) return "write_sql";
  return s.best ? "present_sample" : "give_up";
};

export function buildGraph() {
  return new StateGraph(GraphState)
    .addNode("route", route)
    .addNode("understand", understand)
    .addNode("clarify", clarify)
    .addNode("chitchat", chitchat)
    .addNode("write_sql", writeSql)
    .addNode("execute", execute)
    .addNode("enrich", enrich)
    .addNode("validate", validate)
    .addNode("present_sample", presentSample)
    .addNode("give_up", giveUp)
    .addNode("deliver", deliver)
    .addEdge(START, "route")
    .addConditionalEdges("route", afterRoute, ["deliver", "chitchat", "understand"])
    .addConditionalEdges("understand", afterUnderstand, ["chitchat", "clarify", "write_sql"])
    .addEdge("write_sql", "execute")
    .addConditionalEdges("execute", afterExecute, ["enrich", "write_sql", "present_sample", "give_up"])
    .addEdge("enrich", "validate")
    .addConditionalEdges("validate", afterValidate, ["present_sample", "write_sql", "give_up"])
    .addEdge("present_sample", END)
    .addEdge("give_up", END)
    .addEdge("clarify", END)
    .addEdge("chitchat", END)
    .addEdge("deliver", END)
    .compile();
}

export const NODE_LABELS: Record<string, string> = {
  route: "Reading your message",
  understand: "Understanding the request",
  clarify: "Need one detail",
  chitchat: "Replying",
  write_sql: "Writing the database query",
  execute: "Searching the database",
  enrich: "Cleaning & checking numbers / emails / GCC",
  validate: "Checking the data matches your request",
  present_sample: "Preparing a sample",
  give_up: "Asking you how to adjust",
  deliver: "Preparing your records",
};
