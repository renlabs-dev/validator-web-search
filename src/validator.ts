import { z } from "zod";
import { eq, and, or, notExists, asc, lte, gte, ne, isNotNull, isNull } from "drizzle-orm";
import { type DB, type Transaction } from "./db/client.js";
import {
  parsedPrediction,
  parsedPredictionDetails,
  scrapedTweet,
  validationResult,
  type ParsedPrediction,
  type ParsedPredictionDetails,
  type ScrapedTweet,
} from "./db/schema.js";
import { searchMultiple } from "./search/searchapi.js";
import { QueryEnhancer } from "./llm/query-enhancer.js";
import { ResultJudge } from "./llm/result-judge.js";
import { truncateText, writeCostLog } from "./utils.js";
import { log } from "./logger.js";

export const ValidationOutcome = z.enum([
  "MaturedTrue",
  "MaturedFalse",
  "MaturedMostlyTrue",
  "MaturedMostlyFalse",
  "NotMatured",
  "MissingContext",
  "Invalid",
]);

export type ValidationOutcomeType = z.infer<typeof ValidationOutcome>;

export const SourceSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  pub_date: z.string().nullable(),
  excerpt: z.string(),
});

export type Source = z.infer<typeof SourceSchema>;

export const ValidationResultSchema = z.object({
  prediction_id: z.string().or(z.number()),
  outcome: ValidationOutcome,
  proof: z.string().max(700),
  sources: z.array(SourceSchema),
});

export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export interface PredictionToValidate {
  parsedPrediction: ParsedPrediction;
  parsedPredictionDetails: ParsedPredictionDetails;
  scrapedTweet: ScrapedTweet;
}

interface PreValidationCheck {
  shouldValidate: boolean;
  reason?: string;
}

export class Validator {
  constructor(_db: DB) {}

  /**
   * Check if a prediction should be validated before doing expensive operations
   * Filters out invalid predictions based on multiple criteria
   *
   * Thresholds are based on database analysis of 70,416 predictions
   * and 14,218 pending validations. This filtering saves ~11% of API costs.
   */
  shouldValidatePrediction(
    prediction: PredictionToValidate,
  ): PreValidationCheck {
    const details = prediction.parsedPredictionDetails;
    const parsed = prediction.parsedPrediction;

    // Check 1: Timeframe sanity - start should not be after end
    // Impact: Filters ~1.62% of validation queue (230 out of 14,218)
    if (details.timeframeStartUtc && details.timeframeEndUtc) {
      if (details.timeframeStartUtc > details.timeframeEndUtc) {
        return {
          shouldValidate: false,
          reason: "Invalid timeframe: start date is after end date",
        };
      }
    }

    // Check 2: Timeframe status - reject "missing" status
    // Impact: Filters ~0.15% of validation queue (21 out of 14,218)
    if (details.timeframeStatus === "missing") {
      return {
        shouldValidate: false,
        reason: 'Timeframe status is "missing" - cannot determine validation timing',
      };
    }

    // Check 3: Filter validation reasoning - check if it indicates this is not a valid prediction
    // Impact: Variable, catches hedging words and non-predictions
    if (details.filterValidationReasoning) {
      const reasoning = details.filterValidationReasoning.toLowerCase();
      const invalidKeywords = [
        "not a prediction",
        "not a valid prediction",
        "no prediction",
        "invalid prediction",
        "not making a prediction",
        "does not contain a prediction",
        "doesn't contain a prediction",
        "no clear prediction",
        "lacks a prediction",
        "missing prediction",
        "not predictive",
        "too vague",
        "overly vague",
        "impossible to validate",
        "cannot be validated",
        "not verifiable",
        "unverifiable",
        "heavy hedging",
        "quoting someone else",
        "is an announcement",
        "factual announcement",
      ];

      for (const keyword of invalidKeywords) {
        if (reasoning.includes(keyword)) {
          return {
            shouldValidate: false,
            reason: `Filter stage marked as invalid: ${details.filterValidationReasoning.slice(0, 200)}`,
          };
        }
      }
    }

    // Check 4: Filter validation confidence - if too low, likely not a real prediction
    // Data: All values are 0.8-1.0 (avg 0.925, median 0.9)
    // Impact: Filters ~0.5% of validation queue
    if (details.filterValidationConfidence !== null) {
      const confidence = Number(details.filterValidationConfidence);
      if (confidence < 0.85) {
        return {
          shouldValidate: false,
          reason: `Filter validation confidence too low: ${confidence.toFixed(2)} (threshold: 0.85)`,
        };
      }
    }

    // Check 5: LLM confidence - if too low, prediction quality is suspect
    // Data: 0.0-1.0 scale (avg 0.755, median 0.7)
    // Impact: Filters ~1.80% of validation queue (256 out of 14,218)
    if (parsed.llmConfidence !== null) {
      const llmConfidence = Number(parsed.llmConfidence);
      if (llmConfidence < 0.5) {
        return {
          shouldValidate: false,
          reason: `LLM confidence too low: ${llmConfidence.toFixed(2)} (threshold: 0.50)`,
        };
      }
    }

    // Check 6: Prediction quality - if too low, not worth validating
    // Data: 0-95 scale (avg 53.85, median 55)
    // Impact: Filters ~0.97% of validation queue (138 out of 14,218)
    // Quality < 30 are clearly invalid (tautologies, jokes, greetings)
    if (parsed.predictionQuality !== null) {
      if (parsed.predictionQuality < 30) {
        return {
          shouldValidate: false,
          reason: `Prediction quality too low: ${parsed.predictionQuality} (threshold: 30)`,
        };
      }
    }

    // Check 7: Vagueness score - if too high, prediction is too vague to validate
    // Data: 0.0-1.0 scale (avg 0.555, median 0.65)
    // Impact: Filters ~7.63% of validation queue (1,084 out of 14,218)
    // Strong correlation: low quality predictions have avg vagueness 0.834-0.863
    if (parsed.vagueness !== null) {
      const vagueness = Number(parsed.vagueness);
      if (vagueness > 0.8) {
        return {
          shouldValidate: false,
          reason: `Prediction too vague: ${vagueness.toFixed(2)} (threshold: 0.80)`,
        };
      }
    }

    // All checks passed
    return { shouldValidate: true };
  }

