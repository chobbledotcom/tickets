/**
 * Ping a configured ntfy URL when a payment sandbox e2e run fails. Mirrors the
 * app's own `src/shared/ntfy.ts` contract: report just enough to identify the
 * failure (which target broke), not the failure detail itself — harness error
 * messages routinely echo exact booker emails or scraped page text, and unlike
 * the app's fixed error-code enum there is no safe way to sanitize free-form
 * failure text. Full diagnostics stay in the CI job log/artifacts. Never logs
 * the configured URL itself: for a public ntfy topic, the URL is the
 * publish/subscribe handle.
 */

import { config } from "./config.ts";
import { log, warn } from "./log.ts";

const NOTIFY_TIMEOUT_MS = 5_000;

export const notifyFailure = async (target: string): Promise<void> => {
  const ntfyUrl = config.ntfyUrl;
  if (!ntfyUrl) return;

  try {
    const res = await fetch(ntfyUrl, {
      body:
        `payment sandbox e2e (${target}) failed — see the CI job log/artifacts for details.`,
      headers: {
        Tags: "warning",
        Title: `payment sandbox e2e: ${target} failed`,
      },
      method: "POST",
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!res.ok) {
      warn(
        `ntfy publish rejected: HTTP ${res.status} ${
          (await res.text()).slice(0, 200)
        }`,
      );
      return;
    }
    log("  notified ntfy of the failure");
  } catch (err) {
    warn(
      `failed to notify ntfy: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
};
