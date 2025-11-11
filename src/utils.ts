export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

export function formatDate(date: Date | string | null): string | null {
  if (!date) return null;
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toISOString();
}

export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.toString();
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CostLogEntry {
  prediction_id: string;
  prediction_context: string;
  searchApiCalls: number;
  queryEnhancerInputTokens: number;
  queryEnhancerOutputTokens: number;
  resultJudgeInputTokens: number;
  resultJudgeOutputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  outcome: string;
  timestamp: string;
}

/**
 * Append cost data to costs.json file and update live cost tracker
 */
export async function writeCostLog(entry: CostLogEntry): Promise<void> {
  const { appendFile } = await import("node:fs/promises");

  const logLine = JSON.stringify(entry) + "\n";

  try {
    await appendFile("costs.json", logLine, "utf-8");

    // Update cost tracker and render UI
    const { CostTracker } = await import("./ui/cost-tracker.js");
    const { TerminalUI } = await import("./ui/terminal-ui.js");

    const tracker = CostTracker.getInstance();
    tracker.updateCosts(entry);

    const ui = TerminalUI.getInstance();
    ui.render();
  } catch (error) {
    const { logError } = await import("./logger.js");
    logError("Failed to write to costs.json:", error);
  }
}
