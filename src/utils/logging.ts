/**
 * Logs an informational message to the console.
 * @param message The message parts to log.
 */
export function logInfo(...message: any[]): void {
  console.log("[INFO]", ...message);
}

/**
 * Logs a warning message to the console.
 * @param message The message parts to log.
 */
export function logWarn(...message: any[]): void {
  console.warn("[WARN]", ...message);
}

/**
 * Logs an error message to the console.
 * @param message The message parts to log.
 */
export function logError(...message: any[]): void {
  console.error("[ERROR]", ...message);
}

/**
 * Logs a critical error message to the console.
 * @param message The message parts to log.
 */
export function logCritical(...message: any[]): void {
  console.error("[CRITICAL]", ...message);
}
