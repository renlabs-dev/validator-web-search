-- Drop and recreate validation_result table with correct types
DROP TABLE IF EXISTS "validation_result";

CREATE TABLE "validation_result" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "parsed_prediction_id" UUID NOT NULL,
  "outcome" VARCHAR(50) NOT NULL,
  "proof" VARCHAR(700) NOT NULL,
  "sources" JSONB NOT NULL,
  "created_at" TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Create index on parsed_prediction_id
CREATE INDEX IF NOT EXISTS "validation_result_parsed_prediction_id_idx" ON "validation_result" ("parsed_prediction_id");
