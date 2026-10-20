import fs from "node:fs";
import path from "node:path";

let cached: string | null = null;

// The DB knowledge prompt (schema, indexes, spelling lists, SQL rules, GCC list).
export function systemPrompt(): string {
  if (cached === null) {
    cached = fs.readFileSync(path.join(process.cwd(), "prompts", "system_prompt.md"), "utf8");
  }
  return cached;
}
