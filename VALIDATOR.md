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

### Stage 1: Query Selection

**Goal**: Find predictions ready for validation

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
- Uses `FOR UPDATE SKIP LOCKED` for concurrent worker safety

### Stage 2: Goal Extraction

**Goal**: Extract the prediction claim from the tweet text

```typescript
extractGoalText(prediction: PredictionToValidate): string {
  const goalSlices = prediction.parsedPrediction.goal as Array<{
    start: number;
    end: number;
  }>;

  const tweetText = prediction.scrapedTweet.text;
  const goalTexts = goalSlices.map((slice) =>
    tweetText.slice(slice.start, slice.end)
  );

  return goalTexts.join(" ");
}
```

**Example**:

- Tweet: "I predict Bitcoin will hit $100k by end of Q1 2025! 🚀"
- Goal slices: `[{start: 10, end: 54}]`
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

### Stage 5: Storage

**Goal**: Persist validation results to database

```typescript
async storeValidationResult(tx: Transaction, result: ValidationResult) {
  await tx.insert(validationResult).values({
    parsedPredictionId: result.prediction_id.toString(),
    outcome: result.outcome,
    proof: result.proof,
    sources: result.sources,
  });
}
```

**Table**: `validation_result`

- Stores validation outcome and evidence
- Indexed on `parsed_prediction_id` for fast lookups
- Prevents duplicate validation via `notExists()` check in query

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