  /**
   * Get next prediction ready for validation
   * Criteria: timeframe_end_utc is not null, is today or past, no verdict exists,
   * and passes pre-validation quality filters at SQL level
   */
  async getNextPredictionToValidate(
    tx: Transaction,
  ): Promise<PredictionToValidate | null> {
    const now = new Date();

    const predictions = await tx
      .select({
        parsedPrediction: parsedPrediction,
        parsedPredictionDetails: parsedPredictionDetails,
        scrapedTweet: scrapedTweet,
      })
      .from(parsedPrediction)
      .innerJoin(
        parsedPredictionDetails,
        eq(parsedPrediction.id, parsedPredictionDetails.parsedPredictionId),
      )
      .innerJoin(
        scrapedTweet,
        eq(parsedPrediction.predictionId, scrapedTweet.predictionId),
      )
      .where(
        and(
          // Timeframe end must exist and be in the past or today
          isNotNull(parsedPredictionDetails.timeframeEndUtc),
          lte(parsedPredictionDetails.timeframeEndUtc, now),
          // No validation result exists yet
          notExists(
            tx
              .select()
              .from(validationResult)
              .where(
                eq(validationResult.parsedPredictionId, parsedPrediction.id),
              ),
          ),
          // SQL-level pre-validation filters (eliminates ~11% of invalid predictions)
          // Filter 1: Timeframe sanity - start must not be after end
          or(
            isNull(parsedPredictionDetails.timeframeStartUtc),
            isNull(parsedPredictionDetails.timeframeEndUtc),
            lte(
              parsedPredictionDetails.timeframeStartUtc,
              parsedPredictionDetails.timeframeEndUtc,
            ),
          ),
          // Filter 2: Timeframe status must not be "missing"
          ne(parsedPredictionDetails.timeframeStatus, "missing"),
          // Filter 3: Filter validation confidence >= 0.85
          or(
            isNull(parsedPredictionDetails.filterValidationConfidence),
            gte(parsedPredictionDetails.filterValidationConfidence, "0.85"),
          ),
          // Filter 4: Prediction quality >= 30
          or(
            isNull(parsedPrediction.predictionQuality),
            gte(parsedPrediction.predictionQuality, 30),
          ),
          // Filter 5: LLM confidence >= 0.5
          or(
            isNull(parsedPrediction.llmConfidence),
            gte(parsedPrediction.llmConfidence, "0.5"),
          ),
          // Filter 6: Vagueness <= 0.8
          or(
            isNull(parsedPrediction.vagueness),
            lte(parsedPrediction.vagueness, "0.8"),
          ),
        ),
      )
      .orderBy(asc(parsedPredictionDetails.timeframeEndUtc))
      .limit(1)
      .for("update", { skipLocked: true });

    if (predictions.length === 0) {
      return null;
    }

    return predictions[0] ?? null;
  }

