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
    goal: PostSlice[];        // Extracted prediction goal
    timeframe: PostSlice[];   // Timeframe references
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
  proof: string;  // ≤7 lines markdown: 1 summary + 2-4 bullets + reasoning
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

### Stage 3: Web Search

**Goal**: Find evidence on the web for or against the prediction

```typescript
async searchWeb(query: string): Promise<SearchResult | null> {
  const url = new URL("https://www.searchapi.io/api/v1/search");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", env.SEARCHAPI_API_KEY);

  const response = await fetch(url.toString());
  const data = await response.json();

  return data.organic_results?.[0] || null;
}
```

**Currently**: Returns the **first organic search result** from Google via SearchAPI.io

**Future**: Will implement multi-query strategy, relevance scoring, and source credibility checks

### Stage 4: Outcome Determination

**Goal**: Analyze search results and determine validation outcome

**Current (MVP)**: Simple placeholder logic
```typescript
// For now, returns MaturedTrue if evidence found
return {
  prediction_id: prediction.parsedPrediction.id,
  outcome: searchResult ? "MaturedTrue" : "MissingContext",
  proof: `Found evidence: ${searchResult.title}`,
  sources: [searchResult]
};
```

**Future**: Will implement:
- Evidence analysis (supporting vs refuting)
- Confidence scoring
- Multi-source aggregation
- Nuanced outcomes (MostlyTrue, MostlyFalse)

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

**Key Features**:
- **Concurrent workers**: Multiple workers can run in parallel
- **Transaction isolation**: Each prediction validated in atomic transaction
- **Row-level locking**: `FOR UPDATE SKIP LOCKED` prevents race conditions
- **Graceful shutdown**: SIGINT/SIGTERM handling
- **AsyncLocalStorage**: Worker ID tracking for logging

### Concurrency Strategy

```typescript
// Start multiple workers
async function runValidator(concurrency: number = 1) {
  const workers = Array.from({ length: concurrency }, (_, i) =>
    runWorker(i + 1, () => shouldStop)
  );
  await Promise.all(workers);
}
```

**Benefits**:
- Horizontal scaling: Add more workers to increase throughput
- Fault tolerance: One worker crash doesn't affect others
- Load balancing: Workers automatically grab next available prediction

---

## Current Implementation (MVP)

### What's Working ✅

1. **Database Integration**
   - Connects to PostgreSQL with Drizzle ORM
   - Proper UUID handling
   - SSL certificate handling for remote databases

2. **Query Logic**
   - Finds matured predictions correctly
   - Excludes already-validated predictions
   - Row-level locking for concurrent workers

3. **Search Integration**
   - Calls SearchAPI.io with Google engine
   - Extracts first organic result
   - Returns structured search result

4. **Worker Architecture**
   - Single worker polling loop
   - Transaction-based processing
   - Error handling with retry

5. **Logging**
   - Worker ID prefixes
   - Prediction details (ID, tweet preview, goal, search query)
   - Validation outcome logging

### What's Pending ⏳

1. **Smart Outcome Determination**
   - Currently returns placeholder "MaturedTrue"
   - Needs: Evidence analysis, confidence scoring, nuanced outcomes

2. **Multi-Source Search**
   - Currently uses only first result
   - Needs: Multiple queries, source aggregation, credibility weighting

3. **Proof Generation**
   - Currently simple single-line proof
   - Needs: Structured markdown (summary + bullets + reasoning)

4. **Advanced Query Construction**
   - Currently uses raw goal text
   - Needs: Entity extraction, query variations, date filtering

5. **Error Recovery**
   - Basic retry with 5s delay
   - Needs: Exponential backoff, error categorization, alerting

---

## Future Improvements

### Phase 1: Enhanced Evidence Gathering

**Multi-Query Strategy**
```typescript
function generateSearchQueries(goal: string, timeframe: Timeframe): string[] {
  return [
    goal,                                    // Base query
    `${goal} news`,                          // News-focused
    `${goal} ${timeframe.end.getFullYear()}`, // Time-scoped
    `did ${goal} happen`,                    // Direct question
  ];
}
```

**Source Diversity**
- News sites (credible journalism)
- Official sources (company announcements, government data)
- Market data APIs (for price/number predictions)
- Social proof (multiple independent reports)

**Relevance Scoring**
```typescript
interface ScoredSource {
  source: SearchResult;
  relevanceScore: number;  // 0-1
  credibilityScore: number; // 0-1
  recencyScore: number;     // 0-1
  overallScore: number;     // Weighted average
}
```

### Phase 2: Intelligent Outcome Logic

**Evidence Classification**
```typescript
enum EvidenceType {
  SUPPORTING = "supporting",    // Confirms prediction
  REFUTING = "refuting",        // Contradicts prediction
  NEUTRAL = "neutral",          // Neither confirms nor denies
  INSUFFICIENT = "insufficient" // Not enough info
}
```

**Outcome Rules**
```
MaturedTrue:       ≥80% supporting evidence, high confidence
MaturedMostlyTrue: 60-79% supporting evidence
MaturedFalse:      ≥80% refuting evidence, high confidence
MaturedMostlyFalse: 60-79% refuting evidence
MissingContext:    <60% confidence or conflicting evidence
NotMatured:        Timeframe hasn't ended (should not reach validator)
Invalid:           Malformed prediction or data integrity issues
```

### Phase 3: Proof Generation

