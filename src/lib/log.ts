/**
 * Logging module for debugging
 */

// biome-ignore lint/suspicious/noConsole: Logging module
export const log = (message: string, data?: Record<string, unknown>): void => {
  const timestamp = new Date().toISOString();
  if (data) {
    console.log(`[${timestamp}] ${message}`, JSON.stringify(data));
  } else {
    console.log(`[${timestamp}] ${message}`);
  }
};
