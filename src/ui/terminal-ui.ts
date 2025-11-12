import { CostTracker } from "./cost-tracker.js";

// ANSI escape codes
const SAVE_CURSOR = "\x1b[s";
const RESTORE_CURSOR = "\x1b[u";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_TO_END = "\x1b[J";
const RESET_SCROLL_REGION = "\x1b[r"; // Reset to full screen

// Colors
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

/**
 * Move cursor to specific row and column
 */
function moveCursor(row: number, col: number = 1): string {
  return `\x1b[${row};${col}H`;
}

/**
 * Set scrolling region (top to bottom rows)
 */
function setScrollRegion(top: number, bottom: number): string {
  return `\x1b[${top};${bottom}r`;
}

/**
 * Format large numbers with comma separators
 */
function formatNumber(num: number): string {
  return num.toLocaleString("en-US");
}

/**
 * Format cost as currency
 */
function formatCost(cost: number): string {
  return `$${cost.toFixed(3)}`;
}

/**
 * Terminal UI manager for displaying live cost and statistics
 * Uses ANSI escape codes to render a static stats bar at the bottom
 */
export class TerminalUI {
  private static instance: TerminalUI | null = null;
  private costTracker: CostTracker;
  private statsHeight = 3; // Number of lines for stats bar (dynamically adjusted)
  private isInitialized = false;
  private terminalRows = 24; // Default, will be updated
  private readonly MIN_LOG_LINES = 15; // Minimum lines for log viewing area

  private constructor() {
    this.costTracker = CostTracker.getInstance();
    this.terminalRows = process.stdout.rows || 24;
    this.adjustStatsHeight();
  }

  /**
   * Adjust stats height based on terminal size
   * Ensures minimum log lines are available
   */
  private adjustStatsHeight(): void {
    const availableLines = this.terminalRows - this.MIN_LOG_LINES;
    if (availableLines < 3) {
      // Terminal too small, use minimal stats (2 lines minimum)
      this.statsHeight = Math.max(2, this.terminalRows - this.MIN_LOG_LINES);
    } else {
      // Use default 3 lines
      this.statsHeight = 3;
    }
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): TerminalUI {
    if (!TerminalUI.instance) {
      TerminalUI.instance = new TerminalUI();
    }
    return TerminalUI.instance;
  }

  /**
   * Initialize the terminal UI
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Load historical costs
    await this.costTracker.loadHistoricalCosts();

    // Hide cursor for cleaner display
    process.stdout.write(HIDE_CURSOR);

    // Set scrolling region (leave bottom lines for stats)
    const scrollBottom = this.terminalRows - this.statsHeight;
    process.stdout.write(setScrollRegion(1, scrollBottom));

    // Move cursor to top of scrolling region
    process.stdout.write(moveCursor(1));

    // Handle terminal resize
    process.stdout.on("resize", () => {
      this.terminalRows = process.stdout.rows || 24;
      this.adjustStatsHeight();
      const newScrollBottom = this.terminalRows - this.statsHeight;
      process.stdout.write(setScrollRegion(1, newScrollBottom));
      this.render();
    });

    // Handle shutdown signals to clean up terminal
    process.on("SIGINT", () => this.cleanup());
    process.on("SIGTERM", () => this.cleanup());
    process.on("exit", () => this.cleanup());

    this.isInitialized = true;

    // Initial render
    this.render();
  }

  /**
   * Render the stats bar at the bottom of the terminal
   */
  render(): void {
    if (!this.isInitialized) return;

    const session = this.costTracker.getSessionStats();
    const total = this.costTracker.getTotalStats();
    const rate = this.costTracker.getProcessingRate();
    const workers = this.costTracker.getWorkerActivities();
    const activeCount = this.costTracker.getActiveWorkerCount();

    const termWidth = process.stdout.columns || 80;
    const statsStartRow = this.terminalRows - this.statsHeight + 1;

    // Move to stats area (outside scrolling region) and clear it
    process.stdout.write(moveCursor(statsStartRow));
    process.stdout.write(CLEAR_TO_END);

    // Line 1: Separator
    process.stdout.write(GRAY + "─".repeat(termWidth) + RESET + "\n");

    // Line 2: All stats in one line (Session, Total, Rate, Workers, Cost breakdown)
    const sessionInfo = `${BOLD}SESSION:${RESET} ${CYAN}${formatCost(session.totalCost)}${RESET} (${YELLOW}${session.validated}${RESET} pred)`;
    const totalInfo = `${BOLD}TOTAL:${RESET} ${CYAN}${formatCost(total.totalCost)}${RESET} (${YELLOW}${formatNumber(total.validated)}${RESET} pred)`;
    const rateInfo = `${BOLD}Rate:${RESET} ${GREEN}${rate.toFixed(1)}/min${RESET}`;
    const workerInfo = `${BOLD}Workers:${RESET} ${GREEN}${activeCount}${RESET}/${workers.length}`;
    const searchInfo = `${BOLD}Search:${RESET} ${formatCost(session.searchCost)} (${session.searchApiCalls})`;
    const llmInfo = `${BOLD}LLM:${RESET} ${formatCost(session.llmCost)} (${this.formatTokens(session.totalInputTokens + session.totalOutputTokens)})`;
    const avgInfo = `${BOLD}Avg:${RESET} ${session.validated > 0 ? formatCost(session.totalCost / session.validated) : "$0.00"}/pred`;

    process.stdout.write(
      `${sessionInfo} | ${totalInfo} | ${rateInfo} | ${workerInfo} | ${searchInfo} | ${llmInfo} | ${avgInfo}\n`,
    );

    // Line 3: Outcomes and worker status
    const outcomesStr = this.formatOutcomes(session.outcomes);
    const workersStr = this.formatWorkers(workers);

    process.stdout.write(`${outcomesStr} | ${BOLD}Workers:${RESET} ${workersStr}\n`);

    // Restore cursor to original position
    process.stdout.write(RESTORE_CURSOR);
  }

