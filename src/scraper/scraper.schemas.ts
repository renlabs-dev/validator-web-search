import { z } from "zod";

export const SerpItemSchema = z.object({
  title: z.string().default(""),
  link: z.string().url(),
  snippet: z.string().default(""),
  date: z.string().optional().nullable(),
  domain: z.string().optional().nullable(),
});

export const SerperSchema = z.object({
  search_parameters: z.object({ q: z.string() }),
  organic_results: z.array(SerpItemSchema).default([]),
});

// Re-export as value via empty object to satisfy ESM named export at runtime.
export type SerpItem = z.infer<typeof SerpItemSchema>;
export const __types = {} as const;

export const PicksSchema = z.object({
  picks: z
    .array(
      z.object({
        url: z.string().url(),
        reason: z.string().optional(),
      }),
    )
    .min(1),
});