  /**
   * Fetch a specific tweet by ID from the database
   */
  async getThreadTweet(
    tx: Transaction,
    tweetId: string,
  ): Promise<string | null> {
    const tweets = await tx
      .select({ text: scrapedTweet.text })
      .from(scrapedTweet)
      .where(eq(scrapedTweet.id, BigInt(tweetId)))
      .limit(1);

    return tweets[0]?.text ?? null;
  }

  /**
   * Extract goal text from prediction for search query
   * Handles cross-tweet references in threads
   */
  async extractGoalText(
    tx: Transaction,
    prediction: PredictionToValidate,
  ): Promise<string> {
    interface GoalSlice {
      start: number;
      end: number;
      source?: { tweet_id: string };
    }

    const goalSlices = prediction.parsedPrediction.goal as GoalSlice[];

    if (!goalSlices || goalSlices.length === 0) {
      return "";
    }

    const currentTweetId = prediction.scrapedTweet.id.toString();
    const currentTweetText = prediction.scrapedTweet.text;

    // Check if any goal slice references a different tweet
    const crossTweetSlices = goalSlices.filter(
      (slice) =>
        slice.source?.tweet_id && slice.source.tweet_id !== currentTweetId,
    );

    if (crossTweetSlices.length > 0) {
      // Need to fetch other tweets in the thread
      const tweetTexts = new Map<string, string>();
      tweetTexts.set(currentTweetId, currentTweetText);

      // Fetch all referenced tweets
      for (const slice of crossTweetSlices) {
        if (slice.source?.tweet_id && !tweetTexts.has(slice.source.tweet_id)) {
          const text = await this.getThreadTweet(tx, slice.source.tweet_id);
          if (text) {
            tweetTexts.set(slice.source.tweet_id, text);
          }
        }
      }

      // Extract text from correct tweets
      const goalTexts = goalSlices
        .map((slice) => {
          const tweetId = slice.source?.tweet_id || currentTweetId;
          const text = tweetTexts.get(tweetId);
          if (!text) return "";

          const extracted = text.slice(slice.start, slice.end);
          return extracted;
        })
        .filter((text) => text.length > 0);

      return goalTexts.join(" ");
    }

    // All slices reference current tweet
    const goalTexts = goalSlices
      .map((slice) => currentTweetText.slice(slice.start, slice.end))
      .filter((text) => text.length > 0);

    return goalTexts.join(" ");
  }

  /**
   * Store validation result in database
   */
  async storeValidationResult(
    tx: Transaction,
    result: ValidationResult,
  ): Promise<void> {
    await tx.insert(validationResult).values({
      parsedPredictionId: result.prediction_id.toString(),
      outcome: result.outcome,
      proof: result.proof,
      sources: result.sources,
    });
  }

