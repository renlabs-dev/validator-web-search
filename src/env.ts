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
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
