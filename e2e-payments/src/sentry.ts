/**
 * Report a sandbox harness crash to the operator's bug catcher (Sentry).
 *
 * A planned failure — a leg the provider refused, a scenario that did not
 * assert — is the run's normal signal: it turns the CI job red and stays out
 * of the bug catcher, because it has no stack to group by. A crash is
 * different; it carries a stack, so it goes to the bug catcher as the
 * exception itself. The failure text still stays in the CI job
 * log/artifacts, where the harness's own red step already points.
 *
 * Unset SENTRY_URL means no report — the crash is still a failed CI job.
 */

import { errorMessage } from "#shared/error-message.ts";
import { sentrySdk } from "#shared/sentry-sdk.ts";
import { config } from "./config.ts";
import { log, warn } from "./log.ts";

/** How long to wait for queued reports to reach the bug catcher (ms). */
const SENTRY_FLUSH_TIMEOUT_MS = 5_000;

/** Report one crash: initialize the SDK once, capture the exception, flush. */
export const reportCrash = async (
  harness: string,
  target: string,
  error: unknown,
): Promise<void> => {
  const dsn = config.sentryUrl;
  if (!dsn) return;

  try {
    if (!sentrySdk.isInitialized()) {
      sentrySdk.init({ dsn, release: undefined });
    }
    sentrySdk.captureReport({
      error,
      extra: {},
      fingerprint: [],
      message: errorMessage(error),
      tags: { harness, target },
      transactionName: undefined,
    });
    const delivered = await sentrySdk.flush(SENTRY_FLUSH_TIMEOUT_MS);
    if (delivered) {
      log("  reported the crash to the bug catcher");
    } else {
      warn("the bug catcher did not confirm the crash report");
    }
  } catch (err) {
    warn(`failed to report to the bug catcher: ${errorMessage(err)}`);
  }
};
