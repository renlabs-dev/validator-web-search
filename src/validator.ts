import { z } from "zod";

export const ValidationOutcome = z.enum([
  "MaturedTrue",
  "MaturedFalse",
  "MaturedMostlyTrue",
  "MaturedMostlyFalse",
  "NotMatured",
  "MissingContext",
  "Invalid",
]);

export type ValidationOutcome = z.infer<typeof ValidationOutcome>;

export const SourceSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  pub_date: z.string().nullable(),
  excerpt: z.string(),
});

export type Source = z.infer<typeof SourceSchema>;

export const ValidationResultSchema = z.object({
  prediction_id: z.string().or(z.number()),
  outcome: ValidationOutcome,
  proof: z.string().max(700), // Roughly 7 lines of markdown
  sources: z.array(SourceSchema),
});

export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export interface AgentClaim {
  id: string | number;
  claim_text: string;
  agent_source?: string;
  created_at?: Date;
}

export async function validateClaim(
  claim: AgentClaim
): Promise<ValidationResult> {
  // TODO: Implement validation logic
  // 1. Perform web search for the claim
  // 2. Analyze search results
  // 3. Determine outcome based on evidence
  // 4. Generate proof summary
  // 5. Return structured result

  throw new Error("Not implemented");
}
