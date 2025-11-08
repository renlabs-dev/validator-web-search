import "dotenv/config";
import { env } from "../env.js";
import { rankByEmbedding } from "../llm/embeddings.js";
import { gatePicksWithLLM } from "./firecrawl.llm-gate.js";
import { fetchWithEscalation, looksBlocked } from "./firecrawl.fetch.js";
import { readSerperSample } from "./firecrawl.serp.js";

const DEBUG =
  process.env.FIRECRAWL_DEBUG === "1" || process.argv.includes("--debug");

function debug(...args: unknown[]) {
  if (DEBUG) console.log("[debug]", ...args);
}

// redactUrl no longer needed here
// moved to helpers

import { stripHtml, chunkText } from "./firecrawl.text.js";
import { summarizeRankedChunks } from "./firecrawl.summarize.js";
import type { RankedForSource } from "./firecrawl.summarize.js";

async function main(): Promise<void> {
  // 1) Load sample SERP
  const sample = await readSerperSample();
  const query = sample.search_parameters.q;
  const serp = sample.organic_results.slice(0, 8);
  console.log(`Query: ${query}`);
  console.log(`Loaded ${serp.length} SERP items from sample_serper.json`);
  if (DEBUG) {
    console.log("SERP top items:");
    serp.forEach((r, i) => {
      console.log(`#${i + 1}`, JSON.stringify(r, null, 2));
    });
  }

  // 2) Ask LLM gate to pick URLs to crawl
  const picks = await gatePicksWithLLM(query, serp, 3);
  console.log("Picked URLs:", picks);

  // 3) Crawl picked pages via ScraperAPI (if configured), else fallback to snippets
  const sources: { url: string; chunks: string[] }[] = [];
  let budget = { remaining: env.SCRAPER_BUDGET_CREDITS ?? 500 };
  if (env.SCRAPER_API) {
    console.log(`Scraper budget credits: ${budget.remaining}`);
  }
  for (const url of picks) {
    try {
      if (env.SCRAPER_API) {
        const page = await fetchWithEscalation(url, budget, (html, meta) => {
          const { blocked, reason } = looksBlocked(meta.url, html);
          if (blocked) {
            debug("acceptHtml: blocked content:", reason);
            return false;
          }
          // Accept if page contains patterns indicative of price tables or numeric series
          const text = stripHtml(html);
          const hasMarketNumbers = /\b\d{1,3}(,\d{3})*(\.\d+)?\b/.test(text);
          const hasDateLike =
            /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}/.test(
              text,
            );
          if (!hasMarketNumbers && !hasDateLike) {
            debug("acceptHtml: insufficient signals (numbers/dates) -> reject");
            return false;
          }
          return true;
        });
        const text = stripHtml(page.html);
        debug("Page text length:", text.length);
        const chunks = chunkText(text, 1200).slice(0, 12); // keep cheap
        debug(
          "Chunk count/sizes:",
          chunks.length,
          chunks.map((c) => c.length),
        );
        if (DEBUG) {
          chunks.forEach((c, idx) => {
            console.log(
              `Chunk[${idx}] preview:`,
              c.slice(0, 240).replace(/\s+/g, " "),
            );
          });
        }
        sources.push({ url, chunks });
      } else {
        // Fallback: use snippet if no crawler configured
        const item = serp.find((r) => r.link === url);
        if (item) {
          const datePart = item.date ? `${item.date} — ` : "";
          const fallback = `${datePart}${item.snippet || item.title}`;
          debug("Fallback snippet used:", fallback);
          sources.push({ url, chunks: [fallback] });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`Fetch failed for ${url}:`, msg);
      // Fallback to SERP snippet when fetch fails
      const item = serp.find((r) => r.link === url);
      if (item) {
        const datePart = item.date ? `${item.date} — ` : "";
        const fallback = `${datePart}${item.snippet || item.title}`;
        debug("Fallback snippet (fetch error) used:", fallback);
        sources.push({ url, chunks: [fallback] });
      }
    }
  }

  // If we still have too few sources, supplement with additional SERP items' snippets
  if (sources.length < 2) {
    const pickedSet = new Set(picks);
    const extras = serp
      .filter((r) => !pickedSet.has(r.link))
      .filter((r) => {
        const s = `${r.title} ${r.link}`.toLowerCase();
        return (
          s.includes("history") ||
          s.includes("historical") ||
          s.includes("price") ||
          s.includes("close") ||
          s.includes("chart")
        );
      })
      .slice(0, 3);
    for (const r of extras) {
      const datePart = r.date ? `${r.date} — ` : "";
      const fallback = `${datePart}${r.snippet || r.title}`;
      sources.push({ url: r.link, chunks: [fallback] });
      if (sources.length >= 2) break;
    }
  }

  if (sources.length === 0) {
    console.log("No sources to rank.");
    return;
  }

  // 4) Embedding rerank within each source
  const focus = `${query} — exact numeric price and date context`;
  debug("Embedding focus:", focus);
  const rankedPerSource: RankedForSource[] = [];
  for (const src of sources) {
    debug("Embedding input chunks for", src.url, src.chunks);
    const ranked = await rankByEmbedding(focus, src.chunks);
    const top = ranked.slice(0, 3);
    console.log("\nSource:", src.url);
    for (const r of top) {
      const preview = r.text.slice(0, 240).replace(/\s+/g, " ");
      console.log(`- score=${r.score.toFixed(3)} :: ${preview}`);
    }
    rankedPerSource.push({
      url: src.url,
      chunks: ranked.map((r) => ({ text: r.text, score: r.score })),
    });
    if (DEBUG) {
      console.log("All ranked chunks:");
      ranked.forEach((r) => {
        const prev = r.text.slice(0, 160).replace(/\s+/g, " ");
        console.log(`  idx=${r.index} score=${r.score.toFixed(3)} :: ${prev}`);
      });
    }
  }

  // 5) Ask LLM for a precise, quoted summary of what the top chunks actually say
  const now = new Date();
  const anchorISO = now.toISOString().slice(0, 10); // YYYY-MM-DD
  try {
    const summary = await summarizeRankedChunks(
      query,
      rankedPerSource,
      anchorISO,
    );
    console.log("\nAI Summary:");
    console.log(
      summary.answer ||
        (summary.status === "insufficient"
          ? "Insufficient evidence in provided snippets."
          : ""),
    );
    if (summary.citations.length > 0) {
      console.log("Citations:");
      for (const c of summary.citations) {
        console.log(`- ${c.url}`);
        for (const q of c.quotes.slice(0, 3)) {
          if (q) console.log(`  > ${q}`);
        }
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("AI Summary failed:", msg);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("firecrawl pipeline test failed:", message);
  process.exit(1);
});
