# Validator Architecture

## Overview

The **Validator** is the fourth and final stage in the Torus prediction pipeline. It receives **verdicts** from the Verifier (which determined whether predictions came TRUE or FALSE) and validates those verdicts by performing independent web searches and evidence gathering.

**Purpose**: Double-check verifier outputs with real-time web search to ensure prediction outcomes are accurate and well-supported.

---

## Pipeline Context

```
┌─────────────┐     ┌────────────┐     ┌──────────────┐     ┌─────────────┐
│   Scraper   │ ──> │   Filter   │ ──> │   Verifier   │ ──> │  Validator  │
│  (Tweets)   │     │ (Quality)  │     │  (Verdict)   │     │ (Validation)│
└─────────────┘     └────────────┘     └──────────────┘     └─────────────┘
      │                   │                    │                     │
      v                   v                    v                     v
  Raw tweets      Parsed predictions    True/False/Indet.    Validation results
```

**Input**: Parsed predictions with verdicts from the Verifier
**Output**: Validation results with evidence from web searches

---

## Data Model Review

### Input: ParsedPrediction + Verdict

The Validator consumes predictions that have already been verified:

```typescript
interface PredictionToValidate {
  parsedPrediction: {
    id: uuid;
    predictionId: uuid;
    goal: PostSlice[]; // Extracted prediction goal
    timeframe: PostSlice[]; // Timeframe references
    topicId: uuid;
  };
  parsedPredictionDetails: {
    parsedPredictionId: uuid;
    predictionContext: string;
    timeframeStatus: string;
    timeframeStartUtc: timestamp;
    timeframeEndUtc: timestamp;
    timeframePrecision: string;
    // ... other fields
  };
  scrapedTweet: {
    id: bigint;
    text: string;
    authorId: bigint;
    date: timestamp;
  };
}
```

### Output: ValidationResult

```typescript
interface ValidationResult {
  prediction_id: string | number;
  outcome:
    | "MaturedTrue"
    | "MaturedFalse"
    | "MaturedMostlyTrue"
    | "MaturedMostlyFalse"
    | "NotMatured"
    | "MissingContext"
    | "Invalid";
  proof: string; // ≤7 lines markdown: 1 summary + 2-4 bullets + reasoning
  sources: Array<{
    url: string;
    title: string;
    pub_date: string | null;
    excerpt: string;
  }>;
}
```

---

## Validator Core Operations

### Stage 0: Pre-Validation Filtering

**Goal**: Filter out invalid predictions BEFORE expensive API calls

The validator implements a two-layer filtering system to reduce wasted costs on predictions that cannot be meaningfully validated:

#### Layer 1: SQL-Level Filters

Applied at the database query level in `getNextPredictionToValidate()` to prevent fetching invalid predictions:

```typescript
// 7 SQL-level filters applied in WHERE clause:

// Filter 1: Timeframe Sanity (~1.62% filtered)
or(isNull(timeframeStartUtc), isNull(timeframeEndUtc),
   lte(timeframeStartUtc, timeframeEndUtc))

// Filter 2: Timeframe Status (~0.15% filtered)
ne(timeframeStatus, "missing")

// Filter 3: Filter Validation Confidence (~0.5% filtered)
or(isNull(filterValidationConfidence), gte(filterValidationConfidence, "0.85"))

// Filter 4: Prediction Quality (~0.97% filtered)
or(isNull(predictionQuality), gte(predictionQuality, 30))

// Filter 5: LLM Confidence (~1.80% filtered)
or(isNull(llmConfidence), gte(llmConfidence, "0.5"))

// Filter 6: Vagueness (~7.63% filtered)
or(isNull(vagueness), lte(vagueness, "0.8"))
```

**Total Impact**: Filters ~10.87% (1,546 out of 14,218) predictions before any API calls, saving 7,730 API calls.

**Data Source**: Thresholds derived from statistical analysis of 70,416 predictions. See `FILTERING_ANALYSIS.md` for full analysis.

#### Layer 2: Application-Level Checks

Applied in `shouldValidatePrediction()` after fetching prediction:

- Keyword scanning in `filter_validation_reasoning` for semantic invalidity
- Redundant safety checks for edge cases missed by SQL filters
- Early return with "Invalid" outcome (0 API calls) if checks fail

