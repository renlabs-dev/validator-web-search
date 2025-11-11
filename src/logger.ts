/**
 * Global logging utility with shutdown awareness
 * Prevents log output during graceful shutdown
 */

let isShuttingDown = false;

/**
 * Set the shutting down state
 * When true, all log output is suppressed
 */
export function setShuttingDown(value: boolean): void {
  isShuttingDown = value;
}

/**
 * Log a message to console
 * Suppressed during shutdown
 */
export function log(message: string, ...args: unknown[]): void {
  if (isShuttingDown) return;
  console.log(message, ...args);
}

/**
 * Log an error to console
 * Suppressed during shutdown
 */
export function logError(message: string, ...args: unknown[]): void {
  if (isShuttingDown) return;
  console.error(message, ...args);
}
