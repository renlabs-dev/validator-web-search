import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    PORT: z.coerce.number().default(3000),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    POSTGRES_URL: z.string().url(),
    SEARCHAPI_API_KEY: z.string(),
    OPENROUTER_API_KEY: z.string(),
    OPENAI_API_KEY: z.string(),
    SCRAPER_API: z.string().optional(),
    SCRAPER_BUDGET_CREDITS: z.coerce.number().positive().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
