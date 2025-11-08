import fetch from "node-fetch";
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

export function estimateCredits(
  targetUrl: string,
  params: ScraperParams,
): number {
  const url = new URL(targetUrl);
  const host = url.hostname;
  let base = 1;
  if (host.includes("google.") && url.pathname.startsWith("/search")) base = 25;
  if (params.ultra_premium === "true" && params.render === "true") return 75;
  if (params.ultra_premium === "true") return 30;
  if (params.render === "true" && params.premium === "true") return 25;
  if (params.render === "true") return base + 9;
  if (params.premium === "true") return base + 9;
  return base;
}

async function preflightCost(
  apiKey: string,
  targetUrl: string,
  params: ScraperParams,
): Promise<number | undefined> {
  try {
    const u = new URL("https://api.scraperapi.com/account/urlcost");
    u.searchParams.set("api_key", apiKey);
    u.searchParams.set("url", targetUrl);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    debug("Preflight cost request:", redactUrl(u.toString()));
    const res = await fetch(u.toString());
    const text = await res.text();
    debug("Preflight cost response:", text);
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const cVal = obj.cost ?? obj.credits;
        const cNum = typeof cVal === "number" ? cVal : Number(cVal);
        if (Number.isFinite(cNum) && cNum > 0) return cNum;
      }
    } catch (err) {
      debug("Preflight JSON parse error:", err);
    }
    const n = Number(text.trim());
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch (e) {
    debug("Preflight cost failed:", e);
    return undefined;
  }
}

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
  const url = new URL(urlStr);
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
  if (url.hostname.endsWith("yahoo.com") && hit("oops, something went wrong")) {
    return { blocked: true, reason: "yahoo oops page" };
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
  const attempts: Array<{ label: string; url: string; params: ScraperParams }> = [
    { label: "plain+us", url: fixedUrl, params: { country_code: "us" } },
    { label: "render+us", url: fixedUrl, params: { render: "true", country_code: "us" } },
    { label: "premium+us", url: fixedUrl, params: { premium: "true", country_code: "us" } },
    {
      label: "premium+render+us",
      url: fixedUrl,
      params: { premium: "true", render: "true", country_code: "us" },
    },
    { label: "ultra_premium", url: fixedUrl, params: { ultra_premium: "true" } },
    {
      label: "ultra_premium+render",
      url: fixedUrl,
      params: { ultra_premium: "true", render: "true" },
    },
  ];

  for (const attempt of attempts) {
    const estimate = estimateCredits(attempt.url, attempt.params);
    const pre = await preflightCost(apiKey, attempt.url, attempt.params).catch(
      () => undefined,
    );
    const predicted = pre ?? estimate;
    debug(
      "Attempt",
      attempt.label,
      "predicted cost=",
      predicted,
      "remaining=",
      budget.remaining,
    );

    if (predicted > budget.remaining) {
      debug("Skipping attempt due to budget");
      continue;
    }

    // Set max_cost to avoid being billed for higher-than-expected costs
    const requestUrl = buildScraperApiUrl(apiKey, attempt.url, {
      ...attempt.params,
      max_cost: String(budget.remaining),
    });
    debug("ScraperAPI request:", redactUrl(requestUrl));
    const res = await fetch(requestUrl, {
      // Let ScraperAPI finish its internal retries to avoid accidental charges
      signal: (AbortSignal as any).timeout?.(75_000),
    } as any);
    const body = await res.text();
    const creditCostHeader = res.headers.get("sa-credit-cost");
    const fromCache = res.headers.get("sa-from-cache");
    const billed = creditCostHeader ? Number(creditCostHeader) : undefined;
    debug("ScraperAPI headers:", {
      status: res.status,
      saCreditCost: creditCostHeader,
      saFromCache: fromCache,
      predictedCost: predicted,
      billedCredits: billed,
      htmlLength: body.length,
    });

    // Mimic ScraperAPI billing: only bill on 200/404
    if (
      (res.status === 200 || res.status === 404) &&
      typeof billed === "number" &&
      Number.isFinite(billed)
    ) {
      budget.remaining -= billed;
    }

    if (res.ok) {
      const blocked = looksBlocked(attempt.url, body);
      if (blocked.blocked) {
        debug("Content appears blocked:", blocked.reason);
      } else if (
        acceptHtml &&
        !acceptHtml(body, { url: attempt.url, status: res.status })
      ) {
        debug("Content rejected by acceptHtml; escalating");
      } else {
        const result: FetchResult = { html: body, status: res.status };
        if (creditCostHeader) result.creditCost = Number(creditCostHeader);
        if (fromCache === "true" || fromCache === "1") result.fromCache = true;
        if (fromCache === "false" || fromCache === "0") result.fromCache = false;
        return result;
      }
    }

    if (res.status === 404) {
      if (
        !acceptHtml ||
        acceptHtml(body, { url: attempt.url, status: res.status })
      ) {
        const result: FetchResult = { html: body, status: res.status };
        if (creditCostHeader) result.creditCost = Number(creditCostHeader);
        if (fromCache === "true" || fromCache === "1") result.fromCache = true;
        if (fromCache === "false" || fromCache === "0") result.fromCache = false;
        return result;
      }
      debug("404 content rejected by acceptHtml; escalating");
    }

    debug("Attempt", attempt.label, "failed with status", res.status);
  }

  throw new Error("All escalation attempts failed or skipped by budget");
}
