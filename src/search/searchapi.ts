import { env } from "../env.js";

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
      console.error(`SearchAPI error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = (await response.json()) as SearchApiResponse;

    if (data.error) {
      console.error(`SearchAPI error: ${data.error}`);
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
    console.error("Search API error:", error);
    return null;
  }
}
