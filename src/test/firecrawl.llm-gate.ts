import { PicksSchema } from "./firecrawl.schemas.js";
import type { SerpItem } from "./firecrawl.schemas.js";
import { oneShot } from "../llm/openrouter.js";

const DEBUG =
  process.env.FIRECRAWL_DEBUG === "1" || process.argv.includes("--debug");
const debug = (...args: unknown[]) => {
  if (DEBUG) console.log("[debug]", ...args);
};

function tryParseJSON(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function extractJsonObject(text: string): unknown {
  const fence = text.match(/```(?:json)?\n([\s\S]*?)```/i);
  if (fence && typeof fence[1] === "string") {
    const got = tryParseJSON(fence[1]);
    if (got !== undefined) return got;
  }
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart) {
    const slice = text.slice(braceStart, braceEnd + 1);
    const got = tryParseJSON(slice);
    if (got !== undefined) return got;
  }
  throw new Error("Failed to parse JSON from LLM output");
}

export async function gatePicksWithLLM(
  query: string,
  items: readonly SerpItem[],
  maxPicks = 2,
) {
  const list = items
    .map(
      (r, i) =>
        `#${i + 1}\n- url: ${r.link}\n- domain: ${r.domain ?? ""}\n- title: ${r.title}\n- snippet: ${r.snippet}`,
    )
    .join("\n\n");

  const system =
    "You are a small gate model that selects the top URLs to crawl. Prefer official sources (.gov, company press) and independent corroboration. Always return strict JSON with a 'picks' array of {url, reason}.";
  const user = `Query: ${query}\nTop SERP items (ordered):\n\n${list}\n\nPick up to ${maxPicks} URLs to crawl. Return JSON only.`;

  debug("LLM gate system:", system);
  debug("LLM gate user:\n" + user);
  const res = await oneShot("querier", user, { system, temperature: 0 });
  debug("LLM gate raw response:", res.content);
  const parsed = extractJsonObject(res.content);
  const { picks } = PicksSchema.parse(parsed);
  debug("LLM gate parsed picks:", JSON.stringify(picks, null, 2));
  const seen = new Set<string>();
  return picks
    .map((p) => p.url)
    .filter((u) => {
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    })
    .slice(0, maxPicks);
}