**Format**:
```markdown
Summary: Bitcoin reached $105,000 on January 15, 2025.

Evidence:
• CoinDesk reported BTC at $105,234 on Jan 15, 2025
• Bloomberg confirmed the milestone with market data
• Multiple exchanges showed prices above $100k

Reasoning: Prediction was accurate within specified timeframe.
```

**Implementation**:
```typescript
function generateProof(
  prediction: string,
  evidence: ScoredSource[],
  outcome: ValidationOutcome
): string {
  const summary = generateSummary(prediction, outcome);
  const bullets = evidence
    .slice(0, 4)
    .map(e => `• ${e.source.title} (${e.source.pub_date})`);
  const reasoning = generateReasoning(outcome, evidence);

  return `${summary}\n\nEvidence:\n${bullets.join('\n')}\n\n${reasoning}`;
}
```

### Phase 4: Cost Optimization

**Search Result Caching**
```typescript
// Cache search results by query + date range
const cacheKey = `${query}:${dateRange}`;
const cached = await redis.get(cacheKey);
if (cached) return JSON.parse(cached);
```

**Batch Processing**
- Group predictions by topic
- Reuse search results across similar predictions
- Priority queue for high-value predictions

**Rate Limiting**
- Respect SearchAPI.io rate limits
- Exponential backoff on API errors
- Fallback to cached data when available

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

## Monitoring and Metrics

### Success Metrics

1. **Validation Coverage**: % of verdicts that get validated
   - Target: >95% of matured predictions validated within 24h

2. **Evidence Quality**: % of validations with ≥2 credible sources
   - Target: >80% have multiple sources

3. **Outcome Accuracy**: Agreement rate with manual review
   - Target: >90% match human judgment

4. **Latency**: Time from maturity to validation
   - Target: <1 hour for recent predictions

5. **Cost Efficiency**: Average cost per validation
   - Target: <$0.01 per validation (SearchAPI.io + compute)

### Monitoring Dashboard

```typescript
interface ValidatorMetrics {
  validationsCompleted: number;
  validationsPerHour: number;
  outcomeDistribution: Record<ValidationOutcome, number>;
  averageSourcesPerValidation: number;
  searchAPIErrors: number;
  processingErrors: number;
  averageProcessingTime: number; // milliseconds
}
```

---

## Cost Analysis

### SearchAPI.io Pricing
- **Free tier**: 100 searches/month
- **Paid**: ~$0.002 per search (Serper.dev pricing)
- **Monthly estimate**: 10,000 predictions × $0.002 = $20/month

### Optimization Strategies

1. **Result Caching**:
   - Cache similar queries (e.g., "BTC price Q1 2025")
   - Reduce duplicate searches by ~40%
   - Savings: ~$8/month

2. **Batch Processing**:
   - Group predictions by topic/entity
   - Reuse search results across predictions
   - Savings: ~$5/month

3. **Smart Querying**:
   - Skip validation for low-priority predictions
   - Prioritize high-stakes/high-engagement predictions
   - Savings: Variable

**Total estimated cost**: $20/month (unoptimized) → $7-10/month (optimized)

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

## Development Roadmap

### ✅ Phase 0: MVP (Current)
- [x] Database schema and connection
- [x] Query logic for matured predictions
- [x] SearchAPI.io integration (first result)
- [x] Basic worker architecture
- [x] Result storage
- [x] Logging and debugging

### 🚧 Phase 1: Core Validation (Next)
- [ ] Multi-query search strategy
- [ ] Evidence classification (supporting/refuting/neutral)
- [ ] Outcome determination logic
- [ ] Structured proof generation
- [ ] Source credibility scoring

### 📋 Phase 2: Production Readiness
- [ ] Error handling and retry logic
- [ ] Monitoring and alerting
- [ ] Cost tracking
- [ ] Search result caching
- [ ] Rate limiting
- [ ] API fallbacks

### 🚀 Phase 3: Advanced Features
- [ ] Multi-source aggregation
- [ ] Market data API integration
- [ ] Confidence scoring
- [ ] Manual review queue
- [ ] A/B testing framework
- [ ] Validation quality feedback loop

---

## Technical Decisions

### Why SearchAPI.io?
- **Pro**: Simple REST API, good Google results, affordable
- **Con**: Rate limits, no built-in caching, single source dependency
- **Alternative considered**: SerpAPI (more expensive), Brave Search (less coverage)

### Why Single Worker (MVP)?
- **Simplicity**: Easier to debug and monitor
- **Cost control**: Avoid API rate limit issues
- **Scalability**: Can increase to N workers with config change
- **Future**: Will scale to 3-5 workers in production

### Why Store Everything?
- **Auditability**: Can review validation decisions
- **Analytics**: Track outcome distribution, source quality
- **Debugging**: Reproduce validation logic on historical data
- **Training data**: Use validated predictions for ML models

### Why Placeholder Outcomes?
- **Iterative development**: Get pipeline working end-to-end first
- **Data collection**: Gather real search results before optimizing logic
- **Risk mitigation**: Avoid premature optimization
- **Learning**: Understand data patterns before building complex rules

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

The **Validator** is a critical quality assurance layer that independently verifies prediction outcomes using real-time web search. It operates as the final stage in the prediction pipeline, ensuring that verdicts from the Verifier are accurate and well-supported by evidence.

**Current State**: MVP with basic search integration and placeholder outcome logic
**Next Steps**: Implement multi-source evidence gathering and intelligent outcome determination
**Timeline**: Core validation logic in 1-2 weeks, production-ready in 3-4 weeks

**Key Principle**: Start simple, measure everything, iterate based on data.
