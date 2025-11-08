import fetch from "node-fetch";
import type { Response } from "node-fetch";
import { env } from "../env.js";

type ScraperParams = Record<string, string>;

const DEBUG =
  process.env.FIRECRAWL_DEBUG === "1" || process.argv.includes("--debug");
const debug = (...args: unknown[]) => {
  if (DEBUG) console.log("[debug]", ...args);
};

function redactUrl(u: string) {
  try {
    const url = new URL(u);
    if (url.searchParams.has("api_key"))
      url.searchParams.set("api_key", "***redacted***");
    return url.toString();
  } catch {
    return u;
  }
}

export function buildScraperApiUrl(
  apiKey: string,
  targetUrl: string,
  params: ScraperParams = {},
): string {
  const u = new URL("https://api.scraperapi.com/");
  u.searchParams.set("api_key", apiKey);
  u.searchParams.set("url", targetUrl);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

// Note: We intentionally avoid preflight and heuristic cost estimation.
// ScraperAPI will respect `max_cost` and report actual cost via headers.

export type FetchResult = {
  html: string;
  creditCost?: number;
  fromCache?: boolean;
  status: number;
};

export function looksBlocked(
  urlStr: string,
  html: string,
): { blocked: boolean; reason?: string } {
  const lower = html.toLowerCase();
  const hit = (s: string) => lower.includes(s);
  // Extract <title> text (helps avoid false positives from scripts)
  const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const title = titleMatch?.[1]?.toLowerCase() ?? "";
  const titleSuggestsBlock =
    title.includes("attention required") ||
    title.includes("just a moment") ||
    title.includes("access denied") ||
    title.includes("forbidden") ||
    title.includes("request unsuccessful") ||
    title.includes("checking if the site connection is secure");

  // Strong bot-wall markers
  const strongBotWall =
    hit("cf-please-wait") ||
    hit("cf-browser-verification") ||
    hit("cf-chl") ||
    hit("challenge-platform") ||
    hit("perimeterx") ||
    hit("px-captcha") ||
    hit("datadome") ||
    hit("distil_r_captcha") ||
    hit("incapsula");

  // Only treat JavaScript notices as block when phrased as an interstitial
  const jsRequiredInterstitial =
    /please enable javascript (to continue|to view this page)/i.test(html) ||
    /javascript is required/i.test(html);

  if (titleSuggestsBlock || strongBotWall || jsRequiredInterstitial) {
    return { blocked: true, reason: "bot/anti-bot interstitial" };
  }
  return { blocked: false };
}

function maybeFixYahooHistory(u: string): string {
  try {
    const url = new URL(u);
    if (
      url.hostname === "finance.yahoo.com" &&
      url.pathname.startsWith("/quote/") &&
      url.pathname.includes("/history")
    ) {
      const parts = url.pathname.split("/").filter(Boolean);
      const sym = parts[1];
      if (sym && !url.searchParams.has("p")) url.searchParams.set("p", sym);
      return url.toString();
    }
  } catch (err) {
    debug("URL parse failed in maybeFixYahooHistory:", err);
  }
  return u;
}

export async function fetchWithEscalation(
  originalUrl: string,
  budget: { remaining: number },
  acceptHtml?: (html: string, meta: { url: string; status: number }) => boolean,
): Promise<FetchResult> {
  const apiKey = env.SCRAPER_API;
  if (!apiKey) throw new Error("SCRAPER_API not set");

  const fixedUrl = maybeFixYahooHistory(originalUrl);
  const requestUrl = buildScraperApiUrl(apiKey, fixedUrl, {
    retry_404: "true",
    max_cost: String(budget.remaining),
  });
  debug("ScraperAPI request:", redactUrl(requestUrl));
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 75_000);
  let res: Response;
  try {
    res = (await fetch(requestUrl, {
      signal: ac.signal,
    })) as unknown as Response;
  } finally {
    clearTimeout(timeout);
  }
  const body = await res.text();
  const creditCostHeader = res.headers.get("sa-credit-cost");
  const fromCache = res.headers.get("sa-from-cache");
  const billed = creditCostHeader ? Number(creditCostHeader) : undefined;
  debug("ScraperAPI headers:", {
    status: res.status,
    saCreditCost: creditCostHeader,
    saFromCache: fromCache,
    billedCredits: billed,
    htmlLength: body.length,
  });

  if (
    (res.status === 200 || res.status === 404) &&
    typeof billed === "number" &&
    Number.isFinite(billed)
  ) {
    budget.remaining -= billed;
  }

  if (res.ok || res.status === 404) {
    if (
      acceptHtml &&
      !acceptHtml(body, { url: fixedUrl, status: res.status })
    ) {
      throw new Error("content_rejected_by_acceptHtml");
    }
    const result: FetchResult = { html: body, status: res.status };
    if (creditCostHeader) result.creditCost = Number(creditCostHeader);
    if (fromCache === "true" || fromCache === "1") result.fromCache = true;
    if (fromCache === "false" || fromCache === "0") result.fromCache = false;
    return result;
  }

  throw new Error(`scraper_request_failed_${res.status}`);
}