**Outcome**: Predictions that fail pre-validation are immediately marked as "Invalid" without consuming any LLM or SearchAPI resources.

---

### Stage 1: Query Selection

**Goal**: Find predictions ready for validation (with pre-filtering applied)

```typescript
async getNextPredictionToValidate(tx: Transaction) {
  return await tx
    .select(/* ... */)
    .from(parsedPrediction)
    .innerJoin(parsedPredictionDetails, /* ... */)
    .innerJoin(scrapedTweet, /* ... */)
    .where(
      and(
        isNotNull(parsedPredictionDetails.timeframeEndUtc),
        lte(parsedPredictionDetails.timeframeEndUtc, now),
        notExists(/* no validation_result yet */)
      )
    )
    .orderBy(asc(parsedPredictionDetails.timeframeEndUtc))
    .limit(1)
    .for("update", { skipLocked: true });
}
```

**Criteria**:

- `timeframe_end_utc` is not null and ≤ today (prediction has matured)
- No `validation_result` exists yet
- Pre-validation filters applied (see Stage 0)
- Ordered by `timeframe_end_utc` ASC (oldest first)
- Uses `FOR UPDATE SKIP LOCKED` for concurrent worker safety (10 workers in parallel)

### Stage 2: Goal Extraction

**Goal**: Extract the prediction claim from the tweet (or thread)

**Primary Strategy**: Use `prediction_context` (thread summary from Verifier)

```typescript
const predictionText = prediction.parsedPredictionDetails.predictionContext;
```

**Fallback Strategy**: Extract from goal slices with cross-tweet support

```typescript
async extractGoalText(tx: Transaction, prediction: PredictionToValidate): Promise<string> {
  const goalSlices = prediction.parsedPrediction.goal as Array<{
    start: number;
    end: number;
    source?: { tweet_id: string };
  }>;

  // Handle cross-tweet references
  for (const slice of goalSlices) {
    if (slice.source?.tweet_id !== prediction.scrapedTweet.id) {
      // Fetch text from referenced tweet in database
      const referencedTweet = await tx
        .select({ text: scrapedTweet.text })
        .from(scrapedTweet)
        .where(eq(scrapedTweet.id, slice.source.tweet_id))
        .limit(1);

      goalTexts.push(referencedTweet[0].text.slice(slice.start, slice.end));
    } else {
      goalTexts.push(tweetText.slice(slice.start, slice.end));
    }
  }

  return goalTexts.join(" ");
}
```

**Example (Thread Prediction)**:

- Tweet 1: "I predict Bitcoin will hit $100k"
- Tweet 2: "by end of Q1 2025! 🚀"
- Goal slices: `[{start: 10, end: 45, source: {tweet_id: "1"}}, {start: 0, end: 21, source: {tweet_id: "2"}}]`
- Extracted: "Bitcoin will hit $100k by end of Q1 2025"

### Stage 3: Query Enhancement (LLM Agent #1)

**Goal**: Transform prediction goals into optimized search queries

**Implementation**: Uses Gemini 2.5 Flash via OpenRouter

```typescript
const queryEnhancer = new QueryEnhancer();
const enhancedQueries = await queryEnhancer.enhanceMultiple(goalText, 3);
// Generates 3 diverse queries in parallel:
// Query 1: Direct factual approach
// Query 2: News/reports focused
// Query 3: Alternative keywords
```

**Features**:

- Parallel generation of 3 diverse query variations
- Each query approaches claim from different angle
- Varies temperature (0.7, 0.8, 0.9) for diversity
- Returns optimized queries designed for evidence discovery

### Stage 4: Parallel Web Search

**Goal**: Gather comprehensive evidence from multiple search queries

**Implementation**: Searches all 3 queries concurrently

```typescript
const searchPromises = enhancedQueries.map(
  ({ query }) => searchMultiple(query, 10), // 10 results per query
);
const allResultSets = await Promise.all(searchPromises);
const combinedResults = allResultSets.flat(); // ~30 total results
```

**Features**:

- 3 parallel searches (using SearchAPI.io with Google)
- 10 results per query = up to 30 total results
- Executes in ~2-3 seconds (parallel I/O)
- Combines all results for comprehensive evaluation

### Stage 5: Result Judgment (LLM Agent #2)

**Goal**: Evaluate all evidence and determine validation outcome

**Implementation**: Uses Gemini 2.5 Flash via OpenRouter

