import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    PORT: z.coerce.number().default(3000),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    DATABASE_URL: z.string().url(),
    WEB_SEARCH_API_KEY: z.string().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
