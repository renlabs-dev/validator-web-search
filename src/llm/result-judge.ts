import { createChat } from "./openrouter.js";
import { RESULT_JUDGE_SYSTEM_PROMPT } from "./prompts.js";
import type { SearchResult } from "../search/searchapi.js";

export type JudgmentDecision = "TRUE" | "FALSE" | "INCONCLUSIVE";

export interface Judgment {
  decision: JudgmentDecision;
  score: number;
  summary: string;
  evidence: string;
  reasoning: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Extract XML content from LLM response
 */
function extractXML(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "i");
  const match = xml.match(regex);
  return match
    ? match[0].replace(new RegExp(`</?${tag}>`, "gi"), "").trim()
    : "";
}

/**
 * Result Judge Agent - Uses Validator to evaluate search results
 */
export class ResultJudge {
  private chat = createChat("validator");

  /**
   * Evaluate search results against a prediction claim
   * @param goalText - The prediction claim
   * @param searchResults - Array of search results to evaluate
   * @returns Judgment with decision, score, and reasoning
   */
  async evaluate(
    goalText: string,
    searchResults: SearchResult[],
  ): Promise<Judgment> {
    if (searchResults.length === 0) {
      return {
        decision: "INCONCLUSIVE",
        score: 0,
        summary: "No search results to evaluate",
        evidence: "",
        reasoning: "",
        inputTokens: 0,
        outputTokens: 0,
      };
    }

    // Format search results for the prompt
    const resultsText = searchResults
      .map(
        (result, index) => `
Result ${index + 1}:
Title: ${result.title}
URL: ${result.url}
Excerpt: ${result.excerpt}
Published: ${result.pub_date || "Unknown"}
`,
      )
      .join("\n---\n");

    const userPrompt = `Prediction Claim: "${goalText}"

Search Results:
${resultsText}

Evaluate these results and determine if they confirm or refute the prediction.`;

    const response = await this.chat(userPrompt, {
      system: RESULT_JUDGE_SYSTEM_PROMPT,
      temperature: 0.3, // Lower temperature for more consistent judgments
      maxTokens: 1024,
    });

    // Parse XML response
    const scoreStr = extractXML(response.content, "score");
    const decision = extractXML(
      response.content,
      "decision",
    ) as JudgmentDecision;
    const summary = extractXML(response.content, "summary");
    const evidence = extractXML(response.content, "evidence");
    const reasoning = extractXML(response.content, "reasoning");

    const score = parseInt(scoreStr) || 5;

    // Validate decision matches score
    let finalDecision = decision;
    if (score >= 7 && decision !== "TRUE") finalDecision = "TRUE";
    if (score <= 3 && decision !== "FALSE") finalDecision = "FALSE";
    if (score > 3 && score < 7 && decision !== "INCONCLUSIVE")
      finalDecision = "INCONCLUSIVE";

    return {
      decision: finalDecision,
      score,
      summary,
      evidence,
      reasoning,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    };
  }
}
