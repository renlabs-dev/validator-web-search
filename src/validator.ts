import { z } from "zod";
import { eq, and, or, asc, lte, gte, ne, isNotNull, isNull } from "drizzle-orm";
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
import { QueryEnhancer, type PastAttempt } from "./llm/query-enhancer.js";
import { ResultJudge } from "./llm/result-judge.js";
import { truncateText, writeCostLog } from "./utils.js";
import { logWithContext, logErrorWithContext } from "./logger.js";

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

const VALIDATION_CONFIG = {
  search: {
    INITIAL_QUERIES: 2,
    RESULTS_PER_QUERY: 10,
    MAX_TOTAL_RESULTS: 30,
    MAX_REFINEMENT_ITERATIONS: 1,
  },
  quality: {
    FILTER_VALIDATION_CONFIDENCE_MIN: 0.85,
    PREDICTION_QUALITY_MIN: 30,
    LLM_CONFIDENCE_MIN: 0.5,
    VAGUENESS_MAX: 0.8,
  },
  scoring: {
    TRUE_DEFINITIVE_MIN: 9,
    FALSE_DEFINITIVE_MAX: 2,
  },
} as const;

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
      if (confidence < VALIDATION_CONFIG.quality.FILTER_VALIDATION_CONFIDENCE_MIN) {
        return {
          shouldValidate: false,
          reason: `Filter validation confidence too low: ${confidence.toFixed(2)} (threshold: ${VALIDATION_CONFIG.quality.FILTER_VALIDATION_CONFIDENCE_MIN})`,
        };
      }
    }

    // Check 5: LLM confidence - if too low, prediction quality is suspect
    // Data: 0.0-1.0 scale (avg 0.755, median 0.7)
    // Impact: Filters ~1.80% of validation queue (256 out of 14,218)
    if (parsed.llmConfidence !== null) {
      const llmConfidence = Number(parsed.llmConfidence);
      if (llmConfidence < VALIDATION_CONFIG.quality.LLM_CONFIDENCE_MIN) {
        return {
          shouldValidate: false,
          reason: `LLM confidence too low: ${llmConfidence.toFixed(2)} (threshold: ${VALIDATION_CONFIG.quality.LLM_CONFIDENCE_MIN})`,
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
      if (vagueness > VALIDATION_CONFIG.quality.VAGUENESS_MAX) {
        return {
          shouldValidate: false,
          reason: `Prediction too vague: ${vagueness.toFixed(2)} (threshold: ${VALIDATION_CONFIG.quality.VAGUENESS_MAX})`,
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
      .leftJoin(
        validationResult,
        eq(validationResult.parsedPredictionId, parsedPrediction.id),
      )
      .where(
        and(
          // Timeframe end must exist and be in the past or today
          isNotNull(parsedPredictionDetails.timeframeEndUtc),
          lte(parsedPredictionDetails.timeframeEndUtc, now),
          // No validation result exists yet (LEFT JOIN with NULL check)
          isNull(validationResult.parsedPredictionId),
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
          // Filter 3: Filter validation confidence threshold
          or(
            isNull(parsedPredictionDetails.filterValidationConfidence),
            gte(
              parsedPredictionDetails.filterValidationConfidence,
              String(VALIDATION_CONFIG.quality.FILTER_VALIDATION_CONFIDENCE_MIN),
            ),
          ),
          // Filter 4: Prediction quality threshold
          or(
            isNull(parsedPrediction.predictionQuality),
            gte(
              parsedPrediction.predictionQuality,
              VALIDATION_CONFIG.quality.PREDICTION_QUALITY_MIN,
            ),
          ),
          // Filter 5: LLM confidence threshold
          or(
            isNull(parsedPrediction.llmConfidence),
            gte(
              parsedPrediction.llmConfidence,
              String(VALIDATION_CONFIG.quality.LLM_CONFIDENCE_MIN),
            ),
          ),
          // Filter 6: Vagueness threshold
          or(
            isNull(parsedPrediction.vagueness),
            lte(
              parsedPrediction.vagueness,
              String(VALIDATION_CONFIG.quality.VAGUENESS_MAX),
            ),
          ),
        ),
      )
      .orderBy(asc(parsedPredictionDetails.timeframeEndUtc))
      .limit(1)
      .for("update", {
        of: [parsedPrediction, parsedPredictionDetails, scrapedTweet],
        skipLocked: true,
      });

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

  async storeValidationResult(
    tx: Transaction,
    result: ValidationResult,
  ): Promise<void> {
    try {
      const proof = result.proof.substring(0, 700);
      const sources = result.sources.slice(0, 5);

      await tx
        .insert(validationResult)
        .values({
          parsedPredictionId: result.prediction_id.toString(),
          outcome: result.outcome,
          proof,
          sources,
        })
        .onConflictDoNothing();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logErrorWithContext(
        result.prediction_id.toString(),
        `Failed to store result: ${errorMessage}`,
      );
      logErrorWithContext(
        result.prediction_id.toString(),
        `Outcome: ${result.outcome}, Proof length: ${result.proof.length}, Sources count: ${result.sources.length}`,
      );
      if (error instanceof Error && error.stack) {
        logErrorWithContext(
          result.prediction_id.toString(),
          `Stack: ${error.stack}`,
        );
      }
      throw error;
    }
  }

  /**
   * Validate a single prediction using parallel multi-agent approach
   */
  async validatePrediction(
    tx: Transaction,
    prediction: PredictionToValidate,
  ): Promise<ValidationResult> {
    const predictionId = prediction.parsedPrediction.id;

    const preCheck = this.shouldValidatePrediction(prediction);

    if (!preCheck.shouldValidate) {
      logWithContext(predictionId, `Skipping: ${preCheck.reason}`);
      return {
        prediction_id: predictionId,
        outcome: "Invalid",
        proof: preCheck.reason || "Prediction failed pre-validation checks",
        sources: [],
      };
    }

    const predictionText =
      prediction.parsedPredictionDetails.predictionContext ||
      (await this.extractGoalText(tx, prediction));

    if (!predictionText) {
      return {
        prediction_id: predictionId,
        outcome: "Invalid",
        proof: "Unable to extract prediction text",
        sources: [],
      };
    }

    const queryEnhancer = new QueryEnhancer();
    const resultJudge = new ResultJudge();

    logWithContext(predictionId, "Starting hybrid validation");
    logWithContext(
      predictionId,
      `Prediction: "${predictionText.slice(0, 150)}..."`,
    );

    try {
      logWithContext(
        predictionId,
        `Step 1: Generating ${VALIDATION_CONFIG.search.INITIAL_QUERIES} queries...`,
      );
      const initialQueryResult = await queryEnhancer.enhanceMultiple(
        predictionText,
        VALIDATION_CONFIG.search.INITIAL_QUERIES,
      );

      initialQueryResult.queries.forEach((query, index) => {
        logWithContext(predictionId, `Query ${index + 1}: "${query}"`);
      });

      logWithContext(
        predictionId,
        `Step 2: Searching ${VALIDATION_CONFIG.search.INITIAL_QUERIES} queries...`,
      );
      const searchPromises = initialQueryResult.queries.map((query) =>
        searchMultiple(query, VALIDATION_CONFIG.search.RESULTS_PER_QUERY),
      );
      const initialResultSets = await Promise.all(searchPromises);

      let totalQueryEnhancerInputTokens = initialQueryResult.totalInputTokens;
      let totalQueryEnhancerOutputTokens = initialQueryResult.totalOutputTokens;
      let totalResultJudgeInputTokens = 0;
      let totalResultJudgeOutputTokens = 0;
      let searchApiCalls = VALIDATION_CONFIG.search.INITIAL_QUERIES;

      let combinedResults = initialResultSets.flat();
      logWithContext(
        predictionId,
        `Total results found: ${combinedResults.length}`,
      );

      if (combinedResults.length === 0) {
        return {
          prediction_id: predictionId,
          outcome: "MissingContext",
          proof: "No search results found",
          sources: [],
        };
      }

      logWithContext(
        predictionId,
        `Step 3: Evaluating ${combinedResults.length} results...`,
      );
      let judgment = await resultJudge.evaluate(
        predictionText,
        combinedResults,
      );
      totalResultJudgeInputTokens += judgment.inputTokens;
      totalResultJudgeOutputTokens += judgment.outputTokens;

      logWithContext(
        predictionId,
        `Judgment: ${judgment.decision} (score: ${judgment.score}), Sufficient: ${judgment.sufficient ? "yes" : "no"}`,
      );

      if (
        !judgment.sufficient &&
        combinedResults.length < VALIDATION_CONFIG.search.MAX_TOTAL_RESULTS
      ) {
        logWithContext(
          predictionId,
          "Step 4: Results insufficient, generating refined query...",
        );
        if (judgment.nextQuerySuggestion) {
          logWithContext(
            predictionId,
            `Suggestion: ${judgment.nextQuerySuggestion}`,
          );
        }

        const pastAttempts: PastAttempt[] = initialQueryResult.queries.map(
          (q) => {
            const attempt: PastAttempt = {
              query: q,
              success: false,
            };
            if (judgment.nextQuerySuggestion) {
              attempt.reasoning = judgment.nextQuerySuggestion;
            }
            return attempt;
          },
        );

        const refinedQueryResult = await queryEnhancer.enhanceWithTokens(
          predictionText,
          pastAttempts,
        );
        totalQueryEnhancerInputTokens += refinedQueryResult.inputTokens;
        totalQueryEnhancerOutputTokens += refinedQueryResult.outputTokens;

        logWithContext(
          predictionId,
          `Refined query: "${refinedQueryResult.query}"`,
        );

        const refinedResults = await searchMultiple(
          refinedQueryResult.query,
          VALIDATION_CONFIG.search.RESULTS_PER_QUERY,
        );
        searchApiCalls++;

        combinedResults = [...combinedResults, ...refinedResults];
        logWithContext(
          predictionId,
          `Additional results: ${refinedResults.length}, Total: ${combinedResults.length}`,
        );

        judgment = await resultJudge.evaluate(predictionText, combinedResults);
        totalResultJudgeInputTokens += judgment.inputTokens;
        totalResultJudgeOutputTokens += judgment.outputTokens;

        logWithContext(
          predictionId,
          `Final judgment: ${judgment.decision} (score: ${judgment.score})`,
        );
      }

      let outcome: ValidationResult["outcome"];

      if (judgment.decision === "TRUE") {
        outcome =
          judgment.score >= VALIDATION_CONFIG.scoring.TRUE_DEFINITIVE_MIN
            ? "MaturedTrue"
            : "MaturedMostlyTrue";
      } else if (judgment.decision === "FALSE") {
        outcome =
          judgment.score <= VALIDATION_CONFIG.scoring.FALSE_DEFINITIVE_MAX
            ? "MaturedFalse"
            : "MaturedMostlyFalse";
      } else {
        outcome = "MissingContext";
      }

      let proof = judgment.summary;

      if (judgment.evidence) {
        proof += `\n\n${judgment.evidence}`;
      }

      if (judgment.reasoning) {
        proof += `\n\nReasoning: ${judgment.reasoning}`;
      }

      proof = truncateText(proof, 700);

      const totalInputTokens =
        totalQueryEnhancerInputTokens + totalResultJudgeInputTokens;
      const totalOutputTokens =
        totalQueryEnhancerOutputTokens + totalResultJudgeOutputTokens;

      logWithContext(
        predictionId,
        `Costs: ${searchApiCalls} searches, ${totalInputTokens}/${totalOutputTokens} tokens`,
      );

      await writeCostLog({
        prediction_id: predictionId,
        prediction_context: predictionText,
        searchApiCalls,
        queryEnhancerInputTokens: totalQueryEnhancerInputTokens,
        queryEnhancerOutputTokens: totalQueryEnhancerOutputTokens,
        resultJudgeInputTokens: totalResultJudgeInputTokens,
        resultJudgeOutputTokens: totalResultJudgeOutputTokens,
        totalInputTokens,
        totalOutputTokens,
        outcome,
        timestamp: new Date().toISOString(),
      });

      const sources =
        judgment.decision !== "INCONCLUSIVE"
          ? combinedResults.slice(0, 2)
          : [];

      return {
        prediction_id: predictionId,
        outcome,
        proof,
        sources,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logErrorWithContext(
        predictionId,
        `Validation failed: ${errorMessage}`,
      );
      if (error instanceof Error && error.stack) {
        logErrorWithContext(predictionId, `Stack: ${error.stack}`);
      }
      return {
        prediction_id: predictionId,
        outcome: "Invalid",
        proof: `Validation error: ${errorMessage}`,
        sources: [],
      };
    }
  }
}
