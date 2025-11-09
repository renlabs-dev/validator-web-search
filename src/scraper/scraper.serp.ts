import { readFile } from "node:fs/promises";
import { SerperSchema } from "./scraper.schemas.js";

type RawSerp = {
  search_parameters?: { q?: unknown };
  organic_results?: unknown;
};

type RawItem = {
  title?: unknown;
  link?: unknown;
  snippet?: unknown;
  date?: unknown;
  domain?: unknown;
};

const DEBUG =
  process.env.FIRECRAWL_DEBUG === "1" || process.argv.includes("--debug");
const debug = (...args: unknown[]) => {
  if (DEBUG) console.log("[debug]", ...args);
};

export async function readSerperSample(path = "src/test/sample_serper.json") {
  const raw = await readFile(path, "utf8");
  const data: RawSerp = JSON.parse(raw);
  const parsed = SerperSchema.parse({
    search_parameters: data.search_parameters,
    organic_results: (Array.isArray(data.organic_results)
      ? (data.organic_results as unknown[])
      : []
    )
      .filter(
        (r: unknown): r is RawItem => typeof (r as RawItem)?.link === "string",
      )
      .map((r) => ({
        title: typeof r.title === "string" ? r.title : "",
        link: r.link as string,
        snippet: typeof r.snippet === "string" ? r.snippet : "",
        date: typeof r.date === "string" ? (r.date as string) : null,
        domain: typeof r.domain === "string" ? (r.domain as string) : null,
      })),
  });
  debug("SERP sample parsed:", JSON.stringify(parsed, null, 2));
  return parsed;
}