  /**
   * Format outcomes with symbols
   */
  private formatOutcomes(outcomes: Map<string, number>): string {
    const parts: string[] = [];

    const maturedTrue = outcomes.get("MaturedTrue") || 0;
    const maturedMostlyTrue = outcomes.get("MaturedMostlyTrue") || 0;
    const maturedFalse = outcomes.get("MaturedFalse") || 0;
    const maturedMostlyFalse = outcomes.get("MaturedMostlyFalse") || 0;
    const missingContext = outcomes.get("MissingContext") || 0;
    const notMatured = outcomes.get("NotMatured") || 0;
    const invalid = outcomes.get("Invalid") || 0;

    if (maturedTrue > 0)
      parts.push(`${GREEN}✓True:${maturedTrue}${RESET}`);
    if (maturedMostlyTrue > 0)
      parts.push(`${GREEN}~MostlyTrue:${maturedMostlyTrue}${RESET}`);
    if (maturedFalse > 0)
      parts.push(`${YELLOW}✗False:${maturedFalse}${RESET}`);
    if (maturedMostlyFalse > 0)
      parts.push(`${YELLOW}~MostlyFalse:${maturedMostlyFalse}${RESET}`);
    if (missingContext > 0)
      parts.push(`${BLUE}?Missing:${missingContext}${RESET}`);
    if (notMatured > 0)
      parts.push(`${GRAY}⏳NotMatured:${notMatured}${RESET}`);
    if (invalid > 0) parts.push(`${GRAY}✗Invalid:${invalid}${RESET}`);

    return `${BOLD}Outcomes:${RESET} ${parts.join(" ")}`;
  }

  /**
   * Format workers with status indicators
   */
  private formatWorkers(
    workers: { workerId: number; isActive: boolean }[],
  ): string {
    // Sort by worker ID
    const sorted = [...workers].sort((a, b) => a.workerId - b.workerId);

    return (
      "[" +
      sorted
        .map((w) => {
          const symbol = w.isActive ? `${GREEN}✓${RESET}` : `${GRAY}○${RESET}`;
          return `${w.workerId}${symbol}`;
        })
        .join(" ") +
      "]"
    );
  }

  /**
   * Format token count with K/M suffix
   */
  private formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) {
      return `${(tokens / 1_000_000).toFixed(1)}M tok`;
    } else if (tokens >= 1_000) {
      return `${(tokens / 1_000).toFixed(1)}K tok`;
    }
    return `${tokens} tok`;
  }

  /**
   * Clean up terminal on exit
   */
  cleanup(): void {
    if (!this.isInitialized) return;

    // Reset scrolling region to full screen
    process.stdout.write(RESET_SCROLL_REGION);

    // Move to stats area and clear it
    const statsStartRow = this.terminalRows - this.statsHeight + 1;
    process.stdout.write(moveCursor(statsStartRow));
    process.stdout.write(CLEAR_TO_END);

    // Show cursor again
    process.stdout.write(SHOW_CURSOR);

    // Move cursor to bottom
    process.stdout.write(moveCursor(this.terminalRows));
  }
}
