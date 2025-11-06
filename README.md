# Validator

Validator is the fourth and final stage in the Torus prediction pipeline. It validates verdicts from the Verifier by performing independent web searches and evidence gathering.

## Quick Start

```bash
# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env with your credentials

# Run validator
npm run dev
```

## Documentation

See [VALIDATOR.md](./VALIDATOR.md) for complete architecture and implementation details.

## Project Structure

```
validator/
├── src/
│   ├── db/              # Database client and schema
│   ├── llm/             # LLM agents (query enhancer, result judge)
│   ├── search/          # SearchAPI.io integration
│   ├── env.ts           # Environment config
│   ├── validator.ts     # Core validation logic
│   ├── utils.ts         # Utility functions
│   └── index.ts         # Main entry point
├── drizzle/             # Database migrations
├── QUERY_ENHANCER_PROMPT.md  # Query enhancement prompt
├── RESULT_JUDGE_PROMPT.md    # Result judgment prompt
├── .env.example         # Environment template
└── VALIDATOR.md         # Architecture docs
```

## Environment Variables

- `POSTGRES_URL` - PostgreSQL connection string
- `SEARCHAPI_API_KEY` - SearchAPI.io API key
- `OPENROUTER_API_KEY` - OpenRouter API key for LLM agents
- `NODE_TLS_REJECT_UNAUTHORIZED` - Set to `0` for self-signed certs
- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment (development/production)

## Scripts

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm start            # Run compiled version
npm run typecheck    # Type checking
npm run lint         # Lint code
npm run test         # Run tests
```
