# Embeddings + Rerank Flow (Deep Dive)

This document explains, in detail, how the scraper test pipeline embeds and reranks content after scraping, and how the ranked snippets are handed to the judge LLM. The goal is to keep the process efficient, deterministic, and easy to tune.

## High-Level Flow

- Chunk scraped text into manageable slices.
- Compute embeddings for the query and each chunk.
- Score chunks by cosine similarity against the query embedding.
- Sort chunks by score (highest first); log and optionally cap to top-k for display.
- Pass ranked chunks for the current source to the summarizer/judge LLM.
- Short-circuit as soon as we get sufficient evidence.

## Chunking Strategy

- HTML is stripped to text, removing scripts and styles.
- Text is chunked by fixed character length to bound embedding cost and context.
- Current default: size 1200 chars, capped to 12 chunks per crawled page in the test pipeline (keeps it cheap while still useful).

Relevant utility:

- `src/scraper/scraper.text.ts:1`

```ts
export function stripHtml(html: string) {
  /* remove <script>, <style>, tags, collapse whitespace */
}
export function chunkText(s: string, size = 800) {
  /* fixed-size slicing */
}
```

Where it’s used in the pipeline:

- `src/test/scraper.pipeline.ts` (strip to text then chunk to 1200, capped to 12)

```ts
const text = stripHtml(page.html);
const chunks = chunkText(text, 1200).slice(0, 12);
```

## Embedding + Scoring

We use OpenAI’s embedding models (small by default) to embed both the query and the content chunks, compute cosine similarity, and sort.

Core implementation:

- `src/llm/embeddings.ts:15` – input validation + call to OpenAI
- `src/llm/embeddings.ts:28` – cosine similarity
- `src/llm/embeddings.ts:44` – `rankByEmbedding` orchestrates end‑to‑end ranking

```ts
export async function embedTexts({ texts, model }: EmbeddingInput) {
  const parsed = EmbeddingInputSchema.parse({ texts, model });
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const res = await client.embeddings.create({
    model: parsed.model,
    input: parsed.texts,
  });
  return res.data.map((d) => d.embedding);
}

export function cosineSimilarity(a: number[], b: number[]) {
  // dot(a, b) / (||a|| * ||b||)
}

export async function rankByEmbedding(
  query: string,
  chunks: readonly string[],
  model = "text-embedding-3-small",
) {
  const allEmbs = await embedTexts({ texts: [query, ...chunks], model });
  const qEmb = allEmbs[0];
  const cEmbs = allEmbs.slice(1);
  const scored = chunks.map((text, i) => ({
    index: i,
    text,
    score: cosineSimilarity(qEmb, cEmbs[i]),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
```

Notes:

- Model is typed and validated via Zod; defaults to `text-embedding-3-small`.
- Cosine denominator is guarded against zero to avoid NaNs.
- If embeddings are ever missing, we return an empty ranking (fail‑safe, not throwing).

## Query Focus

We focus the embedding similarity on the concrete numeric/date signal we care about. The pipeline builds a concise focus string:

- `src/test/scraper.pipeline.ts`

```ts
const focus = `${query} — exact numeric price and date context`;
```

This tends to lift price tables or historical series snippets above boilerplate marketing text.

## Per‑Source Ranking in the Pipeline

For each source (sequentially), we run embeddings and sort. We print a short preview of the best 3 and forward all ranked chunks to the judge (to preserve recall while keeping the judge’s input bounded per source):

- `src/test/scraper.pipeline.ts`

```ts
const ranked = await rankByEmbedding(focus, source.chunks);
const top = ranked.slice(0, 3);
console.log("\nSource:", source.url);
for (const r of top) {
  const preview = r.text.slice(0, 240).replace(/\s+/g, " ");
  console.log(`- score=${r.score.toFixed(3)} :: ${preview}`);
}
```

We then build the judge payload for exactly this source:

- `src/test/scraper.pipeline.ts`

```ts
const rankedForJudge = [
  {
    url: source.url,
    chunks: ranked.map((r) => ({ text: r.text, score: r.score })),
  },
];
```

## Hand‑off to the Judge LLM

The summarizer/judge receives the ranked chunks (top‑weighted) and is instructed to answer strictly from the snippets with citations and verbatim quotes. It returns one of: `answered`, `insufficient`, or `ambiguous`.

- `src/scraper/scraper.summarize.ts:1` – schema + prompt construction
- `src/scraper/scraper.summarize.ts` – prompt includes scored chunk previews per source

```ts
const summary = await summarizeRankedChunks(query, rankedForJudge, anchorISO);
```

Key properties enforced by Zod validation in `summarizeRankedChunks`:

- Output shape and status are validated.
- Quotes are cross‑checked to exist verbatim within the provided text (defensive post‑validation).
- If evidence is sufficient (`answered` with citations), we stop early and return.

## Why This Design

- Cost‑aware: We embed and judge one source at a time and stop early on success.
- Precision: Cosine similarity against a focused query string tends to surface price/date snippets.
- Robustness: Strict schema validation and quote verification de‑risk hallucinations.
- Tunability: Chunk size, cap, and embedding model are simple knobs.

## Tuning Guide

- Reduce cost: lower chunk size/cap (e.g., 800 chars × 8 chunks) or top‑k.
- Increase precision: refine `focus` string (task‑specific keywords).
- Model trade‑off: use `text-embedding-3-large` for tougher retrieval at higher cost.
- Thresholding: introduce a minimum cosine score to filter noisy chunks before judging.

## Edge Cases & Safeguards

- Empty or blocked pages fall back to SERP snippets (free) with the same ranking step.
- If embeddings fail, ranking returns empty and the judge step is skipped for that source.
- Quotes are validated against the exact text we passed; unverifiable quotes are dropped.

## Quick Reference (Files)

- chunking: `src/scraper/scraper.text.ts:1`
- embedding core: `src/llm/embeddings.ts:15`, `src/llm/embeddings.ts:28`, `src/llm/embeddings.ts:44`
- per‑source ranking: `src/test/scraper.pipeline.ts`
- judge integration: `src/test/scraper.pipeline.ts`, `src/scraper/scraper.summarize.ts:1`