  /**
   * Validate a single prediction using parallel multi-agent approach
   */
  async validatePrediction(
    tx: Transaction,
    prediction: PredictionToValidate,
  ): Promise<ValidationResult> {
    // Pre-validation check: Filter out invalid predictions before expensive operations
    const preCheck = this.shouldValidatePrediction(prediction);

    if (!preCheck.shouldValidate) {
      log(`[Validation] Skipping invalid prediction: ${preCheck.reason}`);
      return {
        prediction_id: prediction.parsedPrediction.id,
        outcome: "Invalid",
        proof: preCheck.reason || "Prediction failed pre-validation checks",
        sources: [],
      };
    }

    // Use prediction_context (thread summary) instead of extracting goal from slices
    const predictionText =
      prediction.parsedPredictionDetails.predictionContext ||
      (await this.extractGoalText(tx, prediction));

    if (!predictionText) {
      return {
        prediction_id: prediction.parsedPrediction.id,
        outcome: "Invalid",
        proof: "Unable to extract prediction text",
        sources: [],
      };
    }

    const queryEnhancer = new QueryEnhancer();
    const resultJudge = new ResultJudge();

    const NUM_QUERIES = 3;
    const RESULTS_PER_QUERY = 10;

    log(
      `[Validation] Starting parallel validation for prediction ${prediction.parsedPrediction.id}`,
    );
    log(`[Validation]   Prediction: "${predictionText.slice(0, 150)}..."`);

    // Step 1: Generate 3 diverse queries in parallel
    log(
      `[Validation] Step 1: Generating ${NUM_QUERIES} diverse queries in parallel...`,
    );
    const queryResult = await queryEnhancer.enhanceMultiple(
      predictionText,
      NUM_QUERIES,
    );

    queryResult.queries.forEach((query, index) => {
      log(`[Validation]   Query ${index + 1}: "${query}"`);
    });

    // Step 2: Search all queries in parallel
    log(
      `[Validation] Step 2: Searching all ${NUM_QUERIES} queries in parallel...`,
    );
    const searchPromises = queryResult.queries.map((query) =>
      searchMultiple(query, RESULTS_PER_QUERY),
    );
    const allResultSets = await Promise.all(searchPromises);
    const searchApiCalls = NUM_QUERIES; // Track number of search API calls

    // Combine all results
    const combinedResults = allResultSets.flat();
    log(
      `[Validation]   Total results found: ${combinedResults.length}`,
    );

    if (combinedResults.length === 0) {
      return {
        prediction_id: prediction.parsedPrediction.id,
        outcome: "MissingContext",
        proof: "No search results found across all query variations",
        sources: [],
      };
    }

    // Step 3: Single judgment on all combined results
    log(
      `[Validation] Step 3: Evaluating all ${combinedResults.length} results...`,
    );
    const judgment = await resultJudge.evaluate(
      predictionText,
      combinedResults,
    );
    log(
      `[Validation]   Judgment: ${judgment.decision} (score: ${judgment.score})`,
    );
    log(`[Validation]   Summary: ${judgment.summary}`);

    // Step 4: Map score to outcome (including Mostly variants)
    let outcome: ValidationResult["outcome"];

    if (judgment.decision === "TRUE") {
      outcome = judgment.score >= 9 ? "MaturedTrue" : "MaturedMostlyTrue";
    } else if (judgment.decision === "FALSE") {
      outcome = judgment.score <= 2 ? "MaturedFalse" : "MaturedMostlyFalse";
    } else {
      // INCONCLUSIVE
      outcome = "MissingContext";
    }

    // Step 5: Format proof as structured markdown
    let proof = judgment.summary;

    if (judgment.evidence) {
      proof += `\n\n${judgment.evidence}`;
    }

    if (judgment.reasoning) {
      proof += `\n\nReasoning: ${judgment.reasoning}`;
    }

    // Ensure proof fits in 700 characters
    proof = truncateText(proof, 700);

    // Step 6: Track and log costs
    const totalInputTokens =
      queryResult.totalInputTokens + judgment.inputTokens;
    const totalOutputTokens =
      queryResult.totalOutputTokens + judgment.outputTokens;

    log(`[Validation] Costs:`);
    log(`[Validation]   Search API calls: ${searchApiCalls}`);
    log(`[Validation]   Query enhancer tokens: ${queryResult.totalInputTokens} in, ${queryResult.totalOutputTokens} out`);
    log(`[Validation]   Result judge tokens: ${judgment.inputTokens} in, ${judgment.outputTokens} out`);
    log(`[Validation]   Total LLM tokens: ${totalInputTokens} in, ${totalOutputTokens} out`);

    // Write cost data to costs.json
    await writeCostLog({
      prediction_id: prediction.parsedPrediction.id,
      prediction_context: predictionText,
      searchApiCalls,
      queryEnhancerInputTokens: queryResult.totalInputTokens,
      queryEnhancerOutputTokens: queryResult.totalOutputTokens,
      resultJudgeInputTokens: judgment.inputTokens,
      resultJudgeOutputTokens: judgment.outputTokens,
      totalInputTokens,
      totalOutputTokens,
      outcome,
      timestamp: new Date().toISOString(),
    });

    // Step 7: Return result
    const sources =
      judgment.decision !== "INCONCLUSIVE"
        ? combinedResults.slice(0, 2) // Top 2 sources for conclusive results
        : []; // No sources for inconclusive results

    return {
      prediction_id: prediction.parsedPrediction.id,
      outcome,
      proof,
      sources,
    };
  }
}
