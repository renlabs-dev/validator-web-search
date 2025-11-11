import { readFile } from "node:fs/promises";
import type { CostLogEntry } from "../utils.js";

interface WorkerActivity {
  workerId: number;
  activity: string;
  timestamp: number;
  isActive: boolean;
}

interface SessionStats {
  validated: number;
  searchApiCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  outcomes: Map<string, number>;
  startTime: number;
  searchCost: number;
  llmCost: number;
  totalCost: number;
}

interface HistoricalStats {
  validated: number;
  searchApiCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  searchCost: number;
  llmCost: number;
  totalCost: number;
}

/**
 * Singleton cost tracker for aggregating validation costs and statistics
 * Tracks both current session and historical (all-time) costs
 */
export class CostTracker {
  private static instance: CostTracker | null = null;

  private session: SessionStats = {
    validated: 0,
    searchApiCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    outcomes: new Map(),
    startTime: Date.now(),
    searchCost: 0,
    llmCost: 0,
    totalCost: 0,
  };

  private historical: HistoricalStats = {
    validated: 0,
    searchApiCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    searchCost: 0,
    llmCost: 0,
    totalCost: 0,
  };

  private workers: Map<number, WorkerActivity> = new Map();

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): CostTracker {
    if (!CostTracker.instance) {
      CostTracker.instance = new CostTracker();
    }
    return CostTracker.instance;
  }

  /**
   * Load historical costs from costs.json file
   */
  async loadHistoricalCosts(): Promise<void> {
    try {
      const data = await readFile("costs.json", "utf-8");
      const lines = data.trim().split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as CostLogEntry;
          this.historical.validated++;
          this.historical.searchApiCalls += entry.searchApiCalls;
          this.historical.totalInputTokens += entry.totalInputTokens;
          this.historical.totalOutputTokens += entry.totalOutputTokens;
        } catch {
          // Skip invalid lines
          continue;
        }
      }

      // Calculate historical costs
      this.historical.searchCost = this.historical.searchApiCalls * (100 / 35000);
      this.historical.llmCost = this.calculateLLMCost(
        this.historical.totalInputTokens,
        this.historical.totalOutputTokens,
      );
      this.historical.totalCost =
        this.historical.searchCost + this.historical.llmCost;
    } catch {
      // File doesn't exist or can't be read - start with zero historical costs
      // This is fine for first run
    }
  }

  /**
   * Update costs with a new validation entry
   */
  updateCosts(entry: CostLogEntry): void {
    this.session.validated++;
    this.session.searchApiCalls += entry.searchApiCalls;
    this.session.totalInputTokens += entry.totalInputTokens;
    this.session.totalOutputTokens += entry.totalOutputTokens;

    // Update outcome counts
    const currentCount = this.session.outcomes.get(entry.outcome) || 0;
    this.session.outcomes.set(entry.outcome, currentCount + 1);

    // Calculate costs
    this.session.searchCost = this.session.searchApiCalls * (100 / 35000); // $100 plan = 35000 searches
    this.session.llmCost = this.calculateLLMCost(
      this.session.totalInputTokens,
      this.session.totalOutputTokens,
    );
    this.session.totalCost = this.session.searchCost + this.session.llmCost;
  }

  /**
   * Update worker activity
   */
  updateWorkerActivity(
    workerId: number,
    activity: string,
    isActive: boolean = true,
  ): void {
    this.workers.set(workerId, {
      workerId,
      activity,
      timestamp: Date.now(),
      isActive,
    });
  }

  /**
   * Calculate LLM cost based on tokens
   * Uses Gemini 2.5 Flash pricing via OpenRouter:
   * - Input: $0.30 per 1M tokens
   * - Output: $2.50 per 1M tokens
   */
  private calculateLLMCost(inputTokens: number, outputTokens: number): number {
    const inputCost = (inputTokens / 1_000_000) * 0.30;
    const outputCost = (outputTokens / 1_000_000) * 2.50;
    return inputCost + outputCost;
  }

  /**
   * Get current session statistics
   */
  getSessionStats(): SessionStats {
    return { ...this.session };
  }

  /**
   * Get historical (all-time) statistics
   */
  getHistoricalStats(): HistoricalStats {
    return { ...this.historical };
  }

  /**
   * Get processing rate in predictions per minute
   */
  getProcessingRate(): number {
    const runtimeMinutes = (Date.now() - this.session.startTime) / 1000 / 60;
    if (runtimeMinutes < 0.1) return 0; // Avoid division by very small numbers
    return this.session.validated / runtimeMinutes;
  }

  /**
   * Get worker activities
   */
  getWorkerActivities(): WorkerActivity[] {
    return Array.from(this.workers.values());
  }

  /**
   * Get count of active workers
   */
  getActiveWorkerCount(): number {
    return Array.from(this.workers.values()).filter((w) => w.isActive).length;
  }

  /**
   * Get total (session + historical) statistics
   */
  getTotalStats() {
    return {
      validated: this.session.validated + this.historical.validated,
      searchApiCalls:
        this.session.searchApiCalls + this.historical.searchApiCalls,
      totalInputTokens:
        this.session.totalInputTokens + this.historical.totalInputTokens,
      totalOutputTokens:
        this.session.totalOutputTokens + this.historical.totalOutputTokens,
      searchCost: this.session.searchCost + this.historical.searchCost,
      llmCost: this.session.llmCost + this.historical.llmCost,
      totalCost: this.session.totalCost + this.historical.totalCost,
    };
  }
}
