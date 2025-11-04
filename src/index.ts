import "dotenv/config";
import { AsyncLocalStorage } from "node:async_hooks";
import { createDb } from "./db/client.js";
import { Validator } from "./validator.js";
import { sleep } from "./utils.js";

const asyncLocalStorage = new AsyncLocalStorage<{ workerId: number }>();

function log(message: string, ...args: unknown[]) {
  const store = asyncLocalStorage.getStore();
  const prefix = store ? `[Worker ${store.workerId}]` : "[Main]";
  console.log(`${prefix} ${message}`, ...args);
}

async function runWorker(workerId: number, stopHook: () => boolean) {
  await asyncLocalStorage.run({ workerId }, async () => {
    const db = createDb();
    const validator = new Validator(db);

    log("Worker started");

    while (!stopHook()) {
      try {
        const result = await db.transaction(async (tx) => {
          // Get next prediction to validate
          const prediction = await validator.getNextPredictionToValidate(tx);

          if (!prediction) {
            return null;
          }

          // Extract goal text for logging
          const goalText = await validator.extractGoalText(tx, prediction);
          const tweetPreview = prediction.scrapedTweet.text.slice(0, 100);

          log(
            `Processing prediction ${prediction.parsedPrediction.id}`
          );
          log(`  Tweet: "${tweetPreview}${prediction.scrapedTweet.text.length > 100 ? '...' : ''}"`);
          log(`  Goal: "${goalText}"`);
          log(`  Search query: "${goalText}"`);

          // Validate the prediction
          const validationResult = await validator.validatePrediction(
            tx,
            prediction
          );

          // Store the validation result
          await validator.storeValidationResult(tx, validationResult);

          log(
            `Validation complete: ${validationResult.outcome}`,
            validationResult
          );

          return validationResult;
        });

        if (!result) {
          // No predictions to process, wait before checking again
          log("No predictions ready, waiting 30s...");
          await sleep(30000);
        }
      } catch (error) {
        log("Error processing prediction:", error);
        // Wait before retrying on error
        await sleep(5000);
      }
    }

    log("Worker stopped");
  });
}

async function runValidator(concurrency: number = 1) {
  let shouldStop = false;

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nReceived SIGINT, shutting down gracefully...");
    shouldStop = true;
  });

  process.on("SIGTERM", () => {
    console.log("\nReceived SIGTERM, shutting down gracefully...");
    shouldStop = true;
  });

  console.log(`Starting validator with ${concurrency} worker(s)...`);

  const workers = Array.from({ length: concurrency }, (_, i) =>
    runWorker(i + 1, () => shouldStop)
  );

  await Promise.all(workers);

  console.log("All workers stopped");
}

// Start the validator
runValidator(1).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
