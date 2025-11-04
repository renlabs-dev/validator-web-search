import { z } from "zod";
import { eq, and, notExists, asc, lte, isNotNull } from "drizzle-orm";
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
import { searchWeb } from "./search/searchapi.js";

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

export class Validator {
  constructor(_db: DB) {}

  /**
   * Get next prediction ready for validation
   * Criteria: timeframe_end_utc is not null, is today or past, and no verdict exists
   */
  async getNextPredictionToValidate(
    tx: Transaction
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
        eq(parsedPrediction.id, parsedPredictionDetails.parsedPredictionId)
      )
      .innerJoin(
        scrapedTweet,
        eq(parsedPrediction.predictionId, scrapedTweet.predictionId)
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
              .where(eq(validationResult.parsedPredictionId, parsedPrediction.id))
          )
        )
      )
      .orderBy(asc(parsedPredictionDetails.timeframeEndUtc))
      .limit(1)
      .for("update", { skipLocked: true });

    if (predictions.length === 0) {
      return null;
    }

    return predictions[0] ?? null;;
  }

  /**
   * Fetch a specific tweet by ID from the database
   */
  async getThreadTweet(tx: Transaction, tweetId: string): Promise<string | null> {
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
    prediction: PredictionToValidate
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
      (slice) => slice.source?.tweet_id && slice.source.tweet_id !== currentTweetId
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
    result: ValidationResult
  ): Promise<void> {
    await tx.insert(validationResult).values({
      parsedPredictionId: result.prediction_id.toString(),
      outcome: result.outcome,
      proof: result.proof,
      sources: result.sources,
    });
  }

  /**
   * Validate a single prediction
   */
  async validatePrediction(
    tx: Transaction,
    prediction: PredictionToValidate
  ): Promise<ValidationResult> {
    const goalText = await this.extractGoalText(tx, prediction);

    if (!goalText) {
      return {
        prediction_id: prediction.parsedPrediction.id,
        outcome: "Invalid",
        proof: "Unable to extract goal text from prediction",
        sources: [],
      };
    }

    // Perform web search
    const searchResult = await searchWeb(goalText);

    if (!searchResult) {
      return {
        prediction_id: prediction.parsedPrediction.id,
        outcome: "MissingContext",
        proof: "No search results found for the prediction claim",
        sources: [],
      };
    }

    // For now, return the first result as a simple validation
    // TODO: Implement more sophisticated validation logic
    return {
      prediction_id: prediction.parsedPrediction.id,
      outcome: "MaturedTrue", // Placeholder - needs actual validation logic
      proof: `Found evidence: ${searchResult.title}`,
      sources: [
        {
          url: searchResult.url,
          title: searchResult.title,
          excerpt: searchResult.excerpt,
          pub_date: searchResult.pub_date,
        },
      ],
    };
  }
}
