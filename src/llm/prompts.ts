import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PromptSchema = z.object({ system: z.string() });

/**
 * Load prompt text from JSON file in prompts/ directory at repo root
 */
async function loadPromptFromJson(basename: string): Promise<string> {
  const p = join(__dirname, "..", "..", "prompts", `${basename}.json`);
  const raw = await readFile(p, "utf-8");
  const parsed = PromptSchema.parse(JSON.parse(raw));
  return parsed.system;
}

/**
 * System prompt for the Query Enhancer agent (Querier)
 * Loaded from QUERY_ENHANCER_PROMPT.md
 */
export const QUERY_ENHANCER_SYSTEM_PROMPT = await loadPromptFromJson(
  "query-enhancer", // TODO: refactor prompt
);

/**
 * System prompt for the Result Judge agent (Validator)
 * Loaded from RESULT_JUDGE_PROMPT.md
 */
export const RESULT_JUDGE_SYSTEM_PROMPT = await loadPromptFromJson(
  "result-judge", // TODO: refactor this, prompt seems wrong
);
