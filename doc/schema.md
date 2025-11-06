```ts
// Top-level
interface Output {
  predictions: Prediction[];
  count: number;     // number of items returned
  limit: number;     // request limit
}

interface Prediction {
  id: string;                 // uuid
  prediction_id: string;      // uuid
  topic_id: string;           // uuid
  topic_name: string | null;
  prediction_quality: number; // int
  brief_rationale: string;
  llm_confidence: string | null; // decimal-as-string
  vagueness: string | null;      // decimal-as-string
  goal: Span[];                 // text slice(s)
  timeframe: Span[];            // text slice(s)
  context: Record<string, any> | null; // arbitrary json
  filter_agent_id: string | null;
  created_at: string;          // ISO datetime
  updated_at: string;          // ISO datetime
  details: Details | null;
  feedback: Feedback[];
  verdicts: Verdict[];
}

interface Span {
  start: number;  // int
  end: number;    // int
  source: { tweet_text: string | null } & Record<string, any>;
}

interface Details {
  parsed_prediction_id: string;  // uuid
  prediction_context: string | null;
  timeframe_status: string | null;
  timeframe_start_utc: string | null; // ISO datetime
  timeframe_end_utc: string | null;   // ISO datetime
  timeframe_precision: string | null;
  timeframe_reasoning: string | null;
  timeframe_assumptions: any[] | null;
  timeframe_confidence: string | null;          // decimal-as-string
  filter_validation_confidence: string | null;  // decimal-as-string
  filter_validation_reasoning: string | null;
  verdict_confidence: string | null;            // decimal-as-string
  verdict_sources: any | null;
  created_at: string;   // ISO datetime
  updated_at: string;   // ISO datetime
  deleted_at: string | null; // ISO datetime
}

interface Feedback {
  parsed_prediction_id: string; // uuid
  reason: string;
  validation_step: string;
  failure_cause: string | null;
  created_at: string; // ISO datetime
}

interface Verdict {
  parsed_prediction_id: string; // uuid
  verdict: boolean;
  context: any | null;
  created_at: string; // ISO datetime
}
```