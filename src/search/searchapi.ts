import { env } from "../env.js";
import { logError } from "../logger.js";

export interface SearchResult {
  url: string;
  title: string;
  excerpt: string;
  pub_date: string | null;
}

export interface SearchApiResponse {
  organic_results?: Array<{
    link?: string;
    title?: string;
    snippet?: string;
    date?: string;
  }>;
  error?: string;
}

export async function searchWeb(query: string): Promise<SearchResult | null> {
  try {
    const url = new URL("https://www.searchapi.io/api/v1/search");
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", query);
    url.searchParams.set("api_key", env.SEARCHAPI_API_KEY);

    const response = await fetch(url.toString());

    if (!response.ok) {
      logError(
        `SearchAPI error: ${response.status} ${response.statusText}`,
      );
      return null;
    }

    const data = (await response.json()) as SearchApiResponse;

    if (data.error) {
      logError(`SearchAPI error: ${data.error}`);
      return null;
    }

    // Get first organic result
    const firstResult = data.organic_results?.[0];

    if (!firstResult || !firstResult.link) {
      console.log("No search results found");
      return null;
    }

    return {
      url: firstResult.link,
      title: firstResult.title || "",
      excerpt: firstResult.snippet || "",
      pub_date: firstResult.date || null,
    };
  } catch (error) {
    logError("Search API error:", error);
    return null;
  }
}

/**
 * Search and return multiple results
 * @param query - Search query
 * @param maxResults - Maximum number of results to return (default: 10)
 * @returns Array of search results
 */
export async function searchMultiple(
  query: string,
  maxResults: number = 10,
): Promise<SearchResult[]> {
  try {
    const url = new URL("https://www.searchapi.io/api/v1/search");
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", query);
    url.searchParams.set("num", Math.min(maxResults, 10).toString()); // Max 10 per request
    url.searchParams.set("api_key", env.SEARCHAPI_API_KEY);

    const response = await fetch(url.toString());

    if (!response.ok) {
      logError(
        `SearchAPI error: ${response.status} ${response.statusText}`,
      );
      return [];
    }

    const data = (await response.json()) as SearchApiResponse;

    if (data.error) {
      logError(`SearchAPI error: ${data.error}`);
      return [];
    }

    if (!data.organic_results || data.organic_results.length === 0) {
      console.log("No search results found");
      return [];
    }

    // Map all results
    return data.organic_results
      .filter((result) => result.link)
      .map((result) => ({
        url: result.link ?? "",
        title: result.title || "",
        excerpt: result.snippet || "",
        pub_date: result.date || null,
      }))
      .slice(0, maxResults);
  } catch (error) {
    logError("Search API error:", error);
    return [];
  }
}
