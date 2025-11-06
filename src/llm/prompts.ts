import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load prompt from markdown file
 * Prompts are located at project root, so we go up from src/llm/ to root
 */
async function loadPrompt(filename: string): Promise<string> {
  // From src/llm/ up to root: ../..
  return await readFile(join(__dirname, "..", "..", filename), "utf-8");
}

/**
 * System prompt for the Query Enhancer agent (Querier)
 * Loaded from QUERY_ENHANCER_PROMPT.md
 */
export const QUERY_ENHANCER_SYSTEM_PROMPT = await loadPrompt(
  "QUERY_ENHANCER_PROMPT.md",
);

/**
 * System prompt for the Result Judge agent (Validator)
 * Loaded from RESULT_JUDGE_PROMPT.md
 */
export const RESULT_JUDGE_SYSTEM_PROMPT = await loadPrompt(
  "RESULT_JUDGE_PROMPT.md",
);
