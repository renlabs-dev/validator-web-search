import "dotenv/config";
import { env } from "../env.js";
import { rankByEmbedding } from "../llm/embeddings.js";
import { gatePicksWithLLM } from "../scraper/scraper.llm-gate.js";
import { fetchWithEscalation, looksBlocked } from "../scraper/scraper.fetch.js";
import { readSerperSample } from "../scraper/scraper.serp.js";

const DEBUG =
  process.env.FIRECRAWL_DEBUG === "1" || process.argv.includes("--debug");

function debug(...args: unknown[]) {
  if (DEBUG) console.log("[debug]", ...args);
}

// redactUrl no longer needed here
// moved to helpers

import { stripHtml, chunkText } from "../scraper/scraper.text.js";
import { summarizeRankedChunks } from "../scraper/scraper.summarize.js";
import type { RankedForSource } from "../scraper/scraper.summarize.js";

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

  // 3) Sequential crawl -> embed -> judge per source; short-circuit on evidence
  // Introduce explicit price budgets: total=75, per-source=25
  const TOTAL_BUDGET_CREDITS = 75;
  const PER_SOURCE_BUDGET_CREDITS = 25;
  const overallBudget = { remaining: TOTAL_BUDGET_CREDITS };
  let totalScrapeCreditsSpent = 0;
  if (env.SCRAPER_API) {
    console.log(
      `Scraper budgets — total: ${overallBudget.remaining}, per-source: ${PER_SOURCE_BUDGET_CREDITS}`,
    );
  }

  const focus = `${query} — exact numeric price and date context`;
  debug("Embedding focus:", focus);
  const now = new Date();
  const anchorISO = now.toISOString().slice(0, 10); // YYYY-MM-DD

  async function buildSource(
    url: string,
  ): Promise<{ url: string; chunks: string[] } | null> {
    try {
      if (env.SCRAPER_API) {
        // Allocate a per-attempt budget, capped by both per-source and total remaining
        const alloc = Math.min(
          PER_SOURCE_BUDGET_CREDITS,
          Math.max(0, overallBudget.remaining),
        );
        if (alloc <= 0) {
          console.log("Budget exhausted — skipping crawl for", url);
        } else {
          const perAttemptBudget = { remaining: alloc };
          console.log(
            `Attempting crawl with up to ${alloc} credits (total remaining: ${overallBudget.remaining})`,
          );

          const page = await fetchWithEscalation(
            url,
            perAttemptBudget,
            (html, meta) => {
              const { blocked, reason } = looksBlocked(meta.url, html);
              if (blocked) {
                debug("acceptHtml: blocked content:", reason);
                return false;
              }
              const text = stripHtml(html);
              const hasMarketNumbers = /\b\d{1,3}(,\d{3})*(\.\d+)?\b/.test(
                text,
              );
              const hasDateLike =
                /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}/.test(
                  text,
                );
              if (!hasMarketNumbers && !hasDateLike) {
                debug(
                  "acceptHtml: insufficient signals (numbers/dates) -> reject",
                );
                return false;
              }
              return true;
            },
          );
          // Update total budget based on actual billed credits
          const spent =
            typeof page.creditCost === "number" &&
            Number.isFinite(page.creditCost)
              ? page.creditCost
              : alloc - perAttemptBudget.remaining;
          if (spent > 0) {
            overallBudget.remaining = Math.max(
              0,
              overallBudget.remaining - spent,
            );
            console.log(
              `Spent ${spent} credits on crawl. Total remaining: ${overallBudget.remaining}`,
            );
            totalScrapeCreditsSpent += spent;
          }
          const text = stripHtml(page.html);
          debug("Page text length:", text.length);
          const chunks = chunkText(text, 1200).slice(0, 12);
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
          return { url, chunks };
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`Fetch failed for ${url}:`, msg);
    }
    // Fallback: use snippet from SERP
    const item = serp.find((r) => r.link === url);
    if (item) {
      const datePart = item.date ? `${item.date} — ` : "";
      const fallback = `${datePart}${item.snippet || item.title}`;
      debug("Fallback snippet used:", fallback);
      return { url, chunks: [fallback] };
    }
    return null;
  }

  async function evaluateSource(source: {
    url: string;
    chunks: string[];
  }): Promise<boolean> {
    debug("Embedding input chunks for", source.url, source.chunks);
    const ranked = await rankByEmbedding(focus, source.chunks);
    const top = ranked.slice(0, 3);
    console.log("\nSource:", source.url);
    for (const r of top) {
      const preview = r.text.slice(0, 240).replace(/\s+/g, " ");
      console.log(`- score=${r.score.toFixed(3)} :: ${preview}`);
    }
    if (DEBUG) {
      console.log("All ranked chunks:");
      ranked.forEach((r) => {
        const prev = r.text.slice(0, 160).replace(/\s+/g, " ");
        console.log(`  idx=${r.index} score=${r.score.toFixed(3)} :: ${prev}`);
      });
    }

    const rankedForJudge: RankedForSource[] = [
      {
        url: source.url,
        chunks: ranked.map((r) => ({ text: r.text, score: r.score })),
      },
    ];

    try {
      const summary = await summarizeRankedChunks(
        query,
        rankedForJudge,
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
      const evidenceFound =
        summary.status === "answered" && summary.citations.length > 0;
      if (evidenceFound) {
        console.log("\nEvidence found — stopping early.");
      } else {
        console.log(
          "\nNo conclusive evidence from this source. Trying next...",
        );
      }
      return evidenceFound;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("AI Summary failed:", msg);
      return false;
    }
  }

  for (const url of picks) {
    const source = await buildSource(url);
    if (!source) continue;
    const done = await evaluateSource(source);
    if (done) {
      console.log(`\nTotal scraping credits spent: ${totalScrapeCreditsSpent}`);
      return; // short-circuit when evidence found
    }
  }

  console.log("\nNo conclusive evidence from picked sources.");
  console.log(`\nTotal scraping credits spent: ${totalScrapeCreditsSpent}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("scraper pipeline test failed:", message);
  process.exit(1);
});
