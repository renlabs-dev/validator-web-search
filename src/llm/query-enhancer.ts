import { createChat } from "./openrouter.js";
import { QUERY_ENHANCER_SYSTEM_PROMPT } from "./prompts.js";

export interface PastAttempt {
  query: string;
  success: boolean;
  reasoning?: string;
}

export interface PredictionContext {
  goalText: string;
  fullTweet: string;
  predictionContext: string | null;
  briefRationale: string | null;
  timeframeEnd: Date | null;
}

/**
 * Query Enhancer Agent - Uses Querier to generate optimized search queries
 */
export class QueryEnhancer {
  private chat = createChat("querier");

  /**
   * Generate an enhanced search query from a prediction goal
   * @param goalText - The prediction goal text
   * @param pastAttempts - Previous search attempts (for learning)
   * @returns Enhanced search query
   */
  async enhance(
    goalText: string,
    pastAttempts: PastAttempt[] = [],
  ): Promise<string> {
    let userPrompt = `Prediction claim: "${goalText}"\n\nGenerate an optimized search query to verify this claim.`;

    // Add context from past attempts if any
    if (pastAttempts.length > 0) {
      userPrompt += `\n\nPrevious attempts that didn't yield clear results:`;
      pastAttempts.forEach((attempt, index) => {
        userPrompt += `\n${index + 1}. Query: "${attempt.query}"`;
        if (attempt.reasoning) {
          userPrompt += ` - ${attempt.reasoning}`;
        }
      });
      userPrompt += `\n\nGenerate a DIFFERENT query that approaches the claim from a new angle.`;
    }

    const response = await this.chat(userPrompt, {
      system: QUERY_ENHANCER_SYSTEM_PROMPT,
      temperature: 0.7,
      maxTokens: 200,
    });

    // Clean up the response (remove quotes, trim, etc.)
    const query = response.content
      .trim()
      .replace(/^["']|["']$/g, "") // Remove leading/trailing quotes
      .replace(/\n.*/g, ""); // Take only first line if multi-line

    return query;
  }

  /**
   * Generate multiple diverse search queries in parallel
   * Each query approaches the claim from a different angle
   * @param context - Full prediction context including tweet, rationale, and thread summary
   * @param count - Number of queries to generate (default: 3)
   * @returns Array of enhanced queries
   */
  async enhanceMultiple(
    context: PredictionContext,
    count: number = 3,
  ): Promise<string[]> {
    const queryAngles = [
      "Generate a direct, factual search query focusing on the main claim",
      "Generate a query that would find news articles or reports about this claim",
      "Generate a query using alternative keywords or synonyms for the same claim",
    ];

    // Generate all queries in parallel
    const queryPromises = queryAngles.slice(0, count).map((angle, index) => {
      // Create separate chat instance for each query to avoid interference
      const chat = createChat("querier");

      // Build rich context prompt
      let userPrompt = `Prediction Goal: "${context.goalText}"

Full Tweet: "${context.fullTweet}"`;

      if (context.briefRationale) {
        userPrompt += `\n\nRationale: ${context.briefRationale}`;
      }

      if (context.predictionContext) {
        userPrompt += `\n\nThread Context: ${context.predictionContext.slice(0, 500)}`;
      }

      if (context.timeframeEnd) {
        userPrompt += `\n\nTimeframe ends: ${context.timeframeEnd.toISOString().split("T")[0]}`;
      }

      userPrompt += `\n\n${angle}.

Return ONLY the search query, nothing else.`;

      return chat(userPrompt, {
        system: QUERY_ENHANCER_SYSTEM_PROMPT,
        temperature: 0.7 + index * 0.1, // Vary temperature for diversity
        maxTokens: 200,
      });
    });

    const responses = await Promise.all(queryPromises);

    // Clean and return queries
    return responses.map((response) =>
      response.content
        .trim()
        .replace(/^["']|["']$/g, "")
        .replace(/\n.*/g, ""),
    );
  }
}