```typescript
const resultJudge = new ResultJudge();
const judgment = await resultJudge.evaluate(goalText, combinedResults);
// Returns: { decision, score, summary, evidence, reasoning }
```

**Scoring System**:

- Score 9-10: Clear confirmation (multiple credible sources)
- Score 7-8: Strong confirmation (at least one credible source)
- Score 4-6: Vague prediction OR inconclusive evidence
- Score 2-3: Strong refutation
- Score 0-1: Clear refutation

**Decision Mapping**:

- TRUE decision + score >= 9 → `MaturedTrue`
- TRUE decision + score 7-8 → `MaturedMostlyTrue`
- FALSE decision + score <= 2 → `MaturedFalse`
- FALSE decision + score 3-4 → `MaturedMostlyFalse`
- INCONCLUSIVE (score 4-6) → `MissingContext`

**Proof Format** (structured markdown):

```markdown
Summary line of validation result.

• Evidence bullet 1 with specific finding
• Evidence bullet 2 with specific finding
• Evidence bullet 3 (if applicable)

Reasoning: Optional one-line explanation.
```

### Stage 6: Storage and Cost Tracking

**Goal**: Persist validation results and track costs

#### Database Storage

```typescript
async storeValidationResult(tx: Transaction, result: ValidationResult) {
  await tx.insert(validationResult).values({
    parsedPredictionId: result.prediction_id.toString(),
    outcome: result.outcome,
    proof: result.proof, // Truncated to 700 chars
    sources: result.sources, // Top 2 search results (JSONB)
  });
}
```

**Table**: `validation_result`

**Constraints**:
- Unique constraint on `parsed_prediction_id` prevents duplicate validations
- JSONB `sources` stores array of search results with url, title, excerpt, pub_date

#### Cost Logging

```typescript
await writeCostLog({
  prediction_id: prediction.parsedPrediction.id,
  prediction_context: predictionText,
  searchApiCalls: 3, // Always 3 parallel searches
  queryEnhancerInputTokens: queryResult.totalInputTokens,
  queryEnhancerOutputTokens: queryResult.totalOutputTokens,
  resultJudgeInputTokens: judgment.inputTokens,
  resultJudgeOutputTokens: judgment.outputTokens,
  totalInputTokens: queryResult.totalInputTokens + judgment.inputTokens,
  totalOutputTokens: queryResult.totalOutputTokens + judgment.outputTokens,
  outcome: result.outcome,
  timestamp: new Date().toISOString()
});
```

**Cost Tracking**:
- Appended to `costs.json` (one JSON object per line)
- Tracks both LLM token usage and SearchAPI call counts
- Used for historical cost analysis and budgeting

---

### Complete Validation Flow

```
┌───────────────────────────────────────────────────────────────┐
│ Stage 0: Pre-Validation Filtering                            │
│   SQL Filters → ~10.87% filtered (1,546 predictions)         │
│   App Filters → Early "Invalid" return (0 API calls)         │
└─────────────────────────┬─────────────────────────────────────┘
                          │
                          v
┌───────────────────────────────────────────────────────────────┐
│ Stage 1: Query Selection                                     │
│   Database: parsedPrediction + details + scrapedTweet        │
│   Concurrency: FOR UPDATE SKIP LOCKED (10 workers)           │
└─────────────────────────┬─────────────────────────────────────┘
                          │
                          v
┌───────────────────────────────────────────────────────────────┐
│ Stage 2: Goal Extraction                                     │
│   Primary: prediction_context (thread summary)               │
│   Fallback: Extract from goal slices (cross-tweet support)   │
└─────────────────────────┬─────────────────────────────────────┘
                          │
                          v
┌───────────────────────────────────────────────────────────────┐
│ Stage 3: Query Enhancement (LLM #1)                          │
│   Model: Gemini 2.5 Flash via OpenRouter                     │
│   Generate 3 queries in PARALLEL (temp 0.7, 0.8, 0.9)        │
│   Track: input/output tokens                                 │
└─────────────────────────┬─────────────────────────────────────┘
                          │
                          v
┌───────────────────────────────────────────────────────────────┐
│ Stage 4: Parallel Web Search                                 │
│   3 PARALLEL searches via SearchAPI.io (Google)              │
│   10 results per query = ~30 total results                   │
│   Execution: ~2-3 seconds                                    │
│   Early exit: "MissingContext" if no results                 │
└─────────────────────────┬─────────────────────────────────────┘
                          │
                          v
┌───────────────────────────────────────────────────────────────┐
│ Stage 5: Result Judgment (LLM #2)                            │
│   Model: Gemini 2.5 Flash via OpenRouter                     │
│   Input: Prediction + ALL 30 search results                  │
│   Output: Score (0-10) + Decision + Evidence                 │
│   Outcome Mapping: TRUE/FALSE/INCONCLUSIVE → 7 outcomes      │
│   Track: input/output tokens                                 │
└─────────────────────────┬─────────────────────────────────────┘
                          │
                          v
┌───────────────────────────────────────────────────────────────┐
│ Stage 6: Storage and Cost Tracking                           │
│   Database: INSERT validation_result (unique constraint)     │
│   Cost Log: Append to costs.json (tokens + API calls)        │
│   Transaction: COMMIT all operations atomically              │
└───────────────────────────────────────────────────────────────┘
```

