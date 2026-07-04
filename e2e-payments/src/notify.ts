/**
 * Ping a configured ntfy URL when a payment sandbox e2e run fails. Mirrors the
 * app's own `src/shared/ntfy.ts` contract (POST the message, `Tags: warning`),
 * but this harness has no request/domain to report — it identifies the failed
 * target and error message instead.
 */

import { config } from "./config.ts";
import { log, warn } from "./log.ts";

export const notifyFailure = async (
  target: string,
  message: string,
): Promise<void> => {
  const ntfyUrl = config.ntfyUrl;
  if (!ntfyUrl) return;

  try {
    await fetch(ntfyUrl, {
      body: `payment sandbox e2e (${target}) failed: ${message}`.slice(0, 1000),
      headers: {
        Tags: "warning",
        Title: `payment sandbox e2e: ${target} failed`,
      },
      method: "POST",
    });
    log(`  notified ${ntfyUrl}`);
  } catch (err) {
    warn(
      `failed to notify ${ntfyUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};
