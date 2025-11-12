import { z } from "zod";
import { createOpenRouterClient } from "./openrouter.js";

export const EmbeddingInputSchema = z.object({
  texts: z.array(z.string().min(1)).min(1),
  model: z
    .literal("openai/text-embedding-3-small")
    .or(z.literal("openai/text-embedding-3-large"))
    .default("openai/text-embedding-3-small"),
});

export type EmbeddingInput = z.infer<typeof EmbeddingInputSchema>;

export async function embedTexts({ texts, model }: EmbeddingInput) {
  const parsed = EmbeddingInputSchema.parse({ texts, model });

  const client = createOpenRouterClient();

  const res = await client.embeddings.create({
    model: parsed.model,
    input: parsed.texts,
  });

  return res.data.map((d) => d.embedding);
}

export function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export async function rankByEmbedding(
  query: string,
  chunks: readonly string[],
  model: EmbeddingInput["model"] = "openai/text-embedding-3-small",
) {
  const allEmbs = await embedTexts({ texts: [query, ...chunks], model });
  const qEmb = allEmbs[0];
  const cEmbs = allEmbs.slice(1);
  if (!qEmb) return [] as { index: number; text: string; score: number }[];
  const scored = chunks.map((text, i) => {
    const emb = cEmbs[i];
    let vec: number[] | null = null;
    if (Array.isArray(emb) && emb.every((v) => typeof v === "number")) {
      vec = emb as number[];
    }
    let score = -1;
    if (vec) {
      score = cosineSimilarity(qEmb, vec);
    }
    return { index: i, text, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