---

## Architecture Design

### Worker Pattern

```typescript
async function runWorker(workerId: number, stopHook: () => boolean) {
  const db = createDb();
  const validator = new Validator(db);

  while (!stopHook()) {
    const result = await db.transaction(async (tx) => {
      const prediction = await validator.getNextPredictionToValidate(tx);
      if (!prediction) return null;

      const validationResult = await validator.validatePrediction(prediction);
      await validator.storeValidationResult(tx, validationResult);

      return validationResult;
    });

    if (!result) {
      await sleep(30000); // Wait 30s if no predictions ready
    }
  }
}
```

### Concurrency Strategy

```typescript
// Start multiple workers
async function runValidator(concurrency: number = 1) {
  const workers = Array.from({ length: concurrency }, (_, i) =>
    runWorker(i + 1, () => shouldStop),
  );
  await Promise.all(workers);
}
```

**Benefits**:

- Horizontal scaling: Add more workers to increase throughput
- Fault tolerance: One worker crash doesn't affect others
- Load balancing: Workers automatically grab next available prediction

---

## LLM Integration Architecture

### OpenRouter Integration

All LLM calls go through OpenRouter API using the OpenAI SDK format:

```typescript
const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: env.OPENROUTER_API_KEY,
});
```

### Agent #1: Query Enhancer

**Model**: Gemini 2.5 Flash (`google/gemini-2.5-flash`)
**Role**: Transform prediction goals into effective search queries
**Prompt**: Loaded from `QUERY_ENHANCER_PROMPT.md`

**Implementation**:

- Generates 3 diverse queries in parallel
- Each query approaches claim from different angle
- Temperature variation for diversity (0.7, 0.8, 0.9)
- Returns clean search queries without extra text

**Example**:

```
Input: "England would no longer exist"
Output:
  Query 1: "England no longer exist prediction"
  Query 2: "Paul Ehrlich England 2000 prediction news"
  Query 3: "UK existence prediction wrong"
```

### Agent #2: Result Judge

**Model**: Gemini 2.5 Flash (`google/gemini-2.5-flash`)
**Role**: Evaluate search results and determine validation outcome
**Prompt**: Loaded from `RESULT_JUDGE_PROMPT.md`

**Implementation**:

- Evaluates up to 30 search results at once
- Returns 0-10 score with decision (TRUE/FALSE/INCONCLUSIVE)
- Generates structured markdown proof (summary + bullets + reasoning)
- Handles vague predictions (scores them 0-2)

**Example**:

```
Input: Goal + 30 search results
Output:
  Score: 9
  Decision: TRUE
  Summary: "Bitcoin closed above $100k on August 3, 2025"
  Evidence: "• CoinGecko data shows $100,234..."
  Reasoning: "Threshold met with verifiable data"
```

### Prompt Management

System prompts are stored as markdown files at the repository root:

- `QUERY_ENHANCER_PROMPT.md` - Query optimization guidelines
- `RESULT_JUDGE_PROMPT.md` - Evidence evaluation criteria with examples

Prompts are loaded at module initialization using Node.js file system operations:

```typescript
import { readFile } from "node:fs/promises";
export const QUERY_ENHANCER_SYSTEM_PROMPT = await loadPrompt(
  "QUERY_ENHANCER_PROMPT.md",
);
```

---

## Edge Cases

