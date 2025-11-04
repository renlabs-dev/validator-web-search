import { pgTable, varchar, timestamp, jsonb, decimal, integer, boolean, bigint, index, uuid, text } from "drizzle-orm/pg-core";

// Parsed prediction table
export const parsedPrediction = pgTable(
  "parsed_prediction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    predictionId: uuid("prediction_id").notNull(),
    goal: jsonb("goal").notNull(),
    timeframe: jsonb("timeframe").notNull(),
    topicId: uuid("topic_id"),
    predictionQuality: integer("prediction_quality"),
    llmConfidence: decimal("llm_confidence"),
    briefRationale: text("brief_rationale"),
    vagueness: decimal("vagueness"),
    context: jsonb("context"),
    filterAgentId: varchar("filter_agent_id", { length: 48 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    predictionIdIdx: index("parsed_prediction_prediction_id_idx").on(table.predictionId),
    createdAtIdx: index("parsed_prediction_created_at_idx").on(table.createdAt),
  })
);

// Parsed prediction details table
export const parsedPredictionDetails = pgTable(
  "parsed_prediction_details",
  {
    parsedPredictionId: uuid("parsed_prediction_id").primaryKey(),
    predictionContext: varchar("prediction_context", { length: 5000 }),
    timeframeStatus: varchar("timeframe_status", { length: 50 }),
    timeframeStartUtc: timestamp("timeframe_start_utc", { withTimezone: true }),
    timeframeEndUtc: timestamp("timeframe_end_utc", { withTimezone: true }),
    timeframePrecision: varchar("timeframe_precision", { length: 50 }),
    timeframeReasoning: varchar("timeframe_reasoning", { length: 2000 }),
    timeframeAssumptions: jsonb("timeframe_assumptions"),
    timeframeConfidence: decimal("timeframe_confidence"),
    filterValidationConfidence: decimal("filter_validation_confidence"),
    filterValidationReasoning: varchar("filter_validation_reasoning", { length: 2000 }),
    verdictConfidence: decimal("verdict_confidence"),
    verdictSources: jsonb("verdict_sources"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    timeframeEndUtcIdx: index("parsed_prediction_details_timeframe_end_utc_idx").on(table.timeframeEndUtc),
  })
);

// Verdict table
export const verdict = pgTable(
  "verdict",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parsedPredictionId: uuid("parsed_prediction_id").notNull(),
    verdict: boolean("verdict").notNull(),
    context: jsonb("context"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    parsedPredictionIdIdx: index("verdict_parsed_prediction_id_idx").on(table.parsedPredictionId),
  })
);

// Parsed prediction feedback table
export const parsedPredictionFeedback = pgTable(
  "parsed_prediction_feedback",
  {
    parsedPredictionId: uuid("parsed_prediction_id").primaryKey(),
    validationStep: varchar("validation_step", { length: 50 }),
    failureCause: varchar("failure_cause", { length: 50 }),
    reason: varchar("reason", { length: 2000 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  }
);

// Scraped tweet table (for joining)
export const scrapedTweet = pgTable(
  "scraped_tweet",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey(),
    text: varchar("text", { length: 25000 }).notNull(),
    authorId: bigint("author_id", { mode: "bigint" }).notNull(),
    date: timestamp("date", { withTimezone: true }).notNull(),
    conversationId: bigint("conversation_id", { mode: "bigint" }),
    parentTweetId: bigint("parent_tweet_id", { mode: "bigint" }),
    predictionId: uuid("prediction_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  }
);

// Validation result table (our output)
export const validationResult = pgTable(
  "validation_result",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parsedPredictionId: uuid("parsed_prediction_id").notNull(),
    outcome: varchar("outcome", { length: 50 }).notNull(),
    proof: varchar("proof", { length: 700 }).notNull(),
    sources: jsonb("sources").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    parsedPredictionIdIdx: index("validation_result_parsed_prediction_id_idx").on(table.parsedPredictionId),
  })
);

// Type exports
export type ParsedPrediction = typeof parsedPrediction.$inferSelect;
export type ParsedPredictionDetails = typeof parsedPredictionDetails.$inferSelect;
export type Verdict = typeof verdict.$inferSelect;
export type ParsedPredictionFeedback = typeof parsedPredictionFeedback.$inferSelect;
export type ScrapedTweet = typeof scrapedTweet.$inferSelect;
export type ValidationResult = typeof validationResult.$inferSelect;
