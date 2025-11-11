import "dotenv/config";
import { AsyncLocalStorage } from "node:async_hooks";
import { createDb } from "./db/client.js";
import { Validator } from "./validator.js";
import { sleep } from "./utils.js";
import { TerminalUI } from "./ui/terminal-ui.js";
import { CostTracker } from "./ui/cost-tracker.js";
import { log as globalLog, setShuttingDown } from "./logger.js";

const asyncLocalStorage = new AsyncLocalStorage<{ workerId: number }>();
const activeWorkers = new Set<number>();

function log(message: string, ...args: unknown[]) {
  const store = asyncLocalStorage.getStore();
  const prefix = store ? `[Worker ${store.workerId}]` : "[Main]";
  globalLog(`${prefix} ${message}`, ...args);
}

/**
 * Update worker activity in the cost tracker
 */
function updateWorkerActivity(workerId: number, activity: string, isActive: boolean = true) {
  const tracker = CostTracker.getInstance();
  tracker.updateWorkerActivity(workerId, activity, isActive);
}

async function runWorker(workerId: number, stopHook: () => boolean) {
  await asyncLocalStorage.run({ workerId }, async () => {
    activeWorkers.add(workerId);
    const db = createDb();
    const validator = new Validator(db);

    log("Worker started");
    updateWorkerActivity(workerId, "Started", false);

    while (!stopHook()) {
      try {
        const result = await db.transaction(async (tx) => {
          // Get next prediction to validate
          updateWorkerActivity(workerId, "Fetching prediction", true);
          const prediction = await validator.getNextPredictionToValidate(tx);

          if (!prediction) {
            return null;
          }

          // Extract goal text for logging
          const goalText = await validator.extractGoalText(tx, prediction);
          const tweetPreview = prediction.scrapedTweet.text.slice(0, 100);

          log(`Processing prediction ${prediction.parsedPrediction.id}`);
          log(
            `  Tweet: "${tweetPreview}${prediction.scrapedTweet.text.length > 100 ? "..." : ""}"`,
          );
          log(`  Goal: "${goalText}"`);
          log(`  Search query: "${goalText}"`);

          // Validate the prediction
          updateWorkerActivity(workerId, "Validating", true);
          const validationResult = await validator.validatePrediction(
            tx,
            prediction,
          );

          // Store the validation result
          await validator.storeValidationResult(tx, validationResult);

          log(
            `Validation complete: ${validationResult.outcome}`,
            validationResult,
          );

          return validationResult;
        });

        if (!result) {
          // No predictions to process, wait before checking again
          log("No predictions ready, waiting 10s...");
          updateWorkerActivity(workerId, "Waiting (idle)", false);
          await sleep(10000);
        }
      } catch (error) {
        log("Error processing prediction:", error);
        updateWorkerActivity(workerId, "Error (retrying)", false);
        // Wait before retrying on error
        await sleep(5000);
      }
    }

    log("Worker stopped");
    updateWorkerActivity(workerId, "Stopped", false);
    activeWorkers.delete(workerId);
  });
}

async function runValidator(concurrency: number = 1) {
  // Initialize Terminal UI
  const ui = TerminalUI.getInstance();
  await ui.initialize();

  let shouldStop = false;

  // Handle shutdown with clean progress display
  const cleanup = () => {
    setShuttingDown(true); // Suppress all logs via global logger
    shouldStop = true;
    ui.cleanup(); // Clear terminal UI immediately

    // Use raw console.log for shutdown messages (bypass logger)
    console.log("\n\nFinishing run for workers...");

    // Track worker completion with live updates
    const shutdownInterval = setInterval(() => {
      const remaining = activeWorkers.size;
      if (remaining > 0) {
        // Clear previous line and print update
        process.stdout.write("\r\x1b[K"); // Clear line
        process.stdout.write(
          `Finishing run for workers (${remaining} still running)...`,
        );
      } else {
        clearInterval(shutdownInterval);
        process.stdout.write("\r\x1b[K"); // Clear line
        console.log("All workers completed.");
      }
    }, 500); // Update every 500ms
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Use raw console.log for startup message
  console.log(`Starting validator with ${concurrency} worker(s)...`);

  const workers = Array.from({ length: concurrency }, (_, i) =>
    runWorker(i + 1, () => shouldStop),
  );

  await Promise.all(workers);

  // Use raw console.log for final message
  console.log("All workers stopped");
  ui.cleanup();
  process.exit(0);
}

// Start the validator with 10 concurrent workers for better throughput
// Note: Each worker processes predictions independently using FOR UPDATE SKIP LOCKED
runValidator(10).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