### Case 1: Ambiguous Evidence

**Scenario**: Search returns conflicting information
**Example**: "BTC will hit $100k" but sources disagree (some say $99k peak, others $101k)
**Solution**: Use `MaturedMostlyTrue` with confidence score, cite conflicting sources

### Case 2: No Search Results

**Scenario**: Query returns no organic results
**Example**: Very niche prediction with no web coverage
**Solution**: Mark as `MissingContext`, log for manual review

### Case 3: Outdated Information

**Scenario**: Search returns old data, not from timeframe
**Example**: Searching "Tesla stock price Q1 2025" returns 2024 data
**Solution**: Filter by `pub_date`, require sources from timeframe period or after

### Case 4: Precision Issues

**Scenario**: Prediction has specific number, evidence is approximate
**Example**: "BTC will hit $100,000" vs sources reporting "$99,800-$100,200 range"
**Solution**: Define tolerance ranges (±2% for prices), mark as True within tolerance

### Case 5: Multi-Part Predictions

**Scenario**: Prediction has multiple conditions (AND/OR logic)
**Example**: "BTC > $100k AND ETH > $5k by Q1 2025"
**Solution**: Search each part independently, combine results with logical operators

---

## Integration Points

### Upstream: Verifier

- **Input**: Predictions with verdicts from `verdict` table
- **Dependency**: Requires `timeframe_end_utc` to be set
- **Schema**: Shares `parsed_prediction`, `parsed_prediction_details`, `verdict` tables

### Downstream: Analytics/UI

- **Output**: Validation results in `validation_result` table
- **Query pattern**:
  ```sql
  SELECT pp.*, v.verdict, vr.outcome, vr.sources
  FROM parsed_prediction pp
  JOIN verdict v ON v.parsed_prediction_id = pp.id
  LEFT JOIN validation_result vr ON vr.parsed_prediction_id = pp.id
  WHERE vr.outcome IN ('MaturedTrue', 'MaturedFalse')
  ORDER BY vr.created_at DESC;
  ```

### External: SearchAPI.io

- **API**: https://www.searchapi.io/
- **Auth**: API key in `SEARCHAPI_API_KEY` env var
- **Rate limits**: Depends on pricing tier
- **Fallback**: Return `MissingContext` on API errors

---

## Technology Stack

**Database**: PostgreSQL with Drizzle ORM
**LLM Provider**: OpenRouter
**Search API**: SearchAPI.io (Google)
**Models**:

- Query Enhancer: Gemini 2.5 Flash
- Result Judge: Gemini 2.5 Flash
  **Runtime**: Node.js with TypeScript (ESM modules)
  **Concurrency**: Single worker (configurable)

---

## Running the Validator

### Prerequisites

```bash
# Install dependencies
npm install

# Set environment variables
cp .env.example .env
# Edit .env with your credentials:
#   POSTGRES_URL=postgresql://...
#   SEARCHAPI_API_KEY=...
#   NODE_TLS_REJECT_UNAUTHORIZED=0  # For self-signed SSL certs
```

### Development

```bash
# Run with auto-reload
npm run dev

# Type checking
npm run typecheck

# Linting
npm run lint
```

### Production

```bash
# Build
npm run build

# Run compiled version
npm start
```

### Monitoring

```bash
# Check validation results
psql $POSTGRES_URL -c "SELECT outcome, COUNT(*) FROM validation_result GROUP BY outcome;"

# Check latest validations
psql $POSTGRES_URL -c "SELECT * FROM validation_result ORDER BY created_at DESC LIMIT 10;"
```

---

## Summary

The Validator is the fourth stage in the Torus prediction pipeline. It validates prediction outcomes using a multi-agent LLM system combined with web search.

**Architecture**:

- LLM integration: Gemini 2.5 Flash via OpenRouter for both query enhancement and evidence evaluation
- Parallel processing: 3 diverse queries generated and searched concurrently
- Evidence gathering: Up to 30 search results from SearchAPI.io (Google)
- Scoring system: 0-10 scale determines outcome (MaturedTrue, MaturedMostlyTrue, MaturedFalse, MaturedMostlyFalse, or MissingContext)
- Output format: Structured markdown proof with summary, evidence bullets, and reasoning (max 2 sources)

The validator processes matured predictions from the database, validates them through parallel web searches, and stores results in the validation_result table.
