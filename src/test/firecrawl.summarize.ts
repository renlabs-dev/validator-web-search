import { z } from "zod";
import { oneShot } from "../llm/openrouter.js";
import { extractJsonObject } from "./firecrawl.llm-gate.js";

export type RankedForSource = {
  readonly url: string;
  readonly chunks: ReadonlyArray<{ text: string; score: number }>;
};

const DEBUG =
  process.env.FIRECRAWL_DEBUG === "1" || process.argv.includes("--debug");
const debug = (...args: unknown[]) => {
  if (DEBUG) console.log("[debug]", ...args);
};

const QuoteSchema = z.string().min(6).max(800);
const CitationSchema = z.object({
  url: z.string().url(),
  quotes: z.array(QuoteSchema).max(4).default([]),
});
const OutputSchema = z.object({
  status: z.enum(["answered", "insufficient", "ambiguous"]).default("answered"),
  answer: z.string().min(1).max(600).optional(),
  citations: z.array(CitationSchema).default([]),
});

function buildSourcesPrompt(ranked: ReadonlyArray<RankedForSource>): string {
  return ranked
    .map((src, i) => {
      const previews = src.chunks
        .slice(0, 5)
        .map(
          (c, j) =>
            `  - chunk${j + 1} (score=${c.score.toFixed(3)}): ` +
            c.text.replace(/\s+/g, " ").slice(0, 900),
        )
        .join("\n");
      return `#${i + 1}\nurl: ${src.url}\n${previews}`;
    })
    .join("\n\n");
}

export async function summarizeRankedChunks(
  query: string,
  ranked: ReadonlyArray<RankedForSource>,
  anchorDateISO?: string,
) {
  const system = [
    "You are a careful, citation-first reader.",
    "You MUST answer only from the provided snippets. Do NOT use outside knowledge.",
    "Be precise and avoid speculation. If the snippets do not establish a clear answer, return status=insufficient.",
    "Always support the answer with 1–3 short exact quotes present in the snippets for each cited URL.",
    "Quotes must be verbatim substrings of the snippets.",
  ].join("\n");

  const user = [
    `Query: ${query}`,
    anchorDateISO
      ? `Current UTC date: ${anchorDateISO}. If the query implies "yesterday", treat it as the most recent calendar date strictly earlier than this.`
      : undefined,
    "Snippets (embedding top chunks per source):",
    buildSourcesPrompt(ranked),
    "\nWhen exactness is unclear, provide the best supported approximate answer and explicitly say 'Approximate' in the answer. Maintain citations and verbatim quotes.",
    'Output JSON only with:\n{"status":"answered|insufficient|ambiguous","answer":"<concise answer>","citations":[{"url":"<src>","quotes":["<exact quote>"]}]}\nDo not add fields. If quotes are unavailable, set status=insufficient.',
  ].join("\n\n");

  debug("LLM summarize system:\n" + system);
  debug("LLM summarize user:\n" + user);
  const res = await oneShot("validator", user, { system, temperature: 0 });
  debug("LLM summarize raw:", res.content);

  const parsedUnknown = extractJsonObject(res.content);
  const parsed = OutputSchema.parse(parsedUnknown);

  // Verify quotes actually exist inside the provided chunks; drop any that don't.
  const textIndexByUrl = new Map<string, string>();
  for (const s of ranked) {
    textIndexByUrl.set(s.url, s.chunks.map((c) => c.text).join("\n\n"));
  }
  const verified = parsed.citations.map((c) => {
    const hay = textIndexByUrl.get(c.url) ?? "";
    const quotes = (c.quotes ?? []).filter(
      (q) => (q && hay.includes(q)) || q.length === 0,
    );
    return { url: c.url, quotes };
  });

  return {
    status: parsed.status,
    answer: parsed.answer ?? "",
    citations: verified,
  };
}
