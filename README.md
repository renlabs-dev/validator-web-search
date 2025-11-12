# Validator

Multi-worker validation system that evaluates predictions using web search and LLM-based evidence analysis.

## Quick Start

```bash
npm install
cp .env.example .env
# Configure .env with your credentials
npm run dev
```

## Architecture

- **10 concurrent workers** with row-level locking for parallel processing
- **Hybrid search strategy**: 2 parallel queries + optional refinement
- **Two-agent system**: Query generation (Gemini 2.5 Flash) + Result evaluation (Gemini 2.5 Flash)
- **Pre-validation filtering**: SQL-level quality checks reduce API costs by ~11%
- **Live terminal UI**: Real-time stats, cost tracking, worker status

## Project Structure

```
validator/
├── src/
│   ├── db/              # Drizzle ORM client and schema
│   ├── llm/             # LLM agents (QueryEnhancer, ResultJudge)
│   ├── search/          # SearchAPI.io integration
│   ├── ui/              # Terminal UI and cost tracking
│   ├── validator.ts     # Core validation logic
│   ├── logger.ts        # Logging with shutdown awareness
│   ├── utils.ts         # Utilities
│   └── index.ts         # Worker orchestration
├── prompts/             # Agent system prompts (JSON)
└── drizzle/             # Database migrations
```

## Environment Variables

```env
POSTGRES_URL=postgresql://...
SEARCHAPI_API_KEY=...
OPENROUTER_API_KEY=...
NODE_ENV=production
```

## Validation Pipeline

1. **Fetch**: Get next unvalidated prediction (timeframe ended)
2. **Pre-validate**: Check quality thresholds (confidence, vagueness, etc.)
3. **Extract**: Use prediction_context or extract from goal slices
4. **Query**: Generate 2 diverse search queries
5. **Search**: Parallel search (10 results per query)
6. **Judge**: Evaluate evidence with sufficiency check
7. **Refine**: Optional 3rd query if insufficient results
8. **Store**: Write outcome (MaturedTrue/False/MostlyTrue/MostlyFalse/MissingContext/Invalid)

## Scripts

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm start            # Run compiled version
npm run typecheck    # Type checking only
```

## Configuration

Edit `VALIDATION_CONFIG` in `src/validator.ts`:

- `search.INITIAL_QUERIES`: Parallel queries (default: 2)
- `search.MAX_TOTAL_RESULTS`: Max results before stopping (default: 30)
- `quality.*`: Pre-validation thresholds
- `scoring.*`: Outcome mapping thresholds
